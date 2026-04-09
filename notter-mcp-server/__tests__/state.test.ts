import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadState, saveState, type ExecStateFile } from '../src/state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-state-'));
});

function makeState(actionId: string): ExecStateFile {
  return {
    actionId,
    projectPath: 'D:/project',
    projectName: 'proj',
    tasks: [
      {
        id: 't1',
        title: 'Task 1',
        refinedPrompt: 'Do the thing',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'semi',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
}

describe('state', () => {
  it('saveState writes JSON atomically', () => {
    const s = makeState('act-1');
    saveState(tmpDir, s);
    const filePath = path.join(tmpDir, 'act-1.json');
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.actionId).toBe('act-1');
    expect(parsed.tasks).toHaveLength(1);
  });

  it('loadState round-trips saveState', () => {
    const s = makeState('act-2');
    saveState(tmpDir, s);
    const loaded = loadState(tmpDir, 'act-2');
    expect(loaded).toEqual(s);
  });

  it('loadState returns null when file does not exist', () => {
    const loaded = loadState(tmpDir, 'nope');
    expect(loaded).toBeNull();
  });

  it('saveState writes through a temp file (atomicity smoke)', () => {
    const s = makeState('act-3');
    saveState(tmpDir, s);
    const tmpPath = path.join(tmpDir, 'act-3.json.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('saveState throws a clear error when the dir is unwritable', () => {
    expect(() =>
      saveState('/nonexistent/dir', makeState('act-4')),
    ).toThrow();
  });
});
