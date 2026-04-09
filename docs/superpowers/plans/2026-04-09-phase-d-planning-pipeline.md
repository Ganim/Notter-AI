# Phase D — Planning Pipeline (4-step LLM review) + Plan Review Panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 4-step planning pipeline that turns a raw Planner note into a reviewed, approved `Task[]` ready for execution. Pipeline runs Extract → Security → Data → Prompt-critic through the Phase C LLMWorkers, persists each `PlanStage` on the `Action`, and surfaces the result in a Plan Review Panel where the user approves or rejects before tasks become `queued`.

**Architecture:**
- `src/lib/planning/` — pure library, no store/UI imports. Each stage is a function `(input) => Promise<output>` that calls an `LLMWorker` and validates the response.
- `src/stores/actions-store.ts` — gains `startPlanning(actionId)`, `retryPlanStage(actionId, stage)`, `approvePlan(actionId)`, `rejectPlan(actionId, reason)` actions. Each stage commit atomically updates `planStages[]` + `tasks[]`.
- `src/components/planning/` — new folder holding the "Plan with AI" trigger, stage progress strip, and Plan Review Panel.

**Spec reference:** `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §6 (pipeline), §11 (trust levels), §12 (UI surfaces), §19 (success criteria).

**Pre-flight:**
- Phase C fixes (commit `f594a07`) must be in `main`. All 3 workers validated end-to-end in Tauri runtime.
- `Action.planStages?: PlanStage[]` and `ActionTask.{rawPrompt,refinedPrompt,trustLevel,securityFlags,dataFlags}` already exist in `src/types/actions.ts` from Phase B.

---

## Critical design decisions

### Why sequential, not parallel
The 4 stages are dependent: Security reads Extract's output, Data reads Security's output, Prompt-critic reads all three. We run sequentially to keep state transitions clean (one stage at a time), simplify the UI (one progress bar), and avoid ambiguous failure modes (which stage poisoned the pool?). Token savings from parallelism are marginal because the critical path is dominated by Claude Code's latency.

### State persistence is atomic per stage
Each stage either **fully completes and writes its PlanStage + updated tasks**, or **fails and writes only the error PlanStage**. No partial updates. This is the foundation for "resume from failed stage": the user clicks "Retry Security", the orchestrator reads the last successful Extract output, re-runs Security, and continues.

### Retry granularity = stage, not task
If Security flags the wrong task or Prompt-critic produces a bad refined prompt, the user re-runs the *entire stage*, not individual tasks. This is simpler than per-task retry, and cheaper because the upstream stages don't re-run.

### Task ID stability
Extract generates task IDs once. Subsequent stages only ADD fields (securityFlags, dataFlags, refinedPrompt, trustLevel) to the existing tasks — they never add, remove, or reorder tasks. If a downstream stage tries to rename IDs, the orchestrator rejects the response with `parse_error`.

### Trust level floor
If Prompt-critic classifies a task as `auto` but Security or Data flagged something non-empty, the orchestrator forces `semi` (upgrade). Trust levels only ever escalate, never de-escalate. This protects against the LLM being overconfident.

### Strict JSON validation
Each stage's output goes through a Zod (or hand-written) schema check. On parse failure, we throw `parse_error` (one retry allowed, then surface to UI). LLMs drift — treat their output as untrusted input.

---

## File Structure

```
src/lib/planning/
  ├── types.ts                    # NEW: PipelineInput, StageRunResult, PipelineError
  ├── prompts.ts                  # NEW: system prompts for all 4 stages (one file, editable together)
  ├── schemas.ts                  # NEW: Zod-like validators for each stage's output
  ├── stage-runner.ts             # NEW: generic wrapper — run worker, parse, validate, time, map errors
  ├── stages/
  │   ├── extract.ts              # NEW: Gemini → Task[] stubs
  │   ├── security.ts             # NEW: Codex → securityFlags
  │   ├── data-consistency.ts     # NEW: Gemini → dataFlags
  │   └── prompt-critic.ts        # NEW: Claude → refinedPrompt + trustLevel
  ├── orchestrator.ts             # NEW: runs all 4 stages sequentially, persists via callback
  ├── index.ts                    # NEW: public entry (runPipeline, PipelineStatus)
  └── __tests__/
      ├── stage-runner.test.ts
      ├── extract.test.ts
      ├── security.test.ts
      ├── data-consistency.test.ts
      ├── prompt-critic.test.ts
      ├── orchestrator.test.ts
      └── schemas.test.ts

