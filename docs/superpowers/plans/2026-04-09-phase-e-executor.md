# Phase E — Minimum Viable Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimum viable autonomous executor — MCP Server Notter (sidecar), a singleton Queue Worker, and Claude Code spawn plumbing — so a Phase D approved plan runs end-to-end and modifies real files in the project.

**Architecture:** Three units — a Node sidecar in `notter-mcp-server/` with 5 MCP tools over stdio, a pure TS library in `src/lib/executor/` that spawns `claude --print --mcp-config <file>` and polls a per-Action exec-state JSON file to mirror progress into the Zustand store, and small UI additions to `PlanReviewPanel` + `ActionDetail` so the user sees the Action progress from `queued` → `running` → `done|failed`. `ask_user` is stubbed in Phase E; ActionReport + full HITL + git isolation land in Phase F/G.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (MCP server), Node.js (sidecar runtime), Tauri 2 `@tauri-apps/plugin-shell` `Command.spawn()` for long-lived child, Zustand store for UI state, Vitest for unit tests.

**Spec reference:** `docs/superpowers/specs/2026-04-09-phase-e-executor-design.md` §1–§11 and `docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §7–§11 (MCP contract, execution flow, HITL, token tracking, trust levels).

**Pre-flight checks:**
- Phase D must be merged and working. All 4 stages produce a Plan Review Panel with refined tasks.
- `claude.exe` must be on PATH (Phase C validated this).
- `node` must be on PATH (used by `claude` to spawn the MCP subprocess — outside Tauri's allowlist but must be present).

---

## File Structure (new + modified)

```
notter-mcp-server/                          # NEW sidecar workspace
  package.json                              # deps: @modelcontextprotocol/sdk
  tsconfig.json                             # emit dist/
  src/
    server.ts                               # stdio MCP server glue + tool registration
    state.ts                                # atomic read/write exec-state/<id>.json
    tools/
      get-next-task.ts                      # returns first pending task, marks it running
      report-progress.ts                    # updates summary
      mark-done.ts                          # finalizes a task, appends priorTaskSummaries
      get-project-context.ts                # returns cwd + priorTaskSummaries
      ask-user.ts                           # STUB — always returns {answer:'proceed'}
  __tests__/
    state.test.ts
    get-next-task.test.ts
    report-progress.test.ts
    mark-done.test.ts
    get-project-context.test.ts
    ask-user.test.ts

src/lib/executor/                           # NEW library
  types.ts                                  # ExecStateFile, ExecTaskSnapshot, SpawnHandle
  exec-state.ts                             # shared read/write helpers (used by state-bridge)
  mcp-config.ts                             # build + write the --mcp-config JSON
  spawn-claude.ts                           # Tauri Command.spawn wrapper, streams exit
  state-bridge.ts                           # poll exec-state file, mirror into store
  initial-prompt.ts                         # build the initial prompt string
  queue-worker.ts                           # singleton loop
  index.ts                                  # re-exports
  __tests__/
    exec-state.test.ts
    mcp-config.test.ts
    spawn-claude.test.ts
    state-bridge.test.ts
    initial-prompt.test.ts
    queue-worker.test.ts

