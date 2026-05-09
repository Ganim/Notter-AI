# 04 — Handoff Prompts

Date: 2026-05-09
Each block below is a self-contained prompt to feed to `/make-plan`. Do them in the listed order: System 1 unblocks several stores; System 3 + Retirement together clean up `actions-store`; the others are independent.

Recommended sequence:
1. System 1 (`SyncedStore`)
2. System 3 (`actions-store` mutate envelope) — depends on System 1's `deleteUserRow`
3. System 2 (planning primitives)
4. System 4 (provider adapter registry)
5. System 5 (small helpers — split into 5a/5b/5c if you want three small PRs)
6. Retirement (v1 execution path)

---

## 1. SyncedStore primitive

```
/make-plan

Create a new module `src/lib/synced-store.ts` that exposes five named exports replacing four duplicated patterns across the project. Source-of-truth evidence in `PATHFINDER-2026-05-09/02-cross-duplication.md` (#A, #B, #F, #G); flowcharts to consult: `PATHFINDER-2026-05-09/01-flowcharts/auth-sync.md` and `PATHFINDER-2026-05-09/01-flowcharts/board-tasks.md`.

Target API (no class, no factory):
- `upsertUserRows<TLocal, TRow>(table, userId, rows, toRow)` — Supabase upsert keyed by `(user_id, id)`. Replaces destructive delete-then-insert.
- `deleteUserRow(table, userId, id)` — explicit single-row delete.
- `subscribeUserTable(channel, table, userId, refetchAndApply)` — wraps `postgres_changes` subscription with the user_id filter.
- `makeDebouncedSync<T>(pushFn, ms)` returns `{ schedule(payload), flush() }`.
- `runOnce(key, asyncFn)` — flips a per-key flag AFTER success so failed init can retry.

Exact call sites to rewrite:
- `src/lib/sync.ts:76-98` (pushAgentProfiles) → `upsertUserRows('agent_profiles', uid, profiles, toAgentProfileRow)`
- `src/lib/sync.ts:116-133` (pushProjects) → same pattern
- `src/lib/sync.ts:259-283` (pushBoardTasks) → same
- `src/lib/sync.ts:301-318` (pushActions) → same
- `src/lib/realtime.ts:37-59` (agent_profiles), `:60-76` (projects), `:77-94` (subjects), `:95-119` (board_tasks), `:120-133` (actions) → each becomes one `subscribeUserTable(...)` call
- `src/stores/actions-store.ts:200-208` + `:245-262` → `makeDebouncedSync(pushActions, 1000)`
- `src/stores/board-store.ts:11-19` + `:22-38` → `makeDebouncedSync(pushBoardTasks, 1000)`
- `src/stores/planner-store.ts:23-31` (projects) and `:33-41` (subjects) → two `makeDebouncedSync` instances
- `src/stores/agents-store.ts:17-25` → `makeDebouncedSync(pushAgentProfiles, 1000)`; add `flush()` call to app-close handler
- `src/stores/app-store.ts:34-42` → `makeDebouncedSync(pushPreferences, 1000)`; add `flush()` call to app-close handler
- `src/stores/actions-store.ts:39-50` (`bootExecutor`) → wrap `await startQueueWorker(...)` in `runOnce('queue-worker', ...)`. Move the `queueWorkerStarted = true` assignment AFTER the await.

Behavior change to verify: every store's local-delete reducer must now call `deleteUserRow(table, uid, id)` because upsert no longer deletes server rows. Audit each `deleteAction`/`deleteBoardTask`/etc. and add the explicit delete call. This is the whole point of the change — it closes the destructive-overwrite race window.

Pick one debounce value (1000ms) for all stores — the existing 300/1000/1500 mix has no documented rationale.

Register `flush()` for every synced store on the Tauri `tauri://close-requested` window event so app-close doesn't silently drop pending writes.

