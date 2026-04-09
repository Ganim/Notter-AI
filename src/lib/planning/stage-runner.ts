// src/lib/planning/stage-runner.ts
//
// Phase D: generic "run this stage" wrapper shared by all 4 stage modules.
// It knows how to invoke a worker, strip common LLM noise, parse JSON,
// delegate to a stage-specific validator, and map every error into a
// PipelineError keyed by the stageName.

import type { PlanStageName, TokenUsage } from '@/types/actions';
import { getWorker, LLMWorkerError, type WorkerName } from '@/lib/llm';
import { PipelineError } from './types';

export interface RunStageOptions<TParsed> {
  stageName: PlanStageName;
  workerName: WorkerName;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Stage-specific validator. Receives the already-parsed JSON and the
   * raw LLM output (passed on to PipelineError for debugging). Should
   * either return the narrowed shape or throw a PipelineError with
   * reason 'schema_error'.
   */
  validate: (parsed: unknown, rawOutput: string) => TParsed;
  /** Per-call timeout. Default 120000ms (matches LLMWorker default). */
  timeoutMs?: number;
}

export interface StageRunOutput<TParsed> {
  parsed: TParsed;
  rawOutput: string;
  tokenUsage: TokenUsage;
  durationMs: number;
}

/**
 * Strip the most common garbage that LLMs add around JSON bodies:
 *   - leading/trailing whitespace
 *   - markdown code fences (```json ... ``` or ``` ... ```)
 *   - single leading "Here is the JSON:" style preamble before the first {
 *
 * We deliberately do NOT attempt to fix malformed JSON — if the LLM drifts
 * past these simple patterns, we surface parse_error and let the caller
 * retry or fail loudly.
 */
export function stripJsonNoise(raw: string): string {
  let s = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }

  // If there is still a preamble before the first { or [, drop it.
  const firstBrace = s.search(/[\{\[]/);
  if (firstBrace > 0) {
    // Cheap sanity: only treat as preamble if the prefix contains a
    // newline or colon (i.e. looks like "Here is the JSON:\n{...}").
    const prefix = s.slice(0, firstBrace);
    if (/[\n:]/.test(prefix)) {
      s = s.slice(firstBrace);
    }
  }

  // Trim trailing junk after the last } or ].
  const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastBrace >= 0 && lastBrace < s.length - 1) {
    s = s.slice(0, lastBrace + 1);
  }

  return s;
}

function mapWorkerError(
  err: LLMWorkerError,
  stage: PlanStageName,
): PipelineError {
  // Keep the reason bucket small: anything coming from the worker layer
  // becomes llm_error, except parse_error (LLM returned non-text/broken
  // output the adapter itself flagged).
  if (err.reason === 'parse_error') {
    return new PipelineError({
      stage,
      reason: 'parse_error',
      message: `${stage} worker parse_error: ${err.message}`,
      rawOutput: err.stderr,
    });
  }

  const hint =
    err.reason === 'auth_expired'
      ? ' — re-login to the CLI is required'
      : err.reason === 'rate_limited'
        ? ' — rate limited, retry after a short wait'
        : err.reason === 'cli_not_found'
          ? ' — CLI binary not found on PATH'
          : err.reason === 'timeout'
            ? ' — timed out waiting for the CLI'
            : '';

  return new PipelineError({
    stage,
    reason: 'llm_error',
    message: `${stage} llm_error (${err.reason}): ${err.message}${hint}`,
    rawOutput: err.stderr,
  });
}

/**
 * Run one stage: invoke the worker, clean output, parse JSON, validate.
 * Returns the parsed result plus token accounting and timing.
 * Throws PipelineError on any failure.
 */
export async function runStage<TParsed>(
  opts: RunStageOptions<TParsed>,
): Promise<StageRunOutput<TParsed>> {
  const worker = getWorker(opts.workerName);

  let response;
  try {
    response = await worker.run({
      prompt: opts.userPrompt,
      systemPrompt: opts.systemPrompt,
      responseFormat: 'json',
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    if (err instanceof LLMWorkerError) {
      throw mapWorkerError(err, opts.stageName);
    }
    throw new PipelineError({
      stage: opts.stageName,
      reason: 'llm_error',
      message: `${opts.stageName} unknown worker error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const rawOutput = response.text;
  const cleaned = stripJsonNoise(rawOutput);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new PipelineError({
      stage: opts.stageName,
      reason: 'parse_error',
      message: `${opts.stageName} returned invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      rawOutput,
    });
  }

  // Validators throw PipelineError(schema_error) on their own.
  const validated = opts.validate(parsed, rawOutput);

  return {
    parsed: validated,
    rawOutput,
    tokenUsage: response.tokenUsage,
    durationMs: response.durationMs,
  };
}
