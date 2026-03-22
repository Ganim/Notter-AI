# Board Task System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Slack-style task management Board with threaded conversations, grouped by project and subject, with create/edit/delete and message threads.

**Architecture:** New Zustand board-store persists tasks as board.json per project. BoardTab renders a grouped list with collapsible sections and a detail side panel. PlannerTab gets a "+ Board" button to create linked tasks. Responsive layout reuses useWindowWidth() from PlannerTab.

**Tech Stack:** React 19, TypeScript, Zustand, Tailwind CSS, shadcn/ui, Tauri plugin-fs, i18next

**Spec:** `docs/superpowers/specs/2026-03-22-board-task-system.md`

---

## File Structure

```
src/
├── types/index.ts                    ← MODIFY: add BoardTask, TaskMessage, TaskStatus, TaskPriority
├── hooks/useWindowWidth.ts           ← NEW: extracted from PlannerTab for shared use
├── stores/board-store.ts             ← NEW: task CRUD, messages, persistence, debounced save
├── stores/planner-store.ts           ← MODIFY: call board cascade on project rename/delete
├── components/BoardTab.tsx           ← REWRITE: grouped list + detail panel + filters
├── components/PlannerTab.tsx         ← MODIFY: add [+ Board] button, import shared hook
├── i18n/locales/en.json              ← MODIFY: add board.* keys
└── i18n/locales/pt-BR.json           ← MODIFY: add board.* keys
```

**Design note — sync vs async:** The spec declares store methods as `Promise<void>`, but the actual implementation uses synchronous `set()` + fire-and-forget debounced save. The plan uses `void` return types which is more honest. This is a justified deviation.

**Design note — onProjectRenamed:** The planner-store renames the directory first (via `rename()`), which physically moves `board.json` to the new path. The board-store's `onProjectRenamed` only updates in-memory state — it does NOT trigger a redundant save since the file already moved.

---

## Task 1: Add Board types and i18n keys

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/pt-BR.json`

- [ ] **Step 1: Add types to index.ts**

Add after the `EditorTheme` interface:

```typescript
export type TaskStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | 'stuck';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface TaskMessage {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  type: 'comment' | 'action' | 'status_change';
}

