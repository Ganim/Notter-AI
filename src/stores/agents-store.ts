import { create } from 'zustand';
import { BaseDirectory, readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import type { AgentProfile } from '@/types';

const PROFILES_FILE = 'AgentProfiles/profiles.json';

interface AgentsState {
  profiles: AgentProfile[];
  selectedProfileId: string | null;

  setSelectedProfileId: (id: string | null) => void;
  loadProfiles: () => Promise<void>;
  saveProfiles: (profiles: AgentProfile[]) => Promise<void>;
  createProfile: () => void;
  updateProfile: (id: string, updates: Partial<AgentProfile>) => void;
  deleteProfile: (id: string) => void;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  profiles: [],
  selectedProfileId: null,

  setSelectedProfileId: (id) => set({ selectedProfileId: id }),

  loadProfiles: async () => {
    try {
      if (!(await exists('AgentProfiles', { baseDir: BaseDirectory.AppLocalData }))) {
        await mkdir('AgentProfiles', { baseDir: BaseDirectory.AppLocalData, recursive: true });
      }
      if (await exists(PROFILES_FILE, { baseDir: BaseDirectory.AppLocalData })) {
        const contents = await readTextFile(PROFILES_FILE, { baseDir: BaseDirectory.AppLocalData });
        const parsed: AgentProfile[] = JSON.parse(contents);
        set({ profiles: parsed, selectedProfileId: parsed[0]?.id || null });
      } else {
        const defaultProfile: AgentProfile = {
          id: Date.now().toString(),
          name: 'Assistente Ollama',
          provider: 'ollama',
          apiKey: '',
          systemPrompt: 'Você é um assistente de desenvolvimento que executa e planeja código no Notter-AI.',
          autonomous: false,
        };
        set({ profiles: [defaultProfile], selectedProfileId: defaultProfile.id });
        await get().saveProfiles([defaultProfile]);
      }
    } catch (e) {
      console.error('Failed to load agent profiles:', e);
    }
  },

  saveProfiles: async (profiles) => {
    try {
      await writeTextFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), { baseDir: BaseDirectory.AppLocalData });
    } catch (e) {
      console.error('Failed to save agent profiles:', e);
    }
  },

  createProfile: () => {
    const newProfile: AgentProfile = {
      id: Date.now().toString(),
      name: 'Novo Agente',
      provider: 'ollama',
      apiKey: '',
      systemPrompt: 'Instruções do sistema...',
      autonomous: false,
    };
    const newProfiles = [...get().profiles, newProfile];
    set({ profiles: newProfiles, selectedProfileId: newProfile.id });
    get().saveProfiles(newProfiles);
  },

  updateProfile: (id, updates) => {
    const newProfiles = get().profiles.map((p) => (p.id === id ? { ...p, ...updates } : p));
    set({ profiles: newProfiles });
    get().saveProfiles(newProfiles);
  },

  deleteProfile: (id) => {
    const newProfiles = get().profiles.filter((p) => p.id !== id);
    set({
      profiles: newProfiles,
      selectedProfileId: get().selectedProfileId === id ? newProfiles[0]?.id || null : get().selectedProfileId,
    });
    get().saveProfiles(newProfiles);
  },
}));