Anti-patterns to reject:
- DO NOT introduce a `class SyncedStore`. Five functions, not an OO container.
- DO NOT add a generic mapping config. Each call site passes a small `toRow` lambda.
- DO NOT leave the old `pushXxx` functions in place behind a flag. Migrate one store, delete its old function, repeat.
- DO NOT add `runOnce` to `realtime.ts` until existing `if (channel) stopRealtimeSync()` is removed — converting both to the same primitive is the goal.

Phases (suggested):
1. Write the primitive + tests with a fake supabase client.
2. Migrate `actions-store` first (most complex, validates the API).
3. Migrate `board-store`, `planner-store`, `agents-store`, `app-store` in parallel PRs or one batch.
4. Replace all 5 realtime listeners.
5. Delete the old `pushXxx` functions and the per-store debounce timers.
6. Wire `flush()` into the close-window handler. Verify with manual app-close test that pending writes land.
```

---

## 2. Actions store mutate envelope + runPlanning helper

```
/make-plan

Refactor `src/stores/actions-store.ts` (no new files) to eliminate the hottest within-feature duplication identified in `PATHFINDER-2026-05-09/02-within-duplication.md` #actions-foundation 1, 2. Flowchart: `PATHFINDER-2026-05-09/01-flowcharts/actions-foundation.md`.

Add three store-private helpers and one async helper, used only inside the store factory closure:
- `mutate(updater)` — wraps `set(updater)` + `schedulePersist(() => get().actions)`.
- `mapAction(id, fn)` — walks `actions.map(...)`, applies `fn` to the matching action, stamps `updatedAt`.
- `mapTask(actionId, taskId, fn)` — composes `mapAction` for nested task updates.
- `runPlanning(actionId, project, resumeFrom?, existingTasks?)` — owns the `onProgress` closure, the `runPipeline` call, and both success/failure `set` blocks. Called by `startPlanning` and `retryPlanStage`.

Exact call sites to rewrite (all in `src/stores/actions-store.ts`):
- `:347-350` (addAction) → `mutate((s) => ({ actions: [...s.actions, a] }))`
- `:352-359` (updateAction) → `mapAction(id, (a) => ({ ...a, ...patch }))`
- `:361-367` (deleteAction) → `mutate(...)` + `deleteUserRow('actions', uid, id)` (from System 1)
- `:373-385` (updateTask) → `mapTask(actionId, taskId, (t) => ({ ...t, ...patch }))`
- `:404-473` (startPlanning) → seed the action into 'planning' state, then call `runPlanning(id, project)`
- `:483-563` (retryPlanStage) → seed the reset state, then call `runPlanning(id, project, resumeFrom, existingTasks)`
- `:568-581` (approvePlan), `:584-614` (rejectPlan), `:618-647` (requeueExecution) → `mapAction(id, ...)` patterns

Centralize the `updatedAt` stamp inside `mapAction` (currently re-inlined ~10 times in this file).

Anti-patterns to reject:
- DO NOT export `mutate`/`mapAction`/`mapTask`. They are store-private.
- DO NOT generalize `runPlanning` to "any pipeline." It's tied to the planning stage names.
- DO NOT split `runPlanning` into its own file. It needs `set`/`get` closure access.

Phases:
1. Add the four helpers, leave existing methods untouched.
2. Migrate the simple CRUD methods first (`addAction`, `updateAction`, `deleteAction`, `updateTask`).
3. Migrate `startPlanning` to use `runPlanning`. Verify pipeline still completes end-to-end.
4. Migrate `retryPlanStage`. Verify resume-from-stage works.
5. Migrate the remaining methods.

Verification:
- Existing vitest suite in `src/stores/__tests__/actions-store.test.ts` (if present — confirm) must pass unchanged.
- Manual: trigger plan, fail mid-stage, retry — both paths exercise `runPlanning`.
```

---

## 3. Planning primitives + promoted helpers

```
/make-plan

