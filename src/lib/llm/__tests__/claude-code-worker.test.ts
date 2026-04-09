// src/lib/llm/__tests__/claude-code-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock spawn-helper so tests don't actually spawn anything
const spawnCliMock = vi.fn();
vi.mock('@/lib/llm/spawn-helper', () => ({
  spawnCli: (...args: unknown[]) => spawnCliMock(...args),
}));

import { ClaudeCodeWorker } from '@/lib/llm/claude-code-worker';
import { LLMWorkerError } from '@/lib/llm/types';

const VALID_RESPONSE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 38004,
  duration_api_ms: 1272,
  num_turns: 1,
  result: 'pong',
  total_cost_usd: 0.11500225,
  usage: {
    input_tokens: 5,
    cache_creation_input_tokens: 16895,
    cache_read_input_tokens: 18467,
    output_tokens: 6,
  },
  modelUsage: {
    'claude-opus-4-6[1m]': {
      inputTokens: 5,
      outputTokens: 6,
      cacheReadInputTokens: 18467,
      cacheCreationInputTokens: 16895,
      costUSD: 0.11500225,
    },
  },
};

beforeEach(() => {
  spawnCliMock.mockReset();
});

describe('ClaudeCodeWorker', () => {
  it('returns parsed text and rich token usage on a successful run', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify(VALID_RESPONSE),
      stderr: '',
      exitCode: 0,
      durationMs: 1500,
    });

    const worker = new ClaudeCodeWorker();
    const res = await worker.run({ prompt: 'hi' });

    expect(res.text).toBe('pong');
    expect(res.tokenUsage.worker).toBe('claude-code');
    expect(res.tokenUsage.inputTokens).toBe(5);
    expect(res.tokenUsage.outputTokens).toBe(6);
    expect(res.tokenUsage.cacheCreationTokens).toBe(16895);
    expect(res.tokenUsage.cacheReadTokens).toBe(18467);
    expect(res.tokenUsage.costEstimate).toBeCloseTo(0.115, 3);
    expect(res.tokenUsage.apiDurationMs).toBe(1272);
    expect(res.durationMs).toBe(1500);
    expect(res.tokenUsageReported).toBe(true);
  });

  it('passes the correct args to spawnCli', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify(VALID_RESPONSE),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new ClaudeCodeWorker();
    await worker.run({ prompt: 'test' });

    const callArgs = spawnCliMock.mock.calls[0][0];
    expect(callArgs.command).toBe('claude');
    expect(callArgs.args).toEqual([
      '--print',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      'test',
    ]);
    // Prompt is now passed as a positional arg, not stdin.
    expect(callArgs.stdin).toBeUndefined();
  });

  it('concatenates systemPrompt before prompt in the positional arg', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify(VALID_RESPONSE),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new ClaudeCodeWorker();
    await worker.run({ prompt: 'do it', systemPrompt: 'You are X.' });

    const callArgs = spawnCliMock.mock.calls[0][0];
    // Last arg is the combined prompt
    expect(callArgs.args[callArgs.args.length - 1]).toBe('You are X.\n\ndo it');
  });

  it('throws parse_error when stdout is not JSON', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: 'not json at all',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new ClaudeCodeWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'parse_error',
      cli: 'claude',
    });
  });

  it('throws auth_expired on a "please login" stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'Please login first',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new ClaudeCodeWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'auth_expired',
    });
  });

  it('throws rate_limited on a "rate limit" stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'Error: rate limit exceeded',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new ClaudeCodeWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('throws network on a "ENOTFOUND" stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'fetch failed: ENOTFOUND api.anthropic.com',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new ClaudeCodeWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'network',
    });
  });

  it('throws unknown on an unrecognized non-zero exit', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'something weird',
      exitCode: 2,
      durationMs: 50,
    });

    const worker = new ClaudeCodeWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toBeInstanceOf(LLMWorkerError);
  });

  it('throws when JSON has is_error=true', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify({ ...VALID_RESPONSE, is_error: true, subtype: 'something_failed' }),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new ClaudeCodeWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'unknown',
    });
  });

  it('handles missing usage fields by defaulting to 0', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new ClaudeCodeWorker();
    const res = await worker.run({ prompt: 'hi' });
    expect(res.tokenUsage.inputTokens).toBe(0);
    expect(res.tokenUsage.outputTokens).toBe(0);
    expect(res.text).toBe('ok');
  });
});
