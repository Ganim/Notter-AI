// src/lib/planning/stages/extract.ts
//
// Phase D — Stage 1 of 4: extract.
// Input:  a raw Markdown planning note.
// Output: an ActionTask[] with id, objective (= title), rawPrompt, and
//         the v1 required fields filled with safe defaults so the
//         existing v1 UI keeps rendering.
//
// The stage never mutates existing tasks — if existingTasks is present
// it is ignored (extract generates a fresh task set from the note).

import type { ActionTask } from '@/types/actions';
import { runStage } from '../stage-runner';
import { validateExtractOutput, type ExtractedTask } from '../schemas';
import { EXTRACT_PROMPT } from '../prompts';
import type { PipelineInput, StageRunResult, ProjectContext } from '../types';

function buildUserPrompt(
  rawMarkdown: string,
  project: ProjectContext,
): string {
  const greenfieldLine =
    (project.topLevelEntries?.length ?? 0) === 0
      ? 'Project state: GREENFIELD (no top-level files detected).'
      : `Project state: contains ${project.topLevelEntries!.length} top-level entries (${project.topLevelEntries!.slice(0, 10).join(', ')}${
          project.topLevelEntries!.length > 10 ? ', ...' : ''
        }).`;

  const descLine = project.description
    ? `Project description: ${project.description}`
    : 'Project description: (none provided)';

  return [
    `Project: ${project.name}`,
    `Path: ${project.path}`,
    descLine,
    greenfieldLine,
    '',
    'Raw planning note (Markdown):',
    '---',
    rawMarkdown.trim(),
    '---',
    '',
    'Return STRICT JSON per the system prompt.',
  ].join('\n');
}

function toActionTask(extracted: ExtractedTask): ActionTask {
  return {
    // v1 required fields — safe defaults so the v1 UI keeps rendering
    id: extracted.id,
    objective: extracted.title,
    prompt: extracted.rawPrompt, // will be overwritten by prompt-critic stage
    agentId: '',
    modelTag: '',
    terminalId: '',
    status: 'waiting',
    returnText: '',

    // v2 fields — start populated with what extract produced
    rawPrompt: extracted.rawPrompt,
  };
}

/**
 * Run the extract stage. Returns a StageRunResult whose `tasks` is a
 * freshly-generated ActionTask[] snapshot.
 */
export async function runExtractStage(
  input: PipelineInput,
): Promise<StageRunResult> {
  const userPrompt = buildUserPrompt(input.rawMarkdown, input.project);

  const result = await runStage({
    stageName: 'extract',
    workerName: 'gemini-cli',
    systemPrompt: EXTRACT_PROMPT,
    userPrompt,
    validate: (parsed, rawOutput) => validateExtractOutput(parsed, rawOutput),
  });

  const tasks = result.parsed.map(toActionTask);

  return {
    stageName: 'extract',
    tasks,
    tokenUsage: result.tokenUsage,
    durationMs: result.durationMs,
    rawOutput: result.rawOutput,
  };
}
