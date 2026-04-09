// src/lib/planning/orchestrator.ts
//
// Phase D: runs the 4 planning stages sequentially, persists each
// stage's result via an onProgress callback (the store owns state
// transitions), and supports resuming from a specific stage after a
// partial failure. A cancellation AbortSignal may be supplied — if
// it fires between stages, the orchestrator throws PipelineError with
// reason 'cancelled'.

import type { ActionTask, PlanStageName } from '@/types/actions';
import {
  PipelineError,
  type PipelineInput,
  type PipelineProgressHandler,
  type StageRunResult,
} from './types';

import { runExtractStage } from './stages/extract';
import { runSecurityStage } from './stages/security';
import { runDataStage } from './stages/data-consistency';
import { runPromptCriticStage } from './stages/prompt-critic';

/** Stages in execution order. */
const STAGE_ORDER: PlanStageName[] = [
  'extract',
  'security',
  'data_consistency',
  'prompt_critic',
];

interface StageDefinition {
  name: PlanStageName;
  run: (
    input: PipelineInput,
    prevTasks: ActionTask[] | null,
  ) => Promise<StageRunResult>;
}

const STAGES: StageDefinition[] = [
  {
    name: 'extract',
    run: (input) => runExtractStage(input),
  },
  {
    name: 'security',
    run: (input, prev) =>
      runSecurityStage({ ...input, existingTasks: prev! }),
  },
  {
    name: 'data_consistency',
    run: (input, prev) =>
      runDataStage({ ...input, existingTasks: prev! }),
  },
  {
    name: 'prompt_critic',
    run: (input, prev) =>
      runPromptCriticStage({ ...input, existingTasks: prev! }),
  },
];

export interface RunPipelineOptions {
  /** Optional cancellation signal — checked between stages. */
  signal?: AbortSignal;
}

/**
 * Run the planning pipeline. Invokes `onProgress` after every stage
 * commit with the StageRunResult. On failure, propagates the
 * PipelineError without calling onProgress for the failed stage —
 * the caller is responsible for persisting the failure via its own
 * error path (the store writes a failed PlanStage with errorMessage).
 *
 * If `input.resumeFrom` is set, earlier stages are skipped and the
 * provided `existingTasks` become the starting snapshot.
 */
export async function runPipeline(
  input: PipelineInput,
  onProgress: PipelineProgressHandler,
  options: RunPipelineOptions = {},
): Promise<ActionTask[]> {
  const startIdx = input.resumeFrom
    ? STAGE_ORDER.indexOf(input.resumeFrom)
    : 0;

  if (startIdx < 0) {
    throw new PipelineError({
      stage: 'extract',
      reason: 'validation_error',
      message: `unknown resumeFrom stage "${input.resumeFrom}"`,
    });
  }

  if (startIdx > 0 && !input.existingTasks) {
    throw new PipelineError({
      stage: STAGE_ORDER[startIdx],
      reason: 'validation_error',
      message: `resumeFrom="${STAGE_ORDER[startIdx]}" requires existingTasks`,
    });
  }

  checkCancelled(options.signal, STAGE_ORDER[startIdx]);

  let tasks: ActionTask[] | null = input.existingTasks ?? null;

  for (let i = startIdx; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const result = await stage.run(input, tasks);
    tasks = result.tasks;
    await onProgress(result);
    checkCancelled(
      options.signal,
      i + 1 < STAGES.length ? STAGES[i + 1].name : stage.name,
    );
  }

  return tasks!;
}

function checkCancelled(
  signal: AbortSignal | undefined,
  stage: PlanStageName,
): void {
  if (signal?.aborted) {
    throw new PipelineError({
      stage,
      reason: 'cancelled',
      message: 'pipeline cancelled by caller',
    });
  }
}
