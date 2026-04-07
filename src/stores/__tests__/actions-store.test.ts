import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  exists: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:\\test\\'),
}));

import * as fs from '@tauri-apps/plugin-fs';
import { useActionsStore, getActionProgress, flushActionsStore } from '@/stores/actions-store';
import type { Action, ActionTask } from '@/types/actions';
import { nextTaskStatus } from '@/types/actions';

function makeTask(id: string, status: ActionTask['status'] = 'waiting'): ActionTask {
  return {
    id,
    objective: `task ${id}`,
    prompt: '',
    agentId: '',
    modelTag: '',
    terminalId: '',
    status,
    returnText: '',
  };
}

function makeAction(id: string, tasks: ActionTask[] = []): Action {
  return {
    id,
    projectName: 'proj',
    subjectName: 'sub.md',
    title: `action ${id}`,
    summary: '',
    originalMarkdown: '',
    status: 'waiting',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks,
  };
}

beforeEach(() => {
  useActionsStore.setState({ actions: [], selectedActionId: null, loaded: false });
  vi.clearAllMocks();
});

describe('actions-store', () => {
  describe('load', () => {
    it('starts with empty array when file does not exist', async () => {
      vi.mocked(fs.exists).mockResolvedValueOnce(false);
      await useActionsStore.getState().load();
      const s = useActionsStore.getState();
      expect(s.actions).toEqual([]);
      expect(s.loaded).toBe(true);
    });

    it('loads actions from valid JSON file', async () => {
      vi.mocked(fs.exists).mockResolvedValueOnce(true);
      vi.mocked(fs.readTextFile).mockResolvedValueOnce(
        JSON.stringify({ version: 1, actions: [makeAction('a1')] }),
      );
      await useActionsStore.getState().load();
      const s = useActionsStore.getState();
      expect(s.actions).toHaveLength(1);
      expect(s.actions[0].id).toBe('a1');
    });

    it('backs up corrupted file and starts empty on parse error', async () => {
      vi.mocked(fs.exists).mockResolvedValueOnce(true);
      vi.mocked(fs.readTextFile).mockResolvedValueOnce('not json {');
      vi.mocked(fs.rename).mockResolvedValueOnce(undefined);
      await useActionsStore.getState().load();
      expect(fs.rename).toHaveBeenCalled();
      expect(useActionsStore.getState().actions).toEqual([]);
      expect(useActionsStore.getState().loaded).toBe(true);
    });
  });

  describe('addAction', () => {
    it('appends to list', async () => {
      await useActionsStore.getState().addAction(makeAction('a1'));
      expect(useActionsStore.getState().actions).toHaveLength(1);
    });
  });

  describe('updateAction', () => {
    it('patches existing action and updates timestamp', async () => {
      const a = makeAction('a1');
      useActionsStore.setState({ actions: [a] });
      const oldUpdatedAt = a.updatedAt;
      // Ensure the new timestamp differs
      await new Promise((r) => setTimeout(r, 5));
      await useActionsStore.getState().updateAction('a1', { title: 'updated' });
      const s = useActionsStore.getState();
      expect(s.actions[0].title).toBe('updated');
      expect(s.actions[0].updatedAt).not.toBe(oldUpdatedAt);
    });

    it('no-op for missing id', async () => {
      await useActionsStore.getState().updateAction('missing', { title: 'x' });
      expect(useActionsStore.getState().actions).toEqual([]);
    });
  });

  describe('deleteAction', () => {
    it('removes by id', async () => {
      useActionsStore.setState({
        actions: [makeAction('a1'), makeAction('a2')],
      });
      await useActionsStore.getState().deleteAction('a1');
      const s = useActionsStore.getState();
      expect(s.actions).toHaveLength(1);
      expect(s.actions[0].id).toBe('a2');
    });

    it('clears selection if the deleted action was selected', async () => {
      useActionsStore.setState({
        actions: [makeAction('a1')],
        selectedActionId: 'a1',
      });
      await useActionsStore.getState().deleteAction('a1');
      expect(useActionsStore.getState().selectedActionId).toBeNull();
    });
  });

  describe('cycleTaskStatus', () => {
    it('advances waiting -> running -> done -> failed -> waiting', async () => {
      const task = makeTask('t1', 'waiting');
      const action = makeAction('a1', [task]);
      useActionsStore.setState({ actions: [action] });

      const get = () => useActionsStore.getState().actions[0].tasks[0].status;

      await useActionsStore.getState().cycleTaskStatus('a1', 't1');
      expect(get()).toBe('running');
      await useActionsStore.getState().cycleTaskStatus('a1', 't1');
      expect(get()).toBe('done');
      await useActionsStore.getState().cycleTaskStatus('a1', 't1');
      expect(get()).toBe('failed');
      await useActionsStore.getState().cycleTaskStatus('a1', 't1');
      expect(get()).toBe('waiting');
    });
  });

  describe('getActionProgress', () => {
    it('counts done tasks correctly', () => {
      const action = makeAction('a1', [
        makeTask('t1', 'done'),
        makeTask('t2', 'done'),
        makeTask('t3', 'running'),
        makeTask('t4', 'waiting'),
      ]);
      expect(getActionProgress(action)).toEqual({ done: 2, total: 4 });
    });

    it('returns 0/0 for empty tasks', () => {
      const action = makeAction('a1', []);
      expect(getActionProgress(action)).toEqual({ done: 0, total: 0 });
    });
  });

  describe('nextTaskStatus', () => {
    it('cycles correctly', () => {
      expect(nextTaskStatus('waiting')).toBe('running');
      expect(nextTaskStatus('running')).toBe('done');
      expect(nextTaskStatus('done')).toBe('failed');
      expect(nextTaskStatus('failed')).toBe('waiting');
    });
  });

  describe('stale running/processing reset on load', () => {
    it('resets running tasks back to waiting on load', async () => {
      const stale: Action = {
        ...makeAction('a1', [makeTask('t1', 'running'), makeTask('t2', 'done')]),
        status: 'processing',
      };
      vi.mocked(fs.exists).mockResolvedValueOnce(true);
      vi.mocked(fs.readTextFile).mockResolvedValueOnce(
        JSON.stringify({ version: 1, actions: [stale] }),
      );
      await useActionsStore.getState().load();
      const a = useActionsStore.getState().actions[0];
      expect(a.status).toBe('waiting'); // processing → waiting
      expect(a.tasks[0].status).toBe('waiting'); // running → waiting
      expect(a.tasks[1].status).toBe('done'); // unchanged
    });
  });

  describe('flushActionsStore', () => {
    it('persists pending debounced writes immediately', async () => {
      vi.mocked(fs.writeTextFile).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.exists).mockResolvedValue(true);

      await useActionsStore.getState().addAction(makeAction('a1'));
      // schedulePersist has a 300ms debounce — flush should write before then
      await flushActionsStore();
      expect(fs.writeTextFile).toHaveBeenCalled();
    });

    it('is a no-op when nothing is pending', async () => {
      await expect(flushActionsStore()).resolves.toBeUndefined();
    });
  });
});
