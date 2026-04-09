// src/lib/llm/types.ts
//
// Phase C: shared types for the LLMWorker abstraction. The interface is
// minimal — one method, one input shape, one response shape, one error
// type — so each CLI adapter can implement it without leaking CLI specifics
// into the planning pipeline.

import type { TokenUsage } from '@/types/actions';

/**
 * The abstract interface every LLM adapter implements.
 *
 * Adapters MUST:
 * - Spawn the CLI via the shared spawn-helper (do not call Tauri Command directly)
 * - Pipe the prompt via stdin when the CLI supports it
 * - Map every error to an LLMWorkerError with a typed reason
 * - Populate TokenUsage with whatever the CLI exposes; use 0 for missing fields
 *
 * Adapters MUST NOT:
 * - Catch and swallow errors silently
 * - Persist anything to disk
 * - Mutate any shared state
 */
export interface LLMWorker {
  /** Stable identifier for logs and TokenUsage.worker. */
  readonly name: 'claude-code' | 'gemini-cli' | 'codex-cli';

  /**
   * Run the LLM with the given input. Returns a normalized LLMResponse on
   * success or throws LLMWorkerError on any failure.
   */
  run(input: LLMInput): Promise<LLMResponse>;
}

/**
 * Input to an LLM run. systemPrompt and modelHint are optional and may be
 * ignored by adapters whose CLIs don't expose those knobs.
 */
export interface LLMInput {
  /** The user prompt — required. */
  prompt: string;
  /** Optional system prompt; adapter may concatenate or pass through. */
  systemPrompt?: string;
  /** Optional model identifier; adapter chooses default if absent. */
  modelHint?: string;
  /**
   * Output format hint. 'json' tells the adapter to ask the CLI for JSON
   * output if supported. 'text' is the default.
   */
  responseFormat?: 'text' | 'json';
  /** Per-call timeout. Default 120000ms. */
  timeoutMs?: number;
}

/**
 * Successful LLM response. tokenUsage is always present even if the CLI did
 * not report tokens (in which case fields will be 0 and the adapter SHOULD
 * still set worker, timestamp, and durationMs).
 */
export interface LLMResponse {
  /** The raw text content the LLM returned. */
  text: string;
  /** Token accounting in the project's TokenUsage shape. */
  tokenUsage: TokenUsage;
  /** Wall-clock duration of the spawn including startup. */
  durationMs: number;
  /** Whether the CLI emitted token usage natively (false = adapter estimated). */
  tokenUsageReported: boolean;
}

/**
 * Typed error class for LLM failures. Use the static `from` factory to
 * convert raw errors / exit codes / stderr blobs into a typed error.
 */
export type LLMWorkerErrorReason =
  | 'cli_not_found'
  | 'auth_expired'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'parse_error'
  | 'unknown';

export class LLMWorkerError extends Error {
  readonly reason: LLMWorkerErrorReason;
  readonly cli: string;
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(opts: {
    reason: LLMWorkerErrorReason;
    cli: string;
    message: string;
    exitCode?: number;
    stderr?: string;
  }) {
    super(opts.message);
    this.name = 'LLMWorkerError';
    this.reason = opts.reason;
    this.cli = opts.cli;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}
