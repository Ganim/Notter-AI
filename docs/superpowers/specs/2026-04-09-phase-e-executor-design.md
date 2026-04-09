# Phase E — Minimum Viable Executor (design supplement)

**Supplements:** `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §7–§11.
**Scope:** first cut of the autonomous executor loop. Ships the MCP server + Queue Worker + Claude Code spawn so an approved Action can actually run. Full HITL and ActionReport generation are deferred to Phase F; git isolation to Phase G.

## 1. Goal

After Phase D, approving a plan leaves tasks in `status: 'pending'` and the Action in `status: 'queued'` with no consumer. Phase E gives them a consumer: a singleton Queue Worker that picks up queued Actions, spawns Claude Code with an MCP-Server-Notter connection, lets Claude execute the refined tasks autonomously, and transitions the Action to `done` (success) or `failed` (error).

The terminal state of this phase is **"a task I planned with Phase D is executed by a real Claude Code subprocess, files are modified in the project, and the UI shows it as done"**.

## 2. Non-goals (explicit, to keep Phase E small)

- **Full HITL modal.** `ask_user` tool is stubbed to return `{ answer: 'proceed' }` immediately. Manual-trust tasks therefore run without a human gate in Phase E. Documented limitation; fixed in Phase F.
- **ActionReport generation.** When the executor finishes, the Action transitions directly to `done` (or `failed`); no Gemini summarization, no diff capture. Phase F adds the report step.
- **Mid-execution cancel.** Once Claude Code is running, there is no UI control to abort. If the user wants to stop, they kill the app. Phase F adds a proper cancel path.
- **Crash recovery.** If AgentTrack crashes mid-execution, orphaned Actions are left in `running` status; on next boot the load() path already resets them (it currently maps v2 `running` → `draft`, which is too aggressive but acceptable for the MVP). Phase F adds a proper orphan detector.
- **Git integration.** No branch-per-action, no commit-per-task, no rollback. The user is responsible for their own version control during Phase E E2E. Phase G adds git isolation.
- **Parallel execution.** Queue Worker is a strict singleton — one Action at a time. Documented in spec §8.

## 3. Architecture overview

Three new units:

1. **`notter-mcp-server/`** — a new Node sidecar workspace at the repo root (peer to `src/` and `src-tauri/`). Uses `@modelcontextprotocol/sdk` over stdio. Ships 5 tools. Completely stateless between calls; all Action state lives in a per-Action JSON file under `$APPLOCALDATA/exec-state/<actionId>.json`.
2. **`src/lib/executor/`** — new pure TypeScript library that owns: building the per-Action MCP config file, spawning `claude.exe` with the right flags, polling the exec-state file to mirror progress into the Zustand store, and running the Queue Worker loop.
3. **UI additions** — a "Start Execution" button on `PlanReviewPanel` (becomes the next action after approve, visible when Action.status is `queued`), and live task-status rendering in `ActionDetail` while Action.status is `running`.

### 3.1 State-sharing strategy (file-based IPC)

The MCP server is a Node subprocess spawned by Claude Code. It cannot access the Zustand store directly. Communication happens via a JSON file per Action:

```
$APPLOCALDATA/exec-state/<actionId>.json
```

Shape:
```jsonc
{
  "actionId": "act-...",
  "projectPath": "D:/path/to/project",
  "projectName": "notter",
  "tasks": [
    {
      "id": "t1",
      "title": "...",
      "refinedPrompt": "...",
      "securityFlags": [],
      "dataFlags": [],
      "trustLevel": "semi",
      "status": "pending",          // pending | running | done | failed
      "result": null,               // filled by mark_done
      "startedAt": null,
      "completedAt": null
    }
  ],
  "priorTaskSummaries": []          // filled as mark_done calls land, read by get_project_context
}
```

**Write path (executor → file)**: Queue Worker writes the file once when it starts the Action (full snapshot from the Zustand store).
**Read path (file → MCP server)**: each tool handler in the MCP server reads the file on every call, mutates it, writes it back atomically (temp+rename). No locks; the MCP server is single-threaded per Action.
**Sync path (file → Zustand store)**: Queue Worker polls the file every 500ms while the Action is running and mirrors any changes into the store via the existing `updateTask` / `updateAction` actions. Polling is fine — the MCP server writes at most a few times per task (report_progress, mark_done), so we'll never miss a meaningful state change.

Tradeoffs:
- Upside: no IPC plumbing, crash-safe (file survives either process dying), trivial to test (mock the fs layer).
- Downside: ~500ms UI latency on live progress. Acceptable for the MVP.

### 3.2 Claude Code spawn pattern (validated in Phase A spike)

Per the existing spec §8.4 and `spike/notes.md`:

```
claude --print --mcp-config <path-to-temp-config.json> --strict-mcp-config <initial-prompt>
```

- `--print`: one-shot headless mode (no interactive REPL).
- `--mcp-config <path>`: loads MCP server definitions from a JSON file we write per invocation.
- `--strict-mcp-config`: ignores user/project/global MCP config so we only see `notter`.
- `<initial-prompt>`: the final positional arg is the initial user message.

The temp config file has shape:
```json
{
  "mcpServers": {
    "notter": {
      "command": "node",
      "args": ["D:/path/to/notter-mcp-server/dist/server.js", "--action-id", "act-abc"],
      "env": { "AGENTTRACK_STATE_DIR": "C:/Users/.../AppData/Local/com.guilh.notterai/exec-state" }
    }
  }
}
```

Claude Code spawns `node <path-to-server.js>` as its MCP subprocess. It connects over stdio. The server reads `AGENTTRACK_STATE_DIR` to find the exec-state files. One `--action-id` per invocation keeps the server scoped to a single Action.

**Spawn mechanism from AgentTrack:** reuse `spawnCli` from `src/lib/llm/spawn-helper.ts`? No — spawn-helper is for short-lived CLIs where we capture and return output. The executor needs to **let claude run for minutes**, stream progress to the UI via file polling, and clean up on exit. We'll build a new `spawnClaudeExecutor` in `src/lib/executor/spawn-claude.ts` using Tauri's `Command.spawn()` (streaming) instead of `Command.execute()`. Cleanup via the existing `.tmp-prompts/` temp file machinery.

**stdin for the initial prompt:** claude takes the initial prompt as a positional arg on the command line. That's what the spec §8 says. We'll do that too. Windows BatBadBut doesn't apply because `claude.exe` is a real PE, not a `.cmd` shim — no sanitizer trips.

### 3.3 Initial prompt

```
You are the executor for action <id>. Use the `notter` MCP tools to retrieve and complete
tasks one at a time. Workflow:

