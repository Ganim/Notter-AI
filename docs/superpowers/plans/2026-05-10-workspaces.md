# Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Workspaces feature on top of post-M4 `main`. Inserts a "workspace" container layer between `account` and `projects`, mirroring the M1 multi-account pattern one level deeper. Strictly additive: a new `workspaces` table with RLS, a `projects.workspace_id` FK, a `WorkspaceManager` singleton + `useWorkspacesStore` Zustand store, a `WorkspaceSwitcher` header chip, a `WorkspaceManagerDialog` with create/rename/delete/set-default flows, a "Move project to workspace" affordance in the planner sidebar, a Rust MCP token-map refactor from `HashMap<token, accountId>` to `HashMap<token, AuthOwner { account_id, workspace_id }>` (every tool query gains a `WHERE workspace_id = ?` clause), per-workspace MCP token + config file, and an account-wide v2 filesystem migration that moves `<accountId>/cache/` and `<accountId>/exports/` under `<accountId>/<defaultWorkspaceId>/`. Spec is `docs/superpowers/specs/2026-05-10-workspaces-design.md`. Baseline schema is M2 subject-anchored (`supabase/migrations/2026-05-10-subject-versioning.sql`).

**Architecture:** Bottom-up, eight concentric layers:
1. **Schema** — `workspaces` table (RLS + realtime + partial-unique-default index); `projects.workspace_id` with `ON DELETE RESTRICT`; in-migration backfill of `"User's workspace"` + every project's `workspace_id`.
2. **Sync layer** — `WorkspaceRecord` type + `fetchWorkspaces` / `pushWorkspace` / `deleteWorkspace` / `updateProjectWorkspace` functions in `src/lib/sync.ts`. Mirrors the existing `fetchProjects` pattern.
3. **TS scaffolding** — `src/lib/workspaces/{workspace-manager, workspace-paths, workspace-storage, fs-migration-v2, mcp-token}.ts` direct analogues of `src/lib/accounts/*`.
4. **Zustand store** — `useWorkspacesStore` (slices: `workspaces[]`, `currentWorkspaceId`, `loading`). `registerResettableStore` so account-switch wipes it.
5. **Planner refactor** — `usePlannerStore` gains a canonical `allProjects[]` slice; `projects` is exposed as a derived selector filtered by `useWorkspacesStore.currentWorkspaceId`. Existing `applyRemoteProjects` writes to `allProjects`. Workspace switch fires a re-render via the Zustand subscription — zero refetch.
6. **Realtime + auth wiring** — `workspaces` subscription added to `realtime.ts`; `syncOnLogin` fetches workspaces and bootstraps `WorkspaceManager`; account-switch reset registry already wipes the store.
7. **Filesystem migration v2** — sentinel-gated mover at `notter-ai/.migration-v2-workspaces-complete`. Idempotent per-account. Runs in `App.tsx` after `bootstrap()` and before `initialize()`.
8. **MCP server refactor (Rust + TS bridge)** — `token_to_account: HashMap<String, String>` becomes `token_to_owner: HashMap<String, AuthOwner>` where `AuthOwner { account_id, workspace_id }`. Two new Tauri commands `mcp_register_bearer(account_id, workspace_id, bearer)` and `mcp_revoke_bearer(bearer)`. Every tool query gains `WHERE workspace_id = ?`. Per-workspace config files at `notter-ai/mcp/<accountId>-<workspaceId>-config.json`.
9. **UI** — `WorkspaceSwitcher` (header), `WorkspaceManagerDialog` (create/rename/set-default/delete), `WorkspaceDeleteDialog` (move-or-purge radio), inline "Move to workspace" kebab in the planner sidebar.

**Tech Stack:** TypeScript / React / Zustand / Vitest / `@supabase/supabase-js` v2 / Tauri 2 (`@tauri-apps/plugin-fs`) / Rust 1.74+ / `axum 0.8.9` / `tokio 1` / `reqwest 0.12` / `@radix-ui/react-dialog` (shadcn).

**Spec references:** `docs/superpowers/specs/2026-05-10-workspaces-design.md` (entire doc; §2b locked tactical decisions). Baseline schema `supabase/migrations/2026-05-10-subject-versioning.sql`. M1 foundation: `src/lib/accounts/{account-manager,account-paths,account-storage,fs-migration,store-registry,secure-store,supabase-storage-adapter}.ts`. M3 foundation: `src-tauri/src/mcp/{auth,server,tools,supabase}.rs`, `src/lib/mcp/index.ts`.

**Out of scope (do not drift, matches spec §10):** Sharing workspaces between accounts. Per-workspace roles. Per-workspace theming / preferences. Local-only workspaces. `subjects` PK change to include `workspace_id`. `projects` PK change to include `workspace_id`. CLI awareness of workspaces (workspace is implicit per token).

---

## Critical correctness reminders (READ FIRST — locked tactical decisions)

The following six tactical decisions were resolved with the user during the 2026-05-10 spec review (§2b). Any implementing subagent must NOT relitigate them:

1. **Legacy M3 `<accountId>-config.json` path:** break cleanly. Delete the old file once the per-workspace `<accountId>-<workspaceId>-config.json` is written. No back-compat shim. No symlink.
2. **Token revocation race for in-flight CLI calls:** let in-flight requests finish; 401 the next. Middleware re-checks the bearer per request. No active-connection tracking.
3. **"Set as default" placement in the manager dialog:** inline link/button on each non-default workspace row.
4. **Atomic move-then-delete:** sequential REST calls protected by `ON DELETE RESTRICT`. **No Supabase RPC.** If the UPDATE doesn't move every project, the DELETE fails on the FK constraint — that's the safety net. The UI handles the partial-failure toast.
5. **"Move project to workspace" UI affordance:** in-scope for this feature. Kebab menu on each project row in the planner sidebar opens a submenu listing every other workspace. Phase L.
6. **`projects` PK change to include `workspace_id`:** deferred. Phase 1 keeps the existing `PRIMARY KEY (user_id, name)` — same project name across workspaces is forbidden within an account.

Additional guardrails for the implementing subagent:

- **Schema baseline is M2 subject-anchored.** The `subjects` table has a stable `id uuid` + `current_version_id` (live in `2026-05-10-subject-versioning.sql`). Do NOT regress to plans-table semantics. Do NOT recreate the dropped `plans` / `plan_versions` / `plan_comments` tables.
- **`subjects` PK is unchanged.** `(user_id, project_name, file_name)`. Scoping to workspace happens via the FK chain `subjects → projects → workspaces`. Do NOT add `workspace_id` to `subjects`.
- **Workspaces are per-account.** Account-switch (`AccountManager.switchAccount`) calls `resetAllStores()`. `useWorkspacesStore` registers with `registerResettableStore` so its `workspaces[]` and `currentWorkspaceId` are wiped. `syncOnLogin` re-fetches and seeds `currentWorkspaceId` from the `is_default = true` row.
- **Use `crypto.randomUUID()` exclusively.** The `uuid` npm package is NOT a dependency and must NOT be introduced. See `src/stores/board-store.ts`, `src/stores/subject-versions-store.ts` for the pattern.
- **`react-resizable-panels` v4 takes percentage strings, not numbers** — if you touch any layout with the right-side panel.
- **No separate "Plans" tab — `PlannerTab` is the canonical UI.** Don't introduce one.
- **Workspaces are server-side rows.** The local filesystem layout follows from the Supabase IDs. Do NOT introduce local-only workspaces.
- **Per-account user_preferences / agent_profiles stay account-wide.** Workspaces scope CONTENT (projects, subjects, versions, comments), not SETTINGS.

---

## File Structure

### New files (TypeScript)

- `src/lib/workspaces/workspace-manager.ts` — singleton (mirrors `account-manager.ts`). `bootstrap()`, `list()`, `currentWorkspaceId`, `switchWorkspace(id)`, `add({ name, isDefault? })`, `rename(id, name)`, `setDefault(id)`, `remove(id, { moveTargetWorkspaceId } | { purge: true })`.
- `src/lib/workspaces/workspace-paths.ts` — `workspaceScopedPath(rel)` (throws), `tryWorkspaceScopedPath(rel)` (returns null). Direct analogue of `account-paths.ts`.
- `src/lib/workspaces/workspace-storage.ts` — `notter-ai/<accountId>/workspaces/index.json` and `active.json` readers / writers (mirrors `account-storage.ts`).
- `src/lib/workspaces/fs-migration-v2.ts` — `migrateAccountToWorkspacesIfNeeded(accountId, defaultWorkspaceId)` — moves `<accountId>/cache/` and `<accountId>/exports/` to `<accountId>/<defaultWorkspaceId>/...`. Sentinel-gated.
- `src/lib/workspaces/mcp-token.ts` — `generateWorkspaceMcpToken()` (32 random bytes → base64url, prefix `notter_ws_`). Single small helper consumed by `workspace-manager`.
- `src/lib/workspaces/__tests__/workspace-manager.test.ts`
- `src/lib/workspaces/__tests__/workspace-paths.test.ts`
- `src/lib/workspaces/__tests__/fs-migration-v2.test.ts`
- `src/stores/workspaces-store.ts` — Zustand store. Slices: `workspaces`, `currentWorkspaceId`, `loading`. `registerResettableStore` callback. `applyRemoteWorkspaces(rows)` setter for realtime.
- `src/stores/__tests__/workspaces-store.test.ts`
- `src/components/WorkspaceSwitcher.tsx` — header chip + dropdown.
- `src/components/WorkspaceManagerDialog.tsx` — modal with create / rename / set-default / delete flows.
- `src/components/WorkspaceDeleteDialog.tsx` — sub-modal: move-or-purge radio confirmation.
- `src/components/MoveProjectToWorkspaceMenu.tsx` — kebab menu used by the planner sidebar project rows.

### Modified files (TypeScript)

- `src/lib/sync.ts` — add `WorkspaceRecord` type + `fetchWorkspaces` / `pushWorkspace` / `renameWorkspace` / `setWorkspaceDefault` / `deleteWorkspace` / `updateProjectWorkspace` / `moveProjectsBetweenWorkspaces`. `fetchProjects` gains an optional 2nd `workspaceId` arg (ignored when omitted, for backward compatibility with `syncOnLogin` and realtime refetch).
- `src/lib/realtime.ts` — subscribe `workspaces` table via `subscribeUserTable`. Closure calls `useWorkspacesStore.getState().applyRemoteWorkspaces(rows)`.
- `src/stores/auth-store.ts` — `syncOnLogin` boots `WorkspaceManager` AFTER session establishment, calls `fetchWorkspaces(userId)`, seeds `currentWorkspaceId` from the `is_default=true` row, then proceeds to projects/subjects fetch. The `WorkspaceManager.bootstrap()` call (which lazily creates a default workspace if none exists for the account) lives here so RLS-authenticated INSERTs work.
- `src/stores/planner-store.ts` — canonical `allProjects[]` slice; `projects` becomes a derived selector filtered by `useWorkspacesStore.currentWorkspaceId`. `applyRemoteProjects` writes to `allProjects`. New action `moveProjectToWorkspace(projectId, targetWorkspaceId)` calls `updateProjectWorkspace` then re-applies the local slice. `createProject` now takes `(name, path, workspaceId?)` and stamps `workspace_id` on the upsert (defaulting to `useWorkspacesStore.currentWorkspaceId`).
- `src/lib/accounts/account-manager.ts` — `add()` no longer mints an account-scoped MCP token (or rather: the existing mcp_token logic is kept for accounts pre-existing the v2 migration; after migration the per-workspace token is the canonical surface). On `add()`, the WorkspaceManager will be bootstrapped separately by `syncOnLogin`. **No code change required** unless the implementing subagent finds a race; document any necessary tweak in the phase commit message.
- `src/lib/mcp/index.ts` — add `notifyMcpWorkspaceAdded(accountId, workspaceId, bearer)`, `notifyMcpWorkspaceRemoved(bearer)`. Keep existing `notifyMcpAccountAdded` / `notifyMcpAccountRemoved` for backward compatibility; both will be deprecated by call-site replacement in Phase I.
- `src/components/Layout.tsx` — insert `<WorkspaceSwitcher />` immediately to the LEFT of `<UserMenu />` (current line 54).
- `src/components/PlannerTab.tsx` — add `MoveProjectToWorkspaceMenu` to the project row (kebab on hover). Add small workspace-name badge next to project name when `workspaces.length > 1`.
- `src/App.tsx` — call `migrateAccountToWorkspacesIfNeeded(...)` AFTER `AccountManager.bootstrap()` resolves (which transitively boots `WorkspaceManager` and resolves the default workspace id), BEFORE `initialize()`. (Tight coupling on order; document in code.)
- `src/i18n/locales/en.json` — new namespace `workspaces.*` keys (full list in Phase M).
- `src/i18n/locales/pt-BR.json` — same keys translated.

### New files (Rust)

- None. All required changes live in existing `src-tauri/src/mcp/*.rs` files.

### Modified files (Rust)

- `src-tauri/src/mcp/auth.rs`:
  - `AuthContext` gains `workspace_id: String`.
  - New struct `AuthOwner { account_id: String, workspace_id: String }`.
  - `mcp_register_bearer` signature becomes `(account_id, workspace_id, bearer_token, ...)`.
  - New Tauri command `mcp_revoke_bearer(bearer_token)` removes a single bearer.
  - `mcp_remove_account_token(account_id)` keeps revoking every bearer whose `AuthOwner.account_id == account_id` (`token_to_owner.retain(...)`).
  - `bearer_auth` middleware reads `AuthOwner` from the map and inserts the full `AuthContext` into request extensions.
- `src-tauri/src/mcp/server.rs`:
  - `McpStateInner.token_to_account: HashMap<String, String>` → `token_to_owner: HashMap<String, AuthOwner>`.
  - `write_per_account_configs` renamed to `write_per_workspace_configs`. Writes one file per `(account_id, workspace_id)` at `<dir>/<account_id>-<workspace_id>-config.json`.
  - `mcp_read_account_config` renamed to `mcp_read_workspace_config(account_id, workspace_id)` and updated accordingly.
  - `start_mcp_server` updates the post-bind reconciliation call to the renamed function.
- `src-tauri/src/mcp/tools.rs`:
  - Every tool that queries `projects` (currently `list_subjects` indirectly via `subjects → projects`) gains a workspace-scoped filter. Approach: a new helper `workspace_project_filter(state, &auth)` returns the comma-separated list of project names belonging to `(auth.account_id, auth.workspace_id)`. Tools that query `subjects` add `&project_name=in.(...)` to the querystring. Tools that query `projects` directly add `&workspace_id=eq.<auth.workspace_id>`. (Alternative discussed in Phase H — the implementer chooses the cleanest path.)
