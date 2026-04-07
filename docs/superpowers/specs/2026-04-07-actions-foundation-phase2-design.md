# Actions Foundation — Phase 2

**Date:** 2026-04-07
**Status:** Approved for implementation
**Strategy:** Vertical slice — second phase of a 6-phase rework

## Goal

Deliver the Actions tab scaffold: a new primary workspace for processed Planner notes. Phase 2 builds everything **except** the AI processing pipeline:

1. Data model for Actions and their Tasks
2. Persistent store (JSON file under `$APPLOCALDATA`)
3. New `Actions` tab in the navbar (dev only; hidden in production)
4. Two-column layout: searchable list + detail panel
5. Empty state when no actions exist
6. Status toggles on tasks (local state only, no AI wiring)
7. Stub "Process" button that's visibly disabled with a tooltip

Phase 3 will wire the Planner play button to the AI pipeline, which creates real Actions. Until then, the Actions tab starts empty and stays empty — no mock data.

## Non-Goals

- Processing pipeline (Planner → AI → Action) → Phase 3
- Terminal integration for task execution → Phase 4
- Callback / follow-up task generation → Phase 6
- Migration from the existing Board store → keep Board coexisting in dev
- Any AI calls
- Sync to Supabase (local-only for now)
- Roadmap view (the "fila de execução" from the user's spec) → Phase 3 or later

## User experience

### Entry point
A new tab **Actions** (EN) / **Ações** (PT) in the navbar, placed between `Board` and `Terminals` in dev mode. In production the tab is hidden (only `Planner` and `Terminals` remain).

### Empty state
When no actions exist:
- Centered layout with an icon (`ListTodo` or `Sparkles`)
- Heading: "No actions yet" / "Nenhuma ação ainda"
- Subtext: "Process a Planner note to create your first action" / "Processe uma nota do Planner para criar sua primeira ação"
- No button — the action must be triggered from the Planner (Phase 3 wires this up)

### Two-column layout (when actions exist)
- **Left column (~420px, resizable)**
  - Header: search input (filters by title, project, subject) + counter ("5 actions")
  - Scrollable list of action cards
- **Right column (remaining width)**
  - Detail panel: header, context section, tasks section
  - When nothing is selected: "Select an action" hint

### Action list card
```
┌─────────────────────────────────────┐
│ Build authentication system         │
│ my-project / auth-notes.md     3/5  │  ← badge x/y, grey normally, emerald when full
└─────────────────────────────────────┘
```
- Title on first line (1 line, truncated)
- Project / Subject on second line (muted color, truncated)
- Right-aligned badge showing `{done}/{total}` of tasks
- Click → select, shows in detail panel
- Active card highlighted (same pattern as existing BoardTab)

### Detail panel

**Header strip (top)**
- Title (editable on double-click, like BoardTab)
- Status dropdown: `Waiting` / `Processing` / `Skipped` / `Done`
- Project/Subject metadata (muted)
- Actions button cluster (right side):
  - **Process** button — stub, disabled, tooltip: "AI processing coming in Phase 3"
  - **Delete** icon button (trash) with confirm

**Context section**
- Heading: "Context" / "Contexto"
- Markdown rendering of `action.summary` field (read-only for Phase 2)
- If empty: muted italic "No context" / "Sem contexto"

**Tasks section**
- Heading: "Tasks" / "Tarefas"
- List of task cards, each:
  - Status dot (like BoardTab) — clickable to cycle: `waiting` → `running` → `done` → `failed` → `waiting`
  - Objective (single-line title)
  - Collapsed by default; click to expand
  - Expanded view shows: prompt, metadata (agent / model / terminal — all can be empty strings for Phase 2), return text area (empty)
- No "add task" button — tasks are created only by the AI pipeline (Phase 3)

## Data model

### Types (`src/types/actions.ts`)

```ts
export type ActionStatus = 'waiting' | 'processing' | 'skipped' | 'done';
export type ActionTaskStatus = 'waiting' | 'running' | 'done' | 'failed';

export interface ActionTask {
  id: string;
  objective: string;        // short title
  prompt: string;           // what to inject in the terminal
  agentId: string;          // Phase 5 fills this in; for now, ''
  modelTag: string;         // e.g., 'qwen3-vl:4b'; '' if unset
  terminalId: string;       // terminal target; '' if unset
  status: ActionTaskStatus;
  returnText: string;       // captured output / summary; '' initially
}

export interface Action {
  id: string;
  projectName: string;
  subjectName: string;      // subject (filename), empty for project-level
  title: string;            // AI-generated, user-editable
  summary: string;          // markdown context, AI-generated
  originalMarkdown: string; // Planner note snapshot at process time
  status: ActionStatus;
  createdAt: string;        // ISO
  updatedAt: string;        // ISO
  tasks: ActionTask[];
}
```

### Store (`src/stores/actions-store.ts`)

```ts
interface ActionsState {
  actions: Action[];
  selectedActionId: string | null;
  loaded: boolean;

  load(): Promise<void>;                    // read from JSON file
  addAction(a: Action): Promise<void>;      // append + persist (used by Phase 3)
  updateAction(id: string, patch: Partial<Action>): Promise<void>;
  deleteAction(id: string): Promise<void>;
  setSelected(id: string | null): void;

  updateTask(actionId: string, taskId: string, patch: Partial<ActionTask>): Promise<void>;
  cycleTaskStatus(actionId: string, taskId: string): Promise<void>;

  // derived selector helpers
  getProgress(action: Action): { done: number; total: number };
}
```

### Persistence
- File: `$APPLOCALDATA/notter-ai/actions.json`
- Format: `{ "version": 1, "actions": Action[] }`
- Reads on `load()` called once at app boot
- Writes on every mutation (debounced 300ms to batch rapid updates)
- Uses existing `tauri-plugin-fs` (already wired)
- On read error (file not found): initialize with empty array
- On parse error: log + use empty, back up corrupted file with timestamp suffix

## Architecture

### File map (created)

```
src/
├── types/
│   └── actions.ts                       # Action, ActionTask, enums
├── stores/
│   └── actions-store.ts                 # Zustand store with fs persistence
├── stores/__tests__/
│   └── actions-store.test.ts            # Mocked fs tests
├── components/
│   └── ActionsTab.tsx                   # Top-level tab component
└── components/actions/
    ├── ActionList.tsx                   # Left column: search + list
    ├── ActionCard.tsx                   # Single list item
    ├── ActionDetail.tsx                 # Right column: header + context + tasks
    └── TaskItem.tsx                     # Single task card (collapsible)
```

### File map (modified)

```
src/
├── App.tsx                              # Add actions: <ActionsTab />
├── components/Layout.tsx                # Add 'actions' to Tab type + TABS in dev
├── i18n/locales/en.json                 # Add actions.* keys
└── i18n/locales/pt-BR.json              # Add actions.* keys (PT)
```

## Data flow examples

### Boot
1. App mounts → `App.tsx` calls `useActionsStore.getState().load()`
2. `load()` reads `actions.json`, parses, sets `actions` + `loaded=true`
3. ActionsTab mounts → reads from store, renders list or empty state

### Selecting an action
1. User clicks a card
2. `ActionList` calls `setSelected(action.id)`
3. `ActionDetail` subscribes to `actions.find(a => a.id === selectedActionId)`
4. Renders header, context, task list

### Cycling task status
1. User clicks status dot on a task
2. `TaskItem` calls `cycleTaskStatus(actionId, taskId)`
3. Store computes next status: `waiting → running → done → failed → waiting`
4. Persists the full actions.json (debounced)
5. UI re-renders with new dot color

### Deleting an action
1. User clicks trash icon → confirm dialog (reuse existing Dialog pattern)
2. Confirmed → `deleteAction(id)` removes from array, persists, clears `selectedActionId` if it was the deleted one
3. Detail panel returns to "select an action" hint

## Error handling

| Failure | Behavior |
|---|---|
| `actions.json` file not found on first boot | Initialize with `[]`, no error shown |
| `actions.json` parse error | Console error, back up file to `actions.json.corrupted-{timestamp}`, start fresh |
| Write failure | Toast error "Failed to save actions"; keep in-memory state, retry on next mutation |
| Mutation on non-existent action id | Console warn, no-op |

## i18n keys to add

Under `actions.*` in both locales:

| Key | EN | PT-BR |
|---|---|---|
| `nav.actions` | "Actions" | "Ações" |
| `actions.title` | "Actions" | "Ações" |
| `actions.search_placeholder` | "Search actions..." | "Buscar ações..." |
| `actions.counter` | "{{count}} action" / "{{count}}_plural actions" | "{{count}} ação" / "{{count}}_plural ações" |
| `actions.empty_title` | "No actions yet" | "Nenhuma ação ainda" |
| `actions.empty_subtitle` | "Process a Planner note to create your first action" | "Processe uma nota do Planner para criar sua primeira ação" |
| `actions.select_hint` | "Select an action to view details" | "Selecione uma ação para ver detalhes" |
| `actions.status_waiting` | "Waiting" | "Aguardando" |
| `actions.status_processing` | "Processing" | "Processando" |
| `actions.status_skipped` | "Skipped" | "Pulado" |
| `actions.status_done` | "Done" | "Concluído" |
| `actions.task_status_waiting` | "Waiting" | "Aguardando" |
| `actions.task_status_running` | "Running" | "Em execução" |
| `actions.task_status_done` | "Done" | "Concluído" |
| `actions.task_status_failed` | "Failed" | "Falhou" |
| `actions.process` | "Process" | "Processar" |
| `actions.process_disabled_tooltip` | "AI processing coming in Phase 3" | "Processamento com IA vem na Phase 3" |
| `actions.delete` | "Delete" | "Excluir" |
| `actions.delete_confirm` | "Delete action '{{title}}' and all its tasks?" | "Excluir ação '{{title}}' e todas suas tarefas?" |
| `actions.cancel` | "Cancel" | "Cancelar" |
| `actions.context` | "Context" | "Contexto" |
| `actions.no_context` | "No context" | "Sem contexto" |
| `actions.tasks` | "Tasks" | "Tarefas" |
| `actions.task_prompt` | "Prompt" | "Prompt" |
| `actions.task_return` | "Return" | "Retorno" |
| `actions.task_agent` | "Agent" | "Agente" |
| `actions.task_model` | "Model" | "Modelo" |
| `actions.task_terminal` | "Terminal" | "Terminal" |
| `actions.no_return` | "No return captured" | "Nenhum retorno capturado" |
| `actions.save_failed` | "Failed to save actions" | "Falha ao salvar ações" |

## Testing strategy

Unit tests (vitest):

1. **Types exported correctly**: smoke test for `ActionStatus` / `ActionTaskStatus` enums
2. **Store load**: mocks fs read → empty file → store initializes with `[]`
3. **Store load**: mocks fs read with valid JSON → store has those actions
4. **Store load**: mocks fs read with bad JSON → falls back to empty, logs error
5. **addAction**: appends to list and writes file
6. **updateAction**: patches existing action, writes
7. **deleteAction**: removes by id, clears selection if needed
8. **cycleTaskStatus**: advances status through the 4-state cycle
9. **getProgress**: counts done tasks correctly

No component tests in Phase 2 — visual verification is enough for this UI surface.

## Success criteria

Phase 2 is done when, in dev mode:

1. ✅ I click the new "Actions" tab in the navbar and see the empty state
2. ✅ If I manually inject an action via devtools (`useActionsStore.setState(...)`), the list shows it with correct badge
3. ✅ I click a card → detail panel shows title, status, context, tasks
4. ✅ I click a task's status dot → cycles through waiting/running/done/failed
5. ✅ I click delete on an action → confirm dialog → action is removed
6. ✅ I reload the app → state persists (via `actions.json`)
7. ✅ In production build, Actions tab does NOT appear (hidden alongside Board/Agents)
8. ✅ The stub Process button is disabled with a tooltip
9. ✅ All new unit tests pass (9+)
10. ✅ Existing tests (28 from Phase 1) still pass

No regressions to Planner, Terminals, Board, Agents, OAuth, updater, or AI Provider Center.
