# Multi-User Workspaces — Design

**Date:** 2026-05-13
**Status:** Draft pending user review.
**Baseline:** post-`2026-05-12-comment-anchors.sql`. Builds on the single-user workspaces feature shipped 2026-05-10 (`supabase/migrations/2026-05-10-workspaces.sql`, `src/lib/workspaces/workspace-manager.ts`, `src/stores/workspaces-store.ts`).
**Supersedes for the membership dimension:** `docs/superpowers/specs/2026-05-10-workspaces-design.md` §10 "no sharing across accounts" — that constraint is being lifted here. Everything else in the 2026-05-10 spec (workspace switcher, default workspace, move-to-workspace, fs layout) stays.
**Does NOT touch:** the (separately specced) anonymous **share-link** feature. This design defines the `sharing_policy` field that gates it (§6) and stops there.

---

## 1. Goal

Lift the single-owner constraint baked into every plan-collab table so that a workspace can carry 2..N members with one of a small set of roles, while leaving:

- The single-user (1 member = owner) path **identical in behavior** post-migration. No existing user notices anything until they invite someone.
- Every account-scoped concern (preferences, agents, account-level MCP token, secure-store layout, fs layout) unchanged. Workspaces gain members; accounts remain the auth identity.
- A clean integration point for the downstream share-link feature via a new `sharing_policy` enum on `workspaces`.

The membership layer is the precondition for plan-review as a real team product. The share-link is the precondition for ad-hoc external review. Both ship on top of the same plumbing; this spec lays it.

## 2. Out of scope (explicit)

- **Org / billing / team hierarchy above workspaces.** No `organizations` table, no seat counting, no purchase-of-plans-for-employees flow. Section §10 calls out the hooks left for it.
- **Public web preview of plans / unauth share read.** That's the share-link spec, downstream.
- **Per-project ACLs inside a workspace.** A workspace has ONE permission level — your role applies to every project, subject, version, comment in it.
- **Granular comment-level permissions** (e.g. "viewer can't comment"). Out of scope; viewers can comment in v1 (see §3.2 role table).
- **Email customization, branded transactional templates, magic-link tracking.** v1 uses Supabase's built-in invite emails (§5).
- **Presence indicators / live cursors / concurrent editing CRDT.** Multi-user implies these are now meaningful but they ship later.
- **Transferring workspace ownership across accounts.** v1 model: owner is set at workspace creation, cannot be re-assigned. Workaround: invite the target as `editor`, then have a developer-side ops procedure to flip the column. §8 explains.
- **Removing the account-level realtime channel restructure.** Realtime keeps filtering by `user_id=eq.<auth.uid()>` for tables that have a denormalized `user_id` (subjects, subject_versions, subject_comments). For the new `workspace_members` and `workspace_invites`, realtime filters by `workspace_id=eq.<...>` with the workspace list read on bootstrap. §7 details.

---

## 3. Membership model

### 3.1 Tables

Two new tables. One join, one invite.

```sql
-- 1. workspace_members
create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'editor', 'viewer')),
  -- The user who issued the invite that produced this membership.
  -- NULL for the implicit-owner row created by the v1->v2 backfill
  -- (no inviter exists; the user already owned the workspace).
  invited_by   uuid references auth.users(id) on delete set null,
  invited_at   timestamptz,
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx     on workspace_members(user_id);
create index workspace_members_workspace_id_idx on workspace_members(workspace_id);

-- Exactly one owner per workspace (partial unique index).
create unique index workspace_members_one_owner_per_workspace_idx
  on workspace_members(workspace_id) where role = 'owner';

alter table workspace_members enable row level security;
alter publication supabase_realtime add table workspace_members;

-- 2. workspace_invites
create table workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  -- Lowercased, trimmed at insert time. Always populated even when the invitee
  -- already has an account, so the "Pending invites" UI can render without an
  -- auth.users join (which RLS can't do under user-context anyway).
  email         text not null,
  -- NULL until accepted. On acceptance set to auth.uid() of the redeemer.
  accepted_by   uuid references auth.users(id) on delete set null,
  invited_by    uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('editor', 'viewer')),
  -- High-entropy opaque token in the invite URL. SHA-256 of this is what's
  -- stored; the raw token is only seen at create time + in the invite email.
  -- See §5.2 for the choice.
  token_hash    text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, email, accepted_at, revoked_at)
    -- Practical effect: one OPEN invite per (workspace, email) at a time;
    -- once accepted_at or revoked_at is set the row is terminal and a fresh
    -- invite can be created.
);

create index workspace_invites_token_hash_idx on workspace_invites(token_hash);
create index workspace_invites_email_idx      on workspace_invites(email);
create index workspace_invites_workspace_idx  on workspace_invites(workspace_id);

alter table workspace_invites enable row level security;
alter publication supabase_realtime add table workspace_invites;
```

Notes:

- **Why composite PK `(workspace_id, user_id)` and not a synthetic id**: makes the existence-check inside every RLS policy a primary-key probe. PostgreSQL inlines this; we get the same plan as the current `auth.uid() = user_id` checks. A synthetic id would force `EXISTS(SELECT 1 FROM workspace_members WHERE ...)` to hit a secondary index every read.
- **`one_owner_per_workspace` partial unique index**: same pattern as `workspaces_one_default_per_user_idx`. Owner is a single named role; if we ever want N owners we drop this index. Doing N=1 lets the UI confidently show one "Owner" row.
- **`accepted_by` vs implicit `auth.uid()` on acceptance**: storing it explicitly lets us trace who redeemed a forwarded invite without joining against `workspace_members`.
- **Why `token_hash` and not `token`**: an invite link in someone's email/Slack history that leaks should not be a DB credential. Hashing means a DB read leak doesn't immediately yield usable invite tokens. See §5.2 for the verify flow.

### 3.2 Roles

Three roles. Smallest set that covers the team-review use case without painting us into a corner.

| Role | Can read workspace + projects + subjects + versions + comments | Can write subjects / versions | Can post comments | Can resolve comments | Can rename / delete workspace | Can manage members (invite / remove / change roles) | Can change `sharing_policy` |
|---|---|---|---|---|---|---|---|
| `owner` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `editor` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `viewer` | ✓ | ✗ | ✓ (see decision below) | ✓ own comments only | ✗ | ✗ | ✗ |

**Decision: viewers CAN comment in v1.** This is the smallest divergence from a strict role model and the loudest user signal that comments are not "read-only" furniture in a plan-review product. Editors-only-can-comment is the more conservative cut; we lock viewer-can-comment because it's the value-proposition of the workspace for an external reviewer who doesn't have edit rights on the plan itself. **User to sanity-check.**

**Decision: no "admin" role distinct from owner.** Owner is the single billing/policy seat. If we later want delegated admin (an editor who can also invite), it becomes a fourth role with admin = (editor + invite). Adding a role is additive in the policies; not blocking.

**Decision: viewers can resolve THEIR OWN comments.** Editors can resolve any. The RLS policy on `subject_comments` UPDATE is therefore `role IN ('owner','editor') OR (role = 'viewer' AND author_user_id = auth.uid())`. This lets a viewer un-flag their own concern without giving them blanket comment-mutation power.

### 3.3 Leaving / removal

