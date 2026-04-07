import { create } from 'zustand';
import type { ConsoleInstance, ShellType } from '@/types';

export interface TerminalRunningTask {
  actionId: string;
  taskId: string;
  label: string;
}

interface TerminalsState {
  consoles: ConsoleInstance[];
  /** Map of console id -> the action/task currently associated with it */
  runningTasks: Record<string, TerminalRunningTask | null>;

  addConsole: (name: string, cwd?: string, shell?: ShellType) => string | null;
  renameConsole: (id: string, name: string) => void;
  removeConsole: (id: string) => void;

  setTerminalRunningTask: (consoleId: string, task: TerminalRunningTask | null) => void;
  clearRunningTaskByTaskId: (taskId: string) => void;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  consoles: [],
  runningTasks: {},

  addConsole: (name, cwd, shell) => {
    if (get().consoles.length >= 4) return null;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({
      consoles: [...state.consoles, { id, name, cwd, shell }],
    }));
    return id;
  },

  renameConsole: (id, name) => {
    set((state) => ({
      consoles: state.consoles.map((c) => (c.id === id ? { ...c, name } : c)),
    }));
  },

  removeConsole: (id) => {
    set((state) => {
      const nextRunning = { ...state.runningTasks };
      delete nextRunning[id];
      return {
        consoles: state.consoles.filter((c) => c.id !== id),
        runningTasks: nextRunning,
      };
    });
  },

  setTerminalRunningTask: (consoleId, task) => {
    set((state) => ({
      runningTasks: { ...state.runningTasks, [consoleId]: task },
    }));
  },

  clearRunningTaskByTaskId: (taskId) => {
    set((state) => {
      const next: Record<string, TerminalRunningTask | null> = {};
      let changed = false;
      for (const [cid, t] of Object.entries(state.runningTasks)) {
        if (t && t.taskId === taskId) {
          next[cid] = null;
          changed = true;
        } else {
          next[cid] = t;
        }
      }
      return changed ? { runningTasks: next } : state;
    });
  },
}));
