// src/lib/planning/__tests__/stage-runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PipelineError } from '../types';
import { runStage, stripJsonNoise } from '../stage-runner';
import { LLMWorkerError } from '@/lib/llm';
import type { LLMResponse } from '@/lib/llm';

// ----- mock the worker factory -----

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
      run: vi.fn(() => runImpl()),
    })),
  };
});

function makeResponse(text: string): LLMResponse {
  return {
    text,
    tokenUsage: {
      worker: 'gemini-cli',
      inputTokens: 100,
      outputTokens: 50,
      timestamp: 1_700_000_000_000,
    },
    durationMs: 1234,
    tokenUsageReported: true,
  };
}

// ----- stripJsonNoise -----

describe('stripJsonNoise', () => {
  it('passes clean JSON through unchanged', () => {
    expect(stripJsonNoise('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(stripJsonNoise('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences', () => {
    expect(stripJsonNoise('```\n[1,2]\n```')).toBe('[1,2]');
  });

  it('drops a preamble before the first brace', () => {
    expect(stripJsonNoise('Here is the JSON:\n{"a":1}')).toBe('{"a":1}');
  });

  it('trims trailing noise after the last closing brace', () => {
    expect(stripJsonNoise('{"a":1}\n\nThat was it.')).toBe('{"a":1}');
  });
});

// ----- runStage -----

describe('runStage', () => {
  beforeEach(() => {
    runImpl = async () => makeResponse('{"tasks":[{"id":"t1"}]}');
  });

  it('returns parsed + tokenUsage + durationMs on success', async () => {
    const validate = vi.fn((parsed: unknown) => parsed);
    const out = await runStage({
      stageName: 'extract',
      workerName: 'gemini-cli',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      validate,
    });
    expect(out.parsed).toEqual({ tasks: [{ id: 't1' }] });
    expect(out.rawOutput).toBe('{"tasks":[{"id":"t1"}]}');
    expect(out.tokenUsage.inputTokens).toBe(100);
    expect(out.durationMs).toBe(1234);
    expect(validate).toHaveBeenCalledOnce();
  });

  it('strips code fences before parsing', async () => {
    runImpl = async () =>
      makeResponse('```json\n{"tasks":[{"id":"t1"}]}\n```');
    const out = await runStage({
      stageName: 'extract',
      workerName: 'gemini-cli',
      systemPrompt: 's',
      userPrompt: 'u',
      validate: (p) => p,
    });
    expect((out.parsed as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it('throws parse_error when JSON is malformed', async () => {
    runImpl = async () => makeResponse('not json at all');
    await expect(
      runStage({
        stageName: 'extract',
        workerName: 'gemini-cli',
        systemPrompt: 's',
        userPrompt: 'u',
        validate: (p) => p,
      }),
    ).rejects.toMatchObject({
      name: 'PipelineError',
      reason: 'parse_error',
      stage: 'extract',
    });
  });

  it('propagates schema_error from validator unchanged', async () => {
    runImpl = async () => makeResponse('{"ok":true}');
    const err = new PipelineError({
      stage: 'extract',
      reason: 'schema_error',
      message: 'missing tasks',
    });
    await expect(
      runStage({
        stageName: 'extract',
        workerName: 'gemini-cli',
        systemPrompt: 's',
        userPrompt: 'u',
        validate: () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });

  it('maps LLMWorkerError auth_expired to llm_error with re-login hint', async () => {
    runImpl = async () => {
      throw new LLMWorkerError({
        reason: 'auth_expired',
        cli: 'gemini',
        message: 'not logged in',
      });
    };
    try {
      await runStage({
        stageName: 'security',
        workerName: 'gemini-cli',
        systemPrompt: 's',
        userPrompt: 'u',
        validate: (p) => p,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineError);
      expect((e as PipelineError).reason).toBe('llm_error');
      expect((e as PipelineError).stage).toBe('security');
      expect((e as PipelineError).message).toMatch(/re-login/);
    }
  });

  it('maps LLMWorkerError rate_limited with retry hint', async () => {
    runImpl = async () => {
      throw new LLMWorkerError({
        reason: 'rate_limited',
        cli: 'gemini',
        message: 'slow down',
      });
    };
    await expect(
      runStage({
        stageName: 'extract',
        workerName: 'gemini-cli',
        systemPrompt: 's',
        userPrompt: 'u',
        validate: (p) => p,
      }),
    ).rejects.toMatchObject({
      reason: 'llm_error',
      message: expect.stringMatching(/rate limited/),
    });
  });

  it('maps LLMWorkerError parse_error to pipeline parse_error', async () => {
    runImpl = async () => {
      throw new LLMWorkerError({
        reason: 'parse_error',
        cli: 'gemini',
        message: 'adapter failed to parse',
        stderr: 'weird bytes',
      });
    };
    try {
      await runStage({
        stageName: 'extract',
        workerName: 'gemini-cli',
        systemPrompt: 's',
        userPrompt: 'u',
        validate: (p) => p,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineError);
      expect((e as PipelineError).reason).toBe('parse_error');
      expect((e as PipelineError).rawOutput).toBe('weird bytes');
    }
  });

  it('wraps unknown non-LLMWorkerError errors as llm_error', async () => {
    runImpl = async () => {
      throw new Error('boom');
    };
    await expect(
      runStage({
        stageName: 'extract',
        workerName: 'gemini-cli',
        systemPrompt: 's',
        userPrompt: 'u',
        validate: (p) => p,
      }),
    ).rejects.toMatchObject({
      reason: 'llm_error',
      message: expect.stringMatching(/unknown worker error/),
    });
  });
});
