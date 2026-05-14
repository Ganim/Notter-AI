-- supabase/migrations/2026-05-14-workspace-members.sql
--
-- Multi-user workspaces — Migration A.
--
-- Lifts the single-owner constraint on every workspace-scoped table by
-- introducing workspace_members (one row per (workspace, user, role)) and
-- rewriting RLS on workspaces / projects / subjects / subject_versions /
-- subject_comments to check membership instead of auth.uid() = user_id.
--
-- The denormalized workspace_id column on subjects/versions/comments is a
-- perf hedge: correlated subqueries through projects on every RLS read would
-- double the work on the hottest tables. Triggers keep workspace_id in sync
-- on insert and on project re-targeting.
--
-- Client behavior pre/post this migration is IDENTICAL for single-user
-- accounts: every user is the owner-member of every workspace they own, and
-- workspace_role() returns 'owner' in those rows. Plan 2 introduces invites;
-- only then do non-owner members start existing.
--
-- See docs/superpowers/specs/2026-05-13-multi-user-workspaces-design.md §3,
-- §4, §11.1 for the full design. Edge case #9 ("owner downgrades themselves
-- via DB") is mitigated by the last-owner-protection trigger at the end.

-- 1. workspace_members table
create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'editor', 'viewer')),
  invited_by   uuid references auth.users(id) on delete set null,
  invited_at   timestamptz,
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx      on workspace_members(user_id);
create index workspace_members_workspace_id_idx on workspace_members(workspace_id);

-- One owner per workspace.
create unique index workspace_members_one_owner_per_workspace_idx
  on workspace_members(workspace_id) where role = 'owner';

alter table workspace_members enable row level security;
alter publication supabase_realtime add table workspace_members;

-- Temporary permissive policy so the backfill INSERT below works regardless
-- of whether the migration runs as a BYPASSRLS role. Supabase Cloud runs
-- migrations as `postgres` (BYPASSRLS = true) so this is belt-and-suspenders
-- there, but self-hosted deployments where the migration user lacks
-- BYPASSRLS would otherwise see the INSERT silently affect 0 rows and the
-- next DO block raise. Dropped before the strict policies are installed.
create policy "members_seed_temp_permissive" on workspace_members
  for all using (true) with check (true);

-- 2. Backfill: one owner row per existing workspace, mirroring workspaces.user_id.
insert into workspace_members (workspace_id, user_id, role, joined_at)
select id, user_id, 'owner', created_at
from workspaces
on conflict (workspace_id, user_id) do nothing;

-- 3. Backfill verification — fail-fast if any workspace lacks its owner row.
do $$
declare
  unseeded_count int;
begin
  select count(*) into unseeded_count
  from workspaces w
  where not exists (
    select 1 from workspace_members m
    where m.workspace_id = w.id
      and m.user_id = w.user_id
      and m.role = 'owner'
  );
  if unseeded_count > 0 then
    raise exception 'workspace_members backfill missed % workspaces', unseeded_count;
  end if;
end $$;

-- 4. Helpers. STABLE + security invoker so the planner can inline them and
--    they obey the caller's RLS.
create or replace function is_workspace_member(ws_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = ws_id
      and user_id = auth.uid()
  );
$$;

create or replace function workspace_role(ws_id uuid)
returns text
language sql
stable
security invoker
as $$
  select role from workspace_members
  where workspace_id = ws_id
    and user_id = auth.uid()
  limit 1;
$$;

grant execute on function is_workspace_member(uuid) to authenticated;
grant execute on function workspace_role(uuid) to authenticated;

-- 5. workspace_members RLS. Drop the temporary permissive policy now that
--    the seed is committed, then install the real policies.
--
--    SELECT is restricted to the caller's own membership row. The first cut
--    used a "I can see all members of any workspace I belong to" formulation
--    via `workspace_id IN (SELECT workspace_id ... WHERE user_id = auth.uid())`
--    but Postgres rejected it at runtime with infinite-recursion: the inner
--    subquery reads workspace_members under the same policy, retriggering it,
--    and the recursion guard fires before convergence. For Plan 1 single-user
--    this self-row policy is sufficient — the only consumer (workspace_role /
--    is_workspace_member / the get_my_workspaces JOIN) only needs to see the
--    caller's own row. Plan 2 will revisit when WorkspaceMembersDialog needs
--    to render peer members; that'll require a SECURITY DEFINER helper or a
--    non-recursive policy formulation.
drop policy "members_seed_temp_permissive" on workspace_members;

create policy "members_read_self" on workspace_members
  for select using ( user_id = auth.uid() );

create policy "members_insert_owner_only" on workspace_members
  for insert with check ( workspace_role(workspace_id) = 'owner' );