Eliminate stage-glue duplication in `src/lib/planning/stages/*.ts` and promote two cross-cutting helpers out of feature-private files. Source: `PATHFINDER-2026-05-09/02-within-duplication.md` #planning 1-4 and `02-cross-duplication.md` #C, #D-sub. Flowchart: `PATHFINDER-2026-05-09/01-flowcharts/planning-pipeline.md`.

Create three new files:
- `src/lib/planning/stages/_shared.ts` exposing:
  - `buildTaskListPrompt({ project, tasks, projectFields, label })`
  - `mergePatchById<T, P>(tasks, patches, merge)`
  - `runFlaggingStage<P>({ stageName, systemPrompt, validate, workerName? })` — encapsulates `expectedIds + buildUserPrompt + runStage` for the three flagging stages.
- `src/lib/llm/json-utils.ts` exposing `extractJsonObject(raw)` (renamed from the most-evolved version `stripJsonNoise` at `src/lib/planning/stage-runner.ts:45-72`).
- `src/lib/llm/error-classifier.ts` exposing `classifyCliError({ cli, exitCode, stderr, patterns, defaultMessage? })` returning `LLMWorkerError`.

Exact call sites to rewrite:
Stages:
- `src/lib/planning/stages/security.ts:15-70` → ~30 declarative lines using `_shared.ts`
- `src/lib/planning/stages/data-consistency.ts:12-66` → same shape
- `src/lib/planning/stages/prompt-critic.ts:23-90` → same shape, keep `enforceTrustFloor` after the merge

JSON cleaning consumers:
- `src/lib/action-processor.ts:55-96` (extractJson) → import + call `extractJsonObject`
- `src/lib/callback-analyzer.ts:62-99` (parseAnalysisResponse) → import + call `extractJsonObject`
- `src/lib/planning/stage-runner.ts:45-72` (stripJsonNoise) → delete; import from `json-utils.ts`

CLI worker error classifiers:
- `src/lib/llm/claude-code-worker.ts:107-159` → `classifyCliError({ cli: 'claude-code', exitCode, stderr, patterns: CLAUDE_PATTERNS })`. Keep `CLAUDE_PATTERNS` colocated in the worker file.
- `src/lib/llm/codex-worker.ts:107-158` → same with `CODEX_PATTERNS`
- `src/lib/llm/gemini-worker.ts:121-172` → same with `GEMINI_PATTERNS`

Do NOT consolidate:
- The `extract` stage (`src/lib/planning/stages/extract.ts`) — it operates on raw markdown, not a task list. Different shape, leave as-is.
- The Codex/Gemini Windows-stdin sentinel branch in those workers (`codex-worker.ts:27-38`, `gemini-worker.ts:52-65`). Per-CLI argument shape is genuinely incompatible.

Anti-patterns to reject:
- DO NOT pass `runFlaggingStage` a generic "stage config" object. Keep `validate` and `systemPrompt` as required typed params.
- DO NOT add `classifyHttpError` or `classifyOpenAIError` to `error-classifier.ts` until there's a real call site that needs it.
- DO NOT make `_shared.ts` exports global — they're planning-stage-private.

Phases:
1. Add `extractJsonObject` (smallest blast radius), migrate three consumers.
2. Add `classifyCliError`, migrate three workers, verify error tests still pass.
3. Add `_shared.ts` helpers, migrate `security.ts` first (simplest), then `data-consistency.ts` and `prompt-critic.ts`.
4. End-to-end: run a plan with deliberate validation failures to exercise the new paths.
```

---

## 4. Provider adapter registry

```
/make-plan

Refactor `src/lib/ai-providers.ts` to replace the `generateCloud` switch + nested ternary with a small in-file adapter registry. Source: `PATHFINDER-2026-05-09/02-within-duplication.md` #ai-providers 1. Flowchart: `PATHFINDER-2026-05-09/01-flowcharts/ai-providers.md`.

Inside `src/lib/ai-providers.ts` (no new file):

