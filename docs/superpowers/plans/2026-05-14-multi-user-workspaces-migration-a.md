# Multi-User Workspaces — Plan 1 (Migration A + sync/store plumbing)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the load-bearing schema + RLS rewrite that lifts the single-owner constraint on every workspace-scoped table, plus the sync/store plumbing that follows from it. Ships with zero new UI: the user is still the only member of their own workspaces, single-user behavior is identical pre/post, and `useWorkspacesStore.currentRole` is always `'owner'` until Plan 2 introduces invites.

**Architecture:** One Supabase migration (`workspace_members` table + role helpers + denormalized `workspace_id` columns on `subjects` / `subject_versions` / `subject_comments` + RLS rewrite + "last owner" safety trigger). One SECURITY DEFINER RPC (`create_workspace_with_owner`) so the workspace row + owner-member row are inserted atomically. Three TS files change shape (`synced-store.ts` gains a workspace-scoped subscription helper, `realtime.ts` switches the workspace-scoped tables to it and adds a membership-change resubscribe listener, `sync.ts` gains the new RPC wrapper). The Zustand workspaces-store gains `currentRole` and `memberCount` derived from a join.

**Tech Stack:** PostgreSQL 15 (Supabase) · Supabase JS (`@supabase/supabase-js` v2) · Zustand · Vitest · Supabase MCP tools for branch / migration / verification.

**Spec reference:** `docs/superpowers/specs/2026-05-13-multi-user-workspaces-design.md` §3, §4 (Migration A only), §8, §11.1. Decisions locked 2026-05-14: viewer-can-comment YES, `disabled` retroactive YES, owner-deletion doc-only v1, email service Resend. None of those four bite into Plan 1 — they all land in Plan 2/3 — but the schema this plan installs is the substrate they depend on.

**Out of scope for this plan (deliberately):**
- `workspace_invites` table + accept RPC (Plan 2).
- `WorkspaceMembersDialog`, invite form, role-aware editor toolbar, viewer-disabled buttons (Plan 2).
- `sharing_policy` enum + column (Plan 3).
- Resend Edge Function + deep-link extension for `notterai://invite/<token>` (Plan 2).
- Dropping the redundant `workspaces.user_id` column (deferred — spec §10.5).

---

## File Structure

**Create:**
- `supabase/migrations/2026-05-14-workspace-members.sql` — the migration. Single transaction; verification DO blocks fail-fast.

**Modify:**
- `src/lib/sync.ts` — add `createWorkspaceWithOwner` (RPC wrapper); rewrite `fetchWorkspaces` to call the new `get_my_workspaces` RPC (returns role + member count in one round-trip); extend `WorkspaceRecord` interface.
- `src/lib/synced-store.ts` — add `subscribeWorkspaceTable(channel, table, workspaceIds, refetchAndApply)` for workspace-scoped tables. Keep existing `subscribeUserTable` for account-scoped tables (`user_preferences`, `agent_profiles`).
- `src/lib/realtime.ts` — switch `workspaces` / `projects` / `subjects` / `subject_versions` / `subject_comments` to `subscribeWorkspaceTable`; add a `workspace_members` listener filtered by `user_id=eq.<auth.uid()>` that rebuilds the channel on membership change.
- `src/lib/workspaces/workspace-manager.ts` — `add()` and `bootstrap()`'s lazy-default branch call the new RPC instead of `pushWorkspace`.
- `src/stores/workspaces-store.ts` — add `currentRole: 'owner' | 'editor' | 'viewer' | null`, `memberCounts: Record<string, number>`, and `applyMembershipChange()` reducer; recompute `currentRole` on `currentWorkspaceId` change and on `applyRemoteWorkspaces`.

**Test:**
- `src/lib/__tests__/sync-workspaces.test.ts` — new file. Tests `createWorkspaceWithOwner` happy path and the new shape of `fetchWorkspaces`.
- `src/stores/__tests__/workspaces-store-multi-user.test.ts` — new file. Tests `currentRole` derivation when `currentWorkspaceId` changes and when `applyRemoteWorkspaces` lands fresh rows.

**Smoke-test on staging (no file):** documented in Task 11 as a manual checklist applied to a fresh Supabase branch.

---

## Task 1: Write the migration SQL

**Files:**
- Create: `supabase/migrations/2026-05-14-workspace-members.sql`

The migration is a single SQL file with verification DO blocks. Idempotent where possible (`on conflict do nothing` on the backfill, `create policy if not exists` is NOT a thing in Postgres so policies are dropped explicitly first).

- [ ] **Step 1: Create the file with the full migration body**

```sql
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
--    Self-referential SELECT is safe: PostgreSQL evaluates the inner query
--    under the same RLS, the inner query is restricted to `user_id =
--    auth.uid()` (an index probe), the set converges on the caller's own
--    membership rows, and recursion terminates after one level.
drop policy "members_seed_temp_permissive" on workspace_members;

create policy "members_read_self_workspaces" on workspace_members
  for select using (
    workspace_id in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

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
  current_role text,
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
    me.role as current_role,
    (select count(*) from workspace_members m where m.workspace_id = w.id) as member_count
  from workspaces w
  join workspace_members me on me.workspace_id = w.id and me.user_id = auth.uid()
  order by w.created_at asc;
$$;

grant execute on function get_my_workspaces() to authenticated;
```

- [ ] **Step 2: Run a static lint pass on the SQL**

Run: `git diff --check supabase/migrations/2026-05-14-workspace-members.sql`
Expected: no whitespace warnings.

Read the file once end-to-end. Sanity checks: every `do $$ ... $$` block declares its locals; every `create policy` has a unique name within its table; every `references` clause names an existing table; every trigger function has `set search_path = public` (SECURITY DEFINER without it is a known privilege-escalation vector).

- [ ] **Step 3: Commit the migration file**

