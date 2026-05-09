import { create } from 'zustand';
import { readTextFile, writeTextFile, exists, rename } from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import type {
  Action,
  ActionTask,
  ActionTaskStatus,
  PlanStage,
  PlanStageName,
} from '@/types/actions';
import { nextTaskStatus } from '@/types/actions';
import { migrateActionsFile } from '@/stores/actions-migration';
import {
  runPipeline,
  PipelineError,
  type ProjectContext,
  type StageRunResult,
} from '@/lib/planning';
import { startQueueWorker } from '@/lib/executor';
import { pushActions } from '@/lib/sync';
import { useAuthStore } from '@/stores/auth-store';
import { makeDebouncedSync, runOnce, deleteUserRow } from '@/lib/synced-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { getAccountManager } from '@/lib/accounts/account-manager';

const actionsSync = makeDebouncedSync<Action[]>(pushActions, 1000);

const FILE_NAME = 'actions.json';
const FILE_VERSION = 2;
const V1_BACKUP_SUFFIX = '.v1-backup.json';

// Phase E: dev-time path to the built MCP server. In a packaged Tauri
// build this will need to resolve via resourceDir() — Phase F will
// teach the executor to adapt. For now, assume the Tauri dev cwd is
// the repo root, which Tauri sets automatically in `tauri dev`.
const PHASE_E_MCP_SERVER_PATH =
  'D:/Code/Projetos/CodeReview/AgentTrack/notter-mcp-server/dist/server.js';

async function bootExecutor(getState: () => ActionsState): Promise<void> {
  await runOnce('queue-worker', async () => {
    await startQueueWorker({
      serverAbsolutePath: PHASE_E_MCP_SERVER_PATH,
      intervalMs: 500,
      getActions: () => getState().actions,
      updateAction: (id, patch) => getState().updateAction(id, patch),
      updateTask: (actionId, taskId, patch) =>
        getState().updateTask(actionId, taskId, patch),
    });
  });
}

interface PersistedShapeV2 {
  version: 2;
  actions: Action[];
}

interface ActionsState {
  actions: Action[];
  selectedActionId: string | null;
  loaded: boolean;

  load(): Promise<void>;
  addAction(action: Action): Promise<void>;
  updateAction(id: string, patch: Partial<Action>): Promise<void>;
  deleteAction(id: string): Promise<void>;
  setSelected(id: string | null): void;

  updateTask(actionId: string, taskId: string, patch: Partial<ActionTask>): Promise<void>;
  cycleTaskStatus(actionId: string, taskId: string): Promise<void>;

  // Phase D — planning pipeline
  startPlanning(actionId: string, project: ProjectContext): Promise<void>;
  retryPlanStage(actionId: string, stage: PlanStageName): Promise<void>;
  approvePlan(actionId: string): Promise<void>;
  rejectPlan(actionId: string, reason?: string): Promise<void>;

  // Phase E — re-queue a failed/done execution back into the queue.
  requeueExecution(actionId: string): Promise<void>;

  // Sync
  applyRemoteActions(actions: Action[]): void;

  reset(): void;
}

// ----- Phase D: planning pipeline helpers (pure, no store state access) -----

const STAGE_ORDER: PlanStageName[] = [
  'extract',
  'security',
  'data_consistency',
  'prompt_critic',
];

function seedPlanStages(): PlanStage[] {
  const now = Date.now();
  return STAGE_ORDER.map((name, i) => ({
    name,
    status: i === 0 ? 'running' : 'pending',
    startedAt: i === 0 ? now : undefined,
  }));
}

/**
 * Build a fresh planStages snapshot that marks every stage up to and
 * including `upTo` as pending (clearing errors) and `upTo` itself as
 * running. Stages beyond `upTo` are left at whatever they were.
 */
function resetPlanStagesFrom(
  existing: PlanStage[] | undefined,
  upTo: PlanStageName,
): PlanStage[] {
  const now = Date.now();
  const base: PlanStage[] = existing
    ? [...existing]
    : STAGE_ORDER.map((name) => ({ name, status: 'pending' as const }));

  // Ensure all 4 entries exist in order
  const byName = new Map(base.map((s) => [s.name, s]));
  const ordered: PlanStage[] = STAGE_ORDER.map(
    (n) => byName.get(n) ?? { name: n, status: 'pending' as const },
  );

  const targetIdx = STAGE_ORDER.indexOf(upTo);
  return ordered.map((s, i) => {
    if (i === targetIdx) {
      return {
        ...s,
        status: 'running',
        startedAt: now,
        completedAt: undefined,
        errorMessage: undefined,
        output: undefined,
        tokenUsage: undefined,
      };
    }
    if (i > targetIdx) {
      return { name: s.name, status: 'pending' };
    }
    return s;
  });
}

