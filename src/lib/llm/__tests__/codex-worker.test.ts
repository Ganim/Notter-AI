// src/lib/llm/__tests__/codex-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnCliMock = vi.fn();
vi.mock('@/lib/llm/spawn-helper', () => ({
  spawnCli: (...args: unknown[]) => spawnCliMock(...args),
}));

import { CodexWorker } from '@/lib/llm/codex-worker';
import { LLMWorkerError } from '@/lib/llm/types';

// Sanitized fixture from a real `codex exec "Say pong and nothing else"` run on 2026-04-09.
const REAL_STDERR = `Reading additional input from stdin...
OpenAI Codex v0.118.0 (research preview)
--------
workdir: /some/path
model: gpt-5.4
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: sanitized-uuid
--------
user
Say pong and nothing else
codex
pong
tokens used
21.848
`;

beforeEach(() => {
  spawnCliMock.mockReset();
});

describe('CodexWorker', () => {
  it('returns trimmed stdout as text and parses aggregate tokens', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: 'pong\n',
      stderr: REAL_STDERR,
      exitCode: 0,
      durationMs: 5000,
    });

    const worker = new CodexWorker();
    const res = await worker.run({ prompt: 'Say pong and nothing else' });

    expect(res.text).toBe('pong');
    expect(res.tokenUsage.worker).toBe('codex-cli');
    expect(res.tokenUsageReported).toBe(true);
    // Total parsed from "21.848" (pt-BR thousands) → 21848
    // outputTokens = min(ceil(4/4)=1, 21848) = 1
    // inputTokens = 21848 - 1 = 21847
    expect(res.tokenUsage.outputTokens).toBe(1);
    expect(res.tokenUsage.inputTokens).toBe(21847);
  });

  it('parses US-formatted thousands separator (21,848)', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: 'ok',
      stderr: 'codex\nok\ntokens used\n21,848\n',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new CodexWorker();
    const res = await worker.run({ prompt: 'hi' });
    expect(res.tokenUsageReported).toBe(true);
    expect(res.tokenUsage.inputTokens + res.tokenUsage.outputTokens).toBe(21848);
  });

  it('falls back to char-length estimation when stderr has no tokens line', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: 'hello world response',
      stderr: 'some unrelated banner',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new CodexWorker();
    const res = await worker.run({ prompt: 'prompt text' });
    expect(res.tokenUsageReported).toBe(false);
    expect(res.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(res.tokenUsage.outputTokens).toBeGreaterThan(0);
  });

  it('passes the correct args to spawnCli', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new CodexWorker();
    await worker.run({ prompt: 'build me a widget' });

    const callArgs = spawnCliMock.mock.calls[0][0];
    expect(callArgs.command).toBe('codex');
    expect(callArgs.args).toEqual(['exec', 'build me a widget']);
  });

  it('throws auth_expired on "not signed in" stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'Error: you are not signed in',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new CodexWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'auth_expired',
    });
  });

  it('throws rate_limited on quota stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'HTTP 429: quota exceeded',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new CodexWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('throws network on ENOTFOUND stderr', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'fetch: ENOTFOUND api.openai.com',
      exitCode: 1,
      durationMs: 50,
    });

    const worker = new CodexWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'network',
    });
  });

  it('throws unknown on an unrecognized non-zero exit', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: '',
      stderr: 'weird failure',
      exitCode: 2,
      durationMs: 50,
    });

    const worker = new CodexWorker();
    await expect(worker.run({ prompt: 'hi' })).rejects.toBeInstanceOf(LLMWorkerError);
  });

  it('sets worker to "codex-cli" in the response', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: 'x',
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    });

    const worker = new CodexWorker();
    const res = await worker.run({ prompt: 'q' });
    expect(res.tokenUsage.worker).toBe('codex-cli');
  });
});
