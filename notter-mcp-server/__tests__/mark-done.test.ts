import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, loadState, type ExecStateFile } from '../src/state.js';
import { markDone } from '../src/tools/mark-done.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-md-'));
});

function seed(): void {
  const state: ExecStateFile = {
    actionId: 'act-1',
    projectPath: 'D:/p',
    projectName: 'p',
    tasks: [
      {
        id: 't1',
        title: 'One',
        refinedPrompt: 'Do 1',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'semi',
        status: 'running',
        result: null,
        startedAt: Date.now() - 1000,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
  saveState(tmpDir, state);
}

describe('mark_done', () => {
  it('marks a task done on success and appends priorTaskSummaries', () => {
    seed();
    const out = markDone(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      summary: 'Created file foo.ts and ran tests',
      files_changed: ['foo.ts'],
      tests_run: [{ command: 'npm test', passed: true }],
    });
    expect(out).toEqual({ ok: true });

    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].status).toBe('done');
    expect(after.tasks[0].completedAt).toBeGreaterThan(0);
    expect(after.tasks[0].result).toEqual({
      summary: 'Created file foo.ts and ran tests',
      filesChanged: ['foo.ts'],
      testsRun: [{ command: 'npm test', passed: true }],
    });
    expect(after.priorTaskSummaries).toHaveLength(1);
    expect(after.priorTaskSummaries[0]).toEqual({
      title: 'One',
      summary: 'Created file foo.ts and ran tests',
    });
  });

  it('marks a task failed when error_message is present', () => {
    seed();
    markDone(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      summary: 'Attempted to create file but permission denied',
      files_changed: [],
      error_message: 'EACCES: permission denied',
    });
    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].status).toBe('failed');
    expect(after.tasks[0].result!.errorMessage).toBe(
      'EACCES: permission denied',
    );
  });

  it('throws when task_id does not exist', () => {
    seed();
    expect(() =>
      markDone(tmpDir, {
        action_id: 'act-1',
        task_id: 'unknown',
        summary: 'x',
        files_changed: [],
      }),
    ).toThrow(/task .* not found/i);
  });

  it('defaults testsRun to an empty array when omitted', () => {
    seed();
    markDone(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      summary: 'ok',
      files_changed: [],
    });
    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].result!.testsRun).toEqual([]);
  });

  it('throws when action state is missing', () => {
    expect(() =>
      markDone(tmpDir, {
        action_id: 'ghost',
        task_id: 't1',
        summary: 'x',
        files_changed: [],
      }),
    ).toThrow(/not found/i);
  });
});
