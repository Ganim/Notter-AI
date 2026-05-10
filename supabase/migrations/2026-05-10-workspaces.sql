-- supabase/migrations/2026-05-10-workspaces.sql
--
-- Workspaces: a container between account and projects. Each user has 1..N
-- workspaces; every project belongs to exactly one workspace. Subjects,
-- versions, and comments remain scoped via the project FK chain — they DO
-- NOT gain a workspace_id column (spec §4.3).
--
-- NOTE on FK ordering: the spec §5.1 SQL combines `ADD COLUMN ... NOT NULL
-- DEFAULT '00000000-...' REFERENCES workspaces(id)` into a single statement.
-- Postgres rejects that when the table already has rows because the default
-- value is validated against the FK before the backfill in step 4 can run
-- (error 23503). We therefore add the column with the temp default, run the
-- backfill, drop the default, and then attach the FK as a separate step —
-- end state matches the spec exactly (NOT NULL, FK ON DELETE RESTRICT, no
-- default). The all-zero sentinel still serves its canary purpose for the
-- verification DO block at the end.

-- 1. workspaces table
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);
create index workspaces_user_id_idx on workspaces(user_id);

-- Exactly one default workspace per user (partial unique index).
create unique index workspaces_one_default_per_user_idx
  on workspaces(user_id) where is_default = true;

alter table workspaces enable row level security;
create policy "workspaces_user_isolation" on workspaces for all
  using (auth.uid() = user_id);

-- Realtime publication — explicit add so postgres_changes events fire on
-- workspace insert/update/delete from another device.
alter publication supabase_realtime add table workspaces;

-- 2. Backfill: one default workspace per existing user (with projects).
-- Users without projects get one lazily via WorkspaceManager.bootstrap()
-- on next sign-in.
insert into workspaces (user_id, name, is_default)
select distinct user_id, 'User''s workspace', true
from projects;

-- 3. projects.workspace_id — add with temp all-zero default (NOT NULL) but
-- WITHOUT the FK constraint yet. See header note for rationale.
alter table projects
  add column workspace_id uuid not null
  default '00000000-0000-0000-0000-000000000000';

-- 4. Backfill each project's workspace_id to its user's default workspace.
update projects p
set workspace_id = w.id
from workspaces w
where w.user_id = p.user_id
  and w.is_default = true;

-- 5. Drop the temporary default so future inserts must choose a workspace.
alter table projects alter column workspace_id drop default;

-- 6. Now add the FK constraint — every row already points at a real workspace.
alter table projects
  add constraint projects_workspace_id_fkey
  foreign key (workspace_id) references workspaces(id) on delete restrict;

-- 7. Composite index for the (user_id, workspace_id) query the app uses.
create index projects_user_workspace_idx on projects(user_id, workspace_id);

-- 8. Verification — fail-fast canary if backfill leaves any row pointing
-- at the all-zero UUID. Re-running this migration on a partial state will
-- raise here rather than silently leaving bad data.
do $$
begin
  if exists (
    select 1 from projects where workspace_id = '00000000-0000-0000-0000-000000000000'
  ) then
    raise exception 'workspaces backfill incomplete — % projects still have all-zero workspace_id',
      (select count(*) from projects where workspace_id = '00000000-0000-0000-0000-000000000000');
  end if;
end $$;
