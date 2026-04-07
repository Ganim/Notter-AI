import { invoke } from '@tauri-apps/api/core';
import type { Action } from '@/types/actions';
import { useActionsStore } from '@/stores/actions-store';
import { useTerminalsStore } from '@/stores/terminals-store';

/** Normalize text for PTY input on Windows shells (CR for Enter, no LF). */
export function normalizeForPty(text: string): string {
  const normalized = text.replace(/\r?\n/g, '\r');
  return normalized.endsWith('\r') ? normalized : normalized + '\r';
}

export interface RunActionResult {
  success: number;
  failed: number;
}

/**
 * Inject all waiting tasks of a single action into the given terminal.
 * Updates each task's status to 'running' and sets the runningTask badge.
 * Caller is responsible for marking the parent action's status.
 */
export async function runActionInTerminal(
  action: Action,
  terminalId: string,
  delayMs = 600,
): Promise<RunActionResult> {
  const updateTask = useActionsStore.getState().updateTask;
  const setTerminalRunningTask = useTerminalsStore.getState().setTerminalRunningTask;

  let success = 0;
  let failed = 0;

  const pendingTasks = action.tasks.filter((t) => t.status === 'waiting');
  for (const task of pendingTasks) {
    try {
      const data = normalizeForPty(task.prompt);
      await invoke('write_pty', { id: terminalId, data });
      await updateTask(action.id, task.id, {
        terminalId,
        status: 'running',
      });
      setTerminalRunningTask(terminalId, {
        actionId: action.id,
        taskId: task.id,
        label: task.objective || '(task)',
      });
      success++;
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      failed++;
      console.error('[action-runner] write_pty failed for task', task.id, err);
    }
  }

  return { success, failed };
}

/**
 * Run a queue of actions sequentially in the same terminal.
 * Returns aggregate counts.
 */
export async function runActionQueue(
  actions: Action[],
  terminalId: string,
  delayBetweenActionsMs = 1500,
): Promise<{ actionsProcessed: number; tasksSucceeded: number; tasksFailed: number }> {
  const updateAction = useActionsStore.getState().updateAction;
  let tasksSucceeded = 0;
  let tasksFailed = 0;
  let actionsProcessed = 0;

  for (const action of actions) {
    await updateAction(action.id, { status: 'processing' });
    const fresh = useActionsStore.getState().actions.find((a) => a.id === action.id);
    if (!fresh) continue;
    const r = await runActionInTerminal(fresh, terminalId);
    tasksSucceeded += r.success;
    tasksFailed += r.failed;
    actionsProcessed++;
    if (delayBetweenActionsMs > 0) {
      await new Promise((res) => setTimeout(res, delayBetweenActionsMs));
    }
  }

  return { actionsProcessed, tasksSucceeded, tasksFailed };
}