function applyStageCommit(
  stages: PlanStage[] | undefined,
  result: StageRunResult,
): PlanStage[] {
  const now = Date.now();
  const base: PlanStage[] = stages
    ? [...stages]
    : STAGE_ORDER.map((name) => ({ name, status: 'pending' as const }));
  const byName = new Map(base.map((s) => [s.name, s]));
  const existing = byName.get(result.stageName) ?? { name: result.stageName, status: 'pending' as const };

  const nextStageIdx = STAGE_ORDER.indexOf(result.stageName) + 1;
  const updated: PlanStage = {
    ...existing,
    status: 'done',
    completedAt: now,
    tokenUsage: result.tokenUsage,
    output: result.rawOutput,
    errorMessage: undefined,
  };
  byName.set(result.stageName, updated);

  // Start the next stage (if any) as running so the UI strip advances
  // even before the next StageRunResult commits.
  if (nextStageIdx < STAGE_ORDER.length) {
    const nextName = STAGE_ORDER[nextStageIdx];
    const nextExisting = byName.get(nextName) ?? { name: nextName, status: 'pending' as const };
    byName.set(nextName, { ...nextExisting, status: 'running', startedAt: now });
  }
  return STAGE_ORDER.map((n) => byName.get(n)!);
}

function applyStageFailure(
  stages: PlanStage[] | undefined,
  stageName: PlanStageName,
  errorMessage: string,
  rawOutput: string | undefined,
): PlanStage[] {
  const now = Date.now();
  const base: PlanStage[] = stages
    ? [...stages]
    : STAGE_ORDER.map((name) => ({ name, status: 'pending' as const }));
  const byName = new Map(base.map((s) => [s.name, s]));
  const existing = byName.get(stageName) ?? { name: stageName, status: 'pending' as const };
  byName.set(stageName, {
    ...existing,
    status: 'failed',
    completedAt: now,
    errorMessage,
    output: rawOutput ?? existing.output,
  });
  return STAGE_ORDER.map((n) => byName.get(n)!);
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

async function getActionsPath(): Promise<string> {
  const dir = await appLocalDataDir();
  const id = getAccountManager().activeAccountId;
  if (!id) throw new Error('getActionsPath: no active account');
  return join(dir, 'notter-ai', id, FILE_NAME);
}

async function persist(actions: Action[]): Promise<void> {
  // Note: we used to call ensureDir() here, which called
  // `exists(appLocalDataDir())`. That check is REJECTED by Tauri's
  // fs:scope — `$APPLOCALDATA/**` only matches children of the app
  // data dir, not the dir itself. Tauri creates the app data dir
  // automatically at startup, so the check was not only unnecessary
  // but actively breaking persistence on every write. Just let
  // writeTextFile surface any real "missing dir" errors.
  const path = await getActionsPath();
  const tmpPath = `${path}.tmp`;
  const payload: PersistedShapeV2 = { version: FILE_VERSION, actions };
  // Atomic write: write to .tmp then rename. If rename fails (Windows
  // sometimes refuses to overwrite an existing file), remove the target
  // first and retry once.
  await writeTextFile(tmpPath, JSON.stringify(payload, null, 2));
  try {
    await rename(tmpPath, path);
  } catch {
    // Fallback: write directly (loses atomicity but at least persists)
    await writeTextFile(path, JSON.stringify(payload, null, 2));
  }
}

let pendingPersistArgs: (() => Action[]) | null = null;

function schedulePersist(getActions: () => Action[]) {
  pendingPersistArgs = getActions;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const fn = pendingPersistArgs;
    pendingPersistArgs = null;
    writeTimer = null;
    if (fn) {
      const actions = fn();
      persist(actions).catch((e) => {
        console.error('[actions-store] failed to persist', e);
      });
      actionsSync.schedule(actions);
    }
  }, 300);
}

/**
 * Synchronously flush any pending debounced write. Returns a promise that
 * resolves when the disk write completes. Call this from window close handlers
 * to avoid losing the most recent edits.
 */
export async function flushActionsStore(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const fn = pendingPersistArgs;
  pendingPersistArgs = null;
  if (fn) {
    await persist(fn());
  }
  await actionsSync.flush();
}

