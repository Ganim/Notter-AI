import { create } from 'zustand';
import type { ConsoleInstance, ShellType } from '@/types';

interface TerminalsState {
  consoles: ConsoleInstance[];
  addConsole: (name: string, cwd?: string, shell?: ShellType) => string | null;
  removeConsole: (id: string) => void;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  consoles: [],

  addConsole: (name, cwd, shell) => {
    if (get().consoles.length >= 4) return null;
    const id = Date.now().toString();
    set((state) => ({
      consoles: [...state.consoles, { id, name, cwd, shell }],
    }));
    return id;
  },

  removeConsole: (id) => {
    set((state) => ({ consoles: state.consoles.filter((c) => c.id !== id) }));
  },
}));