src/stores/actions-store.ts       # MODIFIED: add startPlanning / retryPlanStage / approvePlan / rejectPlan
src/stores/__tests__/actions-store-planning.test.ts   # NEW

src/components/planning/
  ├── PlanWithAiButton.tsx        # NEW: trigger on a Planner note
  ├── PlanStageStrip.tsx          # NEW: 4 dots/bars showing stage status
  ├── PlanReviewPanel.tsx         # NEW: shows tasks with flags, approve/reject
  └── TaskCard.tsx                # NEW: one task row (title, prompt preview, flags, trust)
```

**Boundaries:**
- `lib/planning/` has ZERO imports from `stores/`, `components/`, or `@tauri-apps/*` (only `@/lib/llm`). This keeps it unit-testable.
- Each stage module exports a single async function with typed input/output. No shared state.
- The orchestrator receives a `persist(stage, tasks)` callback, so the store owns state transitions.

---

## Task 1: Planning types + prompts file

**Files:**
- Create: `src/lib/planning/types.ts`
- Create: `src/lib/planning/prompts.ts`

- [ ] **Step 1: Create `types.ts`**

```typescript
// src/lib/planning/types.ts
//
// Phase D: shared types for the planning pipeline. Keep this file free of
// runtime dependencies — it's imported by every stage module and the store.

import type { ActionTask, PlanStageName, TokenUsage, TrustLevel } from '@/types/actions';

/** Snapshot of a project passed to every stage as context. */
export interface ProjectContext {
  /** Project name (display only). */
  name: string;
  /** Absolute project path. */
  path: string;
  /** Short description of what this project does, used in prompts. */
  description?: string;
  /** Optional list of top-level files/dirs for greenfield detection. */
  topLevelEntries?: string[];
}

/** Input for running the full pipeline against a raw note. */
export interface PipelineInput {
  actionId: string;
  rawMarkdown: string;
  project: ProjectContext;
  /** If set, resume from this stage; earlier stages are skipped. */
  resumeFrom?: PlanStageName;
  /** Existing tasks from a prior run, used when resumeFrom is set. */
  existingTasks?: ActionTask[];
}

/** Result of running one stage. */
export interface StageRunResult {
  stageName: PlanStageName;
  tasks: ActionTask[];          // full array — each stage returns the next snapshot
  tokenUsage: TokenUsage;
  durationMs: number;
  rawOutput: string;            // verbatim LLM output, stored for debugging
}

/** Orchestrator progress callback. Fires after every stage commit. */
export type PipelineProgressHandler = (
  result: StageRunResult,
) => void | Promise<void>;

/** Structured pipeline error — mapped from LLMWorkerError or Zod violations. */
export class PipelineError extends Error {
  readonly stage: PlanStageName;
  readonly reason: 'llm_error' | 'parse_error' | 'schema_error' | 'validation_error' | 'cancelled';
  readonly rawOutput?: string;

  constructor(opts: {
    stage: PlanStageName;
    reason: PipelineError['reason'];
    message: string;
    rawOutput?: string;
  }) {
    super(opts.message);
    this.name = 'PipelineError';
    this.stage = opts.stage;
    this.reason = opts.reason;
    this.rawOutput = opts.rawOutput;
  }
}

/** Per-stage trust upgrade rule. Never escalates *down*. */
export function enforceTrustFloor(
  task: ActionTask,
  classifierTrust: TrustLevel,
): TrustLevel {
  const hasFlags =
    (task.securityFlags?.length ?? 0) > 0 ||
    (task.dataFlags?.length ?? 0) > 0;
  if (classifierTrust === 'auto' && hasFlags) return 'semi';
  return classifierTrust;
}
```

- [ ] **Step 2: Create `prompts.ts`** — one file with all 4 system prompts so we can iterate on them together.

```typescript
// src/lib/planning/prompts.ts
//
// Phase D: system prompts for the 4 planning stages. Change prompts here,
// NOT inside stage files. Prompts are intentionally short — verbosity hurts
// both cost and model focus.