- `src-tauri/src/lib.rs`:
  - Register the new `mcp_revoke_bearer` Tauri command in `invoke_handler!`.
  - `McpStateInner` instantiation updates `token_to_account` → `token_to_owner: HashMap::new()`.
  - Replace `mcp::server::mcp_read_account_config` registration with `mcp::server::mcp_read_workspace_config`.

### New migrations

- `supabase/migrations/2026-05-10-workspaces.sql` — schema migration (full SQL in Phase A). The date matches today; the existing `2026-05-10-subject-versioning.sql` lives at the same date and is alphabetically before this one (`subject-versioning` < `workspaces`), so ordering is correct.

### Deleted files

- None. Strictly additive.

### Phase order

| # | Phase | Scope | Lands |
|---|---|---|---|
| A | Supabase schema migration | one SQL file applied via MCP | first; no app code change |
| B | sync.ts workspace types + functions | add `WorkspaceRecord` + 6 functions | independent of UI |
| C | TS workspace scaffolding | `workspace-paths`, `workspace-storage`, `mcp-token` + manager skeleton | depends on B |
| D | useWorkspacesStore (TDD) | failing tests, then implementation; register reset | depends on C |
| E | Refactor usePlannerStore | canonical `allProjects[]` + derived `projects`; existing tests must still pass | depends on D |
| F | Realtime + auth-store wiring | `workspaces` subscription; `syncOnLogin` boots WorkspaceManager + seeds default | depends on D |
| G | Filesystem migration v2 | `fs-migration-v2.ts` + App.tsx boot wiring; tests cover sentinel + move idempotency | depends on F |
| H | MCP server (Rust) refactor | `token_to_owner` map + workspace-scoped tool queries + per-workspace configs + new Tauri commands | depends on A; independent of E/F/G |
| I | TS MCP glue | `notifyMcpWorkspaceAdded/Removed` wrappers; `WorkspaceManager.add/remove` invoke them | depends on H |
| J | WorkspaceSwitcher UI | header chip + dropdown; wired into Layout | depends on D + F |
| K | WorkspaceManagerDialog + delete sub-modal | create / rename / set-default / delete | depends on J |
| L | Move project to workspace | kebab menu in planner sidebar | depends on E + K |
| M | i18n keys + manual smoke checklist | en.json + pt-BR.json; smoke doc inside this plan | last code phase |
| N | End-to-end verification | tests + build green; manual smoke; cleanup | last |

---

## Phase A — Supabase schema migration

This phase creates the `workspaces` table, adds `projects.workspace_id`, backfills existing rows, and drops the temporary default. The SQL is verbatim from spec §4 + §5.1. No app code changes.

### Task A1: Write and apply the migration SQL

**Files:**
- Create: `supabase/migrations/2026-05-10-workspaces.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/2026-05-10-workspaces.sql
--
-- Workspaces: a container between account and projects. Each user has 1..N
-- workspaces; every project belongs to exactly one workspace. Subjects,
-- versions, and comments remain scoped via the project FK chain — they DO
-- NOT gain a workspace_id column (spec §4.3).

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

-- 3. projects.workspace_id (with temporary default to satisfy NOT NULL
-- during the backfill in step 4).
alter table projects
  add column workspace_id uuid not null
  default '00000000-0000-0000-0000-000000000000'
  references workspaces(id) on delete restrict;

-- 4. Backfill each project's workspace_id to its user's default workspace.
update projects p
set workspace_id = w.id
from workspaces w
where w.user_id = p.user_id
  and w.is_default = true;

-- 5. Drop the temporary default so future inserts must choose a workspace.
alter table projects alter column workspace_id drop default;

-- 6. Composite index for the (user_id, workspace_id) query the app uses.
create index projects_user_workspace_idx on projects(user_id, workspace_id);

-- 7. Verification — fail-fast canary if backfill leaves any row pointing
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
```

- [ ] **Step 2: Apply via the Supabase MCP tool**

Use `mcp__plugin_supabase_supabase__apply_migration` with the SQL above. Pass `name: "workspaces"` and the SQL as `query`. Confirm no errors.

- [ ] **Step 3: Verify schema with `list_tables`**

```
mcp__plugin_supabase_supabase__list_tables
```

Confirm `workspaces` appears with columns `id, user_id, name, is_default, created_at, updated_at`. Confirm `projects` shows the new `workspace_id uuid not null` column. Spot-check the indexes (`workspaces_user_id_idx`, `workspaces_one_default_per_user_idx`, `projects_user_workspace_idx`) and the RLS policy.

- [ ] **Step 4: Spot-check the backfill via `execute_sql`**

```sql
select user_id, count(*) as ws_count, count(*) filter (where is_default) as default_count
from workspaces
group by user_id;

select count(*) as zero_uuid_count
from projects
where workspace_id = '00000000-0000-0000-0000-000000000000';
```

Expected: every user has `ws_count >= 1` and `default_count = 1`. `zero_uuid_count = 0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-05-10-workspaces.sql
git commit -m "$(cat <<'EOF'
feat(schema): add workspaces table + projects.workspace_id with backfill

- new workspaces table (RLS, realtime, partial unique default index)
- projects.workspace_id NOT NULL FK with ON DELETE RESTRICT
- backfill: one default workspace per existing user; every project's
  workspace_id retargeted to its user's default
- in-migration verification step fails fast on partial backfill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — sync.ts: workspace types + functions

This phase adds the workspace `WorkspaceRecord` type and six functions to `src/lib/sync.ts`. Mirrors the existing `fetchProjects` / `pushProjects` pattern. No existing functions are removed; `fetchProjects` gains an optional second `workspaceId` argument that is ignored when omitted (default behavior unchanged for realtime + initial sync).

### Task B1: Add `WorkspaceRecord` type and `fetchWorkspaces`

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Add the type and the fetch function**

Append after the existing `// ── Actions ──` block:

```ts
// ── Workspaces ────────────────────────────────────────────────────────

export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchWorkspaces(userId: string): Promise<WorkspaceRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('workspaces')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
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
    }));
  } catch (e) {
    console.error('[sync] fetchWorkspaces threw:', e);
    return null;
  }
}
```

Note: returns `[]` for legitimately empty result sets and `null` only on error — same pattern as `fetchSubjectVersions`. This is required for realtime DELETE propagation (deleting the last workspace must apply an empty array, not be treated as an error).

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add WorkspaceRecord type + fetchWorkspaces"
```

### Task B2: Add `pushWorkspace`, `renameWorkspace`, `setWorkspaceDefault`

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Add the functions**

```ts
/**
 * Insert a single workspace row. The caller chooses the id (crypto.randomUUID).
 * Direct insert, not upsertUserRows, because `add` is a single-row write and
 * the `(user_id, name)` UNIQUE constraint requires error reporting rather
 * than silent merge.
 */
