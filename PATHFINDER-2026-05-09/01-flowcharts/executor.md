# executor — flowchart

## Sources consulted
- `src/stores/actions-store.ts:1-345` (boot path: `bootExecutor` + `startQueueWorker` invocation at line 43)
- `src/lib/executor/index.ts:1-17` (public surface)
- `src/lib/executor/queue-worker.ts:1-153` (singleton loop, dequeue, spawn, mirror)
- `src/lib/executor/exec-state.ts:1-34` (state file read/write helpers)
- `src/lib/executor/spawn-claude.ts:1-62` (Claude Code CLI process spawn via Tauri shell)
- `src/lib/executor/state-bridge.ts:1-67` (polling bridge)
- `src/lib/executor/mcp-config.ts:1-70` (per-Action `--mcp-config` JSON writer)
- `src/lib/executor/initial-prompt.ts:1-24` (CLI initial prompt)
- `src/lib/executor/types.ts:1-53` (ExecStateFile / SpawnHandle shapes)
- `src-tauri/src/lib.rs:50-180` (PTY commands — terminal-panes feature uses these; executor does NOT currently feed them)

## Happy path
`actions-store.load()` finishes hydrating and calls `bootExecutor(get)` (`actions-store.ts:344`), which is guarded by a module-level `queueWorkerStarted` flag and invokes `startQueueWorker(...)` once with a 500 ms `intervalMs` plus three store callbacks (`getActions`, `updateAction`, `updateTask`). `startQueueWorker` registers a single `setInterval` (idempotent — re-calls return early on existing `timer`); each tick fires `runOnce`. `runOnce` is itself guarded by a module-level `busy` boolean that enforces strict one-Action-at-a-time execution, then scans `getActions()` for the **first** Action whose `status === 'queued'` (FIFO by store array order, no priority). On a hit, it (1) ensures the `$APPLOCALDATA/exec-state/` dir, (2) snapshots the Action to an `ExecStateFile` (mapping `tasks[].objective → title`, defaulting `refinedPrompt` to `prompt`, and stamping every task `status:'pending'`) and writes `<actionId>.json`, (3) writes a fresh `mcp-config-<actionId>.json` pointing the `notter` MCP server at `node <serverAbsolutePath> --action-id <id> --state-dir <dir>`, (4) flips the Action to `status:'running'` in the store, (5) starts the **state bridge** (a polling loop that reads the exec-state file every 500 ms, computes a `snapshotKey` of `id:status:summary:result.summary` per task, and only fires `onChange` on diff), and (6) calls `spawnClaudeExecutor` which executes `Command.create('claude', […args…])` via `@tauri-apps/plugin-shell`, with the `buildInitialPrompt(actionId)` instructing the CLI to loop over `notter.get_next_task` / `notter.report_progress` / `notter.mark_done` MCP calls. As Claude runs (minutes), the MCP server (out-of-process Node child) rewrites the exec-state JSON; the bridge picks up changes, `mirrorStateToStore` translates each `ExecTaskSnapshot` into a `Partial<ActionTask>` patch (`status`, `summary`, `result`, `startedAt`, `completedAt`) and calls `deps.updateTask` — which threads back into the Zustand store and the debounced 300 ms `schedulePersist`. `handle.waitForExit()` resolves with the CLI exit code; the Action is flipped to `status: code === 0 ? 'done' : 'failed'`, the bridge is stopped in `finally`, and `busy` clears so the next tick can dequeue.

