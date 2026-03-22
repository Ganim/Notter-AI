# Board — Task System with Threaded Conversations

## Overview

The Board tab replaces the placeholder with a task management system using a list/thread layout (Slack-style). Tasks are grouped by project and subject, with conversational threads inside each task. Both the user and (in Alpha 3.0) AI agents can post messages.

---

## Data Model

### BoardTask

```typescript
interface BoardTask {
  id: string;                    // Generated via crypto.randomUUID()
  projectName: string;
  subjectName: string | null;    // With .md extension (e.g. "architecture-notes.md"). UI strips .md for display. Null = manual task.
  title: string;
  description: string;           // Shown as static block above the thread. Editable via detail panel.
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp — updated on every mutation (status, message, edit)
  messages: TaskMessage[];       // Append-only in this version. No edit/delete of messages.
}

type TaskStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | 'stuck';
type TaskPriority = 'low' | 'medium' | 'high';
```

### TaskMessage

```typescript
interface TaskMessage {
  id: string;                 // Generated via crypto.randomUUID()
  author: string;             // "user" or agent name (Alpha 3.0)
  content: string;
  timestamp: string;          // ISO timestamp
  type: 'comment' | 'action' | 'status_change';
}
```

### Persistence

One JSON file per project: `NotterProjects/{projectName}/board.json`

```json
{
  "tasks": [
    {
      "id": "t-1",
      "projectName": "My App",
      "subjectName": "architecture-notes.md",
      "title": "Define API structure",
      "description": "Decide REST vs GraphQL",
      "status": "in_progress",
      "priority": "high",
      "createdAt": "2026-03-22T14:00:00Z",
      "messages": [
        {
          "id": "m-1",
          "author": "user",
          "content": "Decided on REST with versioning",
          "timestamp": "2026-03-22T14:15:00Z",
          "type": "comment"
        }
      ]
    }
  ]
}
```

The board store loads all `board.json` files from all projects on init. Each project's file is loaded independently — if one is corrupt or missing, it is skipped with a console warning and other projects load normally.

**Save strategy:** Writes are debounced per project (300ms). Multiple rapid mutations (e.g., status change + message) within 300ms produce a single write. This prevents race conditions from concurrent async writes.

**Project rename/delete cascade:** When a project is renamed or deleted in the Planner, the board store must re-sync. The `planner-store` calls `boardStore.onProjectRenamed(oldName, newName)` or `boardStore.onProjectDeleted(name)` to update in-memory tasks and file paths.

---

## Board Layout

### Main View — Grouped List

```
┌──────────────────────────────────────────────────────┐
│ Board                                    [+ New Task] │
├──────────────────────────────────────────────────────┤
│ Filters: [All Projects ▾] [Status ▾] [Priority ▾]   │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ▼ Project A                                          │
│   ├─ ▼ architecture-notes (subject)                  │
│   │    ┌─────────────────────────────────────┐       │
│   │    │ ● Define API structure        [High] │       │
│   │    │   In Progress  ·  3 messages         │       │
│   │    └─────────────────────────────────────┘       │
│   │    ┌─────────────────────────────────────┐       │
│   │    │ ○ Document endpoints          [Med]  │       │
│   │    │   Open  ·  0 messages                │       │
│   │    └─────────────────────────────────────┘       │
│   ├─ ▼ General                                       │
│   │    ┌─────────────────────────────────────┐       │
│   │    │ ● Setup CI/CD                [Low]   │       │
│   │    │   In Review  ·  5 messages           │       │
│   │    └─────────────────────────────────────┘       │
│                                                       │
│ ▼ Project B                                          │
│   ...                                                │
└──────────────────────────────────────────────────────┘
```

**Grouping:** Projects are top-level sections, subjects are sub-sections. Tasks created manually (not from Planner) go under a "General" group within their project.

**Collapsible:** Project and subject sections can be expanded/collapsed.

**Task card shows:** Status dot (colored), title, priority badge, status label, message count.

### Task Detail — Side Panel

Clicking a task opens a side panel on the right (or expands inline on small screens).

```
┌──────────────────────────────────────┐
│ Define API structure            [X]  │
│ Status: [In Progress ▾]  Pri: [High] │
│ Project: A  ·  Subject: architecture │
├──────────────────────────────────────┤
│                                      │
│ [user] 14:00                         │
│ We need to decide REST vs GraphQL    │
│                                      │
│ [user] 14:15                         │
│ Decided on REST with versioning      │
│                                      │
│ [status] 14:20                       │
│ Status changed: Open → In Progress   │
│                                      │
├──────────────────────────────────────┤
│ [Type a message...]          [Send]  │
└──────────────────────────────────────┘
```