export async function pushWorkspace(
  workspace: Omit<WorkspaceRecord, 'createdAt' | 'updatedAt'>,
): Promise<{ ok: true } | { ok: false; code: 'duplicate_name' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase.from('workspaces').insert({
      id: workspace.id,
      user_id: workspace.userId,
      name: workspace.name,
      is_default: workspace.isDefault,
    });
    if (error) {
      // Postgres unique-violation code is 23505.
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_name', message: error.message };
      }
      console.error('[sync] pushWorkspace failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] pushWorkspace threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

export async function renameWorkspace(
  workspaceId: string,
  userId: string,
  newName: string,
): Promise<{ ok: true } | { ok: false; code: 'duplicate_name' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase
      .from('workspaces')
      .update({ name: newName, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (error) {
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_name', message: error.message };
      }
      console.error('[sync] renameWorkspace failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] renameWorkspace threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

/**
 * Set `workspaceId` as the default for `userId`. Issues two updates so the
 * partial-unique-default index is never violated:
 *   1. Clear `is_default` on the current default (where `is_default = true`).
 *   2. Set `is_default = true` on the target.
 * Sequential is fine — Supabase serializes our writes per request.
 */
export async function setWorkspaceDefault(
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    // Step 1: clear the existing default.
    await supabase
      .from('workspaces')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_default', true);
    // Step 2: set the new one.
    const { error } = await supabase
      .from('workspaces')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (error) console.error('[sync] setWorkspaceDefault step 2 failed:', error);
  } catch (e) {
    console.error('[sync] setWorkspaceDefault threw:', e);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add pushWorkspace / renameWorkspace / setWorkspaceDefault"
```

### Task B3: Add `deleteWorkspace`, `updateProjectWorkspace`, `moveProjectsBetweenWorkspaces`

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Add the functions**

```ts
/**
 * Delete a workspace. Caller is responsible for resolving children FIRST
 * (move or purge). The `ON DELETE RESTRICT` on projects.workspace_id will
 * cause this to fail with 23503 if any project still references the workspace
 * — that's the safety net the spec relies on (§4.2).
 *
 * Returns ok:false on the 23503 path so the UI can show a specific toast.
 */
export async function deleteWorkspace(
  workspaceId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; code: 'has_projects' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase
      .from('workspaces')
      .delete()
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (error) {
      if ((error as any).code === '23503') {
        return { ok: false, code: 'has_projects', message: error.message };
      }
      console.error('[sync] deleteWorkspace failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] deleteWorkspace threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

/**
 * Re-target a single project to a different workspace. Used by the "Move to
 * workspace" UI affordance. Subjects/versions/comments travel with the
 * project automatically — they're scoped via the FK chain, not via a
 * denormalized workspace_id of their own.
 */
export async function updateProjectWorkspace(
  userId: string,
  projectName: string,
  targetWorkspaceId: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase
      .from('projects')
      .update({ workspace_id: targetWorkspaceId, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('name', projectName);
    if (error) console.error('[sync] updateProjectWorkspace failed:', error);
  } catch (e) {
    console.error('[sync] updateProjectWorkspace threw:', e);
  }
}

/**
 * Move every project from `fromWorkspaceId` to `toWorkspaceId` for the
 * given user. Used by the "move-then-delete" flow in WorkspaceDeleteDialog.
 * Returns the number of rows affected so the UI can verify before issuing
 * the workspace delete.
 */
export async function moveProjectsBetweenWorkspaces(
  userId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<{ ok: true; movedCount: number } | { ok: false; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, message: 'supabase not configured' };
  try {
    const { data, error, count } = await supabase
      .from('projects')
      .update({ workspace_id: toWorkspaceId, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('user_id', userId)
      .eq('workspace_id', fromWorkspaceId)
      .select('name');
    if (error) {
      console.error('[sync] moveProjectsBetweenWorkspaces failed:', error);
      return { ok: false, message: error.message };
    }
    return { ok: true, movedCount: count ?? data?.length ?? 0 };
  } catch (e: any) {
    console.error('[sync] moveProjectsBetweenWorkspaces threw:', e);
    return { ok: false, message: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add deleteWorkspace / updateProjectWorkspace / moveProjectsBetweenWorkspaces"
```

### Task B4: Extend `fetchProjects` to accept an optional `workspaceId`

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Update the signature**

The existing `fetchProjects(userId)` is called from `syncOnLogin` and `realtime.ts`. Both should keep fetching ALL projects (the planner store filters client-side via the derived selector). The optional second arg is for callers that want a pre-filtered list (e.g. the "Move to workspace" submenu when listing destinations).

```ts
export async function fetchProjects(userId: string, workspaceId?: string): Promise<Project[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    let q = supabase.from('projects').select('*').eq('user_id', userId);
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({ name: row.name, path: row.path, workspaceId: row.workspace_id }));
  } catch {
    return null;
  }
}
```

The shape of `Project` from `@/types` will gain `workspaceId: string`. If the type already exists without that field, add it.

- [ ] **Step 2: Update `pushProjects` to include `workspace_id`**

```ts
export async function pushProjects(userId: string, projects: Project[]): Promise<void> {
  await upsertUserRows('projects', userId, projects, (p) => ({
    id: p.name,
    user_id: userId,
    name: p.name,
    path: p.path,
    workspace_id: p.workspaceId,  // NEW — required NOT NULL column
    updated_at: new Date().toISOString(),
  }));
}
```

- [ ] **Step 3: Update `src/types/index.ts` (or wherever `Project` lives)**

Find the `Project` interface and add `workspaceId: string`. Search:

```bash
grep -rn "interface Project" src/types
```

Add the new field. This will break `usePlannerStore.createProject` until Phase E refactors it; that's expected — type-check failures will fail the build, motivating Phase E.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sync.ts src/types/index.ts
git commit -m "feat(sync): Project.workspaceId + workspace-filtered fetchProjects"
```

Note: the build will not yet pass because `createProject` doesn't stamp `workspaceId`. Phase E fixes this. Don't attempt to push at this point — the next phase is sequential.

---

## Phase C — TS workspace scaffolding

This phase creates the four foundational TS files under `src/lib/workspaces/`. The `workspace-manager.ts` is a singleton class mirroring `account-manager.ts`; the `workspace-paths.ts`, `workspace-storage.ts`, and `mcp-token.ts` are direct analogues of their `account-*` counterparts.

### Task C1: `mcp-token.ts` (small helper)

**Files:**
- Create: `src/lib/workspaces/mcp-token.ts`

- [ ] **Step 1: Create the file**

```ts
// src/lib/workspaces/mcp-token.ts
//
// 32 random bytes → base64url, prefixed `notter_ws_` to distinguish from the
// M1-era `notter_acc_` tokens at a glance in MCP configs. The same crypto
// routine as `generateMcpToken` in account-manager.ts — extracted so both
// managers share a single source of truth.

export function generateWorkspaceMcpToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `notter_ws_${b64}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/workspaces/mcp-token.ts
git commit -m "feat(workspaces): mcp-token helper (notter_ws_ prefix)"
```

### Task C2: `workspace-paths.ts`

**Files:**
- Create: `src/lib/workspaces/workspace-paths.ts`
- Create: `src/lib/workspaces/__tests__/workspace-paths.test.ts`

- [ ] **Step 1: Write the test first (TDD)**

```ts
// src/lib/workspaces/__tests__/workspace-paths.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock both managers — workspace-paths reads the active account from
// account-manager and the active workspace from workspace-manager.
vi.mock('@/lib/accounts/account-manager', () => ({
  getAccountManager: () => ({ activeAccountId: 'acc-1' }),
}));

vi.mock('@/lib/workspaces/workspace-manager', () => ({
  getWorkspaceManager: () => ({ currentWorkspaceId: 'ws-1' }),
}));

import { workspaceScopedPath, tryWorkspaceScopedPath } from '../workspace-paths';

describe('workspace-paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('joins account/workspace/rel', () => {
    expect(workspaceScopedPath('cache/plans.json')).toBe('notter-ai/acc-1/ws-1/cache/plans.json');
  });

  it('strips leading slashes', () => {
    expect(workspaceScopedPath('/cache/x')).toBe('notter-ai/acc-1/ws-1/cache/x');
    expect(workspaceScopedPath('\\cache\\x')).toBe('notter-ai/acc-1/ws-1/cache\\x');
  });

  it('tryWorkspaceScopedPath returns the same as workspaceScopedPath when active', () => {
    expect(tryWorkspaceScopedPath('exports/x.md')).toBe('notter-ai/acc-1/ws-1/exports/x.md');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm run test -- workspace-paths
```

- [ ] **Step 3: Implement**

```ts
// src/lib/workspaces/workspace-paths.ts
import { getAccountManager } from '@/lib/accounts/account-manager';
import { getWorkspaceManager } from './workspace-manager';

export function workspaceScopedPath(rel: string): string {
  const accountId = getAccountManager().activeAccountId;
  if (!accountId) throw new Error('workspaceScopedPath: no active account');
  const workspaceId = getWorkspaceManager().currentWorkspaceId;
  if (!workspaceId) throw new Error('workspaceScopedPath: no active workspace');
  const trimmed = rel.replace(/^[\/]+/, '');
  return `notter-ai/${accountId}/${workspaceId}/${trimmed}`;
}

export function tryWorkspaceScopedPath(rel: string): string | null {
  const accountId = getAccountManager().activeAccountId;
  if (!accountId) return null;
  const workspaceId = getWorkspaceManager().currentWorkspaceId;
  if (!workspaceId) return null;
  const trimmed = rel.replace(/^[\/]+/, '');
  return `notter-ai/${accountId}/${workspaceId}/${trimmed}`;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm run test -- workspace-paths
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspaces/workspace-paths.ts src/lib/workspaces/__tests__/workspace-paths.test.ts
git commit -m "feat(workspaces): workspace-paths.ts (account/workspace path scoping)"
```

### Task C3: `workspace-storage.ts`

**Files:**
- Create: `src/lib/workspaces/workspace-storage.ts`

- [ ] **Step 1: Create the file**

Mirror `account-storage.ts` directly. Files live at `notter-ai/<accountId>/workspaces/index.json` and `notter-ai/<accountId>/workspaces/active.json`. The accountId is a parameter (not read from `getAccountManager()`) so the storage layer stays pure — the manager passes its own account id in.

```ts
// src/lib/workspaces/workspace-storage.ts
import {
  BaseDirectory, readTextFile, writeTextFile, exists, mkdir, rename,
} from '@tauri-apps/plugin-fs';

const ROOT = 'notter-ai';

export interface WorkspaceIndex {
  workspaces: { id: string; name: string; isDefault: boolean }[];
}

export interface ActiveWorkspacePointer {
  workspaceId: string | null;
}

function indexPath(accountId: string): string {
  return `${ROOT}/${accountId}/workspaces/index.json`;
}

function activePath(accountId: string): string {
  return `${ROOT}/${accountId}/workspaces/active.json`;
}

async function ensureDir(accountId: string): Promise<void> {
  const p = `${ROOT}/${accountId}/workspaces`;
  if (!(await exists(p, { baseDir: BaseDirectory.AppLocalData }))) {
    await mkdir(p, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeTextFile(tmp, content, { baseDir: BaseDirectory.AppLocalData });
  try {
    await rename(tmp, path, {
      oldPathBaseDir: BaseDirectory.AppLocalData,
      newPathBaseDir: BaseDirectory.AppLocalData,
    });
  } catch {
    await writeTextFile(path, content, { baseDir: BaseDirectory.AppLocalData });
  }
}

export async function readWorkspaceIndex(accountId: string): Promise<WorkspaceIndex> {
  const p = indexPath(accountId);
  if (!(await exists(p, { baseDir: BaseDirectory.AppLocalData }))) {
    return { workspaces: [] };
  }
  try {
    const raw = await readTextFile(p, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.workspaces)) return { workspaces: [] };
    return parsed as WorkspaceIndex;
  } catch (e) {
    console.error('[workspace-storage] read index failed:', e);
    return { workspaces: [] };
  }
}

export async function writeWorkspaceIndex(accountId: string, idx: WorkspaceIndex): Promise<void> {
  await ensureDir(accountId);
  await atomicWrite(indexPath(accountId), JSON.stringify(idx, null, 2));
}

export async function readActiveWorkspace(accountId: string): Promise<ActiveWorkspacePointer> {
  const p = activePath(accountId);
  if (!(await exists(p, { baseDir: BaseDirectory.AppLocalData }))) {
    return { workspaceId: null };
  }
  try {
    const raw = await readTextFile(p, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (typeof parsed?.workspaceId !== 'string' && parsed?.workspaceId !== null) {
      return { workspaceId: null };
    }
    return parsed as ActiveWorkspacePointer;
  } catch (e) {
    console.error('[workspace-storage] read active failed:', e);
    return { workspaceId: null };
  }
}

export async function writeActiveWorkspace(accountId: string, p: ActiveWorkspacePointer): Promise<void> {
  await ensureDir(accountId);
  await atomicWrite(activePath(accountId), JSON.stringify(p, null, 2));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/workspaces/workspace-storage.ts
git commit -m "feat(workspaces): workspace-storage.ts (index.json + active.json per account)"
```

### Task C4: `workspace-manager.ts` (TDD — failing tests first)

**Files:**
- Create: `src/lib/workspaces/__tests__/workspace-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/workspaces/__tests__/workspace-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/workspaces/workspace-storage', () => ({
  readWorkspaceIndex: vi.fn().mockResolvedValue({ workspaces: [] }),
  writeWorkspaceIndex: vi.fn().mockResolvedValue(undefined),
  readActiveWorkspace: vi.fn().mockResolvedValue({ workspaceId: null }),
  writeActiveWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/accounts/secure-store', () => ({
  secureSet: vi.fn(),
  secureGet: vi.fn().mockResolvedValue(null),
  secureDelete: vi.fn(),
}));

vi.mock('@/lib/accounts/account-manager', () => ({
  getAccountManager: () => ({ activeAccountId: 'acc-1' }),
}));

vi.mock('@/lib/sync', () => ({
  fetchWorkspaces: vi.fn().mockResolvedValue([]),
  pushWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  renameWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  setWorkspaceDefault: vi.fn().mockResolvedValue(undefined),
  deleteWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  moveProjectsBetweenWorkspaces: vi.fn().mockResolvedValue({ ok: true, movedCount: 0 }),
}));

vi.mock('@/lib/mcp', () => ({
  notifyMcpWorkspaceAdded: vi.fn(),
  notifyMcpWorkspaceRemoved: vi.fn(),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
}));

import { getWorkspaceManager, _resetForTests } from '../workspace-manager';
import * as sync from '@/lib/sync';

describe('workspace-manager', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
  });

  it('bootstrap creates a default workspace lazily when none exist server-side', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    expect(sync.pushWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "User's workspace", isDefault: true, userId: 'u1' }),
    );
    expect(mgr.list().length).toBe(1);
    expect(mgr.currentWorkspaceId).not.toBeNull();
  });

  it('bootstrap seeds currentWorkspaceId from is_default=true row', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: false, createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: true,  createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    expect(mgr.currentWorkspaceId).toBe('w2');
  });

  it('switchWorkspace updates the active pointer and notifies listeners', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    const sub = vi.fn();
    mgr.subscribe(sub);
    await mgr.switchWorkspace('w2');
    expect(mgr.currentWorkspaceId).toBe('w2');
    expect(sub).toHaveBeenCalled();
  });

  it('add creates the row + token, registers the bearer with Rust', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    const before = mgr.list().length;
    await mgr.add({ name: 'Work' });
    expect(sync.pushWorkspace).toHaveBeenCalled();
    expect(mgr.list().length).toBe(before + 1);
    const { notifyMcpWorkspaceAdded } = await import('@/lib/mcp');
    expect(notifyMcpWorkspaceAdded).toHaveBeenCalled();
  });

  it('remove with purge:true deletes the workspace row and notifies Rust', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    await mgr.remove('w2', { purge: true });
    expect(sync.deleteWorkspace).toHaveBeenCalledWith('w2', 'u1');
  });

  it('remove with moveTargetWorkspaceId moves projects first, then deletes', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    await mgr.remove('w2', { moveTargetWorkspaceId: 'w1' });
    expect(sync.moveProjectsBetweenWorkspaces).toHaveBeenCalledWith('u1', 'w2', 'w1');
    expect(sync.deleteWorkspace).toHaveBeenCalledWith('w2', 'u1');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

```bash
npm run test -- workspace-manager
```

- [ ] **Step 3: Commit failing tests**

```bash
git add src/lib/workspaces/__tests__/workspace-manager.test.ts
git commit -m "test(workspaces): failing tests for workspace-manager (TDD red)"
```

### Task C5: Implement `workspace-manager.ts`

**Files:**
- Create: `src/lib/workspaces/workspace-manager.ts`

- [ ] **Step 1: Implement**

```ts
// src/lib/workspaces/workspace-manager.ts
//
// Mirrors src/lib/accounts/account-manager.ts one level deeper. The
// singleton holds the per-account workspaces[] + currentWorkspaceId, and is
// the sole writer for Supabase mutations (add/rename/remove/setDefault).
//
// Bootstrap order (called from auth-store.syncOnLogin AFTER the supabase
// session is established):
//   1. fetchWorkspaces(userId) from Supabase.
//   2. If [] returned, INSERT one default workspace (the migration's
//      backfill only covers users with projects; project-less accounts get
//      a workspace lazily here).
//   3. Read active.json under the account's dir; if present + still valid,
//      restore currentWorkspaceId. Otherwise seed from is_default=true.
//   4. Push every workspace's bearer to Rust via notifyMcpWorkspaceAdded.

import { readWorkspaceIndex, writeWorkspaceIndex, readActiveWorkspace, writeActiveWorkspace } from './workspace-storage';
import { secureSet, secureGet, secureDelete } from '@/lib/accounts/secure-store';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchWorkspaces, pushWorkspace, renameWorkspace, setWorkspaceDefault,
  deleteWorkspace, moveProjectsBetweenWorkspaces,
  type WorkspaceRecord,
} from '@/lib/sync';
import { notifyMcpWorkspaceAdded, notifyMcpWorkspaceRemoved } from '@/lib/mcp';
import { generateWorkspaceMcpToken } from './mcp-token';

export interface WorkspaceSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

function workspaceMcpKey(accountId: string, workspaceId: string): string {
  return `notter:account:${accountId}:workspace:${workspaceId}:mcp_token`;
}

export class WorkspaceManager {
  private workspaces: WorkspaceSummary[] = [];
  private current: string | null = null;
  private booted = false;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(); } catch (e) { console.error('[workspace-manager] listener failed', e); }
    }
  }

  get currentWorkspaceId(): string | null { return this.current; }
  list(): WorkspaceSummary[] { return [...this.workspaces]; }
  get(id: string): WorkspaceSummary | null { return this.workspaces.find((w) => w.id === id) ?? null; }

  /** Reset hook called from registerResettableStore on account-switch. */
  reset(): void {
    this.workspaces = [];
    this.current = null;
    this.booted = false;
    this.notify();
  }

  async bootstrap(): Promise<void> {
    if (this.booted) return;
    const accountId = getAccountManager().activeAccountId;
    const userId = useAuthStore.getState().user?.id;
    if (!accountId || !userId) {
      console.warn('[workspace-manager] bootstrap skipped — no active account/user');
      return;
    }

    // 1. Fetch from Supabase.
    let remote = (await fetchWorkspaces(userId)) ?? [];

    // 2. Lazy default for project-less accounts.
    if (remote.length === 0) {
      const id = crypto.randomUUID();
      const result = await pushWorkspace({
        id, userId, name: "User's workspace", isDefault: true,
      });
      if (result.ok) {
        remote = [{
          id, userId, name: "User's workspace", isDefault: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }];
      } else {
        // Re-fetch — a parallel sign-in on another device may have created one.
        remote = (await fetchWorkspaces(userId)) ?? [];
      }
    }

    this.workspaces = remote.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault }));

    // 3. Persist index.json for offline fast-boot.
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });

    // 4. Restore active pointer.
    const active = await readActiveWorkspace(accountId);
    if (active.workspaceId && this.workspaces.some((w) => w.id === active.workspaceId)) {
      this.current = active.workspaceId;
    } else {
      this.current = this.workspaces.find((w) => w.isDefault)?.id ?? this.workspaces[0]?.id ?? null;
      if (this.current) await writeActiveWorkspace(accountId, { workspaceId: this.current });
    }

    // 5. Push every bearer to Rust. Auto-mint missing ones.
    for (const ws of this.workspaces) {
      const key = workspaceMcpKey(accountId, ws.id);
      let bearer = await secureGet(key);
      if (!bearer) {
        bearer = generateWorkspaceMcpToken();
        await secureSet(key, bearer);
      }
      await notifyMcpWorkspaceAdded(accountId, ws.id, bearer);
    }

    this.booted = true;
    this.notify();
  }

  async switchWorkspace(targetId: string): Promise<void> {
    if (!this.workspaces.some((w) => w.id === targetId)) {
      throw new Error(`unknown workspace ${targetId}`);
    }
    if (this.current === targetId) return;
    const accountId = getAccountManager().activeAccountId;
    if (!accountId) throw new Error('switchWorkspace: no active account');
    this.current = targetId;
    await writeActiveWorkspace(accountId, { workspaceId: targetId });
    this.notify();
  }

  async add(input: { name: string; isDefault?: boolean }): Promise<WorkspaceSummary> {
    const accountId = getAccountManager().activeAccountId;
    const userId = useAuthStore.getState().user?.id;
    if (!accountId || !userId) throw new Error('add: not signed in');
    if (this.workspaces.some((w) => w.name === input.name)) {
      throw new Error('duplicate_name');
    }
    const id = crypto.randomUUID();
    const isDefault = input.isDefault ?? false;
    const result = await pushWorkspace({ id, userId, name: input.name, isDefault });
    if (!result.ok) throw new Error(result.code);

    if (isDefault) {
      // Clear is_default on the previous default in-memory; setWorkspaceDefault
      // already did the DB writes inside pushWorkspace's transaction window
      // via the partial unique index — but if it fired in REST order, the
      // first INSERT may have collided. Be safe: call setWorkspaceDefault
      // explicitly to converge.
      await setWorkspaceDefault(id, userId);
      this.workspaces = this.workspaces.map((w) => ({ ...w, isDefault: false }));
    }

    const summary: WorkspaceSummary = { id, name: input.name, isDefault };
    this.workspaces.push(summary);
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });

    // Mint + register bearer.
    const bearer = generateWorkspaceMcpToken();
    await secureSet(workspaceMcpKey(accountId, id), bearer);
    await notifyMcpWorkspaceAdded(accountId, id, bearer);

    this.notify();
    return summary;
  }

  async rename(id: string, newName: string): Promise<void> {
    const userId = useAuthStore.getState().user?.id;
    const accountId = getAccountManager().activeAccountId;
    if (!userId || !accountId) throw new Error('rename: not signed in');
    if (this.workspaces.some((w) => w.id !== id && w.name === newName)) {
      throw new Error('duplicate_name');
    }
    const result = await renameWorkspace(id, userId, newName);
    if (!result.ok) throw new Error(result.code);
    this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, name: newName } : w));
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });
    this.notify();
  }

  async setDefault(id: string): Promise<void> {
    const userId = useAuthStore.getState().user?.id;
    const accountId = getAccountManager().activeAccountId;
    if (!userId || !accountId) throw new Error('setDefault: not signed in');
    await setWorkspaceDefault(id, userId);
    this.workspaces = this.workspaces.map((w) => ({ ...w, isDefault: w.id === id }));
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });
    this.notify();
  }

  async remove(
    id: string,
    opts: { moveTargetWorkspaceId: string } | { purge: true },
  ): Promise<void> {
    const userId = useAuthStore.getState().user?.id;
    const accountId = getAccountManager().activeAccountId;
    if (!userId || !accountId) throw new Error('remove: not signed in');
    if (this.workspaces.length <= 1) {
      throw new Error('cannot_remove_last_workspace');
    }
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) throw new Error(`unknown workspace ${id}`);
    if (ws.isDefault && 'moveTargetWorkspaceId' in opts) {
      throw new Error('cannot_remove_default_workspace');
    }

    if ('moveTargetWorkspaceId' in opts) {
      const moved = await moveProjectsBetweenWorkspaces(userId, id, opts.moveTargetWorkspaceId);
      if (!moved.ok) throw new Error(moved.message);
    } else {
      // purge path — projects need to go too. Caller (delete-dialog) issues
      // the project deletes via usePlannerStore.deleteProject for each project
      // in the workspace BEFORE calling remove(). This method does not own
      // the project teardown; it only handles workspace-row removal.
    }

    const delResult = await deleteWorkspace(id, userId);
    if (!delResult.ok) {
      // 'has_projects' means UPDATE didn't cover every row OR purge wasn't
      // performed by the caller. Surface to UI.
      throw new Error(delResult.code);
    }

    // Drop the bearer.
    const key = workspaceMcpKey(accountId, id);
    const bearer = await secureGet(key);
    if (bearer) {
      await secureDelete(key);
      await notifyMcpWorkspaceRemoved(bearer);
    }

    this.workspaces = this.workspaces.filter((w) => w.id !== id);
    await writeWorkspaceIndex(accountId, { workspaces: this.workspaces });
    if (this.current === id) {
      this.current = this.workspaces.find((w) => w.isDefault)?.id ?? this.workspaces[0]?.id ?? null;
      if (this.current) await writeActiveWorkspace(accountId, { workspaceId: this.current });
    }
    this.notify();
  }
}

let _singleton: WorkspaceManager | null = null;
export function getWorkspaceManager(): WorkspaceManager {
  if (!_singleton) _singleton = new WorkspaceManager();
  return _singleton;
}

export function _resetForTests(): void {
  _singleton = null;
}
```

- [ ] **Step 2: Run tests — expect PASS**

```bash
npm run test -- workspace-manager
```

If `notifyMcpWorkspaceAdded` / `notifyMcpWorkspaceRemoved` don't exist yet in `@/lib/mcp`, this will fail. Phase I provides them. For now, add minimal stubs:

```ts
// Append to src/lib/mcp/index.ts — temporary stubs, Phase I fills in.
export async function notifyMcpWorkspaceAdded(
  _accountId: string, _workspaceId: string, _bearer: string,
): Promise<void> {}
export async function notifyMcpWorkspaceRemoved(_bearer: string): Promise<void> {}
```

Re-run tests — should PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/workspaces/workspace-manager.ts src/lib/mcp/index.ts
git commit -m "feat(workspaces): WorkspaceManager singleton + Mcp stubs (TDD green)"
```

---

## Phase D — useWorkspacesStore (Zustand, TDD)

This phase introduces the Zustand store consumed by `WorkspaceSwitcher`, `WorkspaceManagerDialog`, and (transitively, via the derived selector in Phase E) `usePlannerStore`.

### Task D1: Failing tests for the store

**Files:**
- Create: `src/stores/__tests__/workspaces-store.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// src/stores/__tests__/workspaces-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/accounts/store-registry', () => ({
  registerResettableStore: vi.fn(),
}));

import { useWorkspacesStore } from '@/stores/workspaces-store';

describe('useWorkspacesStore', () => {
  beforeEach(() => {
    useWorkspacesStore.getState().reset();
  });

  it('starts empty', () => {
    const { workspaces, currentWorkspaceId, loading } = useWorkspacesStore.getState();
    expect(workspaces).toEqual([]);
    expect(currentWorkspaceId).toBeNull();
    expect(loading).toBe(false);
  });

  it('applyRemoteWorkspaces replaces the slice', () => {
    const rows = [
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ];
    useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
    expect(useWorkspacesStore.getState().workspaces).toEqual(rows);
  });

  it('setCurrentWorkspaceId updates the active id', () => {
    useWorkspacesStore.getState().setCurrentWorkspaceId('w2');
    expect(useWorkspacesStore.getState().currentWorkspaceId).toBe('w2');
  });

  it('reset wipes all slices', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true, createdAt: '', updatedAt: '' },
    ]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    useWorkspacesStore.getState().reset();
    const s = useWorkspacesStore.getState();
    expect(s.workspaces).toEqual([]);
    expect(s.currentWorkspaceId).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
npm run test -- workspaces-store
```

- [ ] **Step 3: Commit failing tests**

```bash
git add src/stores/__tests__/workspaces-store.test.ts
git commit -m "test(workspaces-store): failing tests (TDD red)"
```

### Task D2: Implement the store

**Files:**
- Create: `src/stores/workspaces-store.ts`

- [ ] **Step 1: Implement**

```ts
// src/stores/workspaces-store.ts
//
// Zustand-backed view of workspaces for UI components. The canonical writer
// is WorkspaceManager (src/lib/workspaces/workspace-manager.ts) — this store
// just reflects state for React. realtime.ts pushes rows into
// applyRemoteWorkspaces on every postgres_changes event; WorkspaceManager
// pushes the active-id changes via setCurrentWorkspaceId.
import { create } from 'zustand';
import type { WorkspaceRecord } from '@/lib/sync';
import { registerResettableStore } from '@/lib/accounts/store-registry';

interface WorkspacesState {
  workspaces: WorkspaceRecord[];
  currentWorkspaceId: string | null;
  loading: boolean;

  setCurrentWorkspaceId: (id: string | null) => void;
  applyRemoteWorkspaces: (rows: WorkspaceRecord[]) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

const INITIAL = {
  workspaces: [] as WorkspaceRecord[],
  currentWorkspaceId: null as string | null,
  loading: false,
};

export const useWorkspacesStore = create<WorkspacesState>((set) => ({
  ...INITIAL,
  setCurrentWorkspaceId: (id) => set({ currentWorkspaceId: id }),
  applyRemoteWorkspaces: (rows) => set({ workspaces: rows }),
  setLoading: (loading) => set({ loading }),
  reset: () => set(INITIAL),
}));

registerResettableStore(() => useWorkspacesStore.getState().reset());
```

- [ ] **Step 2: Run — expect PASS**

```bash
npm run test -- workspaces-store
```

- [ ] **Step 3: Commit**

```bash
git add src/stores/workspaces-store.ts
git commit -m "feat(workspaces-store): Zustand store + reset registration (TDD green)"
```

---

## Phase E — Refactor usePlannerStore

This phase introduces the `allProjects[]` canonical slice and exposes `projects` as a derived value filtered by `useWorkspacesStore.currentWorkspaceId`. Every existing call site that reads `state.projects` keeps working — the filter is transparent. `applyRemoteProjects` rewrites the canonical slice; switching workspace fires a re-render automatically via the Zustand subscription wired in step 3 below.

### Task E1: Add `allProjects[]` slice + derived selector

**Files:**
- Modify: `src/stores/planner-store.ts`

- [ ] **Step 1: Rename the existing `projects` field to `allProjects` and add the derived selector**

The strategy: `allProjects[]` is the canonical state slice. `projects` becomes a derived value that gets recomputed when either `allProjects` or `currentWorkspaceId` changes. The cleanest implementation in Zustand is to keep `projects` in state and sync it via a subscription to `useWorkspacesStore`:

```ts
// At the top of src/stores/planner-store.ts, add:
import { useWorkspacesStore } from './workspaces-store';

// Inside the state interface:
interface PlannerState {
  // NEW canonical slice:
  allProjects: Project[];
  // Existing field renamed semantically — now a derived view filtered by
  // currentWorkspaceId. Kept as state (not getter) so Zustand subscribers
  // see the change.
  projects: Project[];
  // ... rest unchanged
}

// Replace the initial state:
allProjects: [],
projects: [],

// Update applyRemoteProjects to write to allProjects and recompute projects:
applyRemoteProjects: (projects) => {
  const currentWsId = useWorkspacesStore.getState().currentWorkspaceId;
  const filtered = currentWsId
    ? projects.filter((p) => p.workspaceId === currentWsId)
    : projects;
  set({ allProjects: projects, projects: filtered });
  // ... existing filesystem mirror logic stays
},
```

- [ ] **Step 2: Update every existing setter that mutates `projects` to mutate `allProjects` first, then recompute**

A small helper avoids duplication:

```ts
// Internal helper inside the store factory:
function recomputeProjects(allProjects: Project[]): Project[] {
  const currentWsId = useWorkspacesStore.getState().currentWorkspaceId;
  return currentWsId
    ? allProjects.filter((p) => p.workspaceId === currentWsId)
    : allProjects;
}
```

Apply to `createProject`, `renameProject`, `updateProjectPath`, `deleteProject`. Example:

```ts
createProject: async (name, path) => {
  const wsId = useWorkspacesStore.getState().currentWorkspaceId;
  if (!wsId) throw new Error('createProject: no active workspace');
  await mkdir(accountScopedPath(`NotterProjects/${name}`), { baseDir: BaseDirectory.AppLocalData, recursive: true });
  const newProject: Project = { name, path, workspaceId: wsId };
  const newAll = [...get().allProjects, newProject];
  set({ allProjects: newAll, projects: recomputeProjects(newAll) });
  await writeTextFile(getProjectsFile(), JSON.stringify(newAll, null, 2), { baseDir: BaseDirectory.AppLocalData });
  projectsSync.schedule(newAll);
},
```

Apply the same pattern to `renameProject`, `updateProjectPath`, `deleteProject`. The `selectedProject` invariant is unchanged — but note that on workspace switch, the selected project may no longer be in the filtered view; clearing it is handled in Step 3.

- [ ] **Step 3: Subscribe to workspace changes and recompute `projects` on switch**

Add at the bottom of the file (after `registerResettableStore`):

```ts
// Whenever the active workspace changes, recompute the filtered `projects`
// view. If the currently-selected project no longer belongs to the active
// workspace, clear it so the planner UI doesn't render a phantom.
useWorkspacesStore.subscribe((state, prev) => {
  if (state.currentWorkspaceId === prev.currentWorkspaceId) return;
  const all = usePlannerStore.getState().allProjects;
  const filtered = state.currentWorkspaceId
    ? all.filter((p) => p.workspaceId === state.currentWorkspaceId)
    : all;
  const selectedProject = usePlannerStore.getState().selectedProject;
  const stillSelected = selectedProject && filtered.some((p) => p.name === selectedProject.name)
    ? selectedProject : null;
  usePlannerStore.setState({
    projects: filtered,
    selectedProject: stillSelected,
    selectedSubject: stillSelected ? usePlannerStore.getState().selectedSubject : null,
    subjects: stillSelected ? usePlannerStore.getState().subjects : [],
  });
});
```

- [ ] **Step 4: Add `moveProjectToWorkspace(projectName, targetWorkspaceId)` action**

Used by Phase L's `MoveProjectToWorkspaceMenu`:

```ts
moveProjectToWorkspace: async (projectName: string, targetWorkspaceId: string) => {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return;
  const newAll = get().allProjects.map((p) =>
    p.name === projectName ? { ...p, workspaceId: targetWorkspaceId } : p
  );
  set({ allProjects: newAll, projects: recomputeProjects(newAll) });
  const { updateProjectWorkspace } = await import('@/lib/sync');
  await updateProjectWorkspace(userId, projectName, targetWorkspaceId);
},
```

Add the matching field to the `PlannerState` interface.

- [ ] **Step 5: Update `reset()`**

```ts
reset() {
  set({
    allProjects: [],
    projects: [],
    selectedProject: null,
    subjects: [],
    selectedSubject: null,
    subjectRows: [],
    subjectContent: '# Nova Anotação',
    isViewing: false,
  });
},
```

- [ ] **Step 6: Type-check + run all existing tests**

```bash
npm run build
npm run test
```

Expected: PASS. The `Project.workspaceId` field added in Phase B is now actually consumed; any callers passing `Project` literals without `workspaceId` will surface here. Fix call sites. Common spots: tests that mock `Project` instances, the realtime refetch closure (which already passes through `applyRemoteProjects` — unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/stores/planner-store.ts
git commit -m "$(cat <<'EOF'
refactor(planner): allProjects canonical slice + workspace-filtered projects derived view

- usePlannerStore.applyRemoteProjects writes to allProjects[]
- projects[] is recomputed by filtering allProjects by
  useWorkspacesStore.currentWorkspaceId
- subscription on workspaces-store re-filters on workspace switch and
  clears stale selectedProject if it no longer belongs to the active
  workspace
- moveProjectToWorkspace action added for Phase L

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase F — Realtime + auth-store wiring

This phase wires the new `workspaces` table into the realtime subscription and extends `syncOnLogin` to bootstrap `WorkspaceManager` and seed `useWorkspacesStore`.

### Task F1: Subscribe `workspaces` table in `realtime.ts`

**Files:**
- Modify: `src/lib/realtime.ts`

- [ ] **Step 1: Add the refetch closure + subscription**

```ts
// Add to imports:
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { fetchWorkspaces } from '@/lib/sync';

// Inside startRealtimeSync, after refetchActions:
const refetchWorkspaces = async () => {
  const rows = await fetchWorkspaces(userId);
  if (rows) useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
};

// Add the subscription before `channel = ch.subscribe()`:
ch = subscribeUserTable(ch, 'workspaces', userId, refetchWorkspaces);
```

- [ ] **Step 2: Type-check**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/realtime.ts
git commit -m "feat(realtime): subscribe workspaces table"
```

### Task F2: Wire `WorkspaceManager` boot into `syncOnLogin`

**Files:**
- Modify: `src/stores/auth-store.ts`

- [ ] **Step 1: Import and bootstrap**

```ts
// Add to the named imports from @/lib/sync:
fetchWorkspaces,

// Add new imports:
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { useWorkspacesStore } from '@/stores/workspaces-store';

// Inside syncOnLogin, FIRST step (before preferences):
try {
  // Workspaces must boot first — projects fetch filters by workspace_id.
  // bootstrap() handles the lazy default workspace if the user has none.
  await getWorkspaceManager().bootstrap();
  const remoteWs = await fetchWorkspaces(userId);
  if (remoteWs) useWorkspacesStore.getState().applyRemoteWorkspaces(remoteWs);
  const currentId = getWorkspaceManager().currentWorkspaceId;
  if (currentId) useWorkspacesStore.getState().setCurrentWorkspaceId(currentId);
} catch (e) {
  console.error('[auth] workspaces bootstrap failed:', e);
}
```

Place this BEFORE the existing `// Preferences` block.

- [ ] **Step 2: Reset WorkspaceManager on signOut**

In `signOut`, after `stopRealtimeSync()`:

```ts
// Drop the WorkspaceManager singleton state — the next sign-in will rebuild it.
getWorkspaceManager().reset();
```

- [ ] **Step 3: Type-check**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/stores/auth-store.ts
git commit -m "feat(auth): bootstrap WorkspaceManager + seed useWorkspacesStore in syncOnLogin"
```

---

## Phase G — Filesystem migration v2

This phase introduces the v2 sentinel + per-account directory mover. Runs once per app installation: moves `notter-ai/<accountId>/cache/` and `notter-ai/<accountId>/exports/` to `notter-ai/<accountId>/<defaultWorkspaceId>/cache/` and `.../exports/`.

### Task G1: `fs-migration-v2.ts` with tests

**Files:**
- Create: `src/lib/workspaces/fs-migration-v2.ts`
- Create: `src/lib/workspaces/__tests__/fs-migration-v2.test.ts`

- [ ] **Step 1: Write tests first**

```ts
// src/lib/workspaces/__tests__/fs-migration-v2.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = {
  exists: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  writeTextFile: vi.fn(),
};
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppLocalData: 'AppLocalData' },
  exists: (...args: any[]) => fsMock.exists(...args),
  mkdir: (...args: any[]) => fsMock.mkdir(...args),
  rename: (...args: any[]) => fsMock.rename(...args),
  writeTextFile: (...args: any[]) => fsMock.writeTextFile(...args),
}));

import {
  migrateAccountToWorkspacesIfNeeded,
  SENTINEL_V2_PATH,
} from '../fs-migration-v2';

describe('fs-migration-v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.exists.mockResolvedValue(false);
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);
    fsMock.writeTextFile.mockResolvedValue(undefined);
  });

  it('skips when the v2 sentinel already exists', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === SENTINEL_V2_PATH);
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.skipped).toBe(true);
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it('moves cache and exports when present', async () => {
    fsMock.exists.mockImplementation(async (p: string) => {
      return p === 'notter-ai/acc-1/cache' || p === 'notter-ai/acc-1/exports';
    });
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.moved).toEqual(expect.arrayContaining(['cache', 'exports']));
    expect(fsMock.rename).toHaveBeenCalledTimes(2);
  });

  it('skips a subdir that does not exist', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === 'notter-ai/acc-1/cache');
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.moved).toEqual(['cache']);
    expect(fsMock.rename).toHaveBeenCalledTimes(1);
  });

  it('writes the sentinel only when no failures', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === 'notter-ai/acc-1/cache');
    fsMock.rename.mockRejectedValueOnce(new Error('locked'));
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.failed.length).toBe(1);
    expect(fsMock.writeTextFile).not.toHaveBeenCalledWith(SENTINEL_V2_PATH, expect.anything(), expect.anything());
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/lib/workspaces/fs-migration-v2.ts
import {
  BaseDirectory, exists, mkdir, rename, writeTextFile,
} from '@tauri-apps/plugin-fs';