export interface BoardTask {
  id: string;
  projectName: string;
  subjectName: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  messages: TaskMessage[];
}
```

- [ ] **Step 2: Add English board keys to en.json**

Add a `"board"` section (replace the existing placeholder board keys):

```json
"board": {
  "title": "Board",
  "new_task": "New Task",
  "create_task": "Create Task",
  "create_task_desc": "Create a new task in the board.",
  "project": "Project",
  "subject": "Subject",
  "general": "General",
  "title_label": "Title",
  "title_placeholder": "E.g.: Implement login page",
  "description_label": "Description",
  "description_placeholder": "Describe what needs to be done...",
  "priority_label": "Priority",
  "status_label": "Status",
  "status_open": "Open",
  "status_in_progress": "In Progress",
  "status_in_review": "In Review",
  "status_done": "Done",
  "status_cancelled": "Cancelled",
  "status_stuck": "Stuck",
  "priority_low": "Low",
  "priority_medium": "Medium",
  "priority_high": "High",
  "messages": "messages",
  "type_message": "Type a message...",
  "send": "Send",
  "delete_task": "Delete Task",
  "delete_task_desc": "This will permanently delete '{{name}}' and all its messages.",
  "cancel": "Cancel",
  "delete": "Delete",
  "task_created": "Task created!",
  "task_deleted": "Task deleted!",
  "no_tasks": "No tasks yet. Create one or transform a Planner note.",
  "no_tasks_filtered": "No tasks match the current filters.",
  "no_messages": "No messages yet. Start the conversation.",
  "all_projects": "All Projects",
  "all_statuses": "All",
  "all_priorities": "All",
  "status_changed": "Status changed: {{from}} → {{to}}",
  "add_to_board": "+ Board",
  "view_in_board": "View in Board",
  "filter_status": "Status",
  "filter_priority": "Priority",
  "select_project": "Select a project",
  "select_subject": "Select a subject (optional)"
}
```

- [ ] **Step 3: Add Portuguese board keys to pt-BR.json**

```json
"board": {
  "title": "Board",
  "new_task": "Nova Task",
  "create_task": "Criar Task",
  "create_task_desc": "Crie uma nova task no board.",
  "project": "Projeto",
  "subject": "Assunto",
  "general": "Geral",
  "title_label": "Título",
  "title_placeholder": "Ex: Implementar página de login",
  "description_label": "Descrição",
  "description_placeholder": "Descreva o que precisa ser feito...",
  "priority_label": "Prioridade",
  "status_label": "Status",
  "status_open": "Aberto",
  "status_in_progress": "Em Progresso",
  "status_in_review": "Em Revisão",
  "status_done": "Concluído",
  "status_cancelled": "Cancelado",
  "status_stuck": "Travado",
  "priority_low": "Baixa",
  "priority_medium": "Média",
  "priority_high": "Alta",
  "messages": "mensagens",
  "type_message": "Digite uma mensagem...",
  "send": "Enviar",
  "delete_task": "Deletar Task",
  "delete_task_desc": "Isso irá deletar permanentemente '{{name}}' e todas as suas mensagens.",
  "cancel": "Cancelar",
  "delete": "Deletar",
  "task_created": "Task criada!",
  "task_deleted": "Task deletada!",
  "no_tasks": "Nenhuma task ainda. Crie uma ou transforme uma nota do Planner.",
  "no_tasks_filtered": "Nenhuma task corresponde aos filtros atuais.",
  "no_messages": "Nenhuma mensagem ainda. Comece a conversa.",
  "all_projects": "Todos os Projetos",
  "all_statuses": "Todos",
  "all_priorities": "Todas",
  "status_changed": "Status alterado: {{from}} → {{to}}",
  "add_to_board": "+ Board",
  "view_in_board": "Ver no Board",
  "filter_status": "Status",
  "filter_priority": "Prioridade",
  "select_project": "Selecione um projeto",
  "select_subject": "Selecione um assunto (opcional)"
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/i18n/locales/en.json src/i18n/locales/pt-BR.json
git commit -m "feat: add Board types and i18n keys (en + pt-BR)"
```

---

## Task 1b: Extract useWindowWidth to shared hook

**Files:**
- Create: `src/hooks/useWindowWidth.ts`
- Modify: `src/components/PlannerTab.tsx`

- [ ] **Step 1: Create the shared hook**

```typescript
// src/hooks/useWindowWidth.ts
import { useState, useEffect } from 'react';

export function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}
```

- [ ] **Step 2: Update PlannerTab to import from shared hook**

In `src/components/PlannerTab.tsx`, remove the local `useWindowWidth` function (lines ~21-28) and replace with:

```typescript
import { useWindowWidth } from '@/hooks/useWindowWidth';
```

Remove the `type MobilePanel` and `function useWindowWidth()` declarations that are local to PlannerTab — keep `MobilePanel` type but move `useWindowWidth` import to the shared hook.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useWindowWidth.ts src/components/PlannerTab.tsx
git commit -m "refactor: extract useWindowWidth to shared hook"
```

---

## Task 2: Create board-store with persistence

**Files:**
- Create: `src/stores/board-store.ts`

- [ ] **Step 1: Create the store**

