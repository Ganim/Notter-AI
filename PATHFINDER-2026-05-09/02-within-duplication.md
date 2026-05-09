## Within-feature duplication

Per-feature scan for accidental repetition that survived past helpers like `runStage`, `spawnCli`, `loadState`/`saveState`. Skipped trivial idioms (one-line guards, type casts, lone `console.log`s, React-import boilerplate).

---

### planning-pipeline

#### 1. `buildUserPrompt` is structurally identical across stages 2-4

- **Concern** — Three stages re-implement the same "project block + tasks JSON + sign-off line" prompt assembly, differing only in which fields they project from each task and the literal "Tasks to review/refine" label.
- **Locations**
  - `src/lib/planning/stages/security.ts:15-45` — `id, title, rawPrompt`.
  - `src/lib/planning/stages/data-consistency.ts:12-43` — adds `securityFlags`.
  - `src/lib/planning/stages/prompt-critic.ts:23-55` — adds `securityFlags + dataFlags`.
- **Why diverged** — Accidental. Each stage was authored as a copy of `security.ts` (the comment in `data-consistency.ts:4` literally says "Same shape as security.ts"). The 3-line `projectBlock` and the 5-line outer string assembly are byte-identical; only the `tasks.map(...)` projection and the "review"/"refine" label change.
- **Consolidation hint** — Extract `buildTaskListPrompt({ project, tasks, projectFields, label })` in `src/lib/planning/stages/_shared.ts`. Each stage passes its task field selector (`(t) => ({ id, title: t.objective, rawPrompt: ..., securityFlags: ... })`) and a label string. The extract stage doesn't share this code (different shape — raw markdown not a task list) and should stay as-is.

#### 2. "merge by id" patch loop in stages 2-4

- **Concern** — Identical "build patchById Map, walk tasks, return new array with patch fields merged" sequence appears in every flag-merging stage.
- **Locations**
  - `src/lib/planning/stages/security.ts:66-70`
  - `src/lib/planning/stages/data-consistency.ts:62-66`
  - `src/lib/planning/stages/prompt-critic.ts:72-90` (also adds the trust-floor enforcement after the merge)
- **Why diverged** — Accidental for security/data-consistency (truly identical except for the field name being merged). The prompt-critic version legitimately diverges because it must run `enforceTrustFloor` after the merge.
- **Consolidation hint** — Add `mergePatchById<T, P extends { id: string }>(tasks: T[], patches: P[], merge: (task, patch) => T)` to `_shared.ts`. Security/data-consistency become one-liners; prompt-critic can either use the helper with a richer `merge` callback or stay manual since it does the trust-floor escalation.

#### 3. `expectedIds + runStage + validate` glue in stages 2-4

- **Concern** — `const expectedIds = new Set(tasks.map(t => t.id)); const result = await runStage({ stageName, workerName: 'claude-code', systemPrompt, userPrompt: buildUserPrompt(...), validate: (parsed, raw) => validateXxx(parsed, expectedIds, raw) });`
- **Locations**
  - `src/lib/planning/stages/security.ts:50-63`
  - `src/lib/planning/stages/data-consistency.ts:49-60`
  - `src/lib/planning/stages/prompt-critic.ts:61-70`
- **Why diverged** — Accidental. The three modules differ only in which `validateXxx` runs and which `XXX_PROMPT` is used.
- **Consolidation hint** — A `runFlaggingStage<P>({ stageName, systemPrompt, validate })` wrapper that takes the input, computes `expectedIds`, builds the prompt, calls `runStage`, and returns `{ tokenUsage, durationMs, rawOutput, parsed }`. Each stage shrinks to: build the project-relative prompt, call `runFlaggingStage`, run the merge, return `StageRunResult`. Three stages → three small map functions instead of three near-clones.

#### 4. CLI worker error classifier (auth_expired / rate_limited / network buckets)

