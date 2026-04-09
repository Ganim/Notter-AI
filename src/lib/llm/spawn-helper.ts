// src/lib/llm/spawn-helper.ts
//
// Phase C: shared helper to invoke a CLI through @tauri-apps/plugin-shell.
// All LLMWorker adapters use this helper instead of calling Command directly,
// so the timeout / error mapping logic exists in exactly one place.
//
// Phase D fix (2026-04-09 — "BatBadBut" workaround):
// ----------------------------------------------------
// Rust's std::process::Command (which Tauri's shell plugin wraps) applies
// the CVE-2024-24576 mitigation on Windows: spawning a .cmd/.bat file with
// any arg containing shell metacharacters (\n, ", <, >, |, &, etc.) is
// rejected with "batch file arguments are invalid". Phase D's planning
// prompts are multi-line Markdown, which trips this immediately for
// gemini.cmd and codex.cmd. Phase C's spike only tested with trivial
// single-word prompts so it didn't surface.
//
// The fix: on Windows, when the caller provides `stdin`, we write it to a
// temp file under $APPLOCALDATA and spawn `powershell.exe` (a real .exe —
// no sanitizer) running a one-liner that pipes the file into the CLI:
//
//   Get-Content -Raw -LiteralPath '<path>' | & '<cli.cmd>' <args>
//
// PowerShell 5.1 (the built-in Windows PowerShell) does NOT apply the same
// mitigation when calling a .cmd file via the & operator, so metacharacters
// in the piped stdin stream pass through untouched. The `args` we pass
// through PS are kept free of metacharacters by the worker adapters — only
// flags like `-p ' '` / `exec -` / `-o json`.
//
// On non-Windows platforms `stdin` is ignored and the worker must embed the
// prompt in `args` as before (Unix has no .cmd sanitizer problem). Today
// AgentTrack is a Windows-first Tauri app so this path is theoretical, but
// we keep the fallback so tests running under vitest (jsdom/node, NOT
// "Win32") exercise the legacy path.

import { Command } from '@tauri-apps/plugin-shell';
import {
  writeTextFile,
  readFile,
  mkdir,
  remove,
  exists,
} from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { LLMWorkerError } from '@/lib/llm/types';

export interface SpawnCliInput {
  /** The CLI command name (must match a capability allowlist entry). */
  command: 'claude' | 'gemini' | 'codex';
  /** Args passed to the CLI — flags only, NO long/risky user content. */
  args: string[];
  /**
   * Optional long-form text to deliver to the CLI's stdin. On Windows this
   * is written to a temp file and piped via PowerShell, bypassing Rust's
   * .cmd arg sanitizer. On non-Windows this field is ignored.
   */
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
const TMP_PROMPTS_SUBDIR = 'tmp-prompts';

/** Runtime Windows check. Uses navigator (WebView2 on Windows reports Win32). */
export function isWindowsRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  const raw =
    (navigator as { platform?: string }).platform ??
    (navigator as { userAgent?: string }).userAgent ??
    '';
  return /win/i.test(raw);
}

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
export function resolveProgramName(
  command: 'claude' | 'gemini' | 'codex',
): string {
  if (!isWindowsRuntime()) return command;
  if (command === 'claude') return 'claude';
  return `${command}.cmd`;
}

/**
 * Escape a string for embedding inside a PowerShell single-quoted literal.
 * PowerShell's single-quote rule is simple: every `'` becomes `''`; nothing
 * else needs escaping.
 *
 * Kept for test compatibility — the active Windows stdin route now uses
 * cmd.exe `<` redirect instead of a PowerShell pipeline (see
 * buildCmdStdinRedirect), but psSingleQuote is still exercised by unit
 * tests as a guard in case we ever need to fall back.
 */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the cmd.exe /S /C command string that runs the CLI with its
 * stdin redirected from a temp file. Exported for unit tests.
 *
 * Why cmd.exe and not PowerShell: `Get-Content -Raw | & native.exe` in
 * PowerShell 5.1 does not reliably flush/close the child's stdin handle,
 * and codex-cli (at least) hangs waiting for EOF that never arrives.
 * cmd.exe's `<` operator opens the file as a real Win32 stdin handle,
 * so EOF comes naturally when the file is fully consumed.
 *
 * Quoting: cmd.exe quoting is fragile. We require that all inputs (the
 * temp path, cli executable name, and each arg) contain NO spaces and NO
 * cmd.exe special characters (`&`, `|`, `<`, `>`, `(`, `)`, `^`, `%`,
 * `!`, `"`, newline). The caller must verify this before calling.
 * Normal AppLocalData paths under a typical Windows install are safe;
 * if the username contains spaces, we'd need a GetShortPathName helper.
 */