export const EXTRACT_PROMPT = `You are a task extractor for an autonomous development pipeline.
Input: a raw Markdown planning note written by a developer.
Output: a JSON array of atomic development tasks.

Rules:
- Each task must be independently actionable by another engineer.
- Preserve the user's literal intent. Do NOT add speculative tasks.
- If the project is greenfield (no files), include "stack-decision" and
  "initial-scaffold" tasks at the top.
- Keep titles ≤ 80 chars.
- rawPrompt must be a detailed instruction the executor will follow verbatim.
- Return STRICT JSON only — no prose, no code fences, no comments.

Output shape:
{ "tasks": [ { "id": "t1", "title": "...", "rawPrompt": "..." } ] }`;

export const SECURITY_PROMPT = `You are a security reviewer.
Input: an array of development tasks plus project context.
Output: the same tasks with a securityFlags array added to each.

Rules:
- securityFlags are short descriptors (e.g. "sanitize filename", "avoid SSRF").
- Empty array if no concern — do NOT pad with generic advice.
- Focus on: input validation, injection, path traversal, secrets, authz, SSRF, data leakage.
- Only flag concerns SPECIFIC to what the task will do.
- Do NOT alter task titles, ids, or rawPrompts.
- Return STRICT JSON only.

Output shape:
{ "tasks": [ { "id": "t1", "securityFlags": ["..."] } ] }`;

export const DATA_CONSISTENCY_PROMPT = `You are a data consistency reviewer.
Input: an array of development tasks plus project context.
Output: the same tasks with a dataFlags array added to each.

Rules:
- dataFlags are short descriptors about schema, API, migration, cache risks.
- Empty array if the task doesn't touch data.
- Focus on: schema changes, API breakage, migration safety, referential integrity, cache invalidation, serialization shape.
- Only flag concerns specific to the task.
- Do NOT alter task titles, ids, rawPrompts, or securityFlags.
- Return STRICT JSON only.

Output shape:
{ "tasks": [ { "id": "t1", "dataFlags": ["..."] } ] }`;

export const PROMPT_CRITIC_PROMPT = `You are a senior staff engineer refining task prompts.
Input: an array of development tasks with securityFlags and dataFlags, plus project context.
Output: the same tasks with refinedPrompt and trustLevel populated.

Rules for refinedPrompt:
- Must be self-contained — the executor sees ONLY this prompt, not the rawPrompt or flags.
- Must reference securityFlags and dataFlags as constraints.
- Must include explicit acceptance criteria (what "done" looks like).
- Must assume read/write/shell access to the project cwd.
- No preamble, no markdown headings, no step numbering unless essential.

Rules for trustLevel:
- "auto"   — cosmetic, low-risk, fully reversible (formatting, doc tweaks, adding comments).
- "semi"   — default. Feature dev, refactor, UI work, tests.
- "manual" — schema migration, auth, secrets, destructive ops, deploy.
- Err on the side of "semi".

Do NOT alter task titles, ids, rawPrompts, securityFlags, or dataFlags.
Return STRICT JSON only.

Output shape:
{ "tasks": [ { "id": "t1", "refinedPrompt": "...", "trustLevel": "semi" } ] }`;
```

- [ ] **Step 3: Verify tsc, commit**

```bash
npx tsc --noEmit && git add src/lib/planning/types.ts src/lib/planning/prompts.ts && git commit -m "feat(planning): types + system prompts for the 4-stage pipeline

