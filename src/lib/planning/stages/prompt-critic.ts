// src/lib/planning/stages/prompt-critic.ts
//
// Phase D — Stage 4 of 4: prompt critic.
// Input:  ActionTask[] with securityFlags and dataFlags populated.
// Output: the same array with refinedPrompt, trustLevel, and the v1
//         `prompt` mirror set so existing execution code keeps working.
//
// Applies enforceTrustFloor: if the classifier said `auto` but the task
// has any security/data flags, bump it up to `semi`. Trust only
// escalates — never de-escalates — protecting against LLM overconfidence.

import type { ActionTask } from '@/types/actions';
import { runStage } from '../stage-runner';
import { validatePromptCriticOutput } from '../schemas';
import { PROMPT_CRITIC_PROMPT } from '../prompts';
import {
  enforceTrustFloor,
  type PipelineInput,
  type StageRunResult,
  type ProjectContext,
} from '../types';

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
      dataFlags: t.dataFlags ?? [],
    })),
    null,
    2,
  );

  return [
    projectBlock,
    '',
    'Tasks to refine (JSON):',
    tasksJson,
    '',
    'Return STRICT JSON per the system prompt.',
  ].join('\n');
}

export async function runPromptCriticStage(
  input: PipelineInput & { existingTasks: ActionTask[] },
): Promise<StageRunResult> {
  const tasks = input.existingTasks;
  const expectedIds = new Set(tasks.map((t) => t.id));

  const result = await runStage({
    stageName: 'prompt_critic',
    workerName: 'claude-code',
    systemPrompt: PROMPT_CRITIC_PROMPT,
    userPrompt: buildUserPrompt(tasks, input.project),
    validate: (parsed, rawOutput) =>
      validatePromptCriticOutput(parsed, expectedIds, rawOutput),
  });

  const patchById = new Map(result.parsed.map((p) => [p.id, p]));
  const merged = tasks.map((t) => {
    const patch = patchById.get(t.id);
    if (!patch) return t;

    // Merge first, THEN enforce the trust floor so enforceTrustFloor
    // can see the flags that were already set by earlier stages.
    const withPatch: ActionTask = {
      ...t,
      refinedPrompt: patch.refinedPrompt,
      trustLevel: patch.trustLevel,
      // v1 mirror — the existing execution code reads `prompt`
      prompt: patch.refinedPrompt,
    };
    const enforced = enforceTrustFloor(withPatch, patch.trustLevel);
    return enforced === withPatch.trustLevel
      ? withPatch
      : { ...withPatch, trustLevel: enforced };
  });

  return {
    stageName: 'prompt_critic',
    tasks: merged,
    tokenUsage: result.tokenUsage,
    durationMs: result.durationMs,
    rawOutput: result.rawOutput,
  };
}