```bash
git add supabase/migrations/2026-05-14-workspace-members.sql
git commit -m "feat(workspaces): migration A — workspace_members + RLS rewrite + workspace_id denorm

Adds the schema substrate for multi-user workspaces (spec
2026-05-13-multi-user-workspaces-design.md §3, §4, §11.1).

No client behavior change yet: every user remains the sole owner-member of
their own workspaces and workspace_role() returns 'owner' for them.
Plan 2 will introduce invites and non-owner members.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Apply the migration to a Supabase branch and smoke-test it

Verifying the migration on a branch BEFORE we touch the client is the load-bearing safety. If any DO block raises here, the migration is unsound and the client changes are stalled.

**Files:** none changed (read-only ops against Supabase via MCP).

- [ ] **Step 1: Create a Supabase branch named `migration-a-smoke`**

Use the Supabase MCP: `mcp__plugin_supabase_supabase__create_branch` with `confirm_cost_id` from `get_cost` first. Branch name: `migration-a-smoke`. Branches the prod schema + data into a fresh project ref.

Capture the new branch's project ref from the tool response.

- [ ] **Step 2: Apply the migration to the branch**

Use `mcp__plugin_supabase_supabase__apply_migration` with the branch's project ref. `name`: `2026_05_14_workspace_members`. `query`: the full SQL body from Task 1 Step 1.

Expected: success, no exception raised by any DO block. If a DO block raises, the response will surface the `RAISE` message — read it, diagnose, fix the migration source file, drop the branch, repeat.

- [ ] **Step 3: Verify table + indexes + policies exist**

Use `mcp__plugin_supabase_supabase__execute_sql` against the branch:

```sql
-- Membership table + indexes
select tablename, indexname from pg_indexes where tablename = 'workspace_members' order by indexname;
```
Expected rows: `workspace_members_one_owner_per_workspace_idx`, `workspace_members_pkey`, `workspace_members_user_id_idx`, `workspace_members_workspace_id_idx`.

```sql
-- Policies on each rewritten table
select tablename, policyname from pg_policies
where tablename in ('workspaces','projects','subjects','subject_versions','subject_comments','workspace_members')
order by tablename, policyname;
```
Expected: every table has the new policies from the migration; none of the old `_user_isolation` / `users own X` policies remain.

```sql
-- Helper functions + RPCs
select proname, provolatile, prosecdef from pg_proc
where proname in ('is_workspace_member','workspace_role','create_workspace_with_owner','prevent_last_owner_orphan','get_my_workspaces');
```
Expected 5 rows: `is_workspace_member` (s/false), `workspace_role` (s/false), `create_workspace_with_owner` (v/true), `prevent_last_owner_orphan` (v/false), `get_my_workspaces` (s/false).

- [ ] **Step 4: Verify backfill — every existing workspace has exactly one owner**

```sql
select w.id, w.name, m.role
from workspaces w
left join workspace_members m on m.workspace_id = w.id and m.role = 'owner'
where m.user_id is null;
```
Expected: zero rows. Any row means the seed missed (should have raised in DO block — belt-and-suspenders).

```sql
select workspace_id, count(*) as owners
from workspace_members where role = 'owner'
group by workspace_id having count(*) <> 1;
```
Expected: zero rows.

- [ ] **Step 5: Verify denormalized columns are populated and consistent with parent FK**

```sql
-- subjects vs parent project
select s.user_id, s.project_name, s.workspace_id as s_ws, p.workspace_id as p_ws
from subjects s
join projects p on p.user_id = s.user_id and p.name = s.project_name
where s.workspace_id <> p.workspace_id;
```
Expected: zero rows.

```sql
-- subject_versions vs parent subject
select sv.id, sv.workspace_id as sv_ws, s.workspace_id as s_ws
from subject_versions sv
join subjects s on s.id = sv.subject_id
where sv.workspace_id <> s.workspace_id;
```
Expected: zero rows.

```sql
-- subject_comments vs parent subject
select sc.id, sc.workspace_id as sc_ws, s.workspace_id as s_ws
from subject_comments sc
join subjects s on s.id = sc.subject_id
where sc.workspace_id <> s.workspace_id;
```
Expected: zero rows.

- [ ] **Step 6: Verify the security advisors flag nothing new**

`mcp__plugin_supabase_supabase__get_advisors` with `type: 'security'` against the branch. Expected: no NEW errors compared to the baseline. RLS-disabled-on-public-table is the failure mode to watch for; every new table has `enable row level security` in the migration.

- [ ] **Step 7: Delete the smoke-test branch**

Use `mcp__plugin_supabase_supabase__delete_branch`. The branch was throw-away; production prod will get the migration in Task 11 once the whole plan is reviewed.

---

## Task 3: Add `createWorkspaceWithOwner` to sync.ts and extend `fetchWorkspaces`

**Files:**
- Modify: `src/lib/sync.ts` (extend `WorkspaceRecord` interface; add `createWorkspaceWithOwner`; rewrite `fetchWorkspaces` to call the `get_my_workspaces` RPC)

- [ ] **Step 1: Extend the `WorkspaceRecord` interface**

In `src/lib/sync.ts`, replace the existing `WorkspaceRecord` (around line 238) with:

```ts
export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** Caller's role in this workspace. 'owner' for any workspace the caller created (every workspace, in Plan 1). */
  currentRole: 'owner' | 'editor' | 'viewer';
  /** Total members in this workspace. Always 1 in Plan 1. */
  memberCount: number;
}
```

- [ ] **Step 2: Modify `fetchWorkspaces` to call the `get_my_workspaces` RPC**

Replace the function body (around line 247) with:

```ts
export async function fetchWorkspaces(userId: string): Promise<WorkspaceRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  // userId is kept in the signature so call sites don't change, but the RPC
  // reads auth.uid() server-side — we don't pass it. A PostgREST embed
  // (`workspaces?select=*,workspace_members(role,count)` + an .eq filter)
  // was considered first but is unsound: .eq('workspace_members.user_id',
  // ...) filters BOTH embeds by table name, leaking the user filter into
  // the unfiltered members_count and yielding 1 per workspace. The RPC
  // encapsulates the join + scalar subquery and is immune to that.
  void userId;
  try {
    const { data, error } = await supabase.rpc('get_my_workspaces');
    if (error) {
      console.error('[sync] fetchWorkspaces failed:', error);
      return null;
    }
    return (data ?? []).map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      isDefault: row.is_default,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentRole: row.current_role as 'owner' | 'editor' | 'viewer',
      memberCount: Number(row.member_count),
    }));
  } catch (e) {
    console.error('[sync] fetchWorkspaces threw:', e);
    return null;
  }
}
```

- [ ] **Step 3: Add the `createWorkspaceWithOwner` RPC wrapper**

In `src/lib/sync.ts`, immediately AFTER `pushWorkspace` (around line 303), add:

```ts
/**
 * Atomically create a workspace + its owner-member row via SECURITY DEFINER
 * RPC. Returns the inserted workspace row.
 *
 * Used instead of `pushWorkspace` for new workspace creation. The RPC handles
 * the is_default partial-unique-index dance internally (clears the previous
 * default in the same transaction).
 */
