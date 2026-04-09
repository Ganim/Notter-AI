import { describe, it, expect, vi, beforeEach } from 'vitest';

let writeCalls: { path: string; content: string }[] = [];
let readReturn: string | null = null;

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async (p: string, c: string) => {
    writeCalls.push({ path: p, content: c });
  }),
  readTextFile: vi.fn(async () => {
    if (readReturn === null) throw new Error('ENOENT');
    return readReturn;
  }),
  exists: vi.fn(async () => readReturn !== null),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

import {
  writeExecState,
  readExecState,
  execStatePath,
} from '@/lib/executor/exec-state';
import type { ExecStateFile } from '@/lib/executor/types';

beforeEach(() => {
  writeCalls = [];
  readReturn = null;
});

const sample: ExecStateFile = {
  actionId: 'act-1',
  projectPath: 'D:/p',
  projectName: 'p',
  tasks: [],
  priorTaskSummaries: [],
};

describe('exec-state', () => {
  it('execStatePath resolves under $APPLOCALDATA/exec-state/', async () => {
    const p = await execStatePath('act-42');
    expect(p).toBe('C:/appdata/exec-state/act-42.json');
  });

  it('writeExecState serializes JSON and writes to the correct path', async () => {
    await writeExecState(sample);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].path).toBe('C:/appdata/exec-state/act-1.json');
    expect(JSON.parse(writeCalls[0].content).actionId).toBe('act-1');
  });

  it('readExecState returns parsed state when the file exists', async () => {
    readReturn = JSON.stringify(sample);
    const s = await readExecState('act-1');
    expect(s).toEqual(sample);
  });

  it('readExecState returns null when the file is missing', async () => {
    readReturn = null;
    const s = await readExecState('ghost');
    expect(s).toBeNull();
  });
});
