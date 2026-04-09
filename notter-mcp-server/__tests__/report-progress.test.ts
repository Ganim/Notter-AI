import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, loadState, type ExecStateFile } from '../src/state.js';
import { reportProgress } from '../src/tools/report-progress.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-rp-'));
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
        startedAt: Date.now(),
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
  saveState(tmpDir, state);
}

describe('report_progress', () => {
  it('updates the summary field on the targeted task', () => {
    seed();
    const out = reportProgress(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      status: 'running',
      summary: 'Created file foo.ts',
    });
    expect(out).toEqual({ ok: true });
    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].summary).toBe('Created file foo.ts');
    expect(after.tasks[0].status).toBe('running');
  });

  it('does not transition status even when a different status is passed', () => {
    seed();
    reportProgress(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      status: 'blocked_hitl',
      summary: 'blocked by user',
    });
    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].status).toBe('running');
  });

  it('throws when task_id does not exist', () => {
    seed();
    expect(() =>
      reportProgress(tmpDir, {
        action_id: 'act-1',
        task_id: 'unknown',
        status: 'running',
        summary: 'x',
      }),
    ).toThrow(/task .* not found/i);
  });

  it('throws when action state is missing', () => {
    expect(() =>
      reportProgress(tmpDir, {
        action_id: 'ghost',
        task_id: 't1',
        status: 'running',
        summary: 'x',
      }),
    ).toThrow(/not found/i);
  });
});
