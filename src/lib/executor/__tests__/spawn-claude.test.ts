import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockChild {
  pid: number;
  write: (data: string) => Promise<void>;
  kill: () => Promise<void>;
}

let spawnImpl: () => Promise<MockChild> = async () => ({
  pid: 1,
  write: async () => {},
  kill: async () => {},
});
let lastCreateCall: { program: string; args: string[] } | null = null;
let closeHandler: ((payload: { code: number | null }) => void) | null = null;

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn((program: string, args: string[]) => {
      lastCreateCall = { program, args };
      return {
        on: (event: string, h: (payload: unknown) => void) => {
          if (event === 'close') closeHandler = h as typeof closeHandler;
        },
        spawn: () => spawnImpl(),
      };
    }),
  },
}));

import { spawnClaudeExecutor } from '@/lib/executor/spawn-claude';

beforeEach(() => {
  lastCreateCall = null;
  closeHandler = null;
});

describe('spawnClaudeExecutor', () => {
  it('spawns claude with --print --mcp-config --strict-mcp-config and initial prompt', async () => {
    const handle = await spawnClaudeExecutor({
      mcpConfigPath: 'C:/appdata/exec-state/mcp-config-act-1.json',
      initialPrompt: 'do the thing',
    });
    expect(lastCreateCall?.program).toBe('claude');
    expect(lastCreateCall?.args).toEqual([
      '--print',
      '--mcp-config',
      'C:/appdata/exec-state/mcp-config-act-1.json',
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
      'do the thing',
    ]);
    closeHandler?.({ code: 0 });
    expect(await handle.waitForExit()).toBe(0);
  });

  it('waitForExit resolves with the process exit code', async () => {
    const handle = await spawnClaudeExecutor({
      mcpConfigPath: 'x.json',
      initialPrompt: 'p',
    });
    closeHandler?.({ code: 42 });
    expect(await handle.waitForExit()).toBe(42);
  });

  it('waitForExit resolves with -1 when code is null', async () => {
    const handle = await spawnClaudeExecutor({
      mcpConfigPath: 'x.json',
      initialPrompt: 'p',
    });
    closeHandler?.({ code: null });
    expect(await handle.waitForExit()).toBe(-1);
  });
});