export const SENTINEL_V2_PATH = 'notter-ai/.migration-v2-workspaces-complete';

const WORKSPACE_OWNED_SUBDIRS = ['cache', 'exports'] as const;

export interface MigrationV2Result {
  skipped: boolean;
  moved: string[];
  failed: { path: string; error: string }[];
}

/**
 * Move `<accountId>/cache/` and `<accountId>/exports/` to
 * `<accountId>/<defaultWorkspaceId>/...`. Sentinel-gated. Idempotent:
 * if the target already exists (partial prior run), the source rename is
 * skipped for that subdir.
 */
export async function migrateAccountToWorkspacesIfNeeded(
  accountId: string,
  defaultWorkspaceId: string,
): Promise<MigrationV2Result> {
  const opts = { baseDir: BaseDirectory.AppLocalData };
  if (await exists(SENTINEL_V2_PATH, opts)) {
    return { skipped: true, moved: [], failed: [] };
  }

  await mkdir(`notter-ai/${accountId}/${defaultWorkspaceId}`, {
    ...opts, recursive: true,
  });

  const moved: string[] = [];
  const failed: { path: string; error: string }[] = [];

  for (const sub of WORKSPACE_OWNED_SUBDIRS) {
    const src = `notter-ai/${accountId}/${sub}`;
    const dst = `notter-ai/${accountId}/${defaultWorkspaceId}/${sub}`;
    if (!(await exists(src, opts))) continue;
    if (await exists(dst, opts)) {
      // Already moved on a partial prior run — skip without error.
      moved.push(sub);
      continue;
    }
    try {
      await rename(src, dst, {
        oldPathBaseDir: BaseDirectory.AppLocalData,
        newPathBaseDir: BaseDirectory.AppLocalData,
      });
      moved.push(sub);
    } catch (e: any) {
      failed.push({ path: sub, error: e?.message ?? String(e) });
    }
  }

  if (failed.length === 0) {
    await writeTextFile(
      SENTINEL_V2_PATH,
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        perAccount: [{ accountId, workspaceId: defaultWorkspaceId, moved }],
      }, null, 2),
      opts,
    );
  }

  return { skipped: false, moved, failed };
}
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
npm run test -- fs-migration-v2
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/workspaces/fs-migration-v2.ts src/lib/workspaces/__tests__/fs-migration-v2.test.ts
git commit -m "feat(workspaces): fs-migration-v2 (sentinel-gated subdir mover)"
```

### Task G2: Wire into `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Run the migration after `WorkspaceManager` bootstrap**

