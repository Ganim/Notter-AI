// src/lib/executor/queue-worker.ts
//
// Phase E: singleton loop that consumes queued Actions from the store,
// spawns claude-code via the notter MCP server, polls the exec-state
// file via state-bridge to mirror progress, and transitions the Action
// to done or failed on exit.
//
// One action at a time (strict singleton guarded by a module-level
// `busy` flag). Register once via startQueueWorker() — subsequent calls
// are idempotent no-ops.

import { spawnClaudeExecutor } from './spawn-claude';
import { writeExecState } from './exec-state';
import { writeMcpConfigFile, ensureExecStateDir } from './mcp-config';
import { startStateBridge } from './state-bridge';
import { buildInitialPrompt } from './initial-prompt';
import type { ExecStateFile, ExecTaskSnapshot } from './types';

import type { Action, ActionTask, ActionTaskStatus } from '@/types/actions';

export interface QueueWorkerDeps {
  /** Absolute path to notter-mcp-server/dist/server.js. */
  serverAbsolutePath: string;
  intervalMs: number;
  getActions: () => Action[];
  updateAction: (
    id: string,
    patch: Partial<Action>,
  ) => Promise<void> | void;
  updateTask: (
    actionId: string,
    taskId: string,
    patch: Partial<ActionTask>,
  ) => Promise<void> | void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function __resetQueueWorkerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  busy = false;
}

function actionToExecState(action: Action): ExecStateFile {
  return {
    actionId: action.id,
    projectPath: action.projectPath ?? '',
    projectName: action.projectName,
    tasks: action.tasks.map(
      (t): ExecTaskSnapshot => ({
        id: t.id,
        title: t.objective,
        refinedPrompt: t.refinedPrompt ?? t.prompt,
        securityFlags: t.securityFlags ?? [],
        dataFlags: t.dataFlags ?? [],
        trustLevel: t.trustLevel ?? 'semi',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      }),
    ),
    priorTaskSummaries: [],
  };
}

function mirrorStateToStore(
  state: ExecStateFile,
  deps: QueueWorkerDeps,
): void {
  for (const t of state.tasks) {
    const patch: Partial<ActionTask> = {
      status: t.status as ActionTaskStatus,
    };
    if (t.summary !== undefined) patch.summary = t.summary;
    if (t.result) {
      patch.result = {
        summary: t.result.summary,
        filesChanged: t.result.filesChanged,
        testsRun: t.result.testsRun,
        errorMessage: t.result.errorMessage,
      };
    }
    if (t.startedAt !== null) patch.startedAt = t.startedAt;
    if (t.completedAt !== null) patch.completedAt = t.completedAt;
    void deps.updateTask(state.actionId, t.id, patch);
  }
}

async function runOnce(deps: QueueWorkerDeps): Promise<void> {
  if (busy) return;
  const next = deps.getActions().find((a) => a.status === 'queued');
  if (!next) return;
  busy = true;

  const bridgeHandle = { stop: () => {} };
  let capturedBridge: ReturnType<typeof startStateBridge> | null = null;

  try {
    const stateDir = await ensureExecStateDir();
    const execState = actionToExecState(next);
    await writeExecState(execState);

    const mcpConfigPath = await writeMcpConfigFile({
      actionId: next.id,
      serverAbsolutePath: deps.serverAbsolutePath,
      stateDir,
    });

    await deps.updateAction(next.id, { status: 'running' });

    capturedBridge = startStateBridge({
      actionId: next.id,
      intervalMs: deps.intervalMs,
      onChange: (s) => mirrorStateToStore(s, deps),
    });
    bridgeHandle.stop = () => capturedBridge?.stop();

    const handle = await spawnClaudeExecutor({
      mcpConfigPath,
      initialPrompt: buildInitialPrompt(next.id),
    });
    const code = await handle.waitForExit();

    await deps.updateAction(next.id, {
      status: code === 0 ? 'done' : 'failed',
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[queue-worker] runOnce failed', e);
    await deps.updateAction(next.id, { status: 'failed' });
  } finally {
    bridgeHandle.stop();
    busy = false;
  }
}

export async function startQueueWorker(deps: QueueWorkerDeps): Promise<void> {
  if (timer) return; // idempotent
  timer = setInterval(() => {
    void runOnce(deps);
  }, deps.intervalMs);
}

export function stopQueueWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  busy = false;
}
