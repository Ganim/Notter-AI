// src/lib/executor/mcp-config.ts
//
// Phase E: build the per-Action --mcp-config JSON that claude-code reads
// at spawn time to discover the notter MCP server. Each spawn writes a
// fresh config file under $APPLOCALDATA/exec-state/ so parallel runs
// (future) won't step on each other.

import { writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';

export interface McpConfigInput {
  /** Absolute path to notter-mcp-server/dist/server.js. */
  serverAbsolutePath: string;
  actionId: string;
  /** Absolute path to the exec-state directory. */
  stateDir: string;
}

export interface McpConfigJson {
  mcpServers: {
    notter: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
}

export function buildMcpConfigJson(input: McpConfigInput): McpConfigJson {
  return {
    mcpServers: {
      notter: {
        command: 'node',
        args: [
          input.serverAbsolutePath,
          '--action-id',
          input.actionId,
          '--state-dir',
          input.stateDir,
        ],
        env: {},
      },
    },
  };
}

export async function ensureExecStateDir(): Promise<string> {
  const dir = await appLocalDataDir();
  const execStateDir = await join(dir, 'exec-state');
  try {
    if (!(await exists(execStateDir))) {
      await mkdir(execStateDir, { recursive: true });
    }
  } catch {
    // Non-fatal; writeTextFile surfaces the real error.
  }
  return execStateDir;
}

export async function writeMcpConfigFile(input: {
  actionId: string;
  serverAbsolutePath: string;
  stateDir: string;
}): Promise<string> {
  const dir = await ensureExecStateDir();
  const filePath = await join(dir, `mcp-config-${input.actionId}.json`);
  const json = buildMcpConfigJson(input);
  await writeTextFile(filePath, JSON.stringify(json, null, 2));
  return filePath;
}
