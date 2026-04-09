// src/lib/planning/types.ts
//
// Phase D: shared types for the planning pipeline. Keep this file free of
// runtime dependencies — it's imported by every stage module and the store.

import type { ActionTask, PlanStageName, TokenUsage, TrustLevel } from '@/types/actions';

/** Snapshot of a project passed to every stage as context. */
export interface ProjectContext {
  /** Project name (display only). */
  name: string;
  /** Absolute project path. */
  path: string;
  /** Short description of what this project does, used in prompts. */
  description?: string;
  /** Optional list of top-level files/dirs for greenfield detection. */
  topLevelEntries?: string[];
}

/** Input for running the full pipeline against a raw note. */
export interface PipelineInput {
  actionId: string;
  rawMarkdown: string;
  project: ProjectContext;
  /** If set, resume from this stage; earlier stages are skipped. */
  resumeFrom?: PlanStageName;
  /** Existing tasks from a prior run, used when resumeFrom is set. */
  existingTasks?: ActionTask[];
}

/** Result of running one stage. */
export interface StageRunResult {
  stageName: PlanStageName;
  tasks: ActionTask[]; // full array — each stage returns the next snapshot
  tokenUsage: TokenUsage;
  durationMs: number;
  rawOutput: string; // verbatim LLM output, stored for debugging
}

/** Orchestrator progress callback. Fires after every stage commit. */
export type PipelineProgressHandler = (
  result: StageRunResult,
) => void | Promise<void>;

/** Reasons a pipeline stage can fail. */
export type PipelineErrorReason =
  | 'llm_error'
  | 'parse_error'
  | 'schema_error'
  | 'validation_error'
  | 'cancelled';

/** Structured pipeline error — mapped from LLMWorkerError or schema violations. */
export class PipelineError extends Error {
  readonly stage: PlanStageName;
  readonly reason: PipelineErrorReason;
  readonly rawOutput?: string;

  constructor(opts: {
    stage: PlanStageName;
    reason: PipelineErrorReason;
    message: string;
    rawOutput?: string;
  }) {
    super(opts.message);
    this.name = 'PipelineError';
    this.stage = opts.stage;
    this.reason = opts.reason;
    this.rawOutput = opts.rawOutput;
  }
}

/**
 * Trust-floor rule: if the prompt-critic classified a task as `auto` but
 * either securityFlags or dataFlags are non-empty, bump it up to `semi`.
 * Trust levels only ever escalate, never de-escalate — this protects
 * against LLM over-confidence bypassing human review.
 */
export function enforceTrustFloor(
  task: ActionTask,
  classifierTrust: TrustLevel,
): TrustLevel {
  const hasFlags =
    (task.securityFlags?.length ?? 0) > 0 ||
    (task.dataFlags?.length ?? 0) > 0;
  if (classifierTrust === 'auto' && hasFlags) return 'semi';
  return classifierTrust;
}