export async function createWorkspaceWithOwner(
  workspace: Omit<WorkspaceRecord, 'createdAt' | 'updatedAt' | 'currentRole' | 'memberCount'>,
): Promise<{ ok: true } | { ok: false; code: 'duplicate_name' | 'not_authenticated' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase.rpc('create_workspace_with_owner', {
      ws_id: workspace.id,
      ws_name: workspace.name,
      ws_is_default: workspace.isDefault,
    });
    if (error) {
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_name', message: error.message };
      }
      if ((error as any).code === '42501' || /not_authenticated/.test(error.message)) {
        return { ok: false, code: 'not_authenticated', message: error.message };
      }
      console.error('[sync] createWorkspaceWithOwner failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] createWorkspaceWithOwner threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(workspaces): createWorkspaceWithOwner RPC + member-aware fetchWorkspaces

Plan 1, Task 3. WorkspaceRecord now carries currentRole and memberCount
embedded from workspace_members. createWorkspaceWithOwner wraps the
SECURITY DEFINER RPC for atomic workspace+owner-row insertion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `subscribeWorkspaceTable` to synced-store.ts

**Files:**
- Modify: `src/lib/synced-store.ts`

- [ ] **Step 1: Add the new subscription helper**

Append to `src/lib/synced-store.ts` immediately AFTER `subscribeUserTable` (the existing function ends around line 77):

```ts
/**
 * Subscribe to postgres_changes for a workspace-scoped table. Used for
 * `projects`, `subjects`, `subject_versions`, `subject_comments`, and
 * `workspaces` itself — tables whose rows are now visible to any member of
 * the workspace, not just to the row's owner.
 *
 * The filter `workspace_id=in.(<list>)` admits events on any row whose
 * workspace_id is in the caller's member-workspace list. For `workspaces`
 * itself the filter is on `id` instead of `workspace_id` — the caller passes
 * `idColumn: 'id'`.
 *
 * If the list of workspace ids changes (the caller joined/left a workspace),
 * the channel must be rebuilt with a fresh subscription — postgres_changes
 * filters are not mutable after the channel subscribes.
 */
export function subscribeWorkspaceTable(
  channel: RealtimeChannel,
  table: string,
  workspaceIds: string[],
  refetchAndApply: () => Promise<void>,
  idColumn: 'workspace_id' | 'id' = 'workspace_id',
): RealtimeChannel {
  // No workspace ids = no subscription. The caller will rebuild the channel
  // once a workspace appears (bootstrap path).
  if (workspaceIds.length === 0) return channel;
  const filter = `${idColumn}=in.(${workspaceIds.join(',')})`;
  return channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table, filter },
    () => {
      refetchAndApply().catch((e) =>
        console.error(`[synced-store] refetch ${table} failed:`, e),
      );
    },
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/synced-store.ts
git commit -m "feat(workspaces): subscribeWorkspaceTable helper for member-scoped realtime

Plan 1, Task 4. Workspace-scoped tables now filter realtime events by
workspace_id=in.(<member ws ids>) instead of user_id=eq.<caller>, so a
member sees events for rows they CAN read but did not author.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Switch workspace-scoped tables in realtime.ts to `subscribeWorkspaceTable`

**Files:**
- Modify: `src/lib/realtime.ts`

- [ ] **Step 1: Replace `startRealtimeSync` body**

Replace the entire `startRealtimeSync` function (currently lines 15–80) with:

```ts
export function startRealtimeSync(userId: string): void {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();
  for (const c of supabase.getChannels()) {
    if (c.topic.includes('db-sync')) {
      supabase.removeChannel(c);
    }
  }

  const refetchProjects = async () => {
    const projects = await fetchProjects(userId);
    if (projects) usePlannerStore.getState().applyRemoteProjects(projects);
  };
  const refetchSubjects = async () => {
    const subjects = await fetchSubjects(userId);
    if (subjects) await usePlannerStore.getState().applyRemoteSubjects(subjects);
  };
  const refetchSubjectVersions = async () => {
    const currentSubjectId = useSubjectVersionsStore.getState().currentSubjectId;
    if (!currentSubjectId) return;
    const versions = await fetchSubjectVersions(currentSubjectId);
    if (versions) useSubjectVersionsStore.getState().applyRemoteVersions(versions);
  };
  const refetchSubjectComments = async () => {
    const currentSubjectId = useSubjectVersionsStore.getState().currentSubjectId;
    if (!currentSubjectId) return;
    const comments = await fetchSubjectComments(currentSubjectId);
    if (comments) useSubjectVersionsStore.getState().applyRemoteComments(comments);
  };
  const refetchWorkspaces = async () => {
    const rows = await fetchWorkspaces(userId);
    if (rows) useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
  };

  // Workspace ids the user is a member of. In Plan 1 this equals "workspaces
  // the user owns" because there are no invites yet — the set was just
  // hydrated by WorkspaceManager.bootstrap before we got here.
  const memberWsIds = useWorkspacesStore.getState().workspaces.map((w) => w.id);

  const channelName = `db-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let ch = supabase.channel(channelName);

  // user_preferences stays on the inline payload listener (account-scoped, not workspace).
  ch = ch.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'user_preferences', filter: `user_id=eq.${userId}` },
    (payload) => {
      const row = payload.new as any;
      if (!row || payload.eventType === 'DELETE') return;
      useAppStore.getState().applyRemotePreferences({
        darkMode: row.dark_mode,
        language: row.language,
      });
    },
  );

  // Workspace-scoped tables. workspaces filters on `id`, the rest on
  // `workspace_id`.
  ch = subscribeWorkspaceTable(ch, 'workspaces',        memberWsIds, refetchWorkspaces,        'id');
  ch = subscribeWorkspaceTable(ch, 'projects',          memberWsIds, refetchProjects);
  ch = subscribeWorkspaceTable(ch, 'subjects',          memberWsIds, refetchSubjects);
  ch = subscribeWorkspaceTable(ch, 'subject_versions',  memberWsIds, refetchSubjectVersions);
  ch = subscribeWorkspaceTable(ch, 'subject_comments',  memberWsIds, refetchSubjectComments);

  // Membership change listener: filter by user_id of the caller because
  // workspace_members rows for OTHER users in the same workspace are also
  // visible (RLS admits all rows where the caller is a member). We only need
  // to react when the caller's own membership set changes.
  ch = ch.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'workspace_members', filter: `user_id=eq.${userId}` },
    () => {
      // The user joined or left a workspace. Rebuild the channel so the
      // workspace_id=in.(...) filter list reflects the new set.
      void rebuildRealtimeOnMembershipChange(userId);
    },
  );

  channel = ch.subscribe();
}
```

- [ ] **Step 2: Add `rebuildRealtimeOnMembershipChange` and update imports**

Add at the top of `src/lib/realtime.ts`, replacing the current import block (lines 1–11):

```ts
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAppStore } from '@/stores/app-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  fetchProjects, fetchSubjects,
  fetchSubjectVersions, fetchSubjectComments, fetchWorkspaces,
} from '@/lib/sync';
import { subscribeWorkspaceTable } from '@/lib/synced-store';
```

(Removed `subscribeUserTable` from the import — it's no longer used by `startRealtimeSync`; the `user_preferences` listener is inline. If `subscribeUserTable` is referenced elsewhere it stays in `synced-store.ts` as-is.)

Then add this helper function in `src/lib/realtime.ts`, AFTER `stopRealtimeSync`:

```ts
/**
 * Re-fetch the caller's workspaces and rebuild the realtime channel so the
 * `workspace_id=in.(...)` filter list reflects newly-joined or left
 * workspaces. Triggered by a workspace_members change event scoped to the
 * caller. No-op for Plan 1 in practice (single-user accounts never receive
 * such events), but the wiring is in place for Plan 2's invites.
 */
async function rebuildRealtimeOnMembershipChange(userId: string): Promise<void> {
  try {
    const rows = await fetchWorkspaces(userId);
    if (!rows) return;
    const prevIds = new Set(useWorkspacesStore.getState().workspaces.map((w) => w.id));
    const nextIds = new Set(rows.map((w) => w.id));
    const same = prevIds.size === nextIds.size && [...prevIds].every((id) => nextIds.has(id));
    useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
    if (!same) {
      // Membership set changed. Stop+start the channel with the new filter list.
      stopRealtimeSync();
      startRealtimeSync(userId);
    }
  } catch (e) {
    console.error('[realtime] rebuildRealtimeOnMembershipChange failed:', e);
  }
}
```

- [ ] **Step 3: Confirm vite + typescript compile clean**

Run: `npm run build`
Expected: tsc completes without error. Any error from the new imports → fix path. The build is a smoke check, NOT a substitute for runtime testing — that comes in Task 11.

- [ ] **Step 4: Commit**

```bash
git add src/lib/realtime.ts
git commit -m "feat(workspaces): realtime channel filters on workspace_id, rebuilds on membership change

Plan 1, Task 5. Workspace-scoped tables (workspaces, projects, subjects,
subject_versions, subject_comments) now subscribe with
workspace_id=in.(<member-ws-ids>). A workspace_members listener scoped to
the caller's own membership rows tears down and rebuilds the channel when
the caller joins/leaves a workspace. user_preferences keeps its account-
scoped inline listener.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add `currentRole` + `memberCounts` to workspaces-store

**Files:**
- Modify: `src/stores/workspaces-store.ts`

- [ ] **Step 1: Write the failing test**

Create `src/stores/__tests__/workspaces-store-multi-user.test.ts`:

```ts
// src/stores/__tests__/workspaces-store-multi-user.test.ts
//
// Plan 1, Task 6 — verifies that useWorkspacesStore derives currentRole
// from the currently active workspace and exposes memberCounts keyed by id.
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { WorkspaceRecord } from '@/lib/sync';

function ws(over: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: 'w1',
    userId: 'u1',
    name: 'w',
    isDefault: false,
    createdAt: '2026-05-14T00:00:00Z',
    updatedAt: '2026-05-14T00:00:00Z',
    currentRole: 'owner',
    memberCount: 1,
    ...over,
  };
}

describe('workspaces-store multi-user fields', () => {
  beforeEach(() => {
    useWorkspacesStore.getState().reset();
  });

  it('currentRole is null when there is no current workspace', () => {
    expect(useWorkspacesStore.getState().currentRole).toBeNull();
  });

  it('currentRole follows currentWorkspaceId', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      ws({ id: 'w1', currentRole: 'owner', memberCount: 1 }),
      ws({ id: 'w2', currentRole: 'viewer', memberCount: 3 }),
    ]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    expect(useWorkspacesStore.getState().currentRole).toBe('owner');
    useWorkspacesStore.getState().setCurrentWorkspaceId('w2');
    expect(useWorkspacesStore.getState().currentRole).toBe('viewer');
  });

  it('memberCounts is keyed by workspace id', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      ws({ id: 'w1', memberCount: 1 }),
      ws({ id: 'w2', memberCount: 4 }),
    ]);
    expect(useWorkspacesStore.getState().memberCounts).toEqual({ w1: 1, w2: 4 });
  });

  it('reset clears currentRole and memberCounts', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([ws({ id: 'w1', memberCount: 2 })]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    useWorkspacesStore.getState().reset();
    expect(useWorkspacesStore.getState().currentRole).toBeNull();
    expect(useWorkspacesStore.getState().memberCounts).toEqual({});
  });

  it('currentRole is null when currentWorkspaceId references an unknown id', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([ws({ id: 'w1', currentRole: 'owner' })]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w999');
    expect(useWorkspacesStore.getState().currentRole).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npm test -- src/stores/__tests__/workspaces-store-multi-user.test.ts`
Expected: FAIL — `currentRole` and `memberCounts` are not defined on the store yet.

- [ ] **Step 3: Implement the new fields**

Replace `src/stores/workspaces-store.ts` body (entire file after the header comment block) with:

```ts
import { create } from 'zustand';
import type { WorkspaceRecord } from '@/lib/sync';
import { registerResettableStore } from '@/lib/accounts/store-registry';

type Role = 'owner' | 'editor' | 'viewer';

interface WorkspacesState {
  workspaces: WorkspaceRecord[];
  currentWorkspaceId: string | null;
  /** Caller's role in the current workspace. Null if no current workspace or it's not in `workspaces`. */
  currentRole: Role | null;
  /** Map workspace id → total members. Always 1 in Plan 1. */
  memberCounts: Record<string, number>;
  loading: boolean;

  setCurrentWorkspaceId: (id: string | null) => void;
  applyRemoteWorkspaces: (rows: WorkspaceRecord[]) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

const INITIAL = {
  workspaces: [] as WorkspaceRecord[],
  currentWorkspaceId: null as string | null,
  currentRole: null as Role | null,
  memberCounts: {} as Record<string, number>,
  loading: false,
};

function deriveRole(rows: WorkspaceRecord[], currentId: string | null): Role | null {
  if (!currentId) return null;
  const row = rows.find((w) => w.id === currentId);
  return row?.currentRole ?? null;
}

function deriveCounts(rows: WorkspaceRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of rows) out[w.id] = w.memberCount;
  return out;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  ...INITIAL,
  setCurrentWorkspaceId: (id) => {
    const rows = get().workspaces;
    set({ currentWorkspaceId: id, currentRole: deriveRole(rows, id) });
  },
  applyRemoteWorkspaces: (rows) => {
    const currentId = get().currentWorkspaceId;
    set({
      workspaces: rows,
      currentRole: deriveRole(rows, currentId),
      memberCounts: deriveCounts(rows),
    });
  },
  setLoading: (loading) => set({ loading }),
  reset: () => set(INITIAL),
}));