types.ts defines PipelineInput, StageRunResult, PipelineError, and the
trust-floor helper. prompts.ts holds all 4 system prompts in one file so
they can be iterated together. Each stage module will import its prompt
and a Zod-like schema from schemas.ts in subsequent tasks."
```

---

## Task 2: Schemas (validators for each stage's output)

**Files:**
- Create: `src/lib/planning/schemas.ts`
- Create: `src/lib/planning/__tests__/schemas.test.ts`

We don't need full Zod; hand-written validators are ~50 lines and keep the dependency tree small. Each validator takes raw parsed JSON and returns either a typed result or throws a `PipelineError` with `reason: 'schema_error'`.

- [ ] **Step 1: Create validators** for the 4 stages. Each takes `unknown`, returns the typed subset, and throws `PipelineError`. Required checks:
  - `extract`: `tasks: Array<{ id: string, title: string (≤80 chars), rawPrompt: string (non-empty) }>`, ≥ 1 task
  - `security`: `tasks: Array<{ id: string, securityFlags: string[] }>` — all ids must match an input id
  - `data`: same as security with `dataFlags`
  - `prompt_critic`: `tasks: Array<{ id, refinedPrompt: string (non-empty), trustLevel: 'auto'|'semi'|'manual' }>`

- [ ] **Step 2: Tests** — one file per validator, 5-7 cases each (happy path, missing field, wrong type, id mismatch, empty array edge case, oversized title, unknown trustLevel).

- [ ] **Step 3: Commit**

---

## Task 3: Stage runner (shared)

**Files:**
- Create: `src/lib/planning/stage-runner.ts`
- Create: `src/lib/planning/__tests__/stage-runner.test.ts`

The stage runner wraps the common flow:

1. Build the user message from `{ systemPrompt, userContext, payload }`.
2. Call `getWorker(workerName).run({ prompt, systemPrompt, responseFormat: 'json' })`.
3. Parse JSON from `response.text` (strip ``` fences if present).
4. Pass to validator. Re-throw as `PipelineError`.
5. Return `StageRunResult`.

- [ ] **Step 1:** Implement `runStage({ stageName, worker, systemPrompt, userPrompt, validate, existingTasks })`.
- [ ] **Step 2:** Handle LLMWorkerError → PipelineError mapping:
  - `auth_expired` → throw as `llm_error` with clear message ("re-login needed")
  - `rate_limited` → throw as `llm_error` with retry hint
  - `parse_error` → re-parse after stripping common LLM noise (code fences, leading text)
- [ ] **Step 3:** Tests mocking `getWorker` (same pattern as worker tests). 8-10 cases.
- [ ] **Step 4:** Commit

---

## Tasks 4-7: The four stages

Each task is the same shape:
- Create: `src/lib/planning/stages/<name>.ts`
- Create: `src/lib/planning/__tests__/<name>.test.ts`
- Export: `runExtractStage(input) → StageRunResult` (and analogous for others)

Each stage:
1. Builds user prompt (includes rawMarkdown for extract, or prior tasks array for later stages, plus project context).
2. Calls `runStage` from Task 3 with the stage's prompt and validator.
3. Merges the LLM response into the existing tasks array (for stages 2-4: match by task id, copy only the fields that stage owns).
4. Returns the updated task snapshot.

Stage-specific notes:

- [ ] **Task 4 — `extract.ts`** (worker: `gemini-cli`)
  - Generates task IDs (`t1`, `t2`, ...).
  - Sets `ActionTask.rawPrompt`, `title` (stored in `objective`), leaves `refinedPrompt`, flags, trust unset.
  - Maps v2 fields onto the existing `ActionTask` shape — uses `objective: title` so v1 UI continues to render.
  - 6-8 tests including greenfield detection fixture.

- [ ] **Task 5 — `security.ts`** (worker: `codex-cli`)
  - Input: tasks from Extract + project context.
  - Merges `securityFlags` into each task by id.
  - Validates: no new tasks, no removed tasks.
  - 5-7 tests.

- [ ] **Task 6 — `data-consistency.ts`** (worker: `gemini-cli`)
  - Same shape as Security but merges `dataFlags`.
  - 5-7 tests.

- [ ] **Task 7 — `prompt-critic.ts`** (worker: `claude-code`)
  - Merges `refinedPrompt` + `trustLevel` per task.
  - Applies `enforceTrustFloor` from Task 1: if any flags present and LLM said `auto`, bump to `semi`.
  - Populates `ActionTask.prompt` with `refinedPrompt` so the existing execution code (v1) can still read it.
  - 6-8 tests including the trust-floor enforcement edge case.

Each task commits atomically.

---

## Task 8: Orchestrator

**Files:**
- Create: `src/lib/planning/orchestrator.ts`
- Create: `src/lib/planning/index.ts`
- Create: `src/lib/planning/__tests__/orchestrator.test.ts`

- [ ] **Step 1:** Implement `runPipeline(input, onProgress)`:

