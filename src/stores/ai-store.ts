import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appLocalDataDir } from '@tauri-apps/api/path';
import * as ollama from '@/lib/ollama';
import type { CloudProviderId, ProviderId } from '@/lib/ai-providers';
import { CLOUD_PROVIDERS } from '@/lib/ai-providers';

const STORAGE_KEY = 'notter-ai:provider-state';

export type OllamaStatus = 'unknown' | 'not-installed' | 'stopped' | 'running';

export interface PullProgress {
  status: string;
  layerLabel: string | null;
  percent: number;
}

interface InstallingOllamaState {
  downloaded: number;
  total: number;
}

export interface CloudProviderConfig {
  apiKey: string;
  model: string;
}

type CloudConfigs = Record<CloudProviderId, CloudProviderConfig>;

function defaultCloudConfigs(): CloudConfigs {
  return CLOUD_PROVIDERS.reduce<CloudConfigs>(
    (acc, p) => {
      acc[p.id] = { apiKey: '', model: p.defaultModel };
      return acc;
    },
    {} as CloudConfigs,
  );
}

interface PersistedState {
  activeModelTag: string | null;
  activeProviderId: ProviderId;
  cloudConfigs: CloudConfigs;
}

interface AiState extends PersistedState {
  ollamaStatus: OllamaStatus;
  installedModels: string[];
  pulling: Record<string, PullProgress>;
  installingOllama: InstallingOllamaState | null;

  initialize(): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshInstalledModels(): Promise<void>;
  installOllama(): Promise<void>;
  startOllamaService(): Promise<void>;
  pullModel(tag: string): Promise<void>;
  removeModel(tag: string): Promise<void>;
  setActiveModel(tag: string): void;

  setActiveProvider(id: ProviderId): void;
  updateCloudConfig(id: CloudProviderId, patch: Partial<CloudProviderConfig>): void;
}

function loadPersisted(): PersistedState {
  const fallback: PersistedState = {
    activeModelTag: null,
    activeProviderId: 'ollama',
    cloudConfigs: defaultCloudConfigs(),
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      activeModelTag: parsed.activeModelTag ?? null,
      activeProviderId: parsed.activeProviderId ?? 'ollama',
      cloudConfigs: { ...defaultCloudConfigs(), ...(parsed.cloudConfigs ?? {}) },
    };
  } catch {
    return fallback;
  }
}

function persist(state: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  ollamaStatus: 'unknown',
  installedModels: [],
  activeModelTag: null,
  activeProviderId: 'ollama',
  cloudConfigs: defaultCloudConfigs(),
  pulling: {},
  installingOllama: null,

  async initialize() {
    const persisted = loadPersisted();
    set({
      activeModelTag: persisted.activeModelTag,
      activeProviderId: persisted.activeProviderId,
      cloudConfigs: persisted.cloudConfigs,
    });
    await get().refreshStatus();
    if (get().ollamaStatus === 'running') {
      await get().refreshInstalledModels();
    }
  },

  async refreshStatus() {
    try {
      const running = await invoke<boolean>('ollama_check_running');
      if (running) {
        set({ ollamaStatus: 'running' });
        return;
      }
      // Service not running. Check if binary is installed to distinguish stopped vs not-installed.
      try {
        const installed = await invoke<boolean>('ollama_check_installed');
        set({ ollamaStatus: installed ? 'stopped' : 'not-installed' });
      } catch {
        set({ ollamaStatus: 'not-installed' });
      }
    } catch {
      set({ ollamaStatus: 'not-installed' });
    }
  },

  async refreshInstalledModels() {
    const tags = await ollama.listInstalledModels();
    const { activeModelTag, activeProviderId, cloudConfigs } = get();
    const next: Partial<AiState> = { installedModels: tags };
    if (activeModelTag && !tags.includes(activeModelTag)) {
      next.activeModelTag = null;
      persist({ activeModelTag: null, activeProviderId, cloudConfigs });
    }
    set(next);
  },

  async installOllama() {
    set({ installingOllama: { downloaded: 0, total: 0 } });
    const unlisten = await listen<{ downloaded: number; total: number }>(
      'ollama-download-progress',
      (e) => {
        set({ installingOllama: e.payload });
      },
    );

    try {
      const url = 'https://ollama.com/download/OllamaSetup.exe';
      const dest = await pickInstallerPath();

      await invoke('ollama_download_installer', { url, destPath: dest });
      set({ installingOllama: null });
      await invoke('ollama_run_installer', { path: dest });

      // Poll for service up to 60s
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const running = await invoke<boolean>('ollama_check_running');
        if (running) {
          set({ ollamaStatus: 'running' });
          await get().refreshInstalledModels();
          return;
        }
      }
      throw new Error('service did not start within 60s');
    } catch (e) {
      set({ installingOllama: null });
      throw e;
    } finally {
      unlisten();
    }
  },

  async startOllamaService() {
    await invoke('ollama_start_service');
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const running = await invoke<boolean>('ollama_check_running');
      if (running) {
        set({ ollamaStatus: 'running' });
        await get().refreshInstalledModels();
        return;
      }
    }
    throw new Error('service did not start within 15s');
  },

  async pullModel(tag: string) {
    const { pulling } = get();
    if (Object.keys(pulling).length > 0) {
      throw new Error('Another model is currently being pulled');
    }
    set({
      pulling: {
        ...pulling,
        [tag]: { status: 'pulling manifest', layerLabel: null, percent: 0 },
      },
    });

    try {
      await ollama.pullModel(tag, (event) => {
        set((s) => ({
          pulling: {
            ...s.pulling,
            [tag]: {
              status: event.status,
              layerLabel: event.digest ? `layer ${event.digest.slice(7, 13)}` : null,
              percent: event.percent,
            },
          },
        }));
      });
      set((s) => {
        const next = { ...s.pulling };
        delete next[tag];
        return { pulling: next };
      });
      await get().refreshInstalledModels();
    } catch (e) {
      set((s) => {
        const next = { ...s.pulling };
        delete next[tag];
        return { pulling: next };
      });
      throw e;
    }
  },

  async removeModel(tag: string) {
    await ollama.deleteModel(tag);
    await get().refreshInstalledModels();
  },

  setActiveModel(tag: string) {
    const { activeProviderId, cloudConfigs } = get();
    set({ activeModelTag: tag });
    persist({ activeModelTag: tag, activeProviderId, cloudConfigs });
  },

  setActiveProvider(id) {
    const { activeModelTag, cloudConfigs } = get();
    set({ activeProviderId: id });
    persist({ activeModelTag, activeProviderId: id, cloudConfigs });
  },

  updateCloudConfig(id, patch) {
    const next = {
      ...get().cloudConfigs,
      [id]: { ...get().cloudConfigs[id], ...patch },
    };
    set({ cloudConfigs: next });
    const { activeModelTag, activeProviderId } = get();
    persist({ activeModelTag, activeProviderId, cloudConfigs: next });
  },
}));

async function pickInstallerPath(): Promise<string> {
  const dir = await appLocalDataDir();
  return `${dir}OllamaSetup.exe`;
}
