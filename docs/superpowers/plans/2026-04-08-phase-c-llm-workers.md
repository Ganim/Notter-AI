# Phase C — LLMWorker Abstraction + 3 CLI Adapters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a uniform `LLMWorker` interface and three concrete adapters (`ClaudeCodeWorker`, `GeminiWorker`, `CodexWorker`) so the planning pipeline (Phase D) and the execution worker (Phase F) can call any LLM through a single API. Each adapter wraps its CLI's spawn pattern, parses output, normalizes errors, and reports token usage in the v2 `TokenUsage` shape.

**Architecture:** TypeScript-side abstraction at `src/lib/llm/`. The `LLMWorker` interface has a single method `run(input)` returning `LLMResponse`. A shared `spawnCli` helper wraps `@tauri-apps/plugin-shell` Command API with the patterns Phase A discovered (stdin error guard, no shell wrapper on Windows, timeout, error mapping). Each adapter calls `spawnCli` with its CLI-specific args and parses the output.

**Tech Stack:** TypeScript, `@tauri-apps/plugin-shell` (NEW dependency, must be added), Vitest with mocked shell plugin, Rust crate `tauri-plugin-shell` for the Tauri side.

**Spec reference:** `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §10 (token tracking) and §6 (planning pipeline workers).

**Pre-flight:** Phase A spike confirmed the user has Claude Code v2.1.96 installed. Gemini CLI and Codex CLI were NOT installed during the spike but the user has installed them BEFORE this phase. Task 1 verifies all three are on PATH; if any is missing, the phase stops and the user is told.

---

## Critical design decisions

### Why `@tauri-apps/plugin-shell` and not Node `child_process`

The spike used Node `child_process` because it ran outside the Tauri runtime. Phase C runs INSIDE the Tauri renderer (the React UI). Node's `child_process` is not available in a webview. The official Tauri 2 way to spawn arbitrary CLIs from the renderer is the shell plugin's `Command` API. It handles cross-platform spawn, env inheritance, stdin pipes, and stdout/stderr streaming.

The existing PTY-based terminal in `src-tauri/src/lib.rs` is for *interactive* shells; it's the wrong tool for one-shot LLM CLI invocations because it allocates a PTY (overkill, leaks file descriptors, hard to capture stdout cleanly).

### Why one adapter per CLI instead of generic shell-out

Each CLI has different:
- Argument shapes (`gemini -p`, `codex exec`, `claude --print`)
- Authentication state (different config dirs, different OAuth flows)
- Output formats (JSON vs text, stdout vs stderr for tokens)
- Error semantics (rate limit messages, auth expiry, model errors)

Generic shell-out forces every consumer to know these differences. The adapter pattern hides them behind one interface.

### Token discovery for Gemini and Codex

The Phase A spike could not discover token formats for Gemini and Codex because the binaries weren't installed. Tasks 5 and 6 of this plan include a **discovery sub-step** that runs each CLI with a tiny prompt, captures the output, and bases the parsing code on what's actually emitted. **You must do the discovery before writing the parser** — do not invent the parser based on docs alone.

### Error normalization

All adapters return errors as a typed `LLMWorkerError` with one of these reasons:
- `cli_not_found` — binary not on PATH
- `auth_expired` — login required
- `rate_limited` — quota exceeded
- `network` — connectivity failure
- `parse_error` — output couldn't be parsed
- `unknown` — anything else

This lets the planning pipeline (Phase D) handle each case differently without parsing CLI-specific error strings.

---

## File Structure

```
src/lib/llm/
  ├── types.ts                 # NEW: LLMWorker interface, LLMInput, LLMResponse, LLMWorkerError
  ├── spawn-helper.ts          # NEW: spawnCli() wrapper around Tauri Command + error mapping
  ├── claude-code-worker.ts    # NEW: ClaudeCodeWorker adapter
  ├── gemini-worker.ts         # NEW: GeminiWorker adapter
  ├── codex-worker.ts          # NEW: CodexWorker adapter
  ├── index.ts                 # NEW: re-exports + getWorker(name) factory
  └── __tests__/
      ├── spawn-helper.test.ts
      ├── claude-code-worker.test.ts
      ├── gemini-worker.test.ts
      └── codex-worker.test.ts

src-tauri/
  ├── Cargo.toml               # MODIFIED: add tauri-plugin-shell = "2"
  ├── src/lib.rs               # MODIFIED: register shell plugin
  └── capabilities/default.json # MODIFIED: add shell:execute scope for the 3 CLIs