create policy "members_update_owner_only" on workspace_members
  for update using ( workspace_role(workspace_id) = 'owner' )
              with check ( workspace_role(workspace_id) = 'owner' );

create policy "members_delete_self_or_owner" on workspace_members
  for delete using (
    user_id = auth.uid()
    or workspace_role(workspace_id) = 'owner'
  );

-- 6. Last-owner protection. Any operation that would leave a workspace with
--    zero owners raises. Covers:
--      - UPDATE that demotes the last owner's role to editor/viewer.
--      - DELETE on the last owner's membership row.
--    Spec §2/§3.3 v1 rule: ownership cannot be transferred and owners cannot
--    leave. Transfer is a v2 feature; until then, the DB rejects the orphan.
create or replace function prevent_last_owner_orphan()
returns trigger
language plpgsql
as $$
declare
  remaining_owners int;
begin
  if tg_op = 'UPDATE' then
    if old.role = 'owner' and new.role <> 'owner' then
      select count(*) into remaining_owners
      from workspace_members
      where workspace_id = new.workspace_id
        and role = 'owner'
        and user_id <> old.user_id;
      if remaining_owners = 0 then
        raise exception 'cannot demote last owner of workspace %', new.workspace_id
          using errcode = 'P0001';
      end if;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.role = 'owner' then
      select count(*) into remaining_owners
      from workspace_members
      where workspace_id = old.workspace_id
        and role = 'owner'
        and user_id <> old.user_id;
      if remaining_owners = 0 then
        raise exception 'cannot delete last owner of workspace %', old.workspace_id
          using errcode = 'P0001';
      end if;
    end if;
    return old;
  end if;
  return null;
end $$;

create trigger workspace_members_last_owner_guard
  before update or delete on workspace_members
  for each row execute function prevent_last_owner_orphan();

-- 7. Denormalize workspace_id onto subjects/subject_versions/subject_comments.
--    Backfill from the parent project / subject. Set NOT NULL after backfill.

alter table subjects add column workspace_id uuid references workspaces(id) on delete restrict;
update subjects s
  set workspace_id = p.workspace_id
  from projects p
  where p.user_id = s.user_id and p.name = s.project_name;
do $$
declare
  null_count int;
begin
  select count(*) into null_count from subjects where workspace_id is null;
  if null_count > 0 then
    raise exception 'subjects.workspace_id backfill left % rows null', null_count;
  end if;
end $$;
alter table subjects alter column workspace_id set not null;
create index subjects_workspace_id_idx on subjects(workspace_id);

alter table subject_versions add column workspace_id uuid references workspaces(id) on delete restrict;
update subject_versions sv
  set workspace_id = s.workspace_id
  from subjects s
  where s.id = sv.subject_id;
do $$
declare
  null_count int;
begin
  select count(*) into null_count from subject_versions where workspace_id is null;
  if null_count > 0 then
    raise exception 'subject_versions.workspace_id backfill left % rows null', null_count;
  end if;
end $$;
alter table subject_versions alter column workspace_id set not null;
create index subject_versions_workspace_id_idx on subject_versions(workspace_id);

alter table subject_comments add column workspace_id uuid references workspaces(id) on delete restrict;
update subject_comments sc
  set workspace_id = s.workspace_id
  from subjects s
  where s.id = sc.subject_id;
do $$
declare
  null_count int;
begin
  select count(*) into null_count from subject_comments where workspace_id is null;
  if null_count > 0 then
    raise exception 'subject_comments.workspace_id backfill left % rows null', null_count;
  end if;
end $$;
alter table subject_comments alter column workspace_id set not null;
create index subject_comments_workspace_id_idx on subject_comments(workspace_id);

-- 8. Triggers: set workspace_id on insert from parent.

create or replace function set_subject_workspace_id()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.workspace_id is null then
    select workspace_id into new.workspace_id from projects
    where user_id = new.user_id and name = new.project_name;
    if new.workspace_id is null then
      raise exception 'subjects.workspace_id resolve failed for (%, %)',
        new.user_id, new.project_name;
    end if;
  end if;
  return new;
end $$;

create trigger set_workspace_id_on_subjects
  before insert on subjects
  for each row execute function set_subject_workspace_id();

create or replace function set_subject_version_workspace_id()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.workspace_id is null then
    select workspace_id into new.workspace_id from subjects where id = new.subject_id;
    if new.workspace_id is null then
      raise exception 'subject_versions.workspace_id resolve failed for subject_id %', new.subject_id;
    end if;
  end if;
  return new;
end $$;

create trigger set_workspace_id_on_subject_versions
  before insert on subject_versions
  for each row execute function set_subject_version_workspace_id();

