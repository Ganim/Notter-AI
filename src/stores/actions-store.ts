import { create } from 'zustand';
import { readTextFile, writeTextFile, mkdir, exists, rename } from '@tauri-apps/plugin-fs';
import { appLocalDataDir } from '@tauri-apps/api/path';
import type { Action, ActionTask, ActionTaskStatus } from '@/types/actions';
import { nextTaskStatus } from '@/types/actions';

const FILE_NAME = 'actions.json';
const FILE_VERSION = 1;

interface PersistedShape {
  version: number;
  actions: Action[];
}

interface ActionsState {
  actions: Action[];
  selectedActionId: string | null;
  loaded: boolean;

  load(): Promise<void>;
  addAction(action: Action): Promise<void>;
  updateAction(id: string, patch: Partial<Action>): Promise<void>;
  deleteAction(id: string): Promise<void>;
  setSelected(id: string | null): void;

  updateTask(actionId: string, taskId: string, patch: Partial<ActionTask>): Promise<void>;
  cycleTaskStatus(actionId: string, taskId: string): Promise<void>;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

async function getActionsPath(): Promise<string> {
  const dir = await appLocalDataDir();
  return `${dir}${FILE_NAME}`;
}

async function ensureDir(): Promise<void> {
  const dir = await appLocalDataDir();
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
}

async function persist(actions: Action[]): Promise<void> {
  await ensureDir();
  const path = await getActionsPath();
  const payload: PersistedShape = { version: FILE_VERSION, actions };
  await writeTextFile(path, JSON.stringify(payload, null, 2));
}

function schedulePersist(getActions: () => Action[]) {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    persist(getActions()).catch((e) => {
      console.error('[actions-store] failed to persist', e);
    });
  }, 300);
}

export const useActionsStore = create<ActionsState>((set, get) => ({
  actions: [],
  selectedActionId: null,
  loaded: false,

  async load() {
    try {
      const path = await getActionsPath();
      if (!(await exists(path))) {
        set({ actions: [], loaded: true });
        return;
      }
      const raw = await readTextFile(path);
      try {
        const parsed = JSON.parse(raw) as PersistedShape;
        const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
        // Reset stale 'running' tasks back to 'waiting' since the terminal
        // they were attached to is gone after a process restart.
        const actions = rawActions.map((a) => ({
          ...a,
          tasks: a.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'waiting' as const } : t)),
        }));
        set({ actions, loaded: true });
      } catch (parseErr) {
        console.error('[actions-store] parse error, backing up corrupted file', parseErr);
        const backup = `${path}.corrupted-${Date.now()}`;
        await rename(path, backup).catch(() => {});
        set({ actions: [], loaded: true });
      }
    } catch (e) {
      console.error('[actions-store] load failed', e);
      set({ actions: [], loaded: true });
    }
  },

  async addAction(action) {
    set((s) => ({ actions: [...s.actions, action] }));
    schedulePersist(() => get().actions);
  },

  async updateAction(id, patch) {
    set((s) => ({
      actions: s.actions.map((a) =>
        a.id === id ? { ...a, ...patch, updatedAt: new Date().toISOString() } : a,
      ),
    }));
    schedulePersist(() => get().actions);
  },

  async deleteAction(id) {
    set((s) => ({
      actions: s.actions.filter((a) => a.id !== id),
      selectedActionId: s.selectedActionId === id ? null : s.selectedActionId,
    }));
    schedulePersist(() => get().actions);
  },

  setSelected(id) {
    set({ selectedActionId: id });
  },

  async updateTask(actionId, taskId, patch) {
    set((s) => ({
      actions: s.actions.map((a) => {
        if (a.id !== actionId) return a;
        return {
          ...a,
          updatedAt: new Date().toISOString(),
          tasks: a.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
        };
      }),
    }));
    schedulePersist(() => get().actions);
  },

  async cycleTaskStatus(actionId, taskId) {
    const action = get().actions.find((a) => a.id === actionId);
    if (!action) return;
    const task = action.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const next: ActionTaskStatus = nextTaskStatus(task.status);
    await get().updateTask(actionId, taskId, { status: next });
  },
}));

export function getActionProgress(action: Action): { done: number; total: number } {
  const total = action.tasks.length;
  const done = action.tasks.filter((t) => t.status === 'done').length;
  return { done, total };
}