package.json                   # MODIFIED: add @tauri-apps/plugin-shell dependency
```

**Boundaries:**
- `types.ts` — only types, zero runtime
- `spawn-helper.ts` — only knows about `@tauri-apps/plugin-shell`, no CLI specifics
- Each `*-worker.ts` — only knows its CLI's args and output format, no shared state
- `index.ts` — only re-exports and a `getWorker(name)` factory; no logic

---

## Task 1: Verify CLIs and add the shell plugin

**Files:**
- Modify: `package.json` (add dep)
- Modify: `src-tauri/Cargo.toml` (add crate)
- Modify: `src-tauri/src/lib.rs` (register plugin)
- Modify: `src-tauri/capabilities/default.json` (add scope)

- [ ] **Step 1: Verify all 3 CLIs respond to --version**

```bash
which claude && claude --version
which gemini && gemini --version
which codex && codex --version
```

Expected: each prints a version and exits 0. Record the versions.

If any CLI fails:
- `which` returns nothing → not installed → STOP and report BLOCKED with the CLI name. The user must install before Phase C can continue.
- `--version` errors → unusual; capture the error and report DONE_WITH_CONCERNS. The user may need to re-authenticate or update.

Do NOT attempt to install the CLIs yourself. The user is responsible for installation per the spec roadmap §16 prerequisite.

- [ ] **Step 2: Quick auth check on Gemini and Codex**

```bash
echo "Say pong" | gemini -p "Repeat the user message" 2>&1 | head -20
codex exec "Say pong and nothing else" 2>&1 | head -20
```

Expected: each responds with something containing "pong", exit 0. Auth issues will surface here as a login prompt or "not authenticated" error.

If auth is broken: STOP and report NEEDS_CONTEXT — the user needs to re-login. Do not store credentials yourself.

- [ ] **Step 3: Add `@tauri-apps/plugin-shell` to package.json**

```bash
cd D:/Code/Projetos/CodeReview/AgentTrack
npm install @tauri-apps/plugin-shell
```

Verify in `package.json` that `@tauri-apps/plugin-shell` appears under `dependencies` with a `^2.x.y` version range matching the other plugins.

- [ ] **Step 4: Add the Rust crate**

Read `src-tauri/Cargo.toml` first.

Find the `[dependencies]` block (or the lines listing the existing tauri-plugin-* crates) and add this line, preserving the order with the other plugins:

```toml
tauri-plugin-shell = "2"
```

- [ ] **Step 5: Register the shell plugin in lib.rs**

Read `src-tauri/src/lib.rs` first. Find the `tauri::Builder::default()` chain that registers the existing plugins (look for `.plugin(tauri_plugin_fs::init())` or similar). Add this line in the same chain, near the other plugin registrations:

```rust
.plugin(tauri_plugin_shell::init())
```

The exact placement should match the pattern of existing plugin registrations. Don't reorder existing lines.

- [ ] **Step 6: Add capability scope for the 3 CLIs**

Read `src-tauri/capabilities/default.json` first. The current `permissions` array ends just after the `fs:scope` object. Add the shell capability AFTER that object but still inside the `permissions` array:

```json
"shell:default",
{
  "identifier": "shell:allow-execute",
  "allow": [
    { "name": "claude", "cmd": "claude", "args": true, "sidecar": false },
    { "name": "gemini", "cmd": "gemini", "args": true, "sidecar": false },
    { "name": "codex",  "cmd": "codex",  "args": true, "sidecar": false }
  ]
}
```

If the exact identifier `shell:allow-execute` does not exist in the shell plugin schema (Tauri permissions are evolving), check `node_modules/@tauri-apps/plugin-shell/src/permissions/` or the plugin docs and use the closest matching identifier (commonly `shell:allow-execute` or `shell:default`). Document what you used in the commit message.

The `args: true` value allows any args; we trust ourselves not to inject. For a stricter version we'd allow specific arg patterns, but that would force a config update every time we change CLI flags.

- [ ] **Step 7: Build the Rust side and verify no errors**

```bash
cd src-tauri && cargo check
```

Expected: exit 0 (warnings OK). If `tauri-plugin-shell` fails to resolve, run `cargo update -p tauri-plugin-shell` and try again.

- [ ] **Step 8: Verify TS compiles**

```bash
cd D:/Code/Projetos/CodeReview/AgentTrack
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat(deps): add @tauri-apps/plugin-shell for LLM CLI invocation

Adds the Tauri shell plugin (TS + Rust) and a capability scope allowing
execution of claude, gemini, and codex CLIs. Required for Phase C
LLMWorker adapters to spawn CLI processes from the renderer.

Pre-flight verified: claude <ver>, gemini <ver>, codex <ver> all on PATH
and responding to a tiny prompt.

Spec: docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md §10"
```

Replace `<ver>` placeholders with the actual version strings from Step 1.

## Self-review

1. The 3 CLIs all responded to `--version` and a tiny prompt
2. Shell plugin in package.json
3. Crate in Cargo.toml
4. Plugin registered in lib.rs
5. Capability added in default.json
6. `cargo check` passed
7. `tsc --noEmit` passed
8. Single commit with all files

## Report format

- **Status:** DONE | BLOCKED (CLI missing) | NEEDS_CONTEXT (auth issue) | DONE_WITH_CONCERNS
- Versions of the 3 CLIs (or which is missing)
- New commit SHA
- Whether you needed an alternate capability identifier in step 6
- Any concerns

---

## Task 2: Define `LLMWorker` interface and shared types

**Files:**
- Create: `src/lib/llm/types.ts`

- [ ] **Step 1: Create the directory and types file**

```bash
mkdir -p src/lib/llm src/lib/llm/__tests__
```

Then create `src/lib/llm/types.ts`:

```typescript
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
 * - Pipe the prompt via stdin, never as a positional CLI argument
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
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit 0. Note that nothing imports this file yet so a clean compile only proves the file itself is syntactically valid.

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/types.ts
git commit -m "feat(llm): define LLMWorker interface, LLMInput/Response, and typed errors