- **Concern** — Each worker has its own `classifyXxxError(exitCode, stderr)` that scans `stderr` (lowercased) for a hand-picked synonym list and returns an `LLMWorkerError` with one of `auth_expired | rate_limited | network | unknown`. Same control flow, slightly different keyword sets, identical struct construction.
- **Locations**
  - `src/lib/llm/claude-code-worker.ts:107-159` — `not authenticated|please login|login required` → auth, `rate limit|quota|too many requests` → rate, `network|econnrefused|enotfound` → network.
  - `src/lib/llm/codex-worker.ts:107-158` — `not signed in|please sign in|login required|not authenticated|unauthorized` → auth, `quota|rate limit|429|too many requests` → rate, same network terms.
  - `src/lib/llm/gemini-worker.ts:121-172` — `not authenticated|please log in|expired|login required` → auth, `quota|rate limit|429|resource_exhausted|capacity` → rate, same network terms.
- **Why diverged** — The keyword sets ARE legitimately CLI-specific (Codex says "not signed in", Gemini says "resource_exhausted") — that part is real specialization. The surrounding scaffolding (lowercase stderr, three if-blocks each constructing `new LLMWorkerError({ reason, cli, message, exitCode, stderr })`, fallback `unknown`) is accidental copy.
- **Consolidation hint** — One `classifyCliError(opts: { cli, exitCode, stderr, patterns: { auth: string[]; rate: string[]; network?: string[] }, defaultMessage: (code) => string, customMessages?: Partial<Record<Reason, string>> })` lives in `src/lib/llm/error-classifier.ts`. Each worker passes its keyword tables. Saves ~50 lines/worker × 3 workers and makes adding a new bucket a single-file change.

#### 5. Codex/Gemini `useStdin = isWindowsRuntime()` + arg-shape branch

- **Concern** — Both Codex and Gemini workers branch on `isWindowsRuntime()`, set `useStdin`, build a different `args` array depending on stdin vs positional, then call `spawnCli({ command, args, stdin: useStdin ? input.prompt : undefined, timeoutMs })`. ClaudeCodeWorker doesn't have this — it always uses positional.
- **Locations**
  - `src/lib/llm/codex-worker.ts:27-38`
  - `src/lib/llm/gemini-worker.ts:52-65`
- **Why diverged** — The CLI-specific stdin sentinels are different (Codex uses `'-'` as a positional, Gemini uses `' '` after `-p` because of how its help text describes stdin). That argument-construction divergence is real.
- **Consolidation hint** — Skip. The Windows-stdin shape varies per CLI and there are only two callers; abstracting this would push the divergence into a callback that's bigger than the duplication. Leave the comments and move on.

---

### ai-providers

#### 1. `llmRequest` request → `JSON.parse` → "missing field" guard

- **Concern** — Each branch of the `generateCloud` switch repeats: build `url`, build `body` via `JSON.stringify(...)`, call `llmRequest({ url, method: 'POST', headers, body })`, `JSON.parse(raw)`, dig out the text via a provider-specific path, throw `Error('XXX response missing yyy')` if not a string, return text.
- **Locations**
  - `src/lib/ai-providers.ts:74-94` — Gemini (`candidates[0].content.parts[0].text`)
  - `src/lib/ai-providers.ts:96-119` — Claude (`content[0].text`)
  - `src/lib/ai-providers.ts:121-150` — Groq/OpenAI/DeepSeek (`choices[0].message.content`) — already collapsed across 3 OpenAI-shaped providers via a nested ternary.
- **Why diverged** — The auth-header shape (`x-api-key` + `anthropic-version` vs `Authorization: Bearer` vs query-string `?key=`), the JSON request body, and the response field path all genuinely differ per vendor. The `JSON.stringify` + `llmRequest` + `JSON.parse` + extract-or-throw scaffolding is accidental.
- **Consolidation hint** — Move provider-specifics into a small registry:
  ```ts
  type ProviderAdapter = {
    buildRequest(model, apiKey, prompt): { url, headers, body: object };
    extractText(parsed): string | undefined;
    label: string;
  };
  const ADAPTERS: Record<CloudProviderId, ProviderAdapter> = { ... };
  ```
  Then `generateCloud` becomes ~10 lines: lookup adapter, build, send, parse, extract, throw on missing. This also lets the OpenAI-compatible branch register `groq | openai | deepseek` as three separate entries with their own URLs (drops the nested `?:` ternary at line 124-129).