- **Leave a workspace** (any role): self-DELETE from `workspace_members WHERE workspace_id = $ws AND user_id = auth.uid()`. RLS allows it. Owners cannot leave — they must transfer ownership first (which is out of scope for v1; §2). UI exposes "Leave workspace" only to non-owners.
- **Remove a member** (owner only): DELETE from `workspace_members WHERE workspace_id = $ws AND user_id = $target_user_id`. RLS-policed.
- **Cascade behavior on member removal**: comments authored by the removed user STAY (a workspace's history is the workspace's, not the leaver's — same model as GitHub). Subjects/versions edited by them STAY. The only thing that disappears is the membership row and the implicit read access. See §9 for the edge case where the removed user had unsynced local edits.

### 3.4 Workspace deletion + the owner

The `workspaces.user_id` column today is the implicit owner. Under the membership model that column becomes redundant — the owner is `(SELECT user_id FROM workspace_members WHERE workspace_id = $id AND role = 'owner')`. **We keep the column** for a transition period (migration C does NOT drop it) for two reasons:

1. The `ON DELETE CASCADE` from `auth.users(id)` on `workspaces.user_id` keeps the existing "delete account → delete workspaces I own" behavior automatic. Without it we'd need an ON DELETE trigger.
2. The realtime client filter `workspace_id IN (select id from workspaces where user_id = auth.uid())` is wrong post-migration, but several places in the codebase still use it as a perf hint. We swap them in migration A but leave the column as a fallback.

**Decision: defer dropping `workspaces.user_id` to a later migration.** Documented but explicitly not done now. §10 covers what changes when we drop it.

---

## 4. Schema migration & RLS rewrite

Three migrations, each independently shippable, each behind a feature flag if needed.

### 4.1 Migration A — `workspace_members` + RLS rewrite

`supabase/migrations/2026-05-XX-workspace-members.sql` (date stamped on ship day).

**Step 1: Create `workspace_members` and seed the implicit-owner row.**

```sql
-- (table + indexes per §3.1)

-- Seed: every existing workspace gets one owner row mirroring workspaces.user_id.
insert into workspace_members (workspace_id, user_id, role, joined_at)
select id, user_id, 'owner', created_at
from workspaces
on conflict (workspace_id, user_id) do nothing;
```

The `on conflict` makes this idempotent — re-running the migration on a partial state is a no-op.

**Step 2: Verify the seed.**

```sql
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
```

**Step 3: Define the membership-check helper.** Inline `EXISTS(...)` in every policy is fine but a SECURITY DEFINER function is cleaner and lets us add caching/logging later without rewriting all policies.

```sql
-- Stable + parallel-safe so the planner can fold it into the outer query.
create or replace function is_workspace_member(ws_id uuid)
returns boolean
language sql
stable
security invoker  -- runs as the calling user; reads RLS-protected tables fine
                  -- because workspace_members policy below admits self-rows.
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
```

These two helpers are the only new functions. Every policy reads from them.

**Step 4: Rewrite every relevant table's policies.** Drop the old `_user_isolation` policy on each, install new policies. Listed table-by-table in §4.3.

**Step 5: Backfill RLS for `workspace_members` itself.**

```sql
-- A member can SEE rows for any workspace they are a member of.
create policy "members_read_self_workspaces" on workspace_members
  for select using (
    workspace_id in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

-- Only owners can INSERT new members (i.e. accept an invite is via SECURITY DEFINER RPC; §5).
-- Direct INSERTs are denied for everyone except the RPC.
create policy "members_insert_owner_only" on workspace_members
  for insert with check (
    workspace_role(workspace_id) = 'owner'
  );

-- Only owners can UPDATE roles. A viewer/editor cannot promote themselves.
create policy "members_update_owner_only" on workspace_members
  for update using (
    workspace_role(workspace_id) = 'owner'
  ) with check (
    workspace_role(workspace_id) = 'owner'
  );

-- DELETE: self OR owner removing someone else.
create policy "members_delete_self_or_owner" on workspace_members
  for delete using (
    user_id = auth.uid()
    or workspace_role(workspace_id) = 'owner'
  );
```

There's a subtle bootstrap problem: the `members_read_self_workspaces` policy's subquery reads from `workspace_members`, which has RLS enabled. PostgreSQL handles self-referential RLS by evaluating the policy in `bypassrls = false` mode — the subquery itself goes through RLS. Since the inner query is exactly the same shape as the outer, it converges: the only rows the inner sees are rows for the current user. **Verified pattern** (Supabase docs recommend exactly this for member tables).

### 4.2 Migration B — `workspace_invites` + accept RPC

`supabase/migrations/2026-05-XX-workspace-invites.sql`.

Creates the table per §3.1 plus a SECURITY DEFINER RPC for redemption:

```sql
-- Accept an invite. Returns the workspace_id on success or raises.
-- SECURITY DEFINER because the redeemer is NOT yet a member, so the
-- members_insert_owner_only policy would block them. We trust the function's
-- own gating instead.
create or replace function accept_workspace_invite(token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash    text := encode(digest(token, 'sha256'), 'hex');
  v_invite  workspace_invites;
  v_uid     uuid := auth.uid();
  v_email   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Read the invite by hash. No RLS bypass leak: the function returns its
  -- own error codes for caller-friendly diagnostics.
  select * into v_invite from workspace_invites
  where token_hash = v_hash
  limit 1;

  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite_revoked' using errcode = 'P0001';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite_already_accepted' using errcode = 'P0001';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;

  -- Email check. The caller's auth user must have an email matching the invite.
  -- This prevents a leaked invite link from being redeemed by an arbitrary
  -- third party who happens to obtain it.
  select email into v_email from auth.users where id = v_uid;
  if lower(v_email) <> lower(v_invite.email) then
    raise exception 'invite_email_mismatch' using errcode = '42501';
  end if;

  insert into workspace_members (workspace_id, user_id, role, invited_by, invited_at, joined_at)
  values (v_invite.workspace_id, v_uid, v_invite.role, v_invite.invited_by, v_invite.created_at, now())
  on conflict (workspace_id, user_id) do nothing;

  update workspace_invites
    set accepted_at = now(), accepted_by = v_uid
    where id = v_invite.id;

  return v_invite.workspace_id;
end $$;

grant execute on function accept_workspace_invite(text) to authenticated;
```

RLS for `workspace_invites`:

```sql
-- Members of a workspace can see all invites for that workspace (so the
-- "Pending invites" UI works).
create policy "invites_select_members" on workspace_invites
  for select using ( is_workspace_member(workspace_id) );

-- Only owners can create invites.
create policy "invites_insert_owner" on workspace_invites
  for insert with check ( workspace_role(workspace_id) = 'owner' );

-- Only owners can revoke (UPDATE to set revoked_at).
create policy "invites_update_owner" on workspace_invites
  for update using ( workspace_role(workspace_id) = 'owner' )
              with check ( workspace_role(workspace_id) = 'owner' );

-- Hard delete reserved for owners too. Soft-delete via revoked_at is preferred.
create policy "invites_delete_owner" on workspace_invites
  for delete using ( workspace_role(workspace_id) = 'owner' );
```

`pgcrypto` extension must be enabled for `digest()` — included in the migration:

```sql
create extension if not exists pgcrypto;
```

### 4.3 Migration C — `sharing_policy` enum on `workspaces`

`supabase/migrations/2026-05-XX-workspace-sharing-policy.sql`.

```sql
create type workspace_sharing_policy as enum (
  'members_only',         -- default; only authenticated workspace members
  'public_link_allowed',  -- members PLUS the (separate) share-link feature may be used
  'disabled'              -- explicitly forbids share links AND, in future, any
                          -- non-member access channel. Stricter than default.
);

alter table workspaces
  add column sharing_policy workspace_sharing_policy not null default 'members_only';
```

No RLS change here. The `sharing_policy` column is read by the share-link creation flow (downstream); §6 details the gate.

Three values, not two, because the difference between "we allow it but no link exists" (`members_only`) and "we forbid it" (`disabled`) matters for compliance. A team admin in a regulated industry needs to be able to lock the workspace, not just refrain from creating links.

### 4.4 Per-table RLS rewrite — exhaustive

Every table that currently filters by `auth.uid() = user_id` and whose data is workspace-scoped needs its policy rewritten. Table-by-table:

#### `workspaces`

```sql
drop policy "workspaces_user_isolation" on workspaces;

-- SELECT: any member.
create policy "workspaces_member_read" on workspaces
  for select using ( is_workspace_member(id) );

-- UPDATE (rename, set_default, sharing_policy): owner only.
create policy "workspaces_owner_update" on workspaces
  for update using ( workspace_role(id) = 'owner' )
              with check ( workspace_role(id) = 'owner' );

-- INSERT: any authenticated user (creating their own workspace). The
-- workspace_members owner row is inserted in the same transaction (client-side
-- or via a SECURITY DEFINER helper). See §7 "WorkspaceManager.add".
create policy "workspaces_authenticated_insert" on workspaces
  for insert with check ( user_id = auth.uid() );

-- DELETE: owner only.
create policy "workspaces_owner_delete" on workspaces
  for delete using ( workspace_role(id) = 'owner' );
```

#### `projects`

```sql
drop policy "users own projects" on projects;

-- SELECT: any member of the workspace.
create policy "projects_member_read" on projects
  for select using ( is_workspace_member(workspace_id) );

-- INSERT: owner or editor.
create policy "projects_member_write_insert" on projects
  for insert with check ( workspace_role(workspace_id) in ('owner','editor') );

-- UPDATE: owner or editor.
create policy "projects_member_write_update" on projects
  for update using ( workspace_role(workspace_id) in ('owner','editor') )
              with check ( workspace_role(workspace_id) in ('owner','editor') );

-- DELETE: owner only. (Project deletion cascades to subjects/versions/comments
-- across the entire workspace's content — keep it owner-gated.)
create policy "projects_owner_delete" on projects
  for delete using ( workspace_role(workspace_id) = 'owner' );
```

The existing `projects.user_id` column stays. It's now "the user who created this project," NOT "the only person who can access it." We keep it filled at INSERT time so existing client code that reads `row.user_id` doesn't blow up. **It is NOT used by RLS anymore.**

#### `subjects`

`subjects` has no `workspace_id` column today; it's scoped via `(user_id, project_name, file_name)`. Two options:

- **Option A:** Keep status quo, scope via the projects FK. Policy becomes a correlated subquery:
  ```sql
  using ( exists (
    select 1 from projects p
    where p.name = subjects.project_name
      and p.user_id = subjects.user_id
      and is_workspace_member(p.workspace_id)
  ))
  ```
  PostgreSQL inlines `is_workspace_member` as STABLE; the EXISTS hits `projects(user_id, name)` PK. Two index probes per row.
- **Option B:** Denormalize `subjects.workspace_id` (NOT NULL, kept in sync via trigger), policy reads it directly. One row probe per row.

**Decision: Option B.** The correlated subquery is twice the work per row, and `subjects` is one of the hottest tables on read. The denormalization cost is a trigger on INSERT/UPDATE that copies `workspace_id` from the parent project — same pattern we already use for `user_id` on `subject_versions`/`subject_comments`. The schema change:

```sql
alter table subjects add column workspace_id uuid references workspaces(id) on delete restrict;
-- Backfill from projects:
update subjects s
  set workspace_id = p.workspace_id
  from projects p
  where p.user_id = s.user_id and p.name = s.project_name;
-- After backfill:
alter table subjects alter column workspace_id set not null;
create index subjects_workspace_id_idx on subjects(workspace_id);

-- Trigger keeps subjects.workspace_id == projects.workspace_id.
-- Fires on INSERT of subjects (looks up parent project's workspace_id) and on
-- UPDATE of projects.workspace_id (cascades to all child subjects).
create or replace function set_subject_workspace_id()
returns trigger language plpgsql security definer as $$
begin
  select workspace_id into new.workspace_id from projects
  where user_id = new.user_id and name = new.project_name;
  if new.workspace_id is null then
    raise exception 'subjects.workspace_id resolve failed for (%, %)',
      new.user_id, new.project_name;
  end if;
  return new;
end $$;

create trigger set_workspace_id_on_subjects
  before insert on subjects
  for each row execute function set_subject_workspace_id();

create or replace function cascade_project_workspace_to_subjects()
returns trigger language plpgsql security definer as $$
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
```

```sql
drop policy "users own subjects" on subjects;

create policy "subjects_member_read" on subjects
  for select using ( is_workspace_member(workspace_id) );

create policy "subjects_member_write" on subjects
  for all using ( workspace_role(workspace_id) in ('owner','editor') )
          with check ( workspace_role(workspace_id) in ('owner','editor') );
```

Notice the `for all` for write covers INSERT/UPDATE/DELETE. SELECT is the separate `_read` policy so viewers can read but not write.

The "move project to workspace" flow already triggers a single `projects.workspace_id` UPDATE. The new trigger turns that into "also update every child subject's workspace_id." This is exactly the behavior the existing spec assumed; we're just now making it explicit at the SQL layer.

#### `subject_versions`

Same Option-B pattern. Add `workspace_id`, denormalize via trigger from parent subject.

```sql
alter table subject_versions add column workspace_id uuid references workspaces(id) on delete restrict;
update subject_versions sv
  set workspace_id = s.workspace_id
  from subjects s
  where s.id = sv.subject_id;
alter table subject_versions alter column workspace_id set not null;
create index subject_versions_workspace_id_idx on subject_versions(workspace_id);

create or replace function set_subject_version_workspace_id()
returns trigger language plpgsql security definer as $$
begin
  select workspace_id into new.workspace_id from subjects where id = new.subject_id;
  if new.workspace_id is null then
    raise exception 'subject_versions.workspace_id resolve failed';
  end if;
  return new;
end $$;
create trigger set_workspace_id_on_subject_versions
  before insert on subject_versions
  for each row execute function set_subject_version_workspace_id();

-- On cascade from project move, subject_versions get updated too. Add a
-- trigger on subjects.workspace_id UPDATE that fans out.
create or replace function cascade_subject_workspace_to_versions()
returns trigger language plpgsql security definer as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    update subject_versions
      set workspace_id = new.workspace_id where subject_id = new.id;
    update subject_comments
      set workspace_id = new.workspace_id where subject_id = new.id;
  end if;
  return new;
end $$;
create trigger cascade_workspace_id_from_subjects
  after update of workspace_id on subjects
  for each row execute function cascade_subject_workspace_to_versions();
```

```sql
drop policy "subject_versions_user_isolation" on subject_versions;

create policy "versions_member_read" on subject_versions
  for select using ( is_workspace_member(workspace_id) );

-- Versions are append-only; no UPDATE policy needed.
create policy "versions_member_insert" on subject_versions
  for insert with check ( workspace_role(workspace_id) in ('owner','editor') );

-- DELETE: owner only. (Audit-trail integrity — editors don't get to rewrite history.)
create policy "versions_owner_delete" on subject_versions
  for delete using ( workspace_role(workspace_id) = 'owner' );
```

#### `subject_comments`

Same denormalization. Plus the viewer-can-comment-on-own decision turns into a slightly less uniform policy.

```sql
alter table subject_comments add column workspace_id uuid references workspaces(id) on delete restrict;
update subject_comments sc set workspace_id = s.workspace_id from subjects s where s.id = sc.subject_id;
alter table subject_comments alter column workspace_id set not null;
create index subject_comments_workspace_id_idx on subject_comments(workspace_id);

create or replace function set_subject_comment_workspace_id()
returns trigger language plpgsql security definer as $$
begin
  select workspace_id into new.workspace_id from subjects where id = new.subject_id;
  if new.workspace_id is null then
    raise exception 'subject_comments.workspace_id resolve failed';
  end if;
  return new;
end $$;
create trigger set_workspace_id_on_subject_comments
  before insert on subject_comments
  for each row execute function set_subject_comment_workspace_id();
```

```sql
drop policy "subject_comments_user_isolation" on subject_comments;

create policy "comments_member_read" on subject_comments
  for select using ( is_workspace_member(workspace_id) );

-- Any member (including viewer) can post a comment, but the author must be self.
create policy "comments_member_insert" on subject_comments
  for insert with check (
    is_workspace_member(workspace_id)
    and author_user_id = auth.uid()
  );

-- UPDATE: editors/owners can resolve/edit any; viewers can resolve/edit own.
create policy "comments_update_scoped" on subject_comments
  for update using (
    workspace_role(workspace_id) in ('owner','editor')
    or (workspace_role(workspace_id) = 'viewer' and author_user_id = auth.uid())
  ) with check (
    workspace_role(workspace_id) in ('owner','editor')
    or (workspace_role(workspace_id) = 'viewer' and author_user_id = auth.uid())
  );

-- DELETE: editors/owners can delete any; viewers can delete own.
create policy "comments_delete_scoped" on subject_comments
  for delete using (
    workspace_role(workspace_id) in ('owner','editor')
    or (workspace_role(workspace_id) = 'viewer' and author_user_id = auth.uid())
  );
```

The existing `set_subject_owner_id()` trigger that fills `user_id` from parent subject stays as-is. `user_id` is still "the workspace owner's id" — denormalized from `subjects.user_id` which is denormalized from `projects.user_id`. We don't use it for RLS anymore but it's the column the realtime `user_id=eq.<>` filter still watches (until §7's realtime refactor lands).

#### Per-account tables — `user_preferences`, `agent_profiles`, `board_tasks`, `actions`

**No change.** These are account-scoped, not workspace-scoped. A user's theme, agent profiles, and (deprecated but still alive) board/actions don't span workspaces. Keep `auth.uid() = user_id` everywhere.

This is a deliberate decision and an important one: workspaces scope **content**, not **settings**. If we later want shared per-workspace settings (e.g. shared agent prompt config), that's a separate scope.

### 4.5 RLS audit summary

Tables that get a workspace-membership-based policy (changed by this design):

| Table | Old policy | New policy | Notes |
|---|---|---|---|
| `workspaces` | `auth.uid() = user_id` | `is_workspace_member(id)` for SELECT; `workspace_role(id) = 'owner'` for UPDATE/DELETE; `user_id = auth.uid()` for INSERT | Owner is now in `workspace_members`, not the `user_id` column. |
| `workspace_members` | new | self/owner-visibility, owner-only writes, self-or-owner deletes | §3.1. |
| `workspace_invites` | new | member-read, owner-write | §4.2. |
| `projects` | `auth.uid() = user_id` | `is_workspace_member(workspace_id)` for SELECT; `workspace_role(...) in ('owner','editor')` for INSERT/UPDATE; owner-only DELETE | `user_id` column retained, not used by RLS. |
| `subjects` | `auth.uid() = user_id` | `is_workspace_member(workspace_id)` for SELECT; role-based writes | Add denormalized `workspace_id` column + trigger. |
| `subject_versions` | `auth.uid() = user_id` | `is_workspace_member(workspace_id)` for SELECT; editors+ for INSERT; owner-only DELETE | Add denormalized `workspace_id` + trigger. |
| `subject_comments` | `auth.uid() = user_id` | `is_workspace_member(workspace_id)` for SELECT; member-insert (self-author); split UPDATE/DELETE per viewer-self-only rule | Add denormalized `workspace_id` + trigger. |

Tables NOT changed:

| Table | Policy stays | Why |
|---|---|---|
| `user_preferences` | `auth.uid() = user_id` | Account-scoped settings. |
| `agent_profiles` | `auth.uid() = user_id` | Account-scoped agents. |
| `board_tasks` | `auth.uid() = user_id` | Deprecated tab; not on the workspace surface. |
| `actions` | `auth.uid() = user_id` | Deprecated tab; not on the workspace surface. |

**Default-deny stance verification.** RLS enforces "deny by default" when enabled — if no policy matches, the row is invisible. Every changed table has explicit policies for SELECT/INSERT/UPDATE/DELETE. There is no `FOR ALL` policy that admits a viewer to write. The only mixed-permission table is `subject_comments`, whose split policy (viewer-self-only) is the deliberate one.

**Recursion safety.** The `workspace_members.members_read_self_workspaces` policy is the only self-referential one. PostgreSQL evaluates it correctly because the subquery is restricted to the same user (auth.uid()) — the policy is satisfied when the join converges on the user's own membership rows. Tested pattern.

**Helper function isolation.** `is_workspace_member` and `workspace_role` are `security invoker` + `stable`. They run as the caller and obey RLS. They cannot be used to elevate privilege. They're inlinable, so the planner folds them into the outer query.

---

## 5. Invite flow

### 5.1 Three states an invitee can be in

| State | What we do |
|---|---|
| **Already an account, signed in, browsing Notter** | Surface in-app notification ("You've been invited to <workspace>") via realtime on `workspace_invites` filtered by `email=eq.<theirEmail>`. Click → call `accept_workspace_invite(token)` RPC. No email required. |
| **Already an account, NOT currently signed in** | Send email with a deep link `notterai://invite/<token>` (Tauri custom scheme; same one used for OAuth callback). Click → app opens, prompts sign-in if needed, then redeems. |
| **No account yet** | Send email with the same deep link. Click → app opens, sign-up form pre-fills email and is locked to the invite's email (UX-only — the RPC enforces email match). After signup, redeem auto-fires once the session lands. |

### 5.2 Transport

**Decision: send invites via Supabase's built-in `auth.admin.inviteUserByEmail` API for the "no account yet" path, and a plain transactional email (Postmark or Resend; choose at implementation time) for the "already has account" path.**

Why this split:

- Supabase's invite API already creates a placeholder auth user and emails a magic link. That's exactly the signup-and-redeem flow for new users. We piggyback on it.
- But Supabase's invite email is generic — it doesn't say "Alice invited you to Project Apollo workspace." For the existing-user path we want a branded email with the workspace name, inviter name, and a single CTA. That's a transactional service.
- **Both paths** carry the invite `token` in the URL fragment, not as a `?query` (URL fragments don't go to servers if the link is ever pasted in a web preview).

**Decision: token is a 32-byte cryptographically random URL-safe string.** Generated client-side at invite-create time via `crypto.getRandomValues`. The DB stores `sha256(token)` in `token_hash`. The raw token is shown to the inviter once (so they can re-copy if email fails) and embedded in the email link. After 7 days it expires (`expires_at = now() + interval '7 days'`).

**Fallback: copy-and-share link.** Every successful invite-create dialog exposes a "Copy invite link" button. Doesn't depend on email delivery; the inviter can paste it in Slack/Teams. The deep-link format is the same: `notterai://invite/<token>`. The user must still have a matching email on the account to redeem (RPC check) — the link by itself is not enough.

### 5.3 Email service

**v1: Postmark.** Reasons:

- Better deliverability than Resend at our scale (we don't have a warm-up curve).
- Templates are server-side, version-controlled, and previewable; we don't bake HTML into the Tauri app.
- The free tier (100 emails/month) covers the alpha period of multi-user workspaces.

The email is sent from a Supabase Edge Function `send-workspace-invite` (deferred deploy) triggered by an insert into `workspace_invites`. The function reads inviter display name + workspace name, composes the Postmark template variables, and sends.

**Decision deferred / user to sanity-check:** Postmark vs Resend vs hosted SES. We're not blocking on this; the spec assumes Postmark and the implementation plan can swap to Resend with a one-file diff.

### 5.4 Redemption flow (client-side)

1. Tauri receives `notterai://invite/<token>` (existing OAuth deep-link handler in the codebase generalizes).
2. New helper `src/lib/workspaces/invite-acceptor.ts`:
   - If not signed in → store token in memory, redirect to sign-in screen with email pre-fill (extracted from the invite via `fetchInvitePreview(tokenHash)` — a SECURITY DEFINER RPC that returns workspace name + invitee email but nothing else, so the sign-in screen can say "Sign in as alice@acme.com to accept Bob's invite to Apollo").
   - If signed in but as the wrong email → toast "This invite is for alice@acme.com. Sign out and try again as Alice."
   - If signed in as the right email → call `supabase.rpc('accept_workspace_invite', { token })`. On success: refresh `useWorkspacesStore`, switch to the joined workspace, toast "Joined <name>."
3. On failure: parse the SQLSTATE returned by the RPC (`invite_expired`, `invite_revoked`, `invite_email_mismatch`, etc.) → human-readable toast.

`fetchInvitePreview` returns ONLY the workspace name and the invitee's email — not the inviter's identity (to avoid leaking who is inviting whom if the token leaks to a third party who has the right email by coincidence).

### 5.5 Removing / re-inviting

- **Revoke open invite**: owner clicks "Revoke" → `UPDATE workspace_invites SET revoked_at = now() WHERE id = $id`. The RPC's invariant check (`if v_invite.revoked_at is not null`) kicks in for any in-flight redemption.
- **Re-invite same email**: if the existing invite is open, the UNIQUE constraint on `(workspace_id, email, accepted_at, revoked_at)` prevents a duplicate. UI shows "Already invited (sent 3 days ago) — resend or revoke?" with a "Resend" action that calls the Edge Function with the existing token, and a "Revoke and re-invite" that sets `revoked_at` then opens the invite dialog fresh.
- **Re-invite a removed member**: removing a member deletes the `workspace_members` row but leaves the (long-since accepted) `workspace_invites` row terminal. A fresh INSERT into `workspace_invites` is allowed (the UNIQUE constraint on `(workspace_id, email, accepted_at, revoked_at)` is satisfied because one of `accepted_at`/`revoked_at` is set on the old row).

---

## 6. `sharing_policy` integration with the share-link feature

The downstream share-link feature (separately specced; not designed here) needs to be **gated** by a workspace-level policy so an enterprise admin can globally turn it off without going hunting for individual public links.

### 6.1 What gates what

Three values, two gates:

| `sharing_policy` value | Members can read/write (always) | Share-link creation allowed? | Existing share-links resolvable? |
|---|---|---|---|
| `members_only` (default) | ✓ | ✗ | n/a (no links exist) |
| `public_link_allowed` | ✓ | ✓ | ✓ |
| `disabled` | ✓ | ✗ | ✗ — links 403 even if they already exist |

The third row is the kicker. An admin who flips a workspace from `public_link_allowed` to `disabled` retroactively kills outstanding share-links without having to revoke each. That's the compliance story.

### 6.2 Where the gate lives

Two places:

1. **At share-link CREATE time.** The (downstream) `create_share_link(workspace_id, ...)` RPC reads `workspaces.sharing_policy` and rejects with `sharing_policy_disabled` unless the policy is `public_link_allowed`. RPC, not RLS, because RLS only sees the row being written, not the parent workspace's policy unless we add a correlated subquery — RPC is simpler and gives a cleaner error.
2. **At share-link READ time.** The downstream resolver (whatever it is — likely a public Edge Function) reads `workspaces.sharing_policy` BEFORE returning content. If `disabled`, return 403. If `members_only`, return 403 (the link shouldn't exist anyway but defense in depth).

This spec only commits to **the column and the enum** existing. The gate is described here so the downstream design knows where to plug in.

### 6.3 UI surface for `sharing_policy`

Single dropdown in the workspace settings panel (§7.3) with three options + helper text:

- "Members only — only signed-in members can access content"
- "Allow public links — members PLUS anyone with a valid share link"
- "Disabled — only members; existing share links won't work"

Owner-only writable. Default `members_only`. Changing to `disabled` raises a confirm dialog if there are outstanding share links (count comes from the downstream feature; UI hook left in §10).

---

## 7. UI changes

### 7.1 WorkspaceSwitcher (existing, light edits)

`src/components/WorkspaceSwitcher.tsx` already exists. Add:

- Below the workspace name row in the dropdown, a small member-count chip: "3 members." Reads from `useWorkspacesStore.workspaces[i].memberCount` (new field, populated by realtime — see §7.5).
- A new "Members & invites" entry below "Manage workspaces" → opens a new dialog `WorkspaceMembersDialog` (§7.2).

The switcher itself stays a chip+dropdown. The members affordance is a new entry, not a new top-level button — preserves the header density.

### 7.2 WorkspaceMembersDialog (new)

`src/components/WorkspaceMembersDialog.tsx`. Three sections in one dialog.

**Section 1: Members list.**
- Avatar + email + role chip per row. Active user's row marked "(you)."
- For owner: each non-self row has a role dropdown (`editor`/`viewer`) and a "Remove" button. The owner row's role chip is disabled — owner cannot be demoted in v1 (see §2 ownership transfer).
- For non-owner viewers: read-only list.
- For non-owner editors: read-only list except for a "Leave workspace" button at the bottom.

**Section 2: Pending invites.**
- Email + role + expiry + "Revoke" + "Resend" per row. Owner-only.
- Hides entirely for non-owners.

**Section 3: Invite form.**
- Email input + role dropdown (editor/viewer; owner is not in the role picker — you can't create another owner via invite) + "Send invite" button.
- Owner-only.
- On submit: WorkspaceMemberManager.invite(email, role) → toast success + clear form + refresh Section 2.

Realtime: subscribe to `workspace_members` and `workspace_invites` filtered by `workspace_id=eq.<currentWsId>`. Server-driven UI, same pattern as existing tables.

### 7.3 WorkspaceSettingsPanel (new, or embedded in WorkspaceManagerDialog)

Add a "Sharing policy" section to `WorkspaceManagerDialog` (or as a separate Settings tab inside it — implementation plan picks). Owner-only; non-owners see the current value as a read-only chip.

Contents:
- Sharing policy dropdown (three values, copy in §6.3).
- (Hook for downstream share-link feature: list of active links + revoke buttons. Out of scope this spec.)

### 7.4 PlannerTab and CommentsPanel — role-aware UI

Read `workspace_role(currentWorkspaceId)` from a new derived selector in `useWorkspacesStore`:

```ts
useWorkspacesStore((s) => s.currentRole) // 'owner' | 'editor' | 'viewer' | null
```

Populated alongside `currentWorkspaceId` from the `workspace_members` row for the current user. Updated on workspace switch and on realtime change of the member's role.

Components consume:
- `PlannerTab` editor toolbar: disable Save / New version buttons when `currentRole === 'viewer'`. Monaco itself stays read-only (set `readOnly: true` on the editor when viewer).
- `CommentsPanel`: comment compose box always enabled (viewers comment). Resolve button on a comment is shown only if `currentRole !== 'viewer'` OR `comment.authorUserId === currentUserId`.
- Project create/delete buttons in the sidebar: hidden for viewers; disabled-with-tooltip for non-owner editors on DELETE only.
- "Move project to workspace" kebab item: hidden for viewers, shown but constrained to other workspaces the user is also at least editor in (we don't let an editor in workspace A move a project to workspace B where they're a viewer — the move would render the project read-only to themselves).

The hide-disable distinction matters: hide things the user fundamentally can't do, disable+tooltip things they could do if they had a higher role.

### 7.5 Member-count fan-in

`useWorkspacesStore.workspaces[i].memberCount` is a derived field. Populated by:

- Initial fetch: `fetchWorkspaces(userId)` joins against a `workspace_members count(*)` subquery (PostgREST `select=*,member_count:workspace_members(count)` syntax).
- Realtime: subscription to `workspace_members` triggers a re-fetch of `workspace_members WHERE workspace_id IN <ids>`, recomputes the count in the store.

Cheaper than per-row subscription. We're not displaying the actual members of every workspace in the switcher, just the count.

### 7.6 Account-switch behavior unchanged

`registerResettableStore` already drops `useWorkspacesStore` state on account switch. No change. The new fields (`memberCount`, `currentRole`) reset with the rest of the store.

---

## 8. Sync engine implications

The existing sync engine (`src/lib/sync.ts` + `src/lib/realtime.ts` + `src/lib/synced-store.ts`) assumes one writer per row and uses `user_id` as the partition key for both realtime filters and `upsertUserRows`. Multi-user breaks two assumptions, mildly.

### 8.1 Realtime filter shape

Current pattern (`subscribeUserTable`):

```ts
ch.on('postgres_changes', {
  schema: 'public', table, filter: `user_id=eq.${userId}`
}, ...)
```

This works for tables where `user_id` is the workspace owner's id (which is the case post-migration too, because we kept the column denormalized). But it means a non-owner member subscribed to `subjects` won't see realtime events for subjects they CAN read — because the filter only emits rows where `user_id = <their auth.uid()>`, and those rows have a different `user_id` (the owner's).

**Fix:** for the tables that gain workspace-membership RLS, change the realtime filter from `user_id=eq.<auth.uid()>` to `workspace_id=in.(<comma-separated-list-of-ws-ids-user-is-member-of>)`.

```ts
// In realtime.ts startRealtimeSync:
const memberWsIds = useWorkspacesStore.getState().workspaces.map(w => w.id);
const wsFilter = `workspace_id=in.(${memberWsIds.join(',')})`;

ch = ch.on('postgres_changes', { schema: 'public', table: 'projects',         filter: wsFilter }, ...);
ch = ch.on('postgres_changes', { schema: 'public', table: 'subjects',         filter: wsFilter }, ...);
ch = ch.on('postgres_changes', { schema: 'public', table: 'subject_versions', filter: wsFilter }, ...);
ch = ch.on('postgres_changes', { schema: 'public', table: 'subject_comments', filter: wsFilter }, ...);
```

`workspaces` itself: filter by `id=in.(<member-ws-ids>)`. `workspace_members` and `workspace_invites`: same filter on `workspace_id`.

`user_preferences` keeps `user_id=eq.<auth.uid()>` (still account-scoped).

The list of `member-ws-ids` is dynamic: when the user joins a new workspace (accepts an invite) the filter must be rebuilt. **Resubscribe pattern:** on `workspace_members` change events that affect `user_id = auth.uid()`, tear down and rebuild the realtime channel. Same `startRealtimeSync` is called fresh. Already cheap (single channel + ~6 subscriptions).

### 8.2 `upsertUserRows` invariant

`upsertUserRows` today asserts `row.user_id === userId`:
```ts
if (r.user_id !== userId) throw new Error(...);
```

This is fine for `projects` (the `user_id` column still holds the row creator's id, which is the active user). But it's wrong if a member writes to a row that another member created — the row's existing `user_id` is the owner's id, not the writer's. Upserting from a non-owner member triggers the assertion.

**Fix:** loosen the assertion. The new invariant is "the row's `workspace_id` is one of the user's member workspaces." Implementation: pass the active workspace id alongside the user id to `upsertUserRows`, and assert `row.workspace_id === expectedWorkspaceId`. The `user_id` column becomes a free-form metadata column.

Actually, simpler: change the `user_id` field semantics from "row owner" to "row creator (last writer)." `pushProjects` sets `user_id = currentUserId` on every upsert; that's the writer's id. RLS doesn't care about `user_id` for projects anymore. The assertion holds (row.user_id == userId, by construction).

For `subjects`, the existing flow (`pushSubject`) already sets `user_id = userId` on every upsert. Same outcome. **No client-side code change** beyond the upsert payload, which already includes the right value.

**Caveat:** the trigger `set_subject_owner_id()` on `subject_versions` and `subject_comments` denormalizes `user_id` from the parent `subjects.user_id` row. That's the workspace OWNER's id (because the subject was created by the owner originally, or by whoever created it — but subjects' `user_id` gets cascade-updated when projects move). For RLS we don't care. For our purposes, the trigger continues to work; we just don't read `user_id` for membership purposes.

### 8.3 `realtime.ts` rebuild on membership change

Add a `workspace_members` subscription scoped to `user_id=eq.<auth.uid()>` (the user's own membership rows). On any event, call `useWorkspacesStore.refetchMemberships()` which:

1. Re-fetches the user's workspaces (via the existing `fetchWorkspaces` joined with `workspace_members`).
2. If the set differs, calls `stopRealtimeSync()` then `startRealtimeSync()` to rebuild the channel with the new ws-id list.

This is the path that picks up "you've been invited and accepted" without an app restart.

### 8.4 Optimistic UI considerations

Existing optimistic patterns (e.g. `markSubjectCurrentVersion` in `planner-store.ts`) write to local state before realtime confirms. With multi-user, two members can mutate in parallel. The realtime "last write wins" semantics keep both in eventual consistency but the **brief UI flicker** when a remote write overwrites a local optimistic one becomes user-visible.

**Decision: accept the flicker for v1.** The Phase E history-dropdown work already mitigates the worst case (the current-version pointer). For concurrent comment edits / version creation, the flicker is acceptable — we're not building a CRDT here. **User to sanity-check** if this is acceptable for the first beta.

### 8.5 MCP tool surface

The Rust MCP server today scopes everything by `auth.account_id`. With multi-user that's still correct — the MCP bearer represents an account, and Supabase RLS on the queries the MCP server issues (under the user's access token, see `src-tauri/src/mcp/supabase.rs`) takes care of the rest.

But the `list_subjects` tool's optional `workspace_id` parameter is now ambiguous: it filters to subjects under projects in workspace X, but the calling user might not be a member of X. RLS handles this (returns empty). What changes: the MCP tool needs to document that "your CLI must use a workspace you're a member of," and the enriched `workspace_id` field on each subject row now reflects ACTUAL membership.

**No code change required for MCP in this design** — RLS handles it. The CLI surface stays stable.

---

## 9. Risks and edge cases

| # | Case | Behavior |
|---|---|---|
| 1 | Owner deletes their auth account | `auth.users(id) ON DELETE CASCADE` on `workspaces.user_id` cascades to workspaces, which cascades to projects/subjects/everything. **This kills shared workspaces too.** Phase 1 accept this — there's no transfer mechanism. UI surfaces the consequence on the "Delete account" confirm: "X workspaces with Y members will be permanently deleted." For v2 we'll add an ownership-transfer dialog before allowing account delete on workspaces with >1 member. |
| 2 | Removed member had unsynced local edits | The local edit is in the user's local sync queue. On next push, RLS rejects (user is no longer a member of the workspace). The user sees a sync error toast; the local edit is preserved on disk under the workspace's folder but never lands server-side. **Acceptable** — no data corruption, the user can manually copy the markdown if needed. |
| 3 | Member loses access mid-comment | Comment compose was open; member is removed; member clicks Save; RLS rejects with 401. The compose UI shows "You no longer have access to this workspace. Comment saved to draft." (Compose drafts already exist locally per the comment-anchors work.) |
| 4 | Invite forwarded to wrong email | Recipient signs in as wrong email → RPC raises `invite_email_mismatch`. UI surfaces with the inviter's expected email. The invite stays open; the right person can still redeem. |
| 5 | Invite expires while in inbox | RPC raises `invite_expired`. UI offers "Request new invite from <owner email>" with a `mailto:` button. |
| 6 | Two members rename same project simultaneously | Last-write-wins via the `(user_id, name)` PK conflict on the second write. The losing client realtime-rebuilds and shows the winning name. Already handled by existing sync code; the multi-user dimension just makes it more likely. |
| 7 | Owner revokes share-link policy while member is mid-share | `sharing_policy` flips to `disabled`. Existing share links 403 on next read. No grace period. Documented in the policy-change confirm dialog. |
| 8 | Invite to email that already has 2 accounts | `auth.users.email` is unique in Supabase, so this case can't actually arise — there's one auth user per email. Documented assumption. |
| 9 | Workspace owner downgrades themselves via DB | UI prevents it (`role` dropdown on owner row is disabled). DB-level: the `one_owner_per_workspace` partial unique index doesn't block role changes; an UPDATE that flips the owner's role to editor would orphan the workspace. Add a CHECK constraint: `before update on workspace_members` trigger that raises if the UPDATE would leave 0 owners. **Add to migration A.** |
| 10 | Inviter is removed from workspace before invitee accepts | `workspace_invites.invited_by` cascades to NULL (the inviter was deleted). The RPC's redemption logic doesn't read `invited_by` for any check; redemption still works. UI shows "(invited by Alice — no longer a member)" if `invited_by IS NULL`. |
| 11 | Realtime filter `workspace_id=in.(...)` too long | Supabase realtime filters are URL-style; an IN list of 200 ws-ids is ~7KB and within limits. If a user is in >500 workspaces we'd need to fall back to no filter + client-side discard. Not a v1 concern. |
| 12 | Two writers create comments at the same anchor concurrently | Both insert with separate UUIDs; both land server-side; both render in the comments panel. Same model as Google Docs — two comments on the same anchor is fine. The existing anchor-highlight code handles N comments per anchor already. |
| 13 | Member's role flips while they have a write in flight | Write went out under role=editor; arrives at server after role=viewer. RLS rejects on the WITH CHECK. Write fails; toast appears. No data corruption. Same as the "loses access mid-comment" case. |
| 14 | Public-link feature ships and uses `sharing_policy = 'public_link_allowed'`, then this spec's owner sets it back to `members_only` | Existing links 403 on next read. The downstream feature owns the UI for "you have N links that will stop working." This spec just makes the policy column the source of truth. |
| 15 | Re-invite to an already-member | The accept RPC has `on conflict do nothing` on `workspace_members`, but the UNIQUE constraint on `workspace_invites` permits the open invite. The invite redeems to no-op (membership already exists). UI hint: "User is already a member" when adding the invite. |
| 16 | Email mismatch case: user has changed their auth email after invite | Invite emailed `alice@old.com`; user updated auth email to `alice@new.com`. Redemption fails on email mismatch. **Workaround:** owner revokes and re-invites at `alice@new.com`. Documented; not auto-handled. |

### 9.1 The "owner deleted" cliff

Edge case #1 is the scariest. Today a user deleting their account deletes only their own data. Post-multi-user, it can delete OTHER PEOPLE's read access. The mitigation chain:

1. UI warning on the "Delete account" path: enumerate workspaces with members, show member counts.
2. Document the recommended path: "transfer ownership first (v2 feature)" — placeholder for now.
3. DB safety net: defer this risk to v2 via a `before delete on auth.users` trigger that fails if the user owns any workspace with `member_count > 1`, but **NOT in v1** — that breaks the existing single-user delete-account flow. We document instead.

---

## 10. Future-readiness notes

Decisions made now to keep doors open later:

### 10.1 Org / team layer above workspaces

We are NOT designing organizations now. To make adding one painless:

- `workspace_members.workspace_id` is the ONLY scope. No org_id column anywhere. When orgs ship, `workspaces.org_id` (NULL = personal) joins through and `workspace_members` extends to `(workspace_id | org_id, user_id, role)` — additive.
- `sharing_policy` lives on the workspace, not the org. If a future org wants to override member policies, that's a new `org_settings` table with a policy that wins on aggregation. Workspace-level policy stays unchanged.
- The invite system is workspace-scoped. Adding org-level invites is additive — same `workspace_invites` shape with `workspace_id` swapped to a polymorphic `target_id, target_type` or a separate `org_invites` table. Don't bake org assumptions into the workspace_invites schema today.
- Billing seats: an org pays for N seats; a workspace has M members. The mapping `seat → member` is a v3 problem. Today, every member of every workspace is "free" from a billing perspective. The `workspace_members` table doesn't carry seat metadata.

### 10.2 Web shell migration

The current codebase uses Tauri-specific APIs for:
- Secure-store (refresh tokens, MCP bearer).
- Filesystem layout (`accountScopedPath`, `workspaceScopedPath`).
- Deep-link handler (the OAuth/invite redirect).

For this design, **no new Tauri-specific surface is introduced**. The invite redemption uses the existing deep-link handler. The new tables are all Supabase. The role-aware UI is React-only.

On web (someday): the secure-store becomes localStorage (or a server-set HttpOnly cookie for the refresh token, which is the proper web pattern). The filesystem layout becomes irrelevant — the planner reads/writes via Supabase directly, no local cache. The deep-link handler becomes a normal URL route `/invite/<token>`. The invite RPC and policy enum survive verbatim.

**Implication for this design:** we keep the invite-accept logic in `src/lib/workspaces/invite-acceptor.ts` (TS, no Tauri imports). The deep-link handler in Tauri code calls into it. On web, the route handler calls the same function. **No Tauri-only logic in the invite/membership flow.**

### 10.3 Granular per-project ACLs

If a future "viewer for project A only" need arises, the model extends: add a `project_members` table with the same shape as `workspace_members`. The current workspace_role-based policy becomes "you're a workspace member OR a project member with at least viewer role." Additive. We don't design it now (§2) but the helper functions `is_workspace_member` / `workspace_role` would gain `is_project_member` / `project_role` siblings.

### 10.4 Audit log

A team-collab product needs an audit log eventually ("Bob removed Alice on 2026-05-20"). We're NOT building it now but every membership write goes through a single SECURITY DEFINER path (`accept_workspace_invite`) or a small set of REST mutations. Adding an `audit_events` table + triggers on `workspace_members` / `workspace_invites` is a single migration when the time comes.

### 10.5 Dropping the redundant `workspaces.user_id` column

When orgs / ownership transfer ships, we drop the column. Until then, the column stays but is no longer used by RLS. The fact that ON DELETE CASCADE from `auth.users` to `workspaces.user_id` exists is a feature, not a bug — it preserves the existing "delete account = delete my workspaces" UX. When we add transfer, the trigger that runs on auth.users delete will first re-target the user_id (and optionally the owner role) to the new owner.

---

## 11. Migration plan — order of operations

Three migrations, each independently deployable, none blocking on a client release. The client gates behavior via a feature flag (`MULTI_USER_WORKSPACES_ENABLED`) during the rollout; once all are in, the flag flips to "on" globally and the dialog UI appears.

### 11.1 Migration A — `workspace_members` + RLS rewrite + workspace_id denormalization

Order inside the migration:

1. Create `workspace_members` table + indexes.
2. Enable RLS on `workspace_members` with placeholder permissive policies (so the seed step's INSERTs aren't blocked by the new strict policies that come in step 5).
3. Backfill: one owner row per existing workspace (idempotent via `on conflict do nothing`).
4. Verification DO block: every workspace has exactly one owner. Raise on miss.
5. Add `workspace_id` columns to `subjects`, `subject_versions`, `subject_comments`. Backfill from parent project / parent subject. Set NOT NULL after backfill. Add indexes.
6. Add the cascade-on-project-move triggers + the set-workspace-id-on-insert triggers.
7. Replace the placeholder workspace_members policies with the strict ones from §3.1.
8. Drop the old `_user_isolation` policies on `workspaces`, `projects`, `subjects`, `subject_versions`, `subject_comments`. Install the new workspace-membership policies.
9. Create helper functions `is_workspace_member`, `workspace_role`.
10. Add the "before update on workspace_members" trigger that prevents the last owner being demoted (edge case #9).

**Client behavior after Migration A but before Migration B/C ships:**
- The app still calls everything via the existing single-user flows. RLS still admits the user (they're the owner-member of every workspace they own).
- The new `useWorkspacesStore.currentRole` selector returns `'owner'` for every workspace.
- No UI change visible.

This migration is **safe to deploy independently** because client behavior is unchanged.

### 11.2 Migration B — `workspace_invites` + RPC

Order:

1. `create extension if not exists pgcrypto`.
2. Create `workspace_invites` table + indexes.
3. Create `accept_workspace_invite(token text)` SECURITY DEFINER function + grant.
4. Create `fetchInvitePreview(token_hash text)` SECURITY DEFINER function (for the sign-in screen email pre-fill) + grant.
5. RLS policies on `workspace_invites` per §4.2.

**Client behavior after Migration B but before app release:**
- DB accepts new invite rows; nothing inserts them (no UI surface yet).
- DB exposes the redemption RPC; no client calls it yet.
- Safe.

After Migration B is live AND the app release with the members dialog ships, invites start flowing.

### 11.3 Migration C — `sharing_policy` enum

Order:
1. Create the enum.
2. Add the column with `default 'members_only'`. NOT NULL.

**Client behavior:** Owners see the new "Sharing policy" dropdown in workspace settings. Default is the safe value. No share-link feature exists yet to be gated, but the column is in place.

### 11.4 Rollout sequence

1. **Week 1**: Deploy migration A. Client behavior unchanged. Smoke test single-user flows on staging.
2. **Week 2**: Deploy migration B. Deploy the Supabase Edge Function for invite emails (behind feature flag, no actual invites send). Smoke test the RPC via a manual SQL invocation.
3. **Week 3**: Ship app version N with the members dialog UI + invite acceptor + role-aware planner. Flag-gated to a small internal cohort.
4. **Week 4**: Deploy migration C. Add the sharing-policy dropdown to the same release (or in N+1).
5. **Week 5**: Flip the flag for everyone.

Each step is reversible (except migration A, because the RLS rewrite is destructive — but the BEFORE state is reproducible by re-installing the old `_user_isolation` policies and dropping the new ones; the schema additions are non-destructive). **Roll-back strategy** documented but expected unused.

---

## 12. Open items expected at /make-plan

These were not resolved here and should be picked at planning time:

1. **Email service**: Postmark vs Resend vs SES (§5.3). Doesn't affect schema or RPC; one-file diff.
2. **Viewer-can-comment** (§3.2): user to confirm. If overturned, we drop the split policy on `subject_comments.UPDATE` and use the simpler `role IN ('owner','editor')` everywhere.
3. **`sharing_policy = 'disabled'` retroactive kill** (§6.1): user to confirm. Alternative is "disabled prevents NEW links but existing links still work" — less clean but more user-friendly. Recommend the strict version; flag for review.
4. **Owner-deletion cliff** (§9.1): is a v2 transfer-ownership flow acceptable, or do we need a stopgap before multi-user beta? Recommend documenting only for v1.
5. **Realtime resubscribe cost on membership change** (§8.3): need to verify the rebuild doesn't blow up channel quota during a "user accepts 10 invites in 5 seconds" stress test. Implementation-time check.
6. **Members-dialog layout**: single dialog with three sections (this spec) vs tabbed dialog (Members / Invites / Settings). Recommend single dialog; flag for design polish.

---

## 13. Self-review notes

- **The RLS rewrite is the load-bearing change**, not the tables. If anything in §4.4 has a bug, data leaks across workspaces. The default-deny stance is the safety net; every new policy is additive on top of RLS-enabled-no-policy = invisible. Reviewer should focus there.
- **The denormalized `workspace_id` on subjects/versions/comments** doubles the surface where the FK chain can drift. The cascade triggers in §4.4 cover the only mutation path (project.workspace_id update). If a future migration adds another path that mutates a row's parent workspace, it must be wired into the cascade.
- **The invite RPC's email match check** is the only thing standing between a leaked invite URL and unauthorized access. SHA-256 hashing of the token + email-claim verification + 7-day expiry. Audit this in code review.
- **The single-user fast path is preserved.** A user who never invites anyone never sees a UI change. Every member-aware policy admits the single owner-member in exactly the same situations the old policy admitted the single user. Single-user perf is unchanged because `is_workspace_member` inlines to the same index probe.
- **No Tauri-only API touched.** Web migration friction stays the same as today's codebase.
- **Three migrations, three deployments, one client release.** Migration A is the risky one; B and C are additive. Sequencing matters because the app release in §11.4 step 3 assumes A+B are live.
- **No new MCP tool surface.** RLS handles workspace-membership scoping for the existing CLI tools.
