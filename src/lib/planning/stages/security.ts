// src/lib/planning/stages/security.ts
//
// Phase D — Stage 2 of 4: security review.
// Input:  ActionTask[] from the extract stage + project context.
// Output: the same array with securityFlags merged by id. Titles, ids,
//         rawPrompts are NEVER altered by this stage — we verify that
//         via the schema's id-equality check.

import type { ActionTask } from '@/types/actions';
import { runStage } from '../stage-runner';
import { validateSecurityOutput } from '../schemas';
import { SECURITY_PROMPT } from '../prompts';
import type { PipelineInput, StageRunResult, ProjectContext } from '../types';

function buildUserPrompt(
  tasks: ActionTask[],
  project: ProjectContext,
): string {
  const projectBlock = [
    `Project: ${project.name}`,
    `Path: ${project.path}`,
    project.description
      ? `Description: ${project.description}`
      : 'Description: (none)',
  ].join('\n');

  const tasksJson = JSON.stringify(
    tasks.map((t) => ({
      id: t.id,
      title: t.objective,
      rawPrompt: t.rawPrompt ?? t.prompt,
    })),
    null,
    2,
  );

  return [
    projectBlock,
    '',
    'Tasks to review (JSON):',
    tasksJson,
    '',
    'Return STRICT JSON per the system prompt.',
  ].join('\n');
}

export async function runSecurityStage(
  input: PipelineInput & { existingTasks: ActionTask[] },
): Promise<StageRunResult> {
  const tasks = input.existingTasks;
  const expectedIds = new Set(tasks.map((t) => t.id));

  const result = await runStage({
    stageName: 'security',
    workerName: 'codex-cli',
    systemPrompt: SECURITY_PROMPT,
    userPrompt: buildUserPrompt(tasks, input.project),
    validate: (parsed, rawOutput) =>
      validateSecurityOutput(parsed, expectedIds, rawOutput),
  });

  // Merge securityFlags into the existing tasks by id. Returns a new array.
  const patchById = new Map(result.parsed.map((p) => [p.id, p]));
  const merged = tasks.map((t) => {
    const patch = patchById.get(t.id);
    return patch ? { ...t, securityFlags: patch.securityFlags } : t;
  });

  return {
    stageName: 'security',
    tasks: merged,
    tokenUsage: result.tokenUsage,
    durationMs: result.durationMs,
    rawOutput: result.rawOutput,
  };
}
