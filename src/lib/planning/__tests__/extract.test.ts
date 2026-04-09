// src/lib/planning/__tests__/extract.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runExtractStage } from '../stages/extract';
import { PipelineError } from '../types';
import type { LLMResponse } from '@/lib/llm';

// Capture what the mocked worker was called with so we can assert
// the user prompt included project + markdown context.
let lastRunInput: unknown = null;
let runImpl: () => Promise<LLMResponse> = async () => ({
  text: '{"tasks":[]}',
  tokenUsage: {
    worker: 'gemini-cli',
    inputTokens: 0,
    outputTokens: 0,
    timestamp: 0,
  },
  durationMs: 0,
  tokenUsageReported: false,
});

vi.mock('@/lib/llm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm')>('@/lib/llm');
  return {
    ...actual,
    getWorker: vi.fn(() => ({
      name: 'gemini-cli',
      run: vi.fn((input: unknown) => {
        lastRunInput = input;
        return runImpl();
      }),
    })),
  };
});

function okResponse(text: string): LLMResponse {
  return {
    text,
    tokenUsage: {
      worker: 'gemini-cli',
      inputTokens: 200,
      outputTokens: 80,
      timestamp: 1_700_000_000_000,
    },
    durationMs: 2345,
    tokenUsageReported: true,
  };
}

const baseInput = {
  actionId: 'a1',
  rawMarkdown: '# add dark mode\n- toggle in settings\n- persist choice',
  project: {
    name: 'notter',
    path: 'D:/proj/notter',
    description: 'note-taking app',
    topLevelEntries: ['src', 'package.json', 'README.md'],
  },
};

describe('runExtractStage', () => {
  beforeEach(() => {
    lastRunInput = null;
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            {
              id: 't1',
              title: 'Add dark mode toggle to settings',
              rawPrompt: 'In the settings panel, add a toggle...',
            },
            {
              id: 't2',
              title: 'Persist dark mode preference',
              rawPrompt: 'Save the selected mode to localStorage...',
            },
          ],
        }),
      );
  });

  it('returns an ActionTask[] with v1 + v2 fields populated', async () => {
    const out = await runExtractStage(baseInput);
    expect(out.stageName).toBe('extract');
    expect(out.tasks).toHaveLength(2);

    const t = out.tasks[0];
    expect(t.id).toBe('t1');
    expect(t.objective).toBe('Add dark mode toggle to settings');
    expect(t.rawPrompt).toBe('In the settings panel, add a toggle...');
    // v1 defaults
    expect(t.status).toBe('waiting');
    expect(t.agentId).toBe('');
    expect(t.returnText).toBe('');
    // prompt mirrors rawPrompt until prompt-critic runs
    expect(t.prompt).toBe(t.rawPrompt);
  });

  it('forwards tokenUsage and durationMs from the worker response', async () => {
    const out = await runExtractStage(baseInput);
    expect(out.tokenUsage.inputTokens).toBe(200);
    expect(out.tokenUsage.outputTokens).toBe(80);
    expect(out.durationMs).toBe(2345);
  });

  it('sends project context + markdown in the user prompt', async () => {
    await runExtractStage(baseInput);
    const call = lastRunInput as { prompt: string; systemPrompt: string };
    expect(call.prompt).toContain('notter');
    expect(call.prompt).toContain('D:/proj/notter');
    expect(call.prompt).toContain('note-taking app');
    expect(call.prompt).toContain('add dark mode');
    expect(call.prompt).toContain('src, package.json, README.md');
    expect(call.systemPrompt).toContain('task extractor');
  });

  it('greenfield detection: empty topLevelEntries surfaces GREENFIELD in prompt', async () => {
    await runExtractStage({
      ...baseInput,
      project: { ...baseInput.project, topLevelEntries: [] },
    });
    const call = lastRunInput as { prompt: string };
    expect(call.prompt).toContain('GREENFIELD');
  });

  it('handles missing description cleanly', async () => {
    await runExtractStage({
      ...baseInput,
      project: {
        name: 'x',
        path: 'y',
        topLevelEntries: ['src'],
      },
    });
    const call = lastRunInput as { prompt: string };
    expect(call.prompt).toContain('(none provided)');
  });

  it('throws PipelineError(schema_error) if validator rejects output', async () => {
    runImpl = async () => okResponse('{"tasks":[]}'); // zero tasks
    await expect(runExtractStage(baseInput)).rejects.toMatchObject({
      name: 'PipelineError',
      reason: 'schema_error',
      stage: 'extract',
    });
  });

  it('throws PipelineError(parse_error) on malformed JSON', async () => {
    runImpl = async () => okResponse('<<< not json >>>');
    await expect(runExtractStage(baseInput)).rejects.toBeInstanceOf(
      PipelineError,
    );
  });

  it('accepts a single task (>= 1 is the floor)', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [{ id: 'only', title: 'one task', rawPrompt: 'do it' }],
        }),
      );
    const out = await runExtractStage(baseInput);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].id).toBe('only');
  });
});
