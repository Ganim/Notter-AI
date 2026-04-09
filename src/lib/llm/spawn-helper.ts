// src/lib/llm/spawn-helper.ts
//
// Phase C: shared helper to invoke a CLI through @tauri-apps/plugin-shell.
// All LLMWorker adapters use this helper instead of calling Command directly,
// so the timeout / stdin / error mapping logic exists in exactly one place.

import { Command } from '@tauri-apps/plugin-shell';
import { LLMWorkerError } from '@/lib/llm/types';

export interface SpawnCliInput {
  /** The CLI command name (must match a capability allowlist entry). */
  command: 'claude' | 'gemini' | 'codex';
  /** Args passed to the CLI. */
  args: string[];
  /** Optional stdin payload. If provided, written then closed before reading output. */
  stdin?: string;
  /** Timeout in milliseconds. Default 120_000. */
  timeoutMs?: number;
}

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Spawn a CLI via Tauri's shell plugin and return its output.
 *
 * Errors are thrown as LLMWorkerError with a typed reason. Specifically:
 * - `cli_not_found` when the CLI binary cannot be located by the OS
 * - `timeout` when the timeout fires before the process exits
 * - `unknown` for any other spawn-time failure (mapping to more specific
 *   reasons happens in the adapters that interpret the stderr)
 */
export async function spawnCli(input: SpawnCliInput): Promise<SpawnCliResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const cmd = Command.create(input.command, input.args);

  let stdout = '';
  let stderr = '';

  cmd.stdout.on('data', (line: string) => {
    stdout += line;
  });
  cmd.stderr.on('data', (line: string) => {
    stderr += line;
  });

  let child;
  try {
    child = await cmd.spawn();
  } catch (e: unknown) {
    const msg = String((e as { message?: string })?.message ?? e);
    const lower = msg.toLowerCase();
    if (
      lower.includes('not found') ||
      lower.includes('no such file') ||
      lower.includes('cannot find')
    ) {
      throw new LLMWorkerError({
        reason: 'cli_not_found',
        cli: input.command,
        message: `${input.command} not found on PATH`,
      });
    }
    throw new LLMWorkerError({
      reason: 'unknown',
      cli: input.command,
      message: `failed to spawn ${input.command}: ${msg}`,
    });
  }

  // Write stdin if provided. Wrapping in try/catch is critical because the
  // child can exit before stdin is consumed (auth failure, crash) — that path
  // throws EPIPE on the write call.
  if (input.stdin !== undefined) {
    try {
      await child.write(input.stdin + '\n');
    } catch {
      // Ignore — the 'close' event below will surface the real failure
      // through the exit code.
    }
  }

  // Wait for close OR timeout, whichever wins
  const exitCode = await new Promise<number>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill().catch(() => {});
      reject(
        new LLMWorkerError({
          reason: 'timeout',
          cli: input.command,
          message: `${input.command} timed out after ${timeoutMs}ms`,
          stderr,
        }),
      );
    }, timeoutMs);

    cmd.on('close', (data: { code: number | null; signal: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data.code ?? -1);
    });

    cmd.on('error', (err: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new LLMWorkerError({
          reason: 'unknown',
          cli: input.command,
          message: `${input.command} error event: ${err}`,
          stderr,
        }),
      );
    });
  });

  const durationMs = Date.now() - startedAt;
  return { stdout, stderr, exitCode, durationMs };
}