1. Call `notter.get_next_task` to receive a task object. If it returns `{"done": true}`, stop and exit.
2. If the task's `trust_level` is "manual", call `notter.ask_user` first with the refined prompt and wait for confirmation.
3. Follow `refined_prompt` literally. Respect `security_flags` and `data_flags` as hard constraints.
4. Call `notter.report_progress` as you make meaningful progress (file created, command run, etc).
5. When the task is complete, call `notter.mark_done` with a summary, files_changed list, and tests_run results if any. On failure, include `error_message`.
6. Repeat from step 1 until `get_next_task` returns `{"done": true}`.

Do not stop to explain what you're doing — call the MCP tools to report progress instead. When you reach "done: true", you may write a final short summary and exit.
```

Minor variation from the spec §8.5 prompt: the literal instructions are the same, but Phase E stubs `ask_user` so the "wait for confirmation" step always unblocks immediately. We keep the instruction in the initial prompt anyway, so Phase F can remove the stub without touching the prompt.

## 4. MCP tool contracts (Phase E details)

All 5 tools follow the shapes in spec §7. Phase E specifics:

### 4.1 `notter.get_next_task`
Input: `{ action_id: string }`. Output: the first task in state.tasks where `status === 'pending'`, enriched with `project_context: { path, name, is_greenfield }`. If no such task, returns `{ done: true }`.

**First-task side effect:** sets that task's `status` to `running`, `startedAt` to now. Writes the state file. This means the Queue Worker's next poll tick will see `running` and mirror it to the store.

### 4.2 `notter.report_progress`
Input: `{ task_id, status, summary }`. Updates only the `summary` field on the target task (status is already `running` from `get_next_task`). Writes the state file. The `status` input is accepted but ignored in Phase E — the server authoritatively manages status based on which tool was called (get_next_task → running, mark_done → done|failed). Phase F may honor it for `blocked_hitl`.

### 4.3 `notter.mark_done`
Input: `{ task_id, summary, files_changed, tests_run?, error_message? }`. Updates the target task's `status` to `done` (or `failed` if `error_message`), sets `completedAt`, and fills the `result` object. Appends `{ title, summary }` to `priorTaskSummaries`. Writes the state file.

### 4.4 `notter.get_project_context`
Input: `{ project_id, include_file_tree? }`. Output: `{ path, name, is_greenfield, prior_tasks: priorTaskSummaries }`. `file_tree` is NOT implemented in Phase E (would require walking the filesystem; YAGNI until Claude asks).

### 4.5 `notter.ask_user` (STUBBED)
Input: `{ task_id, question, options? }`. Output: `{ answer: 'proceed', timeout: false }`. Logged to stdout for debugging. Phase F replaces this with the real HITL flow.

## 5. Queue Worker

A singleton registered during `actions-store.load()` (after initial actions load). Behavior:

```
loop every 500ms:
  if busy: continue
  find first action with status === 'queued'
  if none: continue
  busy = true
  try:
    write exec-state/<id>.json from current action snapshot
    action.status = 'running' (persist)
    spawn claude --print --mcp-config <path> --strict-mcp-config "<initial-prompt>"
    while claude alive:
      sleep 500ms
      read exec-state/<id>.json
      diff against last-seen snapshot
      mirror tasks[] into store via updateTask (store notices identical snapshots and bails)
    await claude exit
    if exit code 0:
      action.status = 'done'  (Phase F will insert 'report_review' here)
    else:
      action.status = 'failed'
  finally:
    remove temp mcp-config file
    busy = false