src/stores/actions-store.ts                 # MODIFIED: start queue worker on load()
src/components/planning/PlanReviewPanel.tsx # MODIFIED: banner when queued
src/components/actions/TaskItem.tsx         # MODIFIED: render summary line when running
```

**Boundary rules:**
- `notter-mcp-server/` has ZERO imports from `src/` (it's a separate runtime, spawned by claude).
- `src/lib/executor/` imports from `@/stores/actions-store` only via the `state-bridge` module so the polling surface is localized.
- `notter-mcp-server/src/tools/*` each export a single function `(input, state) => output`; no file I/O in the tool modules themselves — `state.ts` owns the file handling so tools are trivially unit-testable.

---

## Critical design decisions (from the spec, locked in)

1. **File-based IPC** (`$APPLOCALDATA/exec-state/<actionId>.json`). Queue Worker writes once at start, MCP tools mutate on each call (atomic temp+rename), Queue Worker polls every 500ms and mirrors into the store.
2. **ask_user is stubbed** — returns `{answer:'proceed'}`. Manual-trust tasks run without a gate in Phase E.
3. **No ActionReport** — Action transitions directly `running` → `done`/`failed` on executor exit.
4. **One Action at a time** — Queue Worker is a strict singleton with a `busy` flag.
5. **Claude spawn uses `Command.spawn()` (streaming)** not `Command.execute()` (one-shot) because the executor runs for minutes. Cleanup via the existing temp-file machinery + explicit `kill()` on timeout.
6. **MCP server shares no types with the renderer in Phase E.** Duplicate the shape. Phase G may add a shared types package.

---

## Task 1: Scaffold notter-mcp-server workspace

**Files:**
- Create: `notter-mcp-server/package.json`
- Create: `notter-mcp-server/tsconfig.json`
- Create: `notter-mcp-server/.gitignore`
- Create: `notter-mcp-server/src/server.ts` (stub)

- [ ] **Step 1: Create `notter-mcp-server/package.json`**

```json
{
  "name": "notter-mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "MCP server that exposes 5 Notter tools to Claude Code during autonomous execution.",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `notter-mcp-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/__tests__/**"]
}
```

- [ ] **Step 3: Create `notter-mcp-server/.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 4: Create stub `notter-mcp-server/src/server.ts`**

```typescript
#!/usr/bin/env node
// notter-mcp-server/src/server.ts
//
// Phase E entry point for the Notter MCP server. Spawned by claude-code
// via --mcp-config; communicates over stdio using @modelcontextprotocol/sdk.
//
// Real tool registration is added in Task 3.

console.error('[notter-mcp-server] boot stub — full server wired in Task 3');
```

- [ ] **Step 5: Install deps from the workspace root**

Run: `cd notter-mcp-server && npm install && cd ..`
Expected: `notter-mcp-server/node_modules/` exists with `@modelcontextprotocol/sdk`.

- [ ] **Step 6: Build once to verify tsconfig**

Run: `cd notter-mcp-server && npm run build && cd ..`
Expected: `notter-mcp-server/dist/server.js` created.

- [ ] **Step 7: Commit**

```bash
git add notter-mcp-server/package.json notter-mcp-server/tsconfig.json notter-mcp-server/.gitignore notter-mcp-server/src/server.ts
git commit -m "feat(mcp): scaffold notter-mcp-server sidecar workspace

Phase E, Task 1 of 14."
```

---

## Task 2: Exec state file shape + atomic read/write helpers

**Files:**
- Create: `notter-mcp-server/src/state.ts`
- Create: `notter-mcp-server/__tests__/state.test.ts`

The state file is the single source of truth while an Action is running. It is written by the Queue Worker on spawn and mutated by the 5 MCP tools.

- [ ] **Step 1: Write failing tests in `notter-mcp-server/__tests__/state.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadState, saveState, type ExecStateFile } from '../src/state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-state-'));
});

function makeState(actionId: string): ExecStateFile {
  return {
    actionId,
    projectPath: 'D:/project',
    projectName: 'proj',
    tasks: [
      {
        id: 't1',
        title: 'Task 1',
        refinedPrompt: 'Do the thing',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'semi',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
}

describe('state', () => {
  it('saveState writes JSON atomically', () => {
    const s = makeState('act-1');
    saveState(tmpDir, s);
    const filePath = path.join(tmpDir, 'act-1.json');
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.actionId).toBe('act-1');
    expect(parsed.tasks).toHaveLength(1);
  });

  it('loadState round-trips saveState', () => {
    const s = makeState('act-2');
    saveState(tmpDir, s);
    const loaded = loadState(tmpDir, 'act-2');
    expect(loaded).toEqual(s);
  });

  it('loadState returns null when file does not exist', () => {
    const loaded = loadState(tmpDir, 'nope');
    expect(loaded).toBeNull();
  });

  it('saveState writes through a temp file (atomicity smoke)', () => {
    const s = makeState('act-3');
    saveState(tmpDir, s);
    // After a successful save, the .tmp must NOT exist
    const tmpPath = path.join(tmpDir, 'act-3.json.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('saveState throws a clear error when the dir is unwritable', () => {
    expect(() =>
      saveState('/nonexistent/dir', makeState('act-4')),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd notter-mcp-server && npx vitest run __tests__/state.test.ts && cd ..`
Expected: FAIL (no state.ts yet).

- [ ] **Step 3: Create `notter-mcp-server/src/state.ts`**

```typescript
// notter-mcp-server/src/state.ts
//
// Phase E: read/write helpers for the per-Action exec state file. The file
// is the single source of truth while an Action is running; Queue Worker
// writes it once at start, MCP tools mutate it on each call, and Queue
// Worker polls it to mirror progress into the Zustand store.
//
// Atomic writes: write to <id>.json.tmp then rename to <id>.json. The
// rename is atomic on Windows and POSIX, so a crash mid-write cannot
// corrupt the file.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

export type ExecTaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type TrustLevel = 'auto' | 'semi' | 'manual';

export interface ExecTaskResult {
  summary: string;
  filesChanged: string[];
  testsRun: Array<{ command: string; passed: boolean; output?: string }>;
  errorMessage?: string;
}

export interface ExecTaskSnapshot {
  id: string;
  title: string;
  refinedPrompt: string;
  securityFlags: string[];
  dataFlags: string[];
  trustLevel: TrustLevel;
  status: ExecTaskStatus;
  summary?: string;
  result: ExecTaskResult | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface PriorTaskSummary {
  title: string;
  summary: string;
}

export interface ExecStateFile {
  actionId: string;
  projectPath: string;
  projectName: string;
  tasks: ExecTaskSnapshot[];
  priorTaskSummaries: PriorTaskSummary[];
}

function pathFor(stateDir: string, actionId: string): string {
  return path.join(stateDir, `${actionId}.json`);
}

export function loadState(
  stateDir: string,
  actionId: string,
): ExecStateFile | null {
  const filePath = pathFor(stateDir, actionId);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as ExecStateFile;
}

export function saveState(stateDir: string, state: ExecStateFile): void {
  const filePath = pathFor(stateDir, state.actionId);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd notter-mcp-server && npx vitest run __tests__/state.test.ts && cd ..`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add notter-mcp-server/src/state.ts notter-mcp-server/__tests__/state.test.ts
git commit -m "feat(mcp): ExecStateFile shape + atomic read/write helpers

state.ts owns all fs access for the per-Action exec state file. Atomic
write via temp+rename; loadState returns null on missing file so tool
handlers can signal 'no such action' cleanly.

Phase E, Task 2 of 14."
```

---

## Task 3: Implement get_next_task tool

**Files:**
- Create: `notter-mcp-server/src/tools/get-next-task.ts`
- Create: `notter-mcp-server/__tests__/get-next-task.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// notter-mcp-server/__tests__/get-next-task.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, loadState, type ExecStateFile } from '../src/state.js';
import { getNextTask } from '../src/tools/get-next-task.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-gnt-'));
});

function seed(actionId: string, overrides: Partial<ExecStateFile> = {}): void {
  const state: ExecStateFile = {
    actionId,
    projectPath: 'D:/p',
    projectName: 'p',
    tasks: [
      {
        id: 't1',
        title: 'One',
        refinedPrompt: 'Do 1',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'auto',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      },
      {
        id: 't2',
        title: 'Two',
        refinedPrompt: 'Do 2',
        securityFlags: ['sanitize'],
        dataFlags: [],
        trustLevel: 'semi',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
    ...overrides,
  };
  saveState(tmpDir, state);
}

describe('get_next_task', () => {
  it('returns the first pending task and marks it running', () => {
    seed('act-1');
    const out = getNextTask(tmpDir, { action_id: 'act-1' });
    expect('task_id' in out).toBe(true);
    if ('task_id' in out) {
      expect(out.task_id).toBe('t1');
      expect(out.title).toBe('One');
      expect(out.refined_prompt).toBe('Do 1');
      expect(out.trust_level).toBe('auto');
      expect(out.project_context.path).toBe('D:/p');
      expect(out.project_context.name).toBe('p');
    }

    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].status).toBe('running');
    expect(after.tasks[0].startedAt).toBeGreaterThan(0);
    expect(after.tasks[1].status).toBe('pending');
  });

  it('skips tasks that are already done/failed/running', () => {
    seed('act-2');
    const state = loadState(tmpDir, 'act-2')!;
    state.tasks[0].status = 'done';
    state.tasks[0].completedAt = Date.now();
    saveState(tmpDir, state);

    const out = getNextTask(tmpDir, { action_id: 'act-2' });
    expect('task_id' in out).toBe(true);
    if ('task_id' in out) expect(out.task_id).toBe('t2');
  });

  it('returns {done:true} when no pending tasks remain', () => {
    seed('act-3');
    const state = loadState(tmpDir, 'act-3')!;
    state.tasks.forEach((t) => (t.status = 'done'));
    saveState(tmpDir, state);

    const out = getNextTask(tmpDir, { action_id: 'act-3' });
    expect(out).toEqual({ done: true });
  });

  it('throws when the action state file is missing', () => {
    expect(() => getNextTask(tmpDir, { action_id: 'ghost' })).toThrow(
      /not found/i,
    );
  });

  it('marks the task running with the current timestamp within 2s', () => {
    seed('act-4');
    const before = Date.now();
    getNextTask(tmpDir, { action_id: 'act-4' });
    const after = loadState(tmpDir, 'act-4')!;
    expect(after.tasks[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(after.tasks[0].startedAt).toBeLessThan(before + 2000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd notter-mcp-server && npx vitest run __tests__/get-next-task.test.ts && cd ..`
Expected: FAIL (no get-next-task.ts yet).

- [ ] **Step 3: Implement `notter-mcp-server/src/tools/get-next-task.ts`**

```typescript
// notter-mcp-server/src/tools/get-next-task.ts
//
// Phase E — Tool 1 of 5: get_next_task.
// Returns the first pending task from the exec state file, enriched with
// project context. Side-effect: marks the returned task as `running` with
// startedAt = now so the Queue Worker sees the transition on its next
// poll tick. If there are no pending tasks, returns { done: true }.

import { loadState, saveState } from '../state.js';

export interface GetNextTaskInput {
  action_id: string;
}

export interface ProjectContextOut {
  path: string;
  name: string;
  is_greenfield: boolean;
}

export interface GetNextTaskOut {
  task_id: string;
  title: string;
  refined_prompt: string;
  security_flags: string[];
  data_flags: string[];
  trust_level: 'auto' | 'semi' | 'manual';
  project_context: ProjectContextOut;
}

export type GetNextTaskResult = GetNextTaskOut | { done: true };

export function getNextTask(
  stateDir: string,
  input: GetNextTaskInput,
): GetNextTaskResult {
  const state = loadState(stateDir, input.action_id);
  if (!state) {
    throw new Error(`exec state for action ${input.action_id} not found`);
  }

  const nextIdx = state.tasks.findIndex((t) => t.status === 'pending');
  if (nextIdx === -1) {
    return { done: true };
  }

  const now = Date.now();
  state.tasks[nextIdx].status = 'running';
  state.tasks[nextIdx].startedAt = now;
  saveState(stateDir, state);

  const task = state.tasks[nextIdx];
  return {
    task_id: task.id,
    title: task.title,
    refined_prompt: task.refinedPrompt,
    security_flags: task.securityFlags,
    data_flags: task.dataFlags,
    trust_level: task.trustLevel,
    project_context: {
      path: state.projectPath,
      name: state.projectName,
      is_greenfield: false, // Phase E: detection in Phase F
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd notter-mcp-server && npx vitest run __tests__/get-next-task.test.ts && cd ..`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add notter-mcp-server/src/tools/get-next-task.ts notter-mcp-server/__tests__/get-next-task.test.ts
git commit -m "feat(mcp): get_next_task tool — return first pending task, mark running

Phase E, Task 3 of 14."
```

---

## Task 4: Implement report_progress tool

**Files:**
- Create: `notter-mcp-server/src/tools/report-progress.ts`
- Create: `notter-mcp-server/__tests__/report-progress.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// notter-mcp-server/__tests__/report-progress.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, loadState, type ExecStateFile } from '../src/state.js';
import { reportProgress } from '../src/tools/report-progress.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-rp-'));
});

function seed(): void {
  const state: ExecStateFile = {
    actionId: 'act-1',
    projectPath: 'D:/p',
    projectName: 'p',
    tasks: [
      {
        id: 't1',
        title: 'One',
        refinedPrompt: 'Do 1',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'semi',
        status: 'running',
        result: null,
        startedAt: Date.now(),
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
  saveState(tmpDir, state);
}

describe('report_progress', () => {
  it('updates the summary field on the targeted task', () => {
    seed();
    const out = reportProgress(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      status: 'running',
      summary: 'Created file foo.ts',
    });
    expect(out).toEqual({ ok: true });
    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].summary).toBe('Created file foo.ts');
    expect(after.tasks[0].status).toBe('running');
  });

  it('does not transition status even when a different status is passed', () => {
    seed();
    reportProgress(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      status: 'blocked_hitl',
      summary: 'blocked by user',
    });
    const after = loadState(tmpDir, 'act-1')!;
    // Phase E: status is authoritative, input status is ignored.
    expect(after.tasks[0].status).toBe('running');
  });

  it('throws when task_id does not exist', () => {
    seed();
    expect(() =>
      reportProgress(tmpDir, {
        action_id: 'act-1',
        task_id: 'unknown',
        status: 'running',
        summary: 'x',
      }),
    ).toThrow(/task .* not found/i);
  });

  it('throws when action state is missing', () => {
    expect(() =>
      reportProgress(tmpDir, {
        action_id: 'ghost',
        task_id: 't1',
        status: 'running',
        summary: 'x',
      }),
    ).toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd notter-mcp-server && npx vitest run __tests__/report-progress.test.ts && cd ..`
Expected: FAIL (no report-progress.ts yet).

- [ ] **Step 3: Implement `notter-mcp-server/src/tools/report-progress.ts`**

```typescript
// notter-mcp-server/src/tools/report-progress.ts
//
// Phase E — Tool 2 of 5: report_progress.
// Updates a task's `summary` field with a short human-readable status.
// The `status` input field is accepted for contract stability but IGNORED
// in Phase E — status is authoritative per the tool that set it
// (get_next_task → running, mark_done → done|failed). Phase F may honor
// blocked_hitl.

import { loadState, saveState } from '../state.js';

export interface ReportProgressInput {
  action_id: string;
  task_id: string;
  status: 'running' | 'blocked_hitl';
  summary: string;
}

export interface ReportProgressOut {
  ok: true;
}

export function reportProgress(
  stateDir: string,
  input: ReportProgressInput,
): ReportProgressOut {
  const state = loadState(stateDir, input.action_id);
  if (!state) {
    throw new Error(`exec state for action ${input.action_id} not found`);
  }
  const task = state.tasks.find((t) => t.id === input.task_id);
  if (!task) {
    throw new Error(
      `task ${input.task_id} not found in action ${input.action_id}`,
    );
  }
  task.summary = input.summary;
  saveState(stateDir, state);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd notter-mcp-server && npx vitest run __tests__/report-progress.test.ts && cd ..`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add notter-mcp-server/src/tools/report-progress.ts notter-mcp-server/__tests__/report-progress.test.ts
git commit -m "feat(mcp): report_progress tool — update task summary (status ignored in Phase E)

Phase E, Task 4 of 14."
```

---

## Task 5: Implement mark_done tool

**Files:**
- Create: `notter-mcp-server/src/tools/mark-done.ts`
- Create: `notter-mcp-server/__tests__/mark-done.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// notter-mcp-server/__tests__/mark-done.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, loadState, type ExecStateFile } from '../src/state.js';
import { markDone } from '../src/tools/mark-done.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-md-'));
});

function seed(): void {
  const state: ExecStateFile = {
    actionId: 'act-1',
    projectPath: 'D:/p',
    projectName: 'p',
    tasks: [
      {
        id: 't1',
        title: 'One',
        refinedPrompt: 'Do 1',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'semi',
        status: 'running',
        result: null,
        startedAt: Date.now() - 1000,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
  saveState(tmpDir, state);
}

describe('mark_done', () => {
  it('marks a task done on success and appends priorTaskSummaries', () => {
    seed();
    const out = markDone(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      summary: 'Created file foo.ts and ran tests',
      files_changed: ['foo.ts'],
      tests_run: [{ command: 'npm test', passed: true }],
    });
    expect(out).toEqual({ ok: true });

    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].status).toBe('done');
    expect(after.tasks[0].completedAt).toBeGreaterThan(0);
    expect(after.tasks[0].result).toEqual({
      summary: 'Created file foo.ts and ran tests',
      filesChanged: ['foo.ts'],
      testsRun: [{ command: 'npm test', passed: true }],
    });
    expect(after.priorTaskSummaries).toHaveLength(1);
    expect(after.priorTaskSummaries[0]).toEqual({
      title: 'One',
      summary: 'Created file foo.ts and ran tests',
    });
  });

  it('marks a task failed when error_message is present', () => {
    seed();
    markDone(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      summary: 'Attempted to create file but permission denied',
      files_changed: [],
      error_message: 'EACCES: permission denied',
    });
    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].status).toBe('failed');
    expect(after.tasks[0].result!.errorMessage).toBe(
      'EACCES: permission denied',
    );
  });

  it('throws when task_id does not exist', () => {
    seed();
    expect(() =>
      markDone(tmpDir, {
        action_id: 'act-1',
        task_id: 'unknown',
        summary: 'x',
        files_changed: [],
      }),
    ).toThrow(/task .* not found/i);
  });

  it('defaults testsRun to an empty array when omitted', () => {
    seed();
    markDone(tmpDir, {
      action_id: 'act-1',
      task_id: 't1',
      summary: 'ok',
      files_changed: [],
    });
    const after = loadState(tmpDir, 'act-1')!;
    expect(after.tasks[0].result!.testsRun).toEqual([]);
  });

  it('throws when action state is missing', () => {
    expect(() =>
      markDone(tmpDir, {
        action_id: 'ghost',
        task_id: 't1',
        summary: 'x',
        files_changed: [],
      }),
    ).toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd notter-mcp-server && npx vitest run __tests__/mark-done.test.ts && cd ..`
Expected: FAIL (no mark-done.ts yet).

- [ ] **Step 3: Implement `notter-mcp-server/src/tools/mark-done.ts`**

```typescript
// notter-mcp-server/src/tools/mark-done.ts
//
// Phase E — Tool 3 of 5: mark_done.
// Finalizes a task. Sets status to 'done' on success or 'failed' when
// error_message is present. Fills the task's result object and appends
// a { title, summary } entry to priorTaskSummaries so later calls to
// get_project_context can surface it.

import { loadState, saveState } from '../state.js';

export interface MarkDoneTestRun {
  command: string;
  passed: boolean;
  output?: string;
}

export interface MarkDoneInput {
  action_id: string;
  task_id: string;
  summary: string;
  files_changed: string[];
  tests_run?: MarkDoneTestRun[];
  error_message?: string;
}

export interface MarkDoneOut {
  ok: true;
}

export function markDone(
  stateDir: string,
  input: MarkDoneInput,
): MarkDoneOut {
  const state = loadState(stateDir, input.action_id);
  if (!state) {
    throw new Error(`exec state for action ${input.action_id} not found`);
  }
  const task = state.tasks.find((t) => t.id === input.task_id);
  if (!task) {
    throw new Error(
      `task ${input.task_id} not found in action ${input.action_id}`,
    );
  }
  task.status = input.error_message ? 'failed' : 'done';
  task.completedAt = Date.now();
  task.result = {
    summary: input.summary,
    filesChanged: input.files_changed,
    testsRun: input.tests_run ?? [],
    ...(input.error_message ? { errorMessage: input.error_message } : {}),
  };
  state.priorTaskSummaries.push({
    title: task.title,
    summary: input.summary,
  });
  saveState(stateDir, state);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd notter-mcp-server && npx vitest run __tests__/mark-done.test.ts && cd ..`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add notter-mcp-server/src/tools/mark-done.ts notter-mcp-server/__tests__/mark-done.test.ts
git commit -m "feat(mcp): mark_done tool — finalize task with result + priorTaskSummaries

Phase E, Task 5 of 14."
```

---

## Task 6: Implement get_project_context + ask_user stub

**Files:**
- Create: `notter-mcp-server/src/tools/get-project-context.ts`
- Create: `notter-mcp-server/src/tools/ask-user.ts`
- Create: `notter-mcp-server/__tests__/get-project-context.test.ts`
- Create: `notter-mcp-server/__tests__/ask-user.test.ts`

- [ ] **Step 1: Write failing tests for get_project_context**

```typescript
// notter-mcp-server/__tests__/get-project-context.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, type ExecStateFile } from '../src/state.js';
import { getProjectContext } from '../src/tools/get-project-context.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-gpc-'));
});

function seed(): void {
  const state: ExecStateFile = {
    actionId: 'act-1',
    projectPath: 'D:/my/project',
    projectName: 'my-project',
    tasks: [],
    priorTaskSummaries: [
      { title: 'First task', summary: 'Created initial scaffold' },
      { title: 'Second task', summary: 'Added config file' },
    ],
  };
  saveState(tmpDir, state);
}

describe('get_project_context', () => {
  it('returns path, name, and priorTaskSummaries', () => {
    seed();
    const out = getProjectContext(tmpDir, {
      project_id: 'act-1',
      include_file_tree: false,
    });
    expect(out.path).toBe('D:/my/project');
    expect(out.name).toBe('my-project');
    expect(out.is_greenfield).toBe(false);
    expect(out.prior_tasks).toHaveLength(2);
    expect(out.prior_tasks[0].title).toBe('First task');
  });

  it('throws when the action state is missing', () => {
    expect(() =>
      getProjectContext(tmpDir, { project_id: 'ghost' }),
    ).toThrow(/not found/i);
  });

  it('omits file_tree in Phase E even when requested', () => {
    seed();
    const out = getProjectContext(tmpDir, {
      project_id: 'act-1',
      include_file_tree: true,
    });
    expect(out.file_tree).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write failing tests for ask_user stub**

```typescript
// notter-mcp-server/__tests__/ask-user.test.ts
import { describe, it, expect } from 'vitest';
import { askUser } from '../src/tools/ask-user.js';

describe('ask_user (Phase E stub)', () => {
  it('always returns {answer:"proceed", timeout:false}', () => {
    expect(
      askUser({
        action_id: 'act-1',
        task_id: 't1',
        question: 'Is it safe?',
      }),
    ).toEqual({ answer: 'proceed', timeout: false });
  });

  it('ignores options in Phase E', () => {
    expect(
      askUser({
        action_id: 'act-1',
        task_id: 't1',
        question: 'Pick one',
        options: ['a', 'b'],
      }),
    ).toEqual({ answer: 'proceed', timeout: false });
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `cd notter-mcp-server && npx vitest run __tests__/get-project-context.test.ts __tests__/ask-user.test.ts && cd ..`
Expected: FAIL.

- [ ] **Step 4: Implement `notter-mcp-server/src/tools/get-project-context.ts`**

```typescript
// notter-mcp-server/src/tools/get-project-context.ts
//
// Phase E — Tool 4 of 5: get_project_context.
// Returns the project path, name, and the list of prior-task summaries
// so claude can orient itself without burning tokens re-reading files.
// file_tree is NOT implemented in Phase E (YAGNI until claude asks for it).

import { loadState, type PriorTaskSummary } from '../state.js';

export interface GetProjectContextInput {
  project_id: string; // we use action_id here; kept the spec name
  include_file_tree?: boolean;
}

export interface GetProjectContextOut {
  path: string;
  name: string;
  is_greenfield: boolean;
  prior_tasks: PriorTaskSummary[];
  file_tree?: string[];
}

export function getProjectContext(
  stateDir: string,
  input: GetProjectContextInput,
): GetProjectContextOut {
  const state = loadState(stateDir, input.project_id);
  if (!state) {
    throw new Error(`exec state for action ${input.project_id} not found`);
  }
  return {
    path: state.projectPath,
    name: state.projectName,
    is_greenfield: false, // Phase F will detect
    prior_tasks: state.priorTaskSummaries,
  };
}
```

- [ ] **Step 5: Implement `notter-mcp-server/src/tools/ask-user.ts`**

```typescript
// notter-mcp-server/src/tools/ask-user.ts
//
// Phase E — Tool 5 of 5: ask_user (STUB).
// Always returns { answer: 'proceed', timeout: false }. Phase F replaces
// this with a real HITL modal that blocks the tool response until the
// user answers. The initial prompt instructs claude to call this for
// manual-trust tasks, so keeping the stub means those tasks run through
// without a gate — documented known limitation.

export interface AskUserInput {
  action_id: string;
  task_id: string;
  question: string;
  options?: string[];
}

export interface AskUserOut {
  answer: string;
  timeout: boolean;
}

export function askUser(_input: AskUserInput): AskUserOut {
  // eslint-disable-next-line no-console
  console.error(
    `[notter-mcp-server] ask_user stub returning 'proceed' for question: ${_input.question}`,
  );
  return { answer: 'proceed', timeout: false };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd notter-mcp-server && npx vitest run && cd ..`
Expected: all 5 test files pass (state, get-next-task, report-progress, mark-done, get-project-context, ask-user).

- [ ] **Step 7: Commit**

```bash
git add notter-mcp-server/src/tools/get-project-context.ts notter-mcp-server/src/tools/ask-user.ts notter-mcp-server/__tests__/get-project-context.test.ts notter-mcp-server/__tests__/ask-user.test.ts
git commit -m "feat(mcp): get_project_context + ask_user stub

Phase E, Task 6 of 14."
```

---

## Task 7: Wire MCP server glue (server.ts) + build

**Files:**
- Modify: `notter-mcp-server/src/server.ts`

This task wires the 5 tool handlers into `@modelcontextprotocol/sdk`'s Server + stdio transport.

- [ ] **Step 1: Rewrite `notter-mcp-server/src/server.ts`**

```typescript
#!/usr/bin/env node
// notter-mcp-server/src/server.ts
//
// Phase E: entry point for the Notter MCP server. Spawned by claude-code
// via --mcp-config; communicates over stdio using @modelcontextprotocol/sdk.
//
// CLI args:
//   --action-id <id>   (required)  — scopes this server instance to a single Action
//   --state-dir <path> (optional)  — override the exec-state directory; defaults to
//                                    AGENTTRACK_STATE_DIR env var, then process.cwd()/exec-state
//
// The server reads/writes $STATE_DIR/<id>.json on every tool call.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getNextTask } from './tools/get-next-task.js';
import { reportProgress } from './tools/report-progress.js';
import { markDone } from './tools/mark-done.js';
import { getProjectContext } from './tools/get-project-context.js';
import { askUser } from './tools/ask-user.js';

interface ParsedArgs {
  actionId: string;
  stateDir: string;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  let actionId: string | undefined;
  let stateDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id') actionId = argv[++i];
    else if (argv[i] === '--state-dir') stateDir = argv[++i];
  }
  if (!actionId) {
    console.error('[notter-mcp-server] --action-id is required');
    process.exit(1);
  }
  stateDir =
    stateDir ??
    process.env.AGENTTRACK_STATE_DIR ??
    `${process.cwd()}/exec-state`;
  return { actionId, stateDir };
}

const { actionId, stateDir } = parseArgs();

const server = new Server(
  { name: 'notter', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'notter.get_next_task',
      description:
        'Return the next pending task for this Action. Returns {done:true} when all tasks are complete.',
      inputSchema: {
        type: 'object',
        properties: { action_id: { type: 'string' } },
        required: ['action_id'],
      },
    },
    {
      name: 'notter.report_progress',
      description:
        'Update a running task with a short human-readable status.',
      inputSchema: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
          task_id: { type: 'string' },
          status: { type: 'string', enum: ['running', 'blocked_hitl'] },
          summary: { type: 'string' },
        },
        required: ['action_id', 'task_id', 'status', 'summary'],
      },
    },
    {
      name: 'notter.mark_done',
      description:
        'Finalize a task with summary, files_changed, and optional tests_run/error_message.',
      inputSchema: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
          task_id: { type: 'string' },
          summary: { type: 'string' },
          files_changed: { type: 'array', items: { type: 'string' } },
          tests_run: { type: 'array' },
          error_message: { type: 'string' },
        },
        required: ['action_id', 'task_id', 'summary', 'files_changed'],
      },
    },
    {
      name: 'notter.get_project_context',
      description:
        'Return project path, name, and summaries of prior tasks completed in this Action.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          include_file_tree: { type: 'boolean' },
        },
        required: ['project_id'],
      },
    },
    {
      name: 'notter.ask_user',
      description:
        'Ask the human operator a question and wait for their answer. (Phase E: stubbed to always return "proceed".)',
      inputSchema: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
          task_id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['action_id', 'task_id', 'question'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (name) {
      case 'notter.get_next_task':
        result = getNextTask(stateDir, { action_id: a.action_id as string });
        break;
      case 'notter.report_progress':
        result = reportProgress(stateDir, {
          action_id: a.action_id as string,
          task_id: a.task_id as string,
          status: a.status as 'running' | 'blocked_hitl',
          summary: a.summary as string,
        });
        break;
      case 'notter.mark_done':
        result = markDone(stateDir, {
          action_id: a.action_id as string,
          task_id: a.task_id as string,
          summary: a.summary as string,
          files_changed: a.files_changed as string[],
          tests_run: a.tests_run as
            | { command: string; passed: boolean; output?: string }[]
            | undefined,
          error_message: a.error_message as string | undefined,
        });
        break;
      case 'notter.get_project_context':
        result = getProjectContext(stateDir, {
          project_id: a.project_id as string,
          include_file_tree: a.include_file_tree as boolean | undefined,
        });
        break;
      case 'notter.ask_user':
        result = askUser({
          action_id: a.action_id as string,
          task_id: a.task_id as string,
          question: a.question as string,
          options: a.options as string[] | undefined,
        });
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `notter-mcp-server error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[notter-mcp-server] ready (actionId=${actionId} stateDir=${stateDir})`,
);
```

- [ ] **Step 2: Rebuild**

Run: `cd notter-mcp-server && npm run build && cd ..`
Expected: clean `tsc` output; `dist/server.js` updated.

- [ ] **Step 3: Smoke test that the built server boots**

Run: `node notter-mcp-server/dist/server.js --action-id test 2>&1 | head -5 &
sleep 1
kill %1 2>/dev/null`
Expected: stderr line `[notter-mcp-server] ready (actionId=test stateDir=...)`.

- [ ] **Step 4: Commit**

```bash
git add notter-mcp-server/src/server.ts
git commit -m "feat(mcp): wire 5 tools into stdio Server + CLI arg parsing

Phase E, Task 7 of 14."
```

---

## Task 8: Executor types + mcp-config builder + initial prompt

**Files:**
- Create: `src/lib/executor/types.ts`
- Create: `src/lib/executor/mcp-config.ts`
- Create: `src/lib/executor/initial-prompt.ts`
- Create: `src/lib/executor/__tests__/mcp-config.test.ts`
- Create: `src/lib/executor/__tests__/initial-prompt.test.ts`

- [ ] **Step 1: Create `src/lib/executor/types.ts`**

```typescript
// src/lib/executor/types.ts
//
// Phase E: shared types for the executor library. These mirror the
// ExecStateFile shape that lives in notter-mcp-server/src/state.ts —
// duplicated intentionally in Phase E (see spec §3.3). Phase G may
// extract a shared types package.

import type { TrustLevel } from '@/types/actions';

export type ExecTaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ExecTaskResult {
  summary: string;
  filesChanged: string[];
  testsRun: Array<{ command: string; passed: boolean; output?: string }>;
  errorMessage?: string;
}

export interface ExecTaskSnapshot {
  id: string;
  title: string;
  refinedPrompt: string;
  securityFlags: string[];
  dataFlags: string[];
  trustLevel: TrustLevel;
  status: ExecTaskStatus;
  summary?: string;
  result: ExecTaskResult | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface PriorTaskSummary {
  title: string;
  summary: string;
}

export interface ExecStateFile {
  actionId: string;
  projectPath: string;
  projectName: string;
  tasks: ExecTaskSnapshot[];
  priorTaskSummaries: PriorTaskSummary[];
}

/** Handle returned by spawnClaudeExecutor — used by the Queue Worker
 *  to await exit and clean up temp files. */
