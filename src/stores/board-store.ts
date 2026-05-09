// src/stores/board-store.ts
import { create } from 'zustand';
import { BaseDirectory, readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import type { BoardTask, TaskMessage, TaskStatus, TaskPriority } from '@/types';
import { usePlannerStore } from './planner-store';
import { pushBoardTasks } from '@/lib/sync';
import { useAuthStore } from './auth-store';
import { makeDebouncedSync, deleteUserRow } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { accountScopedPath, tryAccountScopedPath } from '@/lib/accounts/account-paths';

const BOARD_FILE = 'board.json';

// Debounce timers per project
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

const boardSync = makeDebouncedSync<BoardTask[]>(pushBoardTasks, 1000);

function debouncedSave(projectName: string, tasks: BoardTask[]) {
  if (saveTimers[projectName]) clearTimeout(saveTimers[projectName]);
  saveTimers[projectName] = setTimeout(async () => {
    const projectTasks = tasks.filter((t) => t.projectName === projectName);
    try {
      await writeTextFile(
        accountScopedPath(`NotterProjects/${projectName}/${BOARD_FILE}`),
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

  applyRemoteTasks: (tasks: BoardTask[]) => void;
  flush(): Promise<void>;
  reset(): void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,

  loadAllBoards: async () => {
    if (tryAccountScopedPath('NotterProjects') === null) return;
    const projects = usePlannerStore.getState().projects;
    const allTasks: BoardTask[] = [];
    for (const project of projects) {
      try {
        const filePath = accountScopedPath(`NotterProjects/${project.name}/${BOARD_FILE}`);
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
    if (tryAccountScopedPath('NotterProjects') === null) return;
    try {
      const filePath = accountScopedPath(`NotterProjects/${projectName}/${BOARD_FILE}`);
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
    boardSync.schedule(newTasks);
  },

  updateTask: (id, updates) => {
    const newTasks = get().tasks.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t
    );
    set({ tasks: newTasks });
    const task = newTasks.find((t) => t.id === id);
    if (task) debouncedSave(task.projectName, newTasks);
    boardSync.schedule(newTasks);
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
    boardSync.schedule(newTasks);
  },

  deleteTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    const newTasks = get().tasks.filter((t) => t.id !== id);
    set({
      tasks: newTasks,
      selectedTaskId: get().selectedTaskId === id ? null : get().selectedTaskId,
    });
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteUserRow('board_tasks', userId, id).catch((e) => console.error('[board-store] deleteUserRow failed', e));
    debouncedSave(task.projectName, newTasks);
    boardSync.schedule(newTasks);
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
    boardSync.schedule(newTasks);
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
    boardSync.schedule(allTasks);
  },

  onProjectRenamed: (oldName, newName) => {
    const newTasks = get().tasks.map((t) =>
      t.projectName === oldName ? { ...t, projectName: newName } : t
    );
    set({ tasks: newTasks });
    boardSync.schedule(newTasks);
  },

  onProjectDeleted: (name) => {
    const newTasks = get().tasks.filter((t) => t.projectName !== name);
    set({ tasks: newTasks, selectedTaskId: null });
    boardSync.schedule(newTasks);
  },

  flush: async () => {
    await boardSync.flush();
  },

  applyRemoteTasks: (tasks) => {
    set({ tasks });
    if (tryAccountScopedPath('NotterProjects') === null) return;
    // Persist remote tasks to local board files per project
    const byProject = new Map<string, BoardTask[]>();
    for (const t of tasks) {
      const list = byProject.get(t.projectName) ?? [];
      list.push(t);
      byProject.set(t.projectName, list);
    }
    for (const [projectName, projectTasks] of byProject) {
      writeTextFile(
        accountScopedPath(`NotterProjects/${projectName}/${BOARD_FILE}`),
        JSON.stringify({ tasks: projectTasks }, null, 2),
        { baseDir: BaseDirectory.AppLocalData }
      ).catch(() => {});
    }
  },

  reset() {
    for (const k of Object.keys(saveTimers)) { clearTimeout(saveTimers[k]); delete saveTimers[k]; }
    set({ tasks: [], selectedTaskId: null });
  },
}));

registerResettableStore(() => useBoardStore.getState().reset());
