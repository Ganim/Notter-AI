// src/lib/planning/__tests__/data-consistency.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runDataStage } from '../stages/data-consistency';
import type { ActionTask } from '@/types/actions';
import type { LLMResponse } from '@/lib/llm';

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
      inputTokens: 120,
      outputTokens: 30,
      timestamp: 1_700_000_000_000,
    },
    durationMs: 2000,
    tokenUsageReported: true,
  };
}

function baseTask(id: string, title: string): ActionTask {
  return {
    id,
    objective: title,
    prompt: `raw prompt for ${id}`,
    rawPrompt: `raw prompt for ${id}`,
    agentId: '',
    modelTag: '',
    terminalId: '',
    status: 'waiting',
    returnText: '',
    securityFlags: id === 't1' ? ['sanitize filename'] : [],
  };
}

const baseInput = {
  actionId: 'a1',
  rawMarkdown: '# note',
  project: { name: 'p', path: 'D:/p' },
  existingTasks: [
    baseTask('t1', 'upload file'),
    baseTask('t2', 'migrate schema'),
  ],
};

describe('runDataStage', () => {
  beforeEach(() => {
    lastRunInput = null;
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', dataFlags: [] },
            {
              id: 't2',
              dataFlags: ['schema migration', 'backfill required'],
            },
          ],
        }),
      );
  });

  it('merges dataFlags into existing tasks', async () => {
    const out = await runDataStage(baseInput);
    expect(out.stageName).toBe('data_consistency');
    expect(out.tasks[0].dataFlags).toEqual([]);
    expect(out.tasks[1].dataFlags).toEqual([
      'schema migration',
      'backfill required',
    ]);
  });

  it('preserves previously-set securityFlags', async () => {
    const out = await runDataStage(baseInput);
    expect(out.tasks[0].securityFlags).toEqual(['sanitize filename']);
  });

  it('forwards securityFlags context into the user prompt', async () => {
    await runDataStage(baseInput);
    const call = lastRunInput as { prompt: string; systemPrompt: string };
    expect(call.prompt).toContain('sanitize filename');
    expect(call.systemPrompt).toContain('data-consistency flags');
  });

  it('throws schema_error on id mismatch', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', dataFlags: [] },
            { id: 'tBogus', dataFlags: [] },
          ],
        }),
      );
    await expect(runDataStage(baseInput)).rejects.toMatchObject({
      reason: 'schema_error',
      stage: 'data_consistency',
    });
  });

  it('throws parse_error on malformed JSON', async () => {
    runImpl = async () => okResponse('definitely not json');
    await expect(runDataStage(baseInput)).rejects.toMatchObject({
      reason: 'parse_error',
    });
  });

  it('does not mutate the input task array', async () => {
    const out = await runDataStage(baseInput);
    expect(out.tasks).not.toBe(baseInput.existingTasks);
    expect(baseInput.existingTasks[1].dataFlags).toBeUndefined();
  });
});