## Mermaid
```mermaid
flowchart TD
  StoreLoad["actions-store.load<br/>src/stores/actions-store.ts:286"] -->|after hydrate| BootExec["bootExecutor (one-shot guard)<br/>src/stores/actions-store.ts:36"]
  BootExec -->|queueWorkerStarted flag| StartQW["startQueueWorker (idempotent)<br/>src/lib/executor/queue-worker.ts:140"]
  StartQW -->|setInterval intervalMs=500| TickLoop["runOnce tick<br/>src/lib/executor/queue-worker.ts:92"]

  TickLoop -->|busy guard| BusyCheck{"busy?<br/>src/lib/executor/queue-worker.ts:93"}
  BusyCheck -->|yes| TickLoop
  BusyCheck -->|no| Dequeue["find first status==='queued' (FIFO)<br/>src/lib/executor/queue-worker.ts:94"]
  Dequeue -->|none| TickLoop
  Dequeue -->|hit| Snapshot["actionToExecState<br/>src/lib/executor/queue-worker.ts:46"]

  Snapshot --> WriteState["writeExecState exec-state/&lt;id&gt;.json<br/>src/lib/executor/exec-state.ts:22"]
  WriteState --> WriteMcp["writeMcpConfigFile mcp-config-&lt;id&gt;.json<br/>src/lib/executor/mcp-config.ts:60"]
  WriteMcp --> FlipRunning["updateAction status='running'<br/>src/lib/executor/queue-worker.ts:112"]

  FlipRunning --> StartBridge["startStateBridge<br/>src/lib/executor/state-bridge.ts:34"]
  FlipRunning --> SpawnClaude["spawnClaudeExecutor Command.spawn<br/>src/lib/executor/spawn-claude.ts:24"]

  SpawnClaude -->|claude --print --mcp-config ... initialPrompt| ClaudeProc[["Claude Code CLI process<br/>spawn-claude.ts:36-50"]]
  ClaudeProc -->|MCP stdio| MCPBridge[["notter MCP server (cross-feature: mcp-server-bridge)<br/>mcp-config.ts:33-44"]]
  MCPBridge -->|rewrites| ExecStateFile[("exec-state/&lt;id&gt;.json<br/>exec-state.ts:17")]

  StartBridge -->|setTimeout poll loop intervalMs=500| BridgeTick["tick readExecState<br/>src/lib/executor/state-bridge.ts:40"]
  BridgeTick -->|read| ExecStateFile
  BridgeTick --> SnapKey{"snapshotKey changed?<br/>src/lib/executor/state-bridge.ts:25"}
  SnapKey -->|no| BridgeTick
  SnapKey -->|yes| MirrorState["mirrorStateToStore<br/>src/lib/executor/queue-worker.ts:69"]
  MirrorState -->|deps.updateTask patch| StoreUpdate["actions-store.updateTask + schedulePersist 300ms<br/>src/stores/actions-store.ts:373"]
  StoreUpdate -.->|cross-feature: store mutation| ActionsFoundation[["actions-foundation (consumes status)"]]

  SpawnClaude -->|on close payload.code| WaitExit["handle.waitForExit<br/>src/lib/executor/spawn-claude.ts:53"]
  ClaudeProc -->|exit| WaitExit
  WaitExit --> ExitCode{"code === 0?<br/>queue-worker.ts:127"}
  ExitCode -->|yes| MarkDone["updateAction status='done'<br/>queue-worker.ts:128"]
  ExitCode -->|no / throw| MarkFailed["updateAction status='failed'<br/>queue-worker.ts:128,133"]
  MarkDone --> Cleanup["finally: bridge.stop + busy=false<br/>queue-worker.ts:135-137"]
  MarkFailed --> Cleanup
  Cleanup --> TickLoop

  ClaudeProc -.->|stdout/stderr NOT wired<br/>(gap — see notes)| TerminalPanes[["terminal-panes (cross-feature, currently unwired)"]]
```

## Side effects
- **Process spawn**: `src/lib/executor/spawn-claude.ts:50` — long-lived `claude` child via `@tauri-apps/plugin-shell` `Command.spawn()`. Lifetime is the duration of the entire Action (potentially minutes). Killable via `child.kill()` in returned `SpawnHandle.kill`.
- **Filesystem writes** (all under `$APPLOCALDATA/exec-state/`):
  - `exec-state.ts:22` — `writeExecState` writes `<actionId>.json` once at runOnce start (renderer-side seed). The MCP server then owns subsequent writes.
  - `mcp-config.ts:68` — fresh `mcp-config-<actionId>.json` per spawn (no cleanup; Phase E intentionally leaves the file for spawn-time read).
  - `mcp-config.ts:53` — `mkdir exec-state/` on first boot.
- **Filesystem reads (polling)**: `state-bridge.ts:43` reads `exec-state/<id>.json` every `intervalMs` (500 ms). 500 ms cadence is hard-coded by the caller in `actions-store.ts:46`. No FS watcher / inotify — explicit polling per the comment at `state-bridge.ts:8-10`.
- **Store mutations via callbacks** (the bridge → store boundary, never direct imports of the store from `lib/executor`):
  - `queue-worker.ts:69-90` `mirrorStateToStore` → `deps.updateTask` per task on every diff.
  - `queue-worker.ts:112,128,133` — `deps.updateAction` for `running`/`done`/`failed`.
  - All of these flow through `actions-store.ts:373/352` and trigger 300 ms debounced disk persist + 1500 ms debounced Supabase push (`debouncedActionsSync`).
- **Module-level singleton state**: `queueWorkerStarted` (`actions-store.ts:34`), `timer` and `busy` (`queue-worker.ts:37-38`). Reset only via `__resetQueueWorkerForTests` (`queue-worker.ts:40`) or `stopQueueWorker` (`queue-worker.ts:147`).
- **No Tauri events emitted** by the executor itself. The PTY `pty-output`/`pty-exit` events at `src-tauri/src/lib.rs:119-127` belong to terminal-panes' generic `create_pty` flow and are not connected to `spawnClaudeExecutor` (gap noted below).

