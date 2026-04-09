// src/lib/executor/types.ts
//
// Phase E: shared types for the executor library. These mirror the
// ExecStateFile shape that lives in notter-mcp-server/src/state.ts —
// duplicated intentionally in Phase E (see spec §3.3). Phase G may
// extract a shared types package.

import type { TrustLevel } from '@/types/actions';

export type ExecTaskStatus = 'pending' | 'running' | 'done' | 'failed';

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

/** Handle returned by spawnClaudeExecutor — used by the Queue Worker
 *  to await exit and clean up temp files. */
export interface SpawnHandle {
  /** Resolves with the exit code (non-null) or -1 on abnormal exit. */
  waitForExit: () => Promise<number>;
  /** Best-effort kill; no-op if the process already exited. */
  kill: () => Promise<void>;
}
