import { create } from 'zustand';
import i18n from '@/i18n';
import { pushPreferences, type UserPreferences } from '@/lib/sync';
import { makeDebouncedSync } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';

type Tab = 'planner';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_MODE_STORAGE_KEY = 'notter-theme-mode';

const prefsSync = makeDebouncedSync<UserPreferences>(pushPreferences, 1000);

interface AppState {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  themeMode: ThemeMode;
  darkMode: boolean;
  language: string;
  setThemeMode: (mode: ThemeMode) => void;
  setDarkMode: (dark: boolean) => void;
  setLanguage: (lang: string) => void;
  applyRemotePreferences: (prefs: UserPreferences) => void;
  flush(): Promise<void>;
  getPreferences: () => UserPreferences;
  reset(): void;
}

function resolveDarkMode(mode: ThemeMode): boolean {
  if (mode === 'system') {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return mode === 'dark';
}

function readInitialThemeMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const v = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // localStorage may throw in privacy-mode sandboxes; fall through.
  }
  return 'system';
}

const initialThemeMode = readInitialThemeMode();
const initialDarkMode = resolveDarkMode(initialThemeMode);

// Apply the resolved theme to the DOM at module load so the user doesn't see
// a flash of the wrong theme before the store wires up.
if (typeof document !== 'undefined') {
  document.documentElement.classList.toggle('dark', initialDarkMode);
}

export const useAppStore = create<AppState>((set, get) => ({
  activeTab: 'planner',
  setActiveTab: (tab) => set({ activeTab: tab }),

  themeMode: initialThemeMode,
  darkMode: initialDarkMode,
  language: i18n.language || 'en',

  setThemeMode: (mode) => {
    try { localStorage.setItem(THEME_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
    const dark = resolveDarkMode(mode);
    document.documentElement.classList.toggle('dark', dark);
    set({ themeMode: mode, darkMode: dark });
    prefsSync.schedule(get().getPreferences());
  },

  setDarkMode: (dark) => {
    const mode: ThemeMode = dark ? 'dark' : 'light';
    try { localStorage.setItem(THEME_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
    document.documentElement.classList.toggle('dark', dark);
    set({ themeMode: mode, darkMode: dark });
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
    // Theme is now driven locally via themeMode (localStorage). We still
    // write `dark_mode` to Supabase for backward compatibility but no
    // longer read it back here — otherwise a user's `system` choice would
    // be silently overridden every time auth bootstraps. Language stays
    // remote-synced.
    i18n.changeLanguage(prefs.language);
    set({ language: prefs.language });
  },

  getPreferences: () => {
    const state = get();
    return {
      darkMode: state.darkMode,
      language: state.language,
    };
  },

  reset() {
    const mode = readInitialThemeMode();
    const dark = resolveDarkMode(mode);
    document.documentElement.classList.toggle('dark', dark);
    set({
      themeMode: mode,
      darkMode: dark,
      language: 'en',
    });
  },
}));

// Live OS-theme listener: while themeMode === 'system', track the
// prefers-color-scheme media query and re-resolve darkMode reactively.
// Registered once at module load; the no-op guard inside checks the
// current themeMode so explicit light/dark selections aren't disturbed.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (useAppStore.getState().themeMode !== 'system') return;
    const dark = mq.matches;
    document.documentElement.classList.toggle('dark', dark);
    useAppStore.setState({ darkMode: dark });
  };
  if ('addEventListener' in mq) {
    mq.addEventListener('change', handler);
  } else {
    // Safari < 14 fallback (very unlikely on Tauri WebView2 but cheap).
    (mq as MediaQueryList & { addListener?: (h: () => void) => void }).addListener?.(handler);
  }
}

registerResettableStore(() => useAppStore.getState().reset());
