// notter-mcp-server/src/state.ts
//
// Phase E: read/write helpers for the per-Action exec state file. The file
// is the single source of truth while an Action is running; Queue Worker
// writes it once at start, MCP tools mutate it on each call, and Queue
// Worker polls it to mirror progress into the Zustand store.
//
// Atomic writes: write to <id>.json.tmp then rename to <id>.json. The
// rename is atomic on Windows and POSIX, so a crash mid-write cannot
// corrupt the file.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

export type ExecTaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type TrustLevel = 'auto' | 'semi' | 'manual';

export interface ExecTaskResult {
  summary: string;
  filesChanged: string[];
  testsRun: Array<{ command: string; passed: boolean; output?: string }>;
  errorMessage?: string;
}

export interface ExecTaskSnapshot {
  id: string;
  title: string;
  refinedPrompt: string;
  securityFlags: string[];
  dataFlags: string[];
  trustLevel: TrustLevel;
  status: ExecTaskStatus;
  summary?: string;
  result: ExecTaskResult | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface PriorTaskSummary {
  title: string;
  summary: string;
}

export interface ExecStateFile {
  actionId: string;
  projectPath: string;
  projectName: string;
  tasks: ExecTaskSnapshot[];
  priorTaskSummaries: PriorTaskSummary[];
}

function pathFor(stateDir: string, actionId: string): string {
  return path.join(stateDir, `${actionId}.json`);
}

export function loadState(
  stateDir: string,
  actionId: string,
): ExecStateFile | null {
  const filePath = pathFor(stateDir, actionId);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as ExecStateFile;
}

export function saveState(stateDir: string, state: ExecStateFile): void {
  const filePath = pathFor(stateDir, state.actionId);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}
