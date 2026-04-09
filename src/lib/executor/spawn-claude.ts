// src/lib/executor/spawn-claude.ts
//
// Phase E: spawn claude-code as a long-lived executor process. Unlike
// src/lib/llm/spawn-helper.ts (which uses Command.execute() for one-shot
// CLI calls and captures stdout), this module uses Command.spawn() so
// the process can run for minutes while the Queue Worker polls the
// exec-state file for progress.
//
// The returned SpawnHandle exposes waitForExit and kill. The caller is
// responsible for cleanup of the mcp-config.json temp file — it does
// NOT live inside this module because the Queue Worker needs to keep
// the file around until claude finishes reading it at spawn time.

import { Command } from '@tauri-apps/plugin-shell';
import type { SpawnHandle } from './types';

export interface SpawnClaudeExecutorInput {
  /** Absolute path to the --mcp-config JSON. */
  mcpConfigPath: string;
  /** Initial prompt injected as the final positional arg. */
  initialPrompt: string;
}

export async function spawnClaudeExecutor(
  input: SpawnClaudeExecutorInput,
): Promise<SpawnHandle> {
  const args = [
    '--print',
    '--mcp-config',
    input.mcpConfigPath,
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
    input.initialPrompt,
  ];

  const cmd = Command.create('claude', args);

  let resolveExit: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  cmd.on('close', (payload: { code: number | null }) => {
    resolveExit(payload.code ?? -1);
  });
  cmd.on('error', () => {
    resolveExit(-1);
  });

  const child = await cmd.spawn();

  return {
    waitForExit: () => exitPromise,
    kill: async () => {
      try {
        await child.kill();
      } catch {
        // Already exited.
      }
    },
  };
}
