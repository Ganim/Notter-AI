// src/lib/executor/exec-state.ts
//
// Phase E: shared helpers for reading/writing the per-Action exec-state
// file from the renderer side. The MCP server has its own identical
// helpers in notter-mcp-server/src/state.ts — duplicated intentionally
// because the two runtimes cannot share a single module.

import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import type { ExecStateFile } from './types';

export async function execStateDir(): Promise<string> {
  const dir = await appLocalDataDir();
  return join(dir, 'exec-state');
}

export async function execStatePath(actionId: string): Promise<string> {
  const dir = await execStateDir();
  return join(dir, `${actionId}.json`);
}

export async function writeExecState(state: ExecStateFile): Promise<void> {
  const path = await execStatePath(state.actionId);
  await writeTextFile(path, JSON.stringify(state, null, 2));
}

export async function readExecState(
  actionId: string,
): Promise<ExecStateFile | null> {
  const path = await execStatePath(actionId);
  if (!(await exists(path))) return null;
  const raw = await readTextFile(path);
  return JSON.parse(raw) as ExecStateFile;
}