```typescript
// src/stores/board-store.ts
import { create } from 'zustand';
import { BaseDirectory, readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import type { BoardTask, TaskMessage, TaskStatus, TaskPriority } from '@/types';
import { usePlannerStore } from './planner-store';

const BOARD_FILE = 'board.json';

// Debounce timers per project
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function debouncedSave(projectName: string, tasks: BoardTask[]) {
  if (saveTimers[projectName]) clearTimeout(saveTimers[projectName]);
  saveTimers[projectName] = setTimeout(async () => {
    const projectTasks = tasks.filter((t) => t.projectName === projectName);
    try {
      await writeTextFile(
        `NotterProjects/${projectName}/${BOARD_FILE}`,
        JSON.stringify({ tasks: projectTasks }, null, 2),
        { baseDir: BaseDirectory.AppLocalData }
      );
    } catch (e) {
      console.error(`Failed to save board for ${projectName}:`, e);
    }
  }, 300);
}

interface BoardState {
  tasks: BoardTask[];
  selectedTaskId: string | null;

  loadAllBoards: () => Promise<void>;
  loadProjectBoard: (projectName: string) => Promise<void>;

  createTask: (task: Omit<BoardTask, 'id' | 'createdAt' | 'updatedAt' | 'messages'>) => void;
  updateTask: (id: string, updates: Partial<Pick<BoardTask, 'title' | 'description' | 'priority'>>) => void;
  changeStatus: (id: string, newStatus: TaskStatus) => void;
  deleteTask: (id: string) => void;

  addMessage: (taskId: string, content: string, type?: TaskMessage['type']) => void;

  setSelectedTaskId: (id: string | null) => void;

  createTaskFromPlanner: (projectName: string, subjectName: string, title: string, description: string, priority: TaskPriority) => void;
  createTasksFromNote: (projectName: string, subjectName: string, tasks: Array<{ title: string; description: string; priority: TaskPriority }>) => void;

  onProjectRenamed: (oldName: string, newName: string) => void;
  onProjectDeleted: (name: string) => void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,

  loadAllBoards: async () => {
    const projects = usePlannerStore.getState().projects;
    const allTasks: BoardTask[] = [];
    for (const project of projects) {
      try {
        const filePath = `NotterProjects/${project.name}/${BOARD_FILE}`;
        if (await exists(filePath, { baseDir: BaseDirectory.AppLocalData })) {
          const content = await readTextFile(filePath, { baseDir: BaseDirectory.AppLocalData });
          const parsed = JSON.parse(content);
          if (parsed.tasks && Array.isArray(parsed.tasks)) {
            allTasks.push(...parsed.tasks);
          }
        }
      } catch (e) {
        console.warn(`Failed to load board for ${project.name}:`, e);
      }
    }
    set({ tasks: allTasks });
  },

  loadProjectBoard: async (projectName) => {
    try {
      const filePath = `NotterProjects/${projectName}/${BOARD_FILE}`;
      if (await exists(filePath, { baseDir: BaseDirectory.AppLocalData })) {
        const content = await readTextFile(filePath, { baseDir: BaseDirectory.AppLocalData });
        const parsed = JSON.parse(content);
        if (parsed.tasks && Array.isArray(parsed.tasks)) {
          set((state) => ({
            tasks: [
              ...state.tasks.filter((t) => t.projectName !== projectName),
              ...parsed.tasks,
            ],
          }));
        }
      }
    } catch (e) {
      console.warn(`Failed to load board for ${projectName}:`, e);
    }
  },

  createTask: (taskData) => {
    const now = new Date().toISOString();
    const task: BoardTask = {
      ...taskData,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    const newTasks = [...get().tasks, task];
    set({ tasks: newTasks });
    debouncedSave(task.projectName, newTasks);
  },

  updateTask: (id, updates) => {
    const newTasks = get().tasks.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t
    );
    set({ tasks: newTasks });
    const task = newTasks.find((t) => t.id === id);
    if (task) debouncedSave(task.projectName, newTasks);
  },

  changeStatus: (id, newStatus) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    const oldStatus = task.status;
    const now = new Date().toISOString();
    const statusMessage: TaskMessage = {
      id: crypto.randomUUID(),
      author: 'system',
      content: `${oldStatus} → ${newStatus}`,
      timestamp: now,
      type: 'status_change',
    };
    const newTasks = get().tasks.map((t) =>
      t.id === id
        ? { ...t, status: newStatus, updatedAt: now, messages: [...t.messages, statusMessage] }
        : t
    );
    set({ tasks: newTasks });
    debouncedSave(task.projectName, newTasks);
  },

  deleteTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    const newTasks = get().tasks.filter((t) => t.id !== id);
    set({
      tasks: newTasks,
      selectedTaskId: get().selectedTaskId === id ? null : get().selectedTaskId,
    });
    debouncedSave(task.projectName, newTasks);
  },

  addMessage: (taskId, content, type = 'comment') => {
    const now = new Date().toISOString();
    const message: TaskMessage = {
      id: crypto.randomUUID(),
      author: 'user',
      content,
      timestamp: now,
      type,
    };
    const newTasks = get().tasks.map((t) =>
      t.id === taskId
        ? { ...t, updatedAt: now, messages: [...t.messages, message] }
        : t
    );
    set({ tasks: newTasks });
    const task = newTasks.find((t) => t.id === taskId);
    if (task) debouncedSave(task.projectName, newTasks);
  },

  setSelectedTaskId: (id) => set({ selectedTaskId: id }),

  createTaskFromPlanner: (projectName, subjectName, title, description, priority) => {
    get().createTask({ projectName, subjectName, title, description, status: 'open', priority });
  },

  createTasksFromNote: (projectName, subjectName, tasks) => {
    const now = new Date().toISOString();
    const newTasks: BoardTask[] = tasks.map((t) => ({
      id: crypto.randomUUID(),
      projectName,
      subjectName,
      title: t.title,
      description: t.description,
      status: 'open' as const,
      priority: t.priority,
      createdAt: now,
      updatedAt: now,
      messages: [{
        id: crypto.randomUUID(),
        author: 'system',
        content: `Created from note: ${subjectName?.replace('.md', '') || 'unknown'}`,
        timestamp: now,
        type: 'action' as const,
      }],
    }));
    const allTasks = [...get().tasks, ...newTasks];
    set({ tasks: allTasks });
    debouncedSave(projectName, allTasks);
  },

  onProjectRenamed: (oldName, newName) => {
    // Only update in-memory state. The file already moved with the directory rename.
    const newTasks = get().tasks.map((t) =>
      t.projectName === oldName ? { ...t, projectName: newName } : t
    );
    set({ tasks: newTasks });
  },

  onProjectDeleted: (name) => {
    set((state) => ({
      tasks: state.tasks.filter((t) => t.projectName !== name),
      selectedTaskId: null,
    }));
  },
}));
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/stores/board-store.ts
git commit -m "feat: create board-store with CRUD, messages, debounced persistence"
```

