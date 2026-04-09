// src/lib/llm/claude-code-worker.ts
//
// Phase C: ClaudeCodeWorker — invokes the Claude Code CLI in headless mode
// (`--print --output-format json --dangerously-skip-permissions`) and parses
// the structured JSON response. Token format was confirmed by the Phase A
// spike.

import { spawnCli } from '@/lib/llm/spawn-helper';
import {
  LLMInput,
  LLMResponse,
  LLMWorker,
  LLMWorkerError,
} from '@/lib/llm/types';

interface ClaudeCodeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeCodeJsonResponse {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  total_cost_usd?: number;
  usage?: ClaudeCodeUsage;
  modelUsage?: Record<string, unknown>;
}

export class ClaudeCodeWorker implements LLMWorker {
  readonly name = 'claude-code' as const;

  async run(input: LLMInput): Promise<LLMResponse> {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ];

    const fullPrompt = input.systemPrompt
      ? `${input.systemPrompt}\n\n${input.prompt}`
      : input.prompt;

    const result = await spawnCli({
      command: 'claude',
      args,
      stdin: fullPrompt,
      timeoutMs: input.timeoutMs ?? 120_000,
    });

    if (result.exitCode !== 0) {
      throw classifyClaudeError(result.exitCode, result.stderr, result.stdout);
    }

    let parsed: ClaudeCodeJsonResponse;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new LLMWorkerError({
        reason: 'parse_error',
        cli: 'claude',
        message: 'Claude Code did not return valid JSON',
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    if (parsed.is_error) {
      throw new LLMWorkerError({
        reason: 'unknown',
        cli: 'claude',
        message: `Claude Code reported is_error: ${parsed.subtype ?? 'unknown subtype'}`,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    const usage = parsed.usage ?? {};
    return {
      text: parsed.result ?? '',
      tokenUsage: {
        worker: 'claude-code',
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        costEstimate: parsed.total_cost_usd,
        apiDurationMs: parsed.duration_api_ms,
        timestamp: Date.now(),
      },
      durationMs: result.durationMs,
      tokenUsageReported: true,
    };
  }
}

function classifyClaudeError(
  exitCode: number,
  stderr: string,
  stdout: string,
): LLMWorkerError {
  const text = (stderr + ' ' + stdout).toLowerCase();
  if (
    text.includes('not authenticated') ||
    text.includes('please login') ||
    text.includes('login required')
  ) {
    return new LLMWorkerError({
      reason: 'auth_expired',
      cli: 'claude',
      message: 'Claude Code authentication expired or missing',
      exitCode,
      stderr,
    });
  }
  if (
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('too many requests')
  ) {
    return new LLMWorkerError({
      reason: 'rate_limited',
      cli: 'claude',
      message: 'Claude Code rate limit reached',
      exitCode,
      stderr,
    });
  }
  if (
    text.includes('network') ||
    text.includes('econnrefused') ||
    text.includes('enotfound')
  ) {
    return new LLMWorkerError({
      reason: 'network',
      cli: 'claude',
      message: 'Claude Code network failure',
      exitCode,
      stderr,
    });
  }
  return new LLMWorkerError({
    reason: 'unknown',
    cli: 'claude',
    message: `Claude Code exited with code ${exitCode}`,
    exitCode,
    stderr,
  });
}
