-- supabase/migrations/2026-05-14-versioning-overhaul.sql
--
-- Versioning overhaul (branch fix/versioning-overhaul).
--
-- Enforces the invariant
--   subjects.content == current_version.content_markdown
-- by funnelling every content write through commit_subject_version(...).
-- See project_versioning_invariant.md for the rationale and the call-site
-- audit. Two functions are added; no existing columns are altered.

-- ── 1) commit_subject_version ─────────────────────────────────────────────
-- Atomically inserts a subject_versions row (or coalesces into the most
-- recent same-source row inside the caller-supplied time window) and moves
-- subjects.content + subjects.current_version_id to match. Returns the
-- version id that now holds the content.
--
-- Coalescing rationale: autosave-on-every-keystroke would inflate the
-- subject_versions table. With a positive window we fold consecutive same-
-- source writes from the same actor into a single row — a single "edit
-- session" becomes one version, not one per debounce tick. Callers that
-- want an explicit checkpoint (manual save button, AI revision, import,
-- adopt) pass 0 to force a fresh row.

create or replace function public.commit_subject_version(
  p_subject_id           uuid,
  p_content              text,
  p_source               text,
  p_source_actor         text,
  p_label                text,
  p_parent_version_id    uuid,
  p_coalesce_window_secs int
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner    uuid;
  v_existing subject_versions%rowtype;
  v_new_id   uuid;
begin
  if p_subject_id is null then
    raise exception 'subject_id is required';
  end if;
  if p_content is null then
    raise exception 'content is required';
  end if;
  if p_source not in ('user', 'ai', 'import') then
    raise exception 'invalid source % (expected user|ai|import)', p_source;
  end if;

  -- Ownership check: only the subject's owner may commit. auth.uid() is null
  -- when called from service-role; we still trust the subject row's owner in
  -- that case (server-side flows).
  select user_id into v_owner from subjects where id = p_subject_id;
  if v_owner is null then
    raise exception 'subject % not found', p_subject_id;
  end if;
  if auth.uid() is not null and v_owner <> auth.uid() then
    raise exception 'not authorized to write subject %', p_subject_id;
  end if;

  -- Coalescing window: try to fold the write into the most recent same-source
  -- row instead of appending. Only when caller opts in (window > 0).
  if p_coalesce_window_secs > 0 then
    select * into v_existing
      from subject_versions
     where subject_id = p_subject_id
       and source     = p_source
       and coalesce(source_actor, '') = coalesce(p_source_actor, '')
       and created_at >= now() - make_interval(secs => p_coalesce_window_secs)
     order by created_at desc
     limit 1;

    if found then
      -- Bump created_at so History sorted desc by created_at shows the
      -- coalesced (most-recently-active) row first. Without this, an old
      -- autosave row would sit visually below a newer manual checkpoint
      -- even though it holds the "atual" pointer.
      update subject_versions
         set content_markdown = p_content,
             label            = coalesce(p_label, v_existing.label),
             created_at       = now()
       where id = v_existing.id;

      update subjects
         set content            = p_content,
             current_version_id = v_existing.id,
             updated_at         = now()
       where id = p_subject_id;

      return v_existing.id;
    end if;
  end if;

  -- Fresh row.
  v_new_id := gen_random_uuid();
  insert into subject_versions
    (id, subject_id, content_markdown, parent_version_id, source, source_actor, label)
  values
    (v_new_id, p_subject_id, p_content, p_parent_version_id, p_source, p_source_actor, p_label);

  update subjects
     set content            = p_content,
         current_version_id = v_new_id,
         updated_at         = now()
   where id = p_subject_id;

  return v_new_id;
end;
$$;

grant execute on function public.commit_subject_version(uuid, text, text, text, text, uuid, int) to authenticated;

-- ── 2) rename_subject ─────────────────────────────────────────────────────
-- The old client-side rename did DELETE + INSERT, which cascaded into
-- subject_versions + subject_comments and destroyed all history. This RPC
-- does the rename as a single UPDATE so the row's id (and every FK pointing
-- at it) is preserved. Raises a unique-violation 23505 if another file in
-- the same project already uses the target name.

create or replace function public.rename_subject(
  p_subject_id    uuid,
  p_new_file_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner   uuid;
  v_project text;
begin
  if p_subject_id is null then
    raise exception 'subject_id is required';
  end if;
  if p_new_file_name is null or length(btrim(p_new_file_name)) = 0 then
    raise exception 'new_file_name is empty';
  end if;

  select user_id, project_name into v_owner, v_project
    from subjects
   where id = p_subject_id;
  if v_owner is null then
    raise exception 'subject % not found', p_subject_id;
  end if;
  if auth.uid() is not null and v_owner <> auth.uid() then
    raise exception 'not authorized to rename subject %', p_subject_id;
  end if;

  -- Explicit duplicate check so the UI can show a useful message; without it
  -- the PK update would surface as a generic 23505.
  if exists (
    select 1 from subjects
     where user_id      = v_owner
       and project_name = v_project
       and file_name    = p_new_file_name
       and id           <> p_subject_id
  ) then
    raise exception 'file_name % already exists in project %', p_new_file_name, v_project
      using errcode = '23505';
  end if;

  update subjects
     set file_name  = p_new_file_name,
         updated_at = now()
   where id = p_subject_id;
end;
$$;

grant execute on function public.rename_subject(uuid, text) to authenticated;
