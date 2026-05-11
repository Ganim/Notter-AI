import { create } from 'zustand';
import i18n from '@/i18n';
import { pushPreferences, type UserPreferences } from '@/lib/sync';
import { makeDebouncedSync } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';

type Tab = 'planner' | 'agents' | 'actions' | 'terminals';

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

const prefsSync = makeDebouncedSync<UserPreferences>(pushPreferences, 1000);

interface AppState {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  darkMode: boolean;
  language: string;
  terminalSettings: TerminalSettings;
  setDarkMode: (dark: boolean) => void;
  setLanguage: (lang: string) => void;
  setTerminalSettings: (settings: Partial<TerminalSettings>) => void;
  applyRemotePreferences: (prefs: UserPreferences) => void;
  flush(): Promise<void>;
  getPreferences: () => UserPreferences;
  reset(): void;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeTab: 'planner',
  setActiveTab: (tab) => set({ activeTab: tab }),

  darkMode: document.documentElement.classList.contains('dark'),
  language: i18n.language || 'en',

  terminalSettings: {
    themeName: 'Default',
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    fontSize: 13,
    ligatures: false,
  },

  setDarkMode: (dark) => {
    document.documentElement.classList.toggle('dark', dark);
    set({ darkMode: dark });
    prefsSync.schedule(get().getPreferences());
  },

  setLanguage: (lang) => {
    i18n.changeLanguage(lang);
    set({ language: lang });
    prefsSync.schedule(get().getPreferences());
  },

  setTerminalSettings: (updates) => {
    set((state) => ({
      terminalSettings: { ...state.terminalSettings, ...updates },
    }));
    setTimeout(() => prefsSync.schedule(get().getPreferences()), 0);
  },

  flush: async () => {
    await prefsSync.flush();
  },

  applyRemotePreferences: (prefs) => {
    document.documentElement.classList.toggle('dark', prefs.darkMode);
    i18n.changeLanguage(prefs.language);
    set({
      darkMode: prefs.darkMode,
      language: prefs.language,
      terminalSettings: {
        themeName: prefs.terminalTheme,
        fontFamily: prefs.terminalFont,
        fontSize: prefs.terminalFontSize,
        ligatures: prefs.terminalLigatures,
      },
    });
  },

  getPreferences: () => {
    const state = get();
    return {
      darkMode: state.darkMode,
      language: state.language,
      terminalTheme: state.terminalSettings.themeName,
      terminalFont: state.terminalSettings.fontFamily,
      terminalFontSize: state.terminalSettings.fontSize,
      terminalLigatures: state.terminalSettings.ligatures,
    };
  },

  reset() {
    // activeTab, terminalSettings keep their value: those are UI preferences
    // hydrated from the new account on syncOnLogin.
    set({
      darkMode: document.documentElement.classList.contains('dark'),
      language: 'en',
    });
  },
}));

registerResettableStore(() => useAppStore.getState().reset());
