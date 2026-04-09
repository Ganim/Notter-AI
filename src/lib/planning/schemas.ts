// src/lib/planning/schemas.ts
//
// Phase D: hand-written validators for each stage's LLM output. We keep
// these short and dependency-free to catch JSON drift without pulling in
// Zod. Every validator takes `unknown`, returns the narrowed shape, and
// throws PipelineError with reason 'schema_error' on failure.

import type { PlanStageName, TrustLevel } from '@/types/actions';
import { PipelineError } from './types';

// ----- shared helpers -----

function fail(
  stage: PlanStageName,
  message: string,
  rawOutput?: string,
): never {
  throw new PipelineError({
    stage,
    reason: 'schema_error',
    message,
    rawOutput,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

function getTasksArray(
  parsed: unknown,
  stage: PlanStageName,
  rawOutput?: string,
): unknown[] {
  if (!isRecord(parsed)) {
    fail(stage, `expected object at root, got ${typeof parsed}`, rawOutput);
  }
  const tasks = (parsed as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) {
    fail(stage, 'missing or non-array "tasks" field', rawOutput);
  }
  return tasks;
}

// ----- stage output shapes -----

export interface ExtractedTask {
  id: string;
  title: string;
  rawPrompt: string;
}

export interface SecurityTaskPatch {
  id: string;
  securityFlags: string[];
}

export interface DataTaskPatch {
  id: string;
  dataFlags: string[];
}

export interface PromptCriticTaskPatch {
  id: string;
  refinedPrompt: string;
  trustLevel: TrustLevel;
}

const TRUST_LEVELS: readonly TrustLevel[] = ['auto', 'semi', 'manual'];

// ----- validators -----

/**
 * Extract stage: { tasks: [{ id, title, rawPrompt }] } with >= 1 task.
 * title capped at 80 chars, rawPrompt must be non-empty.
 */
export function validateExtractOutput(
  parsed: unknown,
  rawOutput?: string,
): ExtractedTask[] {
  const stage: PlanStageName = 'extract';
  const tasks = getTasksArray(parsed, stage, rawOutput);
  if (tasks.length === 0) {
    fail(stage, 'extract produced zero tasks', rawOutput);
  }
  const seenIds = new Set<string>();
  const out: ExtractedTask[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!isRecord(t)) {
      fail(stage, `task[${i}] is not an object`, rawOutput);
    }
    const id = (t as Record<string, unknown>).id;
    const title = (t as Record<string, unknown>).title;
    const rawPrompt = (t as Record<string, unknown>).rawPrompt;
    if (typeof id !== 'string' || id.length === 0) {
      fail(stage, `task[${i}].id missing or not a string`, rawOutput);
    }
    if (seenIds.has(id as string)) {
      fail(stage, `task[${i}].id "${id}" is duplicated`, rawOutput);
    }
    seenIds.add(id as string);
    if (typeof title !== 'string' || title.length === 0) {
      fail(stage, `task[${i}].title missing or not a string`, rawOutput);
    }
    if ((title as string).length > 80) {
      fail(
        stage,
        `task[${i}].title exceeds 80 chars (${(title as string).length})`,
        rawOutput,
      );
    }
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      fail(stage, `task[${i}].rawPrompt missing or empty`, rawOutput);
    }
    out.push({
      id: id as string,
      title: title as string,
      rawPrompt: rawPrompt as string,
    });
  }
  return out;
}

function validateIdPatchArray<T>(
  parsed: unknown,
  stage: PlanStageName,
  expectedIds: Set<string>,
  rawOutput: string | undefined,
  extractFields: (
    t: Record<string, unknown>,
    i: number,
  ) => T,
): T[] {
  const tasks = getTasksArray(parsed, stage, rawOutput);
  if (tasks.length !== expectedIds.size) {
    fail(
      stage,
      `expected ${expectedIds.size} tasks, got ${tasks.length}`,
      rawOutput,
    );
  }
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!isRecord(t)) {
      fail(stage, `task[${i}] is not an object`, rawOutput);
    }
    const rec = t as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== 'string' || id.length === 0) {
      fail(stage, `task[${i}].id missing or not a string`, rawOutput);
    }
    if (!expectedIds.has(id as string)) {
      fail(
        stage,
        `task[${i}].id "${id}" does not match any input task id`,
        rawOutput,
      );
    }
    if (seen.has(id as string)) {
      fail(stage, `task[${i}].id "${id}" is duplicated`, rawOutput);
    }
    seen.add(id as string);
    out.push(extractFields(rec, i));
  }
  return out;
}

/** Security stage: { tasks: [{ id, securityFlags: string[] }] }. */
export function validateSecurityOutput(
  parsed: unknown,
  expectedIds: Set<string>,
  rawOutput?: string,
): SecurityTaskPatch[] {
  return validateIdPatchArray<SecurityTaskPatch>(
    parsed,
    'security',
    expectedIds,
    rawOutput,
    (rec, i) => {
      const flags = rec.securityFlags;
      if (!isStringArray(flags)) {
        fail(
          'security',
          `task[${i}].securityFlags missing or not a string array`,
          rawOutput,
        );
      }
      return { id: rec.id as string, securityFlags: flags };
    },
  );
}

/** Data-consistency stage: { tasks: [{ id, dataFlags: string[] }] }. */
export function validateDataOutput(
  parsed: unknown,
  expectedIds: Set<string>,
  rawOutput?: string,
): DataTaskPatch[] {
  return validateIdPatchArray<DataTaskPatch>(
    parsed,
    'data_consistency',
    expectedIds,
    rawOutput,
    (rec, i) => {
      const flags = rec.dataFlags;
      if (!isStringArray(flags)) {
        fail(
          'data_consistency',
          `task[${i}].dataFlags missing or not a string array`,
          rawOutput,
        );
      }
      return { id: rec.id as string, dataFlags: flags };
    },
  );
}

/** Prompt-critic: { tasks: [{ id, refinedPrompt, trustLevel }] }. */
export function validatePromptCriticOutput(
  parsed: unknown,
  expectedIds: Set<string>,
  rawOutput?: string,
): PromptCriticTaskPatch[] {
  return validateIdPatchArray<PromptCriticTaskPatch>(
    parsed,
    'prompt_critic',
    expectedIds,
    rawOutput,
    (rec, i) => {
      const refinedPrompt = rec.refinedPrompt;
      const trustLevel = rec.trustLevel;
      if (typeof refinedPrompt !== 'string' || refinedPrompt.length === 0) {
        fail(
          'prompt_critic',
          `task[${i}].refinedPrompt missing or empty`,
          rawOutput,
        );
      }
      if (
        typeof trustLevel !== 'string' ||
        !TRUST_LEVELS.includes(trustLevel as TrustLevel)
      ) {
        fail(
          'prompt_critic',
          `task[${i}].trustLevel "${String(trustLevel)}" is not one of auto|semi|manual`,
          rawOutput,
        );
      }
      return {
        id: rec.id as string,
        refinedPrompt: refinedPrompt as string,
        trustLevel: trustLevel as TrustLevel,
      };
    },
  );
}
