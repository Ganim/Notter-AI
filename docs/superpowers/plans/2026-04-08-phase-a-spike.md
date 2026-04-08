# Phase A — Architecture Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate in one session that Claude Code CLI can be spawned headless with a subprocess MCP server, call MCP tools, respect blocking tool calls, and that token usage can be read from all three CLIs (Claude Code, Gemini, Codex) — producing a clear Go/No-Go decision before committing to full implementation.

**Architecture:** Isolated spike in a new `spike/` directory at the repo root. Minimal TypeScript MCP server using `@modelcontextprotocol/sdk` with two tools (`echo`, `block`). A spike runner script spawns Claude Code CLI pointed at the server, sends a prompt, captures the output. Token usage discovery is manual: each CLI is run with a tiny prompt and the adapter parsing path is documented.

**Tech Stack:** TypeScript, Node.js ≥18, `@modelcontextprotocol/sdk`, Claude Code CLI (already installed), Gemini CLI, Codex CLI (install if missing). No changes to the main Tauri app in this phase.

**Spec reference:** `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §15

---

## File Structure

```
spike/
  ├── package.json            # Standalone deps for the spike (not linked to root)
  ├── tsconfig.json           # TS config, ESM, node16 module
  ├── src/
  │   ├── mcp-server.ts       # Minimal MCP server with echo + block tools
  │   ├── spike-runner.ts     # Spawns Claude Code with the MCP server
  │   └── token-probe.ts      # Runs each CLI with a tiny prompt and captures output
  ├── fixtures/
  │   ├── gemini-output.txt   # Raw output captured from Gemini CLI
  │   ├── codex-output.txt    # Raw output captured from Codex CLI
  │   └── claude-code-output.txt  # Raw output captured from Claude Code CLI
  └── README.md               # How to run the spike

docs/superpowers/specs/
  └── 2026-04-08-spike-results.md   # Filled at the end with Go/No-Go
