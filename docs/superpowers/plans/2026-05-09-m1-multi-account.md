# M1 — Multi-Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land M1 of the Phase 1 pivot — Notter-AI gains a multi-user fast switcher (separate Supabase users, in-place session swap), a per-account local data layout (with idempotent migration from the legacy single-account layout), and the `SyncedStore` primitive that M2's `PlanStore` will build on.

**Architecture:** Three concentric rings layered bottom-up so each lands shippable on its own:
1. **SyncedStore primitive** (PATHFINDER System 1) — extract the duplicated `debounced sync + push + realtime listener + boot-singleton` patterns into 5 named exports in `src/lib/synced-store.ts`. Migrate the 5 existing Zustand stores onto it. No behavior change visible to the user; closes the destructive delete-then-insert race window flagged in `auth-sync.md`.
2. **AccountManager + secure store** — Rust `keyring`-backed secure store exposed via Tauri commands; `AccountManager` class owning N Supabase sessions; custom Supabase storage adapter that scopes the auth session to the active account; per-account `mcp_token` generated and persisted (consumer in M3).
3. **Per-store `reset()` + fs/localStorage namespacing + `AccountSwitcher` UI** — every store gains a `reset()`, fs paths and localStorage keys carry the active accountId, a sentinel-file-gated migration moves legacy data into the per-account layout on first launch, and the user can switch accounts via the existing `UserMenu`.

**Tech Stack:** TypeScript / React / Zustand / Vitest / `@supabase/supabase-js` v2 / Tauri 2 (`@tauri-apps/plugin-fs`, `@tauri-apps/api`) / Rust `keyring` crate (OS keychain: Windows Credential Manager / macOS Keychain / libsecret).

**Spec references:** `docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md` §3 (decisions), §4 (architecture), §5.2–5.4 (storage layout + switch flow), §7 M1 (scope), §13 (Codex review log). Pathfinder hard prereq: `PATHFINDER-2026-05-09/03-unified-proposal.md` System 1 + `04-handoff-prompts.md` block 1.

**Out of scope (do not drift):** `PlanStore`, `plan_versions` schema, Rust MCP server, Monaco editor, import/export, deletion of `src/lib/planning/`. Legacy `actions-store`, `notter-mcp-server/` (Node), `executor`, `terminal-panes`, `agent-chat`, `board-tasks`, `ai-providers`, `auto-updater` stay intact and untouched.

---

## File Structure

### New files
- `src/lib/synced-store.ts` — 5 named exports (`upsertUserRows`, `deleteUserRow`, `subscribeUserTable`, `makeDebouncedSync`, `runOnce`).
- `src/lib/__tests__/synced-store.test.ts`
- `src/lib/accounts/types.ts` — `AccountSummary`, `AccountSecrets`, `AccountIndex` types.
- `src/lib/accounts/secure-store.ts` — TS wrapper over Tauri `secure_*` commands.
- `src/lib/accounts/account-storage.ts` — fs IO for `accounts/index.json`, `accounts/active.json`.
- `src/lib/accounts/fs-migration.ts` — sentinel-gated legacy → per-account migration.
- `src/lib/accounts/supabase-storage-adapter.ts` — custom `Storage` impl that namespaces the Supabase auth session by active account.
- `src/lib/accounts/account-manager.ts` — `AccountManager` class (singleton).
- `src/lib/accounts/store-registry.ts` — registry of `reset()`-bearing stores called during account switch.
- `src/lib/accounts/__tests__/account-manager.test.ts`
- `src/lib/accounts/__tests__/account-storage.test.ts`
- `src/lib/accounts/__tests__/fs-migration.test.ts`
- `src/lib/accounts/__tests__/supabase-storage-adapter.test.ts`
- `src/lib/accounts/__tests__/secure-store.test.ts`
- `src/components/AccountSwitcher.tsx` — dropdown rendered inside `UserMenu`.
- `src-tauri/src/secure_store.rs` — Rust module wrapping `keyring` crate; exposes `secure_set/get/delete/list_keys` Tauri commands.

### Modified files
- `src/lib/sync.ts` — replace `pushAgentProfiles`, `pushProjects`, `pushBoardTasks`, `pushActions` with thin wrappers around `upsertUserRows`; add `deleteUserRow` call sites where the old delete-then-insert assumed-delete semantics are needed.
- `src/lib/realtime.ts` — replace 5 listener bodies with `subscribeUserTable` calls.
- `src/lib/supabase.ts` — switch to custom `storage` adapter scoped to active account; wire token refresh broadcast (Tauri event for M3).
- `src/stores/actions-store.ts` — adopt `makeDebouncedSync`, `runOnce` for `bootExecutor`, add `reset()`.
- `src/stores/board-store.ts` — adopt `makeDebouncedSync`, add `reset()`, scope `NotterProjects/...` paths via active account.
- `src/stores/planner-store.ts` — same treatment; two `makeDebouncedSync` instances (projects + subjects).
- `src/stores/agents-store.ts` — same; gains `flush()`.
- `src/stores/app-store.ts` — same; gains `flush()`.
- `src/stores/auth-store.ts` — `signOut()` calls registry to reset all stores; `initialize()` defers session decisions to `AccountManager`.
- `src/components/UserMenu.tsx` — show active account email/avatar, embed `AccountSwitcher` dropdown for "Switch / Add account".
- `src/components/AuthDialog.tsx` — usable both for sign-in (no current account) and add-account (has accounts, want to add another). Add `mode: 'sign-in' | 'add-account'` prop.
- `src/App.tsx` — boot sequence is now: `await fsMigrationIfNeeded() → await accountManager.bootstrap() → await useAuthStore.getState().initialize()`. Window-close handler now flushes ALL synced stores (not just `actions-store`).
- `src-tauri/src/lib.rs` — register the `PtyManager` state alongside the new `SecureStoreState`; register the secure-store commands in the `invoke_handler`.
- `src-tauri/Cargo.toml` — add `keyring = "3"` dep.
- `src-tauri/capabilities/default.json` — no fs scope changes needed (still `$APPLOCALDATA/**`).
- `src/i18n/*.json` (both en + pt-BR) — new keys: `accounts.switch`, `accounts.add`, `accounts.remove`, `accounts.signed_in_as`, `accounts.session_expired`, `accounts.switch_failed`, `accounts.fs_migration_partial`, `accounts.confirm_remove`.

### Deleted files (only after successful migration is verified)
- None in M1. The old `pushXxx` functions in `sync.ts` are *replaced in place*, not deleted from a separate file. Their last call sites flip to the new primitive in the same task that introduces the wrapper.

### Phase order

| # | Phase | Scope | Lands |
|---|---|---|---|
| A | SyncedStore primitive | new module + tests | first; no UI change |
| B | Migrate stores onto SyncedStore | 5 stores + realtime + flush hook | per-store PRs possible |
| C | Secure store (Rust + TS) | keyring crate, Tauri commands, TS wrapper | independent |
| D | AccountManager core | types, fs IO, bootstrap, single-account compatible | depends on C |
| E | Custom Supabase storage adapter + auth-store rewire | scoped session + token broadcast | depends on D |
| F | Per-store `reset()` + path/key namespacing | each store knows the active account | depends on B + D |
| G | Filesystem migration (sentinel) | one-shot legacy → per-account move | depends on D |
| H | `AccountSwitcher` UI + add/switch flow | UserMenu + AuthDialog mode | depends on D + E + F |
| I | End-to-end verification | manual + scripted smoke | last |

---

## Phase A — `SyncedStore` primitive

This phase introduces the new module with TDD. No call sites are migrated yet — only the primitive lands and is unit-tested.

### Task A1: Define the public surface and write failing tests

**Files:**
- Create: `src/lib/synced-store.ts`
- Create: `src/lib/__tests__/synced-store.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// src/lib/__tests__/synced-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  upsertUserRows,
  deleteUserRow,
  makeDebouncedSync,
  runOnce,
  // subscribeUserTable is exercised via realtime tests later
} from '@/lib/synced-store';

vi.mock('@/lib/supabase', () => {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn().mockReturnThis();
  const eq = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ upsert, delete: del, eq }));
  return {
    supabase: { from },
    isSupabaseConfigured: true,
  };
});

describe('upsertUserRows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts rows keyed by (user_id, id) — never destructively deletes', async () => {
    const { supabase } = await import('@/lib/supabase');
    type Local = { id: string; name: string };
    type Row = { id: string; user_id: string; name: string };
    const toRow = (r: Local): Row => ({ id: r.id, user_id: 'u1', name: r.name });

    await upsertUserRows<Local, Row>('agent_profiles', 'u1', [{ id: 'p1', name: 'A' }], toRow);

    expect(supabase.from).toHaveBeenCalledWith('agent_profiles');
    const fromMock = (supabase.from as any).mock.results[0].value;
    expect(fromMock.upsert).toHaveBeenCalledWith(
      [{ id: 'p1', user_id: 'u1', name: 'A' }],
      { onConflict: 'user_id,id' },
    );
    expect(fromMock.delete).not.toHaveBeenCalled();
  });

  it('no-ops on empty rows', async () => {
    const { supabase } = await import('@/lib/supabase');
    await upsertUserRows('actions', 'u1', [], (x) => x);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('deleteUserRow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes a single row scoped by user_id and id', async () => {
    const { supabase } = await import('@/lib/supabase');
    await deleteUserRow('actions', 'u1', 'a1');
    expect(supabase.from).toHaveBeenCalledWith('actions');
  });
});

describe('makeDebouncedSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('coalesces rapid schedule() calls into one push after the delay', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const sync = makeDebouncedSync<{ count: number }>((_uid, p) => push(p), 100);
    // active-user lookup is mocked separately in the implementation; for now
    // the helper should accept an explicit (userId, payload) push signature.
    sync.schedule({ count: 1 });
    sync.schedule({ count: 2 });
    sync.schedule({ count: 3 });
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ count: 3 });
  });

  it('flush() forces immediate push and clears the timer', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const sync = makeDebouncedSync<number>((_uid, n) => push(n), 1000);
    sync.schedule(42);
    await sync.flush();
    expect(push).toHaveBeenCalledWith(42);
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(1); // not double-fired
  });

  it('flush() with no pending payload is a no-op', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const sync = makeDebouncedSync<number>((_uid, n) => push(n), 1000);
    await sync.flush();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('runOnce', () => {
  it('runs the function only once per key on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await runOnce('boot:test1', fn);
    await runOnce('boot:test1', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a failed attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    await expect(runOnce('boot:test2', fn)).rejects.toThrow('boom');
    await runOnce('boot:test2', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- synced-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/synced-store.ts` with implementations**

```ts
// src/lib/synced-store.ts
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth-store';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Upsert rows into a per-user table keyed by (user_id, id). Replaces the
 * destructive delete-then-insert pattern that previously created a window
 * where a concurrent reader could observe an empty table.
 */
export async function upsertUserRows<TLocal, TRow extends { id: string; user_id: string }>(
  table: string,
  userId: string,
  rows: TLocal[],
  toRow: (r: TLocal) => TRow,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  if (rows.length === 0) return;
  try {
    const mapped = rows.map(toRow);
    const { error } = await supabase
      .from(table)
      .upsert(mapped, { onConflict: 'user_id,id' });
    if (error) console.error(`[synced-store] upsert ${table} failed:`, error);
    // Note: explicit `userId` arg is used by the call site to construct toRow.
    void userId;
  } catch (e) {
    console.error(`[synced-store] upsert ${table} threw:`, e);
  }
}

/**
 * Explicit single-row delete. Required because upsertUserRows no longer
 * deletes server rows that disappeared locally — every store's local-delete
 * reducer must call this to propagate the deletion.
 */
export async function deleteUserRow(table: string, userId: string, id: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('user_id', userId)
      .eq('id', id);
    if (error) console.error(`[synced-store] delete ${table}:${id} failed:`, error);
  } catch (e) {
    console.error(`[synced-store] delete ${table}:${id} threw:`, e);
  }
}

/**
 * Subscribe to postgres_changes for a per-user table. The supplied
 * `refetchAndApply` is called with no arguments on every change event;
 * implementations re-fetch the full row set and apply it to the matching
 * Zustand store.
 */
export function subscribeUserTable(
  channel: RealtimeChannel,
  table: string,
  userId: string,
  refetchAndApply: () => Promise<void>,
): RealtimeChannel {
  return channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` },
    () => {
      refetchAndApply().catch((e) =>
        console.error(`[synced-store] refetch ${table} failed:`, e),
      );
    },
  );
}

