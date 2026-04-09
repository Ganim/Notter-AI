// src/types/actions.ts
//
// Phase B (2026-04-08): extended for the autonomous pipeline. New types and
// fields are additive — existing UI code continues to read the v1 fields.
// Phase D will start populating the new fields; Phase G will eventually
// remove the v1-only fields once all consumers migrate.

// ----- v1 statuses (kept) + v2 additions (additive union expansion) -----

export type ActionStatus =
  // v1
  | 'waiting'
  | 'processing'
  | 'skipped'
  | 'done'
  // v2 (autonomous pipeline)
  | 'draft'
  | 'planning'
  | 'plan_review'
  | 'rejected'
  | 'queued'
  | 'running'
  | 'awaiting_hitl'
  | 'report_review'
  | 'failed'
  | 'cancelled';

export type ActionTaskStatus =
  // v1
  | 'waiting'
  | 'running'
  | 'done'
  | 'failed'
  // v2 (autonomous pipeline)
  | 'pending'
  | 'blocked_hitl'
  | 'skipped';

// ----- v2 new types -----

export type TrustLevel = 'auto' | 'semi' | 'manual';

export type PlanStageName = 'extract' | 'security' | 'data_consistency' | 'prompt_critic';

export type PlanStageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TokenUsage {
  worker: 'gemini-cli' | 'codex-cli' | 'claude-code';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costEstimate?: number;
  apiDurationMs?: number;
  timestamp: number;
}

export interface PlanStage {
  name: PlanStageName;
  status: PlanStageStatus;
  startedAt?: number;
  completedAt?: number;
  output?: string;
  tokenUsage?: TokenUsage;
  errorMessage?: string;
}

export interface TaskTestRun {
  command: string;
  passed: boolean;
  output?: string;
}

export interface TaskResult {
  summary: string;
  filesChanged: string[];
  testsRun: TaskTestRun[];
  errorMessage?: string;
}

export interface ActionReport {
  generatedAt: number;
  summary: string;
  tasksCompleted: number;
  tasksFailed: number;
  totalTokens: TokenUsage[];
  diffPath?: string;
  userDecision?: 'approved' | 'rejected';
  userComment?: string;
}

// ----- ActionTask: v1 fields + v2 optional additions -----

export interface ActionTask {
  // v1 fields (kept verbatim — UI still reads these)
  id: string;
  objective: string;
  prompt: string;
  agentId: string;
  modelTag: string;
  terminalId: string;
  status: ActionTaskStatus;
  returnText: string;

  // v2 fields (optional — populated by the planning pipeline starting in Phase D)
  rawPrompt?: string;
  refinedPrompt?: string;
  trustLevel?: TrustLevel;
  securityFlags?: string[];
  dataFlags?: string[];
  dependsOn?: string[];
  result?: TaskResult;
  startedAt?: number;
  completedAt?: number;
}

// ----- Action: v1 fields + v2 optional additions -----

export interface Action {
  // v1 fields (kept verbatim — UI still reads these)
  id: string;
  projectName: string;
  subjectName: string;
  title: string;
  summary: string;
  originalMarkdown: string;
  status: ActionStatus;
  createdAt: string; // ISO string in v1; v2 uses createdAtMs alongside
  updatedAt: string; // ISO string in v1; v2 uses updatedAtMs alongside
  tasks: ActionTask[];

  // v2 fields (optional — populated by the planning pipeline starting in Phase D)
  projectId?: string;
  projectPath?: string;
  planStages?: PlanStage[];
  tokenUsage?: TokenUsage[];
  report?: ActionReport;
  createdAtMs?: number; // numeric mirror of createdAt for v2 consumers
  updatedAtMs?: number; // numeric mirror of updatedAt for v2 consumers
}

// ----- v1 helpers (kept) -----

export const ACTION_TASK_STATUS_CYCLE: ActionTaskStatus[] = [
  'waiting',
  'running',
  'done',
  'failed',
];

export function nextTaskStatus(current: ActionTaskStatus): ActionTaskStatus {
  const idx = ACTION_TASK_STATUS_CYCLE.indexOf(current);
  if (idx === -1) {
    // v2 status passed in — fall back to 'waiting' so the UI doesn't break
    return 'waiting';
  }
  return ACTION_TASK_STATUS_CYCLE[(idx + 1) % ACTION_TASK_STATUS_CYCLE.length];
}
