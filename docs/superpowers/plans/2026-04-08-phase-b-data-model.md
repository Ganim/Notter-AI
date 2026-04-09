# Phase B — Data Model + Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Action/Task data model with the new fields the autonomous pipeline needs (PlanStages, TokenUsage, TrustLevel, Report, expanded statuses) and migrate existing `actions.json` from v1 to v2 in place — without breaking any existing UI code that still reads the v1 fields.

**Architecture:** Pure additive migration. New types and fields are added alongside existing ones. The `Action` and `ActionTask` interfaces become supersets of v1: every v1 field stays where the UI expects it; every new field (the autonomous-pipeline ones) is added as optional. The migration runs once on file load, writes a `.v1-backup.json` next to the file, and saves the file as v2. UI consumers (ActionsTab, ActionDetail, TaskItem, PlannerTab) keep working unchanged because every field they read still exists. Phase D will later update them to use the new fields and Phase G will eventually delete the v1 fields.

**Tech Stack:** TypeScript, Zustand, Vitest, Tauri fs plugin (already in use). No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §5

---

## Critical design decision: additive vs. replacement

**Why additive:** the existing UI (`ActionsTab.tsx`, `ActionDetail.tsx`, `TaskItem.tsx`, `PlannerTab.tsx`, `actions-store.ts` consumers) reads `Action.projectName`, `Action.subjectName`, `Action.summary`, `Action.tasks[].objective`, `Action.tasks[].prompt`, `Action.tasks[].agentId`, etc. Replacing those with the new spec types in one shot means a cascading rewrite of every component, every test, every persistence path — high blast radius for a phase whose stated goal is "just the data model". Additive migration keeps Phase B small, focused, and reversible.