The interface is minimal: one method (run), one input shape, one response
shape, and a typed LLMWorkerError. All three CLI adapters (claude, gemini,
codex) will implement this in subsequent tasks."
```

## Self-review

1. File exists at exact path
2. All 5 types/interfaces exported
3. `LLMWorkerError` extends `Error` correctly
4. `tsc --noEmit` clean
5. Single commit

## Report format

- **Status:** DONE | BLOCKED
- New commit SHA
- Any concerns

---

## Task 3: Build the spawn helper

**Files:**
- Create: `src/lib/llm/spawn-helper.ts`
- Create: `src/lib/llm/__tests__/spawn-helper.test.ts`

This task wraps `@tauri-apps/plugin-shell`'s `Command` API in a Promise-based helper that takes a CLI name, args, optional stdin, and a timeout, then returns `{ stdout, stderr, exitCode, durationMs }`. Errors are mapped to `LLMWorkerError`.

The Tauri shell `Command` API works like this (verify against the actual SDK after install):

```typescript
import { Command } from '@tauri-apps/plugin-shell';
const cmd = Command.create('claude', ['--print', '--output-format', 'json']);
let stdout = '';
let stderr = '';
cmd.stdout.on('data', (line) => { stdout += line; });
cmd.stderr.on('data', (line) => { stderr += line; });
const child = await cmd.spawn();
await child.write('prompt text\n');
await new Promise((resolve, reject) => {
  cmd.on('close', resolve);
  cmd.on('error', reject);
});
```

The `child.write()` method takes a string and pipes it to stdin. The `'close'` event fires with `{ code, signal }`. Note the API accumulates `stdout`/`stderr` line-by-line through events, NOT through child.stdout streams as in Node.

- [ ] **Step 1: Read the actual @tauri-apps/plugin-shell SDK to confirm the API surface**

```bash
ls node_modules/@tauri-apps/plugin-shell/dist-js/
cat node_modules/@tauri-apps/plugin-shell/dist-js/index.d.ts | head -120
```

Look for `Command`, `spawn`, `write`, `stdout`, `stderr`, `close`, `error` events. If the API differs from the example above, adapt the code in Step 2 accordingly. **Do not write code that doesn't match the actual SDK.**

- [ ] **Step 2: Create the spawn helper**

Path: `src/lib/llm/spawn-helper.ts`

```typescript
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
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes('not found') || msg.includes('No such file') || msg.includes('cannot find')) {
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
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit 0. If the actual `@tauri-apps/plugin-shell` API differs from the imports above, update them now.

- [ ] **Step 4: Write the test file**

Path: `src/lib/llm/__tests__/spawn-helper.test.ts`

```typescript
// src/lib/llm/__tests__/spawn-helper.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @tauri-apps/plugin-shell with a flexible Command stub that lets each
// test inject its own stdout/stderr/close behavior.
const stdoutListeners: Array<(line: string) => void> = [];
const stderrListeners: Array<(line: string) => void> = [];
const closeListeners: Array<(data: { code: number | null; signal: number | null }) => void> = [];
const errorListeners: Array<(err: string) => void> = [];

let writeCalls: string[] = [];
let killCalled = false;
let spawnImpl: () => Promise<unknown> = async () => ({
  write: async (data: string) => {
    writeCalls.push(data);
  },
  kill: async () => {
    killCalled = true;
  },
});

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(() => ({
      stdout: { on: (_event: string, fn: (line: string) => void) => stdoutListeners.push(fn) },
      stderr: { on: (_event: string, fn: (line: string) => void) => stderrListeners.push(fn) },
      on: (event: string, fn: (data: any) => void) => {
        if (event === 'close') closeListeners.push(fn);
        if (event === 'error') errorListeners.push(fn);
      },
      spawn: () => spawnImpl(),
    })),
  },
}));

import { spawnCli } from '@/lib/llm/spawn-helper';
import { LLMWorkerError } from '@/lib/llm/types';

function emitStdout(line: string) {
  stdoutListeners.forEach((fn) => fn(line));
}
function emitStderr(line: string) {
  stderrListeners.forEach((fn) => fn(line));
}
function emitClose(code: number) {
  closeListeners.forEach((fn) => fn({ code, signal: null }));
}
function emitError(msg: string) {
  errorListeners.forEach((fn) => fn(msg));
}

beforeEach(() => {
  stdoutListeners.length = 0;
  stderrListeners.length = 0;
  closeListeners.length = 0;
  errorListeners.length = 0;
  writeCalls = [];
  killCalled = false;
  spawnImpl = async () => ({
    write: async (data: string) => {
      writeCalls.push(data);
    },
    kill: async () => {
      killCalled = true;
    },
  });
});

describe('spawnCli', () => {
  it('returns stdout, stderr, exitCode, durationMs on a successful run', async () => {
    const promise = spawnCli({ command: 'claude', args: ['--print'] });

    // Let the spawn settle
    await new Promise((r) => setTimeout(r, 10));
    emitStdout('hello');
    emitStdout(' world');
    emitStderr('warn');
    emitClose(0);

    const result = await promise;
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes stdin when provided', async () => {
    const promise = spawnCli({ command: 'claude', args: [], stdin: 'my prompt' });

    await new Promise((r) => setTimeout(r, 10));
    emitClose(0);

    await promise;
    expect(writeCalls).toContain('my prompt\n');
  });

  it('does not throw if stdin write fails (process closed early)', async () => {
    spawnImpl = async () => ({
      write: async () => {
        throw new Error('EPIPE');
      },
      kill: async () => {},
    });

    const promise = spawnCli({ command: 'gemini', args: [], stdin: 'oops' });

    await new Promise((r) => setTimeout(r, 10));
    emitClose(1);

    const result = await promise;
    expect(result.exitCode).toBe(1);
  });

  it('throws LLMWorkerError with reason cli_not_found when spawn fails with not found', async () => {
    spawnImpl = async () => {
      throw new Error('command not found: nope');
    };

    await expect(spawnCli({ command: 'codex', args: [] })).rejects.toMatchObject({
      reason: 'cli_not_found',
      cli: 'codex',
    });
  });

  it('throws LLMWorkerError with reason unknown for other spawn errors', async () => {
    spawnImpl = async () => {
      throw new Error('something weird');
    };

    await expect(spawnCli({ command: 'claude', args: [] })).rejects.toMatchObject({
      reason: 'unknown',
      cli: 'claude',
    });
  });

  it('throws LLMWorkerError with reason timeout when the deadline elapses', async () => {
    const promise = spawnCli({ command: 'claude', args: [], timeoutMs: 50 });

    // Don't emit close — let the timeout fire
    await expect(promise).rejects.toMatchObject({
      reason: 'timeout',
      cli: 'claude',
    });
    expect(killCalled).toBe(true);
  });

  it('throws LLMWorkerError on the error event', async () => {
    const promise = spawnCli({ command: 'gemini', args: [] });

    await new Promise((r) => setTimeout(r, 10));
    emitError('something broke');

    await expect(promise).rejects.toBeInstanceOf(LLMWorkerError);
  });
});
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- spawn-helper
```

Expected: all 7 tests pass. If a test fails, fix the implementation in `spawn-helper.ts` (NOT the test) — except if the failure is because the actual Tauri SDK API differs from what the mock assumes. In that case, update both the implementation AND the mock to match the real API.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: all 118 + 7 = 125 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/spawn-helper.ts src/lib/llm/__tests__/spawn-helper.test.ts
git commit -m "feat(llm): add spawnCli helper wrapping Tauri shell plugin

Single entry point for invoking the LLM CLIs with stdin piping, timeout,
and typed error mapping. All three adapters (claude, gemini, codex) will
use this helper instead of calling Command.create directly. Errors map
to LLMWorkerError with reasons cli_not_found, timeout, or unknown."
```

## Self-review

1. `spawn-helper.ts` exists, compiles
2. Test file exists with 7+ test cases
3. All tests pass
4. Full suite passes
5. Single commit

## Report format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED
- New commit SHA
- Whether you needed to adapt the helper to match the actual Tauri SDK
- Test count (should be 125 total)
- Any concerns

---

## Task 4: ClaudeCodeWorker adapter (with known token format)

**Files:**
- Create: `src/lib/llm/claude-code-worker.ts`
- Create: `src/lib/llm/__tests__/claude-code-worker.test.ts`

The Phase A spike captured the exact JSON shape Claude Code emits with `--print --output-format json`. Use that shape verbatim.

**Reference JSON from spike (copy as fixture in tests):**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 38004,
  "duration_api_ms": 1272,
  "num_turns": 1,
  "result": "pong",
  "total_cost_usd": 0.11500225,
  "usage": {
    "input_tokens": 5,
    "cache_creation_input_tokens": 16895,
    "cache_read_input_tokens": 18467,
    "output_tokens": 6
  },
  "modelUsage": {
    "claude-opus-4-6[1m]": {
      "inputTokens": 5,
      "outputTokens": 6,
      "cacheReadInputTokens": 18467,
      "cacheCreationInputTokens": 16895,
      "costUSD": 0.11500225
    }
  }
}
```

- [ ] **Step 1: Create the adapter**

Path: `src/lib/llm/claude-code-worker.ts`

```typescript
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
      '--output-format', 'json',
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
  if (text.includes('not authenticated') || text.includes('please login') || text.includes('login required')) {
    return new LLMWorkerError({
      reason: 'auth_expired',
      cli: 'claude',
      message: 'Claude Code authentication expired or missing',
      exitCode,
      stderr,
    });
  }
  if (text.includes('rate limit') || text.includes('quota') || text.includes('too many requests')) {
    return new LLMWorkerError({
      reason: 'rate_limited',
      cli: 'claude',
      message: 'Claude Code rate limit reached',
      exitCode,
      stderr,
    });
  }
  if (text.includes('network') || text.includes('econnrefused') || text.includes('enotfound')) {
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
```

- [ ] **Step 2: Write the test file**

Path: `src/lib/llm/__tests__/claude-code-worker.test.ts`

```typescript
// src/lib/llm/__tests__/claude-code-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock spawn-helper so tests don't actually spawn anything
const spawnCliMock = vi.fn();
vi.mock('@/lib/llm/spawn-helper', () => ({
  spawnCli: (...args: any[]) => spawnCliMock(...args),
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
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ]);
    expect(callArgs.stdin).toBe('test');
  });

  it('concatenates systemPrompt before prompt when both are provided', async () => {
    spawnCliMock.mockResolvedValue({
      stdout: JSON.stringify(VALID_RESPONSE),
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const worker = new ClaudeCodeWorker();
    await worker.run({ prompt: 'do it', systemPrompt: 'You are X.' });

    const callArgs = spawnCliMock.mock.calls[0][0];
    expect(callArgs.stdin).toBe('You are X.\n\ndo it');
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
```

- [ ] **Step 3: Run the tests**

```bash
npm test -- claude-code-worker
```

Expected: all 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/llm/claude-code-worker.ts src/lib/llm/__tests__/claude-code-worker.test.ts
git commit -m "feat(llm): ClaudeCodeWorker adapter with rich token parsing

Wraps 'claude --print --output-format json --dangerously-skip-permissions'.
Parses the JSON envelope confirmed by the Phase A spike (input_tokens,
cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
total_cost_usd, duration_api_ms). Maps stderr keywords to typed errors:
auth_expired, rate_limited, network, unknown."
```

## Self-review

1. Adapter file exists with the class
2. Test file with ≥10 tests
3. Tests pass
4. Full suite passes
5. Single commit

## Report format

- **Status:** DONE | BLOCKED
- New commit SHA
- Test count
- Any concerns

---

## Task 5: GeminiWorker — discovery + adapter + tests

This task has TWO sub-phases: first run the real Gemini CLI to discover its output format, then write the adapter based on what you observed. The plan provides scaffolding but the parsing code in Step 2 is a TEMPLATE — you must adapt it after Step 1.

**Files:**
- Create: `src/lib/llm/gemini-worker.ts`
- Create: `src/lib/llm/__tests__/gemini-worker.test.ts`
- Append to: `spike/notes.md` (gitignored)

- [ ] **Step 1: Discover Gemini's output format**

```bash
echo "Say pong and nothing else" | gemini -p "Repeat the user message" 2>spike/fixtures/gemini-stderr.txt > spike/fixtures/gemini-stdout.txt
echo "exit: $?"
cat spike/fixtures/gemini-stdout.txt
echo "--- stderr ---"
cat spike/fixtures/gemini-stderr.txt
```

Inspect both files. Look for:
- Where does the LLM response go? (stdout or stderr)
- Is there a JSON envelope? Try `--json` or `--output-format json`:
  ```bash
  gemini --help 2>&1 | grep -iE 'json|format' | head -10
  ```
- Where do tokens appear (if at all)? Look for: `input_tokens`, `inputTokens`, `usageMetadata`, `totalTokenCount`, etc.
- Is there a way to ask Gemini for structured output?

Document findings in `spike/notes.md` under a new section:

```markdown
## Phase C — Gemini CLI discovery (date)

Version: <gemini --version>

Output format: <text/json/mixed>
Token info location: <stdout/stderr/json field/none>
Parse path: <concrete>
Args used: <gemini -p "prompt" or other>

Sample stdout:
<paste first 50 lines>

Sample stderr:
<paste first 50 lines>

JSON envelope (if any):
<paste>

Notes:
- <anything weird about exit codes, encoding, multi-line output, etc.>
```

The fixture files (`gemini-stdout.txt`, `gemini-stderr.txt`) are gitignored — they exist for your inspection during this task only. You'll commit a sanitized version inside the test file.

- [ ] **Step 2: Create the adapter based on what you observed**

Path: `src/lib/llm/gemini-worker.ts`

The template below is a STARTING POINT. Adapt the spawn args and the parser body based on Step 1 findings. **Do not commit unmodified template code if it doesn't match reality.** The interface (input shape, return shape, error mapping) is fixed by the LLMWorker contract — only the internals change.

```typescript
// src/lib/llm/gemini-worker.ts
//
// Phase C: GeminiWorker — invokes the Gemini CLI and parses its response.
// Output format was discovered manually in Task 5 of Phase C.

import { spawnCli } from '@/lib/llm/spawn-helper';
import {
  LLMInput,
  LLMResponse,
  LLMWorker,
  LLMWorkerError,
} from '@/lib/llm/types';

export class GeminiWorker implements LLMWorker {
  readonly name = 'gemini-cli' as const;

  async run(input: LLMInput): Promise<LLMResponse> {
    // ADAPT: args based on Step 1 discovery. Common patterns:
    //   gemini -p "<prompt>"
    //   gemini --output-format json -p "<prompt>"
    //   gemini chat (interactive — not what we want)
    const args = ['-p', input.prompt]; // ← replace if discovery showed otherwise

    const result = await spawnCli({
      command: 'gemini',
      args,
      // ADAPT: if Gemini wants stdin instead of arg, move prompt here:
      // stdin: input.prompt,
      timeoutMs: input.timeoutMs ?? 120_000,
    });

    if (result.exitCode !== 0) {
      throw classifyGeminiError(result.exitCode, result.stderr);
    }

    // ADAPT: parse based on Step 1 findings.
    // Three common cases:
    //
    // 1. Plain text on stdout, no token info anywhere:
    //    text = result.stdout.trim()
    //    tokenUsage = estimateFromCharCount(input.prompt, text)
    //    tokenUsageReported = false
    //
    // 2. JSON envelope on stdout with usage block:
    //    parsed = JSON.parse(result.stdout)
    //    text = parsed.candidates[0].content.parts[0].text
    //    tokenUsage = { inputTokens: parsed.usageMetadata.promptTokenCount, ... }
    //    tokenUsageReported = true
    //
    // 3. Text on stdout, token line on stderr:
    //    text = result.stdout.trim()
    //    tokenUsage = parseStderrUsage(result.stderr)
    //    tokenUsageReported = true if usage line found

    const text = result.stdout.trim();
    const tokenUsage = estimateTokensFromText(input.prompt, text);
    const tokenUsageReported = false;

    return {
      text,
      tokenUsage: {
        ...tokenUsage,
        worker: 'gemini-cli',
        timestamp: Date.now(),
      },
      durationMs: result.durationMs,
      tokenUsageReported,
    };
  }
}

/**
 * Fallback estimator: ~4 chars per token. Used when the CLI doesn't expose
 * token usage. Phase D's planning pipeline knows to discount these estimates
 * (tokenUsageReported=false on the response).
 */
function estimateTokensFromText(prompt: string, response: string): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: Math.ceil(response.length / 4),
  };
}