**Detail panel features:**
- Editable title (inline)
- Status dropdown (changes create a `status_change` message automatically)
- Priority selector
- Project and subject info (read-only)
- Chronological message thread
- Message input with Send button (Enter to send)
- Messages show author, timestamp, and content
- `status_change` messages styled differently (muted, centered)
- `action` messages styled with code/terminal appearance (for Alpha 3.0 agent actions)

---

## Status Colors

| Status | Color | Dot |
|--------|-------|-----|
| `open` | Gray | ○ hollow |
| `in_progress` | Blue | ● filled |
| `in_review` | Yellow/Amber | ● filled |
| `done` | Green | ● filled |
| `cancelled` | Red | ● filled |
| `stuck` | Orange | ● filled |

---

## Filters

Three filter dropdowns in the Board header:

- **Project filter:** "All Projects" or a specific project name. Built from loaded projects.
- **Status filter:** "All" or a specific status.
- **Priority filter:** "All" or Low/Medium/High.

Filters combine with AND logic. Counts update in real-time.

### Sort Order

Tasks within each group are sorted by `updatedAt` descending (most recently active first). This ensures tasks with new messages bubble up.

### Empty States

- **No tasks at all:** Icon + "No tasks yet. Create one or transform a Planner note." + `[+ New Task]` button.
- **No tasks matching filters:** "No tasks match the current filters." + link to clear filters.
- **No messages in a task thread:** "No messages yet. Start the conversation." shown in the detail panel.

---

## Task Creation

### From Board (manual)

Button `[+ New Task]` in Board header opens a dialog:

- Project selector (dropdown from loaded projects)
- Title (required)
- Description (optional)
- Priority (default: medium)
- Subject (optional dropdown from project's subjects, or "General")

### From Planner (linked)

Button `[+ Board]` appears in the Planner editor header, next to the note title, when a subject is selected.

Clicking opens a dialog pre-filled:
- Project: current project (read-only)
- Subject: current subject name (read-only)
- Title: subject name without .md (editable)
- Description: empty (editable)
- Priority: medium (editable)

On confirm: creates task in Board linked to project + subject. Toast with "View in Board" link.

---

## Zustand Store (board-store)

```typescript
interface BoardState {
  tasks: BoardTask[];
  selectedTaskId: string | null;

  // Init
  loadAllBoards: () => Promise<void>;
  loadProjectBoard: (projectName: string) => Promise<void>;

  // CRUD — called by Board UI
  createTask: (task: Omit<BoardTask, 'id' | 'createdAt' | 'updatedAt' | 'messages'>) => Promise<void>;
  updateTask: (id: string, updates: Partial<Pick<BoardTask, 'title' | 'description' | 'priority'>>) => Promise<void>;
  changeStatus: (id: string, newStatus: TaskStatus) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;

  // Messages — append-only
  addMessage: (taskId: string, content: string, type?: TaskMessage['type']) => Promise<void>;

  // Selection
  setSelectedTaskId: (id: string | null) => void;

  // Planner integration — called by [+ Board] button in PlannerTab
  // Creates a single task linked to the current project + subject
  createTaskFromPlanner: (projectName: string, subjectName: string, title: string, description: string, priority: TaskPriority) => Promise<void>;

  // Agent Translator integration (Alpha 3.0) — batch creation
  createTasksFromNote: (projectName: string, subjectName: string, tasks: Array<{ title: string; description: string; priority: TaskPriority }>) => Promise<void>;

  // Project cascade — called by planner-store on project rename/delete
  onProjectRenamed: (oldName: string, newName: string) => void;
  onProjectDeleted: (name: string) => void;

  // Persistence (internal, debounced 300ms per project)
  _saveProjectBoard: (projectName: string) => void;
}
```

**Persistence flow:**
- On app init: `loadAllBoards()` reads `board.json` from each project in `NotterProjects/`. Each file loaded independently with per-project error handling.
- On mutations: `_saveProjectBoard` is called, debounced at 300ms per project.
- `changeStatus` automatically adds a `status_change` message to the thread.
- `deleteTask` shows a confirmation dialog in the UI before calling the store method.

**Task deletion UI:** A delete button (trash icon) appears in the detail panel header. Clicking opens a confirmation dialog. On confirm, the task and all its messages are removed.

---

## Files Changed

| File | Action |
|------|--------|
| `src/types/index.ts` | Add `BoardTask`, `TaskMessage`, `TaskStatus`, `TaskPriority` |
| `src/stores/board-store.ts` | **New** — Task CRUD, messages, persistence |
| `src/components/BoardTab.tsx` | **Rewrite** — Grouped list, filters, detail panel |
| `src/components/PlannerTab.tsx` | Add `[+ Board]` button in editor header |
| `src/i18n/locales/en.json` | Board i18n keys |
| `src/i18n/locales/pt-BR.json` | Board i18n keys |

No Rust changes. All frontend + Tauri plugin-fs.

---

## Responsive Behavior

Uses the same `useWindowWidth()` hook and breakpoints as PlannerTab:

- **Large (>= 1024px):** List on left (60%), detail panel on right (40%) — side by side via ResizablePanelGroup.
- **Medium (640-1024px):** List takes full width. Clicking a task replaces the list with the detail view (back button).
- **Small (< 640px):** Same as medium — full-width single panel with navigation.

---

## i18n Keys

```
board.title = "Board"
board.new_task = "New Task"
board.create_task = "Create Task"
board.create_task_desc = "Create a new task in the board."
board.project = "Project"
board.subject = "Subject"
board.general = "General"
board.title_label = "Title"
board.title_placeholder = "E.g.: Implement login page"
board.description_label = "Description"
board.description_placeholder = "Describe what needs to be done..."
board.priority_label = "Priority"
board.status_label = "Status"
board.status_open = "Open"
board.status_in_progress = "In Progress"
board.status_in_review = "In Review"
board.status_done = "Done"
board.status_cancelled = "Cancelled"
board.status_stuck = "Stuck"
board.priority_low = "Low"
board.priority_medium = "Medium"
board.priority_high = "High"
board.messages = "messages"
board.type_message = "Type a message..."
board.send = "Send"
board.delete_task = "Delete Task"
board.delete_task_desc = "This will permanently delete '{{name}}' and all its messages."
board.cancel = "Cancel"
board.delete = "Delete"
board.task_created = "Task created!"
board.task_deleted = "Task deleted!"
board.no_tasks = "No tasks yet. Create one or transform a Planner note."
board.no_tasks_filtered = "No tasks match the current filters."
board.no_messages = "No messages yet. Start the conversation."
board.all_projects = "All Projects"
board.all_statuses = "All"
board.all_priorities = "All"
board.status_changed = "Status changed: {{from}} → {{to}}"
board.add_to_board = "+ Board"
board.view_in_board = "View in Board"
board.filter_status = "Status"
board.filter_priority = "Priority"
```

---

## Agent Translator Integration (prepared for Alpha 3.0)

The board store exposes a `createTasksFromNote` method ready for the Agent Translator:

```typescript
interface BoardState {
  // ... existing methods ...

  // Agent Translator entry point
  createTasksFromNote: (
    projectName: string,
    subjectName: string,
    tasks: Array<{ title: string; description: string; priority: TaskPriority }>
  ) => Promise<void>;
}
```

**How it will work in Alpha 3.0:**

1. User writes a rough note in Planner
2. Clicks "Transform to Tasks" button (or agent auto-detects)
3. Agent Translator reads the note content via Vercel AI SDK
4. Agent calls `createTasksFromNote()` with structured tasks
5. Each task appears on the Board linked to the project + subject
6. Agent posts an initial `action` message in each task thread: "Created from note: {subjectName}"
7. Orchestrator picks up new `open` tasks and starts the pipeline

**For now (pre-Alpha 3.0):** The method exists in the store but is only called manually via the `[+ Board]` button (one task at a time). The multi-task batch creation is wired but not exposed in UI until the Agent Translator is built.

The `TaskMessage.type = 'action'` is styled distinctly (monospace, muted bg) to differentiate agent actions from user comments. The `author` field accepts any string — "user" for the human, agent names for AI (e.g., "translator", "orchestrator", "executor").

---

## What's NOT in This Version

- Kanban view (future alternative view)
- Agent messages in threads (Alpha 3.0 — structure ready, agents not built)
- Drag-and-drop reordering
- Task assignment to agents
- Due dates / deadlines
- Subtasks
