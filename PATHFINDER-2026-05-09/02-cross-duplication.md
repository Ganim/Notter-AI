# 02 — Cross-Feature Duplication

Date: 2026-05-09
Scope: concerns appearing in 2+ features whose implementations look like accidental divergence rather than legitimate specialization. Every claim is anchored by ≥2 `file:line` citations and confirmed against source.

Features touched: auth-sync, planner, board-tasks, agent-chat, ai-providers, planning-pipeline, actions-foundation, executor, mcp-server-bridge, terminal-panes.

---

### Sync push: "DELETE all user rows then bulk INSERT"
- **Locations:**
  - `src/lib/sync.ts:76-98` — `pushAgentProfiles`: `delete().eq('user_id', userId)` then `insert(profiles.map(...))`.
  - `src/lib/sync.ts:116-133` — `pushProjects`: same shape (delete-by-user, then insert mapped rows).
  - `src/lib/sync.ts:259-283` — `pushBoardTasks`: same shape, mapping camelCase → snake_case.
  - `src/lib/sync.ts:301-318` — `pushActions`: same shape, JSONB column swap (`data: a`).
- **Divergence:** accidental — four functions with identical control flow (try/catch + console.error), identical "if (rows.length > 0) insert" guard, only the table name and per-row mapper differ. `pushPreferences` (`src/lib/sync.ts:36-52`) and `pushSubject` (`src/lib/sync.ts:161-179`) use a single `upsert` instead, proving destructive delete-then-insert is a copy-paste choice, not a per-table requirement.
- **Consolidation hint:** one helper `replaceUserRows<T>(table, userId, rows, toRow)` plus a couple of column-mapper closures. Could even keep the destructive semantic but centralize the gap-window risk and the `console.error` boilerplate. Better still: switch all four to `upsert` keyed by `(user_id, id)` to close the "concurrent writer wipes rows" race the auth-sync flowchart already flagged (`PATHFINDER-2026-05-09/01-flowcharts/auth-sync.md:98`).

### Realtime listener: "re-SELECT all rows on any change"
- **Locations:**
  - `src/lib/realtime.ts:37-59` — `agent_profiles` listener: `postgres_changes` → `SELECT * WHERE user_id=eq.<uid>` → `applyRemoteProfiles`.
  - `src/lib/realtime.ts:60-76` — `projects` listener: same exact body, different table + applier.
  - `src/lib/realtime.ts:77-94` — `subjects` listener: same body.
  - `src/lib/realtime.ts:95-119` — `board_tasks` listener: same body.
  - `src/lib/realtime.ts:120-133` — `actions` listener: same body.
- **Divergence:** accidental — five copies of an `async () => { const { data } = await supabase.from(<T>).select('*').eq('user_id', userId); if (data) { … applyRemote(map(data)) } }` block. Only the `user_preferences` listener (`src/lib/realtime.ts:20-36`) is different (it consumes `payload.new` directly without a re-SELECT). The fetcher mapping is also a near-copy of the `fetch*` mappers in `sync.ts` (e.g. `src/lib/realtime.ts:104-115` ≡ `src/lib/sync.ts:242-253` for board tasks).
- **Consolidation hint:** one helper `subscribeUserTable(channel, table, userId, refetchAndApply)` whose `refetchAndApply` is the existing `fetch*` from `sync.ts` composed with the existing `applyRemote*` from the store. Removes ~80 lines and forces every new synced table to share the same chatty-fetch contract.