registerResettableStore(() => useWorkspacesStore.getState().reset());
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npm test -- src/stores/__tests__/workspaces-store-multi-user.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npm test`
Expected: every existing test still passes. The change to `applyRemoteWorkspaces` is additive — pre-existing tests that don't read `currentRole` / `memberCounts` are unaffected.

If any test now fails: most likely cause is a fixture that constructs a `WorkspaceRecord` without `currentRole` / `memberCount` (the type tightened). Update the fixture to include `currentRole: 'owner'` and `memberCount: 1` — the Plan 1 single-user defaults.

- [ ] **Step 6: Commit**

```bash
git add src/stores/workspaces-store.ts src/stores/__tests__/workspaces-store-multi-user.test.ts
git commit -m "feat(workspaces): currentRole + memberCounts in workspaces-store

Plan 1, Task 6. Both fields derive from the embedded shape returned by
fetchWorkspaces. setCurrentWorkspaceId and applyRemoteWorkspaces are the
only mutators that recompute currentRole.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: WorkspaceManager — switch `add` and bootstrap's lazy-default branch to `createWorkspaceWithOwner`

**Files:**
- Modify: `src/lib/workspaces/workspace-manager.ts`

- [ ] **Step 1: Update imports**

Replace the import block (lines 29–33) with:

