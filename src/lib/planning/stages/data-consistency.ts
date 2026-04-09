// src/lib/planning/stages/data-consistency.ts
//
// Phase D — Stage 3 of 4: data consistency review.
// Same shape as security.ts but merges dataFlags via Gemini.

import type { ActionTask } from '@/types/actions';
import { runStage } from '../stage-runner';
import { validateDataOutput } from '../schemas';
import { DATA_CONSISTENCY_PROMPT } from '../prompts';
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
      securityFlags: t.securityFlags ?? [],
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

export async function runDataStage(
  input: PipelineInput & { existingTasks: ActionTask[] },
): Promise<StageRunResult> {
  const tasks = input.existingTasks;
  const expectedIds = new Set(tasks.map((t) => t.id));

  const result = await runStage({
    stageName: 'data_consistency',
    // Was gemini-cli → codex-cli → claude-code. See extract.ts and
    // security.ts for the full history — same reasons apply.
    workerName: 'claude-code',
    systemPrompt: DATA_CONSISTENCY_PROMPT,
    userPrompt: buildUserPrompt(tasks, input.project),
    validate: (parsed, rawOutput) =>
      validateDataOutput(parsed, expectedIds, rawOutput),
  });

  const patchById = new Map(result.parsed.map((p) => [p.id, p]));
  const merged = tasks.map((t) => {
    const patch = patchById.get(t.id);
    return patch ? { ...t, dataFlags: patch.dataFlags } : t;
  });

  return {
    stageName: 'data_consistency',
    tasks: merged,
    tokenUsage: result.tokenUsage,
    durationMs: result.durationMs,
    rawOutput: result.rawOutput,
  };
}
