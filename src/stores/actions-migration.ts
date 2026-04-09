// src/stores/actions-migration.ts
//
// Phase B (2026-04-08): pure migration function from actions.json v1 to v2.
// Additive: every v1 field is preserved; v2 optional fields are populated
// where derivable, otherwise left undefined.
//
// IMPORTANT: this function is pure (no I/O, no Tauri, no Zustand). The
// caller (actions-store.ts) handles reading, writing, and backup.

import type { Action, ActionStatus, ActionTask, ActionTaskStatus } from '@/types/actions';

export interface ActionsFileV1 {
  version: 1;
  actions: Action[];
}

export interface ActionsFileV2 {
  version: 2;
  actions: Action[];
}

export type ActionsFile = ActionsFileV1 | ActionsFileV2;

export interface MigrationResult {
  file: ActionsFileV2;
  migrated: boolean; // true if input was v1 and was migrated; false if already v2
  warnings: string[];
}

const V1_TO_V2_ACTION_STATUS: Record<string, ActionStatus> = {
  // v1 → v2 status mapping. NOTE: spec §5 originally said `processing → running`,
  // but a migrated 'processing' Action has no live Claude Code process or MCP
  // server, so mapping to 'running' would lie about state. We map to 'draft'
  // instead so the user can re-plan and execute it cleanly.
  waiting: 'draft',
  processing: 'draft',
  done: 'done',
  skipped: 'cancelled',
};

const V1_TO_V2_TASK_STATUS: Record<string, ActionTaskStatus> = {
  waiting: 'pending',
  running: 'pending', // running tasks at migration time have no live terminal
  done: 'done',
  failed: 'failed',
};

function isoToMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

function migrateTask(t: ActionTask, _warnings: string[]): ActionTask {
  const next: ActionTask = { ...t };

  // Map status if v1 value
  if (V1_TO_V2_TASK_STATUS[t.status]) {
    next.status = V1_TO_V2_TASK_STATUS[t.status];
  }

  // Populate v2 fields with safe defaults
  if (next.rawPrompt === undefined) {
    next.rawPrompt = t.prompt ?? '';
  }
  if (next.trustLevel === undefined) {
    next.trustLevel = 'semi';
  }
  if (next.securityFlags === undefined) {
    next.securityFlags = [];
  }
  if (next.dataFlags === undefined) {
    next.dataFlags = [];
  }

  // If the task has captured returnText, surface it as result.summary so the
  // info isn't lost when v2-aware UI starts reading from `result`.
  if (t.returnText && t.returnText.trim().length > 0 && next.result === undefined) {
    next.result = {
      summary: t.returnText,
      filesChanged: [],
      testsRun: [],
    };
  }

  return next;
}

function migrateAction(a: Action, warnings: string[]): Action {
  const next: Action = { ...a };

  // Status mapping
  if (V1_TO_V2_ACTION_STATUS[a.status]) {
    next.status = V1_TO_V2_ACTION_STATUS[a.status];
  }

  // Populate v2 fields with safe defaults
  if (next.projectId === undefined && a.projectName) {
    // v1 used projectName as the de-facto project identifier; promote it.
    next.projectId = a.projectName;
  }

  if (next.projectPath === undefined) {
    // We can't resolve the absolute path here without access to the planner
    // store. Phase D's planning pipeline will resolve and persist projectPath
    // when an Action is first re-planned. Leave undefined for migrated rows.
    warnings.push(
      `Action ${a.id}: projectPath unresolved (will be filled by planning pipeline on next plan)`,
    );
  }

  if (next.planStages === undefined) {
    next.planStages = [];
  }
  if (next.tokenUsage === undefined) {
    next.tokenUsage = [];
  }

  // Numeric mirror of timestamps
  if (next.createdAtMs === undefined) {
    next.createdAtMs = isoToMs(a.createdAt);
  }
  if (next.updatedAtMs === undefined) {
    next.updatedAtMs = isoToMs(a.updatedAt);
  }

  // Migrate tasks
  next.tasks = (a.tasks ?? []).map((t) => migrateTask(t, warnings));

  return next;
}

/**
 * Migrate an ActionsFile shape from v1 to v2. If the input is already v2,
 * returns it unchanged with `migrated: false`. The function never throws on
 * unknown shapes; it returns an empty v2 file with a warning instead.
 */
export function migrateActionsFile(input: unknown): MigrationResult {
  const warnings: string[] = [];

  if (!input || typeof input !== 'object') {
    warnings.push('Input is not an object — returning empty v2 file');
    return { file: { version: 2, actions: [] }, migrated: false, warnings };
  }

  const obj = input as { version?: unknown; actions?: unknown };

  // Already v2
  if (obj.version === 2) {
    const actions = Array.isArray(obj.actions) ? (obj.actions as Action[]) : [];
    return { file: { version: 2, actions }, migrated: false, warnings };
  }

  // v1 (or missing version, treated as v1)
  if (obj.version === 1 || obj.version === undefined) {
    const rawActions = Array.isArray(obj.actions) ? (obj.actions as Action[]) : [];
    const migratedActions = rawActions.map((a) => migrateAction(a, warnings));
    return {
      file: { version: 2, actions: migratedActions },
      migrated: true,
      warnings,
    };
  }

  // Unknown version
  warnings.push(`Unknown version ${String(obj.version)} — returning empty v2 file`);
  return { file: { version: 2, actions: [] }, migrated: false, warnings };
}