```ts
import {
  fetchWorkspaces, createWorkspaceWithOwner, renameWorkspace, setWorkspaceDefault,
  deleteWorkspace, moveProjectsBetweenWorkspaces,
} from '@/lib/sync';
```

(Drops `pushWorkspace`, adds `createWorkspaceWithOwner`.)

- [ ] **Step 2: Replace the lazy-default branch in `bootstrap()`**

Replace the block currently at lines 112–127 (the `if (remote.length === 0) { ... }` body) with:

```ts
    // 2. Lazy default for project-less accounts. Uses the RPC so the
    // workspace + owner-member rows land atomically.
    if (remote.length === 0) {
      const id = crypto.randomUUID();
      const result = await createWorkspaceWithOwner({
        id, userId, name: "User's workspace", isDefault: true,
      });
      if (result.ok) {
        remote = (await fetchWorkspaces(userId)) ?? [];
      } else {
        // Re-fetch — a parallel sign-in on another device may have created one.
        remote = (await fetchWorkspaces(userId)) ?? [];
      }
    }
```

Note: we drop the optimistic synthetic record from the old code and rely on a re-fetch. The RPC returns the row but we want the embedded `currentRole`/`memberCount` shape from `fetchWorkspaces`, so a re-fetch is the clean path.

Also update the `this.workspaces = remote.map(...)` line right below to drop the now-redundant fields (lines 129–130 are unchanged):

```ts
    this.workspaces = remote.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault }));
```

(No change here — the `WorkspaceSummary` type stays as it was.)

- [ ] **Step 3: Replace the `add()` method's `pushWorkspace` call**

Find the line in `add()` (around line 168):

```ts
    const result = await pushWorkspace({ id, userId, name: input.name, isDefault });
```

Replace with:

```ts
    const result = await createWorkspaceWithOwner({ id, userId, name: input.name, isDefault });
```

Also, the `if (isDefault) { ... await setWorkspaceDefault(id, userId); ... }` block immediately after becomes redundant: the RPC clears the previous default in the same transaction. Delete the entire `if (isDefault)` block (currently lines 171–179) — the in-memory `this.workspaces` update for the previous default still needs to happen, so keep ONLY:

