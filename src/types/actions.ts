export type ActionStatus = 'waiting' | 'processing' | 'skipped' | 'done';
export type ActionTaskStatus = 'waiting' | 'running' | 'done' | 'failed';

export interface ActionTask {
  id: string;
  objective: string;
  prompt: string;
  agentId: string;
  modelTag: string;
  terminalId: string;
  status: ActionTaskStatus;
  returnText: string;
}

export interface Action {
  id: string;
  projectName: string;
  subjectName: string;
  title: string;
  summary: string;
  originalMarkdown: string;
  status: ActionStatus;
  createdAt: string;
  updatedAt: string;
  tasks: ActionTask[];
}

export const ACTION_TASK_STATUS_CYCLE: ActionTaskStatus[] = [
  'waiting',
  'running',
  'done',
  'failed',
];

export function nextTaskStatus(current: ActionTaskStatus): ActionTaskStatus {
  const idx = ACTION_TASK_STATUS_CYCLE.indexOf(current);
  return ACTION_TASK_STATUS_CYCLE[(idx + 1) % ACTION_TASK_STATUS_CYCLE.length];
}
