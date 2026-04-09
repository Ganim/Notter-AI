// src/lib/planning/index.ts
//
// Phase D: public entry point for the planning pipeline library.
// Consumers outside of lib/planning/** should only import from here.

export type {
  PipelineInput,
  PipelineProgressHandler,
  StageRunResult,
  ProjectContext,
  PipelineErrorReason,
} from './types';

export { PipelineError, enforceTrustFloor } from './types';

export { runPipeline, type RunPipelineOptions } from './orchestrator';

// Stage modules are exported so the store can drive individual stages
// if it ever needs to (today, retries go through runPipeline with
// resumeFrom — but this keeps the option open).
export { runExtractStage } from './stages/extract';
export { runSecurityStage } from './stages/security';
export { runDataStage } from './stages/data-consistency';
export { runPromptCriticStage } from './stages/prompt-critic';
