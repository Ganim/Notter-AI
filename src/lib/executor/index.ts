// src/lib/executor/index.ts
//
// Phase E: public entry point for the executor library.

export type {
  ExecStateFile,
  ExecTaskSnapshot,
  ExecTaskStatus,
  ExecTaskResult,
  PriorTaskSummary,
  SpawnHandle,
} from './types';

export { startQueueWorker, stopQueueWorker } from './queue-worker';
export { buildInitialPrompt } from './initial-prompt';
export { execStatePath, readExecState, writeExecState } from './exec-state';