---

## Task 3: Wire board cascade into planner-store

**Files:**
- Modify: `src/stores/planner-store.ts`

The planner-store's `renameProject` and `deleteProject` methods must notify the board-store.

- [ ] **Step 1: Add board cascade calls**

Add at the top of `src/stores/planner-store.ts`, after the existing imports:

```typescript
import { useBoardStore } from './board-store';
```

In `renameProject`, after the existing `await writeTextFile(...)` call, add:

```typescript
useBoardStore.getState().onProjectRenamed(oldName, newName);
```

In `deleteProject`, after the existing `await writeTextFile(...)` call, add:

```typescript
useBoardStore.getState().onProjectDeleted(name);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/stores/planner-store.ts
git commit -m "feat: wire board cascade on project rename/delete"
```

---

## Task 4: Rewrite BoardTab with grouped list and detail panel

**Files:**
- Rewrite: `src/components/BoardTab.tsx`

This is the largest task. The component includes: header with filters, grouped task list, detail side panel with message thread.

Due to size, I'll provide the component as a complete file. The implementer should write it with the Write tool.

- [ ] **Step 1: Write the BoardTab component**

The BoardTab must implement:

**Header:** "Board" title + `[+ New Task]` button. Below: 3 filter dropdowns (project, status, priority).

**List (left side on large screens):**
- Group by `projectName` then by `subjectName` (null → "General")
- Collapsible sections with chevron
- Each task card: status dot (colored), title, priority badge, status text, message count
- Sorted by `updatedAt` desc within each group
- Click task → select it, show detail panel

**Detail panel (right side on large screens):**
- Title (editable inline on double-click)
- Status dropdown + Priority selector
- Description (static block, editable on click)
- Project + Subject info (read-only)
- Message thread (chronological)
  - `comment`: author + timestamp + content
  - `status_change`: centered, muted, shows old→new
  - `action`: monospace bg
- Message input + Send button (Enter to send)
- Delete button (trash) → confirmation dialog

