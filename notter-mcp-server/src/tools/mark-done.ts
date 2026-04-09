// notter-mcp-server/src/tools/mark-done.ts
//
// Phase E — Tool 3 of 5: mark_done.
// Finalizes a task. Sets status to 'done' on success or 'failed' when
// error_message is present. Fills the task's result object and appends
// a { title, summary } entry to priorTaskSummaries so later calls to
// get_project_context can surface it.

import { loadState, saveState } from '../state.js';

export interface MarkDoneTestRun {
  command: string;
  passed: boolean;
  output?: string;
}

export interface MarkDoneInput {
  action_id: string;
  task_id: string;
  summary: string;
  files_changed: string[];
  tests_run?: MarkDoneTestRun[];
  error_message?: string;
}

export interface MarkDoneOut {
  ok: true;
}

export function markDone(
  stateDir: string,
  input: MarkDoneInput,
): MarkDoneOut {
  const state = loadState(stateDir, input.action_id);
  if (!state) {
    throw new Error(`exec state for action ${input.action_id} not found`);
  }
  const task = state.tasks.find((t) => t.id === input.task_id);
  if (!task) {
    throw new Error(
      `task ${input.task_id} not found in action ${input.action_id}`,
    );
  }
  task.status = input.error_message ? 'failed' : 'done';
  task.completedAt = Date.now();
  task.result = {
    summary: input.summary,
    filesChanged: input.files_changed,
    testsRun: input.tests_run ?? [],
    ...(input.error_message ? { errorMessage: input.error_message } : {}),
  };
  state.priorTaskSummaries.push({
    title: task.title,
    summary: input.summary,
  });
  saveState(stateDir, state);
  return { ok: true };
}