The v2 migration needs a `defaultWorkspaceId`, which only exists after `WorkspaceManager.bootstrap()` resolves. But `WorkspaceManager.bootstrap()` is called from `syncOnLogin`, which fires AFTER `initialize()`. To avoid coupling, the v2 migration runs as the FIRST step of `syncOnLogin` after `WorkspaceManager.bootstrap()`:

Update `src/stores/auth-store.ts` `syncOnLogin` — inside the workspaces bootstrap block from Phase F2, after `currentId` is computed:

```ts
// Append after setCurrentWorkspaceId in syncOnLogin:
if (currentId) {
  const mgr = getAccountManager();
  if (mgr.activeAccountId) {
    const { migrateAccountToWorkspacesIfNeeded } = await import('@/lib/workspaces/fs-migration-v2');
    try {
      const r = await migrateAccountToWorkspacesIfNeeded(mgr.activeAccountId, currentId);
      if (!r.skipped && r.failed.length > 0) {
        const { toast } = await import('sonner');
        toast.warning(
          `Workspaces migration partial — ${r.failed.length} item(s) could not be moved. See logs.`,
          { duration: 10_000 },
        );
        console.warn('[auth] fs-migration-v2 failures:', r.failed);
      }
    } catch (e) {
      console.error('[auth] fs-migration-v2 threw:', e);
    }
  }
}
```

This keeps `App.tsx` untouched and centralizes migration in the same code path that already runs the M1 fs migration.

- [ ] **Step 2: Type-check + run tests**

```bash
npm run build
npm run test
```

- [ ] **Step 3: Commit**

```bash
git add src/stores/auth-store.ts
git commit -m "feat(auth): run fs-migration-v2 after WorkspaceManager boot"
```

---

## Phase H — MCP server (Rust) refactor

This phase rewires the Rust MCP server's token map from `HashMap<token, accountId>` to `HashMap<token, AuthOwner { account_id, workspace_id }>`, adds workspace-scoped tool queries, and ships the new per-workspace config file path. This is the largest single phase — Rust + a small TS surface — and should run as its own subagent.

### Task H1: `auth.rs` — `AuthOwner`, `AuthContext.workspace_id`, new commands

**Files:**
- Modify: `src-tauri/src/mcp/auth.rs`

- [ ] **Step 1: Add `AuthOwner` struct and update `AuthContext`**

```rust
// src-tauri/src/mcp/auth.rs — replace the existing AuthContext and add AuthOwner

#[derive(Debug, Clone)]
pub struct AuthOwner {
    pub account_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub account_id: String,
    pub workspace_id: String,
}
```

- [ ] **Step 2: Update `mcp_remove_account_token` to scan `token_to_owner`**

```rust
#[tauri::command]
pub async fn mcp_remove_account_token(
    account_id: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens.remove(&account_id);
    s.token_to_owner.retain(|_, owner| owner.account_id != account_id);
    Ok(())
}
```

- [ ] **Step 3: Update `mcp_register_bearer` to take `workspace_id`**

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterBearerArgs {
    pub account_id: String,
    pub workspace_id: String,
    pub bearer_token: String,
}

#[tauri::command]
pub async fn mcp_register_bearer(
    args: RegisterBearerArgs,
    app: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    {
        let mut s = state.write().await;
        // Drop any prior bearer mapped to the same (account, workspace) pair.
        s.token_to_owner.retain(|_, owner| {
            !(owner.account_id == args.account_id && owner.workspace_id == args.workspace_id)
        });
        s.token_to_owner.insert(
            args.bearer_token,
            AuthOwner {
                account_id: args.account_id.clone(),
                workspace_id: args.workspace_id.clone(),
            },
        );
    }
    let _ = crate::mcp::server::write_per_workspace_configs(&app, state.inner()).await;
    Ok(())
}
```

- [ ] **Step 4: New command `mcp_revoke_bearer`**

```rust
#[tauri::command]
pub async fn mcp_revoke_bearer(
    bearer_token: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.token_to_owner.remove(&bearer_token);
    Ok(())
}
```

- [ ] **Step 5: Update `lookup_account_for_token` to return `AuthOwner`**

```rust
pub async fn lookup_owner_for_token(
    state: &McpState,
    bearer: &str,
) -> Option<AuthOwner> {
    let s = state.read().await;
    s.token_to_owner.get(bearer).cloned()
}
```

(Delete the old `lookup_account_for_token`.)

- [ ] **Step 6: Update `bearer_auth` middleware**

```rust
pub async fn bearer_auth(
    AxumState(state): AxumState<crate::mcp::server::McpState>,
    mut req: Request,
    next: Next,
) -> Response {
    let bearer = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let Some(token) = bearer else {
        return unauthorized_response("missing or malformed Authorization header");
    };
    let owner = match lookup_owner_for_token(&state, token).await {
        Some(o) => o,
        None => return unauthorized_response("unknown token"),
    };
    req.extensions_mut().insert(AuthContext {
        account_id: owner.account_id,
        workspace_id: owner.workspace_id,
    });
    next.run(req).await
}
```

- [ ] **Step 7: `cargo check`**

```bash
cd src-tauri && cargo check
```

Will fail until Task H2 updates `server.rs`. That's expected.

### Task H2: `server.rs` — rename map, rename config writer

**Files:**
- Modify: `src-tauri/src/mcp/server.rs`

- [ ] **Step 1: Update `McpStateInner`**

```rust
#[derive(Clone)]
pub struct McpStateInner {
    /// bearer token -> { account_id, workspace_id }
    pub token_to_owner: HashMap<String, crate::mcp::auth::AuthOwner>,
    /// account id -> (access_token, expires_at_unix_seconds)
    pub access_tokens: HashMap<String, (String, i64)>,
    pub url: Option<String>,
    pub nonce: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
}
```

- [ ] **Step 2: Rename `write_per_account_configs` → `write_per_workspace_configs`**

```rust
#[derive(serde::Serialize, serde::Deserialize)]
pub struct McpWorkspaceConfig {
    pub url: String,
    pub bearer_token: String,
    pub account_id: String,
    pub workspace_id: String,
    pub generated_at: String,
}

