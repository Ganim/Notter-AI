// src/lib/llm/__tests__/gemini-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnCliMock = vi.fn();
vi.mock('@/lib/llm/spawn-helper', () => ({
  spawnCli: (...args: unknown[]) => spawnCliMock(...args),
}));

import { GeminiWorker } from '@/lib/llm/gemini-worker';
import { LLMWorkerError } from '@/lib/llm/types';

// Real sanitized fixture captured from `gemini -p "Say pong" -o json` on 2026-04-09.
const VALID_RESPONSE = {
  session_id: 'sanitized-session-id',
  response: 'pong',
  stats: {
    models: {
      'gemini-2.5-flash-lite': {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 1383 },
        tokens: {
          input: 3038,
          prompt: 3038,
          candidates: 36,
          total: 3197,
          cached: 0,
          thoughts: 123,
          tool: 0,
        },
        roles: {
          utility_router: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 1383 },
        },
      },
      'gemini-3-flash-preview': {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 3034 },
        tokens: {
          input: 1316,
          prompt: 8143,
          candidates: 1,
          total: 8158,
          cached: 6827,
          thoughts: 14,
          tool: 0,
        },
        roles: {
          main: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 3034 },
        },
      },
    },
    tools: {},
    files: {},
  },
};

beforeEach(() => {
  spawnCliMock.mockReset();
});

describe('GeminiWorker', () => {
  it('returns the response text from stdout JSON', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify(VALID_RESPONSE),
      stderr: '',
      exitCode: 0,
      durationMs: 3500,
    });

    const worker = new GeminiWorker();
    const res = await worker.run({ prompt: 'Say pong' });

    expect(res.text).toBe('pong');
    expect(res.tokenUsage.worker).toBe('gemini-cli');
    expect(res.tokenUsageReported).toBe(true);
  });

  it('picks the model flagged as "main" for token accounting (not the utility router)', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify(VALID_RESPONSE),
      stderr: '',
      exitCode: 0,
      durationMs: 3500,
    });

    const worker = new GeminiWorker();
    const res = await worker.run({ prompt: 'Say pong' });

    // Main model tokens: prompt=8143, candidates=1, cached=6827
    expect(res.tokenUsage.inputTokens).toBe(8143);
    expect(res.tokenUsage.outputTokens).toBe(1);
    expect(res.tokenUsage.cacheReadTokens).toBe(6827);
    expect(res.tokenUsage.apiDurationMs).toBe(3034);
  });

  it('passes the correct args to spawnCli', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify(VALID_RESPONSE),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new GeminiWorker();
    await worker.run({ prompt: 'hello' });

    const callArgs = spawnCliMock.mock.calls[0][0];
    expect(callArgs.command).toBe('gemini');
    expect(callArgs.args).toEqual(['-p', 'hello', '-o', 'json']);
  });

  it('throws parse_error when stdout is not JSON', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: 'not json',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new GeminiWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'parse_error',
      cli: 'gemini',
    });
  });

  it('throws auth_expired on login-related stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'Error: please log in first',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new GeminiWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'auth_expired',
    });
  });

  it('throws rate_limited on quota stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'RESOURCE_EXHAUSTED: quota exceeded',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new GeminiWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('throws rate_limited on capacity stderr (real Gemini 429)', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'status 429: No capacity available for model gemini-3-flash-preview',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new GeminiWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('throws unknown on an unrecognized non-zero exit', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'something weird',
      exitCode: 2,
      durationMs: 50,
    });

    const worker = new GeminiWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toBeInstanceOf(LLMWorkerError);
  });

  it('sets tokenUsageReported=false and zeros when stats.models is empty', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify({ response: 'hi', stats: { models: {} } }),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new GeminiWorker();
    const res = await worker.run({ prompt: 'hi' });
    expect(res.text).toBe('hi');
    expect(res.tokenUsageReported).toBe(false);
    expect(res.tokenUsage.inputTokens).toBe(0);
    expect(res.tokenUsage.outputTokens).toBe(0);
  });

  it('handles missing response field gracefully', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify({ session_id: 'x' }),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new GeminiWorker();
    const res = await worker.run({ prompt: 'hi' });
    expect(res.text).toBe('');
  });
});
