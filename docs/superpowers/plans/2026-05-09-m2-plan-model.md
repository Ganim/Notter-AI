# M2 — Plan Model + UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land M2 of the Phase 1 pivot — Notter-AI gains a first-class plan document model: a Supabase schema (`plans`, `plan_versions`, `plan_comments`), a `PlanStore` (Zustand) built on the M1 `SyncedStore` primitives, four new UI components (`PlanList`, `PlanEditor`, `SnapshotPanel`, `CommentsPanel`), a one-shot subjects→plans data migration, and deletion of the now-dead `planning-pipeline` code. M1 must be fully merged to `main` before M2 begins — the `SyncedStore` primitives (`upsertUserRows`, `subscribeUserTable`, `makeDebouncedSync`, `runOnce`) and per-account fs scoping (`accountScopedPath`, `registerResettableStore`) are M2's direct foundation.

**Architecture:** Bottom-up, same as M1:
1. **Schema + sync layer** — Supabase migration (`plans`, `plan_versions`, `plan_comments` tables with RLS + `set_plan_owner_id` trigger); `fetchPlans`/`pushPlans`, `fetchPlanVersions`/`pushPlanVersion`, `fetchPlanComments`/`pushPlanComment` functions added to `src/lib/sync.ts`; `plans`, `plan_versions`, `plan_comments` wired into `realtime.ts` via `subscribeUserTable`.
2. **`PlanStore`** — Zustand store at `src/stores/plan-store.ts`. Slices: `plans[]`, `currentPlanId`, `workingDraft`, `snapshots[]`, `comments[]`. Built on `makeDebouncedSync` (1s debounce for `working_content`), `upsertUserRows` for inserts, `registerResettableStore` for account-switch resets, and `accountScopedPath` for the local cache file.
3. **UI components** — `PlanList`, `PlanEditor` (Monaco), `SnapshotPanel`, `CommentsPanel` in `src/components/plans/`; assembled into a new `PlansTab` wired into `App.tsx` alongside the existing `PlannerTab` (which becomes read-only with a migration banner).
4. **One-shot migration** — on first M2 launch per account, each `subjects` row becomes a `plan` row. Sentinel file prevents double-run. Legacy `PlannerTab` shows a banner.
5. **Deletion** — `src/lib/planning/` and `src/components/planning/` deleted; `src/lib/llm/*` workers audited and retirable exports removed.

**Tech Stack:** TypeScript / React / Zustand / Vitest / `@supabase/supabase-js` v2 / Monaco Editor (already a dep) / Tauri 2 (`@tauri-apps/plugin-fs`) / `src/lib/synced-store.ts` (M1) / `src/lib/accounts/*` (M1).

**Spec references:** `docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md` §5.1 (schema verbatim), §7 M2 (scope), §8 (coexistence map), §9 (error handling), §10 (testing). M1 foundation: `src/lib/synced-store.ts`, `src/lib/accounts/{types,secure-store,account-manager,account-storage,supabase-storage-adapter,account-paths,store-registry,fs-migration}.ts`, `src/components/AccountSwitcher.tsx`, `src-tauri/src/secure_store.rs`.

**Out of scope (do not drift):** Rust `axum` MCP server (M3). Import/export markdown (M4). `post_revision` / `post_comment` MCP tools (M3). `mcp:account-token-refreshed` listener stub (M3). Realtime collaboration (Phase 3). Mermaid rendering (Phase 4). Plan templates. Plan→subjects reverse migration. `PlanService` class or repository pattern — keep store + sync + components as the layered design. Per-line comment anchoring (version-scoped only). Deletion of `notter-mcp-server/` (Node, Phase 3 decision).

---

## File Structure

### New files

- `src/stores/plan-store.ts` — Zustand store: `plans[]`, `currentPlanId`, `workingDraft`, `snapshots[]`, `comments[]`. Debounced upsert on `working_content` (1s). `reset()` registered via `registerResettableStore`. `flush()` registered in `App.tsx` window-close handler.
- `src/stores/__tests__/plan-store.test.ts`
- `src/components/plans/PlanList.tsx` — list of plans; create/delete/select.
- `src/components/plans/PlanEditor.tsx` — Monaco markdown editor for working draft; 1s debounced upsert; "Snapshot" button.
- `src/components/plans/SnapshotPanel.tsx` — sidebar list of `plan_versions` for current plan; shows source + label + timestamp; "Snapshot now" button.
- `src/components/plans/CommentsPanel.tsx` — version-scoped comments; create/delete; resolve toggle.
- `src/components/PlansTab.tsx` — top-level tab component; assembles `PlanList` + `PlanEditor` + `SnapshotPanel` + `CommentsPanel`.
- `src/lib/plans/migration.ts` — one-shot subjects→plans migration; sentinel file `notter-ai/<accountId>/.migration-m2-plans-complete`.
- `src/lib/plans/__tests__/migration.test.ts`
- `supabase/migrations/2026-05-09-plan-model.sql` — full schema migration (verbatim from spec §5.1).

### Modified files

- `src/lib/sync.ts` — add `fetchPlans`, `pushPlans`, `fetchPlanVersions`, `pushPlanVersion`, `fetchPlanComments`, `pushPlanComment`. No existing functions removed.
- `src/lib/realtime.ts` — add `refetchPlans`, `refetchPlanVersions`, `refetchPlanComments` closures + three `subscribeUserTable` calls on the existing channel.
- `src/stores/auth-store.ts` — add `fetchPlans` call to `syncOnLogin`; add `PlanStore` reset to the reset chain; add plans flush.
- `src/App.tsx` — import `PlansTab` and `usePlanStore`; add `plans` key to the tab map; add `usePlanStore.getState().flush()` to the window-close handler.
- `src/i18n/locales/en.json` — new keys: `nav.plans`, `plans.new_plan`, `plans.delete_plan`, `plans.delete_confirm`, `plans.untitled`, `plans.snapshot_now`, `plans.snapshot_label_placeholder`, `plans.no_plans`, `plans.comment_placeholder`, `plans.resolve`, `plans.unresolve`, `plans.migrated_banner`, `plans.migrated_link`, `plans.source_user`, `plans.source_ai`, `plans.source_import`.
- `src/i18n/locales/pt-BR.json` — same keys translated.
- `src/components/PlannerTab.tsx` — add migration banner when `migrationComplete` sentinel is detected; set tab to read-only mode (disable save/create/delete interactions).

### Deleted files (Phase G — only after zero-callers verified)

- `src/lib/planning/index.ts`
- `src/lib/planning/orchestrator.ts`
- `src/lib/planning/prompts.ts`
- `src/lib/planning/schemas.ts`
- `src/lib/planning/stage-runner.ts`
- `src/lib/planning/types.ts`
- `src/lib/planning/stages/data-consistency.ts`
- `src/lib/planning/stages/extract.ts`
- `src/lib/planning/stages/prompt-critic.ts`
- `src/lib/planning/stages/security.ts`
- `src/lib/planning/__tests__/data-consistency.test.ts`
- `src/lib/planning/__tests__/extract.test.ts`
- `src/lib/planning/__tests__/orchestrator.test.ts`
- `src/lib/planning/__tests__/prompt-critic.test.ts`
- `src/lib/planning/__tests__/schemas.test.ts`
- `src/lib/planning/__tests__/security.test.ts`
- `src/lib/planning/__tests__/stage-runner.test.ts`
- `src/components/planning/PlanReviewPanel.tsx`
- `src/components/planning/PlanStageStrip.tsx`
- `src/components/planning/PlanWithAiButton.tsx`
- `src/components/planning/TaskCard.tsx`
- Retirable exports from `src/lib/llm/*` — determined by grep in Phase G.

### Phase order

| # | Phase | Scope | Lands |
|---|---|---|---|
| A | Supabase schema migration | single SQL migration file | first; no app code change |
| B | `sync.ts` fetchers + pushers | 6 new functions for 3 new tables | independent of UI |
| C | `PlanStore` (Zustand) + tests | store with slices, debounce, reset, flush | depends on B |
| D | Realtime listeners | wire 3 new tables into `realtime.ts` | depends on B + C |
| E | UI components + tab integration | `PlanList`, `PlanEditor`, `SnapshotPanel`, `CommentsPanel`, `PlansTab`, `App.tsx` wiring | depends on C |
| F | One-shot subjects→plans migration + Planner banner | `src/lib/plans/migration.ts`, sentinel, `PlannerTab` banner | depends on B + C |
| G | Delete `src/lib/planning/`, audit `src/lib/llm/*` | dead code removal | last; depends on all prior phases |
| H | End-to-end verification + cleanup | manual smoke + full test suite | last |

---

## Phase A — Supabase schema migration

This phase creates the three new tables with RLS and the `set_plan_owner_id` trigger. No app code changes. The SQL is verbatim from spec §5.1.

### Task A1: Write and apply the migration SQL