create or replace function set_subject_comment_workspace_id()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.workspace_id is null then
    select workspace_id into new.workspace_id from subjects where id = new.subject_id;
    if new.workspace_id is null then
      raise exception 'subject_comments.workspace_id resolve failed for subject_id %', new.subject_id;
    end if;
  end if;
  return new;
end $$;

create trigger set_workspace_id_on_subject_comments
  before insert on subject_comments
  for each row execute function set_subject_comment_workspace_id();

-- 9. Cascade triggers: when a project moves between workspaces, every child
--    subject + child subject_version + child subject_comment must follow.
--
--    Note: cascade_subject_workspace_to_children writes to subject_versions
--    and subject_comments via direct UPDATE. The strict RLS on
--    subject_versions has NO UPDATE policy (versions are append-only at the
--    application layer), but the trigger runs as SECURITY DEFINER and
--    bypasses RLS by design. Only workspace_id is mutated — the immutable
--    content_markdown / parent_version_id / etc are not touched. If a future
--    migration adds an UPDATE policy on subject_versions, this trigger
--    continues to work; if someone deletes the SECURITY DEFINER attribute,
--    the cascade would silently fail under RLS.

create or replace function cascade_project_workspace_to_subjects()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    update subjects
      set workspace_id = new.workspace_id, updated_at = now()
      where user_id = new.user_id and project_name = new.name;
  end if;
  return new;
end $$;

create trigger cascade_workspace_id_to_subjects
  after update of workspace_id on projects
  for each row execute function cascade_project_workspace_to_subjects();

create or replace function cascade_subject_workspace_to_children()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    update subject_versions set workspace_id = new.workspace_id where subject_id = new.id;
    update subject_comments set workspace_id = new.workspace_id where subject_id = new.id;
  end if;
  return new;
end $$;

create trigger cascade_workspace_id_from_subjects
  after update of workspace_id on subjects
  for each row execute function cascade_subject_workspace_to_children();

-- 10. RLS rewrite. Drop the old _user_isolation / "users own X" policies and
--     install workspace-membership-based ones. Done last so the helpers from
--     step 4 and the backfilled columns from step 7 are available.

-- workspaces
drop policy "workspaces_user_isolation" on workspaces;

create policy "workspaces_member_read" on workspaces
  for select using ( is_workspace_member(id) );
create policy "workspaces_owner_update" on workspaces
  for update using ( workspace_role(id) = 'owner' )
              with check ( workspace_role(id) = 'owner' );
create policy "workspaces_authenticated_insert" on workspaces
  for insert with check ( user_id = auth.uid() );
create policy "workspaces_owner_delete" on workspaces
  for delete using ( workspace_role(id) = 'owner' );

-- projects (existing policy: "users own projects")
drop policy "users own projects" on projects;

create policy "projects_member_read" on projects
  for select using ( is_workspace_member(workspace_id) );
create policy "projects_member_write_insert" on projects
  for insert with check ( workspace_role(workspace_id) in ('owner','editor') );
create policy "projects_member_write_update" on projects
  for update using ( workspace_role(workspace_id) in ('owner','editor') )
              with check ( workspace_role(workspace_id) in ('owner','editor') );
create policy "projects_owner_delete" on projects
  for delete using ( workspace_role(workspace_id) = 'owner' );

-- subjects (existing policy: "users own subjects")
drop policy "users own subjects" on subjects;

create policy "subjects_member_read" on subjects
  for select using ( is_workspace_member(workspace_id) );
create policy "subjects_member_write_insert" on subjects
  for insert with check ( workspace_role(workspace_id) in ('owner','editor') );
create policy "subjects_member_write_update" on subjects
  for update using ( workspace_role(workspace_id) in ('owner','editor') )
              with check ( workspace_role(workspace_id) in ('owner','editor') );
create policy "subjects_member_write_delete" on subjects
  for delete using ( workspace_role(workspace_id) in ('owner','editor') );

-- subject_versions
drop policy "subject_versions_user_isolation" on subject_versions;

create policy "versions_member_read" on subject_versions
  for select using ( is_workspace_member(workspace_id) );
create policy "versions_member_insert" on subject_versions
  for insert with check ( workspace_role(workspace_id) in ('owner','editor') );
create policy "versions_owner_delete" on subject_versions
  for delete using ( workspace_role(workspace_id) = 'owner' );
-- No UPDATE policy: subject_versions are append-only.

-- subject_comments. Viewer-can-comment + viewer-self-only-modify per §3.2.
drop policy "subject_comments_user_isolation" on subject_comments;

create policy "comments_member_read" on subject_comments
  for select using ( is_workspace_member(workspace_id) );
