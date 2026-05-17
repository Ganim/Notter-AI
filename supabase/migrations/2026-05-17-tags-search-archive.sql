-- supabase/migrations/2026-05-17-tags-search-archive.sql
--
-- Adds Linear-style stable identifiers: projects.tag + subjects.seq render as
-- `flow-3`. Adds projects.next_subject_seq as the monotonic counter the RPC
-- bumps. archived_at columns already exist from 2026-05-14-mcp-expansion.sql
-- and are NOT touched here.
--
-- Order: schema → backfill → constraints → RPCs. Reversing constraints-first
-- deadlocks the backfill on NULL rows.
--
-- Schema-specific notes (differ from the original spec draft):
--   * projects.id is `text` (convention: id == name); not uuid.
--   * Neither projects nor subjects have created_at; backfill ORDER BY uses
--     updated_at + secondary stable key (workspace_id, name) / (file_name).
--   * The create_subject RPC therefore takes `p_project_id text`.

-- ── 1. Schema additions ────────────────────────────────────────────────────

alter table projects
  add column if not exists tag              text,
  add column if not exists next_subject_seq int  not null default 1;

alter table subjects
  add column if not exists seq int;

alter table projects
  drop constraint if exists projects_tag_shape;
alter table projects
  add constraint projects_tag_shape
    check (tag is null or tag ~ '^[a-z0-9]{2,8}$');

-- ── 2. gen_unique_tag helper ──────────────────────────────────────────────

create or replace function gen_unique_tag(p_name text, p_workspace_id uuid)
returns text
language plpgsql
as $fn$
declare
  v_base text;
  v_candidate text;
  v_suffix int := 2;
begin
  v_base := lower(regexp_replace(split_part(coalesce(p_name, ''), ' ', 1), '[^a-z0-9]', '', 'gi'));
  if v_base = '' or length(v_base) < 2 then
    v_base := 'proj';
  end if;
  v_base := substring(v_base, 1, 8);

  if v_base in ('new', 'archived', 'settings', 'inbox', 'all') then
    v_base := substring(v_base || 'p', 1, 8);
  end if;

  v_candidate := v_base;
  while exists (select 1 from projects where workspace_id = p_workspace_id and tag = v_candidate) loop
    v_candidate := substring(v_base, 1, 8 - length(v_suffix::text)) || v_suffix::text;
    v_suffix := v_suffix + 1;
    if v_suffix > 999 then
      raise exception 'tag_generation_exhausted for workspace %', p_workspace_id;
    end if;
  end loop;

  return v_candidate;
end $fn$;

-- ── 3. Backfill ───────────────────────────────────────────────────────────

-- 3a. projects.tag — per workspace to scope collisions. Order by name so the
-- mapping is deterministic (no created_at column on projects).
do $bf$
declare r record;
begin
  for r in
    select id, workspace_id, name
    from projects
    where tag is null
    order by workspace_id, name
  loop
    update projects
      set tag = gen_unique_tag(r.name, r.workspace_id)
    where id = r.id;
  end loop;
end $bf$;

-- 3b. subjects.seq — row_number partitioned by (user_id, project_name).
-- Stable ordering: updated_at then file_name (no created_at on subjects).
with ordered as (
  select id,
         row_number() over (
           partition by user_id, project_name
           order by updated_at asc, file_name asc
         ) as rn
  from subjects
)
update subjects s
  set seq = ordered.rn
  from ordered
  where s.id = ordered.id;

-- 3c. projects.next_subject_seq = max(seq) + 1 for the project
update projects p
  set next_subject_seq = coalesce(
    (select max(s.seq) + 1 from subjects s
       where s.user_id = p.user_id and s.project_name = p.name),
    1
  );

-- ── 4. Verification ────────────────────────────────────────────────────────

do $vf$
declare null_tags int; null_seqs int;
begin
  select count(*) into null_tags from projects where tag is null;
  select count(*) into null_seqs from subjects where seq is null;
  if null_tags > 0 then raise exception 'tag backfill missed % rows', null_tags; end if;
  if null_seqs > 0 then raise exception 'seq backfill missed % rows', null_seqs; end if;
end $vf$;

-- ── 5. NOT NULL + uniqueness ───────────────────────────────────────────────

alter table projects alter column tag set not null;
alter table subjects alter column seq set not null;

create unique index if not exists projects_workspace_tag_uniq
  on projects (workspace_id, tag);

create unique index if not exists subjects_project_seq_uniq
  on subjects (user_id, project_name, seq);

-- ── 6. create_subject RPC ─────────────────────────────────────────────────
-- p_project_id is TEXT because projects.id is text (Notter convention:
-- id == name). Callers pass the project's name as the id.

create or replace function create_subject(
  p_project_id text,
  p_file_name  text,
  p_content    text default ''
)
returns subjects
language plpgsql
security definer
set search_path = public
as $cs$
declare
  v_uid       uuid := auth.uid();
  v_ws        uuid;
  v_role      text;
  v_pname     text;
  v_archived  timestamptz;
  v_seq       int;
  v_subject   subjects;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select workspace_id, name, next_subject_seq, archived_at
    into v_ws, v_pname, v_seq, v_archived
  from projects
  where id = p_project_id
  for update;

  if v_ws is null then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;

  v_role := workspace_role(v_ws);
  if v_role not in ('owner', 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_archived is not null then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;

  insert into subjects (user_id, project_name, file_name, content, seq, workspace_id)
  values (v_uid, v_pname, p_file_name, p_content, v_seq, v_ws)
  returning * into v_subject;

  update projects
    set next_subject_seq = v_seq + 1,
        updated_at       = now()
  where id = p_project_id;

  return v_subject;
end $cs$;

grant execute on function create_subject(text, text, text) to authenticated;
grant execute on function gen_unique_tag(text, uuid) to authenticated;