```typescript
export async function runPipeline(
  input: PipelineInput,
  onProgress: PipelineProgressHandler,
): Promise<ActionTask[]> {
  const stages: Array<{
    name: PlanStageName;
    run: (tasks: ActionTask[] | null) => Promise<StageRunResult>;
  }> = [
    { name: 'extract',          run: (t) => runExtractStage({ ...input, existingTasks: t }) },
    { name: 'security',         run: (t) => runSecurityStage({ ...input, existingTasks: t! }) },
    { name: 'data_consistency', run: (t) => runDataStage({ ...input, existingTasks: t! }) },
    { name: 'prompt_critic',    run: (t) => runPromptCriticStage({ ...input, existingTasks: t! }) },
  ];

  const startIdx = stages.findIndex((s) => s.name === (input.resumeFrom ?? 'extract'));
  let tasks = input.existingTasks ?? null;
  for (let i = startIdx; i < stages.length; i++) {
    const result = await stages[i].run(tasks);
    tasks = result.tasks;
    await onProgress(result);
  }
  return tasks!;
}
```

- [ ] **Step 2:** Tests covering:
  - Full run: extract → security → data → prompt_critic, onProgress fires 4 times, final tasks array has all fields populated.
  - Resume from security: onProgress fires 3 times, extract not called.
  - Stage failure: PipelineError propagated, tasks up to failed stage committed via onProgress.
  - Cancelled before start: throws PipelineError with reason `cancelled`.

- [ ] **Step 3:** `index.ts` re-exports public API.

- [ ] **Step 4:** Commit

---

## Task 9: Store integration

**Files:**
- Modify: `src/stores/actions-store.ts`
- Create: `src/stores/__tests__/actions-store-planning.test.ts`

- [ ] **Step 1:** Add store actions:
  - `startPlanning(actionId, project)` — sets `status: 'planning'`, initializes `planStages[]`, calls `runPipeline` with an onProgress that commits each `StageRunResult` atomically. On error: sets the failed stage to `status: 'failed'` with `errorMessage`, transitions action to `status: 'failed'`. On success: transitions action to `status: 'plan_review'`.
  - `retryPlanStage(actionId, stage)` — looks up the stage, sets it back to `pending`, calls `runPipeline` with `resumeFrom: stage` and the already-committed `tasks[]`.
  - `approvePlan(actionId)` — transitions `plan_review → queued`, sets each task's `status` to `'pending'`.
  - `rejectPlan(actionId, reason?)` — transitions `plan_review → rejected`, writes reason into the failed PlanStage for the last stage.

- [ ] **Step 2:** Ensure persistence — each progress callback writes the full Action snapshot via the existing `save` path (the Phase B migration infrastructure already handles v2 fields).

- [ ] **Step 3:** Tests mocking `runPipeline` (NOT the individual stages). Cover:
  - Happy path: startPlanning → 4 stage commits → plan_review
  - Stage failure: partial commits + action in `failed`
  - Retry from failed stage: resumes with existing tasks
  - Approve → queued
  - Reject → rejected
  - Double-start is a no-op (idempotent if already `planning`)

- [ ] **Step 4:** Commit

---

## Task 10: Planner UI discovery

**Files:**
- READ ONLY: explore `src/components/planner*`, `src/routes`, whatever hosts the Planner note view.

- [ ] **Step 1:** Identify:
  - Where does a Planner note get displayed?
  - What triggers creation of an `Action` from a note today?
  - Where should the "Plan with AI" button sit?
  - Where does the list of Actions render, and where can the Plan Review Panel be mounted?

- [ ] **Step 2:** Write a short `spike/notes.md` section documenting the current flow so Tasks 11-12 have clear insertion points.

- [ ] **Step 3:** NO commit — this is a read-only discovery step.

---

## Task 11: "Plan with AI" button + stage strip

**Files:**
- Create: `src/components/planning/PlanWithAiButton.tsx`
- Create: `src/components/planning/PlanStageStrip.tsx`
- Modify: the Planner note component from Task 10 discovery

- [ ] **Step 1: PlanWithAiButton** — disabled unless `action.status` is `draft` or `failed`. onClick calls `store.startPlanning(actionId, projectContext)`. Shows a spinner while `status === 'planning'`.