### "Note → JSON action" LLM flow (cloud HTTP API surface)
- **Locations:**
  - `src/lib/action-processor.ts:55-96` — `extractJson` + `parseAiResponse`: strip ```` ``` ```` fences, slice from first `{` to last `}`, `JSON.parse`, validate keys.
  - `src/lib/callback-analyzer.ts:62-99` — `parseAnalysisResponse`: identical strip-fence + brace-slice + `JSON.parse` block, narrows different schema.
  - `src/lib/planning/stage-runner.ts:45-72` — `stripJsonNoise`: a slightly more permissive version of the same idea (handles preamble before `{`).
- **Divergence:** accidental — three implementations of the same "LLM JSON cleaning pipeline." `action-processor` and `callback-analyzer` differ only in which keys they pluck off the parsed object; `stage-runner` is the most evolved version but lives in a different feature.
- **Consolidation hint:** export `stripJsonNoise` (or a renamed `extractJsonObject`) from a single place (e.g. `src/lib/llm/json-utils.ts`) and have v1 (`action-processor`, `callback-analyzer`) consume it. Keeps the schema-specific validators where they are.

### Two LLM transport stacks: HTTP API (v1) vs CLI subprocess (planning)
- **Locations:**
  - `src/lib/ai-providers.ts:63-152` + `src/lib/chat.ts:14-140` — cloud chat / v1 actions: `invoke('llm_request')` HTTP proxy through Tauri Rust, builders + parsers per provider.
  - `src/lib/llm/spawn-helper.ts:253-422` — generic CLI spawn (Windows stdin temp-file dance, timeout, error mapping).
  - `src/lib/llm/claude-code-worker.ts:38-104`, `src/lib/llm/gemini-worker.ts:42-103`, `src/lib/llm/codex-worker.ts:20-73` — three CLI workers wrapping `spawnCli` with provider-specific args and stdout parsing.
- **Divergence:** legitimate at the transport layer (HTTP request vs spawn a CLI requires different infrastructure), BUT each path duplicates concerns the other already solves:
  - error classification: `classifyClaudeError`/`classifyCodexError`/`classifyGeminiError` (`src/lib/llm/claude-code-worker.ts:107-159`, `src/lib/llm/codex-worker.ts:107-158`, `src/lib/llm/gemini-worker.ts:121-172`) all share the same auth/rate-limit/network pattern keyword-search and produce identical `LLMWorkerError` reasons. Three near-identical functions.
  - prompt assembly + JSON cleaning: `chat.ts` builders/parsers vs the planning-pipeline `runStage` + `stripJsonNoise` (`src/lib/planning/stage-runner.ts:114-189`).
  - The two paths are not unified by an interface either — `chat.ts` returns `{content, error}`, workers return `LLMResponse`/throw `LLMWorkerError`.
- **Consolidation hint:** keep the transports separate but extract a shared `classifyLlmError(stderrOrMessage)` helper and define a single `LLMWorker`-shaped interface that v1 can also implement (so `action-processor`/`callback-analyzer` could swap between HTTP cloud and a CLI worker without code duplication). Today a Claude HTTP path is in `ai-providers.ts:96-119` while a Claude CLI path is in `claude-code-worker.ts` — they cannot share configuration.

### Two execution paths for action tasks: PTY-write (v1) vs spawn-claude (v2)
- **Locations:**
  - `src/lib/action-runner.ts:22-56` — v1 `runActionInTerminal`: filter `waiting` tasks, `invoke('write_pty', ...)`, mark task `running`, set terminal badge.
  - `src/lib/action-runner.ts:62-86` — v1 `runActionQueue`: drive multiple actions sequentially in the same terminal.
  - `src/lib/executor/queue-worker.ts:92-138` — v2 `runOnce`: pick `queued` action, write exec-state file, spawn claude-code, poll for progress, mark `done`/`failed`.
  - `src/lib/executor/spawn-claude.ts:24-62` — v2 spawn helper.
- **Divergence:** legitimate at the macro level (PTY shell vs autonomous Claude with MCP), BUT the small "drive an action through its task list and update the store" envelope is duplicated and now lives in two places that disagree on data shape (v1 `task.status: 'waiting' | 'running'` in `action-runner.ts:33,40`; v2 `task.status: 'pending' | 'running'` in `queue-worker.ts:73-76`). Active call sites confirm both are still in production: `src/components/ActionsTab.tsx:48` (v1) and `src/stores/actions-store.ts:43` (v2). The "v1↔v2 seam" is already documented at `actions-foundation` (observation #34), but neither path is explicitly retired.
- **Consolidation hint:** decide v1 is deprecated, then either delete `action-runner.ts` once `ActionsTab.tsx`/`ActionDetail.tsx` migrate, or extract a shared "advance task status" core that both runners call. Until then, every status-name change has to be replicated in two places.

### Per-store debounced "save to disk + push to Supabase" pattern
- **Locations:**
  - `src/stores/actions-store.ts:200-208` (`debouncedActionsSync`, 1500ms) + `src/stores/actions-store.ts:245-262` (`schedulePersist`, 300ms).
  - `src/stores/board-store.ts:11-19` (`debouncedBoardSync`, 1000ms) + `src/stores/board-store.ts:22-38` (`debouncedSave` per-project, 300ms).
  - `src/stores/planner-store.ts:23-31` (`debouncedProjectSync`, 1000ms) + `src/stores/planner-store.ts:33-41` (`debouncedSubjectSync`, 1000ms).
  - `src/stores/agents-store.ts:17-25` (`debouncedProfileSync`, 1000ms) — fires inside `saveProfiles`, no debounced disk write.
  - `src/stores/app-store.ts:34-42` (`debouncedSync`, 1000ms) — preferences only.
- **Divergence:** accidental — five copies of the exact pattern `let timer | null; if (timer) clearTimeout(timer); timer = setTimeout(() => { const userId = useAuthStore.getState().user?.id; if (userId) push…(userId, payload); }, MS);`. Three different timeout values (300/1000/1500) with no comment explaining why. Only `actions-store` exposes a `flushActionsStore` for window-close (`src/stores/actions-store.ts:269-279`); the other four lose their pending writes on app exit.
- **Consolidation hint:** one helper `makeDebouncedSync<T>(pushFn, ms)` returning `{ schedule(payload), flush() }`. Pick one debounce value (probably 1000ms), centralize the `useAuthStore.getState().user?.id` lookup, and add `flush()` to the app-close handler so no store has the silent data-loss footgun.

### Exec-state file types & I/O — duplicated across renderer and MCP server runtime
- **Locations:**
  - Types: `src/lib/executor/types.ts:10-44` ≡ `notter-mcp-server/src/state.ts:15-50` (same `ExecTaskStatus`, `ExecTaskResult`, `ExecTaskSnapshot`, `PriorTaskSummary`, `ExecStateFile`, byte-for-byte except for the import line).
  - I/O helpers: `src/lib/executor/exec-state.ts:22-34` (Tauri-fs writeTextFile/readTextFile) vs `notter-mcp-server/src/state.ts:56-71` (Node fs writeFileSync/renameSync, atomic via .tmp).
- **Divergence:** legitimate at the I/O layer (renderer can't call `node:fs`, MCP server can't call Tauri plugin-fs); accidental for the type definitions. The renderer side is non-atomic (no .tmp+rename) while the MCP side is — guaranteed to bite when the renderer crashes mid-write. Both files acknowledge the duplication in comments (`src/lib/executor/exec-state.ts:5-6`, `src/lib/executor/types.ts:3-7`) and explicitly defer it to "Phase G".
- **Consolidation hint:** publish a tiny shared package (`@notter/exec-state-types`) with just the type definitions; the runtime helpers can stay separate but should agree on atomicity (port the MCP `.tmp + rename` to the renderer side). Schema is a single seam between two long-running processes — drift here will be bug-prone.

### Boot-time singleton flag with same idempotency-but-not-race-safe pattern
- **Locations:**
  - `src/stores/actions-store.ts:34-54` — `let queueWorkerStarted = false; … if (queueWorkerStarted) return; queueWorkerStarted = true; await startQueueWorker(...)`.
  - `src/lib/realtime.ts:12-18` — `let channel … if … stopRealtimeSync(); channel = supabase.channel(...).subscribe();` (idempotent by tearing down the previous channel).
  - `src/lib/executor/queue-worker.ts:37-45,140-145` — `let timer; let busy = false; if (timer) return; timer = setInterval(...)`.
  - `src/stores/auth-store.ts:112-115` — `if (session?.user) { syncOnLogin(session.user.id); startRealtimeSync(session.user.id); }` (no await, identical issue noted in flowchart at `01-flowcharts/auth-sync.md:102`).
- **Divergence:** accidental — three slightly different "boot a singleton without awaiting" patterns. `bootExecutor` flips its flag _before_ awaiting `startQueueWorker`, so a second call during the await silently no-ops even if the first failed mid-init (`actions-store.ts:39-50`); `realtime.ts` instead always tears down before re-subscribing (safer but more expensive); `queue-worker.ts` checks `timer` truthy. None share a helper.
- **Consolidation hint:** one `runOnce(asyncFn)` utility that flips the flag _after_ success, plus a documented decision on "tear-down + restart" vs "first-wins." Today the same project has both, and the choice depends on which file you're editing.

---

## Top 5 cross-feature duplications worth consolidating (highest payoff first)

1. **Sync push pattern (4× DELETE-then-INSERT in `sync.ts`)** — biggest payoff: removes ~120 lines, lets us close the race window the auth-sync flowchart already flagged, and forces every new synced table through one chokepoint. (Concern #1.)
2. **Realtime listeners (5× re-SELECT-and-apply in `realtime.ts`)** — pairs naturally with #1: same data-shape contract, same fetcher mapping. Removes ~80 lines and removes one of the two places `agent_profiles` row mapping is duplicated. (Concern #2.)
3. **Per-store debounced persist+push (5 stores)** — every new persisted store today copies this pattern; consolidating it forces every store to have a `flush()` and removes the silent app-close data loss in `board`/`planner`/`agents`/`app` stores. (Concern #6.)
4. **LLM JSON cleaning (3× strip-fence-and-brace-slice)** — small line count but it's the kind of code where bugs hide for months (one path tightens its regex, the others drift). Single export from `src/lib/llm/json-utils.ts` is one PR. (Concern #3.)
5. **CLI worker error classification (3× `classify*Error` keyword-search functions)** — tiny consolidation, but it removes the "if I add a new keyword to claude, do I need to add it to gemini and codex too?" footgun, and the next CLI we add (Cursor? Aider?) inherits the rules for free. (Concern #4 sub-bullet.)

(Concern #5 — the v1 PTY runner vs v2 queue-worker — is intentionally NOT in the top 5: the right move there is to retire v1, not consolidate the two; that's a feature-removal task, not a refactor. Concern #7 — exec-state types — is already explicitly deferred to "Phase G" by the codebase itself; ranking it high would be redundant.)