function classifyGeminiError(exitCode: number, stderr: string): LLMWorkerError {
  const text = stderr.toLowerCase();
  if (text.includes('not authenticated') || text.includes('please log in') || text.includes('expired')) {
    return new LLMWorkerError({
      reason: 'auth_expired',
      cli: 'gemini',
      message: 'Gemini CLI authentication expired or missing',
      exitCode,
      stderr,
    });
  }
  if (text.includes('quota') || text.includes('rate limit') || text.includes('429')) {
    return new LLMWorkerError({
      reason: 'rate_limited',
      cli: 'gemini',
      message: 'Gemini CLI rate limit / quota exceeded',
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
```

- [ ] **Step 3: Write the test file**

Path: `src/lib/llm/__tests__/gemini-worker.test.ts`

Use sanitized samples of what you actually captured in Step 1 as fixtures. Mock `spawn-helper` like the Claude Code test did. Required test cases:

1. Returns parsed text from a successful run
2. Returns token usage (reported or estimated)
3. Sets `tokenUsageReported` correctly based on whether the CLI exposed tokens
4. Throws `auth_expired` on auth-related stderr
5. Throws `rate_limited` on quota-related stderr
6. Throws `unknown` on unrecognized non-zero exit
7. Sets `worker: 'gemini-cli'` in the response

Use the same vi.mock pattern from the claude-code-worker test. The fixtures should be the actual stdout/stderr from your Step 1 discovery (sanitized of any personal data — usernames, paths, tokens).

Aim for 7-10 test cases.

- [ ] **Step 4: Run tests**

```bash
npm test -- gemini-worker
```

Expected: all tests pass. Iterate on the parser if needed — the tests are the contract.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/gemini-worker.ts src/lib/llm/__tests__/gemini-worker.test.ts
git commit -m "feat(llm): GeminiWorker adapter with discovered output parsing

Output format and token reporting were discovered via running the live
gemini CLI; see spike/notes.md Phase C section. <One sentence summary
of the format you found, e.g. 'Gemini emits plain text on stdout with
no token info, so the adapter falls back to char-length estimation
(~4 chars/token).' OR 'Gemini emits a JSON envelope with usageMetadata,
so the adapter parses input/output tokens directly.'>"
```

## Self-review

1. `spike/notes.md` has the discovery section
2. `gemini-worker.ts` matches what you observed (no leftover template stubs)
3. Tests use real captured fixtures (sanitized)
4. All tests pass
5. Single commit
6. Commit message describes the actual format

## Report format

- **Status:** DONE | BLOCKED
- New commit SHA
- One-sentence summary of what Gemini's output looked like
- Did the CLI report tokens natively, or did you fall back to estimation?
- Test count
- Any surprises during discovery

---

## Task 6: CodexWorker — discovery + adapter + tests

Same shape as Task 5 but for the Codex CLI. Run the binary, capture output, write the adapter, write tests.

**Files:**
- Create: `src/lib/llm/codex-worker.ts`
- Create: `src/lib/llm/__tests__/codex-worker.test.ts`
- Append to: `spike/notes.md`

- [ ] **Step 1: Discover Codex's output format**

```bash
codex exec "Say pong and nothing else" 2>spike/fixtures/codex-stderr.txt > spike/fixtures/codex-stdout.txt
echo "exit: $?"
cat spike/fixtures/codex-stdout.txt
echo "--- stderr ---"
cat spike/fixtures/codex-stderr.txt
```

If `codex exec` is not the right subcommand:
```bash
codex --help 2>&1 | head -40
```

Look for the headless / one-shot mode (it may be `codex run`, `codex query`, `codex --print`, `codex chat` with `--no-interactive`, etc.).

Document in `spike/notes.md`:

```markdown
## Phase C — Codex CLI discovery (date)

Version: <codex --version>
Headless command: <codex exec / codex run / etc.>
Output format: <text/json>
Token info location: <stdout/stderr/json field/none>
Parse path: <concrete>

Sample stdout:
<paste first 50 lines>

Sample stderr:
<paste first 50 lines>

Notes:
- <anything weird>
```

- [ ] **Step 2: Create the adapter**

Path: `src/lib/llm/codex-worker.ts`

Same template structure as the Gemini worker. Adapt args and parser based on Step 1.

```typescript
// src/lib/llm/codex-worker.ts
//
// Phase C: CodexWorker — invokes the Codex CLI and parses its response.
// Output format discovered manually in Task 6 of Phase C.

import { spawnCli } from '@/lib/llm/spawn-helper';
import {
  LLMInput,
  LLMResponse,
  LLMWorker,
  LLMWorkerError,
} from '@/lib/llm/types';

export class CodexWorker implements LLMWorker {
  readonly name = 'codex-cli' as const;

  async run(input: LLMInput): Promise<LLMResponse> {
    // ADAPT: subcommand and args based on Step 1 discovery
    const args = ['exec', input.prompt];

    const result = await spawnCli({
      command: 'codex',
      args,
      timeoutMs: input.timeoutMs ?? 120_000,
    });

    if (result.exitCode !== 0) {
      throw classifyCodexError(result.exitCode, result.stderr);
    }

    // ADAPT: parse based on Step 1 findings
    const text = result.stdout.trim();
    const tokenUsage = estimateTokensFromText(input.prompt, text);
    const tokenUsageReported = false;

    return {
      text,
      tokenUsage: {
        ...tokenUsage,
        worker: 'codex-cli',
        timestamp: Date.now(),
      },
      durationMs: result.durationMs,
      tokenUsageReported,
    };
  }
}

function estimateTokensFromText(prompt: string, response: string): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: Math.ceil(response.length / 4),
  };
}

function classifyCodexError(exitCode: number, stderr: string): LLMWorkerError {
  const text = stderr.toLowerCase();
  if (text.includes('not signed in') || text.includes('please sign in') || text.includes('login required')) {
    return new LLMWorkerError({
      reason: 'auth_expired',
      cli: 'codex',
      message: 'Codex CLI authentication expired or missing',
      exitCode,
      stderr,
    });
  }
  if (text.includes('quota') || text.includes('rate limit') || text.includes('429')) {
    return new LLMWorkerError({
      reason: 'rate_limited',
      cli: 'codex',
      message: 'Codex CLI rate limit / quota exceeded',
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
```

- [ ] **Step 3: Write the test file**

Path: `src/lib/llm/__tests__/codex-worker.test.ts`

Same structure as `gemini-worker.test.ts`. Use sanitized real fixtures. Required cases:
1. Returns parsed text
2. Token usage shape (reported or estimated)
3. `tokenUsageReported` flag correct
4. `auth_expired` on sign-in stderr
5. `rate_limited` on quota stderr
6. `unknown` on unrecognized non-zero exit
7. `worker: 'codex-cli'` in response

7-10 cases.

- [ ] **Step 4: Run tests**

```bash
npm test -- codex-worker
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/codex-worker.ts src/lib/llm/__tests__/codex-worker.test.ts
git commit -m "feat(llm): CodexWorker adapter with discovered output parsing

<One sentence summary of the actual Codex output format and whether
tokens are reported natively.>"
```

## Self-review

Same checklist as Task 5.

## Report format

- **Status:** DONE | BLOCKED
- New commit SHA
- One-sentence summary of what Codex's output looked like
- Native token reporting yes/no
- Test count
- Surprises

---

## Task 7: Factory + index.ts

**Files:**
- Create: `src/lib/llm/index.ts`

- [ ] **Step 1: Create the index file**

```typescript
// src/lib/llm/index.ts
//
// Phase C: public entry point for the LLM worker abstraction.
// Re-exports the interface and a factory that returns the right adapter
// for a given worker name.

export type {
  LLMWorker,
  LLMInput,
  LLMResponse,
  LLMWorkerErrorReason,
} from '@/lib/llm/types';

export { LLMWorkerError } from '@/lib/llm/types';

export { ClaudeCodeWorker } from '@/lib/llm/claude-code-worker';
export { GeminiWorker } from '@/lib/llm/gemini-worker';
export { CodexWorker } from '@/lib/llm/codex-worker';

import { LLMWorker } from '@/lib/llm/types';
import { ClaudeCodeWorker } from '@/lib/llm/claude-code-worker';
import { GeminiWorker } from '@/lib/llm/gemini-worker';
import { CodexWorker } from '@/lib/llm/codex-worker';

export type WorkerName = 'claude-code' | 'gemini-cli' | 'codex-cli';

/**
 * Factory: returns a fresh instance of the requested worker. Adapters are
 * stateless so we don't bother caching.
 */
export function getWorker(name: WorkerName): LLMWorker {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodeWorker();
    case 'gemini-cli':
      return new GeminiWorker();
    case 'codex-cli':
      return new CodexWorker();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown worker: ${exhaustive}`);
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: all tests pass (the new index.ts has no tests of its own — it's pure re-exports + factory — but the existing adapter tests still pass).

- [ ] **Step 4: Commit**

```bash
git add src/lib/llm/index.ts
git commit -m "feat(llm): public index with getWorker factory

Single import point for consumers: import { getWorker, LLMWorker } from
'@/lib/llm'. Returns fresh adapter instances; adapters are stateless."
```

## Self-review

1. `index.ts` exists, exports all 5 types + 3 worker classes + factory
2. Factory has exhaustiveness check on WorkerName
3. `tsc --noEmit` clean
4. Full suite passes

## Report format

- **Status:** DONE | BLOCKED
- New commit SHA

---

## Task 8: Live integration smoke test (gated, optional)

**Files:**
- Create: `src/lib/llm/__tests__/integration.test.ts` (gated by env var)

This test actually invokes each CLI and verifies the workers return real responses. It's gated behind `LLM_LIVE_TESTS=1` so the regular `npm test` doesn't run it (those tests must stay deterministic).

- [ ] **Step 1: Create the gated test file**

```typescript
// src/lib/llm/__tests__/integration.test.ts
//
// Phase C: live integration smoke test. Actually spawns each CLI and verifies
// the worker returns a sensible response. Gated by LLM_LIVE_TESTS=1 because:
// - It costs real tokens / quota
// - It requires the user to be logged in to all 3 CLIs
// - It's slow (each call ~30-60s due to Claude Code startup overhead)
//
// Run manually:
//   LLM_LIVE_TESTS=1 npm test -- llm/__tests__/integration
//
// Note: this test runs in Node (Vitest), but the workers normally run inside
// the Tauri renderer. The shell helper imports @tauri-apps/plugin-shell which
// will fail in Node. This test is therefore expected to FAIL in Node and is
// here as a documentation/manual checklist rather than CI coverage. Real
// integration validation happens in Phase D when the planning pipeline
// actually runs in the Tauri runtime.

import { describe, it } from 'vitest';

const LIVE = process.env.LLM_LIVE_TESTS === '1';

describe.skipIf(!LIVE)('live LLM integration (manual gate)', () => {
  it('manual: not runnable from Node — see file header for context', () => {
    // The Tauri shell plugin requires the Tauri runtime. Live validation
    // happens via the dev app, not Vitest. This file documents the
    // manual checklist:
    //
    // 1. Open AgentTrack in dev mode (npm run tauri dev)
    // 2. Open the browser dev tools console
    // 3. Run:
    //    const { getWorker } = await import('@/lib/llm');
    //    const r = await getWorker('claude-code').run({ prompt: 'Say pong' });
    //    console.log(r);
    // 4. Repeat for 'gemini-cli' and 'codex-cli'
    // 5. Verify each returns a sensible text and tokenUsage
  });
});
```

- [ ] **Step 2: Run the file (it should be skipped by default)**

```bash
npm test -- llm/__tests__/integration
```

Expected: 1 test SKIPPED (because `LLM_LIVE_TESTS` not set).

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/__tests__/integration.test.ts
git commit -m "test(llm): document live integration manual checklist

The Vitest sandbox can't actually invoke the Tauri shell plugin, so
true integration validation happens in Phase D when the planning
pipeline runs inside the Tauri runtime. This file documents the
manual steps for verifying each adapter against the real CLI."
```

## Self-review

1. File exists, gated by env var, skipped by default
2. Header explains the limitation clearly
3. No fake assertions
4. Single commit

## Report format

- **Status:** DONE | BLOCKED
- New commit SHA

---

## Final verification

- [ ] **Step 1: Run the full test suite one last time**

```bash
npm test
```

Expected: all tests pass. Approximate count:
- Pre-Phase C: 118
- Phase B Tasks 2+3 added 25 tests in actions-migration.test.ts
- Phase B Task 5 added 3 tests in actions-store.test.ts
- Phase C Task 3 (spawn-helper): ~7 tests
- Phase C Task 4 (claude-code): ~10 tests
- Phase C Task 5 (gemini): ~7-10 tests
- Phase C Task 6 (codex): ~7-10 tests
- Phase C Task 8 (integration): 1 skipped
- **Total: ~150-160 tests passing**

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Check the Phase C commit log**

```bash
git log --oneline dcc2024..HEAD
```

(`dcc2024` is the last Phase B commit.)

Expected: 8 commits in order:
1. shell plugin + cli verification
2. types.ts
3. spawn-helper + tests
4. claude-code-worker + tests
5. gemini-worker + tests
6. codex-worker + tests
7. index.ts factory
8. integration test (gated)

---

## Self-Review Checklist (Plan Author)

- [x] Every task has concrete file paths
- [x] Every code step has complete code OR explicit "ADAPT based on discovery" markers (Tasks 5 and 6 only)
- [x] Discovery sub-steps come BEFORE adapter implementation in Tasks 5 and 6
- [x] Spec coverage: §10 token tracking → spread across Tasks 4-6; §6 worker selection → mapped to adapters; LLMWorker interface → Task 2
- [x] Type consistency: `LLMWorker`, `LLMInput`, `LLMResponse`, `LLMWorkerError` defined in Task 2 and consistently imported by all adapters and helpers
- [x] No references to undefined symbols
- [x] Each task's commit is atomic
- [x] Pre-flight CLI verification is the first task (gates the rest)
- [x] Adapter pattern keeps each CLI's specifics out of consumers
- [x] Tests use mocks (deterministic) + a clearly-gated live test for manual validation

---

## Success criteria (Phase C complete)

Phase C is done when:
1. All 3 CLIs verified on PATH and authenticated
2. `@tauri-apps/plugin-shell` installed (TS + Rust + capability)
3. `LLMWorker` interface defined and re-exported via `src/lib/llm/index.ts`
4. `spawnCli` helper compiled, tested, error-mapped
5. `ClaudeCodeWorker` parses the rich JSON envelope discovered in Phase A
6. `GeminiWorker` parses real Gemini output (verified by manual discovery)
7. `CodexWorker` parses real Codex output (verified by manual discovery)
8. `getWorker(name)` factory dispatches to the right adapter
9. All Vitest tests pass (~150-160 total)
10. Manual smoke test in Tauri dev mode confirms each adapter returns sensible responses (Phase D will exercise this fully; for Phase C completion the gate is "tests + at least one manual call per CLI succeeds")