```ts
type ProviderAdapter = {
  label: string;
  buildRequest(model, apiKey, prompt): { url, headers, body: object };
  extractText(parsed): string | undefined;
};
const ADAPTERS: Record<CloudProviderId, ProviderAdapter> = {
  claude:   { ... },
  gemini:   { ... },
  groq:     { ... },
  openai:   { ... },
  deepseek: { ... },
};
```

`generateCloud` shrinks to: lookup adapter, build request, send via `llmRequest`, parse, extract, throw on missing.

Exact call sites to rewrite (all in `src/lib/ai-providers.ts`):
- `:74-94` (Gemini branch) → `ADAPTERS.gemini` row
- `:96-119` (Claude branch) → `ADAPTERS.claude` row
- `:121-150` (Groq/OpenAI/DeepSeek nested ternary) → three separate rows in `ADAPTERS`. The nested `?:` at `:124-129` is deleted.

Important: keep the `groq | openai | deepseek` adapters as **three separate entries**, not one shared OpenAI-shaped row with a URL switch. The shared structure is fine to extract into a private helper inside the file (e.g. `openAiCompatibleAdapter(url)`) but the registry itself should list three names.

Anti-patterns to reject:
- DO NOT export `ADAPTERS`. It's file-private.
- DO NOT add a `streaming` field "for later." None of the cloud providers stream today.
- DO NOT make `ADAPTERS` pluggable from outside (no `registerProvider`). Five providers, hard-coded.
- DO NOT abstract the Ollama path into the same registry. Ollama bypasses the Tauri proxy and uses `fetch` directly to localhost — legitimate transport divergence.

Phases:
1. Add `ProviderAdapter` type + `ADAPTERS` registry alongside the existing switch.
2. Switch `generateCloud` to use the registry.
3. Delete the old switch branches.
4. Verify each provider works via the agent-chat tab manual smoke test (`src/components/AgentsTab.tsx` chat panel).
```

---

## 5. Small helpers (MCP + Rust PTY + TerminalView)

This is three small independent fixes. They can ship as one PR or three.

### 5a. MCP server: loadStateOrThrow / findTaskOrThrow

```
/make-plan

Add two helpers to `notter-mcp-server/src/state.ts` and migrate four tools. Source: `PATHFINDER-2026-05-09/02-within-duplication.md` #mcp-server-bridge 1, 2. Flowchart: `PATHFINDER-2026-05-09/01-flowcharts/mcp-server-bridge.md`.

Add to `notter-mcp-server/src/state.ts`:
- `loadStateOrThrow(stateDir, actionId): ExecStateFile` — load + throw "exec state for action <id> not found" if missing.
- `findTaskOrThrow(state, taskId): ExecTaskSnapshot` — find + throw "task <tid> not found in action <aid>".

