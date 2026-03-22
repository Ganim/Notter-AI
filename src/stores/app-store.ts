import { create } from 'zustand';

type Tab = 'planner' | 'board' | 'agents' | 'terminals';

interface AppState {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'planner',
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