**Create Task Dialog:**
- Project dropdown (from planner projects)
- Subject dropdown (from project's subjects, + "General")
- Title, Description, Priority
- Create button

**Responsive:**
- Large (>=1024): ResizablePanelGroup, list 60% + detail 40%
- Medium/Small: full-width, click task replaces list with detail (back button)

**Empty states:**
- No tasks: icon + message + CTA button
- No filter results: message + clear link
- No messages in thread: message

**Status colors:**
- open: text-gray-500
- in_progress: text-blue-500
- in_review: text-amber-500
- done: text-green-500
- cancelled: text-red-500
- stuck: text-orange-500

**Priority badges:**
- low: muted bg
- medium: amber bg
- high: red/rose bg

Use `useTranslation()` for all text. Use `useBoardStore` for data. Use `usePlannerStore` for project/subject lists. Use existing shadcn components: Dialog, ScrollArea, ResizablePanel.

Init: call `loadAllBoards()` in useEffect on mount.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/BoardTab.tsx
git commit -m "feat: implement BoardTab with grouped list, filters, detail panel, and threads"
```

---

## Task 5: Add [+ Board] button to PlannerTab

**Files:**
- Modify: `src/components/PlannerTab.tsx`

- [ ] **Step 1: Add board store import and dialog state**

At the top of PlannerTab, add:

```typescript
import { useBoardStore } from '@/stores/board-store';
```

Add dialog state variables:

```typescript
const [isBoardDialogOpen, setIsBoardDialogOpen] = useState(false);
const [boardTaskTitle, setBoardTaskTitle] = useState('');
const [boardTaskDesc, setBoardTaskDesc] = useState('');
const [boardTaskPriority, setBoardTaskPriority] = useState<'low' | 'medium' | 'high'>('medium');
```

Add the store hook:

```typescript
const { createTaskFromPlanner } = useBoardStore();
```

- [ ] **Step 2: Add the [+ Board] button in the editor header**

In `renderEditorHeader()`, after the task title `<span>`, add:

```tsx
{selectedProject && selectedSubject && (
  <button
    onClick={() => {
      setBoardTaskTitle(selectedSubject.replace('.md', ''));
      setBoardTaskDesc('');
      setBoardTaskPriority('medium');
      setIsBoardDialogOpen(true);
    }}
    className="bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 border border-blue-500/20 px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider transition-colors ml-2 shrink-0"
  >
    {t('board.add_to_board')}
  </button>
)}
```

- [ ] **Step 3: Add the board task creation dialog**

In the `renderDialogs()` function, add a new dialog:

```tsx
<Dialog open={isBoardDialogOpen} onOpenChange={setIsBoardDialogOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>{t('board.create_task')}</DialogTitle>
      <DialogDescription>{t('board.create_task_desc')}</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-3">
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.project')}</label>
        <input type="text" readOnly value={selectedProject?.name || ''} className="w-full bg-muted/50 border border-border rounded-md p-2 text-sm text-foreground" />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.subject')}</label>
        <input type="text" readOnly value={selectedSubject?.replace('.md', '') || ''} className="w-full bg-muted/50 border border-border rounded-md p-2 text-sm text-foreground" />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.title_label')}</label>
        <input autoFocus type="text" value={boardTaskTitle} onChange={(e) => setBoardTaskTitle(e.target.value)} placeholder={t('board.title_placeholder')} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.description_label')}</label>
        <textarea value={boardTaskDesc} onChange={(e) => setBoardTaskDesc(e.target.value)} placeholder={t('board.description_placeholder')} rows={3} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring resize-y" />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.priority_label')}</label>
        <select value={boardTaskPriority} onChange={(e) => setBoardTaskPriority(e.target.value as any)} className="w-full bg-background text-foreground border border-border rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring">
          <option value="low">{t('board.priority_low')}</option>
          <option value="medium">{t('board.priority_medium')}</option>
          <option value="high">{t('board.priority_high')}</option>
        </select>
      </div>
    </div>
    <DialogFooter>
      <button onClick={() => setIsBoardDialogOpen(false)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('board.cancel')}</button>
      <button
        onClick={() => {
          if (!selectedProject || !selectedSubject || !boardTaskTitle.trim()) return;
          createTaskFromPlanner(selectedProject.name, selectedSubject, boardTaskTitle, boardTaskDesc, boardTaskPriority);
          setIsBoardDialogOpen(false);
          toast.success(t('board.task_created'));
        }}
        disabled={!boardTaskTitle.trim()}
        className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors disabled:opacity-50"
      >
        {t('board.create_task')}
      </button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/PlannerTab.tsx
git commit -m "feat: add [+ Board] button in Planner to create linked tasks"
```

---

## Task 6: Build, verify, and tag

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: TypeScript compiles and Vite builds without errors

- [ ] **Step 2: Test with Tauri dev**

Run: `npm run tauri dev`
Verify:
1. Board tab shows empty state with CTA
2. Create a task manually from Board → appears in list grouped by project
3. Create a task from Planner [+ Board] button → appears in Board under correct project + subject
4. Click task → detail panel opens with thread
5. Post a message → appears in thread
6. Change status → status_change message auto-added
7. Filters work (project, status, priority)
8. Delete task → confirmation → removed
9. Responsive: resize window to see medium/small layouts

- [ ] **Step 3: Commit any fixes**

- [ ] **Step 4: Tag the release**

```bash
git tag -a board-v1.0 -m "Board v1.0: Task System with Threaded Conversations

- Grouped list view (project → subject → tasks)
- Threaded conversations per task
- 6 status types with colored indicators
- 3 priority levels with badges
- Filters by project, status, priority
- Create tasks from Board or Planner [+ Board] button
- Responsive layout (3 breakpoints)
- Agent Translator API prepared (createTasksFromNote)"
```

---

## Summary

| Task | What it does | Files |
|------|-------------|-------|
| 1 | Types + i18n keys | types/index.ts, en.json, pt-BR.json |
| 1b | Extract useWindowWidth to shared hook | hooks/useWindowWidth.ts (new), PlannerTab.tsx |
| 2 | Board store with persistence | board-store.ts (new) |
| 3 | Cascade planner→board on rename/delete | planner-store.ts |
| 4 | BoardTab full UI | BoardTab.tsx (rewrite) |
| 5 | [+ Board] button in Planner | PlannerTab.tsx |
| 6 | Build, verify, tag | (verification) |

**Total:** 2 new files, 5 modified files, 7 commits + tag