---

### executor

#### 1. (no significant within-feature duplication)

- **Concern** — Looked for: repeated read/write of `<actionId>.json`, repeated callback wiring.
- **Findings** — `exec-state.ts` already centralizes the read/write helpers (`writeExecState`, `readExecState`). `queue-worker.ts` calls them once each; `state-bridge.ts` calls `readExecState` once. The "read then write back" pattern only appears in `runOnce` for the *initial* seed (`writeExecState(execState)` once at line 104) — the polling/mutation cycle goes through the MCP server, not back through this module. The `bridgeHandle.stop = () => {}` pattern wrapping `capturedBridge?.stop()` (lines 98, 119, 135) is a single occurrence, not duplication.
- **Verdict** — Skip. The earlier-extracted `exec-state.ts` did its job; what's left in `queue-worker.ts` is genuine orchestration with single-call sites.

---

### actions-foundation

#### 1. `set(...) → schedulePersist(() => get().actions)` action body

- **Concern** — Every store mutation closes with the same two-step pattern: `set((s) => ({ actions: s.actions.map(...) }))` followed by `schedulePersist(() => get().actions)`. This appears in 11+ store actions, sometimes inside a try/catch where both the success branch and the error branch each do their own `set + schedulePersist`.
- **Locations** (action body endings, all in `src/stores/actions-store.ts`)
  - `addAction` — `347-350`
  - `updateAction` — `352-359`
  - `deleteAction` — `361-367`
  - `updateTask` — `373-385`
  - `startPlanning` — three separate `set + schedulePersist` blocks at `404-416`, `418-432`, `439-446`, `456-473`
  - `retryPlanStage` — four separate `set + schedulePersist` blocks at `483-495`, `502-516`, `529-536`, `546-563`
  - `approvePlan` — `568-581`
  - `rejectPlan` — `584-614`
  - `requeueExecution` — `618-647`
- **Why diverged** — Accidental. Every block has the identical postlude.
- **Consolidation hint** — Wrap the store's `set` in a thin helper:
  ```ts
  function mutate(updater: (s: ActionsState) => Partial<ActionsState>) {
    set(updater);
    schedulePersist(() => get().actions);
  }
  ```
  Also extract `mapAction(id, fn)` and `mapTask(actionId, taskId, fn)` since most callers just walk `actions.map((a) => a.id === id ? { ...a, ...patch, updatedAt: new Date().toISOString() } : a)`. Reduces every action body by ~5 lines and centralizes the `updatedAt` stamp (currently re-inlined ~10 times).

#### 2. `onProgress` closure in startPlanning vs retryPlanStage

- **Concern** — The `onProgress = async (result) => set(... applyStageCommit ... tasks: result.tasks ...) ; schedulePersist(...)` closure appears verbatim in both pipeline-launching actions, then both wrap the `runPipeline` call in the same try/catch with the same `set(... status: 'plan_review' ...)` success block and the same `set(... status: 'failed' ... applyStageFailure ...)` failure block.
- **Locations** — `src/stores/actions-store.ts:418-474` (startPlanning) and `502-564` (retryPlanStage). The only differences are: (a) retryPlanStage builds a `ProjectContext` from `action.projectName`/`action.projectPath` while startPlanning takes one as an arg; (b) retryPlanStage passes `resumeFrom` and `existingTasks` to `runPipeline`.
- **Why diverged** — Accidental. The retry path was copy-pasted from startPlanning to add resume support, and the post-stage handling never got refactored back.
- **Consolidation hint** — Extract `runPlanning(actionId, project, resumeFrom?: PlanStageName, existingTasks?: ActionTask[])` as a private helper that owns the `onProgress` closure + try/catch. `startPlanning` and `retryPlanStage` shrink to: do their state-seed prelude (different — extract-running vs reset-from-stage), then call `runPlanning(...)`. Cuts ~60 lines of duplicated try/catch.