```

**Boundaries:**
- `mcp-server.ts` only knows about MCP SDK. Does not depend on AgentTrack code.
- `spike-runner.ts` only knows about spawning Claude Code and reading stdout. Does not depend on MCP SDK internals.
- `token-probe.ts` is a standalone script that runs each CLI once and saves output to fixtures/. Does not depend on the MCP server or the runner.
- Everything under `spike/` is throw-away — it is **not** promoted to src/. Successful patterns get re-implemented properly in later phases.

---

## Task 1: Scaffold the spike directory

**Files:**
- Create: `spike/package.json`
- Create: `spike/tsconfig.json`
- Create: `spike/.gitignore`
- Create: `spike/README.md`

- [ ] **Step 1: Create the spike directory**

```bash
mkdir -p spike/src spike/fixtures
```

- [ ] **Step 2: Create `spike/package.json`**

```json
{
  "name": "agenttrack-spike",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "mcp-server": "tsx src/mcp-server.ts",
    "runner": "tsx src/spike-runner.ts",
    "token-probe": "tsx src/token-probe.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: Create `spike/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Create `spike/.gitignore`**

```
node_modules/
dist/
fixtures/*.txt
!fixtures/.gitkeep
```

- [ ] **Step 5: Create `spike/fixtures/.gitkeep`**

```bash
touch spike/fixtures/.gitkeep
```

- [ ] **Step 6: Create `spike/README.md`**

```markdown
# AgentTrack Architecture Spike

Standalone spike to validate Claude Code CLI + MCP integration for the
autonomous pipeline design. See
`docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §15.

## Setup

```bash
cd spike
npm install
```

## Scripts

- `npm run mcp-server` — run the minimal MCP server standalone (stdio)
- `npm run runner` — spawn Claude Code with the MCP server and execute the spike
- `npm run token-probe` — run each of the three CLIs with a tiny prompt and
  save output to `fixtures/` for parsing discovery

## Results

Results are documented in
`docs/superpowers/specs/2026-04-08-spike-results.md`.
```

- [ ] **Step 7: Install spike dependencies**

```bash
cd spike && npm install
```

Expected: node_modules created, no errors. If `@modelcontextprotocol/sdk` version `^1.0.0` fails, run `npm view @modelcontextprotocol/sdk versions` and use the latest major available, updating `package.json` accordingly.

- [ ] **Step 8: Commit**

```bash
cd ..
git add spike/package.json spike/tsconfig.json spike/.gitignore spike/README.md spike/fixtures/.gitkeep spike/package-lock.json
git commit -m "spike: scaffold phase A spike directory

Standalone spike environment for validating Claude Code CLI + MCP
integration before the autonomous pipeline implementation."
```

---

## Task 2: Write a minimal MCP server with `echo` tool

**Files:**
- Create: `spike/src/mcp-server.ts`

- [ ] **Step 1: Create the MCP server file with the `echo` tool**

```typescript
// spike/src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'notter-spike', version: '0.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Returns the input message verbatim. Used to verify MCP tool calls work.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo back' },
        },
        required: ['message'],
      },
    },
    {
      name: 'block',
      description: 'Sleeps for the given number of milliseconds before returning. Used to verify MCP tool blocking.',
      inputSchema: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to sleep' },
        },
        required: ['ms'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo') {
    const message = (args as { message: string }).message;
    return {
      content: [{ type: 'text', text: `echo: ${message}` }],
    };
  }

  if (name === 'block') {
    const ms = (args as { ms: number }).ms;
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const elapsed = Date.now() - start;
    return {
      content: [{ type: 'text', text: `blocked for ${elapsed}ms` }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('notter-spike MCP server ready\n');
```

- [ ] **Step 2: Verify the server starts cleanly**

```bash
cd spike
timeout 2 npm run mcp-server 2>&1 || true
```

Expected stderr contains `notter-spike MCP server ready`. Expected stdout empty (MCP protocol silent until a client connects). The `timeout 2` kills it after 2 seconds; if the script exits immediately with a compile error, fix the error before moving on.

**If** `@modelcontextprotocol/sdk/server/index.js` import path fails: the SDK layout may have changed. Run `ls node_modules/@modelcontextprotocol/sdk/dist/esm/server/` and adjust imports to match the actual path.

- [ ] **Step 3: Commit**

```bash
cd ..
git add spike/src/mcp-server.ts
git commit -m "spike: minimal MCP server with echo and block tools"
```

---

## Task 3: Discover Claude Code CLI flags for MCP

**Files:**
- Create: `spike/notes.md` (discovery log — not committed to main spec, just scratchpad)

- [ ] **Step 1: Check Claude Code version**

```bash
claude --version
```

Expected: a version string. Record it for the results doc.

- [ ] **Step 2: Check help output for MCP-related flags**

```bash
claude --help 2>&1 | grep -i mcp
```

- [ ] **Step 3: Check Claude Code MCP config command**

```bash
claude mcp --help 2>&1
```

Expected: shows subcommands like `list`, `add`, `remove`. Claude Code manages MCP servers via a config command, not by flag at invoke time.

- [ ] **Step 4: Understand the two modes MCP can be added**

Read the help output and document in `spike/notes.md`:

```markdown
# Claude Code MCP discovery notes

Version: <filled from step 1>

## How MCP servers are registered

Claude Code uses `claude mcp add <name> <command> [args...]` to register
a server. The registration is stored in a config file. Once registered,
it's available in subsequent `claude` invocations in that scope.

Scopes:
- local (default) — per-project
- user — global to the user
- project — shared via .mcp.json committed to repo

## What we need for the spike

Since our MCP server is per-Action (ephemeral), we cannot use `mcp add`
at session start and `mcp remove` at the end — too slow, too stateful.
Options:
1. Use `.mcp.json` scope "project" and regenerate the file per Action
2. Use `--mcp-config <path>` flag at invocation time if it exists
3. Register with a deterministic name (e.g., `notter-spike`) once and
   reuse, passing action_id via environment variable

Check if `--mcp-config` flag exists:
```bash
claude --help 2>&1 | grep -i "mcp-config"
```
```

- [ ] **Step 5: Check for `--mcp-config` flag specifically**

```bash
claude --help 2>&1 | grep -i "mcp-config" || echo "not found in --help"
claude --mcp-config 2>&1 | head -5 || true
```

Record result in `spike/notes.md`.

- [ ] **Step 6: Do NOT commit spike/notes.md**

Add `notes.md` to the spike gitignore:

```bash
echo "notes.md" >> spike/.gitignore
```

Then:

```bash
git add spike/.gitignore
git commit -m "spike: ignore ephemeral notes.md"
```

---

## Task 4: Spike test 15.1 — Can Claude Code call an MCP tool?

**Files:**
- Create: `spike/src/spike-runner.ts`
- Create: `spike/.mcp.json` (temporary, may be deleted in cleanup)

- [ ] **Step 1: Register the spike MCP server locally**

Use the approach discovered in Task 3. If `--mcp-config` flag exists, write a `.mcp.json` file with the server definition. Otherwise, use `claude mcp add`.

**Branch A — `--mcp-config` exists:**

Create `spike/.mcp.json`:

```json
{
  "mcpServers": {
    "notter-spike": {
      "command": "npx",
      "args": ["tsx", "src/mcp-server.ts"],
      "cwd": "."
    }
  }
}
```

**Branch B — use `claude mcp add`:**

```bash
cd spike
claude mcp add notter-spike -- npx tsx src/mcp-server.ts
claude mcp list
```

Expected: `notter-spike` shows in the list.

Record which branch you used in `spike/notes.md`.

- [ ] **Step 2: Write the spike runner**

```typescript
// spike/src/spike-runner.ts
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SPIKE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

type SpikeResult = {
  name: string;
  passed: boolean;
  details: string;
};

async function runClaudeCodeOnce(prompt: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // Use --print for non-interactive mode. Branch A: pass --mcp-config flag.
    // Branch B: omit (server was registered with `claude mcp add`).
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      // '--mcp-config', '.mcp.json',   // uncomment for Branch A
      prompt,
    ];

    const child = spawn('claude', args, {
      cwd: SPIKE_DIR,
      shell: process.platform === 'win32',
    });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function test_15_1(): Promise<SpikeResult> {
  const prompt = 'Call the notter-spike echo tool with message="hello-from-spike" and tell me exactly what the tool returned.';
  const res = await runClaudeCodeOnce(prompt, 60_000);

  const passed = res.stdout.includes('echo: hello-from-spike') && res.exitCode === 0;

  return {
    name: '15.1 — Claude Code can call MCP tool',
    passed,
    details: `exitCode=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  };
}

async function main() {
  console.log('=== Spike Runner ===\n');

  const results: SpikeResult[] = [];
  results.push(await test_15_1());

  for (const r of results) {
    console.log(`[${r.passed ? 'PASS' : 'FAIL'}] ${r.name}`);
    console.log(r.details);
    console.log('');
  }

  fs.writeFileSync(
    path.join(SPIKE_DIR, 'fixtures', 'spike-15-1-result.txt'),
    JSON.stringify(results[0], null, 2)
  );

  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

main().catch((err) => {
  console.error('Spike runner crashed:', err);
  process.exit(2);
});
```

- [ ] **Step 3: Run the spike runner**

```bash
cd spike
npm run runner
```

Expected: `[PASS] 15.1 — Claude Code can call MCP tool`. If `[FAIL]`, read the details output carefully:
- If stderr mentions "unknown server notter-spike": Branch used wrong. Switch.
- If stderr mentions "permission": permissions flag missing or wrong.
- If stdout has echo but test didn't match: tweak the `includes` check for the actual format.
- If process timed out: increase `timeoutMs` or check MCP server logs via stderr.

**Do not move to the next task until 15.1 passes or we decide the spike fails.**

- [ ] **Step 4: If 15.1 PASSES, commit**

```bash
cd ..
git add spike/src/spike-runner.ts spike/.mcp.json 2>/dev/null || git add spike/src/spike-runner.ts
git commit -m "spike: test 15.1 — Claude Code calls MCP echo tool [PASS]"
```

- [ ] **Step 5: If 15.1 FAILS after 30 minutes of debugging, STOP the plan**

Create `docs/superpowers/specs/2026-04-08-spike-results.md` immediately with a FAIL verdict on 15.1 and detailed findings. Do NOT continue to the remaining tasks. Report to the user for redesign.

---

## Task 5: Spike test 15.3 — Does MCP tool blocking work?

**Files:**
- Modify: `spike/src/spike-runner.ts` (add `test_15_3` and call it)

- [ ] **Step 1: Add the blocking test function**

Open `spike/src/spike-runner.ts` and add the following function above `main()`:

```typescript
async function test_15_3(): Promise<SpikeResult> {
  const prompt = 'Call the notter-spike block tool with ms=8000. After it returns, tell me the elapsed time the tool reported.';
  const startWall = Date.now();
  const res = await runClaudeCodeOnce(prompt, 30_000);
  const wallElapsed = Date.now() - startWall;

  // The tool should have blocked for ~8000ms. Claude Code's total time is more,
  // but should be at least 7500ms (allowing small clock slop).
  const tookEnough = wallElapsed >= 7500;
  const stdoutHasBlocked = /blocked for \d{4,}ms/.test(res.stdout);
  const passed = tookEnough && stdoutHasBlocked && res.exitCode === 0;

  return {
    name: '15.3 — MCP tool blocking works (for HITL)',
    passed,
    details: `wallElapsed=${wallElapsed}ms exitCode=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  };
}
```

- [ ] **Step 2: Wire it into `main()`**

In `main()`, add after the 15.1 push:

```typescript
  results.push(await test_15_3());
```

And update the fixtures write to include all results:

```typescript
  fs.writeFileSync(
    path.join(SPIKE_DIR, 'fixtures', 'spike-results.json'),
    JSON.stringify(results, null, 2)
  );
```

(Delete the earlier `spike-15-1-result.txt` writeFileSync line.)

- [ ] **Step 3: Run the runner again**

```bash
cd spike
npm run runner
```

Expected: both 15.1 and 15.3 pass. Wall elapsed should be ≥ 7500ms. If blocking did not wait (wall elapsed < 7500ms), the MCP transport is not synchronous — document this as a FAIL on 15.3.

- [ ] **Step 4: If 15.3 PASSES, commit**

```bash
cd ..
git add spike/src/spike-runner.ts
git commit -m "spike: test 15.3 — MCP tool blocking works [PASS]"
```

- [ ] **Step 5: If 15.3 FAILS, note it and CONTINUE**

Unlike 15.1, a failure on 15.3 is recoverable — we fall back to filesystem polling for HITL (documented in spec §15.3). Record the failure in `spike/notes.md` and continue to Task 6. Do not commit the 15.3 changes; revert instead:

```bash
git checkout spike/src/spike-runner.ts
```

and re-add only the `test_15_1` version committed earlier.

---

## Task 6: Spike test 15.2 — Read token usage from each CLI

**Files:**
- Create: `spike/src/token-probe.ts`
- Create: `spike/fixtures/gemini-output.txt` (captured)
- Create: `spike/fixtures/codex-output.txt` (captured)
- Create: `spike/fixtures/claude-code-output.txt` (captured)

- [ ] **Step 1: Verify CLI availability**

```bash
which gemini 2>&1 || echo "gemini NOT installed"
which codex 2>&1 || echo "codex NOT installed"
which claude 2>&1 || echo "claude NOT installed"
```

Expected: all three found. If any missing, install per their official docs BEFORE continuing, or skip that sub-test and mark as partial in the results.

- [ ] **Step 2: Write the token probe script**

```typescript
// spike/src/token-probe.ts
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SPIKE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FIXTURES = path.join(SPIKE_DIR, 'fixtures');

const TINY_PROMPT = 'Say the single word "pong" and nothing else.';

type ProbeResult = {
  cli: string;
  available: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

function runCLI(command: string, args: string[], stdin?: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      shell: process.platform === 'win32',
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        cli: command,
        available: false,
        stdout,
        stderr: `Spawn error: binary not found`,
        exitCode: -1,
        durationMs: Date.now() - start,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        cli: command,
        available: true,
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
      });
    });

    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function probeGemini(): Promise<ProbeResult> {
  // Gemini CLI: pipe prompt via stdin, expect usage on stderr or after output
  return runCLI('gemini', ['-p', TINY_PROMPT]);
}

async function probeCodex(): Promise<ProbeResult> {
  // Codex CLI: exec mode with prompt; may require subcommand "exec"
  return runCLI('codex', ['exec', TINY_PROMPT]);
}

async function probeClaudeCode(): Promise<ProbeResult> {
  // Claude Code: --print --output-format json should emit a usage block
  return runCLI('claude', ['--print', '--output-format', 'json', TINY_PROMPT]);
}

async function main() {
  console.log('=== Token Probe ===\n');

  const probes = [
    { name: 'gemini', fn: probeGemini, file: 'gemini-output.txt' },
    { name: 'codex', fn: probeCodex, file: 'codex-output.txt' },
    { name: 'claude-code', fn: probeClaudeCode, file: 'claude-code-output.txt' },
  ];

  for (const p of probes) {
    console.log(`>> Probing ${p.name}...`);
    const res = await p.fn();

    const blob = `=== ${p.name} ===
available: ${res.available}
exitCode: ${res.exitCode}
durationMs: ${res.durationMs}

--- stdout ---
${res.stdout}

--- stderr ---
${res.stderr}
`;

    fs.writeFileSync(path.join(FIXTURES, p.file), blob);
    console.log(`   saved to fixtures/${p.file}\n`);
  }
}

main().catch((err) => {
  console.error('Token probe crashed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Run the token probe**

```bash
cd spike
npm run token-probe
```

Expected: three files written to `spike/fixtures/`. Each should contain the actual output (even if an error — errors are also data).

- [ ] **Step 4: Manually inspect each fixture for token information**

```bash
cat spike/fixtures/gemini-output.txt
cat spike/fixtures/codex-output.txt
cat spike/fixtures/claude-code-output.txt
```

For each, identify:
1. **Is there a usage/token block?** (words like `tokens`, `input_tokens`, `output_tokens`, `usage`, `cost`)
2. **Where is it?** (stdout or stderr)
3. **What format?** (JSON object, YAML, free text, key=value)

Record findings in `spike/notes.md`:

```markdown
## Token parsing findings

### Gemini CLI
- available: yes/no
- token output location: stdout/stderr/both/none
- format: JSON / text / key-value / not visible
- example key paths: <if JSON, like `.usageMetadata.totalTokenCount`>

### Codex CLI
- available: yes/no
- ... same shape ...

### Claude Code CLI
- available: yes/no
- ... same shape ...
```

**A "no token info found" result on one or two CLIs is acceptable** — we degrade gracefully in MVP and estimate from prompt length. Only a total failure on all three is a problem, and even that doesn't block the spike's Go decision (see spec §15.2).

- [ ] **Step 5: Commit**

```bash
cd ..
git add spike/src/token-probe.ts
git commit -m "spike: test 15.2 — token probe for gemini/codex/claude-code

Captures stdout/stderr from each CLI run with a tiny prompt. Output
saved to spike/fixtures/ for manual parsing inspection."
```

---

## Task 7: Write the spike results report

**Files:**
- Create: `docs/superpowers/specs/2026-04-08-spike-results.md`

- [ ] **Step 1: Create the results doc**

Use this template verbatim, filling in the sections with real findings from the previous tasks:

```markdown
# Architecture Spike — Results

**Date:** 2026-04-08
**Spec reference:** `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §15
**Plan reference:** `docs/superpowers/plans/2026-04-08-phase-a-spike.md`

---

## Environment

- OS: <os + version>
- Node: <node --version>
- Claude Code CLI: <claude --version>
- Gemini CLI: <gemini --version or "not installed">
- Codex CLI: <codex --version or "not installed">

## MCP registration approach used

<Branch A with .mcp.json, or Branch B with `claude mcp add`, or something else. One paragraph describing how the spike registered the MCP server and why.>

---

## 15.1 — Can Claude Code call an MCP tool?

**Verdict:** PASS / FAIL

**Evidence:** <paste the `[PASS]` / `[FAIL]` line from the runner output + first 20 lines of details>

**Findings:**
- <any quirks: flag syntax, output format, permission behavior>
- <exact `claude` invocation that worked>
- <whether headless mode accepted the prompt as trailing arg or stdin>

---

## 15.2 — Can we read token usage from each CLI?

**Verdict:** PASS / PARTIAL / FAIL

| CLI | Token info available? | Location | Format | Parse-ability |
|---|---|---|---|---|
| Gemini | Y/N | stdout/stderr | JSON/text | easy/hard/impossible |
| Codex | Y/N | stdout/stderr | JSON/text | easy/hard/impossible |
| Claude Code | Y/N | stdout/stderr | JSON/text | easy/hard/impossible |

**Findings:**
- <for each CLI, describe the exact parse path or mention there's no token info>
- <degradation plan if any CLI fails>

---

## 15.3 — Does MCP tool blocking work?

**Verdict:** PASS / FAIL

**Evidence:** wall-elapsed time reported by the runner for a `block({ms: 8000})` call was <N>ms.

**Findings:**
- <did Claude Code wait the full duration?>
- <any timeouts or warnings during the block?>
- <fallback plan if FAIL: filesystem polling>

---

## Deviations from the plan

- <list anything you had to do differently from the task list>
- <reasons>

---

## Go / No-Go Decision

**Decision:** GO / NO-GO / GO-WITH-CAVEATS

**Rationale:**

<2-4 sentences explaining the decision. Reference the three tests.>

**If GO:** Next step is Phase B (Data model + migration). Proceed to write the Phase B plan.

**If GO-WITH-CAVEATS:** List the caveats and any adjustments needed to the pipeline design spec before Phase B.

**If NO-GO:** Explain what failed, what was tried, and propose either a redesign direction or a different executor (e.g., OpenHands, Aider, custom).

---

## Appendix — raw artifacts

- Spike runner output: `spike/fixtures/spike-results.json`
- Gemini probe: `spike/fixtures/gemini-output.txt`
- Codex probe: `spike/fixtures/codex-output.txt`
- Claude Code probe: `spike/fixtures/claude-code-output.txt`
```

- [ ] **Step 2: Fill it with real data**

Replace every `<...>` placeholder in the template with actual findings from Tasks 4, 5, 6. Read the fixtures and notes.md to get the exact values.

- [ ] **Step 3: Commit the results doc**

```bash
git add docs/superpowers/specs/2026-04-08-spike-results.md
git commit -m "docs(spec): architecture spike results — <GO/NO-GO>"
```

Replace `<GO/NO-GO>` with the actual verdict in the commit message.

---

## Task 8: Final decision gate

**Files:** none (decision only)

- [ ] **Step 1: Read the results doc top-to-bottom**

Open `docs/superpowers/specs/2026-04-08-spike-results.md` and read the whole thing.

- [ ] **Step 2: Decide and announce**

Based on the three test verdicts:

- **All three PASS** → announce **GO** to the user. Next action: write the Phase B plan.
- **15.1 PASS + 15.3 FAIL + 15.2 PASS/PARTIAL** → announce **GO WITH CAVEATS**. Update the spec to use filesystem polling HITL instead of MCP blocking. Next action: write the Phase B plan.
- **15.1 PASS + 15.2 FAIL entirely on all three CLIs** → announce **GO WITH CAVEATS**. Token tracking becomes "best-effort estimates only" in MVP; drop the token dashboard from MVP scope. Next action: write the Phase B plan.
- **15.1 FAIL** → announce **NO-GO**. Do NOT write Phase B plan. Surface the findings and propose alternatives to the user.

- [ ] **Step 3: Report to the user**

Post a brief summary in the conversation:

- Spike verdict: GO / NO-GO / GO-WITH-CAVEATS
- One-line summary of each of the three tests
- File link to the results doc
- Next recommended action

---

## Self-Review Checklist (Plan Author, before handoff)

- [x] Every task has concrete file paths, not placeholders
- [x] Every code step has complete code, not "TODO"
- [x] Commands are exact and runnable on Windows bash
- [x] Spike failure modes have explicit branching (stop on 15.1 fail, continue on 15.3 fail)
- [x] The results doc template is fully specified (no "fill in later")
- [x] Spec coverage: §15.1 → Task 4, §15.2 → Task 6, §15.3 → Task 5, spike deliverable → Task 7, Go/No-Go → Task 8
- [x] Type consistency: `SpikeResult` defined in Task 4 and reused in Task 5 with identical shape; `ProbeResult` defined in Task 6 standalone
- [x] No references to undefined symbols

---

## Success criteria (Phase A complete)

Phase A is done when:
1. `spike/` directory scaffolded, dependencies installed, server runs
2. Test 15.1 executed and verdict recorded
3. Test 15.3 executed and verdict recorded
4. Test 15.2 executed for all three CLIs and fixtures captured
5. `docs/superpowers/specs/2026-04-08-spike-results.md` written with real findings
6. Go/No-Go decision announced to the user
7. All commits landed on `main` (or the active branch)
