import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ollama', () => ({
  listInstalledModels: vi.fn(),
  deleteModel: vi.fn(),
  generate: vi.fn(),
  pullModel: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:\\test\\'),
}));

import { useAiStore } from '@/stores/ai-store';
import * as ollama from '@/lib/ollama';
import { invoke } from '@tauri-apps/api/core';

beforeEach(() => {
  useAiStore.setState({
    ollamaStatus: 'unknown',
    installedModels: [],
    activeModelTag: null,
    pulling: {},
    installingOllama: null,
  });
  vi.clearAllMocks();
  localStorage.clear();
});

describe('aiStore', () => {
  describe('refreshStatus', () => {
    it('sets running when invoke returns true', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(true);
      await useAiStore.getState().refreshStatus();
      expect(useAiStore.getState().ollamaStatus).toBe('running');
    });

    it('sets stopped when service down but binary installed', async () => {
      vi.mocked(invoke)
        .mockResolvedValueOnce(false) // ollama_check_running
        .mockResolvedValueOnce(true); // ollama_check_installed
      await useAiStore.getState().refreshStatus();
      expect(useAiStore.getState().ollamaStatus).toBe('stopped');
    });

    it('sets not-installed when service down and binary missing', async () => {
      vi.mocked(invoke)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      await useAiStore.getState().refreshStatus();
      expect(useAiStore.getState().ollamaStatus).toBe('not-installed');
    });
  });

  describe('refreshInstalledModels', () => {
    it('clears active model if tag was removed', async () => {
      useAiStore.setState({ activeModelTag: 'gone:1', installedModels: [] });
      vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce(['qwen3-vl:4b']);
      await useAiStore.getState().refreshInstalledModels();
      const s = useAiStore.getState();
      expect(s.installedModels).toEqual(['qwen3-vl:4b']);
      expect(s.activeModelTag).toBeNull();
    });

    it('keeps active model if still present', async () => {
      useAiStore.setState({ activeModelTag: 'qwen3-vl:4b' });
      vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce(['qwen3-vl:4b']);
      await useAiStore.getState().refreshInstalledModels();
      expect(useAiStore.getState().activeModelTag).toBe('qwen3-vl:4b');
    });
  });

  describe('setActiveModel', () => {
    it('persists to localStorage', () => {
      useAiStore.getState().setActiveModel('qwen3-vl:4b');
      expect(useAiStore.getState().activeModelTag).toBe('qwen3-vl:4b');
      expect(localStorage.getItem('notter-ai:provider-state')).toContain('qwen3-vl:4b');
    });
  });

  describe('initialize', () => {
    it('loads activeModelTag from localStorage', async () => {
      localStorage.setItem(
        'notter-ai:provider-state',
        JSON.stringify({ activeModelTag: 'persisted:1' }),
      );
      vi.mocked(invoke).mockResolvedValue(false);
      vi.mocked(ollama.listInstalledModels).mockResolvedValue([]);
      await useAiStore.getState().initialize();
      expect(useAiStore.getState().activeModelTag).toBe('persisted:1');
    });
  });

  describe('pullModel', () => {
    it('rejects when another pull is in progress', async () => {
      useAiStore.setState({
        pulling: {
          'other:1': { status: 'downloading', layerLabel: null, percent: 50 },
        },
      });
      await expect(useAiStore.getState().pullModel('qwen3-vl:4b')).rejects.toThrow();
    });

    it('sets and clears pulling state on success', async () => {
      vi.mocked(ollama.pullModel).mockImplementationOnce(async (_tag, onProgress) => {
        onProgress({ status: 'pulling manifest', percent: 0 });
        onProgress({ status: 'success', percent: 100 });
      });
      vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce(['qwen3-vl:4b']);
      await useAiStore.getState().pullModel('qwen3-vl:4b');
      expect(useAiStore.getState().pulling).toEqual({});
      expect(useAiStore.getState().installedModels).toContain('qwen3-vl:4b');
    });

    it('clears pulling and surfaces error on failure', async () => {
      vi.mocked(ollama.pullModel).mockRejectedValueOnce(new Error('boom'));
      await expect(useAiStore.getState().pullModel('qwen3-vl:4b')).rejects.toThrow('boom');
      expect(useAiStore.getState().pulling).toEqual({});
    });

    it('updates progress mid-stream', async () => {
      vi.mocked(ollama.pullModel).mockImplementationOnce(async (_tag, onProgress) => {
        onProgress({ status: 'downloading', digest: 'sha256:abcdef0123', percent: 30 });
        // Verify mid-stream state from outside
        const mid = useAiStore.getState().pulling['qwen3-vl:4b'];
        expect(mid?.percent).toBe(30);
        expect(mid?.layerLabel).toBe('layer abcdef');
      });
      vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce([]);
      await useAiStore.getState().pullModel('qwen3-vl:4b');
    });
  });

  describe('removeModel', () => {
    it('calls ollama.deleteModel and refreshes', async () => {
      vi.mocked(ollama.deleteModel).mockResolvedValueOnce(undefined);
      vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce([]);
      await useAiStore.getState().removeModel('qwen3-vl:4b');
      expect(ollama.deleteModel).toHaveBeenCalledWith('qwen3-vl:4b');
      expect(ollama.listInstalledModels).toHaveBeenCalled();
    });
  });
});