```ts
    if (isDefault) {
      this.workspaces = this.workspaces.map((w) => ({ ...w, isDefault: false }));
    }
```

- [ ] **Step 4: Run the existing workspace-manager tests (if any) and the planner-store-workspaces test**

Run: `npm test -- src/lib/workspaces src/stores/__tests__/planner-store-workspaces.test.ts`
Expected: all green. If a test mocked `pushWorkspace` and now no longer matches, update the mock to `createWorkspaceWithOwner` with the same return shape.

- [ ] **Step 5: Commit**

```ts
git add src/lib/workspaces/workspace-manager.ts
git commit -m "feat(workspaces): WorkspaceManager.add and bootstrap use createWorkspaceWithOwner RPC

Plan 1, Task 7. The previous pushWorkspace + setWorkspaceDefault pair is
replaced by a single SECURITY DEFINER RPC that inserts the workspace row
and the owner workspace_members row atomically, plus handles is_default
clearing in the same transaction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Add a sync.ts unit test for the new shape

**Files:**
- Create: `src/lib/__tests__/sync-workspaces.test.ts`

- [ ] **Step 1: Write the test file**

```ts
// src/lib/__tests__/sync-workspaces.test.ts
//
// Plan 1, Task 8 — verifies createWorkspaceWithOwner and fetchWorkspaces (the
// RPC variant — get_my_workspaces) round-trip the expected shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

beforeEach(() => {
  rpcMock.mockReset();
});

describe('createWorkspaceWithOwner', () => {
  it('returns ok:true on success', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { createWorkspaceWithOwner } = await import('@/lib/sync');
    const result = await createWorkspaceWithOwner({
      id: 'w1', userId: 'u1', name: 'My workspace', isDefault: false,
    });
    expect(result).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith('create_workspace_with_owner', {
      ws_id: 'w1', ws_name: 'My workspace', ws_is_default: false,
    });
  });

  it('returns duplicate_name on Postgres 23505', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate' } });
    const { createWorkspaceWithOwner } = await import('@/lib/sync');
    const result = await createWorkspaceWithOwner({
      id: 'w1', userId: 'u1', name: 'dup', isDefault: false,
    });
    expect(result).toEqual({ ok: false, code: 'duplicate_name', message: 'duplicate' });
  });

  it('returns not_authenticated on Postgres 42501', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authenticated' } });
    const { createWorkspaceWithOwner } = await import('@/lib/sync');
    const result = await createWorkspaceWithOwner({
      id: 'w1', userId: 'u1', name: 'x', isDefault: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_authenticated');
  });
});

