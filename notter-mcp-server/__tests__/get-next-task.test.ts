import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, loadState, type ExecStateFile } from '../src/state.js';
import { getNextTask } from '../src/tools/get-next-task.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-gnt-'));
});

function seed(actionId: string, overrides: Partial<ExecStateFile> = {}): void {
  const state: ExecStateFile = {
    actionId,
    projectPath: 'D:/p',
    projectName: 'p',
    tasks: [
      {
        id: 't1',
        title: 'One',
        refinedPrompt: 'Do 1',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'auto',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      },
      {
        id: 't2',
        title: 'Two',
        refinedPrompt: 'Do 2',
        securityFlags: ['sanitize'],
        dataFlags: [],
        trustLevel: 'semi',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
    ...overrides,
  };
  saveState(tmpDir, state);
}

describe('get_next_task', () => {
  it('returns the first pending task and marks it running', () => {
    seed('act-1');
    const out = getNextTask(tmpDir, { action_id: 'act-1' });
    expect('task_id' in out).toBe(true);
    if ('task_id' in out) {
      expect(out.task_id).toBe('t1');
      expect(out.title).toBe('One');
      expect(out.refined_prompt).toBe('Do 1');
      expect(out.trust_level).toBe('auto');
      expect(out.project_context.path).toBe('D:/p');
      expect(out.project_context.name).toBe('p');
    }

    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].status).toBe('running');
    expect(after.tasks[0].startedAt).toBeGreaterThan(0);
    expect(after.tasks[1].status).toBe('pending');
  });

  it('skips tasks that are already done/failed/running', () => {
    seed('act-2');
    const state = loadState(tmpDir, 'act-2')!;
    state.tasks[0].status = 'done';
    state.tasks[0].completedAt = Date.now();
    saveState(tmpDir, state);

    const out = getNextTask(tmpDir, { action_id: 'act-2' });
    expect('task_id' in out).toBe(true);
    if ('task_id' in out) expect(out.task_id).toBe('t2');
  });

  it('returns {done:true} when no pending tasks remain', () => {
    seed('act-3');
    const state = loadState(tmpDir, 'act-3')!;
    state.tasks.forEach((t) => (t.status = 'done'));
    saveState(tmpDir, state);

    const out = getNextTask(tmpDir, { action_id: 'act-3' });
    expect(out).toEqual({ done: true });
  });

  it('throws when the action state file is missing', () => {
    expect(() => getNextTask(tmpDir, { action_id: 'ghost' })).toThrow(
      /not found/i,
    );
  });

  it('marks the task running with the current timestamp within 2s', () => {
    seed('act-4');
    const before = Date.now();
    getNextTask(tmpDir, { action_id: 'act-4' });
    const after = loadState(tmpDir, 'act-4')!;
    expect(after.tasks[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(after.tasks[0].startedAt!).toBeLessThan(before + 2000);
  });
});