Exact call sites:
- `notter-mcp-server/src/tools/get-next-task.ts:37-40` → `const state = loadStateOrThrow(stateDir, input.action_id)`
- `notter-mcp-server/src/tools/report-progress.ts:27-30` → same. Then `:31-35` → `const task = findTaskOrThrow(state, input.task_id)`.
- `notter-mcp-server/src/tools/mark-done.ts:34-37` → same. Then `:38-42` → `findTaskOrThrow`.
- `notter-mcp-server/src/tools/get-project-context.ts:27-30` → `loadStateOrThrow(stateDir, input.action_id ?? input.project_id)` (legacy field name documented in the file's existing comment).

Anti-patterns to reject:
- DO NOT wrap the full read-modify-write envelope in a `withState` helper. The mutation bodies legitimately diverge across the three mutating tools.
```

### 5b. Rust PTY: with_session helper

```
/make-plan

Add a `PtyManager::with_session<F, R>` helper to `src-tauri/src/lib.rs` and migrate two PTY commands. Source: `PATHFINDER-2026-05-09/02-within-duplication.md` #terminal-panes 1. Flowchart: `PATHFINDER-2026-05-09/01-flowcharts/terminal-panes.md`.

```rust
impl PtyManager {
  fn with_session<F, R>(&self, id: &str, f: F) -> Result<R, String>
    where F: FnOnce(&mut PtySession) -> Result<R, String>;
}
```

Migrate:
- `src-tauri/src/lib.rs:151-168` (`write_pty`) → one-liner using `with_session`.
- `src-tauri/src/lib.rs:166-181` (`resize_pty`) → same.

Leave `close_pty` (`:182-198`) as-is. Its `.remove(&id)` body is legitimately divergent (tearing down the session).

Anti-patterns to reject:
- DO NOT change `create_pty` (`:53-149`). It's a different shape (insert vs lookup).
- DO NOT add `with_session_async`. None of the PTY ops are async at the lock layer.
```

### 5c. TerminalView: handleSwitchShell calls startPty

```
/make-plan

Replace the inlined PTY-create body in `handleSwitchShell` with a call to the existing `startPty` helper. Source: `PATHFINDER-2026-05-09/02-within-duplication.md` #terminal-panes 2.

In `src/components/TerminalView.tsx:189-204`, replace the inlined `invoke('create_pty', ...)` block with:
```ts
term.clear();
await invoke('close_pty', { id }).catch(() => {});
await startPty(term);
```

This mirrors the working `handleRestart` at `:181-187`, proving the helper is the right tool.

Anti-patterns to reject:
- DO NOT add new args to `startPty` to support the shell-switch case. The existing signature already supports it (uses the current shell from store).
```

---

## 6. RETIREMENT — delete v1 execution path

```
/make-plan

This is a deletion task, not a refactor. Two execution paths run in parallel today (`PATHFINDER-2026-05-09/02-cross-duplication.md` #E v1/v2 and `01-flowcharts/executor.md`):
- v1: `src/lib/action-runner.ts` → `write_pty` (PTY shell). Called from `src/components/ActionsTab.tsx:48`.
- v2: `src/lib/executor/queue-worker.ts` → `spawn-claude.ts` (autonomous Claude with MCP). Called from `src/stores/actions-store.ts:43`.

Per `docs/superpowers/specs/2026-04-09-phase-e-executor-design.md`, v2 is the intended path. v1 must go.

Steps:
1. Audit every caller of `runActionInTerminal` and `runActionQueue` in `src/lib/action-runner.ts:22-86`. Identify any use case the v2 path doesn't yet cover (e.g. PTY interactive shell — does any user flow rely on that?).
2. Migrate `src/components/ActionsTab.tsx:48` from v1 to v2 (`startQueueWorker` is already booted in `actions-store.ts:43`; the UI just needs to enqueue actions instead of calling `runActionInTerminal`).
3. Delete `src/lib/action-runner.ts`.
4. Remove v1-only task statuses (`waiting`, `processing`, `skipped`) from `src/types/actions.ts`. Remove or update `nextTaskStatus` at `src/types/actions.ts:155-162` (currently has a comment about falling back to `waiting` for v2 statuses — that fallback can go).
5. Audit each store/component for v1 status branching. Likely sites: `src/stores/actions-store.ts`, `src/components/ActionsTab.tsx`, `src/components/actions/*.tsx`.
6. Update any UI copy that says "waiting" / "processing" to use v2 names.

Anti-patterns to reject:
- DO NOT keep v1 behind a feature flag. The two paths disagree on data shape — coexistence is the bug.
- DO NOT generalize a "task runner" interface that both old and new paths implement. v2 wins; v1 gets deleted.
- DO NOT migrate v1 tests verbatim — the v1 test surface presupposes the v1 status enum. Drop the v1 tests; rely on the v2 executor tests in `src/lib/executor/__tests__/`.

Verification:
- Build passes with `action-runner.ts` deleted and no imports remaining.
- Manual smoke test: create an action via the UI, observe it goes through `queued → running → done` (v2 statuses) without touching any PTY.
- The v1 `terminals-store.runningTasks` badge logic: confirm whether it still has consumers or can be removed too.
```
