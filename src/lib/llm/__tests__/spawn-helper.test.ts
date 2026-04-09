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

// Mock fs + path plugins so the Windows-stdin route can run in vitest
// without touching a real filesystem. Record every call so tests can
// assert on the temp-file lifecycle.
const fsCalls: { op: string; args: unknown[] }[] = [];
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async (...args: unknown[]) => {
    fsCalls.push({ op: 'writeTextFile', args });
  }),
  mkdir: vi.fn(async (...args: unknown[]) => {
    fsCalls.push({ op: 'mkdir', args });
  }),
  remove: vi.fn(async (...args: unknown[]) => {
    fsCalls.push({ op: 'remove', args });
  }),
  exists: vi.fn(async () => true),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:/test/appdata/'),
}));

import {
  spawnCli,
  psSingleQuote,
  buildPowerShellCommand,
  isWindowsRuntime,
} from '@/lib/llm/spawn-helper';

const ORIGINAL_PLATFORM = navigator.platform;

function setPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    get: () => platform,
  });
}

beforeEach(() => {
  lastCreateCall = null;
  fsCalls.length = 0;
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

describe('isWindowsRuntime', () => {
  it('returns true for Win32 platform', () => {
    setPlatform('Win32');
    expect(isWindowsRuntime()).toBe(true);
  });

  it('returns false for Linux', () => {
    setPlatform('Linux x86_64');
    expect(isWindowsRuntime()).toBe(false);
  });

  it('returns false for MacIntel', () => {
    setPlatform('MacIntel');
    expect(isWindowsRuntime()).toBe(false);
  });
});

describe('psSingleQuote', () => {
  it('wraps a simple string in single quotes', () => {
    expect(psSingleQuote('hello world')).toBe("'hello world'");
  });

  it('doubles embedded single quotes', () => {
    expect(psSingleQuote("it's a test")).toBe("'it''s a test'");
  });

  it('leaves double quotes, backslashes, newlines untouched', () => {
    expect(psSingleQuote('C:\\path\\"file"\n')).toBe("'C:\\path\\\"file\"\n'");
  });

  it('handles an empty string', () => {
    expect(psSingleQuote('')).toBe("''");
  });
});

describe('buildPowerShellCommand', () => {
  it('builds a Get-Content | & cli one-liner with proper quoting', () => {
    const ps = buildPowerShellCommand({
      tempPath: 'C:/test/appdata/tmp-prompts/prompt-abc.txt',
      cliExecutable: 'gemini.cmd',
      cliArgs: ['-p', ' ', '-o', 'json'],
    });
    expect(ps).toBe(
      "$ErrorActionPreference='Stop'; Get-Content -Raw -LiteralPath 'C:/test/appdata/tmp-prompts/prompt-abc.txt' | & 'gemini.cmd' '-p' ' ' '-o' 'json'",
    );
  });

  it('escapes single quotes in the temp path', () => {
    const ps = buildPowerShellCommand({
      tempPath: "C:/o'brien/tmp.txt",
      cliExecutable: 'codex.cmd',
      cliArgs: ['exec', '-'],
    });
    expect(ps).toContain("'C:/o''brien/tmp.txt'");
    expect(ps).toContain("& 'codex.cmd' 'exec' '-'");
  });
});

describe('spawnCli — Windows stdin route', () => {
  it('routes through powershell.exe with a temp file when stdin is provided on Windows', async () => {
    setPlatform('Win32');
    executeImpl = async () => ({
      code: 0,
      signal: null,
      stdout: '{"ok":true}',
      stderr: '',
    });

    await spawnCli({
      command: 'gemini',
      args: ['-p', ' ', '-o', 'json'],
      stdin: 'long multi\nline\nprompt with "quotes" & <angles>',
    });

    expect(lastCreateCall?.program).toBe('powershell.exe');
    const psArgs = lastCreateCall!.args;
    expect(psArgs).toContain('-NoProfile');
    expect(psArgs).toContain('-NonInteractive');
    expect(psArgs).toContain('-Command');
    const commandIdx = psArgs.indexOf('-Command');
    const psCmd = psArgs[commandIdx + 1];
    expect(psCmd).toMatch(/Get-Content -Raw -LiteralPath/);
    expect(psCmd).toMatch(/& 'gemini\.cmd'/);
    expect(psCmd).toMatch(/'-p' ' ' '-o' 'json'/);

    // Verify the lifecycle: write → execute → remove (remove is fire-and-
    // forget via void, so it may run after execute resolves — we check
    // writeTextFile was called at minimum).
    const writeCall = fsCalls.find((c) => c.op === 'writeTextFile');
    expect(writeCall).toBeTruthy();
    expect(writeCall!.args[1]).toContain('long multi\nline\nprompt');
  });

  it('falls back to the legacy path on non-Windows even when stdin is set', async () => {
    setPlatform('Linux');
    await spawnCli({
      command: 'gemini',
      args: ['-p', 'raw prompt', '-o', 'json'],
      stdin: 'ignored on linux',
    });

    expect(lastCreateCall?.program).toBe('gemini');
    expect(lastCreateCall?.args).toEqual(['-p', 'raw prompt', '-o', 'json']);
    // No temp file written
    expect(fsCalls.find((c) => c.op === 'writeTextFile')).toBeUndefined();
  });

  it('keeps the legacy path on Windows when stdin is NOT provided', async () => {
    setPlatform('Win32');
    await spawnCli({ command: 'codex', args: ['--version'] });
    expect(lastCreateCall?.program).toBe('codex.cmd');
    expect(fsCalls.find((c) => c.op === 'writeTextFile')).toBeUndefined();
  });

  it('deletes the temp file after execute resolves', async () => {
    setPlatform('Win32');
    await spawnCli({
      command: 'codex',
      args: ['exec', '-'],
      stdin: 'hello',
    });

    // Allow the fire-and-forget remove() microtask to flush.
    await Promise.resolve();
    await Promise.resolve();
    const removeCall = fsCalls.find((c) => c.op === 'remove');
    expect(removeCall).toBeTruthy();
  });
});