#### 3. v1/v2 status branching in `requeueExecution`

- **Concern** — Hand-coded "is this status one of the v2 execution-touched values" check via 4-way `&&` chain.
- **Locations** — `src/stores/actions-store.ts:624-630` is the only location of *that exact* check.
- **Why diverged** — Single occurrence; not duplication. The legitimate-specialization point: `nextTaskStatus` (`src/types/actions.ts:155-162`) only knows the v1 cycle and intentionally falls back to `'waiting'` on v2 statuses, with a comment saying so. The store has multiple `status === 'plan_review' | 'queued' | 'running' | 'failed' | ...` checks scattered across approvePlan, rejectPlan, requeueExecution — but each is asking a different question, so they aren't duplicates.
- **Verdict** — Not duplication; legitimate single use sites.

---

### terminal-panes

#### 1. Mutex lock + session lookup at the start of every PTY command

- **Concern** — Every `#[tauri::command]` PTY handler re-derives the same lock-then-lookup line: `let sessions = state.sessions.lock().map_err(|e| format!("Lock error: {}", e))?; let session = sessions.get(&id).ok_or("Session not found")?;` (or `.get_mut(&id)` for write/close).
- **Locations**
  - `src-tauri/src/lib.rs:151-153` — `write_pty` (mutable)
  - `src-tauri/src/lib.rs:166-168` — `resize_pty` (immutable)
  - `src-tauri/src/lib.rs:182-184` — `close_pty` (mutable, then `remove`)