**Files:**
- Create: `supabase/migrations/2026-05-09-plan-model.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/2026-05-09-plan-model.sql

-- plans
create table plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled plan',
  working_content text not null default '',
  current_snapshot_id uuid, -- FK added after plan_versions exists
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plans_user_id_idx on plans(user_id);

-- plan_versions (append-only)
-- user_id is DENORMALIZED from plans.user_id — set by trigger on insert,
-- never updated. Avoids correlated-subquery RLS perf hit at scale.
create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content_markdown text not null,
  parent_version_id uuid references plan_versions(id) on delete set null,
  source text not null check (source in ('user', 'ai', 'import')),
  source_actor text,           -- 'claude-code' | 'codex' | null
  label text,                  -- optional human-readable name
  created_at timestamptz not null default now()
);
create index plan_versions_plan_id_idx on plan_versions(plan_id);
create index plan_versions_user_id_idx on plan_versions(user_id);

alter table plans
  add constraint plans_current_snapshot_fk
  foreign key (current_snapshot_id) references plan_versions(id) on delete set null;

-- plan_comments
-- user_id is DENORMALIZED plan owner (NOT necessarily comment author).
-- In Phase 1, author = owner always (no sharing). Phase 3 will revisit.
create table plan_comments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  version_id uuid not null references plan_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plan_comments_version_id_idx on plan_comments(version_id);
create index plan_comments_user_id_idx on plan_comments(user_id);

-- RLS: simple ownership check, no correlated subqueries.
alter table plans          enable row level security;
alter table plan_versions  enable row level security;
alter table plan_comments  enable row level security;

create policy "plans_user_isolation"    on plans         for all using (auth.uid() = user_id);
create policy "versions_user_isolation" on plan_versions for all using (auth.uid() = user_id);
create policy "comments_user_isolation" on plan_comments for all using (auth.uid() = user_id);

-- Trigger to denormalize user_id from plans → plan_versions / plan_comments on insert.
-- Keeps clients from having to compute it; prevents data drift.
create function set_plan_owner_id() returns trigger as $$
begin
  select user_id into new.user_id from plans where id = new.plan_id;
  if new.user_id is null then
    raise exception 'plan_id % not found', new.plan_id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger set_user_id_on_plan_versions
  before insert on plan_versions
  for each row execute function set_plan_owner_id();

create trigger set_user_id_on_plan_comments
  before insert on plan_comments
  for each row execute function set_plan_owner_id();
```

- [ ] **Step 2: Apply via the Supabase MCP tool**

Use `mcp__plugin_supabase_supabase__apply_migration` with the SQL above (or run `supabase db push` locally if you have the CLI set up against the project). Confirm no errors in the output.

- [ ] **Step 3: Verify tables in the dashboard**

Run `mcp__plugin_supabase_supabase__list_tables` and confirm `plans`, `plan_versions`, `plan_comments` appear. Spot-check that `plan_versions` has columns `id`, `plan_id`, `user_id`, `content_markdown`, `parent_version_id`, `source`, `source_actor`, `label`, `created_at`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-09-plan-model.sql
git commit -m "feat(schema): add plans, plan_versions, plan_comments tables with RLS + set_plan_owner_id trigger"
```

---

## Phase B — `sync.ts` fetchers + pushers

This phase adds six new functions to `src/lib/sync.ts` — two per table — following the exact same pattern as the existing `fetchBoardTasks`/`pushBoardTasks` pair. No existing code is changed.

### Task B1: Define local types for the three plan tables

**Files:**
- Modify: `src/lib/sync.ts` (add type exports near the top, after existing imports)

- [ ] **Step 1: Add types**

```ts
// src/lib/sync.ts — add after existing imports, before fetchPreferences

export interface PlanRecord {
  id: string;
  userId: string;
  title: string;
  workingContent: string;
  currentSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanVersionRecord {
  id: string;
  planId: string;
  userId: string;
  contentMarkdown: string;
  parentVersionId: string | null;
  source: 'user' | 'ai' | 'import';
  sourceActor: string | null;
  label: string | null;
  createdAt: string;
}

export interface PlanCommentRecord {
  id: string;
  planId: string;
  versionId: string;
  userId: string;
  authorUserId: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add PlanRecord, PlanVersionRecord, PlanCommentRecord types"
```

### Task B2: Add `fetchPlans` and `pushPlans`

**Files:**
- Modify: `src/lib/sync.ts` (append below the existing `fetchActions`/`pushActions` block)

- [ ] **Step 1: Add the functions**

```ts
// src/lib/sync.ts — append at the bottom

// ── Plans ─────────────────────────────────────────────────────────────

export async function fetchPlans(userId: string): Promise<PlanRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      title: row.title,
      workingContent: row.working_content,
      currentSnapshotId: row.current_snapshot_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch {
    return null;
  }
}

export async function pushPlans(userId: string, plans: PlanRecord[]): Promise<void> {
  await upsertUserRows('plans', userId, plans, (p) => ({
    id: p.id,
    user_id: userId,
    title: p.title,
    working_content: p.workingContent,
    current_snapshot_id: p.currentSnapshotId ?? null,
    updated_at: new Date().toISOString(),
  }));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add fetchPlans / pushPlans"
```

### Task B3: Add `fetchPlanVersions` and `pushPlanVersion`

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Add the functions**

```ts
// src/lib/sync.ts — append

// ── Plan Versions ─────────────────────────────────────────────────────

export async function fetchPlanVersions(
  planId: string,
): Promise<PlanVersionRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('plan_versions')
      .select('*')
      .eq('plan_id', planId)
      .order('created_at', { ascending: false });
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({
      id: row.id,
      planId: row.plan_id,
      userId: row.user_id,
      contentMarkdown: row.content_markdown,
      parentVersionId: row.parent_version_id ?? null,
      source: row.source as 'user' | 'ai' | 'import',
      sourceActor: row.source_actor ?? null,
      label: row.label ?? null,
      createdAt: row.created_at,
    }));
  } catch {
    return null;
  }
}

/**
 * Insert a single plan_version row. Uses a direct Supabase insert (not
 * upsertUserRows) because plan_versions are append-only — never updated.
 * The trigger set_user_id_on_plan_versions fills user_id server-side.
 */