pub async fn write_per_workspace_configs(
    app: &AppHandle,
    state: &McpState,
) -> Result<(), String> {
    let dir = mcp_dir(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create_dir_all: {e}"))?;
    let (url, entries) = {
        let s = state.read().await;
        let url = s.url.clone().unwrap_or_default();
        let entries: Vec<(String, crate::mcp::auth::AuthOwner)> = s
            .token_to_owner
            .iter()
            .map(|(tok, owner)| (tok.clone(), owner.clone()))
            .collect();
        (url, entries)
    };
    let generated_at = crate::mcp::endpoint::now_rfc3339();
    for (bearer_token, owner) in entries {
        let cfg = McpWorkspaceConfig {
            url: url.clone(),
            bearer_token,
            account_id: owner.account_id.clone(),
            workspace_id: owner.workspace_id.clone(),
            generated_at: generated_at.clone(),
        };
        let json = serde_json::to_string_pretty(&cfg).map_err(|e| format!("serde: {e}"))?;
        let path = dir.join(format!("{}-{}-config.json", owner.account_id, owner.workspace_id));
        tokio::fs::write(&path, json)
            .await
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    // Locked decision §2b: delete any leftover M3 <accountId>-config.json
    // files. The user has no production CLI configs depending on them.
    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with("-config.json")
                && name.matches('-').count() == 1
            {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 3: Rename `mcp_read_account_config` → `mcp_read_workspace_config`**

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceConfigArgs {
    pub account_id: String,
    pub workspace_id: String,
}

#[tauri::command]
pub async fn mcp_read_workspace_config(
    args: ReadWorkspaceConfigArgs,
    state: tauri::State<'_, McpState>,
) -> Result<McpWorkspaceConfig, String> {
    let s = state.read().await;
    let url = s
        .url
        .clone()
        .ok_or_else(|| "MCP server not yet bound".to_string())?;
    let (bearer, owner) = s
        .token_to_owner
        .iter()
        .find(|(_, owner)| owner.account_id == args.account_id && owner.workspace_id == args.workspace_id)
        .map(|(tok, owner)| (tok.clone(), owner.clone()))
        .ok_or_else(|| format!("no bearer for ({}, {})", args.account_id, args.workspace_id))?;
    Ok(McpWorkspaceConfig {
        url,
        bearer_token: bearer,
        account_id: owner.account_id,
        workspace_id: owner.workspace_id,
        generated_at: crate::mcp::endpoint::now_rfc3339(),
    })
}
```

- [ ] **Step 4: Update `start_mcp_server` post-bind reconciliation call**

```rust
if let Err(e) = write_per_workspace_configs(app, &state).await {
    eprintln!("[mcp] post-bind write_per_workspace_configs failed: {e}");
}
```

- [ ] **Step 5: `cargo check`**

```bash
cd src-tauri && cargo check
```

Will fail until H3 updates `tools.rs`. Expected.

### Task H3: `tools.rs` — workspace-scoped queries

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Add the workspace-project resolver helper**

The cleanest path is a pre-query that returns the project names belonging to the current `(account_id, workspace_id)` pair. Subjects then get filtered by `project_name in (...)`. For `list_subjects` (which queries the `subjects` table), this is a two-step. For tools that query `projects` directly, the workspace_id can be applied as a WHERE clause.

```rust
async fn workspace_project_names(
    auth: &AuthContext,
    state: &McpState,
) -> Result<Vec<String>, McpError> {
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "projects",
            &format!(
                "select=name&workspace_id=eq.{}",
                url_encode(&auth.workspace_id),
            ),
            &token,
        )
        .await?;
    let names: Vec<String> = body
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(names)
}

fn build_in_clause(names: &[String]) -> String {
    // PostgREST in syntax: in.(a,b,c). Names are user-provided; url-encode each.
    let inner = names.iter().map(|n| url_encode(n)).collect::<Vec<_>>().join(",");
    format!("in.({inner})")
}
```

- [ ] **Step 2: Update `list_subjects`**

```rust
async fn list_subjects(
    _params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let names = workspace_project_names(auth, state).await?;
    if names.is_empty() {
        return Ok(serde_json::json!([]));
    }
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subjects",
            &format!(
                "select=id,project_name,file_name,current_version_id,updated_at&project_name={}&order=updated_at.desc",
                build_in_clause(&names),
            ),
            &token,
        )
        .await?;
    Ok(body)
}
```

- [ ] **Step 3: Update `get_subject`, `list_versions`, `get_version`, `list_comments`, `post_subject_revision`**

Each of these takes a `subject_id`. The subject's owner-account is enforced by RLS, but the workspace scope is NOT enforced by RLS (subjects don't carry workspace_id). To prevent leaking subjects from a different workspace under the same account, fetch the subject's `project_name` and assert it's in the workspace's project list. A simple guard pattern:

```rust
async fn assert_subject_in_workspace(
    auth: &AuthContext,
    state: &McpState,
    subject_id: &str,
) -> Result<(), McpError> {
    let names = workspace_project_names(auth, state).await?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subjects",
            &format!("select=project_name&id=eq.{}&limit=1", url_encode(subject_id)),
            &token,
        )
        .await?;
    let pname = body
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.get("project_name"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::NotFound(format!("subject {subject_id} not found")))?;
    if !names.iter().any(|n| n == pname) {
        return Err(McpError::NotFound(format!("subject {subject_id} not found")));
    }
    Ok(())
}
```

Call `assert_subject_in_workspace(auth, state, &p.subject_id).await?;` as the FIRST line of `get_subject`, `list_versions`, `list_comments`, and `post_subject_revision`. For `get_version`, look up the version's `subject_id` via the existing query, then call the assert.

For `get_version`, the cleanest fix is to fetch `subject_id` alongside the version row (already in the SELECT list — `select=id,subject_id,...`) and then call `assert_subject_in_workspace` on the returned subject_id. Restructure:

```rust
async fn get_version(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: GetVersionParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("get_version: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subject_versions",
            &format!(
                "select=id,subject_id,content_markdown,parent_version_id,source,source_actor,label,created_at&id=eq.{}&limit=1",
                url_encode(&p.version_id),
            ),
            &token,
        )
        .await?;
    let row = body
        .as_array()
        .and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::NotFound(format!("version {} not found", p.version_id)))?;
    let subject_id = row
        .get("subject_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::SupabaseError("get_version: missing subject_id".into()))?
        .to_string();
    assert_subject_in_workspace(auth, state, &subject_id).await?;
    Ok(row)
}
```

- [ ] **Step 4: `cargo check`**

```bash
cd src-tauri && cargo check
```

Should pass. Address any remaining type errors (typos in field names, missing imports).

- [ ] **Step 5: Update existing Rust unit tests (if any)**

Search:

```bash
grep -rn "token_to_account\|McpStateInner\|AuthContext " src-tauri/src
```

For every test or call site referencing `token_to_account`, rename to `token_to_owner` and pass the `AuthOwner { account_id, workspace_id }` struct. The endpoint.rs tests don't touch these — check anyway.

- [ ] **Step 6: `cargo test`**

```bash
cd src-tauri && cargo test
```

All existing tests must pass. If a test is brittle to the rename, fix it in this commit.

### Task H4: `lib.rs` — register new commands, instantiate `token_to_owner`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update `McpStateInner` construction**

```rust
let mcp_state: mcp::McpState = std::sync::Arc::new(tokio::sync::RwLock::new(
    mcp::McpStateInner {
        token_to_owner: std::collections::HashMap::new(),
        access_tokens: std::collections::HashMap::new(),
        url: None,
        nonce: mcp::endpoint::generate_nonce(),
        supabase_url: String::new(),
        supabase_anon_key: String::new(),
    },
));
```

- [ ] **Step 2: Update `invoke_handler!`**

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing entries ...
    mcp::auth::mcp_update_account_token,
    mcp::auth::mcp_remove_account_token,
    mcp::auth::mcp_set_supabase_config,
    mcp::auth::mcp_register_bearer,
    mcp::auth::mcp_revoke_bearer,           // NEW
    mcp::server::mcp_read_workspace_config, // RENAMED from mcp_read_account_config
])
```

- [ ] **Step 3: `cargo check && cargo test`**

```bash
cd src-tauri && cargo check && cargo test
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/auth.rs src-tauri/src/mcp/server.rs src-tauri/src/mcp/tools.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
refactor(mcp): token_to_owner map with (account_id, workspace_id)

- AuthContext + AuthOwner gain workspace_id
- mcp_register_bearer signature now (accountId, workspaceId, bearerToken)
- new mcp_revoke_bearer command for per-workspace teardown
- mcp_remove_account_token revokes every bearer belonging to the account
- write_per_workspace_configs replaces write_per_account_configs; writes
  one file per (account, workspace) at <accountId>-<workspaceId>-config.json
- locked: the old <accountId>-config.json files are deleted (no shim)
- every tool query is workspace-scoped via workspace_project_names()
- assert_subject_in_workspace guards every subject-keyed tool
- existing cargo tests updated for the map rename

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase I — TS MCP glue

This phase fleshes out the stub `notifyMcpWorkspaceAdded` / `notifyMcpWorkspaceRemoved` added in Phase C, and replaces the deprecated `notifyMcpAccountAdded` call inside `AccountManager` with one that walks every workspace.

### Task I1: Real implementations in `src/lib/mcp/index.ts`

**Files:**
- Modify: `src/lib/mcp/index.ts`

- [ ] **Step 1: Replace the stubs**

```ts
/**
 * Register a per-workspace bearer with the Rust server. Called by
 * WorkspaceManager.add() and WorkspaceManager.bootstrap().
 */
export async function notifyMcpWorkspaceAdded(
  accountId: string,
  workspaceId: string,
  bearerToken: string,
): Promise<void> {
  try {
    await invoke('mcp_register_bearer', {
      args: { accountId, workspaceId, bearerToken },
    });
  } catch (e) {
    console.warn('[mcp] notifyMcpWorkspaceAdded failed:', e);
  }
}

/**
 * Revoke a single bearer in the Rust map. Used by WorkspaceManager.remove().
 */
export async function notifyMcpWorkspaceRemoved(bearerToken: string): Promise<void> {
  try {
    await invoke('mcp_revoke_bearer', { bearerToken });
  } catch (e) {
    console.warn('[mcp] notifyMcpWorkspaceRemoved failed:', e);
  }
}

/**
 * Read the per-workspace config file (or in-memory state). Used by the
 * "Copy MCP config" UI in WorkspaceManagerDialog.
 */
export interface McpWorkspaceConfig {
  url: string;
  bearer_token: string;
  account_id: string;
  workspace_id: string;
  generated_at: string;
}

export async function readMcpConfigForWorkspace(
  accountId: string,
  workspaceId: string,
): Promise<McpWorkspaceConfig | null> {
  try {
    return await invoke<McpWorkspaceConfig>('mcp_read_workspace_config', {
      args: { accountId, workspaceId },
    });
  } catch (e) {
    console.warn('[mcp] readMcpConfigForWorkspace failed:', e);
    return null;
  }
}
```

Note: the legacy `notifyMcpAccountAdded(accountId, bearer)` is removed (no callers will remain after Step 2). `notifyMcpAccountRemoved(accountId)` still maps to `mcp_remove_account_token` — kept, called from `signOut` and `AccountManager.remove`.

- [ ] **Step 2: Remove `notifyMcpAccountAdded` call from `AccountManager.bootstrap()` and `AccountManager.add()`**

In `src/lib/accounts/account-manager.ts`:

- Bootstrap: remove the loop that calls `notifyMcpAccountAdded` for each account. Workspaces own bearer registration; `WorkspaceManager.bootstrap()` (called from `syncOnLogin`) handles it per workspace.
- Add: drop the `notifyMcpAccountAdded` call after `secureSet(accountKeys.mcpToken(...))`. Also drop the legacy `secureSet(accountKeys.mcpToken(input.id), generateMcpToken())` — the per-account mcp_token is no longer the bearer surface. (Confirm during execution that no other code still reads it; the M3 `<accountId>-config.json` writer is gone in Phase H.)

Also remove the local `generateMcpToken()` function (now lives in `src/lib/workspaces/mcp-token.ts` as `generateWorkspaceMcpToken`).

Update the import block:

```ts
import {
  pushMcpSupabaseConfig,
  notifyMcpAccountRemoved,   // kept — still called from signOut + remove
} from '@/lib/mcp';
```

- [ ] **Step 3: Type-check + tests**

```bash
npm run build
npm run test
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/mcp/index.ts src/lib/accounts/account-manager.ts
git commit -m "$(cat <<'EOF'
feat(mcp): workspace-aware wrappers; drop account-level bearer registration

- notifyMcpWorkspaceAdded/Removed wrappers around mcp_register_bearer /
  mcp_revoke_bearer
- readMcpConfigForWorkspace consumes the renamed mcp_read_workspace_config
  Tauri command
- AccountManager no longer mints or registers account-level mcp_tokens;
  WorkspaceManager.bootstrap() owns the per-workspace bearer surface

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase J — WorkspaceSwitcher UI

This phase ships the header chip + dropdown. Mirrors `AccountSwitcher.tsx` in structure but consumes `useWorkspacesStore` and `getWorkspaceManager`.

### Task J1: `WorkspaceSwitcher.tsx`

**Files:**
- Create: `src/components/WorkspaceSwitcher.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/WorkspaceSwitcher.tsx
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Plus, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { WorkspaceManagerDialog } from '@/components/WorkspaceManagerDialog';

export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);

  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerMode, setManagerMode] = useState<'manage' | 'create'>('manage');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const current = workspaces.find((w) => w.id === currentWorkspaceId);
  if (!current) return null; // pre-bootstrap; render nothing rather than a flicker

  const handleSwitch = async (id: string) => {
    if (id === currentWorkspaceId) { setOpen(false); return; }
    try {
      await getWorkspaceManager().switchWorkspace(id);
      useWorkspacesStore.getState().setCurrentWorkspaceId(id);
      setOpen(false);
    } catch (err: any) {
      toast.error(t('workspaces.switch_failed', { defaultValue: 'Failed to switch workspace' }));
      console.error('[WorkspaceSwitcher] switch failed:', err);
    }
  };

  const openManager = (mode: 'manage' | 'create') => {
    setManagerMode(mode);
    setOpen(false);
    setManagerOpen(true);
  };

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={t('workspaces.switch_tooltip', { defaultValue: 'Switch workspace' })}
        >
          <span className="max-w-[140px] truncate">{current.name}</span>
          <ChevronDown size={14} />
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 w-56 rounded-md border bg-popover text-popover-foreground shadow-md z-50">
            <div className="py-1">
              {workspaces.length === 1 && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('workspaces.only_one', { defaultValue: 'Only one workspace — add another to switch.' })}
                </div>
              )}
              {workspaces.map((ws) => {
                const isCurrent = ws.id === currentWorkspaceId;
                return (
                  <button
                    key={ws.id}
                    onClick={() => handleSwitch(ws.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-muted transition-colors"
                  >
                    <div className="w-4 flex-shrink-0">
                      {isCurrent && <Check size={12} className="text-primary" />}
                    </div>
                    <span className={`flex-1 truncate ${isCurrent ? 'font-medium' : 'text-muted-foreground'}`}>
                      {ws.name}
                    </span>
                    {ws.isDefault && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t('workspaces.default_badge', { defaultValue: 'Default' })}
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="border-t my-1" />
              <button
                onClick={() => openManager('create')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <Plus size={12} />
                {t('workspaces.add', { defaultValue: 'Add workspace' })}
              </button>
              <button
                onClick={() => openManager('manage')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <Settings size={12} />
                {t('workspaces.manage', { defaultValue: 'Manage workspaces' })}
              </button>
            </div>
          </div>
        )}
      </div>

      <WorkspaceManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        initialMode={managerMode}
      />
    </>
  );
}
```

- [ ] **Step 2: Wire into `Layout.tsx`**

Update `src/components/Layout.tsx`. Insert `<WorkspaceSwitcher />` to the LEFT of `<UserMenu />`:

```tsx
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
// ...
<div className="flex items-center gap-1">
  <WorkspaceSwitcher />
  <UserMenu />
</div>
```

Replace the existing `<UserMenu />` line (currently line 54).

- [ ] **Step 3: Type-check**

```bash
npm run build
```

This will fail temporarily because `WorkspaceManagerDialog` doesn't exist yet — that's Phase K. To unblock the build, create a stub:

```tsx
// src/components/WorkspaceManagerDialog.tsx — stub, Phase K fills in
export function WorkspaceManagerDialog(_props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: 'manage' | 'create';
}) {
  return null;
}
```

Re-run `npm run build` — should pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/WorkspaceSwitcher.tsx src/components/WorkspaceManagerDialog.tsx src/components/Layout.tsx
git commit -m "feat(ui): WorkspaceSwitcher header chip + dropdown (manager stub for now)"
```

---

## Phase K — WorkspaceManagerDialog + delete sub-modal

This phase fills in the management dialog (Section 1: list with set-default + delete buttons; Section 2: create form; Section 3: MCP config per workspace) and the move-or-purge confirmation sub-modal.

### Task K1: `WorkspaceManagerDialog.tsx`

**Files:**
- Modify: `src/components/WorkspaceManagerDialog.tsx` (currently a stub)

- [ ] **Step 1: Replace the stub with the real implementation**

```tsx
// src/components/WorkspaceManagerDialog.tsx
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Trash2, Plus, Copy, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { readMcpConfigForWorkspace } from '@/lib/mcp';
import { WorkspaceDeleteDialog } from '@/components/WorkspaceDeleteDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: 'manage' | 'create';
}