```

**Singleton enforcement:** the module-level `busy` flag guards re-entry. The interval timer is registered once (first call to `startQueueWorker()`) and cancelled only on app shutdown.

**Why not event-driven?** The Zustand store does not currently expose a subscribe API that's safe to call from outside a React render. Polling keeps this trivial. Interval is 500ms; the user will never notice the latency.

## 6. UI surfaces

### 6.1 `PlanReviewPanel`
After approve, the panel already transitions the Action to `queued`. Phase E adds a small banner inside the panel: "Waiting for executor..." when `action.status === 'queued'`. No button needed — the Queue Worker picks it up automatically within 500ms.

### 6.2 `ActionDetail` while running
When `action.status === 'running'`, the existing task list renders with live per-task progress:
- `pending` → gray circle
- `running` → spinner + latest `summary` from `report_progress`
- `done` → green check + `result.summary`
- `failed` → red alert + `result.errorMessage`

The existing `TaskItem` component covers most of this via its status badge; Phase E just adds a subtle summary line underneath when one is present.

### 6.3 `PlanStageStrip`
No change. The stage strip is only relevant for the planning pipeline, not execution.

## 7. Error handling

| Failure | Detection | Recovery |
|---|---|---|
| Claude Code refuses to spawn (missing binary) | Tauri `Command.spawn()` rejects | Action → `failed`, `errorMessage` set, Worker continues to next queued Action |
| MCP server crashes before Claude connects | Claude exits non-zero; `exec-state/<id>.json` shows no tasks `running` | Action → `failed`, `errorMessage: "MCP server did not start"` |
| Individual task fails (claude calls `mark_done` with `error_message`) | `mark_done` writes failed status; Worker mirrors it | Task stays failed; Claude proceeds to next task. Action's final status is `failed` if ANY task failed, `done` otherwise |
| Claude exits before `get_next_task` returns `{done:true}` | Worker detects exit while pending tasks remain | Action → `failed`, `errorMessage: "executor exited early"` |
| Polling fails to read state file (corrupted, missing) | `readFile` throws | Log and keep polling; if persistent for >5s, Action → `failed` |
| Timeout | Each Action gets a 30-minute wall-clock ceiling | Kill the claude process, Action → `failed` with timeout reason |

## 8. Testing strategy

**Unit tests (vitest, mocked fs/shell):**
- `mcp-config.ts` — correct JSON shape for the --mcp-config file, proper args, proper env
- `state-bridge.ts` — reading and mirroring exec-state changes into the store mock, idempotent when file content unchanged
- `queue-worker.ts` — transitions: idle → busy → idle, picks queued, ignores running/done, surfaces spawn errors as `failed`
- `notter-mcp-server` tool handlers — each tool asserted against a fake state file: `get_next_task` returns first pending, `mark_done` transitions done + appends to priorTaskSummaries, `ask_user` returns the stub, etc.

**Integration test (gated):**
- Spawn a real `claude --print --mcp-config <fake> --strict-mcp-config "echo hi"` with a fake state file containing one trivial task (`echo done`), assert `exec-state/*.json` shows task `done` afterwards. Skip if `claude` binary is not on PATH. Non-blocking for CI.

**Manual E2E (documented in spike/notes.md):**
- Run the Phase D pipeline against a real note → approve → wait ~5 minutes → verify files in the project were actually changed and tasks are marked done in the UI. This is the definition-of-done for Phase E.

## 9. Success criteria

Phase E is done when:
1. A Phase D Action can be approved and runs to completion without manual intervention (modulo the stubbed ask_user).
2. The UI shows live per-task progress (`running` → `done`) sourced from the MCP server.
3. The project files on disk actually reflect what the tasks instructed.
4. If a task fails, the Action correctly transitions to `failed` with an error message.
5. Unit suite remains green (~285 tests after Phase E additions).
6. `spike/notes.md` has a "Phase E runtime validation" section documenting one successful E2E run.

## 10. Open decisions (explicit)

| Question | Decision | Rationale |
|---|---|---|
| Where does the MCP server code live? | New workspace `notter-mcp-server/` at repo root, not inside `src/` | Ships as an independent node script; cleanly separated from the renderer |
| Does MCP need its own `package.json`? | Yes — independent deps on `@modelcontextprotocol/sdk` | Avoids bloating the Tauri app bundle |
| Does `notter-mcp-server` need build output? | Yes, `tsc --outDir dist` so `node dist/server.js` works without ts-node | Simpler spawn; no runtime TS compilation |
| How does `claude-code` find the server on disk? | Absolute path written into the --mcp-config JSON at spawn time | Portable across dev/packaged builds |
| Should the MCP server share types with the renderer? | Duplicate for Phase E; deduplicate in Phase G | Shared types require path aliases in node tsconfig; YAGNI until we need it |
| Capability changes? | None expected — `claude` is already in `shell:allow-execute`, and the MCP server is spawned by claude itself (not by Tauri), so Tauri's allowlist does not gate it | Verify manually; if claude's subprocess spawn is sandboxed, add `node` to allowlist |

## 11. Implementation order (to be formalized in the plan)

1. Scaffold `notter-mcp-server/` with package.json, tsconfig, empty server.ts
2. Implement state file shape + atomic write helper in TS
3. Implement MCP server with 5 tool handlers (ask_user stubbed)
4. Unit tests for MCP tools against a fake state file
5. Build step: `tsc` into `dist/`
6. Implement `src/lib/executor/mcp-config.ts` (write config JSON)
7. Implement `src/lib/executor/spawn-claude.ts` (streaming spawn)
8. Implement `src/lib/executor/state-bridge.ts` (file → store mirror)
9. Implement `src/lib/executor/queue-worker.ts` (singleton loop)
10. Register Queue Worker in `actions-store.load()`
11. UI: banner in `PlanReviewPanel` when queued
12. UI: live task status in `ActionDetail` when running
13. Unit tests for each executor module
14. Manual E2E validation (this is the gate)

Each step is an atomic commit.