export async function pushPlanVersion(
  version: Omit<PlanVersionRecord, 'userId' | 'createdAt'>,
): Promise<{ id: string } | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('plan_versions')
      .insert({
        id: version.id,
        plan_id: version.planId,
        content_markdown: version.contentMarkdown,
        parent_version_id: version.parentVersionId ?? null,
        source: version.source,
        source_actor: version.sourceActor ?? null,
        label: version.label ?? null,
      })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[sync] pushPlanVersion failed:', error);
      return null;
    }
    return { id: data.id };
  } catch (e) {
    console.error('[sync] pushPlanVersion threw:', e);
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add fetchPlanVersions / pushPlanVersion"
```

### Task B4: Add `fetchPlanComments` and `pushPlanComment`

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Add the functions**

```ts
// src/lib/sync.ts — append

// ── Plan Comments ─────────────────────────────────────────────────────

export async function fetchPlanComments(
  planId: string,
): Promise<PlanCommentRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('plan_comments')
      .select('*')
      .eq('plan_id', planId)
      .order('created_at', { ascending: true });
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({
      id: row.id,
      planId: row.plan_id,
      versionId: row.version_id,
      userId: row.user_id,
      authorUserId: row.author_user_id,
      body: row.body,
      resolved: row.resolved,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch {
    return null;
  }
}

/**
 * Upsert a single plan_comment row (covers create + resolve-toggle + edit).
 * The trigger set_user_id_on_plan_comments fills user_id server-side on INSERT.
 * On update (resolve toggle), send the full row so user_id is not clobbered.
 */
export async function pushPlanComment(
  comment: Omit<PlanCommentRecord, 'userId' | 'createdAt'> & { userId?: string },
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase.from('plan_comments').upsert({
      id: comment.id,
      plan_id: comment.planId,
      version_id: comment.versionId,
      author_user_id: comment.authorUserId,
      body: comment.body,
      resolved: comment.resolved,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error('[sync] pushPlanComment failed:', error);
  } catch (e) {
    console.error('[sync] pushPlanComment threw:', e);
  }
}

export async function deletePlanComment(commentId: string, userId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase
      .from('plan_comments')
      .delete()
      .eq('id', commentId)
      .eq('user_id', userId);
    if (error) console.error('[sync] deletePlanComment failed:', error);
  } catch (e) {
    console.error('[sync] deletePlanComment threw:', e);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): add fetchPlanComments / pushPlanComment / deletePlanComment"
```

---

## Phase C — `PlanStore` (Zustand) + tests

This phase introduces the central Zustand store for plans. It is built on the M1 primitives: `makeDebouncedSync` (1s debounce on `working_content`), `upsertUserRows` (for plan upserts), `registerResettableStore` (account-switch resets), and `accountScopedPath` (local cache). This phase uses TDD: failing tests first, then implementation.

### Task C1: Write failing tests for `PlanStore`

**Files:**
- Create: `src/stores/__tests__/plan-store.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// src/stores/__tests__/plan-store.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePlanStore } from '@/stores/plan-store';

// ── Shared mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase', () => {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const insert = vi.fn(() => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'v1' }, error: null }) }) }));
  const del = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
  const from = vi.fn((table: string) => ({
    upsert,
    insert,
    delete: del,
    select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  }));
  return { supabase: { from }, isSupabaseConfigured: true };
});

vi.mock('@/lib/sync', () => ({
  fetchPlans: vi.fn().mockResolvedValue([]),
  pushPlans: vi.fn().mockResolvedValue(undefined),
  fetchPlanVersions: vi.fn().mockResolvedValue([]),
  pushPlanVersion: vi.fn().mockResolvedValue({ id: 'v1' }),
  fetchPlanComments: vi.fn().mockResolvedValue([]),
  pushPlanComment: vi.fn().mockResolvedValue(undefined),
  deletePlanComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
}));

vi.mock('@/lib/accounts/store-registry', () => ({
  registerResettableStore: vi.fn(),
}));

vi.mock('@/lib/accounts/account-paths', () => ({
  tryAccountScopedPath: vi.fn(() => 'notter-ai/u1/cache/plans.json'),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PlanStore', () => {
  beforeEach(() => {
    usePlanStore.getState().reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty state', () => {
    const { plans, currentPlanId, workingDraft, snapshots, comments } = usePlanStore.getState();
    expect(plans).toEqual([]);
    expect(currentPlanId).toBeNull();
    expect(workingDraft).toBe('');
    expect(snapshots).toEqual([]);
    expect(comments).toEqual([]);
  });

  it('applyRemotePlans replaces the plans slice', () => {
    const remote = [
      { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' },
    ];
    usePlanStore.getState().applyRemotePlans(remote);
    expect(usePlanStore.getState().plans).toEqual(remote);
  });

  it('selectPlan sets currentPlanId and workingDraft from the matching plan', () => {
    const plan = { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' };
    usePlanStore.getState().applyRemotePlans([plan]);
    usePlanStore.getState().selectPlan('p1');
    expect(usePlanStore.getState().currentPlanId).toBe('p1');
    expect(usePlanStore.getState().workingDraft).toBe('# A');
  });

  it('updateWorkingDraft changes workingDraft in local state immediately', () => {
    vi.useFakeTimers();
    const plan = { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' };
    usePlanStore.getState().applyRemotePlans([plan]);
    usePlanStore.getState().selectPlan('p1');
    usePlanStore.getState().updateWorkingDraft('# Updated');
    expect(usePlanStore.getState().workingDraft).toBe('# Updated');
  });

  it('reset clears all slices', () => {
    const plan = { id: 'p1', userId: 'u1', title: 'Plan A', workingContent: '# A', currentSnapshotId: null, createdAt: '', updatedAt: '' };
    usePlanStore.getState().applyRemotePlans([plan]);
    usePlanStore.getState().selectPlan('p1');
    usePlanStore.getState().reset();
    const s = usePlanStore.getState();
    expect(s.plans).toEqual([]);
    expect(s.currentPlanId).toBeNull();
    expect(s.workingDraft).toBe('');
    expect(s.snapshots).toEqual([]);
    expect(s.comments).toEqual([]);
  });

  it('applyRemoteSnapshots replaces the snapshots slice', () => {
    const snaps = [
      { id: 'v1', planId: 'p1', userId: 'u1', contentMarkdown: '# v1', parentVersionId: null, source: 'user' as const, sourceActor: null, label: null, createdAt: '' },
    ];
    usePlanStore.getState().applyRemoteSnapshots(snaps);
    expect(usePlanStore.getState().snapshots).toEqual(snaps);
  });

  it('applyRemoteComments replaces the comments slice', () => {
    const comments = [
      { id: 'c1', planId: 'p1', versionId: 'v1', userId: 'u1', authorUserId: 'u1', body: 'Nice', resolved: false, createdAt: '', updatedAt: '' },
    ];
    usePlanStore.getState().applyRemoteComments(comments);
    expect(usePlanStore.getState().comments).toEqual(comments);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- plan-store
```

Expected: FAIL — module `@/stores/plan-store` not found.

- [ ] **Step 3: Commit failing tests**

```bash
git add src/stores/__tests__/plan-store.test.ts
git commit -m "test(plan-store): add failing tests (TDD — red phase)"
```

### Task C2: Implement `PlanStore`

**Files:**
- Create: `src/stores/plan-store.ts`

- [ ] **Step 1: Create the store**

```ts
// src/stores/plan-store.ts
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { makeDebouncedSync } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { tryAccountScopedPath } from '@/lib/accounts/account-paths';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchPlans,
  pushPlans,
  fetchPlanVersions,
  pushPlanVersion,
  fetchPlanComments,
  pushPlanComment,
  deletePlanComment,
  type PlanRecord,
  type PlanVersionRecord,
  type PlanCommentRecord,
} from '@/lib/sync';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { BaseDirectory, readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';

// ── Types ────────────────────────────────────────────────────────────────────

interface PlanState {
  plans: PlanRecord[];
  currentPlanId: string | null;
  workingDraft: string;
  snapshots: PlanVersionRecord[];
  comments: PlanCommentRecord[];

  // Boot
  load: (userId: string) => Promise<void>;

  // Plan CRUD
  createPlan: (title: string) => Promise<void>;
  deletePlan: (planId: string) => Promise<void>;
  selectPlan: (planId: string) => Promise<void>;
  renamePlan: (planId: string, title: string) => Promise<void>;

  // Working draft
  updateWorkingDraft: (content: string) => void;

  // Snapshots
  snapshotCurrent: (label?: string) => Promise<void>;
  loadSnapshot: (versionId: string) => void;

  // Comments
  addComment: (versionId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  toggleResolveComment: (commentId: string) => Promise<void>;

  // Sync
  applyRemotePlans: (plans: PlanRecord[]) => void;
  applyRemoteSnapshots: (snapshots: PlanVersionRecord[]) => void;
  applyRemoteComments: (comments: PlanCommentRecord[]) => void;

  // Lifecycle
  flush: () => Promise<void>;
  reset: () => void;
}

// ── Debounced sync for working_content ───────────────────────────────────────
// The payload carries { planId, content } so the push function can upsert only
// the affected plan row. userId is read at fire time from auth-store (M1 pattern).

const draftSync = makeDebouncedSync<{ planId: string; content: string }>(
  async (userId, payload) => {
    if (!isSupabaseConfigured) return;
    const { error } = await supabase
      .from('plans')
      .update({ working_content: payload.content, updated_at: new Date().toISOString() })
      .eq('id', payload.planId)
      .eq('user_id', userId);
    if (error) console.error('[plan-store] debounced draft push failed:', error);
  },
  1000,
);

// ── Store factory ─────────────────────────────────────────────────────────────

const INITIAL_STATE = {
  plans: [] as PlanRecord[],
  currentPlanId: null as string | null,
  workingDraft: '',
  snapshots: [] as PlanVersionRecord[],
  comments: [] as PlanCommentRecord[],
};

export const usePlanStore = create<PlanState>((set, get) => {
  const store: PlanState = {
    ...INITIAL_STATE,

    // ── Boot ─────────────────────────────────────────────────────────────────

    async load(userId: string) {
      const remote = await fetchPlans(userId);
      if (remote && remote.length > 0) {
        set({ plans: remote });
        // Persist to local cache for offline/fast-boot
        const cachePath = tryAccountScopedPath('cache/plans.json');
        if (cachePath) {
          try {
            const dir = cachePath.substring(0, cachePath.lastIndexOf('/'));
            const dirExists = await exists(dir, { baseDir: BaseDirectory.AppLocalData });
            if (!dirExists) await mkdir(dir, { baseDir: BaseDirectory.AppLocalData, recursive: true });
            await writeTextFile(cachePath, JSON.stringify(remote), { baseDir: BaseDirectory.AppLocalData });
          } catch (e) {
            console.error('[plan-store] cache write failed:', e);
          }
        }
      } else {
        // Attempt local cache for offline fast-boot
        const cachePath = tryAccountScopedPath('cache/plans.json');
        if (cachePath) {
          try {
            const cacheExists = await exists(cachePath, { baseDir: BaseDirectory.AppLocalData });
            if (cacheExists) {
              const raw = await readTextFile(cachePath, { baseDir: BaseDirectory.AppLocalData });
              set({ plans: JSON.parse(raw) });
            }
          } catch (e) {
            console.error('[plan-store] cache read failed:', e);
          }
        }
      }
    },

    // ── Plan CRUD ────────────────────────────────────────────────────────────

    async createPlan(title: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId || !isSupabaseConfigured) return;
      const id = uuidv4();
      const now = new Date().toISOString();
      const newPlan: PlanRecord = {
        id,
        userId,
        title: title.trim() || 'Untitled plan',
        workingContent: '',
        currentSnapshotId: null,
        createdAt: now,
        updatedAt: now,
      };
      // Optimistic local insert
      set((s) => ({ plans: [newPlan, ...s.plans] }));
      // Push to Supabase
      const { error } = await supabase.from('plans').insert({
        id,
        user_id: userId,
        title: newPlan.title,
        working_content: '',
      });
      if (error) {
        console.error('[plan-store] createPlan failed:', error);
        // Revert optimistic insert
        set((s) => ({ plans: s.plans.filter((p) => p.id !== id) }));
      }
    },

    async deletePlan(planId: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId || !isSupabaseConfigured) return;
      // Optimistic local removal
      const before = get().plans;
      const wasCurrent = get().currentPlanId === planId;
      set((s) => ({
        plans: s.plans.filter((p) => p.id !== planId),
        currentPlanId: wasCurrent ? null : s.currentPlanId,
        workingDraft: wasCurrent ? '' : s.workingDraft,
        snapshots: wasCurrent ? [] : s.snapshots,
        comments: wasCurrent ? [] : s.comments,
      }));
      const { error } = await supabase
        .from('plans')
        .delete()
        .eq('id', planId)
        .eq('user_id', userId);
      if (error) {
        console.error('[plan-store] deletePlan failed:', error);
        // Revert
        set({ plans: before });
      }
    },

    async selectPlan(planId: string) {
      const plan = get().plans.find((p) => p.id === planId);
      if (!plan) return;
      set({
        currentPlanId: planId,
        workingDraft: plan.workingContent,
        snapshots: [],
        comments: [],
      });
      // Fetch snapshots + comments for the selected plan
      const [versions, comments] = await Promise.all([
        fetchPlanVersions(planId),
        fetchPlanComments(planId),
      ]);
      set({
        snapshots: versions ?? [],
        comments: comments ?? [],
      });
    },

    async renamePlan(planId: string, title: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId || !isSupabaseConfigured) return;
      set((s) => ({
        plans: s.plans.map((p) =>
          p.id === planId ? { ...p, title, updatedAt: new Date().toISOString() } : p,
        ),
      }));
      const { error } = await supabase
        .from('plans')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', planId)
        .eq('user_id', userId);
      if (error) console.error('[plan-store] renamePlan failed:', error);
    },

    // ── Working draft ─────────────────────────────────────────────────────────

    updateWorkingDraft(content: string) {
      const planId = get().currentPlanId;
      if (!planId) return;
      set((s) => ({
        workingDraft: content,
        plans: s.plans.map((p) =>
          p.id === planId ? { ...p, workingContent: content, updatedAt: new Date().toISOString() } : p,
        ),
      }));
      draftSync.schedule({ planId, content });
    },

    // ── Snapshots ─────────────────────────────────────────────────────────────

    async snapshotCurrent(label?: string) {
      const { currentPlanId, workingDraft, snapshots } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentPlanId || !userId) return;

      const parentVersionId = snapshots.length > 0 ? snapshots[0].id : null;
      const versionId = uuidv4();

      const result = await pushPlanVersion({
        id: versionId,
        planId: currentPlanId,
        contentMarkdown: workingDraft,
        parentVersionId,
        source: 'user',
        sourceActor: null,
        label: label ?? null,
      });
      if (!result) return;

      // Update plans.current_snapshot_id
      const { error } = await supabase
        .from('plans')
        .update({
          current_snapshot_id: versionId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', currentPlanId)
        .eq('user_id', userId);
      if (error) console.error('[plan-store] snapshotCurrent update snapshot_id failed:', error);

      // Optimistic prepend to snapshots slice
      const newSnapshot: PlanVersionRecord = {
        id: versionId,
        planId: currentPlanId,
        userId,
        contentMarkdown: workingDraft,
        parentVersionId,
        source: 'user',
        sourceActor: null,
        label: label ?? null,
        createdAt: new Date().toISOString(),
      };
      set((s) => ({
        snapshots: [newSnapshot, ...s.snapshots],
        plans: s.plans.map((p) =>
          p.id === currentPlanId
            ? { ...p, currentSnapshotId: versionId, updatedAt: new Date().toISOString() }
            : p,
        ),
      }));
    },

    loadSnapshot(versionId: string) {
      const snap = get().snapshots.find((v) => v.id === versionId);
      if (!snap) return;
      // Load snapshot content into working draft; does NOT persist to Supabase automatically.
      // User must click "Save" / let the 1s debounce fire to persist the adoption.
      get().updateWorkingDraft(snap.contentMarkdown);
    },

    // ── Comments ──────────────────────────────────────────────────────────────

    async addComment(versionId: string, body: string) {
      const { currentPlanId } = get();
      const userId = useAuthStore.getState().user?.id;
      if (!currentPlanId || !userId || !body.trim()) return;
      const commentId = uuidv4();
      const now = new Date().toISOString();
      const newComment: PlanCommentRecord = {
        id: commentId,
        planId: currentPlanId,
        versionId,
        userId,
        authorUserId: userId,
        body: body.trim(),
        resolved: false,
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({ comments: [...s.comments, newComment] }));
      await pushPlanComment({
        id: commentId,
        planId: currentPlanId,
        versionId,
        authorUserId: userId,
        body: body.trim(),
        resolved: false,
      });
    },

    async deleteComment(commentId: string) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      set((s) => ({ comments: s.comments.filter((c) => c.id !== commentId) }));
      await deletePlanComment(commentId, userId);
    },

    async toggleResolveComment(commentId: string) {
      const comment = get().comments.find((c) => c.id === commentId);
      if (!comment) return;
      const updated = { ...comment, resolved: !comment.resolved, updatedAt: new Date().toISOString() };
      set((s) => ({
        comments: s.comments.map((c) => (c.id === commentId ? updated : c)),
      }));
      await pushPlanComment({
        id: updated.id,
        planId: updated.planId,
        versionId: updated.versionId,
        authorUserId: updated.authorUserId,
        body: updated.body,
        resolved: updated.resolved,
      });
    },

    // ── Sync ──────────────────────────────────────────────────────────────────

    applyRemotePlans(plans: PlanRecord[]) {
      set({ plans });
    },

    applyRemoteSnapshots(snapshots: PlanVersionRecord[]) {
      set({ snapshots });
    },

    applyRemoteComments(comments: PlanCommentRecord[]) {
      set({ comments });
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async flush() {
      await draftSync.flush();
    },

    reset() {
      set(INITIAL_STATE);
    },
  };

  // Register with M1 account-switch registry
  registerResettableStore(() => store.reset());

  return store;
});
```

- [ ] **Step 2: Run tests — expect green**

```bash
npm run test -- plan-store
```

Expected: PASS.

- [ ] **Step 3: Type-check**

```bash
npm run build
```

Expected: PASS — `tsc` clean.

- [ ] **Step 4: Commit**

```bash
git add src/stores/plan-store.ts
git commit -m "feat(plan-store): add PlanStore with plans, snapshots, comments slices — built on SyncedStore primitives"
```

---

## Phase D — Realtime listeners for the three new tables

This phase wires `plans`, `plan_versions`, and `plan_comments` into the existing `startRealtimeSync` channel in `src/lib/realtime.ts`. Follows the exact pattern of the M1 `subscribeUserTable` calls already present in that file.

### Task D1: Add refetch closures + `subscribeUserTable` calls

**Files:**
- Modify: `src/lib/realtime.ts`

- [ ] **Step 1: Add imports and the three new closures + subscriptions**

Open `src/lib/realtime.ts`. The existing file ends with:
```ts
  ch = subscribeUserTable(ch, 'actions', userId, refetchActions);
  channel = ch.subscribe();
```

Add the following additions — new imports at the top and three new lines before `channel = ch.subscribe()`:

```ts
// Add to the existing import from '@/lib/sync':
// fetchPlans, fetchPlanVersions, fetchPlanComments
// (add these to the named import list already there)

// Add after the existing import from '@/stores/actions-store':
import { usePlanStore } from '@/stores/plan-store';
```

Then inside `startRealtimeSync`, add after the `refetchActions` closure:

```ts
  const refetchPlans = async () => {
    const plans = await fetchPlans(userId);
    if (plans) usePlanStore.getState().applyRemotePlans(plans);
  };

  const refetchPlanVersions = async () => {
    const currentPlanId = usePlanStore.getState().currentPlanId;
    if (!currentPlanId) return;
    const versions = await fetchPlanVersions(currentPlanId);
    if (versions) usePlanStore.getState().applyRemoteSnapshots(versions);
  };

  const refetchPlanComments = async () => {
    const currentPlanId = usePlanStore.getState().currentPlanId;
    if (!currentPlanId) return;
    const comments = await fetchPlanComments(currentPlanId);
    if (comments) usePlanStore.getState().applyRemoteComments(comments);
  };
```

And add the three subscriptions before `channel = ch.subscribe()`:

```ts
  ch = subscribeUserTable(ch, 'plans',         userId, refetchPlans);
  ch = subscribeUserTable(ch, 'plan_versions', userId, refetchPlanVersions);
  ch = subscribeUserTable(ch, 'plan_comments', userId, refetchPlanComments);
```

Full updated file for reference:

```ts
// src/lib/realtime.ts
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAppStore } from '@/stores/app-store';
import { useAgentsStore } from '@/stores/agents-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useBoardStore } from '@/stores/board-store';
import { useActionsStore } from '@/stores/actions-store';
import { usePlanStore } from '@/stores/plan-store';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  fetchAgentProfiles, fetchProjects, fetchSubjects, fetchBoardTasks, fetchActions,
  fetchPlans, fetchPlanVersions, fetchPlanComments,
} from '@/lib/sync';
import { subscribeUserTable } from '@/lib/synced-store';

let channel: RealtimeChannel | null = null;

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
  const refetchPlans = async () => {
    const plans = await fetchPlans(userId);
    if (plans) usePlanStore.getState().applyRemotePlans(plans);
  };
  const refetchPlanVersions = async () => {
    const currentPlanId = usePlanStore.getState().currentPlanId;
    if (!currentPlanId) return;
    const versions = await fetchPlanVersions(currentPlanId);
    if (versions) usePlanStore.getState().applyRemoteSnapshots(versions);
  };
  const refetchPlanComments = async () => {
    const currentPlanId = usePlanStore.getState().currentPlanId;
    if (!currentPlanId) return;
    const comments = await fetchPlanComments(currentPlanId);
    if (comments) usePlanStore.getState().applyRemoteComments(comments);
  };

  let ch = supabase.channel('db-sync');
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
  ch = subscribeUserTable(ch, 'plans',          userId, refetchPlans);
  ch = subscribeUserTable(ch, 'plan_versions',  userId, refetchPlanVersions);
  ch = subscribeUserTable(ch, 'plan_comments',  userId, refetchPlanComments);

  channel = ch.subscribe();
}

export function stopRealtimeSync(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build
```

Expected: PASS — `tsc` clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/realtime.ts
git commit -m "feat(realtime): subscribe plans, plan_versions, plan_comments tables via subscribeUserTable"
```

### Task D2: Wire `PlanStore` into `syncOnLogin` and the window-close flush

**Files:**
- Modify: `src/stores/auth-store.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `fetchPlans` call to `syncOnLogin` in `auth-store.ts`**

In `src/stores/auth-store.ts`, add to the import from `@/lib/sync`:

```ts
// Add fetchPlans to the existing named import from '@/lib/sync'
import {
  fetchPreferences, pushPreferences,
  fetchAgentProfiles, pushAgentProfiles,
  fetchProjects, pushProjects,
  fetchSubjects,
  fetchBoardTasks, pushBoardTasks,
  fetchActions, pushActions,
  fetchPlans,   // NEW
} from '@/lib/sync';
```

Add the import:

```ts
import { usePlanStore } from '@/stores/plan-store';  // NEW
```

Inside `syncOnLogin`, append after the Actions block:

```ts
    // Plans
    const remotePlans = await fetchPlans(userId);
    if (remotePlans) {
      usePlanStore.getState().applyRemotePlans(remotePlans);
    }
    // Note: PlanStore.load() also writes to local cache; call it directly
    // for the full boot path (includes cache fallback).
    await usePlanStore.getState().load(userId);
```

- [ ] **Step 2: Add `PlanStore` flush to `App.tsx` window-close handler**

In `src/App.tsx`, add the import:

```ts
import { usePlanStore } from '@/stores/plan-store';
```

Inside the `Promise.all([...])` in the `onCloseRequested` handler, add:

```ts
                usePlanStore.getState().flush().catch((e) => console.error('[App] plans flush', e)),
```

The full `Promise.all` becomes:

```ts
              Promise.all([
                flushActionsStore().catch((e) => console.error('[App] actions flush', e)),
                useBoardStore.getState().flush().catch((e) => console.error('[App] board flush', e)),
                usePlannerStore.getState().flush().catch((e) => console.error('[App] planner flush', e)),
                useAgentsStore.getState().flush().catch((e) => console.error('[App] agents flush', e)),
                useAppStore.getState().flush().catch((e) => console.error('[App] app flush', e)),
                usePlanStore.getState().flush().catch((e) => console.error('[App] plans flush', e)),
              ]),
```

- [ ] **Step 3: Type-check**

```bash
npm run build
```

Expected: PASS — `tsc` clean.

- [ ] **Step 4: Commit**

```bash
git add src/stores/auth-store.ts src/App.tsx
git commit -m "feat(auth): wire PlanStore into syncOnLogin + window-close flush"
```

---

## Phase E — UI components + tab integration

This phase adds four components under `src/components/plans/`, a `PlansTab.tsx` wrapper, and wires the new tab into `App.tsx`. Monaco is already a dependency (used in `PlanEditor`). All components are thin wrappers over `usePlanStore` — no local component state that duplicates store state.

### Task E1: `PlanList` component

**Files:**
- Create: `src/components/plans/PlanList.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/plans/PlanList.tsx
import { useState } from 'react';
import { usePlanStore } from '@/stores/plan-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';

export function PlanList() {
  const { t } = useTranslation();
  const plans = usePlanStore((s) => s.plans);
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const createPlan = usePlanStore((s) => s.createPlan);
  const deletePlan = usePlanStore((s) => s.deletePlan);
  const selectPlan = usePlanStore((s) => s.selectPlan);

  const [newTitle, setNewTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const handleCreate = async () => {
    const title = newTitle.trim() || t('plans.untitled');
    await createPlan(title);
    setNewTitle('');
  };

  return (
    <div className="flex flex-col gap-2 p-3 h-full">
      {/* Create new plan */}
      <div className="flex gap-2">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder={t('plans.new_plan')}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          className="h-8 text-sm"
        />
        <Button size="sm" onClick={handleCreate} className="shrink-0">
          {t('plans.new_plan')}
        </Button>
      </div>

      {/* Plan list */}
      {plans.length === 0 && (
        <p className="text-sm text-muted-foreground mt-4 text-center">{t('plans.no_plans')}</p>
      )}
      <ul className="flex flex-col gap-1 overflow-y-auto">
        {plans.map((plan) => (
          <li
            key={plan.id}
            className={cn(
              'flex items-center justify-between px-2 py-1.5 rounded cursor-pointer text-sm',
              plan.id === currentPlanId
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-muted',
            )}
          >
            <span
              className="truncate flex-1"
              onClick={() => selectPlan(plan.id)}
              title={plan.title}
            >
              {plan.title}
            </span>
            {confirmDelete === plan.id ? (
              <div className="flex gap-1 ml-2 shrink-0">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-xs"
                  onClick={() => { deletePlan(plan.id); setConfirmDelete(null); }}
                >
                  {t('plans.delete_plan')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => setConfirmDelete(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 ml-1 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(plan.id); }}
                title={t('plans.delete_confirm')}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/plans/PlanList.tsx
git commit -m "feat(ui): add PlanList component (create / delete / select)"
```

### Task E2: `PlanEditor` component

**Files:**
- Create: `src/components/plans/PlanEditor.tsx`

- [ ] **Step 1: Create the component**

Monaco is already a dev dependency (check `package.json` for `@monaco-editor/react`). The editor wrapper follows the pattern used in the existing `PlannerTab.tsx` Monaco instance.

```tsx
// src/components/plans/PlanEditor.tsx
import { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { usePlanStore } from '@/stores/plan-store';
import { useAppStore } from '@/stores/app-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from 'react-i18next';
import { Camera } from 'lucide-react';
import { toast } from 'sonner';

export function PlanEditor() {
  const { t } = useTranslation();
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const workingDraft = usePlanStore((s) => s.workingDraft);
  const updateWorkingDraft = usePlanStore((s) => s.updateWorkingDraft);
  const snapshotCurrent = usePlanStore((s) => s.snapshotCurrent);
  const darkMode = useAppStore((s) => s.darkMode);

  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [snapshotting, setSnapshotting] = useState(false);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  const handleSnapshot = async () => {
    setSnapshotting(true);
    await snapshotCurrent(snapshotLabel.trim() || undefined);
    setSnapshotLabel('');
    setSnapshotting(false);
    toast.success('Snapshot saved');
  };

  if (!currentPlanId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        {t('plans.no_plans')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <Input
          value={snapshotLabel}
          onChange={(e) => setSnapshotLabel(e.target.value)}
          placeholder={t('plans.snapshot_label_placeholder')}
          className="h-7 text-xs w-48"
          onKeyDown={(e) => { if (e.key === 'Enter') handleSnapshot(); }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-3 text-xs gap-1"
          onClick={handleSnapshot}
          disabled={snapshotting}
        >
          <Camera className="w-3 h-3" />
          {t('plans.snapshot_now')}
        </Button>
      </div>

      {/* Monaco editor */}
      <div className="flex-1 overflow-hidden">
        <Editor
          language="markdown"
          theme={darkMode ? 'vs-dark' : 'vs'}
          value={workingDraft}
          onChange={(val) => updateWorkingDraft(val ?? '')}
          onMount={(editor) => { editorRef.current = editor; }}
          options={{
            wordWrap: 'on',
            minimap: { enabled: false },
            lineNumbers: 'off',
            folding: true,
            fontSize: 14,
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/plans/PlanEditor.tsx
git commit -m "feat(ui): add PlanEditor component (Monaco markdown, 1s debounce, Snapshot button)"
```

### Task E3: `SnapshotPanel` component

**Files:**
- Create: `src/components/plans/SnapshotPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/plans/SnapshotPanel.tsx
import { usePlanStore } from '@/stores/plan-store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

export function SnapshotPanel() {
  const { t } = useTranslation();
  const snapshots = usePlanStore((s) => s.snapshots);
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const plans = usePlanStore((s) => s.plans);
  const loadSnapshot = usePlanStore((s) => s.loadSnapshot);

  const currentSnapshotId = plans.find((p) => p.id === currentPlanId)?.currentSnapshotId ?? null;

  if (!currentPlanId) return null;

  return (
    <div className="flex flex-col gap-1 p-3 h-full overflow-y-auto">
      <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
        Versions ({snapshots.length})
      </p>
      {snapshots.length === 0 && (
        <p className="text-xs text-muted-foreground">No snapshots yet — click "Snapshot now" to save the current state.</p>
      )}
      {snapshots.map((snap) => (
        <div
          key={snap.id}
          className={cn(
            'flex flex-col gap-1 px-2 py-2 rounded border text-xs',
            snap.id === currentSnapshotId ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium truncate">{snap.label ?? `v${snap.id.slice(0, 6)}`}</span>
            <Badge variant="outline" className="text-[10px] py-0 px-1 shrink-0">
              {snap.source === 'user' ? t('plans.source_user')
                : snap.source === 'ai' ? t('plans.source_ai')
                : t('plans.source_import')}
            </Badge>
          </div>
          {snap.sourceActor && (
            <span className="text-muted-foreground">{snap.sourceActor}</span>
          )}
          <div className="flex items-center justify-between mt-1">
            <span className="text-muted-foreground">
              {formatDistanceToNow(new Date(snap.createdAt), { addSuffix: true })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-2 text-xs"
              onClick={() => loadSnapshot(snap.id)}
            >
              Load
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/plans/SnapshotPanel.tsx
git commit -m "feat(ui): add SnapshotPanel component (version list with source badge + load button)"
```

### Task E4: `CommentsPanel` component

**Files:**
- Create: `src/components/plans/CommentsPanel.tsx`

- [ ] **Step 1: Create the component**

Comments are version-scoped. The panel filters to the `current_snapshot_id` of the selected plan by default, with a toggle to show all versions' comments.

```tsx
// src/components/plans/CommentsPanel.tsx
import { useState } from 'react';
import { usePlanStore } from '@/stores/plan-store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Circle, Trash2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { formatDistanceToNow } from 'date-fns';

export function CommentsPanel() {
  const { t } = useTranslation();
  const comments = usePlanStore((s) => s.comments);
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const plans = usePlanStore((s) => s.plans);
  const addComment = usePlanStore((s) => s.addComment);
  const deleteComment = usePlanStore((s) => s.deleteComment);
  const toggleResolveComment = usePlanStore((s) => s.toggleResolveComment);

  const currentSnapshotId = plans.find((p) => p.id === currentPlanId)?.currentSnapshotId ?? null;
  const userId = useAuthStore((s) => s.user?.id);

  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  // Default: comments for the current snapshot version. If no snapshot, show all.
  const filtered = currentSnapshotId
    ? comments.filter((c) =>
        showResolved ? c.versionId === currentSnapshotId : !c.resolved && c.versionId === currentSnapshotId,
      )
    : comments.filter((c) => showResolved || !c.resolved);

  const handleAdd = async () => {
    if (!body.trim() || !currentSnapshotId) return;
    await addComment(currentSnapshotId, body);
    setBody('');
  };

  if (!currentPlanId) return null;

  return (
    <div className="flex flex-col h-full gap-2 p-3">
      {/* Filter toggle */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Comments ({filtered.length})
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? 'Hide resolved' : 'Show resolved'}
        </Button>
      </div>

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {currentSnapshotId ? 'No comments on this version yet.' : 'No snapshot selected — snapshot the plan to add comments.'}
          </p>
        )}
        {filtered.map((c) => (
          <div
            key={c.id}
            className={cn(
              'flex flex-col gap-1 px-2 py-2 rounded border text-xs',
              c.resolved ? 'opacity-50 border-border' : 'border-border',
            )}
          >
            <p className="whitespace-pre-wrap">{c.body}</p>
            <div className="flex items-center justify-between mt-1">
              <span className="text-muted-foreground">
                {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
              </span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  title={c.resolved ? t('plans.unresolve') : t('plans.resolve')}
                  onClick={() => toggleResolveComment(c.id)}
                >
                  {c.resolved
                    ? <CheckCircle className="w-3 h-3 text-green-500" />
                    : <Circle className="w-3 h-3" />}
                </Button>
                {c.authorUserId === userId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 p-0"
                    onClick={() => deleteComment(c.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add comment */}
      {currentSnapshotId ? (
        <div className="flex flex-col gap-2 shrink-0">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('plans.comment_placeholder')}
            className="text-xs resize-none h-16"
          />
          <Button size="sm" onClick={handleAdd} disabled={!body.trim()}>
            Add comment
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground shrink-0">
          Snapshot the plan to enable comments.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/plans/CommentsPanel.tsx
git commit -m "feat(ui): add CommentsPanel component (version-scoped, resolve toggle, CRUD)"
```

### Task E5: `PlansTab` + `App.tsx` wiring + i18n keys

**Files:**
- Create: `src/components/PlansTab.tsx`
- Modify: `src/App.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/pt-BR.json`

- [ ] **Step 1: Create `PlansTab.tsx`**

```tsx
// src/components/PlansTab.tsx
import { PlanList } from '@/components/plans/PlanList';
import { PlanEditor } from '@/components/plans/PlanEditor';
import { SnapshotPanel } from '@/components/plans/SnapshotPanel';
import { CommentsPanel } from '@/components/plans/CommentsPanel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';

export function PlansTab() {
  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      {/* Left sidebar: plan list */}
      <ResizablePanel defaultSize={20} minSize={15} maxSize={30}>
        <PlanList />
      </ResizablePanel>

      <ResizableHandle />

      {/* Center: Monaco editor */}
      <ResizablePanel defaultSize={50} minSize={30}>
        <PlanEditor />
      </ResizablePanel>

      <ResizableHandle />

      {/* Right sidebar: snapshots + comments */}
      <ResizablePanel defaultSize={30} minSize={20} maxSize={40}>
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={50}>
            <SnapshotPanel />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={50}>
            <CommentsPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
```

- [ ] **Step 2: Wire `PlansTab` into `App.tsx`**

Add to imports in `src/App.tsx`:

```ts
import { PlansTab } from '@/components/PlansTab';
```

Add `plans` key to the tab map:

```ts
        {{
          plans: <PlansTab />,          // NEW
          planner: <PlannerTab />,
          board: <BoardTab />,
          agents: <AgentsTab />,
          actions: <ActionsTab />,
          terminals: <TerminalsTab />,
        }}
```

Note: the `Layout` component will need a `plans` nav entry — check `src/components/Layout.tsx` for how nav tabs are defined (they typically map to the keys above) and add the `plans` entry accordingly. If `Layout` drives nav from a hardcoded list, add `{ key: 'plans', label: t('nav.plans') }` in the same position.

- [ ] **Step 3: Add i18n keys to `src/i18n/locales/en.json`**

Add the following keys to the top-level object (alongside the existing `"nav"`, `"actions"`, etc. keys):

```json
  "nav": {
    "plans": "Plans"
  }
```

(Merge with the existing `"nav"` object — do not replace it.)

Add new top-level block:

```json
  "plans": {
    "new_plan": "New plan",
    "delete_plan": "Delete",
    "delete_confirm": "Delete this plan and all its versions?",
    "untitled": "Untitled plan",
    "snapshot_now": "Snapshot now",
    "snapshot_label_placeholder": "Snapshot label (optional)",
    "no_plans": "No plans yet — create one above",
    "comment_placeholder": "Add a comment...",
    "resolve": "Mark resolved",
    "unresolve": "Mark unresolved",
    "migrated_banner": "Your notes have been migrated to the Plans tab.",
    "migrated_link": "Go to Plans",
    "source_user": "user",
    "source_ai": "ai",
    "source_import": "import"
  }
```

- [ ] **Step 4: Add i18n keys to `src/i18n/locales/pt-BR.json`**

```json
  "nav": {
    "plans": "Planos"
  },
  "plans": {
    "new_plan": "Novo plano",
    "delete_plan": "Excluir",
    "delete_confirm": "Excluir este plano e todas as suas versões?",
    "untitled": "Plano sem título",
    "snapshot_now": "Salvar versão",
    "snapshot_label_placeholder": "Nome da versão (opcional)",
    "no_plans": "Nenhum plano ainda — crie um acima",
    "comment_placeholder": "Adicionar comentário...",
    "resolve": "Marcar como resolvido",
    "unresolve": "Reabrir",
    "migrated_banner": "Suas notas foram migradas para a aba Planos.",
    "migrated_link": "Ir para Planos",
    "source_user": "usuário",
    "source_ai": "ia",
    "source_import": "importação"
  }
```

- [ ] **Step 5: Type-check and test**

```bash
npm run build
npm run test
```

Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add src/components/PlansTab.tsx src/App.tsx src/i18n/locales/en.json src/i18n/locales/pt-BR.json
git commit -m "feat(ui): add PlansTab assembling PlanList + PlanEditor + SnapshotPanel + CommentsPanel; wire into App.tsx + i18n"
```

---

## Phase F — One-shot subjects→plans migration + Planner banner

This phase introduces the one-shot migration that runs per account on first M2 launch, converting each `subjects` row into a `plans` row. A sentinel file prevents double-run. The legacy `PlannerTab` gets a read-only banner.

### Task F1: Write failing tests for migration logic

**Files:**
- Create: `src/lib/plans/__tests__/migration.test.ts`

- [ ] **Step 1: Create test file**

```ts
// src/lib/plans/__tests__/migration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => {
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => Promise.resolve({
        data: [
          { project_name: 'My Project', file_name: 'spec.md', content: '# Spec', user_id: 'u1' },
          { project_name: 'My Project', file_name: 'notes.md', content: '# Notes', user_id: 'u1' },
        ],
        error: null,
      }),
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
  }));
  return { supabase: { from }, isSupabaseConfigured: true };
});

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { AppLocalData: 'AppLocalData' },
}));

vi.mock('@/lib/accounts/account-paths', () => ({
  accountScopedPath: (rel: string) => `notter-ai/u1/${rel}`,
}));

import { migrateSubjectsToPlans } from '@/lib/plans/migration';

describe('migrateSubjectsToPlans', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips if sentinel file already exists', async () => {
    const { exists } = await import('@tauri-apps/plugin-fs');
    (exists as any).mockResolvedValueOnce(true);
    const result = await migrateSubjectsToPlans('u1');
    expect(result.skipped).toBe(true);
    expect(result.migrated).toBe(0);
  });

  it('migrates each subject row into a plans insert with flattened title', async () => {
    const { supabase } = await import('@/lib/supabase');
    const result = await migrateSubjectsToPlans('u1');
    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(2);
    expect(result.failed).toHaveLength(0);
  });

  it('writes sentinel file after successful migration', async () => {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await migrateSubjectsToPlans('u1');
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.stringContaining('.migration-m2-plans-complete'),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('does NOT write sentinel if any row failed', async () => {
    const { supabase } = await import('@/lib/supabase');
    // Force first insert to fail, second to succeed
    (supabase.from as any).mockImplementationOnce(() => ({
      select: () => ({
        eq: () => Promise.resolve({
          data: [
            { project_name: 'P1', file_name: 'a.md', content: '# A', user_id: 'u1' },
          ],
          error: null,
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: { message: 'db error' } }),
    }));
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const result = await migrateSubjectsToPlans('u1');
    expect(result.failed).toHaveLength(1);
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

```bash
npm run test -- migration
```

Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing tests**

```bash
git add src/lib/plans/__tests__/migration.test.ts
git commit -m "test(migration): add failing subjects→plans migration tests (TDD — red)"
```

### Task F2: Implement `src/lib/plans/migration.ts`

**Files:**
- Create: `src/lib/plans/migration.ts`

- [ ] **Step 1: Create the migration module**

```ts
// src/lib/plans/migration.ts
//
// One-shot, per-account migration: each `subjects` row becomes a `plans` row.
// Title format: "<project_name> / <file_name>" (no .md suffix).
// working_content = subject.content.
// No initial snapshot is created.
//
// Sentinel file: notter-ai/<accountId>/.migration-m2-plans-complete
// Written ONLY after all rows succeed. If any row fails, the sentinel is NOT
// written and the migration can be re-run on next launch.
//
// Idempotent: if the sentinel exists, the function returns { skipped: true }
// immediately — no Supabase queries are made.

import { exists, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { accountScopedPath } from '@/lib/accounts/account-paths';
import { v4 as uuidv4 } from 'uuid';

export interface MigrationResult {
  skipped: boolean;
  migrated: number;
  failed: { projectName: string; fileName: string; error: string }[];
}

const SENTINEL_REL = '.migration-m2-plans-complete';

export async function migrateSubjectsToPlans(userId: string): Promise<MigrationResult> {
  if (!isSupabaseConfigured) return { skipped: false, migrated: 0, failed: [] };

  const sentinelPath = accountScopedPath(SENTINEL_REL);

  // Check sentinel
  try {
    const done = await exists(sentinelPath, { baseDir: BaseDirectory.AppLocalData });
    if (done) return { skipped: true, migrated: 0, failed: [] };
  } catch {
    // If we can't read the sentinel, treat as not-yet-migrated and proceed.
  }

  // Fetch all subjects for this user
  const { data: subjects, error: fetchError } = await supabase
    .from('subjects')
    .select('project_name, file_name, content, user_id')
    .eq('user_id', userId);

  if (fetchError || !subjects) {
    console.error('[migration] fetchSubjects failed:', fetchError);
    return { skipped: false, migrated: 0, failed: [] };
  }

  if (subjects.length === 0) {
    // Nothing to migrate — write sentinel and return
    await writeSentinel(sentinelPath);
    return { skipped: false, migrated: 0, failed: [] };
  }

  const failed: MigrationResult['failed'] = [];
  let migrated = 0;

  for (const row of subjects) {
    const title = `${row.project_name} / ${row.file_name.replace(/\.md$/i, '')}`;
    const id = uuidv4();
    try {
      const { error: insertError } = await supabase.from('plans').insert({
        id,
        user_id: userId,
        title,
        working_content: row.content ?? '',
        // current_snapshot_id intentionally null — spec §7 M2: no initial snapshot
      });
      if (insertError) {
        console.error(`[migration] insert failed for ${title}:`, insertError);
        failed.push({ projectName: row.project_name, fileName: row.file_name, error: insertError.message });
      } else {
        migrated++;
      }
    } catch (e: any) {
      console.error(`[migration] insert threw for ${title}:`, e);
      failed.push({ projectName: row.project_name, fileName: row.file_name, error: String(e?.message ?? e) });
    }
  }

  // Write sentinel ONLY if zero failures
  if (failed.length === 0) {
    await writeSentinel(sentinelPath);
  }

  return { skipped: false, migrated, failed };
}

async function writeSentinel(sentinelPath: string): Promise<void> {
  try {
    // Ensure parent dir exists (accountScopedPath returns 'notter-ai/<id>/...' relative to AppLocalData)
    const dir = sentinelPath.substring(0, sentinelPath.lastIndexOf('/'));
    const dirExists = await exists(dir, { baseDir: BaseDirectory.AppLocalData });
    if (!dirExists) {
      await mkdir(dir, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    }
    await writeTextFile(sentinelPath, new Date().toISOString(), { baseDir: BaseDirectory.AppLocalData });
  } catch (e) {
    console.error('[migration] failed to write sentinel:', e);
  }
}
```

- [ ] **Step 2: Run tests — expect green**

```bash
npm run test -- migration
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/plans/migration.ts
git commit -m "feat(migration): add one-shot subjects→plans migration with sentinel guard"
```

### Task F3: Call migration on boot in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add migration call**

In `src/App.tsx`, add the import:

```ts
import { migrateSubjectsToPlans } from '@/lib/plans/migration';
```

Inside the boot `useEffect`, after the existing `migrateLegacyLayoutIfNeeded` block and before `initialize()`, add:

```ts
      // M2: one-shot subjects → plans migration per active account
      if (mgr.activeAccountId) {
        try {
          const planMigration = await migrateSubjectsToPlans(mgr.activeAccountId);
          if (!planMigration.skipped && planMigration.failed.length > 0) {
            toast.warning(
              `Plans migration: ${planMigration.migrated} migrated, ${planMigration.failed.length} failed. See logs.`,
              { duration: 10_000 },
            );
            console.warn('[App] plans migration failures:', planMigration.failed);
          }
        } catch (e) {
          console.error('[App] plans migration threw:', e);
        }
      }
```

- [ ] **Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): call migrateSubjectsToPlans on boot per active account"
```

### Task F4: Add migration banner to `PlannerTab`

**Files:**
- Modify: `src/components/PlannerTab.tsx`

The Planner banner should appear when the sentinel file exists (meaning migration ran successfully). It shows once per render; the user can dismiss it via a link to the Plans tab.

- [ ] **Step 1: Add banner logic**

In `src/components/PlannerTab.tsx`, add to the top of the component (or to the relevant hook section):

```ts
import { useEffect, useState } from 'react';
import { exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { accountScopedPath } from '@/lib/accounts/account-paths';
import { useTranslation } from 'react-i18next';
```

Inside the component function, add:

```ts
  const { t } = useTranslation();
  const [migrationBannerVisible, setMigrationBannerVisible] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const path = accountScopedPath('.migration-m2-plans-complete');
        const done = await exists(path, { baseDir: BaseDirectory.AppLocalData });
        setMigrationBannerVisible(done);
      } catch {
        // If the check fails, don't show the banner.
      }
    })();
  }, []);
```

Add the banner JSX at the top of the rendered output (before the existing content):

```tsx
      {migrationBannerVisible && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
          <span>{t('plans.migrated_banner')}</span>
          {/* Navigation to Plans tab depends on how your Layout/nav works.
              Replace the onClick below with however the app switches tabs. */}
          <button
            className="underline font-medium ml-1"
            onClick={() => {/* switch to plans tab */}}
          >
            {t('plans.migrated_link')}
          </button>
        </div>
      )}
```

Note: The exact mechanism for switching to the Plans tab depends on how `Layout.tsx` manages active tab state (likely a Zustand slice or context). Look at how other tabs trigger navigation and use the same call here.

- [ ] **Step 2: Set Planner to read-only mode after migration**

In the same `PlannerTab.tsx`, guard all write operations (create project, create subject, save content, rename, delete) behind `!migrationBannerVisible`:

```ts
  // Disable all mutations when migration is complete
  const isReadOnly = migrationBannerVisible;
```

Pass `disabled={isReadOnly}` to the create/save/delete/rename buttons. For the Monaco editor:

```tsx
  <Editor
    ...
    options={{
      ...existingOptions,
      readOnly: isReadOnly,
    }}
  />
```

- [ ] **Step 3: Type-check**

```bash
npm run build
```

Expected: PASS — `tsc` clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/PlannerTab.tsx
git commit -m "feat(planner): add migration banner + read-only mode after subjects→plans migration"
```

---

## Phase G — Delete `src/lib/planning/`, audit `src/lib/llm/*`

This phase removes dead code. It MUST run after all prior phases are merged and the app builds cleanly. Every deletion is preceded by a `grep` verification of zero callers.

### Task G1: Verify zero callers for `src/lib/planning/`

**Files:**
- No changes in this task — verification only.

- [ ] **Step 1: Search for any remaining import of `planning/`**

```bash
grep -rn "from '@/lib/planning" src/
grep -rn "from '../planning" src/
grep -rn "from './planning" src/
```

Expected: zero results. If any result appears, trace the caller and determine if it still needs the function. If yes, do NOT delete that file yet; file a follow-up task. If no callers remain, proceed.

- [ ] **Step 2: Search for `planning-pipeline` references**

```bash
grep -rn "planning-pipeline\|planning/orchestrator\|planning/stage-runner\|planning/prompts\|planning/schemas\|planning/types\|planning/index\|planning/stages" src/
```

Expected: zero results.

### Task G2: Delete `src/lib/planning/`

- [ ] **Step 1: Delete the directory**

```bash
rm -rf src/lib/planning/
```

- [ ] **Step 2: Build to confirm no broken imports**

```bash
npm run build
```

Expected: PASS — `tsc` clean with no "Cannot find module" errors.

- [ ] **Step 3: Run full test suite**

```bash
npm run test
```

Expected: PASS. (The planning tests are deleted along with the module.)

- [ ] **Step 4: Commit**

```bash
git add -A
git status   # confirm only src/lib/planning/** is removed
git commit -m "chore(m2): delete src/lib/planning/ — planning-pipeline has zero callers post-M2"
```

### Task G3: Delete `src/components/planning/`

- [ ] **Step 1: Verify zero callers**

```bash
grep -rn "from '@/components/planning\|from '../planning\|from './planning" src/
```

Expected: zero results.

- [ ] **Step 2: Delete the directory**

```bash
rm -rf src/components/planning/
```

- [ ] **Step 3: Build + test**

```bash
npm run build && npm run test
```

Expected: PASS on both.

- [ ] **Step 4: Commit**

```bash
git add -A
git status   # confirm only src/components/planning/** is removed
git commit -m "chore(m2): delete src/components/planning/ — PlanReviewPanel, PlanStageStrip, PlanWithAiButton, TaskCard have zero callers"
```

### Task G4: Audit and retire dead `src/lib/llm/*` exports

The `src/lib/llm/` workers (`claude-code-worker.ts`, `codex-worker.ts`, `gemini-worker.ts`) are called by the planning pipeline which is now deleted. However, spec §7 M2 says: "only those with no other callers — keep what `actions-foundation` v1 still uses."

- [ ] **Step 1: Search for callers of each LLM worker**

```bash
grep -rn "claude-code-worker\|codex-worker\|gemini-worker" src/
grep -rn "from '@/lib/llm" src/
```

- [ ] **Step 2: Decision tree**

For each file in `src/lib/llm/`:
- If zero callers AND it only served the planning pipeline → delete.
- If any caller remains (e.g., `actions-store` or `executor`) → keep, do NOT touch.

The planning pipeline was the sole caller of `classifyCliError` (in `src/lib/llm/error-classifier.ts`) and `extractJsonObject` (in `src/lib/llm/json-utils.ts`) per the PATHFINDER proposal. If those files have no other callers, delete them.

```bash
grep -rn "error-classifier\|json-utils\|classifyCliError\|extractJsonObject" src/
```

- [ ] **Step 3: Delete retirable files**

Delete only the files confirmed to have zero callers. Example (adjust based on grep results):

```bash
# Only if grep above shows zero callers:
rm src/lib/llm/error-classifier.ts
rm src/lib/llm/json-utils.ts
```

- [ ] **Step 4: Build + test**

```bash
npm run build && npm run test
```

Expected: PASS on both. If any build error appears, a caller was missed — restore the file and file a follow-up task.

- [ ] **Step 5: Commit**

```bash
git add -A
git status   # confirm only the verified-dead files are removed
git commit -m "chore(m2): delete retirable src/lib/llm/* exports confirmed to have zero callers"
```

---

## Phase H — End-to-end verification + cleanup

### Task H1: Manual smoke test script

Run through these steps with a real Supabase account (test user):

- [ ] **A. Fresh M2 boot — migration runs**
  1. Ensure the test account has at least two existing `subjects` rows in Supabase (create via the legacy Planner tab on `main` before switching branches).
  2. Check out the M2 branch. Run `npm run tauri dev`.
  3. Confirm:
     - `notter-ai/<accountId>/.migration-m2-plans-complete` exists in `%LOCALAPPDATA%\com.notter.ai\`.
     - `plans` table in Supabase dashboard has one row per subject, with title `<projectName> / <fileName>`.
     - `working_content` matches the original subject markdown.
     - `current_snapshot_id` is null on every migrated row.
  4. Confirm the `PlannerTab` shows the migration banner.
  5. Confirm the Planner editor is read-only (edits do not save).

- [ ] **B. Plans tab — create, edit, snapshot**
  1. Open the Plans tab.
  2. Create a new plan named "Test Plan Alpha".
  3. Confirm the plan appears in the `PlanList`.
  4. Click the plan to select it. Confirm `workingDraft` loads in the Monaco editor.
  5. Type some markdown. Wait 1.5s.
  6. Open Supabase dashboard → `plans` table. Confirm `working_content` updated.
  7. Click "Snapshot now" with label "v1".
  8. Confirm:
     - `plan_versions` table has one row with `source = 'user'`, `label = 'v1'`.
     - `plans.current_snapshot_id` updated to the new version's id.
     - The `SnapshotPanel` shows the "v1" version.

- [ ] **C. Comments — add, resolve, delete**
  1. With "Test Plan Alpha" selected and "v1" as the current snapshot, open `CommentsPanel`.
  2. Type a comment body and click "Add comment".
  3. Confirm `plan_comments` table has one row with `version_id = v1.id`.
  4. Click the resolve toggle. Confirm `resolved = true` in Supabase.
  5. Click "Show resolved". Confirm the resolved comment appears.
  6. Delete the comment. Confirm it disappears from the list and from Supabase.

- [ ] **D. Realtime sync — second window**
  1. Open a second `npm run tauri dev` instance (or use Supabase dashboard to manually insert a row into `plans`).
  2. Insert a new row directly via Supabase dashboard.
  3. Confirm the Plans tab in the running app updates within ~2s (realtime event triggers `refetchPlans`).

- [ ] **E. Account switch — PlanStore resets**
  1. Add a second account (from M1 feature). Switch to it.
  2. Confirm the Plans tab is now empty (the new account has no plans).
  3. Create a plan on the second account.
  4. Switch back to the first account.
  5. Confirm the first account's plans reappear.

- [ ] **F. Window close — flush**
  1. Select a plan. Type some markdown.
  2. Immediately close the window (before the 1s debounce fires).
  3. Reopen. Confirm the edited content persisted in Supabase.

- [ ] **G. Migration idempotency**
  1. Restart the app. Confirm the migration does NOT run again (sentinel file exists).
  2. Confirm the `plans` table count did not change.

### Task H2: Final cleanup pass

- [ ] **Step 1: Confirm planning dead code is fully removed**

```bash
grep -rn "from '@/lib/planning" src/
grep -rn "from '@/components/planning" src/
```

Expected: zero results.

- [ ] **Step 2: Confirm no destructive delete-then-insert on new tables**

```bash
grep -n "DELETE.*FROM.*plans\b\|delete.*from.*plan_versions\|delete.*from.*plan_comments" src/lib/sync.ts
```

Expected: only the explicit `deletePlanComment` function (which is the correct explicit delete, not a table wipe).

- [ ] **Step 3: Run the full test suite**

```bash
npm run test
```

Expected: PASS, no skips.

- [ ] **Step 4: Type-check**

```bash
npm run build
```

Expected: PASS — `tsc` clean.

- [ ] **Step 5: Final commit (if any cleanup)**

```bash
git add -A
git status   # confirm only intended files
git commit -m "chore(m2): final cleanup pass"
```

---

## What M2 deliberately does NOT include

| Surface | Why deferred |
|---|---|
| Rust `axum` MCP server | M3 scope. The `mcp_token` per account already exists in secure store from M1; the consumer arrives in M3. |
| `post_revision` / `post_comment` MCP tools | M3. The `plan_versions` and `plan_comments` tables are ready to serve them. |
| `mcp:account-token-refreshed` listener in Rust | M3. The emit in `supabase.ts` (wired in M1 Task E2) is already in place; Rust listener is M3 work. |
| Import / export markdown | M4. `gray-matter`, `src/lib/plans/frontmatter.ts`, etc. |
| Realtime collaboration | Phase 3. |
| Mermaid rendering | Phase 4. |
| `plan_assets` table | Phase 4. |
| Plan templates | Out of scope (explicit non-goal in spec §11). |
| Plan→subjects reverse migration | One-way only per spec §7 M2. |
| `PlanService` class / repository pattern | Explicitly rejected — store + sync + components is the layered design. |
| Deletion of `notter-mcp-server/` (Node stdio) | Phase 3 decision. It stays alive, still spawned by the frozen `executor`. |
| v1 PTY runner retirement | PATHFINDER handoff prompt 6; separate plan. |

---

## Open items expected to surface during execution

- Whether `@monaco-editor/react` is already in `package.json` as a prod dep or only dev dep — check before Task E2. If missing, install it (run `sonatype-guide` check first per project convention).
- Whether `date-fns` is already a dep — used in `SnapshotPanel` and `CommentsPanel`. Check `package.json`.
- Whether `ResizablePanel` / `ResizableHandle` / `ResizablePanelGroup` components exist in the existing shadcn/ui setup or need adding. If not present, use a simple `flex` layout in `PlansTab.tsx` instead.
- The exact mechanism for switching tabs from the Planner banner's "Go to Plans" link — look at how `Layout.tsx` drives active tab state (likely an `app-store` slice or context) and use the same call.
- Whether the `plans` table's `onConflict: 'user_id,id'` upsert works correctly without a composite unique constraint. If Phase A's migration didn't add one, `pushPlans` may need a fallback. Add `UNIQUE (user_id, id)` to the migration if needed.
- Whether `uuid` (`v4`) is already imported as a dep — used by `plan-store.ts` and `migration.ts`. Check `package.json`; if absent, check the project's UUID generation pattern (M1 may have used `crypto.randomUUID()`).

---

## Self-review notes

This plan covers spec §7 M2 verbatim. The schema in Phase A is copied verbatim from spec §5.1 with zero modification. The `set_plan_owner_id` trigger means clients never need to supply `user_id` on `plan_versions` or `plan_comments` inserts — `pushPlanVersion` and `pushPlanComment` rely on this correctly (they omit `user_id` from the insert payload).

Spec §9 error handling is implemented throughout: optimistic local inserts are reverted on Supabase error (`createPlan`, `deletePlan`); per-row try/catch in `migrateSubjectsToPlans` prevents a single bad row from blocking the batch; the sentinel is not written unless all rows succeed; the banner offers implicit re-run on next launch if partial failures occurred.

Spec §10 testing: unit tests are written for `PlanStore` (Task C1) and `migrateSubjectsToPlans` (Task F1). The `realtime.ts` additions (Phase D) are covered by the existing realtime integration pattern established in M1 and do not require new unit tests (the `subscribeUserTable` primitive is already tested in `synced-store.test.ts`).

The `workingDraft`/`workingContent` two-copy pattern (store slice `workingDraft` + `plans[].workingContent` kept in sync by `updateWorkingDraft`) is intentional: `workingDraft` is the live editor value; `plans[].workingContent` is used by the local cache writer and `selectPlan` to restore content on tab switch. They must be kept in sync by `updateWorkingDraft` — do not update one without the other.

`refetchPlanVersions` and `refetchPlanComments` in `realtime.ts` are scope-narrowed to `currentPlanId` — they only re-fetch data for the plan the user is currently viewing. This is correct for Phase 1 (no collab); it means a background insert into a non-active plan's versions will not be reflected until the user selects that plan. This is acceptable and matches the spec's deferred realtime collab stance.

Known follow-up for M3: the `refetchPlanVersions` closure will need to be broadened (or the MCP server will push a toast via Tauri event) to surface "Codex posted v4" notifications even when the user is viewing a different plan. This is the §6.5 happy-path sequence. Do not implement in M2.

Two PATHFINDER surfaces intentionally deferred past M2: PATHFINDER System 2 (planning-pipeline shared helpers — irrelevant once `src/lib/planning/` is deleted in Phase G) and System 3 (`actions-store` `mutate`/`runPlanning` envelope — frozen Actions tab, Phase 3 decision). PATHFINDER System 1 (`SyncedStore`) is M1 and fully in use here.
