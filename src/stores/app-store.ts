import { create } from 'zustand';
import i18n from '@/i18n';
import { pushPreferences, type UserPreferences } from '@/lib/sync';
import { makeDebouncedSync } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';

type Tab = 'planner' | 'agents' | 'actions';

const prefsSync = makeDebouncedSync<UserPreferences>(pushPreferences, 1000);

interface AppState {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  darkMode: boolean;
  language: string;
  setDarkMode: (dark: boolean) => void;
  setLanguage: (lang: string) => void;
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

  flush: async () => {
    await prefsSync.flush();
  },

  applyRemotePreferences: (prefs) => {
    document.documentElement.classList.toggle('dark', prefs.darkMode);
    i18n.changeLanguage(prefs.language);
    set({
      darkMode: prefs.darkMode,
      language: prefs.language,
    });
  },

  getPreferences: () => {
    const state = get();
    return {
      darkMode: state.darkMode,
      language: state.language,
    };
  },

  reset() {
    set({
      darkMode: document.documentElement.classList.contains('dark'),
      language: 'en',
    });
  },
}));

registerResettableStore(() => useAppStore.getState().reset());