## Error / fallback branches
- `runOnce` wraps the whole spawn-and-wait in `try/catch`; any throw flips the Action to `failed` and logs `[queue-worker] runOnce failed` (`queue-worker.ts:130-133`).
- `spawnClaudeExecutor` resolves `waitForExit` with `-1` on `'error'` event or null exit code (`spawn-claude.ts:43-48`), which then routes through `code === 0 ? 'done' : 'failed'` and lands on `failed`.
- `state-bridge.tick` swallows read errors with `console.warn('[state-bridge] poll failed', e)` and keeps polling (`state-bridge.ts:51-53`); a missing/corrupt `exec-state` file means the bridge silently produces no diffs but does not stop the spawn.
- `mcp-config.ensureExecStateDir` swallows `mkdir` errors (`mcp-config.ts:54`) — relies on subsequent `writeTextFile` to surface the real error.
- `bootExecutor` wraps `startQueueWorker` in `try/catch` and only logs `[actions-store] failed to start queue worker` (`actions-store.ts:51-53`); a boot failure leaves `queueWorkerStarted = true` (set on entry, not on success), so a second `load()` call will NOT retry.
- `finally` block in `runOnce` always stops the bridge and clears `busy` even when `updateAction(failed)` itself throws — but if it does throw, it is unhandled (no inner catch around the cleanup `updateAction`).
- Stale-status recovery on next boot: `actions-store.ts:318-323` rewrites any `status:'running'` Action back to `'draft'` and any `running` task back to `'pending'` on `load()` — this is the recovery path for a process killed mid-execution (renderer crash, app quit) since there is no on-disk re-entry resume protocol.
- The `mcp-config-<id>.json` file is intentionally not cleaned up (`spawn-claude.ts:11-13`) so cross-runOnce file accumulation is a known minor leak.

## External dependencies
- **actions-foundation** — consumed via the three `deps` callbacks (`getActions`, `updateAction`, `updateTask`) wired in at `actions-store.ts:46-49`. The executor never imports the store directly; all reads/writes go through this callback boundary. Reverse direction: `actions-foundation` produces `status:'queued'` rows that the executor dequeues, and reads `status` ∈ `running|done|failed` plus per-task `status/summary/result/startedAt/completedAt` written by the bridge.
- **mcp-server-bridge** — the `notter` MCP server is launched as a grandchild of the Tauri renderer: `claude` (via Tauri shell) reads `--mcp-config` (`spawn-claude.ts:30-31`), which points to a JSON listing `command:"node"` + `args:[serverAbsolutePath, "--action-id", id, "--state-dir", dir]` (`mcp-config.ts:33-44`). Claude Code itself spawns the MCP server. The server is the *writer* of `exec-state/<id>.json` (the renderer is the reader via the bridge). The hardcoded `PHASE_E_MCP_SERVER_PATH` at `actions-store.ts:31-32` is a known dev-only absolute path.
- **terminal-panes** — declared as a cross-feature edge in the prompt, but the executor currently does NOT emit logs to terminal-panes. `spawnClaudeExecutor` does not subscribe to `cmd.on('data')` / stdout / stderr (`spawn-claude.ts:43-48` only listens to `close` and `error`), and the Rust side `pty-output` event (`src-tauri/src/lib.rs:124`) is fired only from `create_pty` sessions started by `TerminalView`, not from `Command.spawn`. Net: the cross-feature edge to terminal-panes is **defined in scope but not implemented in code**. Drawn as a dotted edge with a "currently unwired" label.

## Confidence + gaps
high (with one explicit gap) — every node in the diagram maps to a concrete `file:line`, and the lifecycle (boot → tick → dequeue → spawn → poll → mirror → exit → cleanup) is traced unambiguously. The dequeue policy is FIFO-by-array-order with no priority field anywhere in `ActionsState` or the worker. The polling cadence (500 ms) is set by the *caller* in `actions-store.ts:46`, not the worker — worth flagging if this gets parameterized later.

Explicit gaps:
1. **terminal-panes integration is missing** — `spawnClaudeExecutor` discards stdout/stderr. The cross-feature edge from the Pathfinder prompt has no implementation today; drawn as a dotted/unwired node so the architecture review captures it as a known unbuilt dependency rather than missed analysis.
2. **No cleanup of `mcp-config-<id>.json`** — accumulates one file per Action run.
3. **No retry on boot failure** — `queueWorkerStarted` is set before the await, so a thrown `startQueueWorker` permanently disables the worker for that session.
4. **No backpressure / no parallelism** — strict singleton via `busy` boolean. Two-action-at-a-time would require extending the worker.
5. **`PHASE_E_MCP_SERVER_PATH` is a hardcoded absolute dev path** (`actions-store.ts:31-32`); packaged builds will need a different resolution strategy (the comment explicitly flags Phase F).
