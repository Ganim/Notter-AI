# 00 — Feature Inventory (Notter-AI)

Date: 2026-05-09
Source-of-truth scan: `src/`, `src-tauri/src/`, `supabase/`, `notter-mcp-server/src/`.
Out of scope: `node_modules/`, `dist/`, `target/`, `.git/`, `spike/` (isolated experiment subproject with own `package.json`; not imported by `src/`).

## Approved features (11)

| # | Name | Side | Purpose |
|---|------|------|---------|
| 1 | planner | frontend | Project/subject markdown workspace |
| 2 | terminal-panes | cross-cutting | Multi-tab xterm shell (frontend + Tauri PTY) |
| 3 | board-tasks | frontend | Kanban-style task tracking |
| 4 | agent-chat | frontend | Multi-provider chat UI for agent profiles |
| 5 | ai-providers | cross-cutting | Provider config + model selection (Ollama/Claude/Groq/Gemini/OpenAI/DeepSeek) |
| 6 | planning-pipeline | frontend | 4-stage autonomous planning (extract → security → data_consistency → prompt_critic) |
| 7 | actions-foundation | frontend | Action data model, storage, task UI |
| 8 | executor | rust-backend | Queue worker singleton: dequeues actions, spawns Claude Code CLI, mirrors exec-state |
| 9 | mcp-server-bridge | mcp-server | Notter MCP server (5 tools) consumed by spawned Claude Code |
| 10 | auth-sync | supabase | Supabase login + cross-store sync (preferences, profiles, projects, subjects, board, actions) |
| 11 | auto-updater | rust-backend | Tauri auto-update check + install |

### Detailed entries

#### 1. planner
- Entry: `src/App.tsx:8` → `<PlannerTab />`
- Core: `src/components/PlannerTab.tsx`, `src/stores/planner-store.ts`, `src/lib/sync.ts`
- Notes: Hosts the "Plan with AI" button (which delegates to feature 6).

#### 2. terminal-panes
- Entry: `src/App.tsx:8` → `<TerminalsTab />`
- Core: `src/components/TerminalsTab.tsx`, `src/stores/terminals-store.ts`, `src-tauri/src/lib.rs:29-100` (PTY commands)
- Notes: Used as the log surface for executor (feature 8).

#### 3. board-tasks
- Entry: `src/App.tsx:8` → `<BoardTab />`
- Core: `src/components/BoardTab.tsx`, `src/stores/board-store.ts`, `supabase/schema.sql:59-76`
- Notes: Distinct from actions-foundation (feature 7) — manual user task list, not pipeline output.

#### 4. agent-chat
- Entry: `src/App.tsx:8` → `<AgentsTab />`
- Core: `src/components/AgentsTab.tsx`, `src/stores/agents-store.ts`, `src/lib/chat.ts`
- Notes: Reads provider/model config from feature 5.

#### 5. ai-providers
- Entry: `src/components/ai/ManageAiDialog.tsx` (and provider stores)
- Core: `src/lib/ai-providers.ts`, `src/stores/ai-store.ts`, `src/components/ai/*`, `src-tauri/src/lib.rs` (llm_request handler), `src-tauri/src/ollama_install.rs`
- Notes: Cross-cutting — both chat and planning-pipeline consume providers.

#### 6. planning-pipeline
- Entry: `src/components/planning/PlanWithAiButton.tsx`
- Core: `src/lib/planning/orchestrator.ts`, `src/lib/planning/stages/{extract,security,data-consistency,prompt-critic}.ts`, `src/lib/planning/types.ts`, `src/lib/llm/{claude-code-worker,codex-worker,gemini-worker,spawn-helper}.ts`, `src/components/planning/*`
- Notes: Owns `src/lib/llm/*` for now. Phase 2 will check whether executor also consumes it.

#### 7. actions-foundation
- Entry: `src/App.tsx:8` → `<ActionsTab />`
- Core: `src/components/ActionsTab.tsx`, `src/stores/actions-store.ts`, `src/types/actions.ts`, `src/lib/action-processor.ts`, `src/components/actions/*`
- Notes: Provides the data the executor consumes.

#### 8. executor
- Entry: `src/stores/actions-store.ts:43` (`startQueueWorker(...)`)
- Core: `src/lib/executor/queue-worker.ts`, `src/lib/executor/exec-state.ts`, `src/lib/executor/spawn-claude.ts`, `src/lib/executor/state-bridge.ts`, `src/lib/executor/index.ts`
- Notes: Singleton; idempotent boot. Logs via terminal-panes events.

#### 9. mcp-server-bridge
- Entry: `notter-mcp-server/src/server.ts`
- Core: `notter-mcp-server/src/tools/{get-next-task,report-progress,mark-done,get-project-context,ask-user}.ts`
- Notes: Separate Node process spawned by Claude Code; communicates back to the app.

#### 10. auth-sync
- Entry: `src/stores/auth-store.ts` (login flow + `syncOnLogin`)
- Core: `src/stores/auth-store.ts`, `src/lib/sync.ts`, `src/lib/supabase.ts`, `src/lib/realtime.ts`, `supabase/schema.sql`, `supabase/migrations/*`
- Notes: Syncs to all stores after login.

#### 11. auto-updater
- Entry: app startup (Tauri updater plugin) — exact call site to be confirmed in Phase 1
- Core: `src/lib/updater.ts`, `src/stores/app-store.ts`, `src-tauri/tauri.conf.json`, `latest.json`

## Boundary risks (flagged for Phase 2)

1. **planner ↔ planning-pipeline**: PlanWithAiButton lives inside planner UI but logically belongs to pipeline. Acceptable UI nesting; logic stays in `src/lib/planning/`.
2. **actions-foundation ↔ executor**: store ↔ runtime split. Watch state-bridge polling vs store updates for races.
3. **terminal-panes ↔ executor**: executor emits Tauri events into a console terminal. Verify event channel is the only coupling.
4. **ai-providers ↔ planning-pipeline**: providers feed both `chat.ts` and the LLM worker layer. Phase 2 will check for duplicated provider-selection code.
5. **auth-sync fan-out**: sync writes into 5+ stores. Phase 2 should look for duplicated upsert logic.
6. **`src/lib/llm/*` ownership**: assigned to planning-pipeline; flag if executor (`spawn-claude.ts`) duplicates the spawn-helper pattern.

## Confidence

High (≈85%). Five UI tabs are clean Zustand-backed slices. Pipeline + executor are the riskiest areas — explicit Phase 2 focus.
