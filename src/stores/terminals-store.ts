import { create } from 'zustand';
import type { ConsoleInstance } from '@/types';

interface TerminalsState {
  consoles: ConsoleInstance[];
  addConsole: (name?: string) => string | null;
  removeConsole: (id: string) => void;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  consoles: [{ id: 'default', name: 'Agent Shell' }],

  addConsole: (name) => {
    if (get().consoles.length >= 4) return null;
    const id = Date.now().toString();
    set((state) => ({
      consoles: [...state.consoles, { id, name: name || `Terminal ${state.consoles.length + 1}` }],
    }));
    return id;
  },

  removeConsole: (id) => {
    set((state) => ({ consoles: state.consoles.filter((c) => c.id !== id) }));
  },
}));
