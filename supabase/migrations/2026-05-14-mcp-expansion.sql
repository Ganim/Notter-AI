-- supabase/migrations/2026-05-14-mcp-expansion.sql
--
-- Soft-delete columns + two security-definer RPCs that the new MCP tools
-- need. Idempotent — adding columns / functions with create-or-replace and
-- guarded ALTER TABLEs so re-running the migration is a no-op.

-- 1. Soft-delete columns
alter table workspaces add column if not exists archived_at timestamptz;
alter table projects   add column if not exists archived_at timestamptz;
alter table subjects   add column if not exists archived_at timestamptz;

-- 2. Partial indexes — most listings filter `archived_at is null`
create index if not exists workspaces_active_idx
  on workspaces(user_id, updated_at desc)
  where archived_at is null;

create index if not exists projects_active_idx
  on projects(user_id, workspace_id, updated_at desc)
  where archived_at is null;

create index if not exists subjects_active_idx
  on subjects(user_id, updated_at desc)
  where archived_at is null;

-- 3. rename_project_cascade
create or replace function rename_project_cascade(
  old_name text,
  new_name text,
  workspace_uuid uuid
) returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update projects
    set name = new_name,
        updated_at = now()
  where user_id = auth.uid()
    and workspace_id = workspace_uuid
    and name = old_name;

  if not found then
    raise exception 'project not found: %', old_name using errcode = '42P01';
  end if;

  update subjects
    set project_name = new_name,
        updated_at = now()
  where user_id = auth.uid()
    and project_name = old_name;
end;
$$;

-- 4. create_subject_with_v0
create or replace function create_subject_with_v0(
  p_project_name text,
  p_file_name text
) returns subjects
language plpgsql security definer
set search_path = public
as $$
declare
  new_subject subjects;
  new_version_id uuid;
begin
  insert into subjects (user_id, project_name, file_name, content)
  values (auth.uid(), p_project_name, p_file_name, '')
  returning * into new_subject;

  insert into subject_versions (subject_id, content_markdown, source, source_actor, label)
  values (new_subject.id, '', 'user', null, 'v0')
  returning id into new_version_id;

  update subjects
    set current_version_id = new_version_id
  where id = new_subject.id;

  select * into new_subject from subjects where id = new_subject.id;
  return new_subject;
end;
$$;

grant execute on function rename_project_cascade(text, text, uuid) to authenticated;
grant execute on function create_subject_with_v0(text, text) to authenticated;
