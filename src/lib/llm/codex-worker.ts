// src/lib/llm/codex-worker.ts
//
// Phase C: CodexWorker — invokes the Codex CLI and parses its response.
// Output format discovered via live CLI on 2026-04-09 (see spike/notes.md):
//   args:     codex exec "<prompt>"
//   stdout:   plain text answer (just the response, clean)
//   stderr:   banner + "tokens used\n<N>" line (N uses locale thousands separator)
//   errors:   non-zero exit; check stderr for auth/rate-limit keywords

import { spawnCli, isWindowsRuntime } from '@/lib/llm/spawn-helper';
import {
  LLMInput,
  LLMResponse,
  LLMWorker,
  LLMWorkerError,
} from '@/lib/llm/types';

const TOKENS_USED_REGEX = /tokens used\s*\n\s*([\d.,]+)/i;

export class CodexWorker implements LLMWorker {
  readonly name = 'codex-cli' as const;

  async run(input: LLMInput): Promise<LLMResponse> {
    // On Windows, use the stdin route (temp file + cmd.exe `<` redirect)
    // to dodge Rust's BatBadBut sanitizer. codex exec reads the prompt
    // from stdin when we pass the `-` sentinel as the positional arg.
    const useStdin = isWindowsRuntime();
    const args = useStdin ? ['exec', '-'] : ['exec', input.prompt];

    const result = await spawnCli({
      command: 'codex',
      args,
      stdin: useStdin ? input.prompt : undefined,
      // Default 300s: codex is fast (~8s on trivial prompts) but real
      // planning payloads on Windows have exceeded 120s. Bumping to 5
      // minutes gives generous headroom without hanging the UI.
      timeoutMs: input.timeoutMs ?? 300_000,
    });

    if (result.exitCode !== 0) {
      throw classifyCodexError(result.exitCode, result.stderr);
    }

    const text = result.stdout.trim();
    const { inputTokens, outputTokens, tokenUsageReported } = parseTokens(
      input.prompt,
      text,
      result.stderr,
    );

    return {
      text,
      tokenUsage: {
        worker: 'codex-cli',
        inputTokens,
        outputTokens,
        timestamp: Date.now(),
      },
      durationMs: result.durationMs,
      tokenUsageReported,
    };
  }
}

/**
 * Codex prints a single aggregate "tokens used" figure on stderr and does not
 * split input vs output. We parse the total (stripping locale separators),
 * estimate output from response length (~4 chars/token), and assign the
 * remainder to input. If the regex misses, fall back to full estimation.
 */
function parseTokens(
  prompt: string,
  response: string,
  stderr: string,
): { inputTokens: number; outputTokens: number; tokenUsageReported: boolean } {
  const match = stderr.match(TOKENS_USED_REGEX);
  const outputEstimate = Math.ceil(response.length / 4);

  if (match) {
    // Strip locale separators (pt-BR "21.848" → 21848, en-US "21,848" → 21848).
    const totalStr = match[1].replace(/[.,]/g, '');
    const total = parseInt(totalStr, 10);
    if (Number.isFinite(total) && total >= 0) {
      const outputTokens = Math.min(outputEstimate, total);
      const inputTokens = Math.max(0, total - outputTokens);
      return { inputTokens, outputTokens, tokenUsageReported: true };
    }
  }

  return {
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: outputEstimate,
    tokenUsageReported: false,
  };
}

function classifyCodexError(exitCode: number, stderr: string): LLMWorkerError {
  const text = stderr.toLowerCase();
  if (
    text.includes('not signed in') ||
    text.includes('please sign in') ||
    text.includes('login required') ||
    text.includes('not authenticated') ||
    text.includes('unauthorized')
  ) {
    return new LLMWorkerError({
      reason: 'auth_expired',
      cli: 'codex',
      message: 'Codex CLI authentication expired or missing',
      exitCode,
      stderr,
    });
  }
  if (
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('429') ||
    text.includes('too many requests')
  ) {
    return new LLMWorkerError({
      reason: 'rate_limited',
      cli: 'codex',
      message: 'Codex CLI rate limit / quota exceeded',
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
      cli: 'codex',
      message: 'Codex CLI network failure',
      exitCode,
      stderr,
    });
  }
  return new LLMWorkerError({
    reason: 'unknown',
    cli: 'codex',
    message: `Codex CLI exited with code ${exitCode}`,
    exitCode,
    stderr,
  });
}
