// src/lib/llm/__tests__/spawn-helper.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @tauri-apps/plugin-shell with a flexible Command stub that lets each
// test inject its own stdout/stderr/close behavior.
const stdoutListeners: Array<(line: string) => void> = [];
const stderrListeners: Array<(line: string) => void> = [];
const closeListeners: Array<(data: { code: number | null; signal: number | null }) => void> = [];
const errorListeners: Array<(err: string) => void> = [];

let writeCalls: string[] = [];
let killCalled = false;
let spawnImpl: () => Promise<{ write: (data: string) => Promise<void>; kill: () => Promise<void> }> =
  async () => ({
    write: async (data: string) => {
      writeCalls.push(data);
    },
    kill: async () => {
      killCalled = true;
    },
  });

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(() => ({
      stdout: { on: (_event: string, fn: (line: string) => void) => stdoutListeners.push(fn) },
      stderr: { on: (_event: string, fn: (line: string) => void) => stderrListeners.push(fn) },
      on: (event: string, fn: (data: unknown) => void) => {
        if (event === 'close') closeListeners.push(fn as typeof closeListeners[number]);
        if (event === 'error') errorListeners.push(fn as typeof errorListeners[number]);
      },
      spawn: () => spawnImpl(),
    })),
  },
}));

import { spawnCli } from '@/lib/llm/spawn-helper';
import { LLMWorkerError } from '@/lib/llm/types';

function emitStdout(line: string) {
  stdoutListeners.forEach((fn) => fn(line));
}
function emitStderr(line: string) {
  stderrListeners.forEach((fn) => fn(line));
}
function emitClose(code: number) {
  closeListeners.forEach((fn) => fn({ code, signal: null }));
}
function emitError(msg: string) {
  errorListeners.forEach((fn) => fn(msg));
}

beforeEach(() => {
  stdoutListeners.length = 0;
  stderrListeners.length = 0;
  closeListeners.length = 0;
  errorListeners.length = 0;
  writeCalls = [];
  killCalled = false;
  spawnImpl = async () => ({
    write: async (data: string) => {
      writeCalls.push(data);
    },
    kill: async () => {
      killCalled = true;
    },
  });
});

describe('spawnCli', () => {
  it('returns stdout, stderr, exitCode, durationMs on a successful run', async () => {
    const promise = spawnCli({ command: 'claude', args: ['--print'] });

    await new Promise((r) => setTimeout(r, 10));
    emitStdout('hello');
    emitStdout(' world');
    emitStderr('warn');
    emitClose(0);

    const result = await promise;
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes stdin when provided', async () => {
    const promise = spawnCli({ command: 'claude', args: [], stdin: 'my prompt' });

    await new Promise((r) => setTimeout(r, 10));
    emitClose(0);

    await promise;
    expect(writeCalls).toContain('my prompt\n');
  });

  it('does not throw if stdin write fails (process closed early)', async () => {
    spawnImpl = async () => ({
      write: async () => {
        throw new Error('EPIPE');
      },
      kill: async () => {},
    });

    const promise = spawnCli({ command: 'gemini', args: [], stdin: 'oops' });

    await new Promise((r) => setTimeout(r, 10));
    emitClose(1);

    const result = await promise;
    expect(result.exitCode).toBe(1);
  });

  it('throws LLMWorkerError with reason cli_not_found when spawn fails with not found', async () => {
    spawnImpl = async () => {
      throw new Error('command not found: nope');
    };

    await expect(spawnCli({ command: 'codex', args: [] })).rejects.toMatchObject({
      reason: 'cli_not_found',
      cli: 'codex',
    });
  });

  it('throws LLMWorkerError with reason unknown for other spawn errors', async () => {
    spawnImpl = async () => {
      throw new Error('something weird');
    };

    await expect(spawnCli({ command: 'claude', args: [] })).rejects.toMatchObject({
      reason: 'unknown',
      cli: 'claude',
    });
  });

  it('throws LLMWorkerError with reason timeout when the deadline elapses', async () => {
    const promise = spawnCli({ command: 'claude', args: [], timeoutMs: 50 });

    await expect(promise).rejects.toMatchObject({
      reason: 'timeout',
      cli: 'claude',
    });
    expect(killCalled).toBe(true);
  });

  it('throws LLMWorkerError on the error event', async () => {
    const promise = spawnCli({ command: 'gemini', args: [] });

    await new Promise((r) => setTimeout(r, 10));
    emitError('something broke');

    await expect(promise).rejects.toBeInstanceOf(LLMWorkerError);
  });
});