export function WorkspaceManagerDialog({ open, onOpenChange, initialMode = 'manage' }: Props) {
  const { t } = useTranslation();
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [mcpConfigs, setMcpConfigs] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (open && initialMode === 'create') {
      // Focus-defer; rely on autoFocus on the input below.
    }
  }, [open, initialMode]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await getWorkspaceManager().add({ name: newName.trim(), isDefault: newIsDefault });
      // Trigger a realtime-equivalent refresh of the store. The realtime
      // sub will catch up shortly, but seed immediately for snappiness:
      const list = getWorkspaceManager().list();
      useWorkspacesStore.getState().applyRemoteWorkspaces(list.map((w) => ({
        id: w.id, userId: '', name: w.name, isDefault: w.isDefault,
        createdAt: '', updatedAt: '',
      })));
      setNewName('');
      setNewIsDefault(false);
      toast.success(t('workspaces.created', { defaultValue: 'Workspace created' }));
    } catch (err: any) {
      if (err?.message === 'duplicate_name') {
        toast.error(t('workspaces.duplicate_name', { defaultValue: 'A workspace with this name already exists.' }));
      } else {
        toast.error(t('workspaces.create_failed', { defaultValue: 'Failed to create workspace.' }));
        console.error(err);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!renameDraft.trim()) { setRenamingId(null); return; }
    setBusyId(id);
    try {
      await getWorkspaceManager().rename(id, renameDraft.trim());
    } catch (err: any) {
      if (err?.message === 'duplicate_name') {
        toast.error(t('workspaces.duplicate_name', { defaultValue: 'A workspace with this name already exists.' }));
      } else {
        toast.error(t('workspaces.rename_failed', { defaultValue: 'Failed to rename workspace.' }));
      }
    } finally {
      setBusyId(null);
      setRenamingId(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    setBusyId(id);
    try {
      await getWorkspaceManager().setDefault(id);
    } catch {
      toast.error(t('workspaces.set_default_failed', { defaultValue: 'Failed to set default.' }));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopyConfig = async (workspaceId: string) => {
    const accountId = getAccountManager().activeAccountId;
    if (!accountId) return;
    let cached = mcpConfigs[workspaceId];
    if (!cached) {
      const cfg = await readMcpConfigForWorkspace(accountId, workspaceId);
      cached = cfg ? JSON.stringify(cfg, null, 2) : null;
      setMcpConfigs((prev) => ({ ...prev, [workspaceId]: cached }));
    }
    if (cached) {
      await navigator.clipboard.writeText(cached);
      toast.success(t('workspaces.copied', { defaultValue: 'MCP config copied' }));
    } else {
      toast.error(t('workspaces.mcp_unavailable', { defaultValue: 'MCP server not running yet — try again in a moment.' }));
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('workspaces.manage_title', { defaultValue: 'Manage workspaces' })}</DialogTitle>
          </DialogHeader>

          {/* Section 1: list */}
          <div className="space-y-1 mt-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              {t('workspaces.current_section', { defaultValue: 'Current workspaces' })}
            </p>
            {workspaces.map((ws) => {
              const isOnlyOne = workspaces.length === 1;
              const canDelete = !isOnlyOne && !ws.isDefault;
              const isRenaming = renamingId === ws.id;
              return (
                <div key={ws.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted">
                  {isRenaming ? (
                    <Input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => handleRename(ws.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(ws.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="h-7 text-sm flex-1"
                    />
                  ) : (
                    <span
                      className="flex-1 text-sm cursor-text"
                      onClick={() => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
                    >
                      {ws.name}
                    </span>
                  )}
                  {ws.isDefault && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      {t('workspaces.default_badge', { defaultValue: 'Default' })}
                    </span>
                  )}
                  {!ws.isDefault && (
                    <button
                      onClick={() => handleSetDefault(ws.id)}
                      disabled={busyId === ws.id}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {busyId === ws.id ? <Loader2 size={12} className="animate-spin" /> : t('workspaces.set_default', { defaultValue: 'Set as default' })}
                    </button>
                  )}
                  <button
                    onClick={() => setDeleteTarget(ws.id)}
                    disabled={!canDelete}
                    className="p-1 rounded hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                    title={!canDelete ? t('workspaces.cannot_delete_default', { defaultValue: 'Cannot delete the default or the last workspace.' }) : t('workspaces.delete', { defaultValue: 'Delete' })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Section 2: create */}
          <div className="border-t pt-3 mt-3 space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('workspaces.create_section', { defaultValue: 'Create workspace' })}
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('workspaces.create_placeholder', { defaultValue: 'Name…' })}
                className="h-8 text-sm flex-1"
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                autoFocus={initialMode === 'create'}
              />
              <Label className="flex items-center gap-1 text-xs">
                <Switch checked={newIsDefault} onCheckedChange={setNewIsDefault} />
                {t('workspaces.set_default', { defaultValue: 'Set as default' })}
              </Label>
              <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
                {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              </Button>
            </div>
          </div>

          {/* Section 3: MCP configs */}
          <div className="border-t pt-3 mt-3">
            <button
              onClick={() => setMcpExpanded(!mcpExpanded)}
              className="text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              {mcpExpanded
                ? t('workspaces.mcp_hide', { defaultValue: '▾ Hide MCP configs' })
                : t('workspaces.mcp_show', { defaultValue: '▸ Show MCP configs' })}
            </button>
            {mcpExpanded && (
              <div className="mt-2 space-y-1">
                {workspaces.map((ws) => (
                  <div key={ws.id} className="flex items-center justify-between px-2 py-1.5 rounded border text-xs">
                    <span className="truncate">{ws.name}</span>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1" onClick={() => handleCopyConfig(ws.id)}>
                      <Copy size={11} />
                      {t('workspaces.copy_config', { defaultValue: 'Copy MCP config' })}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <WorkspaceDeleteDialog
        open={deleteTarget !== null}
        workspaceId={deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
      />
    </>
  );
}
```

### Task K2: `WorkspaceDeleteDialog.tsx`

**Files:**
- Create: `src/components/WorkspaceDeleteDialog.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/WorkspaceDeleteDialog.tsx
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { usePlannerStore } from '@/stores/planner-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';

interface Props {
  open: boolean;
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceDeleteDialog({ open, workspaceId, onOpenChange }: Props) {
  const { t } = useTranslation();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const allProjects = usePlannerStore((s) => s.allProjects);

  const target = workspaces.find((w) => w.id === workspaceId);
  const others = workspaces.filter((w) => w.id !== workspaceId);
  const defaultOther = useMemo(
    () => others.find((w) => w.isDefault)?.id ?? others[0]?.id ?? null,
    [others],
  );

  const projectsInTarget = allProjects.filter((p) => p.workspaceId === workspaceId);

  const [mode, setMode] = useState<'move' | 'purge' | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(defaultOther);
  const [busy, setBusy] = useState(false);

  if (!target) return null;

  const handleConfirm = async () => {
    if (!mode || !workspaceId) return;
    setBusy(true);
    try {
      if (mode === 'move') {
        if (!moveTarget) {
          toast.error(t('workspaces.pick_move_target', { defaultValue: 'Pick a target workspace.' }));
          setBusy(false);
          return;
        }
        await getWorkspaceManager().remove(workspaceId, { moveTargetWorkspaceId: moveTarget });
        toast.success(t('workspaces.deleted_moved', {
          defaultValue: 'Workspace deleted; projects moved.',
        }));
      } else {
        // Purge: delete every project under the workspace first, then remove.
        for (const p of projectsInTarget) {
          await usePlannerStore.getState().deleteProject(p.name);
        }
        await getWorkspaceManager().remove(workspaceId, { purge: true });
        toast.success(t('workspaces.deleted_purged', {
          defaultValue: 'Workspace and its projects deleted.',
        }));
      }
      onOpenChange(false);
    } catch (err: any) {
      if (err?.message === 'has_projects') {
        toast.error(t('workspaces.delete_has_projects', {
          defaultValue: 'Some projects could not be moved — workspace not deleted. See logs.',
        }));
      } else {
        toast.error(t('workspaces.delete_failed', { defaultValue: 'Failed to delete workspace.' }));
      }
      console.error('[WorkspaceDeleteDialog] failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('workspaces.delete_title', { defaultValue: 'Delete workspace "{{name}}"?', name: target.name })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('workspaces.delete_desc', {
            defaultValue: 'This workspace has {{count}} project(s). What should happen to them?',
            count: projectsInTarget.length,
          })}
        </p>
        <div className="space-y-2 mt-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'move'}
              onChange={() => setMode('move')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm font-medium">
                {t('workspaces.delete_move_label', { defaultValue: 'Move all projects to' })}
              </div>
              {mode === 'move' && (
                <select
                  value={moveTarget ?? ''}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  className="mt-1 text-xs border rounded px-2 py-1 bg-background"
                >
                  {others.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
              )}
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'purge'}
              onChange={() => setMode('purge')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-destructive">
                {t('workspaces.delete_purge_label', { defaultValue: 'Delete projects too' })}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('workspaces.delete_purge_warning', {
                  defaultValue: 'This permanently deletes {{count}} project(s) and every subject, version, and comment under them. This cannot be undone.',
                  count: projectsInTarget.length,
                })}
              </div>
            </div>
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={mode === null || busy}
          >
            {busy ? t('workspaces.deleting', { defaultValue: 'Deleting…' }) : t('workspaces.confirm_delete', { defaultValue: 'Delete' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/WorkspaceManagerDialog.tsx src/components/WorkspaceDeleteDialog.tsx
git commit -m "feat(ui): WorkspaceManagerDialog + WorkspaceDeleteDialog (create/rename/set-default/delete)"
```

---

## Phase L — Move project to workspace (planner sidebar)

This phase adds a kebab menu on each project row in the planner sidebar. Selecting "Move to workspace ▸ <other workspace>" issues a single FK update via `usePlannerStore.moveProjectToWorkspace`.

### Task L1: `MoveProjectToWorkspaceMenu.tsx`

**Files:**
- Create: `src/components/MoveProjectToWorkspaceMenu.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/MoveProjectToWorkspaceMenu.tsx
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreVertical, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { usePlannerStore } from '@/stores/planner-store';

interface Props {
  projectName: string;
}

export function MoveProjectToWorkspaceMenu({ projectName }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const others = workspaces.filter((w) => w.id !== currentWorkspaceId);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSubmenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleMove = async (targetWsId: string, targetName: string) => {
    setOpen(false);
    setSubmenuOpen(false);
    const prevWsId = currentWorkspaceId;
    try {
      await usePlannerStore.getState().moveProjectToWorkspace(projectName, targetWsId);
      toast.success(
        t('workspaces.moved_toast', { defaultValue: 'Moved {{project}} to {{ws}}', project: projectName, ws: targetName }),
        {
          action: prevWsId
            ? {
                label: t('common.undo', { defaultValue: 'Undo' }),
                onClick: () => { usePlannerStore.getState().moveProjectToWorkspace(projectName, prevWsId); },
              }
            : undefined,
        },
      );
    } catch (err) {
      toast.error(t('workspaces.move_failed', { defaultValue: 'Failed to move project.' }));
      console.error(err);
    }
  };

  if (others.length === 0) return null; // single-workspace account — nothing to do

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity"
        title={t('workspaces.move_tooltip', { defaultValue: 'Move project to workspace' })}
      >
        <MoreVertical size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 rounded-md border bg-popover text-popover-foreground shadow-md z-50">
          <button
            onClick={() => setSubmenuOpen(!submenuOpen)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
          >
            <FolderInput size={12} />
            {t('workspaces.move_to', { defaultValue: 'Move to workspace…' })}
          </button>
          {submenuOpen && (
            <div className="border-t">
              {others.map((w) => (
                <button
                  key={w.id}
                  onClick={() => handleMove(w.id, w.name)}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted truncate"
                >
                  {w.name}{w.isDefault ? ' · default' : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

### Task L2: Wire into `PlannerTab.tsx`

**Files:**
- Modify: `src/components/PlannerTab.tsx`

- [ ] **Step 1: Add the kebab next to each project row**

Locate the project list rendering in `PlannerTab.tsx` (search for `projects.map`). Wrap the row in a `group` class so the kebab fades in on hover. Add `<MoveProjectToWorkspaceMenu projectName={p.name} />` to the right side of the row.

The exact JSX change depends on the current PlannerTab structure — the implementing subagent reads the file and identifies the project-row JSX, then injects the kebab as a new flex child between the project name and any existing delete/options buttons.

- [ ] **Step 2: Type-check**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MoveProjectToWorkspaceMenu.tsx src/components/PlannerTab.tsx
git commit -m "feat(ui): move-project-to-workspace kebab in planner sidebar"
```

---

## Phase M — i18n keys + smoke checklist

### Task M1: Add workspace keys to both locale files

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/pt-BR.json`

- [ ] **Step 1: Insert a new `workspaces` top-level namespace**

Both locale files should include the following block. English values are the ones used as `defaultValue` throughout Phases J–L; this step canonicalizes them. The implementing subagent should replace every `defaultValue` fallback in components with `t('workspaces.<key>')` after this step lands.

```json
"workspaces": {
  "switch_tooltip": "Switch workspace",
  "switch_failed": "Failed to switch workspace",
  "only_one": "Only one workspace — add another to switch.",
  "default_badge": "Default",
  "add": "Add workspace",
  "manage": "Manage workspaces",
  "manage_title": "Manage workspaces",
  "current_section": "Current workspaces",
  "create_section": "Create workspace",
  "create_placeholder": "Name…",
  "created": "Workspace created",
  "duplicate_name": "A workspace with this name already exists.",
  "create_failed": "Failed to create workspace.",
  "rename_failed": "Failed to rename workspace.",
  "set_default": "Set as default",
  "set_default_failed": "Failed to set default.",
  "delete": "Delete",
  "cannot_delete_default": "Cannot delete the default or the last workspace.",
  "mcp_show": "▸ Show MCP configs",
  "mcp_hide": "▾ Hide MCP configs",
  "copy_config": "Copy MCP config",
  "copied": "MCP config copied",
  "mcp_unavailable": "MCP server not running yet — try again in a moment.",
  "delete_title": "Delete workspace \"{{name}}\"?",
  "delete_desc": "This workspace has {{count}} project(s). What should happen to them?",
  "delete_move_label": "Move all projects to",
  "delete_purge_label": "Delete projects too",
  "delete_purge_warning": "This permanently deletes {{count}} project(s) and every subject, version, and comment under them. This cannot be undone.",
  "delete_has_projects": "Some projects could not be moved — workspace not deleted. See logs.",
  "delete_failed": "Failed to delete workspace.",
  "deleted_moved": "Workspace deleted; projects moved.",
  "deleted_purged": "Workspace and its projects deleted.",
  "deleting": "Deleting…",
  "confirm_delete": "Delete",
  "pick_move_target": "Pick a target workspace.",
  "move_tooltip": "Move project to workspace",
  "move_to": "Move to workspace…",
  "moved_toast": "Moved {{project}} to {{ws}}",
  "move_failed": "Failed to move project."
}
```

For pt-BR, translate naturally. Sample:

```json
"workspaces": {
  "switch_tooltip": "Trocar workspace",
  "switch_failed": "Falha ao trocar de workspace",
  "only_one": "Apenas uma workspace — adicione outra para trocar.",
  "default_badge": "Padrão",
  "add": "Adicionar workspace",
  "manage": "Gerenciar workspaces",
  "manage_title": "Gerenciar workspaces",
  ...
}
```

- [ ] **Step 2: Replace `defaultValue` fallbacks**

In `WorkspaceSwitcher.tsx`, `WorkspaceManagerDialog.tsx`, `WorkspaceDeleteDialog.tsx`, `MoveProjectToWorkspaceMenu.tsx`, remove every `{ defaultValue: '...' }` second-arg-to-`t()` once the keys exist — `t('workspaces.xxx')` is enough.

- [ ] **Step 3: Type-check**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en.json src/i18n/locales/pt-BR.json src/components/WorkspaceSwitcher.tsx src/components/WorkspaceManagerDialog.tsx src/components/WorkspaceDeleteDialog.tsx src/components/MoveProjectToWorkspaceMenu.tsx
git commit -m "feat(i18n): workspaces.* keys + drop defaultValue fallbacks"
```

### Task M2: Smoke checklist (manual)

Before declaring the workspaces feature done, manually exercise the following flow. Document any defects as separate commits or follow-up issues — do not declare complete with broken paths.

- [ ] **1. Cold start with existing data**
  - Run `npm run tauri dev` on a profile that has projects from before this feature.
  - Verify the migration banner does NOT appear (migration is silent in `syncOnLogin`).
  - Verify the `WorkspaceSwitcher` shows "User's workspace" (the auto-created default).
  - Verify every existing project still appears in PlannerTab.
  - Verify `<appLocalData>/notter-ai/<accountId>/<defaultWorkspaceId>/cache/` and `.../exports/` exist; the old `<accountId>/cache/` and `<accountId>/exports/` no longer exist.

- [ ] **2. Add a workspace**
  - Open WorkspaceSwitcher → "Add workspace" → name "Work" → Create.
  - Verify the dropdown now lists "User's workspace" + "Work".
  - Verify `<appLocalData>/notter-ai/mcp/<accountId>-<workspaceId>-config.json` exists for both workspaces.

- [ ] **3. Switch workspaces**
  - Click "Work" in the dropdown.
  - Verify PlannerTab clears (no projects yet in "Work").
  - Switch back to "User's workspace" — projects reappear.

- [ ] **4. Move a project**
  - Hover a project row → click kebab → "Move to workspace ▸ Work".
  - Verify the project disappears from "User's workspace".
  - Switch to "Work" — project appears with its subjects intact.
  - Click "Undo" on the toast — project returns to "User's workspace".

- [ ] **5. Set a different workspace as default**
  - Open WorkspaceManagerDialog → click "Set as default" next to "Work".
  - Verify the "Default" badge moves to "Work".
  - Sign out + sign in — `currentWorkspaceId` seeds from "Work" (now the default).

- [ ] **6. Delete with move**
  - Add a third workspace "Trash" → move one project into it → open WorkspaceManagerDialog → click Trash icon next to "Trash".
  - In the sub-modal, pick "Move all projects to User's workspace" → Delete.
  - Verify the project ends up in "User's workspace"; "Trash" is gone.

- [ ] **7. Delete with purge**
  - Add another workspace "Burn" → move/create a project + subject under it → delete with "Delete projects too".
  - Verify the project, subjects, versions, and comments are all gone from Supabase (check via SQL or via signing in on another device).

- [ ] **8. MCP isolation**
  - Open WorkspaceManagerDialog → "Show MCP configs" → Copy MCP config for "Work".
  - Run `curl -X POST http://127.0.0.1:5xxxx/mcp -H "Authorization: Bearer notter_ws_xxx" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"list_subjects","params":{}}'`.
  - Verify the response contains ONLY subjects from projects belonging to "Work".
  - Repeat with "User's workspace" bearer — different subject list.

- [ ] **9. Account-switch isolation**
  - Add a second Supabase account → sign in to it → verify it has its own default workspace (auto-created since this account has no projects).
  - Verify the WorkspaceSwitcher shows ONLY this account's workspaces.
  - Switch back to account-1 — workspaces flip back.

- [ ] **10. Duplicate-name validation**
  - In WorkspaceManagerDialog, try to create a second "Work" workspace.
  - Verify toast surfaces `workspaces.duplicate_name` and the row is not added.
  - Try to rename "User's workspace" to "Work" — same error.

If any step fails, file the defect, fix in a new commit, and re-run the checklist.

- [ ] **Commit the smoke-pass marker (after every step is green)**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
chore(workspaces): manual smoke checklist complete

All 10 scenarios in Phase M exercised end-to-end. Multi-account
isolation verified. MCP bearer scoping verified. Delete-with-move and
delete-with-purge both clean. Move-project undo flow works.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase N — End-to-end verification

### Task N1: Full test suite + build

- [ ] **Step 1: Run vitest**

```bash
npm run test
```

Expected: every existing test plus the new workspace tests pass. Any failures must be fixed before declaring done.

- [ ] **Step 2: Type-check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Rust check + cargo test**

```bash
cd src-tauri && cargo check && cargo test
```

- [ ] **Step 4: Tauri dev smoke**

Run `npm run tauri dev` and exercise the WorkspaceSwitcher dropdown, manager dialog, delete sub-modal, and move-project kebab. Verify there are no console errors and no toast errors during normal flows.

- [ ] **Step 5: Final commit (no code changes)**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
chore(workspaces): end-to-end verification complete

Vitest green, npm run build green, cargo test green, manual smoke
checklist green. Workspaces feature ready to merge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Out of scope (matches spec §10)

- **Sharing workspaces between accounts.** Phase 3+ collaboration territory. RLS as written enforces single-owner.
- **Workspace-level permissions / roles.** Owner has full access; no viewer/editor model.
- **Workspace-level theme / preferences.** `user_preferences` and `agent_profiles` stay account-wide.
- **Local-only workspaces.** Every workspace is a Supabase row first.
- **`subjects` PK change to include `workspace_id`.** Scoping via the `projects` FK chain is the Phase 1 mechanism.
- **`projects` PK change to include `workspace_id`.** Same-named projects across workspaces stay forbidden within an account.
- **CLI awareness of workspaces.** The CLI sees only bearer-visible projects/subjects; no new MCP tool argument.

---

## Open items expected to surface during execution

Documented from spec §11 + plan-author review:

1. **`react-resizable-panels` v4 percentage strings.** If the implementing subagent touches any layout, remember the v4 API takes strings like `"30%"`, not numbers like `30`. This is unrelated to workspaces per se but is the kind of subtle regression that easily creeps in.
2. **`UNIQUE (user_id, name)` race on simultaneous create.** Two devices creating workspaces with the same name in the same account would lose the race; one INSERT returns `23505`. The plan surfaces this as `workspaces.duplicate_name` toast.
3. **Optimistic vs. realtime ordering.** `WorkspaceManager.add()` updates the local list immediately AND pushes to Supabase. The realtime channel will also fire a postgres_changes event that re-applies the list to `useWorkspacesStore.applyRemoteWorkspaces`. Both effects converge to the same state, but during execution be careful not to double-apply (`add()` returns first → store has the row → realtime fires → store re-receives the row, no change). If anything looks twitchy, debounce the realtime apply or de-dupe in the apply function. Default: no de-dupe needed — the realtime apply is idempotent.
4. **Workspace-delete on the default row.** Spec §6.3 says the delete button is disabled on the default row when other workspaces exist. The Phase K dialog implements this via the `canDelete` boolean. Double-check that the "Set as default" affordance is reachable for the user to demote first — confirmed in `WorkspaceManagerDialog.tsx` (inline button on every non-default row).
5. **Per-workspace MCP config caching.** The `WorkspaceManagerDialog` caches `mcpConfigs[workspaceId]` lazily on first click. If the user rotates a token via a hypothetical future "Rotate token" button, the cache must be invalidated. Phase 1 has no rotate-token button; if added, surface it explicitly.
6. **Workspace badge on project rows.** Spec §4.3 mentions an optional small badge if same-named projects across workspaces exist. The Phase L commit can add this as a small `<span>` next to the project name when `workspaces.length > 1`. Implementing subagent decides if the visual weight is worth it; the data is already in `useWorkspacesStore`.
7. **`AccountManager.bootstrap()` still calls `notifyMcpAccountAdded` in the existing code.** Phase I removes that loop. Be careful not to introduce a regression — the old loop pushed account-level tokens to Rust; the new flow pushes per-workspace tokens via `WorkspaceManager.bootstrap()` (which runs in `syncOnLogin`). The Rust server has no token map entries until `syncOnLogin` runs, which means MCP requests before sign-in always 401 with "unknown token". This is correct behavior.

---

## Self-review notes

- **Strictly additive on top of `main`.** No table is dropped. No existing Supabase column is renamed. `projects.workspace_id` is added with a temporary default to satisfy NOT NULL during the backfill, then the default is dropped. The migration is reversible if needed via `alter table projects drop column workspace_id; drop table workspaces;` (not part of the deliverable, but recorded).
- **One thing I considered but rejected:** changing `subjects` PK to include `workspace_id`. Doing so would let users have a "blog" project in two different workspaces simultaneously. The spec defers this explicitly (§4.3 + §2b decision row 6). Implementing it later is a single schema migration; implementing it now would balloon every subject query.
- **Phase H's `assert_subject_in_workspace` cost.** Every subject-keyed tool now makes one extra Supabase call. For Phase 1 CLI workloads (Claude Code, Codex — handful of requests per session) this is fine; if it becomes a hot path, cache `workspace_project_names` per `AuthContext` for the request's lifetime.
- **Token revocation race (spec §2b row 2).** Middleware checks the bearer at request entry; in-flight handlers hold the `AuthContext` value they captured at entry. No locking needed. A revoked token's already-started request will complete; the next request 401s. The plan's Phase H confirms this design — no special code required.
- **Rust map shape change (`token_to_account` → `token_to_owner`).** The implementing subagent for Phase H must update every reference. The plan calls out the existing tests under `src-tauri/src/mcp/__tests__/` (if any) — verify via `grep -rn "token_to_account" src-tauri/src` before commit. Same for any front-end TS that may still reference the old account-token map shape (none expected — the front-end only invokes Tauri commands).
- **No `uuid` package introduced.** `crypto.randomUUID()` is used in `workspace-manager.ts` and `fs-migration-v2.ts` (the sentinel JSON doesn't need UUIDs; the manager generates one for each new workspace).
- **Single source of truth per workspace.** Bearer lives ONLY in the Tauri secure store. The in-memory Rust map is rebuilt on every boot from the front-end's `notifyMcpWorkspaceAdded` calls during `WorkspaceManager.bootstrap()`. The per-workspace config file is a synthesis written by the Rust side; it is not authoritative.
- **No backcompat shim for the M3 `<accountId>-config.json`.** Locked decision (§2b row 1). The Phase H writer deletes any orphan files matching `<id>-config.json` (single dash, no workspace component). Clean break.

---

## Smoke test checklist (Phase N)

Run after Phase M lands, before the Phase N final-verification commit. Every step below must pass in a fresh `npm run tauri dev` session against a real Supabase project. File any defect as a separate commit (or follow-up issue) and re-run from the top. The pre-existing Task M2 checklist above remains the canonical end-to-end pass; this section is the condensed operator checklist suitable for the final Phase N gate.

- [ ] **Boot.** Restart `npm run tauri dev`. After sign-in, verify the default workspace appears in the header `WorkspaceSwitcher`. No console errors. The dropdown opens cleanly and shows the single default row with the `Default` badge.

- [ ] **Create.** Open Manage dialog → "Create workspace" → type `Work` → Enter. Verify (a) toast `Workspace created`, (b) the new workspace appears in both the manager list and the header switcher dropdown.

- [ ] **Switch.** From the header switcher, switch between the default workspace and `Work`. Verify the planner project list filters correctly: default shows all migrated projects, `Work` is empty initially. Switching back restores the default list. No flicker.

- [ ] **Create project in Work.** With `Work` active, create a new project (e.g., `work-proj-1`). Verify the project appears in the sidebar under `Work` only. Sanity-check the Supabase `projects` row: `workspace_id` equals the `Work` workspace id.

- [ ] **Move project.** With the default workspace active, hover a project row → click the kebab → `Move to workspace ▸ Work`. Verify (a) toast `Moved {project} to Work` with an `Undo` action, (b) the project disappears from the default sidebar and appears in the `Work` sidebar after switching. Click `Undo` on the toast → the project returns to the default workspace.

- [ ] **Rename.** In Manage dialog, click the `Work` name → rename to `Trabalho` → Enter. Verify the row updates everywhere (manager, header dropdown). Then try renaming `Trabalho` to the default workspace's exact name → verify the `A workspace with this name already exists.` toast fires and the row does not change.

- [ ] **Set as default.** In Manage dialog, click `Set as default` next to `Trabalho`. Verify the `Default` badge moves from the original default row to `Trabalho`. Sign out + sign in to confirm `currentWorkspaceId` re-seeds from `Trabalho`.

- [ ] **Delete — move path.** In Manage dialog, click the trash icon next to the now-non-default original workspace. In the sub-modal, pick `Move all projects to ▸ Trabalho` → Delete. Verify the projects appear under `Trabalho` after the dialog closes, and the original workspace is gone from the list.

- [ ] **Delete — purge path.** Create a throwaway workspace `Burn` → create one project in it (with a subject + version, if quick). In Manage dialog, click the trash icon on `Burn` → choose `Delete projects too` → confirm. Verify the workspace, project, subject, version, and any comments are gone from Supabase (SQL: `select count(*) from projects where workspace_id = '<burn id>'` returns 0; same for `subjects`).

- [ ] **MCP token isolation.** In Manage dialog → `Show MCP configs` → `Copy MCP config` for `Trabalho`. Run the curl from Task M2 step 8 with the copied bearer; verify the `list_subjects` response contains only subjects from projects under `Trabalho`. Repeat with the other workspace's bearer — the subject lists must not overlap.

- [ ] **Account switch.** Add a second Supabase account → switch to it → verify the `WorkspaceSwitcher` shows only that account's workspaces (auto-created default if first sign-in). Switch back to the original account → the original account's workspace list returns. No cross-account leakage.

If every checkbox above is green, commit the empty-marker `chore(workspaces): manual smoke checklist complete` per Task M2, then proceed to Phase N's `npm run test` + `npm run build` + `cargo check` gate.