describe('fetchWorkspaces RPC shape', () => {
  it('maps current_role / member_count into the WorkspaceRecord', async () => {
    rpcMock.mockResolvedValue({
      data: [{
        id: 'w1', user_id: 'u1', name: 'w', is_default: true,
        created_at: '2026-05-14T00:00:00Z', updated_at: '2026-05-14T00:00:00Z',
        current_role: 'owner',
        member_count: 1,
      }],
      error: null,
    });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rpcMock).toHaveBeenCalledWith('get_my_workspaces');
    expect(rows).toHaveLength(1);
    expect(rows![0].currentRole).toBe('owner');
    expect(rows![0].memberCount).toBe(1);
  });

  it('coerces member_count (bigint → number)', async () => {
    // pg bigint returns as string in some setups; the wrapper must coerce.
    rpcMock.mockResolvedValue({
      data: [{
        id: 'w1', user_id: 'u1', name: 'w', is_default: false,
        created_at: '2026-05-14T00:00:00Z', updated_at: '2026-05-14T00:00:00Z',
        current_role: 'editor',
        member_count: '4',
      }],
      error: null,
    });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rows![0].memberCount).toBe(4);
    expect(rows![0].currentRole).toBe('editor');
  });

  it('returns null on Supabase error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rows).toBeNull();
  });

  it('returns empty array when caller is in zero workspaces', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/lib/__tests__/sync-workspaces.test.ts`
Expected: PASS — 6 cases green.

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/sync-workspaces.test.ts
git commit -m "test(workspaces): createWorkspaceWithOwner + fetchWorkspaces RPC shape

Plan 1, Task 8. Covers the happy path of the RPC wrapper, duplicate_name
mapping, not_authenticated mapping, and the current_role/member_count
unpacking from the get_my_workspaces RPC (including bigint coercion).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Run the full test suite and the typecheck

This is a checkpoint — every change is committed, and we should leave Plan 1's TS in a green state before moving to the staging smoke test.

- [ ] **Step 1: Full test run**

Run: `npm test`
Expected: every test passes. Any failure here means a fixture or mock didn't pick up the new `WorkspaceRecord` shape — fix at the call site (almost always: add `currentRole: 'owner'` and `memberCount: 1` to the literal).

- [ ] **Step 2: Typecheck via build**

Run: `npm run build`
Expected: tsc completes with 0 errors. Vite build follows.

- [ ] **Step 3: If both pass, no commit needed — proceed to Task 10**

---

## Task 10: Apply Migration A to production via MCP

This is the irreversible step. Plan 1 is reviewed at this point (per the user's preferred workflow: Codex-review the plan first, then ship).

**Files:** none changed.

- [ ] **Step 1: Confirm Plan 1 review is complete and the user has approved the migration**

The user has explicitly OK'd applying Migration A to prod. (If not, stop and ask.)

- [ ] **Step 2: Apply migration via MCP to the prod project**

Use `mcp__plugin_supabase_supabase__apply_migration` on the production project ref. `name`: `2026_05_14_workspace_members`. `query`: identical to Task 1 Step 1.

Expected: success, no DO block raises. Any failure → STOP, do not run rollback automatically — surface the error to the user, the schema is in a partial state until they decide.

- [ ] **Step 3: Re-run the verification queries from Task 2 Steps 3–6 against prod**

Same SQL, same expected results. If anything diverges from staging, surface to user — do not proceed with the client code that depends on prod schema.

- [ ] **Step 4: Run `get_advisors` against prod**

`mcp__plugin_supabase_supabase__get_advisors` with `type: 'security'`. Expected: no new errors compared to pre-migration baseline.

---

## Task 11: Smoke-test the running app against production schema

End-to-end smoke against the running Tauri app. Manual checklist — no automated test covers Supabase realtime + RLS end-to-end yet.

**Files:** none changed.

- [ ] **Step 1: Restart the dev app**

If `npm run tauri dev` is still running from earlier, stop and restart. The supabase client needs to re-handshake against the migrated schema.

- [ ] **Step 2: Sign in with an existing account, verify workspace list loads**

The default workspace should appear in `WorkspaceSwitcher`. Open the planner — projects, subjects, comments should all still be visible.

Expected: no console errors. Specifically, no RLS denial errors (`new row violates row-level security policy`).

- [ ] **Step 3: Create a new workspace via WorkspaceManagerDialog**

Click the workspace switcher → "Manage workspaces" → "Add workspace". Give it a name. Submit.

Expected: workspace appears in the switcher. `useWorkspacesStore.workspaces` now includes it with `currentRole: 'owner'` and `memberCount: 1`. No 23505 / 42501 errors in the console.

Verify via MCP:
```sql
select w.name, m.role, m.user_id from workspaces w
join workspace_members m on m.workspace_id = w.id
where w.name = '<the name you used>';
```
Expected: one row, role = 'owner', user_id = the signed-in user's id.

- [ ] **Step 4: Create a subject + version + comment in the new workspace**

Switch to the new workspace. Create a project. Create a subject. Create a version. Post a comment.

Expected: all succeed. Verify via MCP:
```sql
select s.id as subject_id, s.workspace_id as s_ws,
       sv.id as version_id, sv.workspace_id as sv_ws,
       sc.id as comment_id, sc.workspace_id as sc_ws
from subjects s
left join subject_versions sv on sv.subject_id = s.id
left join subject_comments sc on sc.subject_id = s.id
where s.workspace_id = '<new workspace id>';
```
Expected: every row's `*_ws` equals the new workspace id. The `set_workspace_id_on_*` triggers fired correctly.

- [ ] **Step 5: Move a project between workspaces, verify cascade**

In the planner, right-click a project → "Move to workspace" → pick another workspace. Submit.

Verify the cascade fired:
```sql
select s.id, s.workspace_id, sv.workspace_id, sc.workspace_id
from subjects s
left join subject_versions sv on sv.subject_id = s.id
left join subject_comments sc on sc.subject_id = s.id
where s.project_name = '<the moved project>' and s.user_id = '<your user id>';
```
Expected: every row's `workspace_id` equals the target workspace id (the cascade trigger updated children).

- [ ] **Step 6: Sign in a second test account, verify isolation**

Use the user-menu account-switcher to sign in a different account (or use a private window with a different test user). The new account should see only its own workspaces — none of the first account's. Create a project, verify the first account's planner doesn't show it.

Expected: complete isolation. Realtime events for account A's mutations do not appear in account B's planner. This is the load-bearing RLS check — if it fails, STOP and roll back.

- [ ] **Step 7: Verify realtime works on a second device / second window**

Open the app in a second window (or signed in on a second device with the same account). Make a change in window 1 — the second window should reflect it within ~1 second via realtime. Specifically test: create a subject in window 1, see it appear in window 2.

Expected: realtime updates flow. If they don't, the `workspace_id=in.(...)` filter is wrong — diagnose.

- [ ] **Step 8: Commit the smoke-test confirmation**

No code change. Just record completion:

```bash
git commit --allow-empty -m "chore(workspaces): Plan 1 smoke-test passed on prod

Plan 1 Migration A applied to prod and verified end-to-end:
- Workspaces / projects / subjects / versions / comments CRUD round-trips
  in the new RLS model.
- Multi-workspace per user works; second test account is isolated.
- Realtime fans out via workspace_id=in.(...) filter on a second window.
- Cascade trigger on project move correctly re-targets child workspace_id.

Plan 2 (invites + members dialog + role-aware UI) is the next milestone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Update memory**

Save a project memory recording Plan 1 ship date and what's next.

Save `C:\Users\Guilherme\.claude\projects\C--Users-Guilherme-Code-Projetos-Notter-AI\memory\project_multi_user_plan1_shipped.md`:

```markdown
---
name: multi-user-plan1-shipped
description: "Multi-user workspaces Plan 1 (Migration A + sync/store plumbing) shipped to prod. Plan 2/3 are the next milestones."
metadata:
  type: project
---

Plan 1 (migration A + sync/store plumbing) for multi-user workspaces shipped 2026-05-14.

**What's live in prod:**
- `workspace_members` table + `is_workspace_member` / `workspace_role` helpers.
- RLS rewrite on workspaces / projects / subjects / subject_versions / subject_comments — all now check membership via `is_workspace_member(workspace_id)`.
- Denormalized `workspace_id` column + triggers on subjects/versions/comments.
- `create_workspace_with_owner` RPC for atomic workspace+owner creation.
- `WorkspaceRecord` carries `currentRole` and `memberCount`; `useWorkspacesStore` exposes them.
- Realtime channel uses `workspace_id=in.(...)` filter and rebuilds on `workspace_members` change.

**What's NOT shipped (Plan 2):**
- `workspace_invites` + accept RPC.
- Resend Edge Function for invite emails.
- Deep-link extension for `notterai://invite/<token>`.
- `WorkspaceMembersDialog`, invite form, role-aware editor toolbar.

**What's NOT shipped (Plan 3):**
- `sharing_policy` enum + column.
- Sharing-policy dropdown in `WorkspaceManagerDialog`.

**Locked decisions from spec §12 (2026-05-14):**
- Viewers CAN comment (spec §3.2; RLS split policy on `subject_comments.UPDATE/DELETE` admits viewer-self).
- `sharing_policy = 'disabled'` retroactively 403s existing share-links (spec §6.1).
- Owner-deletion is doc-only in v1 — Delete-account dialog enumerates affected workspaces; no DB guard yet (spec §9.1).
- Email service: Resend (spec §5.3, overrode the spec's Postmark recommendation).

**Spec:** `docs/superpowers/specs/2026-05-13-multi-user-workspaces-design.md`
**Plan 1:** `docs/superpowers/plans/2026-05-14-multi-user-workspaces-migration-a.md`
```

Then update `MEMORY.md` index — add at the top:
```
- [Multi-user workspaces Plan 1 shipped](project_multi_user_plan1_shipped.md) — migration A live in prod; Plan 2 (invites+UI) and Plan 3 (sharing policy) are next
```

```bash
git add C:/Users/Guilherme/.claude/projects/C--Users-Guilherme-Code-Projetos-Notter-AI/memory/
git commit --allow-empty -m "docs(memory): record multi-user Plan 1 ship"
```

(The memory dir isn't in the project's git, but this command will only commit if changes exist — harmless if it's a no-op.)

---

## Risk register & rollback

**The RLS rewrite is the only irreversible step in this plan.** Everything else is additive code that's gated by `if (isSupabaseConfigured)` or wrapped in `try`. If something goes wrong:

| Scenario | Detection | Recovery |
|---|---|---|
| Migration DO block raises during Task 2/10 | Tool surfaces the `RAISE` message | The migration is transactional; rolled back automatically. Edit the SQL, redeploy. |
| Single-user CRUD fails after migration | Smoke-test Task 11 catches it | Re-install the OLD policies via a new migration (the policy bodies are in source control: `users own projects`, `users own subjects`, `subject_versions_user_isolation`, `subject_comments_user_isolation`, `workspaces_user_isolation`). Drop the new ones. The DENORMALIZED `workspace_id` columns and `workspace_members` table stay — they're invisible to the old policy set. |
| Realtime stops firing | Second-window smoke test catches it | Check Supabase Realtime quotas; verify channel filter syntax by inspecting `supabase.getChannels()` in the dev console. The filter format is `workspace_id=in.(<comma-separated-uuids>)`. |
| `WorkspaceRecord` shape breaks a test fixture | `npm test` red in Task 9 | Add `currentRole: 'owner'` and `memberCount: 1` to the fixture literal. |
| `useWorkspacesStore.applyRemoteWorkspaces` race with `setCurrentWorkspaceId` | Console error or `currentRole === null` when it should be defined | Both setters now compute `currentRole` from a fresh snapshot inside the reducer. If the order is `setCurrent → apply` AND apply doesn't include the current ws id, `currentRole` correctly becomes `null` — that's expected behavior. |

The "schema is in a partial state" failure mode in Task 10 Step 2 is the worst case. Supabase migrations are transactional, so a DO-block raise rolls everything back. If a network error severs the connection mid-apply, the migration is either fully applied or fully rolled back — there is no half-state. Even so: take a manual snapshot via the Supabase dashboard before Task 10.

### Carry-overs explicitly deferred to Plan 2

These are NOT bugs in Plan 1 — they're future hazards the implementor of Plan 2 needs to handle. Flagged here so they aren't rediscovered the hard way.

- **`upsertUserRows` assertion is a Plan-2 time-bomb.** `synced-store.ts:21` asserts `r.user_id !== userId` throws. In Plan 1 every row's `user_id` is the caller's id (single-user accounts), so the assertion never trips. In Plan 2 a non-owner editor calling `pushProjects` may cache a row whose `user_id` is the workspace owner's id — at which point the editor's `userId` won't match and the assertion fires. **Plan 2 must either:** loosen the assertion to check `workspace_id` membership instead of `user_id` equality, OR change `pushProjects` to set `user_id = currentUserId` on every upsert (making `user_id` "last writer" semantics, which is what spec §8.2 recommends).
- **Membership change debounce.** `rebuildRealtimeOnMembershipChange` tears down and rebuilds the realtime channel on every `workspace_members` event scoped to the caller. A rapid-fire sequence (user accepts 5 invites in 2 seconds) triggers 5 sequential rebuilds. No correctness bug — the early-exit `if (!same)` check no-ops identical replays — but it's a perf cliff under bulk-accept. Plan 2 should debounce the rebuild (~500ms trailing edge) if invite bulk-accept becomes a UX.
- **`get_my_workspaces` does not embed pending invites.** Plan 2's `WorkspaceMembersDialog` will want both the user's workspaces AND any pending invites addressed to their email. Plan 2 should add a sibling RPC `get_my_pending_invites()` rather than extending `get_my_workspaces`.

---

## Self-review notes

- **Spec coverage:** §3 (membership model) → migration body. §4 (schema migration + RLS) → migration body. §8.1 / §8.2 / §8.3 (sync engine implications) → Tasks 4/5. §11.1 (Migration A ordering) → migration body. §11.4 step 1 ("Deploy migration A; client behavior unchanged; smoke test") → Tasks 10/11. Items NOT covered here are deliberate Plan 2/3 deferrals.
- **Placeholder scan:** No "TBD", "TODO", or "implement later" in any task body. Code blocks in every step that touches code; commands with expected outputs in every step that runs something.
- **Type consistency:** `Role` is `'owner' | 'editor' | 'viewer'` consistently. `WorkspaceRecord.currentRole` is the narrow `Role` (non-nullable); `useWorkspacesStore.currentRole` is `Role | null` (null when no current workspace). `createWorkspaceWithOwner` takes `Omit<WorkspaceRecord, 'createdAt' | 'updatedAt' | 'currentRole' | 'memberCount'>` — same shape across Task 3 and Task 7's call site.
- **The migration is the only thing that needs human review.** RLS bugs leak data; the TS plumbing is testable. Codex-review SHOULD focus on the SQL.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-multi-user-workspaces-migration-a.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because Task 1 (migration SQL) and Task 5 (realtime refactor) each have non-trivial surface that benefits from a fresh-context review.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster if you want to ride along.

**Which approach?**
