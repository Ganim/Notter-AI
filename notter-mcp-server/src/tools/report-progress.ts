// notter-mcp-server/src/tools/report-progress.ts
//
// Phase E — Tool 2 of 5: report_progress.
// Updates a task's `summary` field with a short human-readable status.
// The `status` input field is accepted for contract stability but IGNORED
// in Phase E — status is authoritative per the tool that set it
// (get_next_task → running, mark_done → done|failed). Phase F may honor
// blocked_hitl.

import { loadState, saveState } from '../state.js';

export interface ReportProgressInput {
  action_id: string;
  task_id: string;
  status: 'running' | 'blocked_hitl';
  summary: string;
}

export interface ReportProgressOut {
  ok: true;
}

export function reportProgress(
  stateDir: string,
  input: ReportProgressInput,
): ReportProgressOut {
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
  task.summary = input.summary;
  saveState(stateDir, state);
  return { ok: true };
}
