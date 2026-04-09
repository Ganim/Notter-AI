// notter-mcp-server/src/tools/get-next-task.ts
//
// Phase E — Tool 1 of 5: get_next_task.
// Returns the first pending task from the exec state file, enriched with
// project context. Side-effect: marks the returned task as `running` with
// startedAt = now so the Queue Worker sees the transition on its next
// poll tick. If there are no pending tasks, returns { done: true }.

import { loadState, saveState } from '../state.js';

export interface GetNextTaskInput {
  action_id: string;
}

export interface ProjectContextOut {
  path: string;
  name: string;
  is_greenfield: boolean;
}

export interface GetNextTaskOut {
  task_id: string;
  title: string;
  refined_prompt: string;
  security_flags: string[];
  data_flags: string[];
  trust_level: 'auto' | 'semi' | 'manual';
  project_context: ProjectContextOut;
}

export type GetNextTaskResult = GetNextTaskOut | { done: true };

export function getNextTask(
  stateDir: string,
  input: GetNextTaskInput,
): GetNextTaskResult {
  const state = loadState(stateDir, input.action_id);
  if (!state) {
    throw new Error(`exec state for action ${input.action_id} not found`);
  }

  const nextIdx = state.tasks.findIndex((t) => t.status === 'pending');
  if (nextIdx === -1) {
    return { done: true };
  }

  const now = Date.now();
  state.tasks[nextIdx].status = 'running';
  state.tasks[nextIdx].startedAt = now;
  saveState(stateDir, state);

  const task = state.tasks[nextIdx];
  return {
    task_id: task.id,
    title: task.title,
    refined_prompt: task.refinedPrompt,
    security_flags: task.securityFlags,
    data_flags: task.dataFlags,
    trust_level: task.trustLevel,
    project_context: {
      path: state.projectPath,
      name: state.projectName,
      is_greenfield: false,
    },
  };
}