create policy "comments_member_insert" on subject_comments
  for insert with check (
    is_workspace_member(workspace_id)
    and author_user_id = auth.uid()
  );
create policy "comments_update_scoped" on subject_comments
  for update using (
    workspace_role(workspace_id) in ('owner','editor')
    or (workspace_role(workspace_id) = 'viewer' and author_user_id = auth.uid())
  ) with check (
    workspace_role(workspace_id) in ('owner','editor')
    or (workspace_role(workspace_id) = 'viewer' and author_user_id = auth.uid())
  );
create policy "comments_delete_scoped" on subject_comments
  for delete using (
    workspace_role(workspace_id) in ('owner','editor')
    or (workspace_role(workspace_id) = 'viewer' and author_user_id = auth.uid())
  );

-- 11. SECURITY DEFINER RPC: atomic workspace + owner-member creation. The
--     workspaces_authenticated_insert policy admits the workspace INSERT;
--     the members_insert_owner_only policy would otherwise block the
--     owner row because workspace_role() returns NULL until the row exists.
--     Definer wraps both writes in one transaction.
create or replace function create_workspace_with_owner(
  ws_id uuid,
  ws_name text,
  ws_is_default boolean
) returns workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ws  workspaces;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- If isDefault is true, clear the existing default in the same transaction
  -- to keep the partial unique index satisfied.
  if ws_is_default then
    update workspaces set is_default = false, updated_at = now()
      where user_id = v_uid and is_default = true;
  end if;

  insert into workspaces (id, user_id, name, is_default)
    values (ws_id, v_uid, ws_name, ws_is_default)
    returning * into v_ws;

  insert into workspace_members (workspace_id, user_id, role, joined_at)
    values (v_ws.id, v_uid, 'owner', now())
    on conflict (workspace_id, user_id) do nothing;

  return v_ws;
end $$;

grant execute on function create_workspace_with_owner(uuid, text, boolean) to authenticated;

-- 12. RPC: fetch the caller's workspaces with embedded role + total member
--     count. Uses an explicit JOIN + scalar subquery instead of a PostgREST
--     embed because the embed syntax `workspace_members(count)` plus
--     `.eq('workspace_members.user_id', ...)` filters BOTH embeds by table
--     name (PostgREST limitation), leaking the user filter into the count
--     and yielding 1 instead of the true total. The RPC encapsulates the
--     join, returns one row per workspace the caller is a member of, and
--     is trivially testable with a single `rpc` mock.
create or replace function get_my_workspaces()
returns table (
  id uuid,
  user_id uuid,
  name text,
  is_default boolean,
  created_at timestamptz,
  updated_at timestamptz,
  my_role text,
  member_count bigint
)
language sql
stable
security invoker
as $$
  select
    w.id,
    w.user_id,
    w.name,
    w.is_default,
    w.created_at,
    w.updated_at,
    me.role as my_role,
    (select count(*) from workspace_members m where m.workspace_id = w.id) as member_count
  from workspaces w
  join workspace_members me on me.workspace_id = w.id and me.user_id = auth.uid()
  order by w.created_at asc;
$$;

grant execute on function get_my_workspaces() to authenticated;

-- 13. Post-deploy hardening (Supabase advisor: function_search_path_mutable +
--     anon/authenticated_security_definer_function_executable).
--
--     a) Lock search_path on SECURITY INVOKER helpers. Functions run as the
--        caller, so they cannot escalate privilege, but a malicious schema in
--        the caller's search_path could still shadow a referenced object.
--        Belt-and-suspenders.
alter function is_workspace_member(uuid) set search_path = public;
alter function workspace_role(uuid) set search_path = public;
alter function get_my_workspaces() set search_path = public;
alter function prevent_last_owner_orphan() set search_path = public;

--     b) Revoke EXECUTE on the trigger-only SECURITY DEFINER functions. They
--        are invoked exclusively by triggers (BEFORE INSERT / AFTER UPDATE)
--        and have no business being callable via PostgREST RPC. The default
--        EXECUTE grant to PUBLIC must be revoked explicitly.
--
--        create_workspace_with_owner is intentionally left callable by
--        `authenticated` — that's the client-side workspace-create entry
--        point. The advisor will continue to warn about it; that warning is
--        a known false positive for this function.
revoke execute on function set_subject_workspace_id() from anon, authenticated, public;
revoke execute on function set_subject_version_workspace_id() from anon, authenticated, public;
revoke execute on function set_subject_comment_workspace_id() from anon, authenticated, public;
revoke execute on function cascade_project_workspace_to_subjects() from anon, authenticated, public;
revoke execute on function cascade_subject_workspace_to_children() from anon, authenticated, public;