export interface SpawnHandle {
  /** Resolves with the exit code (non-null) or -1 on abnormal exit. */
  waitForExit: () => Promise<number>;
  /** Best-effort kill; no-op if the process already exited. */
  kill: () => Promise<void>;
}
```

- [ ] **Step 2: Write failing tests for mcp-config**

```typescript
// src/lib/executor/__tests__/mcp-config.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  exists: vi.fn(async () => true),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

import {
  buildMcpConfigJson,
  writeMcpConfigFile,
} from '@/lib/executor/mcp-config';

describe('buildMcpConfigJson', () => {
  it('returns the expected mcpServers shape', () => {
    const json = buildMcpConfigJson({
      serverAbsolutePath: 'D:/repo/notter-mcp-server/dist/server.js',
      actionId: 'act-1',
      stateDir: 'C:/appdata/exec-state',
    });
    expect(json).toEqual({
      mcpServers: {
        notter: {
          command: 'node',
          args: [
            'D:/repo/notter-mcp-server/dist/server.js',
            '--action-id',
            'act-1',
            '--state-dir',
            'C:/appdata/exec-state',
          ],
          env: {},
        },
      },
    });
  });
});

describe('writeMcpConfigFile', () => {
  it('resolves a path under $APPLOCALDATA/exec-state/', async () => {
    const p = await writeMcpConfigFile({
      actionId: 'act-2',
      serverAbsolutePath: 'D:/repo/notter-mcp-server/dist/server.js',
      stateDir: 'C:/appdata/exec-state',
    });
    expect(p).toMatch(/mcp-config-act-2\.json$/);
  });
});
```

- [ ] **Step 3: Write failing tests for initial-prompt**

```typescript
// src/lib/executor/__tests__/initial-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildInitialPrompt } from '@/lib/executor/initial-prompt';