- **Why diverged** — Accidental for `write_pty` and `resize_pty`. `close_pty` legitimately uses `.remove(&id)` instead of `.get(&id)`/`.get_mut(&id)` because it's tearing the session down.
- **Consolidation hint** — Add a tiny helper on `PtyManager`:
  ```rust
  impl PtyManager {
    fn with_session<F, R>(&self, id: &str, f: F) -> Result<R, String>
      where F: FnOnce(&mut PtySession) -> Result<R, String>;
  }
  ```
  `write_pty` and `resize_pty` become one-liners that pass a closure. `close_pty` keeps its own implementation since it removes the session. Saves the `format!("Lock error: {}", e)` repetition (currently in 4 places counting create_pty's `.insert`).

#### 2. `setError(String(e)); setAlive(false)` after `invoke('create_pty')`

- **Concern** — TerminalView spawns a PTY in two places (`startPty` for initial/restart, `handleSwitchShell` for shell switches). Both wrap `invoke("create_pty", { id, cols, rows, cwd: cwd || null, shell })` in identical `setError(null); setAlive(true); try { ... } catch (e) { setError(String(e)); setAlive(false); }` scaffolding.
- **Locations**
  - `src/components/TerminalView.tsx:71-81` — `startPty`
  - `src/components/TerminalView.tsx:189-204` — `handleSwitchShell` (also calls `term.clear()` and `close_pty` first, then inlines the same body instead of calling `startPty`)
- **Why diverged** — Accidental. `handleSwitchShell` was clearly copied from `startPty` instead of doing `term.clear(); await invoke('close_pty', {id}).catch(()=>{}); await startPty(term);`.
- **Consolidation hint** — `handleSwitchShell` should call `startPty(term)` after the close. The current 6-line inline duplicate goes away. Also, `handleRestart` already does this correctly (`src/components/TerminalView.tsx:181-187`), proving the helper exists.

---

### mcp-server-bridge

#### 1. `loadState` → "not found" guard at the top of every tool

- **Concern** — Three of the four state-touching tools open with the same five-line preamble: `const state = loadState(stateDir, input.action_id); if (!state) throw new Error(\`exec state for action ${input.action_id} not found\`);`. The fourth (`get-project-context.ts`) does the same with `input.project_id` (legacy field name).
- **Locations**
  - `notter-mcp-server/src/tools/get-next-task.ts:37-40`
  - `notter-mcp-server/src/tools/report-progress.ts:27-30`
  - `notter-mcp-server/src/tools/mark-done.ts:34-37`
  - `notter-mcp-server/src/tools/get-project-context.ts:27-30`
- **Why diverged** — Accidental. The `project_id` vs `action_id` argument name in `get-project-context` is a documented legacy quirk (comment at line 12: "we use action_id here; kept the spec name") so the parameter name is the only real difference.
- **Consolidation hint** — Add `loadStateOrThrow(stateDir, actionId)` to `state.ts`. All four tools open with `const state = loadStateOrThrow(stateDir, input.action_id ?? input.project_id);`.

#### 2. `task = state.tasks.find(t => t.id === input.task_id)` + not-found guard

- **Concern** — `report-progress.ts` and `mark-done.ts` both follow the state-load with the same task-lookup-or-throw: `const task = state.tasks.find((t) => t.id === input.task_id); if (!task) throw new Error(\`task ${input.task_id} not found in action ${input.action_id}\`);`
- **Locations**
  - `notter-mcp-server/src/tools/report-progress.ts:31-35`
  - `notter-mcp-server/src/tools/mark-done.ts:38-42`
- **Why diverged** — Accidental.
- **Consolidation hint** — `findTaskOrThrow(state, taskId)` next to `loadStateOrThrow` in `state.ts`. Two callers, but both tools shrink to "load → find task → mutate fields → saveState → return ok" — the lookup helper makes the per-tool body 4 lines instead of 8, and adds the guarantee that a Phase-F sixth tool can't forget the not-found check.

#### 3. The full read-modify-write sequence is uniform across all 3 mutating tools

- **Concern** — `get-next-task`, `report-progress`, and `mark-done` all follow: load state → lookup target → mutate fields on the snapshot → `saveState(stateDir, state)` → return `{ ok: true }` (or task payload). The return shape is the only material variation.
- **Locations**
  - `notter-mcp-server/src/tools/get-next-task.ts:33-66` — finds first pending task, sets `status='running'` + `startedAt`, returns task payload.
  - `notter-mcp-server/src/tools/report-progress.ts:23-40` — sets `task.summary`, returns `{ok:true}`.
  - `notter-mcp-server/src/tools/mark-done.ts:30-58` — sets `status`, `completedAt`, `result`, appends to `priorTaskSummaries`, returns `{ok:true}`.
- **Why diverged** — Legitimate specialization. The mutation body is genuinely different per tool (different fields, different status transitions, different side-effects on `priorTaskSummaries`), and there are only three call sites.
- **Consolidation hint** — Skip the full envelope; just consolidate the load/lookup helpers (items #1 and #2). A `withState(stateDir, actionId, mutator)` envelope would force the mutator signature to handle the divergent return types and would not buy more than the two helpers above.

---

## Summary

| Feature | Duplications found |
|---|---|
| planning-pipeline | 4 (skipped 1 = legitimate) |
| ai-providers | 1 |
| executor | 0 |
| actions-foundation | 2 (1 single-use rejected) |
| terminal-panes | 2 |
| mcp-server-bridge | 2 (skipped 1 = legitimate) |

**Hottest concern** — `actions-store.ts` `set + schedulePersist` postlude appears in 11+ action bodies across ~330 lines, and the `startPlanning` / `retryPlanStage` `onProgress + try/catch` block is duplicated wholesale (~60 lines).

**Most surprising legitimate-specialization** — The Codex/Gemini Windows-stdin branch *looks* like a clear consolidation candidate but the per-CLI sentinel (`'-'` positional vs `' '` after `-p`) is shaped by each CLI's published behavior — abstracting it would replace 8 lines of duplication with a callback bigger than what it replaces.
