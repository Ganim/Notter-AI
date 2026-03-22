import { create } from 'zustand';

type Tab = 'planner' | 'board' | 'agents' | 'terminals';

export interface TerminalTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

export const TERMINAL_THEMES: TerminalTheme[] = [
  { name: 'Default',    background: '#09090b', foreground: '#fafafa', cursor: '#fafafa', selectionBackground: '#3f3f46' },
  { name: 'Dracula',    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a' },
  { name: 'Monokai',    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e' },
  { name: 'Nord',       background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e' },
  { name: 'Solarized',  background: '#002b36', foreground: '#839496', cursor: '#839496', selectionBackground: '#073642' },
  { name: 'GitHub',     background: '#24292e', foreground: '#e1e4e8', cursor: '#e1e4e8', selectionBackground: '#3b4048' },
  { name: 'Cobalt',     background: '#132738', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#1a3a50' },
  { name: 'Rosé Pine',  background: '#191724', foreground: '#e0def4', cursor: '#e0def4', selectionBackground: '#26233a' },
];

export interface TerminalSettings {
  themeName: string;
  fontFamily: string;
  fontSize: number;
  ligatures: boolean;
}

interface AppState {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  terminalSettings: TerminalSettings;
  setTerminalSettings: (settings: Partial<TerminalSettings>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'planner',
  setActiveTab: (tab) => set({ activeTab: tab }),
  terminalSettings: {
    themeName: 'Default',
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    fontSize: 13,
    ligatures: false,
  },
  setTerminalSettings: (updates) =>
    set((state) => ({ terminalSettings: { ...state.terminalSettings, ...updates } })),
}));