/**
 * Debounced "schedule -> push" with a `flush()` for window-close handlers.
 * The callback receives the current active user id at fire time, not at
 * schedule time, so a payload scheduled before account-switch fires under
 * the new user (or no-ops if no user is active).
 */
export function makeDebouncedSync<T>(
  pushFn: (userId: string, payload: T) => Promise<void>,
  ms: number,
): { schedule(payload: T): void; flush(): Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  let hasPending = false;

  const fire = async () => {
    timer = null;
    if (!hasPending) return;
    const payload = pending as T;
    pending = null;
    hasPending = false;
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;
    try {
      await pushFn(userId, payload);
    } catch (e) {
      console.error('[synced-store] debounced push failed:', e);
    }
  };

  return {
    schedule(payload: T) {
      pending = payload;
      hasPending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void fire(); }, ms);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await fire();
    },
  };
}

/**
 * Run an async fn at most once per key. The flag flips AFTER successful
 * resolution, so a failed init can be retried by calling runOnce again with
 * the same key.
 */
const onceFlags = new Map<string, Promise<void>>();
export async function runOnce(key: string, fn: () => Promise<void>): Promise<void> {
  const existing = onceFlags.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      await fn();
    } catch (e) {
      onceFlags.delete(key); // allow retry
      throw e;
    }
  })();
  onceFlags.set(key, p);
  return p;
}

/**
 * Test-only: reset the runOnce key registry between tests.
 */
