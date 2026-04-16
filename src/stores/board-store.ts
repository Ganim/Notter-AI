// src/stores/board-store.ts
import { create } from 'zustand';
import { BaseDirectory, readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import type { BoardTask, TaskMessage, TaskStatus, TaskPriority } from '@/types';
import { usePlannerStore } from './planner-store';
import { pushBoardTasks } from '@/lib/sync';
import { useAuthStore } from './auth-store';

const BOARD_FILE = 'board.json';

let boardSyncTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedBoardSync(tasks: BoardTask[]) {
  if (boardSyncTimer) clearTimeout(boardSyncTimer);
  boardSyncTimer = setTimeout(() => {
    const userId = useAuthStore.getState().user?.id;
    if (userId) pushBoardTasks(userId, tasks);
  }, 1000);
}

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

  applyRemoteTasks: (tasks: BoardTask[]) => void;
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
    debouncedBoardSync(newTasks);
  },

  updateTask: (id, updates) => {
    const newTasks = get().tasks.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t
    );
    set({ tasks: newTasks });
    const task = newTasks.find((t) => t.id === id);
    if (task) debouncedSave(task.projectName, newTasks);
    debouncedBoardSync(newTasks);
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
    debouncedBoardSync(newTasks);
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
    debouncedBoardSync(newTasks);
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
    debouncedBoardSync(newTasks);
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
    debouncedBoardSync(allTasks);
  },

  onProjectRenamed: (oldName, newName) => {
    const newTasks = get().tasks.map((t) =>
      t.projectName === oldName ? { ...t, projectName: newName } : t
    );
    set({ tasks: newTasks });
    debouncedBoardSync(newTasks);
  },

  onProjectDeleted: (name) => {
    const newTasks = get().tasks.filter((t) => t.projectName !== name);
    set({ tasks: newTasks, selectedTaskId: null });
    debouncedBoardSync(newTasks);
  },

  applyRemoteTasks: (tasks) => {
    set({ tasks });
    // Persist remote tasks to local board files per project
    const byProject = new Map<string, BoardTask[]>();
    for (const t of tasks) {
      const list = byProject.get(t.projectName) ?? [];
      list.push(t);
      byProject.set(t.projectName, list);
    }
    for (const [projectName, projectTasks] of byProject) {
      writeTextFile(
        `NotterProjects/${projectName}/${BOARD_FILE}`,
        JSON.stringify({ tasks: projectTasks }, null, 2),
        { baseDir: BaseDirectory.AppLocalData }
      ).catch(() => {});
    }
  },
}));