export const useActionsStore = create<ActionsState>((set, get) => ({
  actions: [],
  selectedActionId: null,
  loaded: false,

  async load() {
    if (!getAccountManager().activeAccountId) return;
    try {
      const path = await getActionsPath();
      if (!(await exists(path))) {
        set({ actions: [], loaded: true });
        return;
      }
      const raw = await readTextFile(path);
      try {
        const parsed = JSON.parse(raw);
        const result = migrateActionsFile(parsed);

        if (result.migrated) {
          // Write the .v1-backup.json next to the live file BEFORE rewriting
          // so the user can recover the original shape if anything goes wrong.
          const backupPath = `${path}${V1_BACKUP_SUFFIX}`;
          try {
            await writeTextFile(backupPath, raw);
            console.log('[actions-store] v1 → v2 migration: backed up to', backupPath);
          } catch (backupErr) {
            console.error('[actions-store] failed to write v1 backup', backupErr);
          }
          if (result.warnings.length > 0) {
            console.warn('[actions-store] migration warnings:', result.warnings);
          }
        }

        // Reset stale in-flight statuses caused by an unclean process exit.
        // For v1 these were 'processing' actions and 'running' tasks; the
        // migration already mapped 'processing' → 'draft' and 'running' →
        // 'pending', but for v2 files (already migrated) we apply the same
        // recovery rule to v2 'running' actions and v2 'running' tasks here.
        const actions = result.file.actions.map((a) => ({
          ...a,
          status: a.status === 'running' ? ('draft' as const) : a.status,
          tasks: a.tasks.map((t) =>
            t.status === 'running' ? { ...t, status: 'pending' as const } : t,
          ),
        }));

        set({ actions, loaded: true });

        // If we migrated, persist immediately so the on-disk file is v2.
        if (result.migrated) {
          schedulePersist(() => get().actions);
        }
      } catch (parseErr) {
        console.error('[actions-store] parse error, backing up corrupted file', parseErr);
        const backup = `${path}.corrupted-${Date.now()}`;
        await rename(path, backup).catch(() => {});
        set({ actions: [], loaded: true });
      }
    } catch (e) {
      console.error('[actions-store] load failed', e);
      set({ actions: [], loaded: true });
    }

    // Phase E: boot the Queue Worker once the store is loaded.
    void bootExecutor(get).catch(console.error);
  },

  async addAction(action) {
    set((s) => ({ actions: [...s.actions, action] }));
    schedulePersist(() => get().actions);
  },

  async updateAction(id, patch) {
    set((s) => ({
      actions: s.actions.map((a) =>
        a.id === id ? { ...a, ...patch, updatedAt: new Date().toISOString() } : a,
      ),
    }));
    schedulePersist(() => get().actions);
  },

  async deleteAction(id) {
    set((s) => ({
      actions: s.actions.filter((a) => a.id !== id),
      selectedActionId: s.selectedActionId === id ? null : s.selectedActionId,
    }));
    schedulePersist(() => get().actions);
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteUserRow('actions', userId, id).catch((e) => console.error(e));
  },

  setSelected(id) {
    set({ selectedActionId: id });
  },

  async updateTask(actionId, taskId, patch) {
    set((s) => ({
      actions: s.actions.map((a) => {
        if (a.id !== actionId) return a;
        return {
          ...a,
          updatedAt: new Date().toISOString(),
          tasks: a.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
        };
      }),
    }));
    schedulePersist(() => get().actions);
  },

  async cycleTaskStatus(actionId, taskId) {
    const action = get().actions.find((a) => a.id === actionId);
    if (!action) return;
    const task = action.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const next: ActionTaskStatus = nextTaskStatus(task.status);
    await get().updateTask(actionId, taskId, { status: next });
  },

  async startPlanning(actionId, project) {
    const action = get().actions.find((a) => a.id === actionId);
    if (!action) return;
    // Idempotent: if we're already planning this action, do nothing.
    if (action.status === 'planning') return;

    // Seed status + plan stages (extract = running) BEFORE kicking off
    // the pipeline so the UI immediately reflects the change.
    set((s) => ({
      actions: s.actions.map((a) =>
        a.id === actionId
          ? {
              ...a,
              status: 'planning',
              planStages: seedPlanStages(),
              updatedAt: new Date().toISOString(),
            }
          : a,
      ),
    }));
    schedulePersist(() => get().actions);

    const onProgress = async (result: StageRunResult) => {
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === actionId
            ? {
                ...a,
                planStages: applyStageCommit(a.planStages, result),
                tasks: result.tasks,
                updatedAt: new Date().toISOString(),
              }
            : a,
        ),
      }));
      schedulePersist(() => get().actions);
    };

    try {
      await runPipeline(
        { actionId, rawMarkdown: action.originalMarkdown, project },
        onProgress,
      );
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === actionId
            ? { ...a, status: 'plan_review', updatedAt: new Date().toISOString() }
            : a,
        ),
      }));
      schedulePersist(() => get().actions);
    } catch (e) {
      const err =
        e instanceof PipelineError
          ? e
          : new PipelineError({
              stage: 'extract',
              reason: 'llm_error',
              message: e instanceof Error ? e.message : String(e),
            });
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === actionId
            ? {
                ...a,
                status: 'failed',
                planStages: applyStageFailure(
                  a.planStages,
                  err.stage,
                  err.message,
                  err.rawOutput,
                ),
                updatedAt: new Date().toISOString(),
              }
            : a,
        ),
      }));
      schedulePersist(() => get().actions);
    }
  },

  async retryPlanStage(actionId, stage) {
    const action = get().actions.find((a) => a.id === actionId);
    if (!action) return;

    // Reset the target stage (and everything after it) and flip status
    // back to 'planning' so the UI shows the strip advancing again.
    set((s) => ({
      actions: s.actions.map((a) =>
        a.id === actionId
          ? {
              ...a,
              status: 'planning',
              planStages: resetPlanStagesFrom(a.planStages, stage),
              updatedAt: new Date().toISOString(),
            }
          : a,
      ),
    }));
    schedulePersist(() => get().actions);

    const project: ProjectContext = {
      name: action.projectName,
      path: action.projectPath ?? '',
    };

    const onProgress = async (result: StageRunResult) => {
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === actionId
            ? {
                ...a,
                planStages: applyStageCommit(a.planStages, result),
                tasks: result.tasks,
                updatedAt: new Date().toISOString(),
              }
            : a,
        ),
      }));
      schedulePersist(() => get().actions);
    };

    try {
      await runPipeline(
        {
          actionId,
          rawMarkdown: action.originalMarkdown,
          project,
          resumeFrom: stage,
          existingTasks: action.tasks,
        },
        onProgress,
      );
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === actionId
            ? { ...a, status: 'plan_review', updatedAt: new Date().toISOString() }
            : a,
        ),
      }));
      schedulePersist(() => get().actions);
    } catch (e) {
      const err =
        e instanceof PipelineError
          ? e
          : new PipelineError({
              stage,
              reason: 'llm_error',
              message: e instanceof Error ? e.message : String(e),
            });
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === actionId
            ? {
                ...a,
                status: 'failed',
                planStages: applyStageFailure(
                  a.planStages,
                  err.stage,
                  err.message,
                  err.rawOutput,
                ),
                updatedAt: new Date().toISOString(),
              }
            : a,
        ),
      }));
      schedulePersist(() => get().actions);
    }
  },

  async approvePlan(actionId) {
    set((s) => ({
      actions: s.actions.map((a) => {
        if (a.id !== actionId) return a;
        if (a.status !== 'plan_review') return a;
        return {
          ...a,
          status: 'queued',
          updatedAt: new Date().toISOString(),
          tasks: a.tasks.map((t) => ({ ...t, status: 'pending' as const })),
        };
      }),
    }));
    schedulePersist(() => get().actions);
  },

  async rejectPlan(actionId, reason) {
    set((s) => ({
      actions: s.actions.map((a) => {
        if (a.id !== actionId) return a;
        if (a.status !== 'plan_review') return a;
        const stages = a.planStages ?? [];
        // Record the reason on the last PlanStage if any; otherwise on
        // a synthetic prompt_critic entry so the UI has somewhere to read.
        const lastIdx = stages.length - 1;
        const nextStages =
          lastIdx >= 0
            ? stages.map((s, i) =>
                i === lastIdx
                  ? { ...s, errorMessage: reason ?? s.errorMessage }
                  : s,
              )
            : [
                {
                  name: 'prompt_critic' as const,
                  status: 'done' as const,
                  errorMessage: reason,
                },
              ];
        return {
          ...a,
          status: 'rejected',
          planStages: nextStages,
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
    schedulePersist(() => get().actions);
  },

  async requeueExecution(actionId) {
    set((s) => ({
      actions: s.actions.map((a) => {
        if (a.id !== actionId) return a;
        // Allow re-queue from any "execution-touched" state. We do NOT
        // re-queue from plan_review/rejected/draft because those states
        // mean the plan itself isn't ready.
        if (
          a.status !== 'failed' &&
          a.status !== 'done' &&
          a.status !== 'queued' &&
          a.status !== 'running'
        ) {
          return a;
        }
        return {
          ...a,
          status: 'queued' as const,
          updatedAt: new Date().toISOString(),
          tasks: a.tasks.map((t) => ({
            ...t,
            status: 'pending' as const,
            summary: undefined,
            result: undefined,
            startedAt: undefined,
            completedAt: undefined,
          })),
        };
      }),
    }));
    schedulePersist(() => get().actions);
  },

  applyRemoteActions(actions) {
    set({ actions, loaded: true });
    persist(actions).catch((e) => {
      console.error('[actions-store] failed to persist remote actions', e);
    });
  },

  reset() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; pendingPersistArgs = null; }
    set({
      actions: [],
      selectedActionId: null,
      loaded: false,
    });
  },
}));

registerResettableStore(() => useActionsStore.getState().reset());

export function getActionProgress(action: Action): { done: number; total: number } {
  const total = action.tasks.length;
  const done = action.tasks.filter((t) => t.status === 'done').length;
  return { done, total };
}