export function buildCmdStdinRedirect(opts: {
  tempPath: string;
  stdoutPath: string;
  cliExecutable: string;
  cliArgs: string[];
}): string {
  const argsJoined =
    opts.cliArgs.length > 0 ? ` ${opts.cliArgs.join(' ')}` : '';
  // Design: route EVERYTHING through temp files so Tauri's strict UTF-8
  // decoder in Command.execute() never sees any CLI bytes at all.
  //
  // - `chcp 65001 >nul && ...` sets the console code page to UTF-8
  //   (defense in depth; harmless for piped stdio which bypasses console
  //   re-encoding anyway)
  // - `< ${tempPath}` delivers the prompt to the CLI's stdin via a real
  //   Win32 file handle so the CLI sees EOF naturally
  // - `> ${stdoutPath}` captures the CLI's stdout into a temp file that
  //   we then read ourselves with a lossy UTF-8 TextDecoder, so any
  //   stray byte in the CLI's output (codex-cli has been observed to
  //   emit raw CP1252 bytes in some installs) gets replaced with U+FFFD
  //   instead of failing the whole call
  // - `2>nul` discards stderr entirely — we can't read it without
  //   another temp file, and the only caller that cares about stderr
  //   contents today is CodexWorker's token parser, which degrades
  //   gracefully to 0 tokens when stderr is empty.
  return `chcp 65001 >nul && ${opts.cliExecutable}${argsJoined} < ${opts.tempPath} > ${opts.stdoutPath} 2>nul`;
}

