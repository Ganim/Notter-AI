import { create } from 'zustand';
import { BaseDirectory, readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import type { AgentProfile, AIProvider } from '@/types';
import { fetchOllamaModels, sendChat, type ChatMessage, type ChatResponse } from '@/lib/chat';
import { pushAgentProfiles } from '@/lib/sync';
import { useAuthStore } from '@/stores/auth-store';
import { makeDebouncedSync, deleteUserRow } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { accountScopedPath, tryAccountScopedPath } from '@/lib/accounts/account-paths';

function getProfilesFile(): string {
  return accountScopedPath('AgentProfiles/profiles.json');
}

const PROVIDER_MODELS: Record<AIProvider, string[]> = {
  ollama: [],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
  gemini: ['gemini-2.0-flash', 'gemini-2.5-pro'],
};

const profilesSync = makeDebouncedSync<AgentProfile[]>(pushAgentProfiles, 1000);

interface AgentsState {
  profiles: AgentProfile[];
  selectedProfileId: string | null;
  ollamaModels: string[];
  ollamaModelsLoading: boolean;
  ollamaModelsError: boolean;

  chatMessages: Record<string, ChatMessage[]>;
  chatLoading: boolean;

  setSelectedProfileId: (id: string | null) => void;
  loadProfiles: () => Promise<void>;
  saveProfiles: (profiles: AgentProfile[]) => Promise<void>;
  createProfile: () => void;
  updateProfile: (id: string, updates: Partial<AgentProfile>) => void;
  deleteProfile: (id: string) => void;
  flush: () => Promise<void>;

  loadOllamaModels: () => Promise<void>;
  getModelsForProvider: (provider: AIProvider) => string[];

  sendTestMessage: (content: string) => Promise<void>;
  clearChat: (profileId: string) => void;
  applyRemoteProfiles: (profiles: AgentProfile[]) => void;
  reset(): void;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  profiles: [],
  selectedProfileId: null,
  ollamaModels: [],
  ollamaModelsLoading: false,
  ollamaModelsError: false,

  chatMessages: {},
  chatLoading: false,

  setSelectedProfileId: (id) => set({ selectedProfileId: id }),

  loadProfiles: async () => {
    if (tryAccountScopedPath('AgentProfiles') === null) return;
    try {
      const agentProfilesPath = accountScopedPath('AgentProfiles');
      if (!(await exists(agentProfilesPath, { baseDir: BaseDirectory.AppLocalData }))) {
        await mkdir(agentProfilesPath, { baseDir: BaseDirectory.AppLocalData, recursive: true });
      }
      const profilesFile = getProfilesFile();
      if (await exists(profilesFile, { baseDir: BaseDirectory.AppLocalData })) {
        const contents = await readTextFile(profilesFile, { baseDir: BaseDirectory.AppLocalData });
        const parsed: AgentProfile[] = JSON.parse(contents);
        const migrated = parsed.map((p) => ({ ...p, model: p.model ?? '' }));
        set({ profiles: migrated, selectedProfileId: migrated[0]?.id || null });
      } else {
        const defaultProfile: AgentProfile = {
          id: Date.now().toString(),
          name: 'Assistente Ollama',
          provider: 'ollama',
          model: '',
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
      await writeTextFile(getProfilesFile(), JSON.stringify(profiles, null, 2), { baseDir: BaseDirectory.AppLocalData });
      profilesSync.schedule(profiles);
    } catch (e) {
      console.error('Failed to save agent profiles:', e);
    }
  },

  createProfile: () => {
    const newProfile: AgentProfile = {
      id: Date.now().toString(),
      name: 'Novo Agente',
      provider: 'ollama',
      model: '',
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
    const newChatMessages = { ...get().chatMessages };
    delete newChatMessages[id];
    set({
      profiles: newProfiles,
      chatMessages: newChatMessages,
      selectedProfileId: get().selectedProfileId === id ? newProfiles[0]?.id || null : get().selectedProfileId,
    });
    get().saveProfiles(newProfiles);
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteUserRow('agent_profiles', userId, id).catch((e) => console.error('[agents-store] deleteUserRow failed', e));
  },

  flush: async () => {
    await profilesSync.flush();
  },

  loadOllamaModels: async () => {
    set({ ollamaModelsLoading: true, ollamaModelsError: false });
    const models = await fetchOllamaModels();
    if (models.length === 0) {
      set({ ollamaModels: [], ollamaModelsLoading: false, ollamaModelsError: true });
    } else {
      set({ ollamaModels: models, ollamaModelsLoading: false, ollamaModelsError: false });
    }
  },

  getModelsForProvider: (provider) => {
    if (provider === 'ollama') return get().ollamaModels;
    return PROVIDER_MODELS[provider] || [];
  },

  sendTestMessage: async (content) => {
    const { selectedProfileId, profiles, chatMessages } = get();
    if (!selectedProfileId) return;

    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (!profile) return;

    const prevMessages = chatMessages[selectedProfileId] || [];
    const userMessage: ChatMessage = { role: 'user', content };
    const allMessages: ChatMessage[] = [
      { role: 'system', content: profile.systemPrompt },
      ...prevMessages,
      userMessage,
    ];

    set({
      chatMessages: {
        ...chatMessages,
        [selectedProfileId]: [...prevMessages, userMessage],
      },
      chatLoading: true,
    });

    const response: ChatResponse = await sendChat(profile, allMessages);

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: response.error ? `Error: ${response.error}` : response.content,
    };

    set((state) => ({
      chatMessages: {
        ...state.chatMessages,
        [selectedProfileId]: [...(state.chatMessages[selectedProfileId] || []), assistantMessage],
      },
      chatLoading: false,
    }));
  },

  clearChat: (profileId) => {
    set((state) => ({
      chatMessages: { ...state.chatMessages, [profileId]: [] },
    }));
  },

  applyRemoteProfiles: (profiles) => {
    set({ profiles, selectedProfileId: profiles[0]?.id || null });
    get().saveProfiles(profiles);
  },

  reset() {
    set({
      profiles: [],
      selectedProfileId: null,
      chatMessages: {},
      chatLoading: false,
    });
  },
}));

registerResettableStore(() => useAgentsStore.getState().reset());
