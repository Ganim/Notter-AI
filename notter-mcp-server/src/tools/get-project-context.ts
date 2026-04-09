// notter-mcp-server/src/tools/get-project-context.ts
//
// Phase E — Tool 4 of 5: get_project_context.
// Returns the project path, name, and the list of prior-task summaries
// so claude can orient itself without burning tokens re-reading files.
// file_tree is NOT implemented in Phase E (YAGNI until claude asks for it).

import { loadState, type PriorTaskSummary } from '../state.js';

export interface GetProjectContextInput {
  project_id: string; // we use action_id here; kept the spec name
  include_file_tree?: boolean;
}

export interface GetProjectContextOut {
  path: string;
  name: string;
  is_greenfield: boolean;
  prior_tasks: PriorTaskSummary[];
  file_tree?: string[];
}

export function getProjectContext(
  stateDir: string,
  input: GetProjectContextInput,
): GetProjectContextOut {
  const state = loadState(stateDir, input.project_id);
  if (!state) {
    throw new Error(`exec state for action ${input.project_id} not found`);
  }
  return {
    path: state.projectPath,
    name: state.projectName,
    is_greenfield: false,
    prior_tasks: state.priorTaskSummaries,
  };
}