export function _resetRunOnceForTests(): void {
  onceFlags.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- synced-store`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/synced-store.ts src/lib/__tests__/synced-store.test.ts
git commit -m "feat(sync): add SyncedStore primitive (PATHFINDER System 1)"
```

---

## Phase B — Migrate stores onto SyncedStore

Each store migration is one task. Order is intentional: `actions-store` is most complex and validates the API; the rest follow the same shape.

### Task B1: Replace `sync.ts` push functions with `upsertUserRows` wrappers

The legacy `pushXxx` functions in `src/lib/sync.ts` are kept (so call sites don't have to flip yet) but their bodies are rewritten to use `upsertUserRows`. This is a behavior change: the destructive `delete().eq('user_id', userId)` is removed. To keep deletions propagating, downstream stores must call `deleteUserRow` from their delete reducers — that wiring happens in B2–B6.

**Files:**
- Modify: `src/lib/sync.ts:76-98` (pushAgentProfiles), `:116-133` (pushProjects), `:259-283` (pushBoardTasks), `:301-318` (pushActions)

- [ ] **Step 1: Rewrite `pushAgentProfiles`**

Replace the body at `src/lib/sync.ts:76-98`:

```ts
import { upsertUserRows } from '@/lib/synced-store';
// ...

export async function pushAgentProfiles(userId: string, profiles: AgentProfile[]): Promise<void> {
  await upsertUserRows('agent_profiles', userId, profiles, (p) => ({
    id: p.id,
    user_id: userId,
    name: p.name,
    provider: p.provider,
    model: p.model,
    api_key: p.apiKey,
    system_prompt: p.systemPrompt,
    autonomous: p.autonomous,
    updated_at: new Date().toISOString(),
  }));
}
```

- [ ] **Step 2: Rewrite `pushProjects`**

Projects don't have a server-side `id` column today (the table uses `(user_id, name)` — verify with `\d projects` if unsure). To use upsert keyed by `(user_id, id)` we need an id. Two options:
- **(a)** Use `name` as the id at the application layer (mapper sets `id: p.name`). Requires DB migration to add a unique constraint on `(user_id, name)`.
- **(b)** Keep the destructive pattern for `projects` only and document why.

For M1 — **option (a)**. Add a Supabase migration in this task:

Apply via `mcp__plugin_supabase_supabase__apply_migration` (or the Supabase dashboard if MCP isn't wired in this session):

```sql
-- 2026-05-09-projects-id-column.sql
alter table projects add column if not exists id text;
update projects set id = name where id is null;
alter table projects alter column id set not null;
alter table projects add constraint projects_user_id_id_unique unique (user_id, id);
```

Then rewrite `pushProjects`:

```ts
export async function pushProjects(userId: string, projects: Project[]): Promise<void> {
  await upsertUserRows('projects', userId, projects, (p) => ({
    id: p.name,
    user_id: userId,
    name: p.name,
    path: p.path,
    updated_at: new Date().toISOString(),
  }));
}
```

If `mcp__plugin_supabase_supabase__list_tables` shows `projects.id` already exists with the right shape, skip the migration step.

- [ ] **Step 3: Rewrite `pushBoardTasks`**

```ts
export async function pushBoardTasks(userId: string, tasks: BoardTask[]): Promise<void> {
  await upsertUserRows('board_tasks', userId, tasks, (t) => ({
    id: t.id,
    user_id: userId,
    project_name: t.projectName,
    subject_name: t.subjectName,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    messages: t.messages,
  }));
}
```

- [ ] **Step 4: Rewrite `pushActions`**

```ts
export async function pushActions(userId: string, actions: Action[]): Promise<void> {
  await upsertUserRows('actions', userId, actions, (a) => ({
    id: a.id,
    user_id: userId,
    data: a,
    updated_at: new Date().toISOString(),
  }));
}
```

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS — no test currently exercises destructive delete semantics.

- [ ] **Step 6: Manual smoke check**

Start the app (`npm run tauri dev`), sign in, create one agent profile and one project. Confirm in the Supabase dashboard's `agent_profiles` and `projects` tables that the new row appears without nuking pre-existing rows.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sync.ts
git commit -m "refactor(sync): switch pushXxx to upsertUserRows (closes destructive-delete race)"
```

### Task B2: Migrate `actions-store` to `makeDebouncedSync` + `runOnce`

**Files:**
- Modify: `src/stores/actions-store.ts`

- [ ] **Step 1: Replace the per-store debounce with `makeDebouncedSync`**

At `src/stores/actions-store.ts:200-208`, delete `actionsSyncTimer` and `debouncedActionsSync`. Replace with:

```ts
import { makeDebouncedSync, runOnce } from '@/lib/synced-store';

const actionsSync = makeDebouncedSync<Action[]>(pushActions, 1000);
```

At `:259`, change `debouncedActionsSync(actions)` to `actionsSync.schedule(actions)`.

In `flushActionsStore` (`:269-279`), after the existing disk flush, also call `await actionsSync.flush()`.

- [ ] **Step 2: Wrap `bootExecutor` in `runOnce`**

Replace lines 34-54 with:

```ts
async function bootExecutor(getState: () => ActionsState): Promise<void> {
  await runOnce('queue-worker', async () => {
    await startQueueWorker({
      serverAbsolutePath: PHASE_E_MCP_SERVER_PATH,
      intervalMs: 500,
      getActions: () => getState().actions,
      updateAction: (id, patch) => getState().updateAction(id, patch),
      updateTask: (actionId, taskId, patch) =>
        getState().updateTask(actionId, taskId, patch),
    });
  });
}
```

Delete the `let queueWorkerStarted = false;` line — `runOnce` owns that flag now.

- [ ] **Step 3: Add `deleteUserRow` to the local-delete reducer**

In `deleteAction`, after `set(...)`, add:

```ts
const userId = useAuthStore.getState().user?.id;
if (userId) deleteUserRow('actions', userId, id).catch((e) => console.error(e));
```

Add the import: `import { deleteUserRow } from '@/lib/synced-store';`.

- [ ] **Step 4: Run the existing actions-store tests**

Run: `npm run test -- actions-store`
Expected: PASS — existing tests don't observe the timer mechanics.

- [ ] **Step 5: Commit**

```bash
git add src/stores/actions-store.ts
git commit -m "refactor(actions-store): adopt makeDebouncedSync + runOnce + deleteUserRow"
```

### Task B3: Migrate `board-store`

**Files:**
- Modify: `src/stores/board-store.ts`

- [ ] **Step 1: Replace `debouncedBoardSync` with `makeDebouncedSync`**

At `src/stores/board-store.ts:11-19`, delete `boardSyncTimer` and `debouncedBoardSync`. Replace with:

```ts
import { makeDebouncedSync, deleteUserRow } from '@/lib/synced-store';

const boardSync = makeDebouncedSync<BoardTask[]>(pushBoardTasks, 1000);
```

Replace every `debouncedBoardSync(...)` call site with `boardSync.schedule(...)`.

- [ ] **Step 2: Add `deleteUserRow` to `deleteTask`**

In `deleteTask` (around `:156-166`), after `set(...)`, add:

```ts
const userId = useAuthStore.getState().user?.id;
if (userId) deleteUserRow('board_tasks', userId, id).catch((e) => console.error(e));
```

- [ ] **Step 3: Add a `flush()` method to the store interface**

Extend the `BoardState` interface:

```ts
flush(): Promise<void>;
```

In the `create<BoardState>(...)` factory, add:

```ts
flush: async () => {
  await boardSync.flush();
},
```

- [ ] **Step 4: Run smoke + commit**

Run: `npm run test`
Expected: PASS.

```bash
git add src/stores/board-store.ts
git commit -m "refactor(board-store): adopt makeDebouncedSync + deleteUserRow + flush()"
```

### Task B4: Migrate `planner-store`

**Files:**
- Modify: `src/stores/planner-store.ts`

- [ ] **Step 1: Replace `debouncedProjectSync` and `debouncedSubjectSync`**

At `:23-41`, delete both timers and helpers. Replace with two `makeDebouncedSync` instances:

```ts
import { makeDebouncedSync, deleteUserRow } from '@/lib/synced-store';

const projectsSync = makeDebouncedSync<Project[]>(pushProjects, 1000);
type SubjectPayload = { projectName: string; fileName: string; content: string };
const subjectSync = makeDebouncedSync<SubjectPayload>(
  (uid, p) => pushSubject(uid, p.projectName, p.fileName, p.content),
  1000,
);
```

Update all call sites:
- `debouncedProjectSync(newProjects)` → `projectsSync.schedule(newProjects)`
- `debouncedSubjectSync(projectName, fileName, content)` → `subjectSync.schedule({ projectName, fileName, content })`

- [ ] **Step 2: Add `flush()` and confirm `deleteSubject` already calls `deleteRemoteSubject`**

`deleteSubject` already calls `deleteRemoteSubject` — no change. `deleteProject` already calls `deleteRemoteSubjectsByProject` — no change. Both stay because they target a `(user_id, project_name, file_name)` composite key, not the generic `(user_id, id)` shape.

Add `flush()` to the interface and implementation:

```ts
flush: async () => {
  await projectsSync.flush();
  await subjectSync.flush();
},
```

- [ ] **Step 3: Smoke + commit**

Run: `npm run test`
Expected: PASS.

```bash
git add src/stores/planner-store.ts
git commit -m "refactor(planner-store): adopt makeDebouncedSync + flush()"
```

### Task B5: Migrate `agents-store`

**Files:**
- Modify: `src/stores/agents-store.ts`

- [ ] **Step 1: Replace `debouncedProfileSync`**

At `:17-25`, replace with:

```ts
import { makeDebouncedSync, deleteUserRow } from '@/lib/synced-store';

const profilesSync = makeDebouncedSync<AgentProfile[]>(pushAgentProfiles, 1000);
```

In `saveProfiles`, swap `debouncedProfileSync(profiles)` for `profilesSync.schedule(profiles)`.

- [ ] **Step 2: Add `deleteUserRow` to `deleteProfile`**

After the existing `set(...)` and `saveProfiles(...)` calls in `deleteProfile`:

```ts
const userId = useAuthStore.getState().user?.id;
if (userId) deleteUserRow('agent_profiles', userId, id).catch((e) => console.error(e));
```

- [ ] **Step 3: Add `flush()`**

```ts
flush: async () => {
  await profilesSync.flush();
},
```

Extend the `AgentsState` interface accordingly.

- [ ] **Step 4: Smoke + commit**

```bash
git add src/stores/agents-store.ts
git commit -m "refactor(agents-store): adopt makeDebouncedSync + deleteUserRow + flush()"
```

### Task B6: Migrate `app-store`

`app-store` has no per-row id — `user_preferences` is keyed by `user_id` alone (single row per user). Upsert is already used in `pushPreferences` (`sync.ts:39`); the existing path is fine. The migration here is just the debounce primitive.

**Files:**
- Modify: `src/stores/app-store.ts`

- [ ] **Step 1: Replace `debouncedSync`**

At `:34-42`, replace with:

```ts
import { makeDebouncedSync } from '@/lib/synced-store';

const prefsSync = makeDebouncedSync<UserPreferences>(pushPreferences, 1000);
```

Replace every `debouncedSync(prefs)` with `prefsSync.schedule(prefs)`.

- [ ] **Step 2: Add `flush()` to the AppState interface and impl**

```ts
flush: async () => {
  await prefsSync.flush();
},
```

- [ ] **Step 3: Commit**

```bash
git add src/stores/app-store.ts
git commit -m "refactor(app-store): adopt makeDebouncedSync + flush()"
```

### Task B7: Migrate `realtime.ts` to `subscribeUserTable`

**Files:**
- Modify: `src/lib/realtime.ts`

- [ ] **Step 1: Refactor each listener body**

The 5 duplicated listener bodies (`agent_profiles`, `projects`, `subjects`, `board_tasks`, `actions` at lines 37-133) collapse into per-table `refetchAndApply` helpers + a single `subscribeUserTable` chain.

Replace the body of `startRealtimeSync` (lines 14-135) with:

```ts
import {
  fetchAgentProfiles, fetchProjects, fetchSubjects, fetchBoardTasks, fetchActions,
} from '@/lib/sync';
import { subscribeUserTable } from '@/lib/synced-store';

export function startRealtimeSync(userId: string): void {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();

  const refetchProfiles = async () => {
    const profiles = await fetchAgentProfiles(userId);
    if (profiles.length > 0) useAgentsStore.getState().applyRemoteProfiles(profiles);
  };
  const refetchProjects = async () => {
    const projects = await fetchProjects(userId);
    if (projects) usePlannerStore.getState().applyRemoteProjects(projects);
  };
  const refetchSubjects = async () => {
    const subjects = await fetchSubjects(userId);
    if (subjects) await usePlannerStore.getState().applyRemoteSubjects(subjects);
  };
  const refetchBoardTasks = async () => {
    const tasks = await fetchBoardTasks(userId);
    if (tasks) useBoardStore.getState().applyRemoteTasks(tasks);
  };
  const refetchActions = async () => {
    const actions = await fetchActions(userId);
    if (actions) useActionsStore.getState().applyRemoteActions(actions);
  };

  let ch = supabase.channel('db-sync');
  // user_preferences keeps the inline listener — it consumes payload.new
  // directly (single row per user, no re-fetch), legitimately different.
  ch = ch.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'user_preferences', filter: `user_id=eq.${userId}` },
    (payload) => {
      const row = payload.new as any;
      if (!row || payload.eventType === 'DELETE') return;
      useAppStore.getState().applyRemotePreferences({
        darkMode: row.dark_mode,
        language: row.language,
        terminalTheme: row.terminal_theme,
        terminalFont: row.terminal_font,
        terminalFontSize: row.terminal_font_size,
        terminalLigatures: row.terminal_ligatures,
      });
    },
  );

  ch = subscribeUserTable(ch, 'agent_profiles', userId, refetchProfiles);
  ch = subscribeUserTable(ch, 'projects',       userId, refetchProjects);
  ch = subscribeUserTable(ch, 'subjects',       userId, refetchSubjects);
  ch = subscribeUserTable(ch, 'board_tasks',    userId, refetchBoardTasks);
  ch = subscribeUserTable(ch, 'actions',        userId, refetchActions);

  channel = ch.subscribe();
}
```

- [ ] **Step 2: Run smoke**

Run: `npm run test`
Expected: PASS — no realtime tests today.

- [ ] **Step 3: Manual smoke**

In two browsers (or one app + Supabase dashboard SQL editor), update an `agent_profiles` row for the active user and confirm it appears in the UI within ~2s.

- [ ] **Step 4: Commit**

```bash
git add src/lib/realtime.ts
git commit -m "refactor(realtime): collapse 5 duplicate listeners onto subscribeUserTable"
```

### Task B8: Wire `flush()` for ALL synced stores on window close

Today only `actions-store` flushes on window close (`src/App.tsx:34`). Add the rest.

**Files:**
- Modify: `src/App.tsx:25-43`

- [ ] **Step 1: Update the close handler**

Replace the close-handler block in `App.tsx` with:

```ts
unlistenClose = await win.onCloseRequested(async (event) => {
  event.preventDefault();
  try {
    await Promise.all([
      flushActionsStore(),
      useBoardStore.getState().flush(),
      usePlannerStore.getState().flush(),
      useAgentsStore.getState().flush(),
      useAppStore.getState().flush(),
    ]);
  } catch (e) {
    console.error('[App] flush on close failed', e);
  }
  await win.destroy();
});
```

Add the imports at the top:

```ts
import { useBoardStore } from '@/stores/board-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useAgentsStore } from '@/stores/agents-store';
import { useAppStore } from '@/stores/app-store';
```

- [ ] **Step 2: Manual verification**

Start the app, edit an agent profile name (triggers debounce), close the window within 1s. Re-open. Confirm the change persists in Supabase (the app, the dashboard, or both).

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "fix(close): flush all synced stores on window close (closes silent-loss footgun)"
```

**Phase B done.** All 5 stores + realtime + sync.ts are on the new primitive. Run the full suite once more before moving on:

```bash
npm run test
```

---

## Phase C — Secure store (Rust keyring + TS wrapper)

The OS keyring (Windows Credential Manager / macOS Keychain / libsecret on Linux) is the right place for refresh tokens and per-account MCP bearer tokens. The Rust `keyring` crate handles all three OSes uniformly.

### Task C1: Add the Rust dependency and the secure-store module

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/secure_store.rs`

- [ ] **Step 1: Check the current crate version with the sonatype-guide skill**

Trigger: `Skill('sonatype-guide:sonatype-guide')` with the request: "Audit `keyring` crate for Rust — vulnerabilities, license, recent versions. Recommend safest pinned major."

Capture the recommended version. As of this writing the spec assumes `keyring = "3"` with the `default-features` enabled (which on Windows uses `windows-credential-manager`, on macOS uses `Security.framework`, on Linux uses `secret-service`).

- [ ] **Step 2: Add the dep**

Modify `src-tauri/Cargo.toml`:

```toml
[dependencies]
# ...existing deps...
keyring = "3"
```

- [ ] **Step 3: Create `src-tauri/src/secure_store.rs`**

```rust
// src-tauri/src/secure_store.rs
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const SERVICE: &str = "notter-ai";

/// In-memory index of every key we've ever written for this service. The OS
/// keyring API does not expose enumeration; we track keys in app-local data
/// elsewhere (accounts/index.json), but for `list_keys` correctness during
/// account removal we maintain this index in process memory and rebuild it
/// at startup from the front-end's accounts index.
pub struct SecureStoreState {
    pub known_keys: Mutex<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
pub struct SecureGetResponse {
    pub key: String,
    pub value: Option<String>,
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keyring entry({key}): {e}"))
}

#[tauri::command]
pub fn secure_set(
    key: String,
    value: String,
    state: tauri::State<'_, SecureStoreState>,
) -> Result<(), String> {
    let e = entry(&key)?;
    e.set_password(&value).map_err(|err| format!("keyring set({key}): {err}"))?;
    let mut keys = state.known_keys.lock().map_err(|e| e.to_string())?;
    if !keys.contains(&key) {
        keys.push(key);
    }
    Ok(())
}

#[tauri::command]
pub fn secure_get(key: String) -> Result<SecureGetResponse, String> {
    let e = entry(&key)?;
    match e.get_password() {
        Ok(value) => Ok(SecureGetResponse { key, value: Some(value) }),
        Err(keyring::Error::NoEntry) => Ok(SecureGetResponse { key, value: None }),
        Err(err) => Err(format!("keyring get({key}): {err}")),
    }
}

#[tauri::command]
pub fn secure_delete(
    key: String,
    state: tauri::State<'_, SecureStoreState>,
) -> Result<(), String> {
    let e = entry(&key)?;
    match e.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => {}
        Err(err) => return Err(format!("keyring delete({key}): {err}")),
    }
    let mut keys = state.known_keys.lock().map_err(|e| e.to_string())?;
    keys.retain(|k| k != &key);
    Ok(())
}

#[tauri::command]
pub fn secure_register_known_keys(
    keys: Vec<String>,
    state: tauri::State<'_, SecureStoreState>,
) -> Result<(), String> {
    let mut k = state.known_keys.lock().map_err(|e| e.to_string())?;
    for key in keys {
        if !k.contains(&key) {
            k.push(key);
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Wire the module into `lib.rs`**

In `src-tauri/src/lib.rs`, near the top:

```rust
mod ollama_install;
mod secure_store;
```

In the existing `tauri::Builder::default()` chain (search for `.invoke_handler` and `.manage`), add the state and the four commands. The exact location is in the `run()` function near the end of `lib.rs`. The new lines:

```rust
.manage(secure_store::SecureStoreState {
    known_keys: std::sync::Mutex::new(Vec::new()),
})
// ...
.invoke_handler(tauri::generate_handler![
    // ...existing handlers (create_pty, write_pty, resize_pty, close_pty, ollama_install::*, llm_request, ...)
    secure_store::secure_set,
    secure_store::secure_get,
    secure_store::secure_delete,
    secure_store::secure_register_known_keys,
])
```

- [ ] **Step 5: Build the Rust side**

Run: `npm run tauri dev`
Expected: builds without errors; the existing app boots normally.

If `keyring` fails to compile on Linux without `libdbus`, add an install hint to the README — but for Windows/macOS dev, no extra system deps are needed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/secure_store.rs src-tauri/src/lib.rs
git commit -m "feat(secure-store): add OS-keyring-backed Tauri commands"
```

### Task C2: TypeScript wrapper + tests

**Files:**
- Create: `src/lib/accounts/secure-store.ts`
- Create: `src/lib/accounts/__tests__/secure-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/accounts/__tests__/secure-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { secureSet, secureGet, secureDelete } from '@/lib/accounts/secure-store';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => invokeMock(...args) }));

beforeEach(() => invokeMock.mockReset());

describe('secureSet', () => {
  it('forwards to secure_set Tauri command', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await secureSet('notter:account:abc:refresh_token', 'rt-xyz');
    expect(invokeMock).toHaveBeenCalledWith('secure_set', {
      key: 'notter:account:abc:refresh_token',
      value: 'rt-xyz',
    });
  });
});

describe('secureGet', () => {
  it('returns null when value is absent', async () => {
    invokeMock.mockResolvedValueOnce({ key: 'k', value: null });
    expect(await secureGet('k')).toBeNull();
  });
  it('returns the value when present', async () => {
    invokeMock.mockResolvedValueOnce({ key: 'k', value: 'v' });
    expect(await secureGet('k')).toBe('v');
  });
});

