// src/lib/llm/spawn-helper.ts
//
// Phase C: shared helper to invoke a CLI through @tauri-apps/plugin-shell.
// All LLMWorker adapters use this helper instead of calling Command directly,
// so the timeout / error mapping logic exists in exactly one place.
//
// Implementation notes:
// - Uses `Command.execute()` (one-shot wait) instead of `spawn()` + events.
//   The Rust side of `execute()` closes the stdin pipe as soon as the child
//   is spawned, which is critical: otherwise CLIs like `codex exec` detect
//   a piped-but-open stdin and block forever waiting for EOF. With `execute()`
//   the pipe closes immediately and codex proceeds.
// - The timeout is enforced in JS via Promise.race, because `execute()` does
//   not accept a timeout. On timeout we throw LLMWorkerError; the child may
//   still be running briefly (no kill API after execute started), but the
//   promise resolves so the caller unblocks.
// - stdin piping is intentionally NOT supported. All adapters must pass the
//   prompt as a positional CLI argument. This is because Tauri's shell plugin
//   offers no stdin close API with `spawn()`, and `execute()` doesn't expose
//   stdin at all. Passing prompts as args is also simpler and works for all
//   three CLIs (claude, gemini, codex).

import { Command } from '@tauri-apps/plugin-shell';
import { LLMWorkerError } from '@/lib/llm/types';

export interface SpawnCliInput {
  /** The CLI command name (must match a capability allowlist entry). */
  command: 'claude' | 'gemini' | 'codex';
  /** Args passed to the CLI. */
  args: string[];
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
 * Resolve the platform-specific executable name for a CLI.
 *
 * On Windows, `gemini` and `codex` are installed as npm shims:
 *   - `gemini`       (bash script, no extension — NOT executable by CreateProcess)
 *   - `gemini.cmd`   (Windows cmd wrapper — this is what we need)
 *   - `gemini.ps1`   (PowerShell wrapper)
 *
 * Rust's `Command::new` (which Tauri's shell plugin wraps) does NOT perform
 * `PATHEXT` resolution the way `cmd.exe` does, so passing bare `gemini` fails
 * with "not found". We must pass `gemini.cmd` explicitly on Windows.
 *
 * `claude` ships as `claude.exe`, a real PE executable, so no .cmd shim is
 * needed — Windows finds it directly.
 */
function resolveProgramName(command: 'claude' | 'gemini' | 'codex'): string {
  const isWindows =
    typeof navigator !== 'undefined' &&
    /win/i.test(navigator.platform ?? navigator.userAgent ?? '');
  if (!isWindows) return command;
  if (command === 'claude') return 'claude';
  return `${command}.cmd`;
}

/**
 * Run a CLI via Tauri's shell plugin and return its output.
 *
 * Errors are thrown as LLMWorkerError with a typed reason:
 * - `cli_not_found` when the CLI binary cannot be located by the OS
 * - `timeout` when the timeout fires before the process exits
 * - `unknown` for any other spawn-time failure
 */
export async function spawnCli(input: SpawnCliInput): Promise<SpawnCliResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const programName = resolveProgramName(input.command);
  const cmd = Command.create(programName, input.args);

  const executePromise = cmd.execute().then((output) => ({
    stdout: typeof output.stdout === 'string' ? output.stdout : '',
    stderr: typeof output.stderr === 'string' ? output.stderr : '',
    exitCode: output.code ?? -1,
    durationMs: Date.now() - startedAt,
  }));

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new LLMWorkerError({
          reason: 'timeout',
          cli: input.command,
          message: `${input.command} timed out after ${timeoutMs}ms`,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([executePromise, timeoutPromise]);
  } catch (e: unknown) {
    if (e instanceof LLMWorkerError) throw e;
    const msg = String((e as { message?: string })?.message ?? e);
    const lower = msg.toLowerCase();
    if (
      lower.includes('not found') ||
      lower.includes('no such file') ||
      lower.includes('cannot find') ||
      lower.includes("program not allowed")
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
      message: `failed to run ${input.command}: ${msg}`,
    });
  }
}