/** Tokens cmd.exe treats specially when parsing a /C command line. */
const CMD_FORBIDDEN_CHARS = /[\s&|<>()^%!"\r\n]/;

export function assertCmdSafe(value: string, label: string): void {
  if (CMD_FORBIDDEN_CHARS.test(value)) {
    throw new LLMWorkerError({
      reason: 'unknown',
      cli: 'cmd',
      message: `${label} contains characters unsafe for cmd.exe: ${JSON.stringify(value)}`,
    });
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function ensureTmpPromptsDir(): Promise<string> {
  // appLocalDataDir() has platform-dependent trailing-separator behavior —
  // string concatenation placed the temp dir OUTSIDE the $APPLOCALDATA
  // scope on Windows (`com.guilh.notterai` + `tmp-prompts` became the
  // sibling `com.guilh.notteraitmp-prompts`). Use Tauri's `join` so the
  // separator is always correct, and the final path stays inside the
  // fs:scope granted by the capability file.
  const dir = await appLocalDataDir();
  const subdir = await join(dir, TMP_PROMPTS_SUBDIR);
  try {
    if (!(await exists(subdir))) {
      await mkdir(subdir, { recursive: true });
    }
  } catch {
    // Non-fatal; writeTextFile will surface the real error if the dir is
    // actually missing.
  }
  return subdir;
}

async function writePromptTempFile(stdin: string): Promise<string> {
  const subdir = await ensureTmpPromptsDir();
  const path = await join(subdir, `prompt-${randomId()}.txt`);
  await writeTextFile(path, stdin);
  return path;
}

async function reserveStdoutTempFile(): Promise<string> {
  const subdir = await ensureTmpPromptsDir();
  return join(subdir, `stdout-${randomId()}.txt`);
}

/**
 * Read a file as bytes and decode with a lossy TextDecoder so invalid
 * UTF-8 sequences are replaced with U+FFFD instead of throwing. Returns
 * an empty string if the file doesn't exist (the CLI may have failed
 * before writing anything).
 */
async function readLossyUtf8File(path: string): Promise<string> {
  try {
    if (!(await exists(path))) return '';
    const bytes = await readFile(path);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(bytes);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[spawn-helper] failed to read stdout temp file', path, e);
    return '';
  }
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await remove(path);
  } catch (e) {
    // Non-fatal — leave it for the next app cleanup. Log so we notice if
    // it becomes a pattern.
    // eslint-disable-next-line no-console
    console.warn('[spawn-helper] failed to delete temp prompt file', path, e);
  }
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

  // Decide routing. If stdin is provided and we're on Windows, wrap the
  // call in a PowerShell pipeline reading from a temp file. Otherwise fall
  // back to the legacy direct-spawn path (Unix, or Windows without stdin).
  const useWindowsStdinRoute =
    input.stdin !== undefined && isWindowsRuntime();

  let programName: string;
  let programArgs: string[];
  let tempPath: string | null = null;
  let stdoutPath: string | null = null;

  if (useWindowsStdinRoute) {
    tempPath = await writePromptTempFile(input.stdin!);
    stdoutPath = await reserveStdoutTempFile();
    const cliExecutable = resolveProgramName(input.command);

    // cmd.exe quoting is fragile — assert all paths/exe/args are free of
    // characters cmd treats specially. For the normal happy path
    // (AppLocalData under a space-free username) this passes silently;
    // if it trips we get a clear LLMWorkerError.
    assertCmdSafe(tempPath, 'temp prompt path');
    assertCmdSafe(stdoutPath, 'temp stdout path');
    assertCmdSafe(cliExecutable, 'CLI executable');
    for (const a of input.args) {
      assertCmdSafe(a, 'CLI arg');
    }

    const innerCmd = buildCmdStdinRedirect({
      tempPath,
      stdoutPath,
      cliExecutable,
      cliArgs: input.args,
    });
    programName = 'cmd.exe';
    // Pass the inner command as a SINGLE arg WITHOUT our own quote
    // wrapping. Rust's std::process::Command auto-wraps args containing
    // spaces in `"..."` when building the Windows CreateProcessW command
    // line, and cmd.exe /S strips those outer quotes. If we pre-wrap,
    // Rust escapes our quotes as \" and cmd.exe parses the literal \"
    // as a broken-quoted token, failing with "A sintaxe do comando está
    // incorreta" (a CP850-encoded error whose 0xA0 byte from 'á' was
    // the root of the "invalid utf-8" we kept seeing).
    programArgs = ['/S', '/C', innerCmd];
  } else {
    programName = resolveProgramName(input.command);
    programArgs = input.args;
  }

  // Diagnostic logging — helps the user diagnose future spawn issues
  // without a rebuild. Safe to leave in: it runs once per CLI call and
  // writes only metadata, never the prompt content.
  // eslint-disable-next-line no-console
  console.log('[spawn-helper] exec', {
    programName,
    programArgs,
    useWindowsStdinRoute,
    tempPath,
    stdoutPath,
    promptLen: input.stdin?.length ?? 0,
    timeoutMs,
  });

  const cmd = Command.create(programName, programArgs);

  // When the Windows stdin route is active, cmd.exe's stdout is empty
  // (everything was redirected to stdoutPath) and stderr is empty
  // (2>nul). So Tauri's strict UTF-8 decoder has nothing to choke on.
  // We read the real stdout from the temp file ourselves after execute()
  // resolves, using a lossy TextDecoder that replaces invalid bytes
  // with U+FFFD.
  const executePromise = cmd.execute().then(async (output) => {
    const exitCode = output.code ?? -1;
    const durationMs = Date.now() - startedAt;
    // Log the raw execute() result so we can see cmd.exe's own
    // stdout/stderr when things go wrong (useful for diagnosing cmd.exe
    // parse errors vs real CLI errors).
    // eslint-disable-next-line no-console
    console.log('[spawn-helper] execute resolved', {
      exitCode,
      durationMs,
      rawStdoutLen:
        typeof output.stdout === 'string' ? output.stdout.length : -1,
      rawStderrLen:
        typeof output.stderr === 'string' ? output.stderr.length : -1,
      rawStdoutHead:
        typeof output.stdout === 'string'
          ? output.stdout.slice(0, 200)
          : null,
      rawStderrHead:
        typeof output.stderr === 'string'
          ? output.stderr.slice(0, 200)
          : null,
    });
    if (useWindowsStdinRoute && stdoutPath) {
      const stdoutText = await readLossyUtf8File(stdoutPath);
      // eslint-disable-next-line no-console
      console.log('[spawn-helper] stdout file read', {
        stdoutPath,
        stdoutLen: stdoutText.length,
        stdoutHead: stdoutText.slice(0, 300),
      });
      return {
        stdout: stdoutText,
        stderr: '', // discarded via 2>nul
        exitCode,
        durationMs,
      };
    }
    return {
      stdout: typeof output.stdout === 'string' ? output.stdout : '',
      stderr: typeof output.stderr === 'string' ? output.stderr : '',
      exitCode,
      durationMs,
    };
  });

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
    // eslint-disable-next-line no-console
    console.error('[spawn-helper] execute rejected', {
      command: input.command,
      error: e,
      errorMessage: (e as { message?: string })?.message,
    });
    if (e instanceof LLMWorkerError) throw e;
    const msg = String((e as { message?: string })?.message ?? e);
    const lower = msg.toLowerCase();
    if (
      lower.includes('not found') ||
      lower.includes('no such file') ||
      lower.includes('cannot find') ||
      lower.includes('program not allowed')
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
  } finally {
    if (tempPath) {
      void removeTempFile(tempPath);
    }
    if (stdoutPath) {
      void removeTempFile(stdoutPath);
    }
  }
}