describe('buildInitialPrompt', () => {
  it('includes the action id and the mandatory workflow steps', () => {
    const p = buildInitialPrompt('act-xyz');
    expect(p).toContain('act-xyz');
    expect(p).toContain('notter.get_next_task');
    expect(p).toContain('notter.mark_done');
    expect(p).toContain('notter.report_progress');
    expect(p).toContain('notter.ask_user');
    expect(p).toContain('trust_level');
    expect(p).toContain('{"done": true}');
  });

  it('produces a single string (no markdown headers)', () => {
    const p = buildInitialPrompt('act-1');
    expect(p.startsWith('#')).toBe(false);
    expect(p.length).toBeGreaterThan(100);
    expect(p.length).toBeLessThan(2000);
  });
});
```

- [ ] **Step 4: Run both test files to verify they fail**

Run: `npx vitest run src/lib/executor/__tests__/mcp-config.test.ts src/lib/executor/__tests__/initial-prompt.test.ts`
Expected: FAIL (no modules yet).

- [ ] **Step 5: Create `src/lib/executor/mcp-config.ts`**

```typescript
// src/lib/executor/mcp-config.ts
//
// Phase E: build the per-Action --mcp-config JSON that claude-code reads
// at spawn time to discover the notter MCP server. Each spawn writes a
// fresh config file under $APPLOCALDATA/exec-state/ so parallel runs
// (future) won't step on each other.

import { writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';

export interface McpConfigInput {
  /** Absolute path to notter-mcp-server/dist/server.js. */
  serverAbsolutePath: string;
  actionId: string;
  /** Absolute path to the exec-state directory. */
  stateDir: string;
}

export interface McpConfigJson {
  mcpServers: {
    notter: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
}

export function buildMcpConfigJson(input: McpConfigInput): McpConfigJson {
  return {
    mcpServers: {
      notter: {
        command: 'node',
        args: [
          input.serverAbsolutePath,
          '--action-id',
          input.actionId,
          '--state-dir',
          input.stateDir,
        ],
        env: {},
      },
    },
  };
}

export async function ensureExecStateDir(): Promise<string> {
  const dir = await appLocalDataDir();
  const execStateDir = await join(dir, 'exec-state');
  try {
    if (!(await exists(execStateDir))) {
      await mkdir(execStateDir, { recursive: true });
    }
  } catch {
    // Non-fatal; writeTextFile surfaces the real error.
  }
  return execStateDir;
}

export async function writeMcpConfigFile(input: {
  actionId: string;
  serverAbsolutePath: string;
  stateDir: string;
}): Promise<string> {
  const dir = await ensureExecStateDir();
  const filePath = await join(dir, `mcp-config-${input.actionId}.json`);
  const json = buildMcpConfigJson(input);
  await writeTextFile(filePath, JSON.stringify(json, null, 2));
  return filePath;
}
```

- [ ] **Step 6: Create `src/lib/executor/initial-prompt.ts`**

```typescript
// src/lib/executor/initial-prompt.ts
//
// Phase E: builds the initial prompt we inject into claude-code when we
// spawn the executor. The prompt is deliberately short and directive —
// claude-code performs best with clear stepwise instructions that
// reference the exact MCP tool names. Any style guidance that isn't
// operational lives in the system prompt of the planning stages, not
// here.

export function buildInitialPrompt(actionId: string): string {
  return [
    `You are the autonomous executor for action ${actionId}. Use the notter MCP tools to retrieve and complete tasks one at a time.`,
    '',
    'Workflow (follow literally):',
    '1. Call notter.get_next_task with action_id="' +
      actionId +
      '". If it returns {"done": true}, stop and exit.',
    '2. If the task has trust_level="manual", call notter.ask_user first with the refined prompt and wait for confirmation.',
    '3. Follow refined_prompt literally. Respect security_flags and data_flags as hard constraints. Stay inside the project cwd.',
    '4. Call notter.report_progress as you make meaningful progress (file created, command run, etc.).',
    '5. When the task is complete, call notter.mark_done with a summary, files_changed list, and tests_run results if any. On failure, include error_message.',
    '6. Repeat from step 1 until get_next_task returns {"done": true}.',
    '',
    'Do not stop to explain what you are doing — call the MCP tools to report progress instead. When you reach done:true, you may write a final short summary and exit.',
  ].join('\n');
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/lib/executor/__tests__/mcp-config.test.ts src/lib/executor/__tests__/initial-prompt.test.ts`
Expected: all tests PASS.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/lib/executor/types.ts src/lib/executor/mcp-config.ts src/lib/executor/initial-prompt.ts src/lib/executor/__tests__/mcp-config.test.ts src/lib/executor/__tests__/initial-prompt.test.ts
git commit -m "feat(executor): types + mcp-config builder + initial prompt

Phase E, Task 8 of 14."
```

---

## Task 9: exec-state helpers + state-bridge poller

**Files:**
- Create: `src/lib/executor/exec-state.ts`
- Create: `src/lib/executor/state-bridge.ts`
- Create: `src/lib/executor/__tests__/exec-state.test.ts`
- Create: `src/lib/executor/__tests__/state-bridge.test.ts`

- [ ] **Step 1: Write failing tests for exec-state**

```typescript
// src/lib/executor/__tests__/exec-state.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let writeCalls: { path: string; content: string }[] = [];
let readReturn: string | null = null;

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async (p: string, c: string) => {
    writeCalls.push({ path: p, content: c });
  }),
  readTextFile: vi.fn(async () => {
    if (readReturn === null) throw new Error('ENOENT');
    return readReturn;
  }),
  exists: vi.fn(async () => readReturn !== null),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

import {
  writeExecState,
  readExecState,
  execStatePath,
} from '@/lib/executor/exec-state';
import type { ExecStateFile } from '@/lib/executor/types';

beforeEach(() => {
  writeCalls = [];
  readReturn = null;
});

const sample: ExecStateFile = {
  actionId: 'act-1',
  projectPath: 'D:/p',
  projectName: 'p',
  tasks: [],
  priorTaskSummaries: [],
};

describe('exec-state', () => {
  it('execStatePath resolves under $APPLOCALDATA/exec-state/', async () => {
    const p = await execStatePath('act-42');
    expect(p).toBe('C:/appdata/exec-state/act-42.json');
  });

  it('writeExecState serializes JSON and writes to the correct path', async () => {
    await writeExecState(sample);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].path).toBe('C:/appdata/exec-state/act-1.json');
    expect(JSON.parse(writeCalls[0].content).actionId).toBe('act-1');
  });

  it('readExecState returns parsed state when the file exists', async () => {
    readReturn = JSON.stringify(sample);
    const s = await readExecState('act-1');
    expect(s).toEqual(sample);
  });

  it('readExecState returns null when the file is missing', async () => {
    readReturn = null;
    const s = await readExecState('ghost');
    expect(s).toBeNull();
  });
});
```

- [ ] **Step 2: Write failing tests for state-bridge**

```typescript
// src/lib/executor/__tests__/state-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockedState: unknown = null;
vi.mock('@/lib/executor/exec-state', () => ({
  readExecState: vi.fn(async () => mockedState),
  writeExecState: vi.fn(async () => {}),
  execStatePath: vi.fn(async () => 'C:/x.json'),
}));

import { startStateBridge } from '@/lib/executor/state-bridge';
import type { ExecStateFile } from '@/lib/executor/types';

beforeEach(() => {
  mockedState = null;
});

function sample(
  status: 'pending' | 'running' | 'done' | 'failed',
  summary?: string,
): ExecStateFile {
  return {
    actionId: 'act-1',
    projectPath: 'D:/p',
    projectName: 'p',
    tasks: [
      {
        id: 't1',
        title: 'One',
        refinedPrompt: 'x',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'semi',
        status,
        summary,
        result: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
}

describe('startStateBridge', () => {
  it('calls onChange when a tracked field flips', async () => {
    mockedState = sample('pending');
    const onChange = vi.fn();
    const bridge = startStateBridge({
      actionId: 'act-1',
      intervalMs: 5,
      onChange,
    });
    // Tick 1: pending snapshot
    await new Promise((r) => setTimeout(r, 10));
    mockedState = sample('running', 'working...');
    // Tick 2: status flipped
    await new Promise((r) => setTimeout(r, 15));
    bridge.stop();
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.tasks[0].status).toBe('running');
  });

  it('does NOT call onChange when the state is unchanged', async () => {
    mockedState = sample('running');
    const onChange = vi.fn();
    const bridge = startStateBridge({
      actionId: 'act-1',
      intervalMs: 5,
      onChange,
    });
    await new Promise((r) => setTimeout(r, 20));
    bridge.stop();
    // First read fires once; subsequent identical reads are skipped.
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('stop() halts the polling loop', async () => {
    mockedState = sample('pending');
    const onChange = vi.fn();
    const bridge = startStateBridge({
      actionId: 'act-1',
      intervalMs: 5,
      onChange,
    });
    bridge.stop();
    const before = onChange.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange.mock.calls.length).toBe(before);
  });
});
```

- [ ] **Step 3: Run the two test files to verify they fail**

Run: `npx vitest run src/lib/executor/__tests__/exec-state.test.ts src/lib/executor/__tests__/state-bridge.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create `src/lib/executor/exec-state.ts`**

```typescript
// src/lib/executor/exec-state.ts
//
// Phase E: shared helpers for reading/writing the per-Action exec-state
// file from the renderer side. The MCP server has its own identical
// helpers in notter-mcp-server/src/state.ts — duplicated intentionally
// because the two runtimes cannot share a single module.

import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import type { ExecStateFile } from './types';

export async function execStateDir(): Promise<string> {
  const dir = await appLocalDataDir();
  return join(dir, 'exec-state');
}

export async function execStatePath(actionId: string): Promise<string> {
  const dir = await execStateDir();
  return join(dir, `${actionId}.json`);
}

export async function writeExecState(state: ExecStateFile): Promise<void> {
  const path = await execStatePath(state.actionId);
  await writeTextFile(path, JSON.stringify(state, null, 2));
}

export async function readExecState(
  actionId: string,
): Promise<ExecStateFile | null> {
  const path = await execStatePath(actionId);
  if (!(await exists(path))) return null;
  const raw = await readTextFile(path);
  return JSON.parse(raw) as ExecStateFile;
}
```

- [ ] **Step 5: Create `src/lib/executor/state-bridge.ts`**

```typescript
// src/lib/executor/state-bridge.ts
//
// Phase E: poll the exec-state file for an Action and fire onChange
// whenever the snapshot differs from the previously observed one. The
// caller (Queue Worker) uses onChange to mirror task status into the
// Zustand store.
//
// Why polling and not inotify/FileSystemWatcher: simpler, portable, and
// the MCP server writes at most a few times per task. 500ms is fast
// enough that the user never notices.

import { readExecState } from './exec-state';
import type { ExecStateFile } from './types';

export interface StartStateBridgeOptions {
  actionId: string;
  intervalMs: number;
  onChange: (state: ExecStateFile) => void | Promise<void>;
}

export interface StateBridgeHandle {
  stop: () => void;
}

function snapshotKey(state: ExecStateFile): string {
  return state.tasks
    .map(
      (t) =>
        `${t.id}:${t.status}:${t.summary ?? ''}:${t.result?.summary ?? ''}`,
    )
    .join('|');
}

export function startStateBridge(
  opts: StartStateBridgeOptions,
): StateBridgeHandle {
  let stopped = false;
  let lastKey = '';

  const tick = async () => {
    if (stopped) return;
    try {
      const s = await readExecState(opts.actionId);
      if (s) {
        const key = snapshotKey(s);
        if (key !== lastKey) {
          lastKey = key;
          await opts.onChange(s);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[state-bridge] poll failed', e);
    }
    if (!stopped) {
      setTimeout(tick, opts.intervalMs);
    }
  };

  // Fire first tick on the next microtask so the caller can stop()
  // immediately without any reads firing.
  setTimeout(tick, 0);

  return {
    stop: () => {
      stopped = true;
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/executor/__tests__/exec-state.test.ts src/lib/executor/__tests__/state-bridge.test.ts`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/executor/exec-state.ts src/lib/executor/state-bridge.ts src/lib/executor/__tests__/exec-state.test.ts src/lib/executor/__tests__/state-bridge.test.ts
git commit -m "feat(executor): exec-state helpers + state-bridge poller

Phase E, Task 9 of 14."
```

---

## Task 10: spawn-claude streaming wrapper

**Files:**
- Create: `src/lib/executor/spawn-claude.ts`
- Create: `src/lib/executor/__tests__/spawn-claude.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/executor/__tests__/spawn-claude.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri shell Command.spawn so the test runs without a real claude.exe.
interface MockChild {
  pid: number;
  write: (data: string) => Promise<void>;
  kill: () => Promise<void>;
}

let spawnImpl: () => Promise<MockChild> = async () => ({
  pid: 1,
  write: async () => {},
  kill: async () => {},
});
let lastCreateCall: { program: string; args: string[] } | null = null;
let closeHandler: ((payload: { code: number | null }) => void) | null = null;

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn((program: string, args: string[]) => {
      lastCreateCall = { program, args };
      return {
        on: (event: string, h: (payload: unknown) => void) => {
          if (event === 'close') closeHandler = h as typeof closeHandler;
        },
        spawn: () => spawnImpl(),
      };
    }),
  },
}));

import { spawnClaudeExecutor } from '@/lib/executor/spawn-claude';

beforeEach(() => {
  lastCreateCall = null;
  closeHandler = null;
});

describe('spawnClaudeExecutor', () => {
  it('spawns claude with --print --mcp-config --strict-mcp-config and initial prompt', async () => {
    const handle = await spawnClaudeExecutor({
      mcpConfigPath: 'C:/appdata/exec-state/mcp-config-act-1.json',
      initialPrompt: 'do the thing',
    });
    expect(lastCreateCall?.program).toBe('claude');
    expect(lastCreateCall?.args).toEqual([
      '--print',
      '--mcp-config',
      'C:/appdata/exec-state/mcp-config-act-1.json',
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
      'do the thing',
    ]);
    // drive close event so waitForExit resolves
    closeHandler?.({ code: 0 });
    expect(await handle.waitForExit()).toBe(0);
  });

  it('waitForExit resolves with the process exit code', async () => {
    const handle = await spawnClaudeExecutor({
      mcpConfigPath: 'x.json',
      initialPrompt: 'p',
    });
    closeHandler?.({ code: 42 });
    expect(await handle.waitForExit()).toBe(42);
  });

  it('waitForExit resolves with -1 when code is null', async () => {
    const handle = await spawnClaudeExecutor({
      mcpConfigPath: 'x.json',
      initialPrompt: 'p',
    });
    closeHandler?.({ code: null });
    expect(await handle.waitForExit()).toBe(-1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/executor/__tests__/spawn-claude.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/lib/executor/spawn-claude.ts`**

```typescript
// src/lib/executor/spawn-claude.ts
//
// Phase E: spawn claude-code as a long-lived executor process. Unlike
// src/lib/llm/spawn-helper.ts (which uses Command.execute() for one-shot
// CLI calls and captures stdout), this module uses Command.spawn() so
// the process can run for minutes while the Queue Worker polls the
// exec-state file for progress.
//
// The returned SpawnHandle exposes waitForExit and kill. The caller is
// responsible for cleanup of the mcp-config.json temp file — it does
// NOT live inside this module because the Queue Worker needs to keep
// the file around until claude finishes reading it at spawn time.

import { Command } from '@tauri-apps/plugin-shell';
import type { SpawnHandle } from './types';

export interface SpawnClaudeExecutorInput {
  /** Absolute path to the --mcp-config JSON. */
  mcpConfigPath: string;
  /** Initial prompt injected as the final positional arg. */
  initialPrompt: string;
}

export async function spawnClaudeExecutor(
  input: SpawnClaudeExecutorInput,
): Promise<SpawnHandle> {
  const args = [
    '--print',
    '--mcp-config',
    input.mcpConfigPath,
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
    input.initialPrompt,
  ];

  const cmd = Command.create('claude', args);

  let resolveExit: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  cmd.on('close', (payload: { code: number | null }) => {
    resolveExit(payload.code ?? -1);
  });
  cmd.on('error', () => {
    resolveExit(-1);
  });

  const child = await cmd.spawn();

  return {
    waitForExit: () => exitPromise,
    kill: async () => {
      try {
        await child.kill();
      } catch {
        // Already exited.
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/executor/__tests__/spawn-claude.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/executor/spawn-claude.ts src/lib/executor/__tests__/spawn-claude.test.ts
git commit -m "feat(executor): spawn-claude streaming wrapper via Tauri Command.spawn

Phase E, Task 10 of 14."
```

---

## Task 11: Queue Worker singleton

**Files:**
- Create: `src/lib/executor/queue-worker.ts`
- Create: `src/lib/executor/index.ts`
- Create: `src/lib/executor/__tests__/queue-worker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/executor/__tests__/queue-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();
const writeExecStateMock = vi.fn();
const writeMcpConfigMock = vi.fn(async () => 'C:/mcp-config.json');
const ensureDirMock = vi.fn(async () => 'C:/appdata/exec-state');
const startBridgeMock = vi.fn(() => ({ stop: vi.fn() }));

vi.mock('@/lib/executor/spawn-claude', () => ({
  spawnClaudeExecutor: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('@/lib/executor/exec-state', () => ({
  writeExecState: (...args: unknown[]) => writeExecStateMock(...args),
}));
vi.mock('@/lib/executor/mcp-config', () => ({
  writeMcpConfigFile: (...args: unknown[]) => writeMcpConfigMock(...args),
  ensureExecStateDir: (...args: unknown[]) => ensureDirMock(...args),
}));
vi.mock('@/lib/executor/state-bridge', () => ({
  startStateBridge: (...args: unknown[]) => startBridgeMock(...args),
}));

// In-memory adapter standing in for the Zustand store.
const actions: {
  id: string;
  status: string;
  projectName: string;
  projectPath?: string;
  tasks: unknown[];
}[] = [];
const updateActionMock = vi.fn((id: string, patch: Record<string, unknown>) => {
  const a = actions.find((x) => x.id === id);
  if (a) Object.assign(a, patch);
});

import {
  startQueueWorker,
  __resetQueueWorkerForTests,
} from '@/lib/executor/queue-worker';

beforeEach(() => {
  actions.length = 0;
  spawnMock.mockReset();
  writeExecStateMock.mockReset();
  writeMcpConfigMock.mockClear();
  ensureDirMock.mockClear();
  startBridgeMock.mockClear();
  updateActionMock.mockClear();
  __resetQueueWorkerForTests();
});

describe('queue-worker', () => {
  it('picks a queued action, spawns claude, and marks done on exit 0', async () => {
    actions.push({
      id: 'act-1',
      status: 'queued',
      projectName: 'p',
      projectPath: 'D:/p',
      tasks: [],
    });
    spawnMock.mockResolvedValue({
      waitForExit: async () => 0,
      kill: async () => {},
    });

    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    // Wait for one full tick + completion
    await new Promise((r) => setTimeout(r, 40));
    expect(writeExecStateMock).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
    expect(actions[0].status).toBe('done');
  });

  it('marks action failed when claude exits non-zero', async () => {
    actions.push({
      id: 'act-2',
      status: 'queued',
      projectName: 'p',
      projectPath: 'D:/p',
      tasks: [],
    });
    spawnMock.mockResolvedValue({
      waitForExit: async () => 5,
      kill: async () => {},
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(actions[0].status).toBe('failed');
  });

  it('ignores actions that are not queued', async () => {
    actions.push({
      id: 'act-3',
      status: 'plan_review',
      projectName: 'p',
      tasks: [],
    });
    spawnMock.mockResolvedValue({
      waitForExit: async () => 0,
      kill: async () => {},
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(actions[0].status).toBe('plan_review');
  });

  it('is idempotent: calling startQueueWorker twice does not double-run', async () => {
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 20));
    // No crash, no runaway spawn
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('transitions action.status to running before spawning', async () => {
    actions.push({
      id: 'act-4',
      status: 'queued',
      projectName: 'p',
      projectPath: 'D:/p',
      tasks: [],
    });
    let statusWhenSpawned: string | undefined;
    spawnMock.mockImplementation(async () => {
      statusWhenSpawned = actions[0].status;
      return { waitForExit: async () => 0, kill: async () => {} };
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(statusWhenSpawned).toBe('running');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/executor/__tests__/queue-worker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/lib/executor/queue-worker.ts`**

```typescript
// src/lib/executor/queue-worker.ts
//
// Phase E: singleton loop that consumes queued Actions from the store,
// spawns claude-code via the notter MCP server, polls the exec-state
// file via state-bridge to mirror progress, and transitions the Action
// to done or failed on exit.
//
// One action at a time (strict singleton guarded by a module-level
// `busy` flag). Register once via startQueueWorker() — subsequent calls
// are idempotent no-ops.

import { spawnClaudeExecutor } from './spawn-claude';
import { writeExecState } from './exec-state';
import { writeMcpConfigFile, ensureExecStateDir } from './mcp-config';
import { startStateBridge } from './state-bridge';
import { buildInitialPrompt } from './initial-prompt';
import type { ExecStateFile, ExecTaskSnapshot } from './types';

import type { Action, ActionTask, ActionTaskStatus } from '@/types/actions';

export interface QueueWorkerDeps {
  /** Absolute path to notter-mcp-server/dist/server.js. */
  serverAbsolutePath: string;
  intervalMs: number;
  getActions: () => Action[];
  updateAction: (
    id: string,
    patch: Partial<Action>,
  ) => Promise<void> | void;
  updateTask: (
    actionId: string,
    taskId: string,
    patch: Partial<ActionTask>,
  ) => Promise<void> | void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function __resetQueueWorkerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  busy = false;
}

function actionToExecState(action: Action): ExecStateFile {
  return {
    actionId: action.id,
    projectPath: action.projectPath ?? '',
    projectName: action.projectName,
    tasks: action.tasks.map(
      (t): ExecTaskSnapshot => ({
        id: t.id,
        title: t.objective,
        refinedPrompt: t.refinedPrompt ?? t.prompt,
        securityFlags: t.securityFlags ?? [],
        dataFlags: t.dataFlags ?? [],
        trustLevel: t.trustLevel ?? 'semi',
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      }),
    ),
    priorTaskSummaries: [],
  };
}

function mirrorStateToStore(
  state: ExecStateFile,
  deps: QueueWorkerDeps,
): void {
  for (const t of state.tasks) {
    const patch: Partial<ActionTask> = {
      status: t.status as ActionTaskStatus,
    };
    if (t.result) {
      patch.result = {
        summary: t.result.summary,
        filesChanged: t.result.filesChanged,
        testsRun: t.result.testsRun,
        errorMessage: t.result.errorMessage,
      };
    }
    if (t.startedAt !== null) patch.startedAt = t.startedAt;
    if (t.completedAt !== null) patch.completedAt = t.completedAt;
    void deps.updateTask(state.actionId, t.id, patch);
  }
}

async function runOnce(deps: QueueWorkerDeps): Promise<void> {
  if (busy) return;
  const next = deps.getActions().find((a) => a.status === 'queued');
  if (!next) return;
  busy = true;

  const bridgeHandle = { stop: () => {} };
  let capturedBridge: ReturnType<typeof startStateBridge> | null = null;

  try {
    const stateDir = await ensureExecStateDir();
    const execState = actionToExecState(next);
    await writeExecState(execState);

    const mcpConfigPath = await writeMcpConfigFile({
      actionId: next.id,
      serverAbsolutePath: deps.serverAbsolutePath,
      stateDir,
    });

    await deps.updateAction(next.id, { status: 'running' });

    capturedBridge = startStateBridge({
      actionId: next.id,
      intervalMs: deps.intervalMs,
      onChange: (s) => mirrorStateToStore(s, deps),
    });
    bridgeHandle.stop = () => capturedBridge?.stop();

    const handle = await spawnClaudeExecutor({
      mcpConfigPath,
      initialPrompt: buildInitialPrompt(next.id),
    });
    const code = await handle.waitForExit();

    await deps.updateAction(next.id, {
      status: code === 0 ? 'done' : 'failed',
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[queue-worker] runOnce failed', e);
    await deps.updateAction(next.id, { status: 'failed' });
  } finally {
    bridgeHandle.stop();
    busy = false;
  }
}

export async function startQueueWorker(deps: QueueWorkerDeps): Promise<void> {
  if (timer) return; // idempotent
  timer = setInterval(() => {
    void runOnce(deps);
  }, deps.intervalMs);
}

export function stopQueueWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  busy = false;
}
```

- [ ] **Step 4: Create `src/lib/executor/index.ts`**

```typescript
// src/lib/executor/index.ts
//
// Phase E: public entry point for the executor library.

export type {
  ExecStateFile,
  ExecTaskSnapshot,
  ExecTaskStatus,
  ExecTaskResult,
  PriorTaskSummary,
  SpawnHandle,
} from './types';

export { startQueueWorker, stopQueueWorker } from './queue-worker';
export { buildInitialPrompt } from './initial-prompt';
export { execStatePath, readExecState, writeExecState } from './exec-state';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/executor`
Expected: all executor tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/executor/queue-worker.ts src/lib/executor/index.ts src/lib/executor/__tests__/queue-worker.test.ts
git commit -m "feat(executor): Queue Worker singleton + public index

Phase E, Task 11 of 14."
```

---

## Task 12: Wire executor into actions-store

**Files:**
- Modify: `src/stores/actions-store.ts`

- [ ] **Step 1: Add executor bootstrap after the initial load**

Open `src/stores/actions-store.ts`. After the existing `load()` function (before `addAction`), register the Queue Worker once loaded actions are in state. We cannot reference `useActionsStore` from its own module body, so use a top-level `startupHook` that runs from within load().

Specifically, modify the `load()` function to call `bootExecutorIfNeeded(get)` as the final step before `return`. Add at the top of the file (under other imports):

```typescript
import { startQueueWorker } from '@/lib/executor';
```

And add this helper before the `create` call:

```typescript
let queueWorkerStarted = false;

async function bootExecutor(
  get: () => ActionsState,
): Promise<void> {
  if (queueWorkerStarted) return;
  queueWorkerStarted = true;

  // Phase E: absolute path to the built MCP server. In dev we assume the
  // cwd is the repo root (Tauri dev sets it automatically); in a packaged
  // build this will need to point into resources — Phase F will teach the
  // executor to resolve that via Tauri's resourceDir().
  const serverAbsolutePath =
    'D:/Code/Projetos/CodeReview/AgentTrack/notter-mcp-server/dist/server.js';

  await startQueueWorker({
    serverAbsolutePath,
    intervalMs: 500,
    getActions: () => get().actions,
    updateAction: (id, patch) => get().updateAction(id, patch),
    updateTask: (actionId, taskId, patch) =>
      get().updateTask(actionId, taskId, patch),
  });
}
```

Then inside `load()`, after the final `set({ actions, loaded: true })` call on the success path:

```typescript
void bootExecutor(get);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run existing store + executor tests**

Run: `npx vitest run src/stores src/lib/executor`
Expected: all pass. Store tests may need a tiny mock addition — if they fail with "startQueueWorker is not a function", add `vi.mock('@/lib/executor', () => ({ startQueueWorker: vi.fn() }))` near the top of each store test file.

- [ ] **Step 4: Commit**

```bash
git add src/stores/actions-store.ts src/stores/__tests__/actions-store.test.ts src/stores/__tests__/actions-store-planning.test.ts
git commit -m "feat(actions-store): boot the Queue Worker after load()

Phase E, Task 12 of 14."
```

---

## Task 13: UI — banner in PlanReviewPanel + live summary in TaskItem

**Files:**
- Modify: `src/components/planning/PlanReviewPanel.tsx`
- Modify: `src/components/actions/TaskItem.tsx`

- [ ] **Step 1: Add a queued banner in PlanReviewPanel**

Read `src/components/planning/PlanReviewPanel.tsx`. Inside the component, just above the "Approve & Queue / Reject" action bar, add:

```tsx
{action.status === 'queued' && (
  <div className="rounded-md border border-primary/50 bg-primary/10 px-3 py-2 text-xs text-primary">
    Waiting for executor… the Queue Worker will pick this up within a second.
  </div>
)}
```

(Phase E: we can't easily guarantee the panel re-renders after Action.status flips to `running`, but if the parent (`ActionDetail`) re-selects another section when the status changes, we don't need to worry here.)

- [ ] **Step 2: Render a live summary line in TaskItem**

Open `src/components/actions/TaskItem.tsx`. Inside the existing task row, when `task.status === 'running'` AND `task.result === undefined`, render a small muted summary line underneath the title using whatever `summary`-like field is present. Since ActionTask in src/types/actions.ts does NOT have a `summary` field, we need to add it first.

Modify `src/types/actions.ts`: add `summary?: string;` to the `ActionTask` interface below `returnText`.

Then modify the Queue Worker's `mirrorStateToStore` in `src/lib/executor/queue-worker.ts` to also copy `t.summary`:

```typescript
if (t.summary !== undefined) patch.summary = t.summary;
```

Then in `TaskItem.tsx` add a rendering branch:

```tsx
{task.status === 'running' && task.summary && (
  <div className="text-xs text-muted-foreground mt-0.5 italic">
    {task.summary}
  </div>
)}
{task.status === 'done' && task.result?.summary && (
  <div className="text-xs text-muted-foreground mt-0.5">
    {task.result.summary}
  </div>
)}
{task.status === 'failed' && task.result?.errorMessage && (
  <div className="text-xs text-destructive mt-0.5">
    {task.result.errorMessage}
  </div>
)}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: all pass. If any planning-store tests fail because they no longer match the new `summary` field, update the `makeTask` helper to include `summary: undefined`.

- [ ] **Step 5: Commit**

```bash
git add src/components/planning/PlanReviewPanel.tsx src/components/actions/TaskItem.tsx src/types/actions.ts src/lib/executor/queue-worker.ts
git commit -m "feat(ui): queued banner + live task summary during execution

Phase E, Task 13 of 14."
```

---

## Task 14: End-to-end manual validation

**Files:**
- Modify: `spike/notes.md` (append a Phase E runtime section if gitignored, skip commit)

- [ ] **Step 1: Rebuild the MCP server**

Run: `cd notter-mcp-server && npm run build && cd ..`
Expected: `notter-mcp-server/dist/server.js` exists.

- [ ] **Step 2: Restart Tauri dev**

Kill any running `npm run tauri dev` and re-launch it fresh.

- [ ] **Step 3: Plan a real note end-to-end**

Inside the running app: create a Planner note describing something trivial but real ("add a dark-mode toggle to the settings panel"). Click the violet Sparkles "Plan with AI" button. Wait for the 4 planning stages to complete.

- [ ] **Step 4: Approve the plan**

In the Plan Review Panel, click "Approve & Queue". Verify:
- Action status transitions to `queued`, then `running` within 1 second
- The queued banner briefly shows in PlanReviewPanel or the ActionDetail switches to the regular task list
- Individual task statuses flip from `pending` → `running` with live summary strings
- Eventually each task becomes `done` or `failed` with a summary/error message

- [ ] **Step 5: Verify files on disk**

In a separate terminal inside the target project directory, run `git status` and verify claude-code actually made the changes described in the refined prompts.

- [ ] **Step 6: Document findings in spike/notes.md**

Append a "Phase E — runtime validation (YYYY-MM-DD)" section noting:
- Total wall-clock time
- Number of tasks, how many done vs failed
- Any surprises (e.g. tool calls that didn't fire, summaries that didn't update live, etc.)
- Whether the executor exited cleanly or crashed

- [ ] **Step 7: If any critical bugs surface, file them as follow-up fix tasks before declaring Phase E done**

---

## Final verification

```bash
npm test                 # expect ~295-310 tests passing (Phase D 268 + ~30 new)
npx tsc --noEmit         # clean
cd notter-mcp-server && npm test && cd ..   # ~20 tests passing
git log --oneline 2d90b7c..HEAD   # expect ~14 commits
```

Phase E is done when:
1. An approved Phase D plan runs to completion without the user having to click anything else.
2. Task statuses update live in the UI as claude executes.
3. Real file changes show up on disk under the target project.
4. A failing task transitions the Action correctly to `failed` with a visible error message.
5. Unit suite is green on both the Tauri app and the sidecar.
6. `spike/notes.md` has a Phase E runtime validation entry.

## Self-Review Checklist (Plan Author)

- [x] Every task has concrete file paths
- [x] Every code step shows the complete code (no "similar to above")
- [x] No placeholders ("TBD", "TODO", "add validation")
- [x] Tests precede implementation (TDD) for every task that has a test
- [x] Each task commits atomically at the end
- [x] Phase E's narrow scope is respected — no ActionReport, no full HITL, no git isolation
- [x] The ask_user stub is explicit and the limitation is documented
- [x] State sharing is file-based (documented tradeoffs) — no new Tauri IPC
- [x] Queue Worker is a strict singleton guarded by a module-level `busy` flag
- [x] Manual E2E is the gate, matching the Phase C/D lesson that mocks don't catch runtime bugs
- [x] Capability changes: none required (claude already allowed; node spawned by claude is outside Tauri's sandbox)