describe('secureDelete', () => {
  it('forwards to secure_delete', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await secureDelete('k');
    expect(invokeMock).toHaveBeenCalledWith('secure_delete', { key: 'k' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- secure-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/accounts/secure-store.ts`**

```ts
// src/lib/accounts/secure-store.ts
import { invoke } from '@tauri-apps/api/core';

export async function secureSet(key: string, value: string): Promise<void> {
  await invoke('secure_set', { key, value });
}

export async function secureGet(key: string): Promise<string | null> {
  const res = await invoke<{ key: string; value: string | null }>('secure_get', { key });
  return res.value;
}

export async function secureDelete(key: string): Promise<void> {
  await invoke('secure_delete', { key });
}

export async function secureRegisterKnownKeys(keys: string[]): Promise<void> {
  await invoke('secure_register_known_keys', { keys });
}

// Helper: per-account key shapes used elsewhere in the app.
export const accountKeys = {
  refreshToken: (accountId: string) => `notter:account:${accountId}:refresh_token`,
  mcpToken:     (accountId: string) => `notter:account:${accountId}:mcp_token`,
};
```

- [ ] **Step 4: Verify tests pass + commit**

Run: `npm run test -- secure-store`
Expected: PASS.

```bash
git add src/lib/accounts/secure-store.ts src/lib/accounts/__tests__/secure-store.test.ts
git commit -m "feat(secure-store): add TS wrapper around Tauri secure_* commands"
```

---

## Phase D — `AccountManager` core

This phase introduces the AccountManager data model, fs persistence for the accounts index, and a single-account-compatible bootstrap. The actual `switchAccount` flow lands in Phase H once the store reset machinery (Phase F) and the custom Supabase storage adapter (Phase E) exist.

### Task D1: Account types and storage IO

**Files:**
- Create: `src/lib/accounts/types.ts`
- Create: `src/lib/accounts/account-storage.ts`
- Create: `src/lib/accounts/__tests__/account-storage.test.ts`

- [ ] **Step 1: Define types**

```ts
// src/lib/accounts/types.ts
export interface AccountSummary {
  id: string;            // Supabase user.id
  email: string;
  displayName: string | null;
  addedAt: string;       // ISO-8601
}

export interface AccountIndex {
  accounts: AccountSummary[];
}

export interface ActiveAccountPointer {
  accountId: string | null;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/accounts/__tests__/account-storage.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fsMock = {
  readTextFile: vi.fn(),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { AppLocalData: 1 },
};
vi.mock('@tauri-apps/plugin-fs', () => fsMock);

import {
  readAccountIndex, writeAccountIndex,
  readActiveAccount, writeActiveAccount,
} from '@/lib/accounts/account-storage';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readAccountIndex', () => {
  it('returns empty index when file is missing', async () => {
    fsMock.exists.mockResolvedValueOnce(false);
    const idx = await readAccountIndex();
    expect(idx.accounts).toEqual([]);
  });
  it('parses and returns accounts when file exists', async () => {
    fsMock.exists.mockResolvedValueOnce(true);
    fsMock.readTextFile.mockResolvedValueOnce(JSON.stringify({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: 'A', addedAt: '2026-01-01T00:00:00Z' }],
    }));
    const idx = await readAccountIndex();
    expect(idx.accounts).toHaveLength(1);
    expect(idx.accounts[0].id).toBe('u1');
  });
});

describe('writeAccountIndex', () => {
  it('writes to accounts/index.json under AppLocalData with a tmp+rename atomic swap', async () => {
    fsMock.exists.mockResolvedValue(true);
    await writeAccountIndex({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' }],
    });
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      'notter-ai/accounts/index.json.tmp',
      expect.stringContaining('"u1"'),
      { baseDir: fsMock.BaseDirectory.AppLocalData },
    );
    expect(fsMock.rename).toHaveBeenCalledWith(
      'notter-ai/accounts/index.json.tmp',
      'notter-ai/accounts/index.json',
      expect.any(Object),
    );
  });
});

describe('readActiveAccount', () => {
  it('returns { accountId: null } when file is missing', async () => {
    fsMock.exists.mockResolvedValueOnce(false);
    expect((await readActiveAccount()).accountId).toBeNull();
  });
});

describe('writeActiveAccount', () => {
  it('writes the active pointer atomically', async () => {
    fsMock.exists.mockResolvedValue(true);
    await writeActiveAccount({ accountId: 'u1' });
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      'notter-ai/accounts/active.json.tmp',
      expect.stringContaining('"u1"'),
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm run test -- account-storage`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `account-storage.ts`**

```ts
// src/lib/accounts/account-storage.ts
import {
  BaseDirectory, readTextFile, writeTextFile, exists, mkdir, rename,
} from '@tauri-apps/plugin-fs';
import type { AccountIndex, ActiveAccountPointer } from './types';

const ROOT = 'notter-ai';
const INDEX_PATH = `${ROOT}/accounts/index.json`;
const ACTIVE_PATH = `${ROOT}/accounts/active.json`;

async function ensureAccountsDir(): Promise<void> {
  if (!(await exists(`${ROOT}/accounts`, { baseDir: BaseDirectory.AppLocalData }))) {
    await mkdir(`${ROOT}/accounts`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await ensureAccountsDir();
  const tmp = `${path}.tmp`;
  await writeTextFile(tmp, content, { baseDir: BaseDirectory.AppLocalData });
  try {
    await rename(tmp, path, {
      oldPathBaseDir: BaseDirectory.AppLocalData,
      newPathBaseDir: BaseDirectory.AppLocalData,
    });
  } catch {
    // Windows occasionally refuses cross-handle rename; fall back to direct write.
    await writeTextFile(path, content, { baseDir: BaseDirectory.AppLocalData });
  }
}

export async function readAccountIndex(): Promise<AccountIndex> {
  if (!(await exists(INDEX_PATH, { baseDir: BaseDirectory.AppLocalData }))) {
    return { accounts: [] };
  }
  try {
    const raw = await readTextFile(INDEX_PATH, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.accounts)) return { accounts: [] };
    return parsed as AccountIndex;
  } catch (e) {
    console.error('[account-storage] failed to read index:', e);
    return { accounts: [] };
  }
}

export async function writeAccountIndex(idx: AccountIndex): Promise<void> {
  await atomicWrite(INDEX_PATH, JSON.stringify(idx, null, 2));
}

export async function readActiveAccount(): Promise<ActiveAccountPointer> {
  if (!(await exists(ACTIVE_PATH, { baseDir: BaseDirectory.AppLocalData }))) {
    return { accountId: null };
  }
  try {
    const raw = await readTextFile(ACTIVE_PATH, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accountId !== 'string' && parsed?.accountId !== null) {
      return { accountId: null };
    }
    return parsed as ActiveAccountPointer;
  } catch (e) {
    console.error('[account-storage] failed to read active pointer:', e);
    return { accountId: null };
  }
}

export async function writeActiveAccount(p: ActiveAccountPointer): Promise<void> {
  await atomicWrite(ACTIVE_PATH, JSON.stringify(p, null, 2));
}
```

- [ ] **Step 5: Verify tests pass + commit**

Run: `npm run test -- account-storage`
Expected: PASS.

```bash
git add src/lib/accounts/types.ts src/lib/accounts/account-storage.ts src/lib/accounts/__tests__/account-storage.test.ts
git commit -m "feat(accounts): add AccountIndex types + atomic fs IO"
```

### Task D2: `AccountManager` class — bootstrap, list, add, remove

`switchAccount` is intentionally NOT in this task — it depends on Phase E (custom storage adapter) and Phase F (per-store reset).

**Files:**
- Create: `src/lib/accounts/account-manager.ts`
- Create: `src/lib/accounts/__tests__/account-manager.test.ts`

- [ ] **Step 1: Write failing test for `bootstrap`, `list`, `add`, `remove`**

```ts
// src/lib/accounts/__tests__/account-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storageMock = {
  readAccountIndex: vi.fn(),
  writeAccountIndex: vi.fn().mockResolvedValue(undefined),
  readActiveAccount: vi.fn(),
  writeActiveAccount: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@/lib/accounts/account-storage', () => storageMock);

const secureMock = {
  secureSet: vi.fn().mockResolvedValue(undefined),
  secureDelete: vi.fn().mockResolvedValue(undefined),
  secureRegisterKnownKeys: vi.fn().mockResolvedValue(undefined),
  accountKeys: {
    refreshToken: (id: string) => `notter:account:${id}:refresh_token`,
    mcpToken: (id: string) => `notter:account:${id}:mcp_token`,
  },
};
vi.mock('@/lib/accounts/secure-store', () => secureMock);

import { AccountManager } from '@/lib/accounts/account-manager';

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.readAccountIndex.mockResolvedValue({ accounts: [] });
  storageMock.readActiveAccount.mockResolvedValue({ accountId: null });
});

describe('AccountManager.bootstrap', () => {
  it('loads the index and active pointer', async () => {
    storageMock.readAccountIndex.mockResolvedValueOnce({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: 'A', addedAt: '2026-05-09T00:00:00Z' }],
    });
    storageMock.readActiveAccount.mockResolvedValueOnce({ accountId: 'u1' });
    const mgr = new AccountManager();
    await mgr.bootstrap();
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.activeAccountId).toBe('u1');
  });

  it('rebuilds the secure-store key index from the loaded accounts', async () => {
    storageMock.readAccountIndex.mockResolvedValueOnce({
      accounts: [
        { id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
        { id: 'u2', email: 'b@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
      ],
    });
    storageMock.readActiveAccount.mockResolvedValueOnce({ accountId: 'u1' });
    const mgr = new AccountManager();
    await mgr.bootstrap();
    expect(secureMock.secureRegisterKnownKeys).toHaveBeenCalledWith([
      'notter:account:u1:refresh_token', 'notter:account:u1:mcp_token',
      'notter:account:u2:refresh_token', 'notter:account:u2:mcp_token',
    ]);
  });
});

describe('AccountManager.add', () => {
  it('persists the refresh token + mcp token to secure store and writes the index', async () => {
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await mgr.add({
      id: 'u1',
      email: 'a@b.c',
      displayName: 'A',
      refreshToken: 'rt-xyz',
    });
    expect(secureMock.secureSet).toHaveBeenCalledWith(
      'notter:account:u1:refresh_token', 'rt-xyz',
    );
    expect(secureMock.secureSet).toHaveBeenCalledWith(
      'notter:account:u1:mcp_token',
      expect.stringMatching(/^notter_acc_/),
    );
    expect(storageMock.writeAccountIndex).toHaveBeenCalled();
    expect(mgr.list()).toHaveLength(1);
  });

  it('rejects an account id collision', async () => {
    storageMock.readAccountIndex.mockResolvedValueOnce({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' }],
    });
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await expect(mgr.add({
      id: 'u1', email: 'a@b.c', displayName: null, refreshToken: 'rt',
    })).rejects.toThrow(/already added/);
  });
});

describe('AccountManager.remove', () => {
  beforeEach(() => {
    storageMock.readAccountIndex.mockResolvedValue({
      accounts: [
        { id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
        { id: 'u2', email: 'b@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
      ],
    });
    storageMock.readActiveAccount.mockResolvedValue({ accountId: 'u1' });
  });

  it('deletes both secure keys and rewrites the index', async () => {
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await mgr.remove('u2');
    expect(secureMock.secureDelete).toHaveBeenCalledWith('notter:account:u2:refresh_token');
    expect(secureMock.secureDelete).toHaveBeenCalledWith('notter:account:u2:mcp_token');
    expect(mgr.list().map((a) => a.id)).toEqual(['u1']);
  });

  it('refuses to remove the currently-active account', async () => {
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await expect(mgr.remove('u1')).rejects.toThrow(/active/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- account-manager`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `account-manager.ts`**

```ts
// src/lib/accounts/account-manager.ts
import { readAccountIndex, writeAccountIndex, readActiveAccount, writeActiveAccount } from './account-storage';
import { secureSet, secureDelete, secureRegisterKnownKeys, accountKeys } from './secure-store';
import type { AccountSummary } from './types';

export interface AddAccountInput {
  id: string;
  email: string;
  displayName: string | null;
  refreshToken: string;
}

function generateMcpToken(): string {
  // 32 bytes → base64url, prefixed for human recognition.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `notter_acc_${b64}`;
}

export class AccountManager {
  private accounts: AccountSummary[] = [];
  private active: string | null = null;
  private booted = false;

  get activeAccountId(): string | null {
    return this.active;
  }

  list(): AccountSummary[] {
    return [...this.accounts];
  }

  get(id: string): AccountSummary | null {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  async bootstrap(): Promise<void> {
    if (this.booted) return;
    const idx = await readAccountIndex();
    const active = await readActiveAccount();
    this.accounts = idx.accounts;
    this.active = active.accountId;

    // Repopulate the Rust-side known-key index so secure_register_known_keys
    // returns sane results during this run.
    const keys: string[] = [];
    for (const a of this.accounts) {
      keys.push(accountKeys.refreshToken(a.id), accountKeys.mcpToken(a.id));
    }
    if (keys.length > 0) await secureRegisterKnownKeys(keys);

    this.booted = true;
  }

  async add(input: AddAccountInput): Promise<AccountSummary> {
    if (this.accounts.some((a) => a.id === input.id)) {
      throw new Error(`Account ${input.id} already added`);
    }
    await secureSet(accountKeys.refreshToken(input.id), input.refreshToken);
    await secureSet(accountKeys.mcpToken(input.id), generateMcpToken());

    const summary: AccountSummary = {
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      addedAt: new Date().toISOString(),
    };
    this.accounts.push(summary);
    await writeAccountIndex({ accounts: this.accounts });
    return summary;
  }

  async remove(id: string): Promise<void> {
    if (this.active === id) {
      throw new Error('Cannot remove the active account; switch to another account first.');
    }
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length === before) return; // no-op
    await secureDelete(accountKeys.refreshToken(id));
    await secureDelete(accountKeys.mcpToken(id));
    await writeAccountIndex({ accounts: this.accounts });
  }

  /**
   * Updates the active-pointer file and the in-memory state. Does NOT touch
   * Supabase, stores, or realtime — those steps live in switchAccount() and
   * are added in Phase H once Phase F (resets) is in place.
   */
  async setActiveAccountId(id: string | null): Promise<void> {
    this.active = id;
    await writeActiveAccount({ accountId: id });
  }
}

// Singleton accessor — created lazily on first access; bootstrap is awaited
// from App.tsx before any auth / store work.
let _singleton: AccountManager | null = null;
export function getAccountManager(): AccountManager {
  if (!_singleton) _singleton = new AccountManager();
  return _singleton;
}
```

- [ ] **Step 4: Verify tests pass + commit**

Run: `npm run test -- account-manager`
Expected: PASS.

```bash
git add src/lib/accounts/account-manager.ts src/lib/accounts/__tests__/account-manager.test.ts
git commit -m "feat(accounts): AccountManager core (bootstrap/list/add/remove)"
```

---

## Phase E — Custom Supabase storage adapter + auth-store rewire

The Supabase JS client persists the auth session via a `Storage`-shaped object (default `window.localStorage`). Our adapter forwards reads/writes to localStorage but namespaces them by the active account, so a single client can host N sessions in storage and switch between them by changing which key it reads.

### Task E1: Implement the storage adapter

**Files:**
- Create: `src/lib/accounts/supabase-storage-adapter.ts`
- Create: `src/lib/accounts/__tests__/supabase-storage-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/accounts/__tests__/supabase-storage-adapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPerAccountStorage } from '@/lib/accounts/supabase-storage-adapter';

beforeEach(() => {
  localStorage.clear();
});

describe('createPerAccountStorage', () => {
  it('namespaces keys with the current active account id', () => {
    let active: string | null = 'u1';
    const adapter = createPerAccountStorage(() => active);
    adapter.setItem('sb-auth-token', 'session-1');
    expect(localStorage.getItem('notter:u1:sb-auth-token')).toBe('session-1');
    expect(adapter.getItem('sb-auth-token')).toBe('session-1');
  });

  it('returns null when no account is active', () => {
    const adapter = createPerAccountStorage(() => null);
    expect(adapter.getItem('sb-auth-token')).toBeNull();
    adapter.setItem('sb-auth-token', 'ignored'); // silently no-ops
    expect(localStorage.getItem('notter:null:sb-auth-token')).toBeNull();
  });

  it('reads from a different namespace after the active account changes', () => {
    let active: string | null = 'u1';
    const adapter = createPerAccountStorage(() => active);
    adapter.setItem('sb-auth-token', 'session-u1');
    active = 'u2';
    expect(adapter.getItem('sb-auth-token')).toBeNull();
    adapter.setItem('sb-auth-token', 'session-u2');
    expect(localStorage.getItem('notter:u2:sb-auth-token')).toBe('session-u2');
  });

  it('removeItem only touches the active namespace', () => {
    let active: string | null = 'u1';
    const adapter = createPerAccountStorage(() => active);
    adapter.setItem('sb-auth-token', 's1');
    active = 'u2';
    adapter.setItem('sb-auth-token', 's2');
    active = 'u1';
    adapter.removeItem('sb-auth-token');
    expect(localStorage.getItem('notter:u1:sb-auth-token')).toBeNull();
    expect(localStorage.getItem('notter:u2:sb-auth-token')).toBe('s2');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- supabase-storage-adapter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// src/lib/accounts/supabase-storage-adapter.ts

/**
 * Returns a `Storage`-compatible object suitable for passing to
 * `createClient(..., { auth: { storage } })`. Reads and writes are
 * transparently namespaced by the active account id resolved at every
 * call. When no account is active, gets return null and sets are no-ops.
 *
 * The Supabase client only writes a single key (typically `sb-<project>-auth-token`)
 * and reads it back during init / refresh. Because the namespace prefix is
 * resolved at call time (not at adapter construction), a session belonging
 * to account A is never mistakenly read for account B.
 */
export function createPerAccountStorage(
  getActiveAccountId: () => string | null,
): Storage {
  const namespace = (key: string): string | null => {
    const id = getActiveAccountId();
    if (!id) return null;
    return `notter:${id}:${key}`;
  };

  return {
    getItem(key: string): string | null {
      const ns = namespace(key);
      if (!ns) return null;
      return localStorage.getItem(ns);
    },
    setItem(key: string, value: string): void {
      const ns = namespace(key);
      if (!ns) return;
      localStorage.setItem(ns, value);
    },
    removeItem(key: string): void {
      const ns = namespace(key);
      if (!ns) return;
      localStorage.removeItem(ns);
    },
    // Storage interface stubs (Supabase doesn't use these but TS requires them):
    get length(): number { return 0; },
    clear(): void { /* no-op */ },
    key(_index: number): string | null { return null; },
  };
}
```

- [ ] **Step 4: Verify tests pass + commit**

Run: `npm run test -- supabase-storage-adapter`
Expected: PASS.

```bash
git add src/lib/accounts/supabase-storage-adapter.ts src/lib/accounts/__tests__/supabase-storage-adapter.test.ts
git commit -m "feat(accounts): per-account Supabase storage adapter"
```

### Task E2: Wire the adapter into `supabase.ts` + add the M3-stub token broadcast

**Files:**
- Modify: `src/lib/supabase.ts`

- [ ] **Step 1: Replace `supabase.ts` with the adapter-aware client**

Full replacement (the file is short):

```ts
// src/lib/supabase.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createPerAccountStorage } from '@/lib/accounts/supabase-storage-adapter';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { emit } from '@tauri-apps/api/event';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const storage = createPerAccountStorage(() => getAccountManager().activeAccountId);

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'placeholder',
  {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      storage,
    },
  },
);

// M3 hook (stub): every time Supabase rotates the access token (front-end is
// the SOLE refresh owner per spec §6.2), broadcast the new (account, token)
// to anyone listening — in M3 this will be the Rust MCP server. In M1 the
// listener does not exist; the emit is a documented contract, not active code.
supabase.auth.onAuthStateChange((event, session) => {
  if (event !== 'TOKEN_REFRESHED' && event !== 'SIGNED_IN') return;
  const accountId = getAccountManager().activeAccountId;
  if (!accountId || !session?.access_token) return;
  void emit('mcp:account-token-refreshed', {
    accountId,
    accessToken: session.access_token,
    expiresAt: session.expires_at,
  });
});
```

- [ ] **Step 2: Verify tests pass + commit**

Run: `npm run test`
Expected: PASS — no tests directly observe the storage swap. Auth-related store tests should still mock `@/lib/supabase` as before.

```bash
git add src/lib/supabase.ts
git commit -m "feat(supabase): swap to per-account storage adapter + emit refreshed-token (M3 hook)"
```

### Task E3: Rewire `auth-store.initialize()` to use the AccountManager

`auth-store` no longer drives the account choice — `AccountManager` does. `initialize()` becomes a hydration-only step that mirrors whatever Supabase session the active account has.

**Files:**
- Modify: `src/stores/auth-store.ts`

- [ ] **Step 1: Replace `initialize` with AccountManager-aware version**

Update `initialize()` (lines 99-134):

```ts
initialize: async () => {
  if (!isSupabaseConfigured) {
    set({ loading: false });
    return;
  }
  try {
    // AccountManager.bootstrap() must have run before this — it's awaited in App.tsx
    // before useAuthStore.initialize() is called.
    const mgr = getAccountManager();
    const activeId = mgr.activeAccountId;

    if (activeId) {
      // Try to restore the session for the active account. The custom storage
      // adapter wired in supabase.ts reads from notter:<activeId>:sb-...
      const { data: { session } } = await supabase.auth.getSession();
      set({ session, user: session?.user ?? null, loading: false });
      if (session?.user) {
        syncOnLogin(session.user.id);
        startRealtimeSync(session.user.id);
      } else {
        // Active account exists but session is invalid — try refresh from secure store.
        const rt = await secureGet(accountKeys.refreshToken(activeId));
        if (rt) {
          const { data, error } = await supabase.auth.setSession({
            access_token: '', refresh_token: rt,
          });
          if (!error && data.session?.user) {
            set({ session: data.session, user: data.session.user });
            syncOnLogin(data.session.user.id);
            startRealtimeSync(data.session.user.id);
          }
        }
      }
    } else {
      set({ loading: false });
    }

    supabase.auth.onAuthStateChange((event, session) => {
      set({ session, user: session?.user ?? null });
      if (event === 'SIGNED_IN' && session?.user) {
        syncOnLogin(session.user.id);
        startRealtimeSync(session.user.id);
      }
      if (event === 'SIGNED_OUT') {
        stopRealtimeSync();
      }
    });
  } catch (e) {
    console.error('Auth initialization failed:', e);
    set({ loading: false });
  }
},
```

Add the imports at the top:

```ts
import { getAccountManager } from '@/lib/accounts/account-manager';
import { secureGet, accountKeys } from '@/lib/accounts/secure-store';
```

- [ ] **Step 2: Update `signOut`**

`signOut` currently nukes the active session and stops realtime. Now it must also remove the active-account pointer (so the next boot lands on the "no active account" path). Account *removal* (delete from index + secure store) is a separate UI action; signOut just clears the runtime session.

Replace `signOut`:

```ts
signOut: async () => {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();
  await supabase.auth.signOut();
  await getAccountManager().setActiveAccountId(null);
  set({ user: null, session: null });
  // Phase F adds: resetAllStores() — wired in Task F2.
},
```

- [ ] **Step 3: Update `signInWithEmail` / `signUpWithEmail` to register the new account**

After a successful sign-in, pull the session and refresh token from Supabase, register the account, set it active, **then re-persist the session via `setSession` so it lands in the correct per-account namespace** (the original `signInWithPassword` write happened with the old `activeAccountId`, which may have been null or a previous account — the storage adapter writes to `notter:<old-active>:sb-...token`, not where we want it).

Update `signInWithEmail`:

```ts
signInWithEmail: async (email, password) => {
  if (!isSupabaseConfigured) return { error: 'not_configured' };

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.includes('Invalid login credentials')) {
      return { error: 'invalid_credentials' };
    }
    return { error: 'generic' };
  }
  if (!data.session?.user || !data.session.refresh_token) {
    return { error: 'generic' };
  }

  const mgr = getAccountManager();
  const existing = mgr.get(data.session.user.id);
  if (!existing) {
    await mgr.add({
      id: data.session.user.id,
      email: data.session.user.email ?? email,
      displayName: (data.session.user.user_metadata?.display_name as string | undefined) ?? null,
      refreshToken: data.session.refresh_token,
    });
  }
  await mgr.setActiveAccountId(data.session.user.id);

  // CRITICAL: re-persist under the now-active namespace. The initial
  // signInWithPassword wrote (or no-op'd) under the old activeAccountId.
  // setSession writes through the storage adapter, which now resolves to
  // notter:<new-userId>:sb-...token — the correct slot for app boot rehydration.
  await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });

  return {};
},
```

Apply the same pattern (register → setActive → re-`setSession`) to `signUpWithEmail` (when sign-up completes synchronously, which happens when email confirmations are disabled).

- [ ] **Step 4: Update `signInWithOAuth`'s callback site**

The OAuth callback lives in `src/lib/deep-link.ts:30`. After `exchangeCodeForSession` succeeds, register the account and re-persist the session in the correct namespace (same fix as Step 3):

Modify `src/lib/deep-link.ts:30-35`:

```ts
const { data, error } = await supabase.auth.exchangeCodeForSession(code);
if (error) {
  console.error('[deep-link] exchangeCodeForSession error:', error);
  toast.error('OAuth error: ' + error.message);
  return;
}
if (data.session?.user && data.session.refresh_token) {
  const mgr = getAccountManager();
  const existing = mgr.get(data.session.user.id);
  if (!existing) {
    await mgr.add({
      id: data.session.user.id,
      email: data.session.user.email ?? '(unknown)',
      displayName: (data.session.user.user_metadata?.display_name as string | undefined) ?? null,
      refreshToken: data.session.refresh_token,
    });
  }
  await mgr.setActiveAccountId(data.session.user.id);
  // Re-persist under the now-active namespace (see signInWithEmail rationale).
  await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
}
```

Add the import:

```ts
import { getAccountManager } from '@/lib/accounts/account-manager';
```

- [ ] **Step 5: Verify + commit**

Run: `npm run test`
Expected: PASS.

```bash
git add src/stores/auth-store.ts src/lib/deep-link.ts
git commit -m "refactor(auth-store): hydrate via AccountManager; register account on sign-in"
```

### Task E4: Wire `AccountManager.bootstrap()` into `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the bootstrap step before `initialize()`**

Replace the `useEffect`'s opening block:

```ts
useEffect(() => {
  (async () => {
    try {
      await getAccountManager().bootstrap();
    } catch (e) {
      console.error('[App] AccountManager.bootstrap failed', e);
    }
    initialize();
    useAiStore.getState().initialize().catch(console.error);
    useActionsStore.getState().load().catch(console.error);
    initDeepLinkHandler().catch(console.error);
  })();
  // ...rest of effect (close handler) unchanged
}, [initialize]);
```

Add the import:

```ts
import { getAccountManager } from '@/lib/accounts/account-manager';
```

- [ ] **Step 2: Manual smoke test**

`npm run tauri dev`. Sign in once with a test account. Inspect `<appLocalData>/notter-ai/accounts/index.json` and confirm the user is registered with id, email, addedAt. Inspect Windows Credential Manager → Generic Credentials → search "notter-ai" — the refresh_token and mcp_token entries should be visible.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): bootstrap AccountManager before auth init"
```

---

## Phase F — Per-store `reset()` + path/key namespacing

Each store gains a `reset()` method that returns its slice to factory-default state. A central registry collects these so `signOut()` and (later) `switchAccount()` can purge state with one call. Persistence paths and localStorage keys also start carrying the active account id.

### Task F1: Store registry

**Files:**
- Create: `src/lib/accounts/store-registry.ts`

- [ ] **Step 1: Implement registry**

```ts
// src/lib/accounts/store-registry.ts

/**
 * Stores register themselves at module load. signOut() and switchAccount()
 * call resetAllStores() to purge state. Each store's `reset()` is
 * synchronous on the in-memory state; persistence is handled separately.
 */
type Resetter = () => void;
const resetters: Resetter[] = [];

export function registerResettableStore(reset: Resetter): void {
  resetters.push(reset);
}

export function resetAllStores(): void {
  for (const r of resetters) {
    try { r(); } catch (e) { console.error('[store-registry] reset failed', e); }
  }
}

export function _clearForTests(): void {
  resetters.length = 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/accounts/store-registry.ts
git commit -m "feat(accounts): add resettable-store registry"
```

### Task F2–F6: Add `reset()` to each store + register

For each store, the recipe is the same:
1. Add `reset(): void` to the state interface.
2. Implement it as `set({ ...factoryDefaults })`.
3. Cancel any in-flight debounce (`xxxSync.flush()` or just `clearTimeout(timer)` for non-makeDebouncedSync timers like the per-project board save timers).
4. After the store factory `create<...>(...)`, call `registerResettableStore(() => useXxxStore.getState().reset())`.

#### Task F2: `actions-store.reset()`

- [ ] **Step 1: Add to the interface**

In `ActionsState`:

```ts
reset(): void;
```

- [ ] **Step 2: Implement**

Inside the `create<ActionsState>(...)` factory:

```ts
reset: () => {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; pendingPersistArgs = null; }
  set({
    actions: [],
    selectedActionId: null,
    loaded: false,
  });
},
```

- [ ] **Step 3: Register**

After the `export const useActionsStore = create...` block:

```ts
import { registerResettableStore } from '@/lib/accounts/store-registry';
registerResettableStore(() => useActionsStore.getState().reset());
```

- [ ] **Step 4: Commit**

```bash
git add src/stores/actions-store.ts
git commit -m "feat(actions-store): reset() + registry"
```

#### Task F3: `board-store.reset()`

- [ ] **Step 1–4** Same recipe. Reset state:

```ts
reset: () => {
  for (const k of Object.keys(saveTimers)) { clearTimeout(saveTimers[k]); delete saveTimers[k]; }
  set({ tasks: [], selectedTaskId: null });
},
```

Register at module bottom and commit.

#### Task F4: `planner-store.reset()`

- [ ] **Step 1–4** Reset state:

```ts
reset: () => {
  set({
    projects: [],
    selectedProject: null,
    subjects: [],
    selectedSubject: null,
    subjectContent: '# Nova Anotação',
    isViewing: false,
  });
},
```

(Keeps `bgColors`, `_activeTheme` — those are user UI prefs, not per-account.)

#### Task F5: `agents-store.reset()`

```ts
reset: () => {
  set({
    profiles: [],
    selectedProfileId: null,
    chatMessages: {},
    chatLoading: false,
  });
},
```

#### Task F6: `app-store.reset()`

`app-store` holds preferences that are mostly account-scoped (via `user_preferences`) plus the active tab. Reset just the account-scoped slice:

```ts
reset: () => {
  // activeTab, terminalSettings keep their value: those are UI preferences
  // hydrated from the new account on syncOnLogin.
  set({
    darkMode: document.documentElement.classList.contains('dark'),
    language: 'en',
  });
},
```

After all five tasks, run `npm run test` to confirm no regressions.

### Task F7: `signOut` resets all stores

**Files:**
- Modify: `src/stores/auth-store.ts:signOut`

- [ ] **Step 1: Call `resetAllStores()` after signOut succeeds**

```ts
signOut: async () => {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();
  await supabase.auth.signOut();
  await getAccountManager().setActiveAccountId(null);
  set({ user: null, session: null });
  resetAllStores();
},
```

Add the import:

```ts
import { resetAllStores } from '@/lib/accounts/store-registry';
```

- [ ] **Step 2: Manual smoke**

Sign in. Create a board task and a project. Sign out. Confirm the planner tab shows zero projects and the board tab shows zero tasks WITHOUT a page reload.

- [ ] **Step 3: Commit**

```bash
git add src/stores/auth-store.ts
git commit -m "fix(auth): reset all stores on signOut to clear in-memory account state"
```

### Task F8: Per-account fs path namespacing

Today's stores write to `NotterProjects/...`, `AgentProfiles/...`, `actions.json`, `board.json` directly under `<appLocalData>`. After Phase G's migration runs, those paths live under `<appLocalData>/notter-ai/<accountId>/...`. Stores need a small helper to compute the per-account prefix, and we need to thread it through every fs call.

**Files:**
- Create: `src/lib/accounts/account-paths.ts`
- Modify: `src/stores/board-store.ts`, `src/stores/planner-store.ts`, `src/stores/agents-store.ts`, `src/stores/actions-store.ts`

- [ ] **Step 1: Implement the path helper**

```ts
// src/lib/accounts/account-paths.ts
import { getAccountManager } from './account-manager';

/**
 * Returns `notter-ai/<accountId>` joined with the supplied relative path.
 * Throws if no account is active — callers must check before invoking
 * (typically by gating fs reads on `activeAccountId !== null`).
 */
export function accountScopedPath(rel: string): string {
  const id = getAccountManager().activeAccountId;
  if (!id) throw new Error('accountScopedPath: no active account');
  // Trim a leading slash from rel to avoid `notter-ai/<id>//foo`.
  const trimmed = rel.replace(/^[\\/]+/, '');
  return `notter-ai/${id}/${trimmed}`;
}

/**
 * Like accountScopedPath but returns null instead of throwing when no
 * account is active. Useful for "load on app boot" calls that may run
 * before sign-in.
 */
export function tryAccountScopedPath(rel: string): string | null {
  const id = getAccountManager().activeAccountId;
  if (!id) return null;
  const trimmed = rel.replace(/^[\\/]+/, '');
  return `notter-ai/${id}/${trimmed}`;
}
```

- [ ] **Step 2: Update each store to use the helper**

For each store: replace every literal `'NotterProjects/...'`, `'AgentProfiles/...'`, `'board.json'`, and the `actions.json` path computation with calls to `accountScopedPath(...)` (or `tryAccountScopedPath` followed by an early return if null).

**`board-store.ts`** — every `'NotterProjects/${...}/${BOARD_FILE}'` becomes `accountScopedPath(\`NotterProjects/${...}/${BOARD_FILE}\`)`. The `loadAllBoards` and `loadProjectBoard` calls need to early-return when `tryAccountScopedPath` returns null.

**`planner-store.ts`** — same. The `PROJECTS_FILE` constant becomes a function, or every reference computes the path on demand.

**`agents-store.ts`** — same for `PROFILES_FILE`.

**`actions-store.ts`** — `getActionsPath()` already uses `appLocalDataDir() + 'actions.json'`. Change it to:

```ts
async function getActionsPath(): Promise<string> {
  const dir = await appLocalDataDir();
  const id = getAccountManager().activeAccountId;
  if (!id) throw new Error('getActionsPath: no active account');
  return join(dir, 'notter-ai', id, FILE_NAME);
}
```

Each store must also gate its `load()` call: if `activeAccountId` is null, the load is a no-op (the data will load when an account is selected). The `subscribe`-on-account-change wiring is added in Phase H once switchAccount exists.

- [ ] **Step 3: Smoke + commit**

`npm run test` — should still pass (tests mock fs, so path string changes are inert there).

```bash
git add src/lib/accounts/account-paths.ts src/stores/board-store.ts src/stores/planner-store.ts src/stores/agents-store.ts src/stores/actions-store.ts
git commit -m "feat(stores): scope all fs paths under notter-ai/<accountId>/..."
```

---

## Phase G — Filesystem migration (sentinel-based, idempotent)

On first launch after upgrade, move legacy single-account data into the per-account layout. Idempotency comes from a sentinel file written ONLY after every move succeeds.

### Task G1: Implement the migration

**Files:**
- Create: `src/lib/accounts/fs-migration.ts`
- Create: `src/lib/accounts/__tests__/fs-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/accounts/__tests__/fs-migration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = {
  exists: vi.fn(),
  readDir: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn(),
  BaseDirectory: { AppLocalData: 1 },
};
vi.mock('@tauri-apps/plugin-fs', () => fsMock);

import { migrateLegacyLayoutIfNeeded, SENTINEL_PATH } from '@/lib/accounts/fs-migration';

beforeEach(() => vi.clearAllMocks());

describe('migrateLegacyLayoutIfNeeded', () => {
  it('skips when the sentinel already exists', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === SENTINEL_PATH);
    const result = await migrateLegacyLayoutIfNeeded('u1');
    expect(result.skipped).toBe(true);
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it('moves NotterProjects, AgentProfiles, exec-state, tmp-prompts into notter-ai/<id>/', async () => {
    fsMock.exists.mockImplementation(async (p: string) => {
      if (p === SENTINEL_PATH) return false;
      return ['NotterProjects', 'AgentProfiles', 'exec-state', 'tmp-prompts', 'actions.json'].includes(p);
    });
    fsMock.readDir.mockResolvedValue([]);
    const result = await migrateLegacyLayoutIfNeeded('u1');
    expect(result.skipped).toBe(false);
    expect(result.moved.sort()).toEqual(['AgentProfiles', 'NotterProjects', 'actions.json', 'exec-state', 'tmp-prompts']);
    for (const dir of ['NotterProjects', 'AgentProfiles', 'exec-state', 'tmp-prompts', 'actions.json']) {
      expect(fsMock.rename).toHaveBeenCalledWith(dir, `notter-ai/u1/${dir}`, expect.any(Object));
    }
    // Sentinel written LAST
    const writeOrder = fsMock.writeTextFile.mock.calls.map((c: any[]) => c[0]);
    expect(writeOrder[writeOrder.length - 1]).toBe(SENTINEL_PATH);
  });

  it('does not write sentinel if any rename fails', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p !== SENTINEL_PATH);
    fsMock.rename.mockRejectedValueOnce(new Error('EBUSY'));
    const result = await migrateLegacyLayoutIfNeeded('u1');
    expect(result.skipped).toBe(false);
    expect(result.failed.length).toBeGreaterThan(0);
    const writes = fsMock.writeTextFile.mock.calls.map((c: any[]) => c[0]);
    expect(writes).not.toContain(SENTINEL_PATH);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- fs-migration`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/accounts/fs-migration.ts
import {
  BaseDirectory, exists, mkdir, rename, writeTextFile,
} from '@tauri-apps/plugin-fs';

export const SENTINEL_PATH = 'notter-ai/.migration-v1-complete';

const LEGACY_PATHS = [
  'NotterProjects',
  'AgentProfiles',
  'exec-state',
  'tmp-prompts',
  'actions.json',
];

export interface MigrationResult {
  skipped: boolean;             // true when sentinel already present
  moved: string[];
  failed: { path: string; error: string }[];
}

export async function migrateLegacyLayoutIfNeeded(accountId: string): Promise<MigrationResult> {
  const opts = { baseDir: BaseDirectory.AppLocalData };
  if (await exists(SENTINEL_PATH, opts)) {
    return { skipped: true, moved: [], failed: [] };
  }
  await mkdir(`notter-ai/${accountId}`, { ...opts, recursive: true });

  const moved: string[] = [];
  const failed: { path: string; error: string }[] = [];

  for (const legacy of LEGACY_PATHS) {
    if (!(await exists(legacy, opts))) continue;
    const target = `notter-ai/${accountId}/${legacy}`;
    try {
      await rename(legacy, target, {
        oldPathBaseDir: BaseDirectory.AppLocalData,
        newPathBaseDir: BaseDirectory.AppLocalData,
      });
      moved.push(legacy);
    } catch (e: any) {
      failed.push({ path: legacy, error: e?.message ?? String(e) });
    }
  }

  if (failed.length === 0) {
    // Write sentinel ONLY after every move succeeds. A partial migration
    // (some moves done, some failed) leaves NO sentinel so the next launch
    // re-tries the failures. Already-moved paths skip via the exists() check.
    await writeTextFile(
      SENTINEL_PATH,
      JSON.stringify({ migratedAt: new Date().toISOString(), accountId, moved }, null, 2),
      opts,
    );
  }

  return { skipped: false, moved, failed };
}
```

- [ ] **Step 4: Verify tests pass + commit**

Run: `npm run test -- fs-migration`
Expected: PASS.

```bash
git add src/lib/accounts/fs-migration.ts src/lib/accounts/__tests__/fs-migration.test.ts
git commit -m "feat(accounts): sentinel-gated legacy layout migration"
```

### Task G2: Wire the migration into App boot

The migration runs ONLY if there is exactly one account in the index AND the sentinel is missing — that's the "fresh upgrade from single-account layout" case. With zero accounts (first install) or 2+ accounts (already multi-account), the migration is a no-op.

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the migration call**

After `await getAccountManager().bootstrap();` and before `initialize()`:

```ts
const mgr = getAccountManager();
const list = mgr.list();
if (list.length === 1 && mgr.activeAccountId) {
  const result = await migrateLegacyLayoutIfNeeded(mgr.activeAccountId);
  if (!result.skipped && result.failed.length > 0) {
    toast.error(
      `Filesystem migration partial — ${result.failed.length} item(s) could not be moved. See logs.`,
      { duration: 10_000 },
    );
    console.warn('[App] fs migration failures:', result.failed);
  }
}
```

Add imports:

```ts
import { migrateLegacyLayoutIfNeeded } from '@/lib/accounts/fs-migration';
import { toast } from 'sonner';
```

- [ ] **Step 2: Manual verification**

This is the trickiest piece to verify. Steps:
1. Stash all changes; check out the previous main commit (single-account layout).
2. Run the app, sign in, create a project + a board task, exit.
3. Confirm `<appLocalData>/com.guilh.notterai/NotterProjects/...` exists as legacy data.
4. Switch back to the M1 branch, run `npm run tauri dev`.
5. Confirm:
   - `<appLocalData>/.../notter-ai/<accountId>/NotterProjects/...` now exists
   - `<appLocalData>/.../notter-ai/.migration-v1-complete` exists
   - No `NotterProjects`, `AgentProfiles`, etc. at the legacy root anymore
6. Restart the app — confirm migration is skipped (no console output about moves).

If you don't have legacy data on the test machine, fake it: manually create empty `NotterProjects/` and `AgentProfiles/` dirs at `<appLocalData>` before running M1, then verify they end up under `notter-ai/<id>/`.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): run sentinel-gated fs migration on boot when legacy layout detected"
```

---

## Phase H — `AccountSwitcher` UI + full `switchAccount` flow

### Task H1: `AccountManager.switchAccount` (non-destructive ordered flow)

**Files:**
- Modify: `src/lib/accounts/account-manager.ts`
- Modify: `src/lib/accounts/__tests__/account-manager.test.ts`

The flow is spec §5.4: validate → acquire → commit. Nothing destructive happens before `setSession` succeeds.

- [ ] **Step 1: Add a failing test for the happy path and the failure path**

Append to `account-manager.test.ts`:

```ts
import { _clearForTests } from '@/lib/accounts/store-registry';

const supabaseMock = {
  auth: {
    setSession: vi.fn(),
  },
};
vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock, isSupabaseConfigured: true }));
vi.mock('@/lib/accounts/store-registry', () => ({
  resetAllStores: vi.fn(),
  registerResettableStore: vi.fn(),
  _clearForTests: vi.fn(),
}));
vi.mock('@/lib/realtime', () => ({
  startRealtimeSync: vi.fn(),
  stopRealtimeSync: vi.fn(),
}));

const secureGetMock = vi.fn();
vi.mock('@/lib/accounts/secure-store', async () => {
  const actual = await vi.importActual<any>('@/lib/accounts/secure-store');
  return {
    ...actual,
    secureGet: secureGetMock,
    secureSet: vi.fn().mockResolvedValue(undefined),
    secureDelete: vi.fn().mockResolvedValue(undefined),
    secureRegisterKnownKeys: vi.fn().mockResolvedValue(undefined),
  };
});

describe('AccountManager.switchAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMock.readAccountIndex.mockResolvedValue({
      accounts: [
        { id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
        { id: 'u2', email: 'b@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
      ],
    });
    storageMock.readActiveAccount.mockResolvedValue({ accountId: 'u1' });
  });

  it('throws immediately when no refresh token is stored (no state change)', async () => {
    secureGetMock.mockResolvedValueOnce(null);
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await expect(mgr.switchAccount('u2')).rejects.toThrow(/session expired/i);
    expect(supabaseMock.auth.setSession).not.toHaveBeenCalled();
    expect(mgr.activeAccountId).toBe('u1');
  });

  it('throws and leaves state untouched when setSession fails', async () => {
    secureGetMock.mockResolvedValueOnce('rt-u2');
    supabaseMock.auth.setSession.mockResolvedValueOnce({ data: null, error: { message: 'invalid' } });
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await expect(mgr.switchAccount('u2')).rejects.toThrow(/invalid/);
    expect(mgr.activeAccountId).toBe('u1');
  });

  it('on success, resets stores then writes the new active pointer last', async () => {
    secureGetMock.mockResolvedValueOnce('rt-u2');
    supabaseMock.auth.setSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'u2' }, refresh_token: 'rt-u2', access_token: 'at-u2' } },
      error: null,
    });
    const { resetAllStores } = await import('@/lib/accounts/store-registry');
    const { stopRealtimeSync, startRealtimeSync } = await import('@/lib/realtime');

    const mgr = new AccountManager();
    await mgr.bootstrap();
    await mgr.switchAccount('u2');

    // Order: stopRealtimeSync → resetAllStores → startRealtimeSync → writeActiveAccount
    expect(stopRealtimeSync).toHaveBeenCalled();
    expect(resetAllStores).toHaveBeenCalled();
    expect(startRealtimeSync).toHaveBeenCalledWith('u2');
    expect(storageMock.writeActiveAccount).toHaveBeenCalledWith({ accountId: 'u2' });
    expect(mgr.activeAccountId).toBe('u2');
  });
});
```

- [ ] **Step 2: Implement `switchAccount`**

Add to `AccountManager`:

```ts
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { resetAllStores } from '@/lib/accounts/store-registry';
import { startRealtimeSync, stopRealtimeSync } from '@/lib/realtime';
import { secureGet, accountKeys } from '@/lib/accounts/secure-store';

// inside class AccountManager { ... }

async switchAccount(targetId: string): Promise<void> {
  if (!isSupabaseConfigured) throw new Error('Supabase not configured');
  if (!this.accounts.some((a) => a.id === targetId)) {
    throw new Error(`Unknown account ${targetId}`);
  }
  if (this.active === targetId) return; // no-op

  // 1. Validate — read refresh token
  const refreshToken = await secureGet(accountKeys.refreshToken(targetId));
  if (!refreshToken) {
    throw new Error('session expired, please re-login this account');
  }

  // 2. Acquire — set the new session. The custom storage adapter will write
  //    to notter:<targetId>:sb-... once we update activeAccountId, but
  //    setSession itself touches in-memory state first. We update activeAccountId
  //    BEFORE setSession so the storage adapter writes to the right namespace.
  const previousActive = this.active;
  this.active = targetId;
  const { data, error } = await supabase.auth.setSession({
    access_token: '',
    refresh_token: refreshToken,
  });
  if (error || !data.session) {
    // Revert in-memory active id; nothing was committed yet (no reset, no realtime).
    this.active = previousActive;
    throw new Error(error?.message ?? 'setSession failed');
  }

  // 3. Commit — only after setSession succeeds.
  stopRealtimeSync();
  resetAllStores();
  // syncOnLogin triggers store rehydration. Imported lazily to avoid a
  // module cycle (auth-store imports account-manager).
  const { syncOnLogin } = await import('@/stores/auth-store');
  await syncOnLogin(targetId);
  startRealtimeSync(targetId);

  // 4. Update active pointer LAST — canonical "switch happened" marker.
  await writeActiveAccount({ accountId: targetId });
}
```

Add the import for `writeActiveAccount`:

```ts
import { readAccountIndex, writeAccountIndex, readActiveAccount, writeActiveAccount } from './account-storage';
```

- [ ] **Step 3: Run tests + commit**

Run: `npm run test -- account-manager`
Expected: PASS.

```bash
git add src/lib/accounts/account-manager.ts src/lib/accounts/__tests__/account-manager.test.ts
git commit -m "feat(accounts): switchAccount — validate → acquire → commit (no rollback needed)"
```

### Task H2: AuthDialog supports `add-account` mode

**Files:**
- Modify: `src/components/AuthDialog.tsx`

- [ ] **Step 1: Add `mode` prop**

Find the `AuthDialog` component. Add to its props:

```ts
interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'sign-in' | 'add-account';
}
```

When `mode === 'add-account'`, the dialog title should read "Add account" and the success path should NOT navigate away — the AccountManager.add() registration in `signInWithEmail` / OAuth callback already handles the account-add side. The dialog just needs to close.

The exact UI changes are minimal:
- Replace the dialog title `t('auth.title')` with: `mode === 'add-account' ? t('accounts.add') : t('auth.title')`
- After successful sign-in, switch the active account: the `signInWithEmail` flow above already calls `mgr.setActiveAccountId(...)`, which is what we want when adding a new account too. So no behavior change is required — only the label.

- [ ] **Step 2: Commit**

```bash
git add src/components/AuthDialog.tsx
git commit -m "feat(auth-dialog): support add-account mode (label only)"
```

### Task H3: `AccountSwitcher` component

**Files:**
- Create: `src/components/AccountSwitcher.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/AccountSwitcher.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, UserPlus, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { getAccountManager } from '@/lib/accounts/account-manager';
import type { AccountSummary } from '@/lib/accounts/types';
import { useAuthStore } from '@/stores/auth-store';

interface Props {
  onAddAccount: () => void;
  onClose: () => void;
}

export function AccountSwitcher({ onAddAccount, onClose }: Props) {
  const { t } = useTranslation();
  const mgr = getAccountManager();
  const [accounts, setAccounts] = useState<AccountSummary[]>(mgr.list());
  const [activeId, setActiveId] = useState<string | null>(mgr.activeAccountId);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    setAccounts(mgr.list());
    setActiveId(mgr.activeAccountId);
  }, [user?.id]);

  const handleSwitch = async (id: string) => {
    if (id === activeId) return;
    setSwitchingId(id);
    try {
      await mgr.switchAccount(id);
      setActiveId(mgr.activeAccountId);
      toast.success(t('accounts.signed_in_as', { email: mgr.get(id)?.email ?? id }));
      onClose();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/session expired/i.test(msg)) {
        toast.error(t('accounts.session_expired'));
      } else {
        toast.error(t('accounts.switch_failed'));
      }
    } finally {
      setSwitchingId(null);
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm(t('accounts.confirm_remove'))) return;
    try {
      await mgr.remove(id);
      setAccounts(mgr.list());
    } catch (e: any) {
      toast.error(String(e?.message ?? e));
    }
  };

  return (
    <div className="py-1">
      {accounts.length === 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {t('accounts.none')}
        </div>
      )}
      {accounts.map((a) => {
        const isActive = a.id === activeId;
        const isSwitching = switchingId === a.id;
        return (
          <div key={a.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-muted">
            <button
              onClick={() => handleSwitch(a.id)}
              disabled={isSwitching}
              className="flex-1 flex items-center gap-2 text-left text-sm text-foreground"
            >
              {isSwitching ? <Loader2 size={14} className="animate-spin" /> :
                isActive ? <Check size={14} className="text-primary" /> : <span className="w-3.5" />}
              <span className="truncate">{a.email}</span>
            </button>
            {!isActive && (
              <button
                onClick={() => handleRemove(a.id)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                title={t('accounts.remove')}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        );
      })}
      <div className="border-t border-border my-1" />
      <button
        onClick={onAddAccount}
        className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted"
      >
        <UserPlus size={14} />
        {t('accounts.add')}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountSwitcher.tsx
git commit -m "feat(ui): AccountSwitcher dropdown component"
```

### Task H4: Embed `AccountSwitcher` in `UserMenu`

**Files:**
- Modify: `src/components/UserMenu.tsx`

- [ ] **Step 1: Add the AccountSwitcher above the existing user actions**

Insert between the "logged in as" row (after line 100) and the "Settings" button. Wrap in a collapsible panel with a "Switch account" header. The simplest version: always render the switcher when the user is signed in.

Insert this after the "logged in as" block:

```tsx
{user && (
  <>
    <AccountSwitcher
      onAddAccount={() => {
        setOpen(false);
        // Open the AuthDialog in add-account mode
        setAddAccountOpen(true);
      }}
      onClose={() => setOpen(false)}
    />
    <div className="border-t border-border my-1" />
  </>
)}
```

Add the local state at the top:

```ts
const [addAccountOpen, setAddAccountOpen] = useState(false);
```

Add the dialog at the bottom (alongside the existing AuthDialog):

```tsx
<AuthDialog open={addAccountOpen} onOpenChange={setAddAccountOpen} mode="add-account" />
```

Add the import:

```ts
import { AccountSwitcher } from '@/components/AccountSwitcher';
```

- [ ] **Step 2: Smoke test**

`npm run tauri dev`. Sign in. Open the user menu — the AccountSwitcher should show one row with a checkmark next to your email. Click "Add account" — the AuthDialog should open with the "Add account" title. Sign in with a second test account. After sign-in completes, the new account should appear in the switcher with a checkmark (it became active).

Click the original account in the switcher → confirm a "Signed in as ..." toast appears, the email in the menu changes, and the planner/board tabs reset to the original account's data.

- [ ] **Step 3: Commit**

```bash
git add src/components/UserMenu.tsx
git commit -m "feat(ui): embed AccountSwitcher in UserMenu"
```

### Task H5: i18n keys

**Files:**
- Modify: `src/i18n/locales/en.json`, `src/i18n/locales/pt-BR.json` (or whichever paths the existing i18n setup uses — find via `Glob src/i18n/**/*.json`)

- [ ] **Step 1: Add the new keys**

Add under a new `accounts` namespace in each locale file:

en:
```json
"accounts": {
  "add": "Add account",
  "switch": "Switch account",
  "remove": "Remove",
  "confirm_remove": "Remove this account from this device? You can sign in again later.",
  "none": "No accounts yet",
  "signed_in_as": "Signed in as {{email}}",
  "session_expired": "Session expired — please re-sign-in this account.",
  "switch_failed": "Failed to switch account",
  "fs_migration_partial": "Filesystem migration partial — see logs"
}
```

pt-BR (translations):
```json
"accounts": {
  "add": "Adicionar conta",
  "switch": "Trocar de conta",
  "remove": "Remover",
  "confirm_remove": "Remover esta conta deste dispositivo? Você poderá entrar novamente mais tarde.",
  "none": "Nenhuma conta ainda",
  "signed_in_as": "Conectado como {{email}}",
  "session_expired": "Sessão expirada — entre novamente nesta conta.",
  "switch_failed": "Falha ao trocar de conta",
  "fs_migration_partial": "Migração de arquivos parcial — ver logs"
}
```

- [ ] **Step 2: Commit**

```bash
git add src/i18n/
git commit -m "i18n: add accounts.* keys (en + pt-BR)"
```

---

## Phase I — End-to-end verification

### Task I1: Manual smoke test script

Run through these steps with two real Supabase test users (create them via the dashboard if needed):

- [ ] **A. Fresh single-account upgrade**
  1. Stash this branch; check out `main`. Sign in once with `user-a@test`. Create one project + one board task. Quit.
  2. Confirm `<appLocalData>/com.guilh.notterai/NotterProjects/...` exists.
  3. Switch back to the M1 branch. Run `npm run tauri dev`.
  4. Confirm:
     - `notter-ai/.migration-v1-complete` exists.
     - `notter-ai/<user-a-id>/NotterProjects/...` exists.
     - The legacy `NotterProjects` at the root is gone.
     - The planner tab shows the same project, the board tab shows the same task.

- [ ] **B. Add second account**
  1. Open user menu → "Add account". Sign in with `user-b@test`.
  2. Confirm `accounts/index.json` has two entries.
  3. Confirm Windows Credential Manager shows four `notter-ai` entries (refresh + mcp for both users).
  4. Confirm the planner/board reset to user-b's empty state.

- [ ] **C. Switch back to first account**
  1. Open user menu → click `user-a@test` row.
  2. Confirm "Signed in as user-a@test" toast.
  3. Confirm the planner shows user-a's project and the board shows user-a's task within ~2s.
  4. Confirm `accounts/active.json` now shows `user-a-id`.

- [ ] **D. Session-expired path**
  1. Open Windows Credential Manager. Delete `notter:account:<user-b-id>:refresh_token`.
  2. Open the user menu → click `user-b@test`.
  3. Confirm a "Session expired — please re-sign-in this account" toast appears.
  4. Confirm the active account did NOT change (planner still shows user-a's data).

- [ ] **E. Sign out + sign in again**
  1. Sign out from the user menu.
  2. Confirm `accounts/active.json` has `accountId: null`.
  3. Confirm planner/board are empty.
  4. Sign in with user-a again.
  5. Confirm data reappears.

- [ ] **F. App close persistence**
  1. Sign in. Edit an agent profile name. Within 500ms (before the 1s debounce fires), close the window.
  2. Reopen. Confirm the new name persisted in Supabase (check the dashboard).
  3. Repeat for project name (planner) and board task title (board).

### Task I2: Final cleanup pass

- [ ] **Step 1: Confirm legacy dead code removed where safe**

`grep -r "queueWorkerStarted" src/` should return zero results.

`grep -rn "DELETE.*FROM.*WHERE.*user_id" src/lib/sync.ts` should return zero results (the destructive delete-then-insert pattern is gone).

- [ ] **Step 2: Run the full test suite**

```bash
npm run test
```

Expected: PASS, no skips.

- [ ] **Step 3: Type-check**

```bash
npm run build
```

Expected: PASS — `tsc` clean.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A
git status   # confirm only intended files
git commit -m "chore(m1): final cleanup pass"
```

---

## What M1 deliberately does NOT include

| Surface | Why deferred |
|---|---|
| `PlanStore`, `plan_versions` schema, Plan UI | M2 scope. |
| Rust `axum` MCP server | M3 scope. The per-account `mcp_token` is generated and persisted in M1; the consumer arrives in M3. |
| Import / export markdown | M4 scope. |
| Realtime collaboration | Phase 3 (post-Phase-1). |
| Mermaid / image rendering | Phase 4. |
| Stale-MCP-endpoint health check round-trip | Phase 3 (the design is documented in spec §6.1 and a TODO comment in `mcp-endpoint.ts` if/when that file lands in M3). |
| Front-end → Rust MCP token push (Tauri command) | M3 — the broadcast `emit('mcp:account-token-refreshed', ...)` is wired in `supabase.ts` (Task E2) but no listener exists yet; that is by design. |
| Deletion of `src/lib/planning/`, parts of `src/lib/llm/` | M2 scope. |

---

## Open items expected to surface during execution

- Whether the existing `projects` table has an `id` column already (Task B2 step 2). If yes, skip the migration; if no, apply the migration noted in B2 first.
- Whether the project's i18n setup uses `src/i18n/locales/<lang>.json` or a different layout (Task H5). Adjust paths in that task accordingly.
- Whether `keyring = "3"` builds clean on Linux without explicit `libdbus-dev`. If not, add a README install hint or pin to a feature-gated variant.
- Whether `flushActionsStore` should be folded into a generic `flushAllStores` helper that the App close handler calls. The current plan keeps `flushActionsStore` exported for backward compat (it's already called explicitly in tests).

---

## Self-review notes

This plan covers spec §7 M1 verbatim. Spec §5.4 is implemented in Task H1 (`switchAccount` ordered as validate→acquire→commit). Spec §5.2 fs layout (`<appLocalData>/notter-ai/<accountId>/...`) is implemented in Task F8 (path scoping) + Task G1 (migration). Spec §5.3 (Zustand key namespacing via `notter:<accountId>:...`) is implemented in Task E1 (the storage adapter applies the prefix) — note that today only the Supabase auth session lands in localStorage; if M2 adds Zustand persistence to localStorage, those stores must use the same namespacing helper. Spec §6.2 token-refresh broadcast hook is implemented in Task E2 (the `emit` call); the listener is M3 work and explicitly out of scope here.

Two PATHFINDER System 1 surfaces are NOT in this plan because they are explicitly out of M1 scope per §7 / coexistence map: the v1 PTY runner retirement and the planning-pipeline / actions-store helper extractions. Those are PATHFINDER handoff prompts 6 and 2/3 respectively, run after M2.
