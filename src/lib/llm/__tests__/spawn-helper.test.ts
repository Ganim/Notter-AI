// src/lib/llm/__tests__/spawn-helper.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @tauri-apps/plugin-shell. The helper uses Command.execute() which
// returns a Promise<{ code, signal, stdout, stderr }>. Each test sets
// `executeImpl` to control the mock's resolve/reject behavior.
let executeImpl: () => Promise<{
  code: number | null;
  signal: number | null;
  stdout: string;
  stderr: string;
}> = async () => ({ code: 0, signal: null, stdout: '', stderr: '' });

let lastCreateCall: { program: string; args: string[] } | null = null;

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn((program: string, args: string[]) => {
      lastCreateCall = { program, args };
      return {
        execute: () => executeImpl(),
      };
    }),
  },
}));

import { spawnCli } from '@/lib/llm/spawn-helper';

const ORIGINAL_PLATFORM = navigator.platform;

function setPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    get: () => platform,
  });
}

beforeEach(() => {
  lastCreateCall = null;
  executeImpl = async () => ({ code: 0, signal: null, stdout: '', stderr: '' });
  setPlatform(ORIGINAL_PLATFORM);
});

describe('spawnCli', () => {
  it('returns stdout, stderr, exitCode, durationMs on a successful run', async () => {
    executeImpl = async () => ({
      code: 0,
      signal: null,
      stdout: 'hello world',
      stderr: 'warn',
    });

    const result = await spawnCli({ command: 'claude', args: ['--print'] });
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes program name and args to Command.create', async () => {
    await spawnCli({ command: 'claude', args: ['--print', 'hi'] });
    expect(lastCreateCall?.args).toEqual(['--print', 'hi']);
  });

  it('keeps claude as bare name on Windows (claude.exe is native)', async () => {
    setPlatform('Win32');
    await spawnCli({ command: 'claude', args: [] });
    expect(lastCreateCall?.program).toBe('claude');
  });

  it('appends .cmd to gemini on Windows', async () => {
    setPlatform('Win32');
    await spawnCli({ command: 'gemini', args: [] });
    expect(lastCreateCall?.program).toBe('gemini.cmd');
  });

  it('appends .cmd to codex on Windows', async () => {
    setPlatform('Win32');
    await spawnCli({ command: 'codex', args: [] });
    expect(lastCreateCall?.program).toBe('codex.cmd');
  });

  it('keeps gemini as bare name on Linux', async () => {
    setPlatform('Linux x86_64');
    await spawnCli({ command: 'gemini', args: [] });
    expect(lastCreateCall?.program).toBe('gemini');
  });

  it('throws LLMWorkerError with reason cli_not_found when execute fails with not found', async () => {
    executeImpl = async () => {
      throw new Error('program not allowed on the configured shell scope');
    };

    await expect(spawnCli({ command: 'codex', args: [] })).rejects.toMatchObject({
      reason: 'cli_not_found',
      cli: 'codex',
    });
  });

  it('throws LLMWorkerError with reason cli_not_found on "command not found"', async () => {
    executeImpl = async () => {
      throw new Error('command not found: nope');
    };

    await expect(spawnCli({ command: 'codex', args: [] })).rejects.toMatchObject({
      reason: 'cli_not_found',
      cli: 'codex',
    });
  });

  it('throws LLMWorkerError with reason unknown for other execute errors', async () => {
    executeImpl = async () => {
      throw new Error('something weird');
    };

    await expect(spawnCli({ command: 'claude', args: [] })).rejects.toMatchObject({
      reason: 'unknown',
      cli: 'claude',
    });
  });

  it('throws LLMWorkerError with reason timeout when the deadline elapses', async () => {
    // Never resolves
    executeImpl = () => new Promise(() => {});

    await expect(
      spawnCli({ command: 'claude', args: [], timeoutMs: 50 }),
    ).rejects.toMatchObject({
      reason: 'timeout',
      cli: 'claude',
    });
  });

  it('propagates non-zero exit codes without throwing', async () => {
    executeImpl = async () => ({
      code: 2,
      signal: null,
      stdout: '',
      stderr: 'some error',
    });

    const result = await spawnCli({ command: 'gemini', args: [] });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('some error');
  });
});