**Status union expansion:** the old `ActionStatus = 'waiting' | 'processing' | 'skipped' | 'done'` becomes `ActionStatus = 'waiting' | 'processing' | 'skipped' | 'done' | 'draft' | 'planning' | 'plan_review' | 'rejected' | 'queued' | 'running' | 'awaiting_hitl' | 'report_review' | 'failed' | 'cancelled'`. Existing code reading the old values continues to work (they're still members of the union); new code can use the new values once Phase D adds them.

**One spec deviation worth flagging:** the spec §5 says migration should map `processing → running`. We deviate because v2 `running` implies an active Claude Code subprocess and live MCP server, neither of which exists for a migrated v1 Action. We map `processing → draft` instead. This is documented in the migration code and in the test fixtures.

---

## File Structure

```
src/types/actions.ts              # Modified: add new types, expand unions, add optional new fields
src/stores/actions-store.ts       # Modified: bump FILE_VERSION to 2, call migration on load
src/stores/actions-migration.ts   # NEW: pure migration function v1 → v2
src/stores/__tests__/actions-migration.test.ts  # NEW: vitest tests for migration
src/stores/__tests__/actions-store.test.ts      # Modified: add one test verifying migration is called
```

**Boundaries:**
- `actions-migration.ts` is a pure function: `(input: unknown) => MigrationResult`. No I/O, no Tauri calls, no Zustand. Trivially testable.
- `actions-store.ts` orchestrates: read file → call migration → if migrated, write backup + persist v2 → set state.
- `types/actions.ts` only declares types. Nothing imports it for runtime behavior beyond type checking.

---

## Task 1: Extend `src/types/actions.ts` with new types and optional fields

**Files:**
- Modify: `src/types/actions.ts`

- [ ] **Step 1: Read the current file**

```bash
# read file: src/types/actions.ts
```

The current file (39 lines) defines `ActionStatus`, `ActionTaskStatus`, `ActionTask`, `Action`, `ACTION_TASK_STATUS_CYCLE`, `nextTaskStatus()`. Note that `Action.createdAt` and `Action.updatedAt` are STRINGS (ISO timestamps), not numbers — this is a constraint from the existing code that the new fields must respect.

- [ ] **Step 2: Replace the file content with the extended version**

The new content keeps every existing line semantically intact and adds new types + optional fields. Write this verbatim:

```typescript
// src/types/actions.ts
//
// Phase B (2026-04-08): extended for the autonomous pipeline. New types and
// fields are additive — existing UI code continues to read the v1 fields.
// Phase D will start populating the new fields; Phase G will eventually
// remove the v1-only fields once all consumers migrate.

// ----- v1 statuses (kept) + v2 additions (additive union expansion) -----

export type ActionStatus =
  // v1
  | 'waiting'
  | 'processing'
  | 'skipped'
  | 'done'
  // v2 (autonomous pipeline)
  | 'draft'
  | 'planning'
  | 'plan_review'
  | 'rejected'
  | 'queued'
  | 'running'
  | 'awaiting_hitl'
  | 'report_review'
  | 'failed'
  | 'cancelled';

export type ActionTaskStatus =
  // v1
  | 'waiting'
  | 'running'
  | 'done'
  | 'failed'
  // v2 (autonomous pipeline)
  | 'pending'
  | 'blocked_hitl'
  | 'skipped';

// ----- v2 new types -----

export type TrustLevel = 'auto' | 'semi' | 'manual';

export type PlanStageName = 'extract' | 'security' | 'data_consistency' | 'prompt_critic';

export type PlanStageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TokenUsage {
  worker: 'gemini-cli' | 'codex-cli' | 'claude-code';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costEstimate?: number;
  apiDurationMs?: number;
  timestamp: number;
}

export interface PlanStage {
  name: PlanStageName;
  status: PlanStageStatus;
  startedAt?: number;
  completedAt?: number;
  output?: string;
  tokenUsage?: TokenUsage;
  errorMessage?: string;
}

export interface TaskTestRun {
  command: string;
  passed: boolean;
  output?: string;
}

export interface TaskResult {
  summary: string;
  filesChanged: string[];
  testsRun: TaskTestRun[];
  errorMessage?: string;
}

export interface ActionReport {
  generatedAt: number;
  summary: string;
  tasksCompleted: number;
  tasksFailed: number;
  totalTokens: TokenUsage[];
  diffPath?: string;
  userDecision?: 'approved' | 'rejected';
  userComment?: string;
}

// ----- ActionTask: v1 fields + v2 optional additions -----

export interface ActionTask {
  // v1 fields (kept verbatim — UI still reads these)
  id: string;
  objective: string;
  prompt: string;
  agentId: string;
  modelTag: string;
  terminalId: string;
  status: ActionTaskStatus;
  returnText: string;

  // v2 fields (optional — populated by the planning pipeline starting in Phase D)
  rawPrompt?: string;
  refinedPrompt?: string;
  trustLevel?: TrustLevel;
  securityFlags?: string[];
  dataFlags?: string[];
  dependsOn?: string[];
  result?: TaskResult;
  startedAt?: number;
  completedAt?: number;
}

// ----- Action: v1 fields + v2 optional additions -----

export interface Action {
  // v1 fields (kept verbatim — UI still reads these)
  id: string;
  projectName: string;
  subjectName: string;
  title: string;
  summary: string;
  originalMarkdown: string;
  status: ActionStatus;
  createdAt: string; // ISO string in v1; v2 uses createdAtMs alongside
  updatedAt: string; // ISO string in v1; v2 uses updatedAtMs alongside
  tasks: ActionTask[];

  // v2 fields (optional — populated by the planning pipeline starting in Phase D)
  projectId?: string;
  projectPath?: string;
  planStages?: PlanStage[];
  tokenUsage?: TokenUsage[];
  report?: ActionReport;
  createdAtMs?: number; // numeric mirror of createdAt for v2 consumers
  updatedAtMs?: number; // numeric mirror of updatedAt for v2 consumers
}

// ----- v1 helpers (kept) -----

export const ACTION_TASK_STATUS_CYCLE: ActionTaskStatus[] = [
  'waiting',
  'running',
  'done',
  'failed',
];

export function nextTaskStatus(current: ActionTaskStatus): ActionTaskStatus {
  const idx = ACTION_TASK_STATUS_CYCLE.indexOf(current);
  if (idx === -1) {
    // v2 status passed in — fall back to 'waiting' so the UI doesn't break
    return 'waiting';
  }
  return ACTION_TASK_STATUS_CYCLE[(idx + 1) % ACTION_TASK_STATUS_CYCLE.length];
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit 0 with no errors. If errors arise from existing UI code that does exhaustive switch statements on `ActionStatus` or `ActionTaskStatus`, that's the rest of the codebase complaining. Read each error and add a `default:` case OR explicitly handle the new statuses where they can't be ignored. Do NOT remove the new statuses to make the build pass — that defeats the phase.

If you find you need to update more than 3 files outside of `types/actions.ts` to make the build pass, **stop and report** as DONE_WITH_CONCERNS — the additive approach is supposed to be silent. More than 3 files means the codebase has tighter exhaustiveness checks than expected and we need to adjust the approach.

- [ ] **Step 4: Run existing tests to ensure nothing broke**

```bash
npm test
```

Expected: all existing tests still pass. The type changes should not affect runtime behavior anywhere.

- [ ] **Step 5: Commit**

```bash
git add src/types/actions.ts
git commit -m "feat(types): extend Action/Task types for autonomous pipeline (additive)

Adds v2 types (TrustLevel, PlanStage, TokenUsage, ActionReport, TaskResult)
and expands ActionStatus/ActionTaskStatus unions with new states. All v1
fields remain on Action/ActionTask so existing UI continues to work
unchanged. Phase D will populate the new optional fields; Phase G will
eventually delete the v1-only fields after all consumers migrate.

Spec: docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md §5"
```

If step 3 required touching files outside `src/types/actions.ts` to fix exhaustiveness errors, include those files in the commit and mention them in the commit body.

---

## Task 2: Write the migration module

**Files:**
- Create: `src/stores/actions-migration.ts`

- [ ] **Step 1: Create the migration file**

```typescript
// src/stores/actions-migration.ts
//
// Phase B (2026-04-08): pure migration function from actions.json v1 to v2.
// Additive: every v1 field is preserved; v2 optional fields are populated
// where derivable, otherwise left undefined.
//
// IMPORTANT: this function is pure (no I/O, no Tauri, no Zustand). The
// caller (actions-store.ts) handles reading, writing, and backup.

import type { Action, ActionStatus, ActionTask, ActionTaskStatus } from '@/types/actions';

export interface ActionsFileV1 {
  version: 1;
  actions: Action[];
}

export interface ActionsFileV2 {
  version: 2;
  actions: Action[];
}

export type ActionsFile = ActionsFileV1 | ActionsFileV2;

export interface MigrationResult {
  file: ActionsFileV2;
  migrated: boolean; // true if input was v1 and was migrated; false if already v2
  warnings: string[];
}

const V1_TO_V2_ACTION_STATUS: Record<string, ActionStatus> = {
  // v1 → v2 status mapping. NOTE: spec §5 originally said `processing → running`,
  // but a migrated 'processing' Action has no live Claude Code process or MCP
  // server, so mapping to 'running' would lie about state. We map to 'draft'
  // instead so the user can re-plan and execute it cleanly.
  waiting: 'draft',
  processing: 'draft',
  done: 'done',
  skipped: 'cancelled',
};

const V1_TO_V2_TASK_STATUS: Record<string, ActionTaskStatus> = {
  waiting: 'pending',
  running: 'pending', // running tasks at migration time have no live terminal
  done: 'done',
  failed: 'failed',
};

function isoToMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

function migrateTask(t: ActionTask, warnings: string[]): ActionTask {
  const next: ActionTask = { ...t };

  // Map status if v1 value
  if (V1_TO_V2_TASK_STATUS[t.status]) {
    next.status = V1_TO_V2_TASK_STATUS[t.status];
  }

  // Populate v2 fields with safe defaults
  if (next.rawPrompt === undefined) {
    next.rawPrompt = t.prompt ?? '';
  }
  if (next.trustLevel === undefined) {
    next.trustLevel = 'semi';
  }
  if (next.securityFlags === undefined) {
    next.securityFlags = [];
  }
  if (next.dataFlags === undefined) {
    next.dataFlags = [];
  }

  // If the task has captured returnText, surface it as result.summary so the
  // info isn't lost when v2-aware UI starts reading from `result`.
  if (t.returnText && t.returnText.trim().length > 0 && next.result === undefined) {
    next.result = {
      summary: t.returnText,
      filesChanged: [],
      testsRun: [],
    };
  }

  return next;
}

function migrateAction(a: Action, warnings: string[]): Action {
  const next: Action = { ...a };

  // Status mapping
  if (V1_TO_V2_ACTION_STATUS[a.status]) {
    next.status = V1_TO_V2_ACTION_STATUS[a.status];
  }

  // Populate v2 fields with safe defaults
  if (next.projectId === undefined && a.projectName) {
    // v1 used projectName as the de-facto project identifier; promote it.
    next.projectId = a.projectName;
  }

  if (next.projectPath === undefined) {
    // We can't resolve the absolute path here without access to the planner
    // store. Phase D's planning pipeline will resolve and persist projectPath
    // when an Action is first re-planned. Leave undefined for migrated rows.
    warnings.push(
      `Action ${a.id}: projectPath unresolved (will be filled by planning pipeline on next plan)`,
    );
  }

  if (next.planStages === undefined) {
    next.planStages = [];
  }
  if (next.tokenUsage === undefined) {
    next.tokenUsage = [];
  }

  // Numeric mirror of timestamps
  if (next.createdAtMs === undefined) {
    next.createdAtMs = isoToMs(a.createdAt);
  }
  if (next.updatedAtMs === undefined) {
    next.updatedAtMs = isoToMs(a.updatedAt);
  }

  // Migrate tasks
  next.tasks = (a.tasks ?? []).map((t) => migrateTask(t, warnings));

  return next;
}

/**
 * Migrate an ActionsFile shape from v1 to v2. If the input is already v2,
 * returns it unchanged with `migrated: false`. The function never throws on
 * unknown shapes; it returns an empty v2 file with a warning instead.
 */
export function migrateActionsFile(input: unknown): MigrationResult {
  const warnings: string[] = [];

  if (!input || typeof input !== 'object') {
    warnings.push('Input is not an object — returning empty v2 file');
    return { file: { version: 2, actions: [] }, migrated: false, warnings };
  }

  const obj = input as { version?: unknown; actions?: unknown };

  // Already v2
  if (obj.version === 2) {
    const actions = Array.isArray(obj.actions) ? (obj.actions as Action[]) : [];
    return { file: { version: 2, actions }, migrated: false, warnings };
  }

  // v1 (or missing version, treated as v1)
  if (obj.version === 1 || obj.version === undefined) {
    const rawActions = Array.isArray(obj.actions) ? (obj.actions as Action[]) : [];
    const migratedActions = rawActions.map((a) => migrateAction(a, warnings));
    return {
      file: { version: 2, actions: migratedActions },
      migrated: true,
      warnings,
    };
  }

  // Unknown version
  warnings.push(`Unknown version ${String(obj.version)} — returning empty v2 file`);
  return { file: { version: 2, actions: [] }, migrated: false, warnings };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit (without tests yet — tests come in the next task as TDD)**

Actually, **don't commit yet** — Task 3 writes the tests first under TDD style. Since the implementation is already in place, Task 3 will demonstrate the tests passing without going through the red phase. We commit the implementation + tests together.

---

## Task 3: Write tests for the migration

**Files:**
- Create: `src/stores/__tests__/actions-migration.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// src/stores/__tests__/actions-migration.test.ts
import { describe, it, expect } from 'vitest';
import { migrateActionsFile } from '@/stores/actions-migration';
import type { Action, ActionTask } from '@/types/actions';

function v1Task(overrides: Partial<ActionTask> = {}): ActionTask {
  return {
    id: 't1',
    objective: 'do thing',
    prompt: 'do thing in detail',
    agentId: '',
    modelTag: '',
    terminalId: '',
    status: 'waiting',
    returnText: '',
    ...overrides,
  };
}

function v1Action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    projectName: 'demo',
    subjectName: 'note.md',
    title: 'demo action',
    summary: '',
    originalMarkdown: '# demo',
    status: 'waiting',
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-01T12:30:00.000Z',
    tasks: [v1Task()],
    ...overrides,
  };
}

describe('migrateActionsFile', () => {
  it('returns empty v2 file for non-object input', () => {
    const r1 = migrateActionsFile(null);
    expect(r1.file).toEqual({ version: 2, actions: [] });
    expect(r1.migrated).toBe(false);

    const r2 = migrateActionsFile('not an object');
    expect(r2.file).toEqual({ version: 2, actions: [] });
    expect(r2.migrated).toBe(false);
  });

  it('passes through a v2 file unchanged with migrated=false', () => {
    const v2 = { version: 2, actions: [] };
    const r = migrateActionsFile(v2);
    expect(r.file).toEqual({ version: 2, actions: [] });
    expect(r.migrated).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('migrates a v1 file to v2 with the same number of actions', () => {
    const v1 = { version: 1, actions: [v1Action(), v1Action({ id: 'a2' })] };
    const r = migrateActionsFile(v1);
    expect(r.migrated).toBe(true);
    expect(r.file.version).toBe(2);
    expect(r.file.actions).toHaveLength(2);
  });

  it('treats missing version as v1', () => {
    const r = migrateActionsFile({ actions: [v1Action()] });
    expect(r.migrated).toBe(true);
    expect(r.file.version).toBe(2);
  });

  it('maps action statuses: waiting → draft', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'waiting' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('draft');
  });

  it('maps action statuses: processing → draft (deviates from spec, see migration comment)', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'processing' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('draft');
  });

  it('maps action statuses: done → done', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'done' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('done');
  });

  it('maps action statuses: skipped → cancelled', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'skipped' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('cancelled');
  });

  it('preserves all v1 Action fields', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    const a = r.file.actions[0];
    expect(a.id).toBe('a1');
    expect(a.projectName).toBe('demo');
    expect(a.subjectName).toBe('note.md');
    expect(a.title).toBe('demo action');
    expect(a.originalMarkdown).toBe('# demo');
    expect(a.createdAt).toBe('2026-04-01T12:00:00.000Z');
    expect(a.updatedAt).toBe('2026-04-01T12:30:00.000Z');
  });

  it('promotes projectName to projectId', () => {
    const v1 = { version: 1, actions: [v1Action({ projectName: 'foo' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].projectId).toBe('foo');
  });

  it('leaves projectPath undefined and emits a warning', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].projectPath).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('projectPath unresolved'))).toBe(true);
  });

  it('initializes planStages and tokenUsage to empty arrays', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].planStages).toEqual([]);
    expect(r.file.actions[0].tokenUsage).toEqual([]);
  });

  it('mirrors createdAt/updatedAt as ms numbers', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    const a = r.file.actions[0];
    expect(a.createdAtMs).toBe(Date.parse('2026-04-01T12:00:00.000Z'));
    expect(a.updatedAtMs).toBe(Date.parse('2026-04-01T12:30:00.000Z'));
  });

  it('handles invalid timestamps by leaving ms fields undefined', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ createdAt: 'not a date', updatedAt: '' })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].createdAtMs).toBeUndefined();
    expect(r.file.actions[0].updatedAtMs).toBeUndefined();
  });

  it('maps task status: waiting → pending', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'waiting' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('pending');
  });

  it('maps task status: running → pending (no live terminal at migration time)', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'running' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('pending');
  });

  it('preserves task status: done', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'done' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('done');
  });

  it('preserves task status: failed', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'failed' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('failed');
  });

  it('populates rawPrompt from prompt', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ prompt: 'specific instruction' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].rawPrompt).toBe('specific instruction');
  });

  it('defaults task trustLevel to "semi"', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].trustLevel).toBe('semi');
  });

  it('defaults task securityFlags and dataFlags to empty arrays', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].securityFlags).toEqual([]);
    expect(r.file.actions[0].tasks[0].dataFlags).toEqual([]);
  });

  it('preserves returnText and surfaces it as result.summary when non-empty', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ returnText: 'previous run output' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].returnText).toBe('previous run output');
    expect(r.file.actions[0].tasks[0].result?.summary).toBe('previous run output');
    expect(r.file.actions[0].tasks[0].result?.filesChanged).toEqual([]);
    expect(r.file.actions[0].tasks[0].result?.testsRun).toEqual([]);
  });

  it('does not create a result object when returnText is empty', () => {
    const v1 = { version: 1, actions: [v1Action({ tasks: [v1Task({ returnText: '' })] })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].result).toBeUndefined();
  });

  it('handles unknown version with empty result and warning', () => {
    const r = migrateActionsFile({ version: 99, actions: [] });
    expect(r.file).toEqual({ version: 2, actions: [] });
    expect(r.migrated).toBe(false);
    expect(r.warnings.some((w) => w.includes('Unknown version'))).toBe(true);
  });

  it('handles a v1 file with no actions array', () => {
    const r = migrateActionsFile({ version: 1 });
    expect(r.file).toEqual({ version: 2, actions: [] });
    expect(r.migrated).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npm test -- actions-migration
```

Expected: all tests pass. (Implementation from Task 2 should make this work without iteration. If a test fails, fix the implementation in `actions-migration.ts` rather than weakening the test.)

- [ ] **Step 3: Commit Task 2 + Task 3 together**

```bash
git add src/stores/actions-migration.ts src/stores/__tests__/actions-migration.test.ts
git commit -m "feat(actions-store): pure migration v1 → v2 with vitest coverage

Adds a pure migrateActionsFile() function and a comprehensive test suite.
Migration is additive: every v1 field is preserved on the resulting v2
Action; new optional v2 fields are populated where derivable. Notable
deviation from spec §5: 'processing' maps to 'draft' instead of 'running'
because a migrated Action has no live executor process. Documented in
the migration source.

Spec: docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md §5"
```

---

## Task 4: Wire migration into `actions-store.ts` load

**Files:**
- Modify: `src/stores/actions-store.ts`

- [ ] **Step 1: Read the current store file**

```bash
# read file: src/stores/actions-store.ts
```

You need to understand:
- `FILE_VERSION` constant (currently 1)
- `PersistedShape` interface
- `load()` function (the relevant changes happen here)
- `persist()` function (must still write `version: 2`)

- [ ] **Step 2: Apply the changes**

Make these specific edits (each is a targeted modification):

**Edit 2a — bump version constant:**

Find:
```typescript
const FILE_NAME = 'actions.json';
const FILE_VERSION = 1;
```

Replace with:
```typescript
const FILE_NAME = 'actions.json';
const FILE_VERSION = 2;
const V1_BACKUP_SUFFIX = '.v1-backup.json';
```

**Edit 2b — add migration import at top of imports block:**

After the existing imports of types, add:
```typescript
import { migrateActionsFile } from '@/stores/actions-migration';
```

**Edit 2c — update PersistedShape to be permissive about input version:**

The existing interface only types output. Since `migrateActionsFile` already handles `unknown`, we can simplify. Find:
```typescript
interface PersistedShape {
  version: number;
  actions: Action[];
}
```

Replace with:
```typescript
interface PersistedShapeV2 {
  version: 2;
  actions: Action[];
}
```

(Then update the type annotation in `persist` accordingly: `const payload: PersistedShapeV2 = { version: FILE_VERSION, actions };` — change `PersistedShape` to `PersistedShapeV2` in that line.)

**Edit 2d — update `load()` to call migration:**

Find the entire body of the inner try block in `load()`:

```typescript
      const raw = await readTextFile(path);
      try {
        const parsed = JSON.parse(raw) as PersistedShape;
        const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
        // Reset stale 'running' tasks back to 'waiting' since the terminal
        // they were attached to is gone after a process restart.
        // Also reset stale 'processing' actions back to 'waiting' for the same reason.
        const actions = rawActions.map((a) => ({
          ...a,
          status: a.status === 'processing' ? ('waiting' as const) : a.status,
          tasks: a.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'waiting' as const } : t)),
        }));
        set({ actions, loaded: true });
      } catch (parseErr) {
        console.error('[actions-store] parse error, backing up corrupted file', parseErr);
        const backup = `${path}.corrupted-${Date.now()}`;
        await rename(path, backup).catch(() => {});
        set({ actions: [], loaded: true });
      }
```

Replace with:

```typescript
      const raw = await readTextFile(path);
      try {
        const parsed = JSON.parse(raw);
        const result = migrateActionsFile(parsed);

        if (result.migrated) {
          // Write the .v1-backup.json next to the live file BEFORE rewriting
          // so the user can recover the original shape if anything goes wrong.
          const backupPath = `${path}${V1_BACKUP_SUFFIX}`;
          try {
            await writeTextFile(backupPath, raw);
            console.log('[actions-store] v1 → v2 migration: backed up to', backupPath);
          } catch (backupErr) {
            console.error('[actions-store] failed to write v1 backup', backupErr);
          }
          if (result.warnings.length > 0) {
            console.warn('[actions-store] migration warnings:', result.warnings);
          }
        }

        // Reset stale in-flight statuses caused by an unclean process exit.
        // For v1 these were 'processing' actions and 'running' tasks; the
        // migration already mapped 'processing' → 'draft' and 'running' →
        // 'pending', but for v2 files (already migrated) we apply the same
        // recovery rule to v2 'running' actions and v2 'running' tasks here.
        const actions = result.file.actions.map((a) => ({
          ...a,
          status: a.status === 'running' ? ('draft' as const) : a.status,
          tasks: a.tasks.map((t) =>
            t.status === 'running' ? { ...t, status: 'pending' as const } : t,
          ),
        }));

        set({ actions, loaded: true });

        // If we migrated, persist immediately so the on-disk file is v2.
        if (result.migrated) {
          schedulePersist(() => get().actions);
        }
      } catch (parseErr) {
        console.error('[actions-store] parse error, backing up corrupted file', parseErr);
        const backup = `${path}.corrupted-${Date.now()}`;
        await rename(path, backup).catch(() => {});
        set({ actions: [], loaded: true });
      }
```

**Note:** the new code uses `schedulePersist` which is a function defined in module scope above the store. It's already accessible — no new import needed.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected:
- All migration tests still pass (Task 3)
- The existing `actions-store.test.ts` tests still pass — the persistence shape changed (v2) but the tests use the store API, not raw JSON, so they should be unaffected. If any test breaks, read the failure carefully:
  - If a test inspects raw written JSON for `version: 1`, update it to `version: 2`
  - If a test mocks `readTextFile` returning a v1 file shape, the migration will now run on it — verify the test still asserts the right post-load state, possibly with added assertions for migrated fields

Do NOT skip failing tests. Fix them.

- [ ] **Step 5: Commit**

```bash
git add src/stores/actions-store.ts
git commit -m "feat(actions-store): wire v1→v2 migration with backup on load

On load, the persisted file is fed through migrateActionsFile(). If a v1
file is detected, it's backed up to actions.json.v1-backup.json and the
in-memory state is rewritten as v2. The next debounced persist writes
v2 to disk. Stale 'running' actions and tasks (from a v2 unclean exit)
are reset to 'draft' and 'pending' respectively. The corrupted-file
recovery path is unchanged.

Spec: docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md §5"
```

---

## Task 5: Add a store-level test that confirms migration is invoked

**Files:**
- Modify: `src/stores/__tests__/actions-store.test.ts`

- [ ] **Step 1: Read the current test file**

```bash
# read file: src/stores/__tests__/actions-store.test.ts
```

Note the existing mock pattern at the top (`vi.mock('@tauri-apps/plugin-fs', ...)`) and how `useActionsStore` is imported. You'll add a single new `describe` block at the bottom of the existing tests.

- [ ] **Step 2: Add a migration-on-load test block at the end of the file**

Append the following block (after the existing tests, before the last closing brace if the file is wrapped in one):

```typescript
describe('actions-store v1 → v2 migration on load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates a v1 file on load and exposes v2 fields in state', async () => {
    const v1Json = JSON.stringify({
      version: 1,
      actions: [
        {
          id: 'mig-1',
          projectName: 'demo',
          subjectName: 'note.md',
          title: 'old action',
          summary: '',
          originalMarkdown: '# old',
          status: 'waiting',
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
          tasks: [
            {
              id: 't-1',
              objective: 'do thing',
              prompt: 'do thing carefully',
              agentId: '',
              modelTag: '',
              terminalId: '',
              status: 'waiting',
              returnText: '',
            },
          ],
        },
      ],
    });

    (fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(v1Json);
    (fs.writeTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.rename as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Reset the store before load (Zustand stores persist across tests)
    useActionsStore.setState({ actions: [], loaded: false, selectedActionId: null });

    await useActionsStore.getState().load();

    const state = useActionsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.actions).toHaveLength(1);

    const a = state.actions[0];
    expect(a.id).toBe('mig-1');
    expect(a.status).toBe('draft'); // was 'waiting'
    expect(a.projectId).toBe('demo'); // promoted from projectName
    expect(a.planStages).toEqual([]);
    expect(a.tokenUsage).toEqual([]);

    const t = a.tasks[0];
    expect(t.status).toBe('pending'); // was 'waiting'
    expect(t.rawPrompt).toBe('do thing carefully');
    expect(t.trustLevel).toBe('semi');
  });

  it('writes a .v1-backup.json before persisting v2', async () => {
    const v1Json = JSON.stringify({ version: 1, actions: [] });

    (fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(v1Json);
    (fs.writeTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.rename as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    useActionsStore.setState({ actions: [], loaded: false, selectedActionId: null });
    await useActionsStore.getState().load();

    const writeMock = fs.writeTextFile as ReturnType<typeof vi.fn>;
    const backupCall = writeMock.mock.calls.find((call) =>
      String(call[0]).endsWith('.v1-backup.json'),
    );
    expect(backupCall).toBeDefined();
    expect(backupCall?.[1]).toBe(v1Json);
  });

  it('does not migrate or back up an already-v2 file', async () => {
    const v2Json = JSON.stringify({ version: 2, actions: [] });

    (fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(v2Json);
    (fs.writeTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    useActionsStore.setState({ actions: [], loaded: false, selectedActionId: null });
    await useActionsStore.getState().load();

    const writeMock = fs.writeTextFile as ReturnType<typeof vi.fn>;
    const backupCall = writeMock.mock.calls.find((call) =>
      String(call[0]).endsWith('.v1-backup.json'),
    );
    expect(backupCall).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
npm test -- actions-store
```

Expected: all tests pass, including the 3 new migration tests. Note that the third test ("does not migrate or back up an already-v2 file") may write a v2 file via `schedulePersist` ONLY if `result.migrated` was true — check that the test correctly asserts the absence of the backup write, not the absence of all writes.

If `flushActionsStore` is called by previous tests and leaves writeTimer state, you may need to await a tiny delay or call `flushActionsStore()` explicitly between tests to drain pending writes. Use `await flushActionsStore()` in `beforeEach` if needed.

- [ ] **Step 4: Commit**

```bash
git add src/stores/__tests__/actions-store.test.ts
git commit -m "test(actions-store): cover v1→v2 migration on load

Adds three integration tests verifying that load() invokes the migration,
writes a .v1-backup.json before rewriting, and skips both backup and
migration for files that are already v2."
```

---

## Task 6: Manual smoke test in dev mode

**Files:** none — this is a manual verification step

- [ ] **Step 1: Identify the live actions.json on disk**

The file lives at `{appLocalDataDir}/actions.json` which on Windows is something like `C:\Users\guilh\AppData\Local\com.notter-ai.app\actions.json` (the exact directory depends on the Tauri identifier). Find it:

```bash
ls "$(cygpath "$LOCALAPPDATA")"/com.notter-ai.app/actions.json 2>/dev/null || \
ls "$(cygpath "$LOCALAPPDATA")"/com.alpha.notter/actions.json 2>/dev/null || \
ls "$(cygpath "$LOCALAPPDATA")"/notter-ai/actions.json 2>/dev/null || \
echo "actions.json not found in common locations — check src-tauri/tauri.conf.json identifier and try again"
```

If you cannot find it, the user may not have any persisted Actions yet (a fresh install) — in which case there's nothing to migrate manually. Skip to Step 4.

- [ ] **Step 2: Back up the live file before testing**

If you found it, copy it to a safe place:

```bash
cp "<path>/actions.json" "<path>/actions.json.pre-phase-b-test"
```

This is a paranoia backup separate from the migration's own `.v1-backup.json`.

- [ ] **Step 3: Inspect the file version**

```bash
head -3 "<path>/actions.json"
```

If it shows `"version": 1`, you have a real v1 file to test with. If it shows `"version": 2`, the migration already ran (or this is a test machine that started fresh after Task 4).

- [ ] **Step 4: Launch the app in dev mode**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && npm run tauri dev
```

Wait for the window to open. Open the Actions tab. **Verify:**
1. All your existing Actions are still listed (count matches)
2. Each action shows the correct title, project, subject, and task list
3. Task statuses are sensible (none stuck in a weird state)
4. Clicking an Action opens its detail view without console errors
5. The Process button on Planner notes still works for new notes

- [ ] **Step 5: Verify migration artifacts on disk**

After the app loaded the file:

```bash
ls "<path>/actions.json"*
```

Expected:
- `actions.json` exists and is now v2 (`head -3` shows `"version": 2`)
- `actions.json.v1-backup.json` exists (the original v1 content, byte-for-byte from the original)
- `actions.json.pre-phase-b-test` exists (your paranoia backup)

If the v1-backup.json content does not match your paranoia backup, **stop and investigate** — the backup logic is broken.

- [ ] **Step 6: Restart the app and verify v2 round-trip**

Close the app. Re-launch:

```bash
export PATH="$HOME/.cargo/bin:$PATH" && npm run tauri dev
```

Verify the app loads cleanly and Actions still display correctly. The second load should NOT create another `.v1-backup.json` (because the file is now v2).

- [ ] **Step 7: Document findings (briefly, no commit)**

Create or append to `spike/notes.md` (gitignored) a short Phase B smoke-test entry:

```markdown
## Phase B smoke test (date)

- Live actions.json found at: <path or "fresh install, n/a">
- Pre-test action count: <N>
- Post-load action count: <N> (should match)
- Migration produced .v1-backup.json: yes/no
- Backup byte-for-byte matches original: yes/no
- All actions display correctly in Actions tab: yes/no
- Restart loads v2 cleanly without re-migrating: yes/no
- Issues found: <none / list>
```

- [ ] **Step 8: No commit for this task**

The smoke test is verification, not code. The verification result is reported back to the controller in the task report.

---

## Task 7: Final integration check + summary commit (optional)

**Files:** none

- [ ] **Step 1: Run the full test suite one last time**

```bash
npm test
```

Expected: all tests pass, including the new migration tests and all pre-existing tests.

- [ ] **Step 2: Run `tsc --noEmit` from the project root**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Verify the git log for Phase B**

```bash
git log --oneline 54b174e..HEAD
```

Expected: 4 commits:
1. `feat(types): extend Action/Task types ...`
2. `feat(actions-store): pure migration v1 → v2 ...`
3. `feat(actions-store): wire v1→v2 migration with backup on load`
4. `test(actions-store): cover v1→v2 migration on load`

(`54b174e` is the commit that closed Phase A by adding spike findings to the spec.)

- [ ] **Step 4: Report completion**

Phase B is complete when:
- All tests pass
- TypeScript compiles
- Manual smoke test verified that existing UI continues to work with migrated data
- v1-backup.json is created on first load of a v1 file
- Subsequent loads of the v2 file do not create new backups

No additional commit is needed for Task 7 — it's verification only.

---

## Self-Review Checklist (Plan Author)

- [x] Every task has concrete file paths
- [x] Every code step has complete code (no TODOs or "implement similar logic")
- [x] TDD-style: tests in Task 3 cover the implementation in Task 2 thoroughly
- [x] Spec coverage: data model §5 → Tasks 1-2; migration § "Migration from version 1" → Tasks 2-4; backup file → Task 4 step 2; tests → Tasks 3 + 5
- [x] Type consistency: `migrateActionsFile`, `MigrationResult`, `ActionsFileV2` are all defined in Task 2 and reused in Task 3 with identical signatures; `Action`/`ActionTask` extended in Task 1 are imported in Task 2
- [x] No references to undefined symbols
- [x] Each task's commit is atomic and reversible
- [x] One spec deviation explicitly documented (`processing → draft` instead of `processing → running`)
- [x] Phase boundaries respected: no UI changes (those belong to Phase D)

---

## Success criteria (Phase B complete)

Phase B is done when:
1. `src/types/actions.ts` has all v2 types added and existing v1 fields preserved
2. `src/stores/actions-migration.ts` exists, is pure, and is fully covered by tests
3. `src/stores/actions-store.ts` invokes migration on load and writes a `.v1-backup.json` when migration runs
4. All tests pass (`npm test`)
5. TypeScript compiles cleanly (`npx tsc --noEmit`)
6. Manual smoke test confirms the app still loads existing Actions correctly after migration
7. All commits landed on `main`
