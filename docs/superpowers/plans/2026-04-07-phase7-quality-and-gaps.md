# Phase 7 — Quality fixes + Spec gap closure

**Goal:** Lock in production quality across phases 1-6 by fixing 12 critical bugs, 7 important issues, missing i18n, dead code, and closing the highest-value functional gaps from the original Actions/Tasks vision.

**Scope decisions:**
- Option D from review: critical + important + functional gaps + tests
- G2 (Roadmap view), G6 (Role assignment matrix), G3 (Auto-feedback capture) and G5 (Auto-completion detection) DEFERRED to Phase 8
- G4 (Terminal badge) kept — simpler version that just shows the task name when user manually clicks Run

## Execution batches

### Batch A — Critical one-line fixes
1. Claude model ID → `claude-sonnet-4-5-20250929`
2. `crypto.randomUUID()` for action/task IDs (replaces `Date.now()+random.slice`)
3. JSON extraction: slice from first `{` to last `}` instead of fence-only stripping
4. Reset stale `Action.status === 'processing'` on `actions-store.load()`
5. Pull concurrency race: functional `set` form
6. `installOllama` re-entrancy guard (early-return if already running)
7. Inno Setup exit code: accept 0 AND 3010 as success
8. Provider consistency on `ai-store.initialize()`: fall back to `ollama` if persisted cloud has no key

### Batch B — Persistence robustness
9. Atomic write: `actions.json.tmp` then `rename` to `actions.json`
10. Flush on `close-requested` Tauri window event
11. Synchronous hydration of persisted state in `ai-store` (avoid double-render flash)

### Batch C — Async closure & leak fixes
12. `handleAnalyze` stale closure → use `useActionsStore.getState()` before patching
13. `TestConnection` AbortController for the 90s timeout + ref-stored timers cleared on unmount
14. `TaskItem.feedbackDraft` syncs from `task.returnText` when external updates happen
15. `ollama.pullModel` releases reader in `finally`
16. `deep-link.handleAuthUrl` adds `.catch` on the exchange promise

### Batch D — Rust improvements
17. `write_pty` releases mutex before `write_all` (take writer out, drop lock, write)
18. `ollama_install.rs` Inno Setup exit codes (covered in batch A on the JS side, but also normalize Rust return)

### Batch E — Terminal badge (G4 only, simpler version)
19. `terminals-store` extended with `runningTask: Record<consoleId, { actionId, taskId, label } | null>`
20. New action `setTerminalRunningTask(consoleId, payload | null)` that updates the map
21. `TaskItem.handleRun` and `ActionDetail.handleProcessAll` set the runningTask when injecting; clearing requires user action
22. `TerminalView` shows a small badge in the title bar when `runningTask` for that console is set ("⚙ <task objective>")
23. When user marks task as Done/Failed in TaskItem, the runningTask is cleared from terminals-store

### Batch F — Process queue (G1)
25. `actions-store.processQueue: string[]` (action IDs)
26. New action `enqueueAction(id)` and `processQueueWorker()` that drains it
27. `ActionsTab` header gets a "Process all" button that enqueues all `waiting` actions
28. Worker processes one action at a time using `ActionDetail.handleProcessAll` logic

### Batch G — i18n + dead code + UX polish
29. i18n: all hardcoded strings in `TaskItem`, `ActionDetail`, `OllamaPanel`, `CloudProvidersSection`, `ManageAiDialog` get `t()` calls
30. PT-BR translations for new strings
31. Delete dead code in `PlannerTab`: `handleTransform`, `setIsTransformOpen`, `setIsTransforming`, board task creation states (kept the dialog JSX too — drop it all)
32. `ManageAiDialog` provider list buttons get `aria-label` and `role="button"` keyboard support
33. `getActionProgress` moved from `actions-store.ts` to `lib/actions-utils.ts`
34. Auto-analyze on Mark Done if feedback present (TaskItem)
35. ProcessAll button shows "(N pending)" count

### Batch H — Tests for everything
36. `actions-store.test.ts`: new tests for atomic write, flush on close, stale processing reset, getState fallback
37. `ai-store.test.ts`: provider consistency on init, pull concurrency, install re-entrancy
38. `ai-providers.test.ts` (NEW FILE): all 4 adapters — body shape, header shape, response parsing, error paths
39. `ai-client.test.ts` (NEW FILE): dispatch branch coverage
40. `action-processor.test.ts`: prose-before-JSON, fences with language tag, malformed task entries
41. `callback-analyzer.test.ts`: missing fields, non-array newTasks, complete:true with non-empty newTasks (ignore newTasks?)
42. `terminals-store.test.ts` (NEW FILE): runningTask map updates, clearing semantics

## Out of scope (deferred to Phase 8)
- Roadmap view of action queue (design-intensive UI)
- Role assignment matrix (planner/task/feedback per provider)
- Auto-feedback capture via shell sentinels (G3)
- Auto-completion detection from exit codes (G5)
- API key keychain storage (security upgrade)
- Component integration tests for React UI flows
- ARIA full audit (only add minimum on provider list now)

## Success criteria
- All 60 existing tests still pass
- 28+ new tests added (estimate)
- Cloud Claude actually works (currently returns 404)
- Closing the app no longer loses unsaved actions
- Crash mid-write no longer corrupts `actions.json`
- Terminal shows which task it's currently running (set when user clicks Run, cleared when user marks Done/Failed)
- Process All button on ActionsTab queues every waiting action
- Zero hardcoded English strings in user-facing components
