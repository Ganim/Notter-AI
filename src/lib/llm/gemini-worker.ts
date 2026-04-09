// src/lib/llm/gemini-worker.ts
//
// Phase C: GeminiWorker — invokes the Gemini CLI and parses its response.
// Output format discovered via live CLI on 2026-04-09 (see spike/notes.md):
//   args:     gemini -p "<prompt>" -o json
//   stdout:   { session_id, response, stats: { models: {...} } }
//   tokens:   stats.models[<main>].tokens.{prompt, candidates, cached}
//   errors:   stdout contains no response on failure; check exit code + stderr

import { spawnCli } from '@/lib/llm/spawn-helper';
import {
  LLMInput,
  LLMResponse,
  LLMWorker,
  LLMWorkerError,
} from '@/lib/llm/types';

interface GeminiTokenBlock {
  input?: number;
  prompt?: number;
  candidates?: number;
  total?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
}

interface GeminiModelStats {
  tokens?: GeminiTokenBlock;
  roles?: Record<string, unknown>;
  api?: { totalLatencyMs?: number };
}

interface GeminiJsonResponse {
  session_id?: string;
  response?: string;
  stats?: {
    models?: Record<string, GeminiModelStats>;
  };
}

export class GeminiWorker implements LLMWorker {
  readonly name = 'gemini-cli' as const;

  async run(input: LLMInput): Promise<LLMResponse> {
    const args = ['-p', input.prompt, '-o', 'json'];

    const result = await spawnCli({
      command: 'gemini',
      args,
      timeoutMs: input.timeoutMs ?? 120_000,
    });

    if (result.exitCode !== 0) {
      throw classifyGeminiError(result.exitCode, result.stderr);
    }

    let parsed: GeminiJsonResponse;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new LLMWorkerError({
        reason: 'parse_error',
        cli: 'gemini',
        message: 'Gemini CLI did not return valid JSON',
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    const text = parsed.response ?? '';
    const mainModel = pickMainModel(parsed.stats?.models ?? {});
    const tokens = mainModel?.tokens ?? {};
    const tokenUsageReported = mainModel !== undefined;

    return {
      text,
      tokenUsage: {
        worker: 'gemini-cli',
        inputTokens: tokens.prompt ?? tokens.input ?? 0,
        outputTokens: tokens.candidates ?? 0,
        cacheReadTokens: tokens.cached,
        apiDurationMs: mainModel?.api?.totalLatencyMs,
        timestamp: Date.now(),
      },
      durationMs: result.durationMs,
      tokenUsageReported,
    };
  }
}

/**
 * Select the model that served the main response.
 * Gemini reports stats for every model it touched (including utility routers
 * that run short classification prompts). The primary model is the one whose
 * `roles` map includes a `main` entry. Fall back to the first model if none
 * is explicitly marked.
 */
function pickMainModel(
  models: Record<string, GeminiModelStats>,
): GeminiModelStats | undefined {
  const entries = Object.values(models);
  if (entries.length === 0) return undefined;
  const main = entries.find((m) => m.roles && 'main' in m.roles);
  return main ?? entries[0];
}

function classifyGeminiError(exitCode: number, stderr: string): LLMWorkerError {
  const text = stderr.toLowerCase();
  if (
    text.includes('not authenticated') ||
    text.includes('please log in') ||
    text.includes('expired') ||
    text.includes('login required')
  ) {
    return new LLMWorkerError({
      reason: 'auth_expired',
      cli: 'gemini',
      message: 'Gemini CLI authentication expired or missing',
      exitCode,
      stderr,
    });
  }
  if (
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('429') ||
    text.includes('resource_exhausted') ||
    text.includes('capacity')
  ) {
    return new LLMWorkerError({
      reason: 'rate_limited',
      cli: 'gemini',
      message: 'Gemini CLI rate limit / quota exceeded',
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
      cli: 'gemini',
      message: 'Gemini CLI network failure',
      exitCode,
      stderr,
    });
  }
  return new LLMWorkerError({
    reason: 'unknown',
    cli: 'gemini',
    message: `Gemini CLI exited with code ${exitCode}`,
    exitCode,
    stderr,
  });
}