- [ ] **Step 2: PlanStageStrip** — 4 pill/dots horizontally, one per stage. Color states:
  - pending: muted
  - running: primary with spinner
  - done: success
  - failed: destructive with tooltip showing `errorMessage`
  - Click a failed stage → calls `store.retryPlanStage(actionId, stage)`.

- [ ] **Step 3: Wire up** on the Planner note view next to the existing "send to terminal" / "mark done" controls.

- [ ] **Step 4: Manual smoke test** — create a test note, click "Plan with AI", watch the strip advance. Errors should be clickable to retry.

- [ ] **Step 5: Commit**

---

## Task 12: Plan Review Panel

**Files:**
- Create: `src/components/planning/PlanReviewPanel.tsx`
- Create: `src/components/planning/TaskCard.tsx`
- Modify: wherever Actions list is shown to surface plan review when `status === 'plan_review'`

- [ ] **Step 1: TaskCard** — one per task, shows:
  - Title + trust badge (auto/semi/manual with distinct colors)
  - `refinedPrompt` (collapsible, monospace)
  - `securityFlags[]` and `dataFlags[]` as chips
  - "Edit refined prompt" is out of scope for MVP — flag only.

- [ ] **Step 2: PlanReviewPanel** — shows project name, overall cost estimate (sum of `planStages[].tokenUsage.costEstimate`), list of TaskCards, "Approve & Queue" and "Reject" buttons.

- [ ] **Step 3: Wire into the Actions list** — when an Action is clicked and `status === 'plan_review'`, show this panel instead of the existing task editor.

- [ ] **Step 4: Manual smoke test** — plan a note end-to-end, approve, verify tasks become `queued` with `status: 'pending'`.

- [ ] **Step 5: Commit**

---

## Task 13: End-to-end manual validation

**Files:**
- Create: `spike/notes.md` append (Phase D runtime validation section)

- [ ] **Step 1:** Write a 3-task test note about something real but trivial ("add a dark-mode toggle to the settings panel") and run it through the pipeline inside the Tauri dev app.

- [ ] **Step 2:** Verify:
  - All 4 stages complete without errors
  - `planStages[]` shows 4 entries with sensible `tokenUsage` on each
  - TaskCard displays meaningful `refinedPrompt`, `securityFlags`, `dataFlags`, `trustLevel`
  - Trust floor kicks in on at least one task (seed a task that will trigger a data flag)
  - Reject path leaves the Action in `rejected` without corrupting anything
  - Approve path transitions tasks to `pending`
  - Total wall-clock time under 3 minutes (spec §19 success criterion)

- [ ] **Step 3:** Document findings in `spike/notes.md` — what worked, what surprised you, what the model outputs looked like. Commit only the notes file if it's not gitignored.

- [ ] **Step 4:** If critical bugs show up, file them as follow-up fix tasks before declaring Phase D done.

---

## Final verification

```bash
npm test                    # expect ~220-240 tests passing
npx tsc --noEmit            # clean
git log --oneline f594a07..HEAD   # expect ~10-13 commits
```

Phase D is done when:
1. `runPipeline()` produces a fully-populated `ActionTask[]` from a raw note in < 3 min.
2. All 4 stages persist via the store; retry-from-failed works.
3. UI: "Plan with AI" trigger, stage strip, Plan Review Panel with approve/reject.
4. Trust-floor enforcement verified (at least one flagged task gets bumped from `auto` to `semi`).
5. Unit tests mock the LLM layer; live validation happens manually inside the Tauri dev app.
6. Spec §19 success criteria 1, 2, 6, 7, 8 validated on at least one real note.

---

## Self-Review Checklist (Plan Author)

- [x] Every task has concrete file paths
- [x] Pipeline core has zero imports from stores/UI (library-first architecture)
- [x] Stage runner is shared — no duplication across the 4 stages
- [x] JSON output is schema-validated; LLM drift caught, not ignored
- [x] Trust-level floor prevents LLM over-confidence from bypassing review
- [x] Retry granularity = stage; avoids re-running the expensive upstream steps
- [x] Store ownership of state transitions; library is pure
- [x] UI work is gated behind a discovery task (Task 10) so we don't blind-code
- [x] Manual E2E validation is the gate, matching Phase C's lesson that mocks don't catch runtime bugs
- [x] Cost expectations from spec §6 are honored (Gemini for cheap stages, Claude for the critic)
