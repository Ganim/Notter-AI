// src/lib/planning/__tests__/security.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runSecurityStage } from '../stages/security';
import type { ActionTask } from '@/types/actions';
import type { LLMResponse } from '@/lib/llm';

let lastRunInput: unknown = null;
let runImpl: () => Promise<LLMResponse> = async () => ({
  text: '{"tasks":[]}',
  tokenUsage: {
    worker: 'codex-cli',
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
      name: 'codex-cli',
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
      worker: 'codex-cli',
      inputTokens: 150,
      outputTokens: 40,
      timestamp: 1_700_000_000_000,
    },
    durationMs: 4567,
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
  };
}

const baseInput = {
  actionId: 'a1',
  rawMarkdown: '# note',
  project: { name: 'p', path: 'D:/p' },
  existingTasks: [baseTask('t1', 'upload file'), baseTask('t2', 'show list')],
};

describe('runSecurityStage', () => {
  beforeEach(() => {
    lastRunInput = null;
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', securityFlags: ['sanitize filename', 'check mime'] },
            { id: 't2', securityFlags: [] },
          ],
        }),
      );
  });

  it('merges securityFlags into existing tasks without altering other fields', async () => {
    const out = await runSecurityStage(baseInput);
    expect(out.stageName).toBe('security');
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks[0].securityFlags).toEqual([
      'sanitize filename',
      'check mime',
    ]);
    expect(out.tasks[1].securityFlags).toEqual([]);
    // untouched fields
    expect(out.tasks[0].objective).toBe('upload file');
    expect(out.tasks[0].rawPrompt).toBe('raw prompt for t1');
  });

  it('uses codex-cli worker and SECURITY_PROMPT', async () => {
    await runSecurityStage(baseInput);
    const call = lastRunInput as { systemPrompt: string; prompt: string };
    expect(call.systemPrompt).toContain('security reviewer');
    expect(call.prompt).toContain('upload file');
    expect(call.prompt).toContain('raw prompt for t1');
  });

  it('forwards tokenUsage from the worker', async () => {
    const out = await runSecurityStage(baseInput);
    expect(out.tokenUsage.worker).toBe('codex-cli');
    expect(out.tokenUsage.inputTokens).toBe(150);
  });

  it('throws schema_error when LLM adds an unknown task id', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', securityFlags: [] },
            { id: 'tEvil', securityFlags: ['xss'] },
          ],
        }),
      );
    await expect(runSecurityStage(baseInput)).rejects.toMatchObject({
      name: 'PipelineError',
      reason: 'schema_error',
      stage: 'security',
    });
  });

  it('throws when LLM removes a task', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [{ id: 't1', securityFlags: [] }],
        }),
      );
    await expect(runSecurityStage(baseInput)).rejects.toMatchObject({
      reason: 'schema_error',
    });
  });

  it('returns a NEW array (does not mutate input tasks)', async () => {
    const out = await runSecurityStage(baseInput);
    expect(out.tasks).not.toBe(baseInput.existingTasks);
    expect(baseInput.existingTasks[0].securityFlags).toBeUndefined();
  });
});
