# AgentTrack — Autonomous Pipeline Design

**Date:** 2026-04-08
**Status:** Draft — awaiting user review
**Strategy:** Rota A (AgentTrack como cérebro de planejamento + Claude Code como executor via MCP)
**Target autonomy level:** v3 (humano aprova plano + revisa no fim da Action; HITL real apenas quando o executor pede)

---

## 1. Overview

AgentTrack deixa de ser apenas um workspace de notas + terminal e passa a ser um **orquestrador de pipelines de desenvolvimento autônomo**. O usuário escreve um planejamento em markdown no Planner; AgentTrack transforma isso em um plano estruturado através de **quatro passos de planejamento sequenciais** (extração, review de segurança, review de consistência de dados, refinamento de prompts); o usuário aprova o plano; a Action entra em uma fila de execução; um worker spawna o **Claude Code CLI** no diretório do projeto com um **MCP server Notter** conectado; o Claude Code consome tasks, reporta progresso e pede decisões via ferramentas MCP; quando a última task é concluída, AgentTrack gera um relatório final para revisão humana.

O sistema não reimplementa agent loop, editor, shell ou git — tudo isso é delegado ao Claude Code. AgentTrack é responsável apenas pelo **cérebro de planejamento**, **orquestração**, **estado persistente** e **UI de review/HITL/relatórios**.

---

## 2. Goals and Non-Goals

### Goals (MVP)

1. Planejamento multi-agente com 3 dimensões de review: segurança, consistência de dados, prompt critic
2. Orquestração de três CLIs distintos (Gemini, Codex, Claude Code) via uma abstração `LLMWorker`
3. MCP server local que expõe 5 ferramentas ao Claude Code
4. Execução via Claude Code spawnado no PTY existente, uma Action por vez no MVP
5. Relatório final por Action com aprovação humana (verification model D)
6. Trust levels `auto | semi | manual` por task, calculados pelo prompt critic (verification model E)
7. Token tracking por Action e por LLMWorker, com quota display agregado
8. Multi-projeto: AgentTrack + 2-3 projetos greenfield adicionais, selecionados via project picker
9. Suporte a greenfield (Action pode criar um projeto novo do zero, decisões de stack viram parte do planejamento)
10. Modal HITL global que responde quando Claude Code chama `notter.ask_user`

### Non-Goals (MVP)

- Pipeline visual estilo n8n (Abordagem 3, roadmap futuro)
- Auto-gate por testes automatizados (verification model A, roadmap futuro)
- Screenshots/diff visual de UI (verification model C, roadmap futuro)
- Execução paralela de múltiplas Actions (MVP roda uma por vez; queue respeita ordem)
- Sync Supabase das Actions/Plans (fica local-only como hoje)
- Reviewers de UI, UX, performance e observabilidade (ficam pra fase 2 quando expandimos de 3 pra 6 dimensões)
- Suporte a outros executores (OpenHands, Aider) — Claude Code é o único no MVP, mas a abstração permite adicionar depois
- Rate limit awareness ativa (MVP apenas exibe consumo; não bloqueia automaticamente)
- Replay / time-travel debugging

---

## 3. User Scenarios

### Cenário 1 — Feature em projeto existente (dogfooding no AgentTrack)

> Guilherme abre o AgentTrack, vai no Planner do projeto "AgentTrack", escreve uma nota: *"Quero adicionar export CSV das Actions concluídas, com filtros por projeto e período"*. Clica em **Plan with AI**. Um modal mostra o progresso dos 4 passos (~90s total). Ao fim, o Review Panel exibe: 4 tasks extraídas, 2 flags de segurança (filename sanitization + path traversal), 1 flag de consistência de dados (formato de data), e os 4 prompts finais refinados. Ele aprova. A Action vai pra queue. Worker spawna Claude Code no cwd do AgentTrack. Em ~15 minutos, todas as tasks são executadas; Guilherme recebe um relatório com diff, summary por task, testes rodados, e tokens consumidos (~320k). Ele revisa o diff, aprova, e o worker encerra.

### Cenário 2 — Novo projeto greenfield

> Guilherme adiciona um projeto novo vazio chamado "expense-tracker" e escreve no Planner: *"Quero um CLI Rust que lê recibos de PDF e gera relatório mensal de despesas, com SQLite e testes"*. Clica em **Plan with AI**. O planner extrai tasks incluindo *"decidir stack Rust + dependências"* como primeira task. O review de segurança flaga tratamento de input (PDF parsing). O prompt critic gera prompts detalhados para cada task, incluindo `cargo init`, schema SQLite, módulo de parsing, testes de integração. Ele aprova. O worker spawna Claude Code na pasta vazia. Ao longo de 40 minutos, Claude Code cria toda a estrutura. Em duas tasks o Claude Code chama `notter.ask_user` perguntando *"usar `pdf-extract` ou `lopdf`? Primeiro é mais simples, segundo mais flexível"*. Modal abre no AgentTrack, Guilherme escolhe. No fim, relatório mostra 14 arquivos criados, testes verdes, 780k tokens. Aprova.

### Cenário 3 — Fila noturna 24h

> Guilherme escreve 5 notas em projetos diferentes ao longo do dia. Processa cada uma, aprova os 5 planos, deixa as 5 Actions na queue. Vai dormir. AgentTrack executa as Actions sequencialmente durante a madrugada. Manhã seguinte, ele abre o app e vê 5 relatórios aguardando revisão. Uma falhou em HITL aguardando resposta (modal ficou aberto); as outras 4 terminaram. Ele revisa rapidamente, aprova 3, rejeita 1 (pede ajustes específicos). A rejeitada volta pro planner com o comentário dele anexado pra re-planejamento.

---

## 4. High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                    AgentTrack (Tauri app)                          │
│  React + Zustand (TypeScript)                                      │
│                                                                    │
│   Planner ─┬─► Planning Pipeline ──► Action Store                  │
│            │      (4 passos)              │                        │
│            │          │                   │                        │
│            │          ▼                   ▼                        │
│            │     LLMWorker            Queue Worker                 │
│            │     abstraction              │                        │
│            │     ┌──┼──┐                  │                        │
│            │   Gemini Codex Claude        │                        │
│            │    CLI   CLI  Code           │                        │
│            │                              │                        │
│   UI: Planner | Actions | Review | HITL Modal | Reports            │
│                                            │                        │
└────────────────────────────────────────────┼────────────────────────┘
                                             │ spawn subprocess
                                             ▼
             ┌───────────────────────────────────────────┐
             │   MCP Server Notter (TS, stdio)           │
             │   ephemeral — one per running Action       │
             └───────────────┬───────────────────────────┘
                             │ MCP stdio
                             ▼
             ┌───────────────────────────────────────────┐
             │   Claude Code CLI (executor)               │
             │   cwd = project path                       │
             │   --mcp-server notter=...                   │
             └───────────────────────────────────────────┘
```

### Component boundaries

| Component | Responsibility | Technology |
|---|---|---|
| UI | Planner, Actions list, Review Panel, HITL Modal, Reports | React + Zustand |
| Planning Pipeline | 4 sequential async steps on an Action | TypeScript |
| LLMWorker abstraction | Unified interface over Gemini/Codex/Claude Code CLIs | TypeScript + Tauri PTY |
| Action Store | Persist Action, Plan, PlanStages, TokenUsage, Report | Zustand + JSON file |
| Queue Worker | Pops approved Actions, spawns MCP + Claude Code | TypeScript (in-process) |
| MCP Server Notter | Exposes 5 tools to Claude Code | TypeScript + `@modelcontextprotocol/sdk` |
| Executor | Runs tasks, edits files, runs tests | **Claude Code CLI (unchanged)** |

---

## 5. Data Model

All data lives in `{appLocalDataDir}/actions.json` (extended from current shape).

```ts
// types/actions.ts

export type TrustLevel = 'auto' | 'semi' | 'manual';

export type ActionStatus =
  | 'draft'           // created from Planner, before planning runs
  | 'planning'        // pipeline running
  | 'plan_review'     // plan ready, awaiting human approval
  | 'rejected'        // user rejected the plan
  | 'queued'          // plan approved, waiting its turn
  | 'running'         // worker spawned Claude Code
  | 'awaiting_hitl'   // paused, Claude Code asked a question
  | 'report_review'   // all tasks done, awaiting human final approval
  | 'done'            // accepted
  | 'failed'          // crashed or rejected at final review
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'blocked_hitl'
  | 'done'
  | 'skipped'
  | 'failed';

export interface Task {
  id: string;
  title: string;
  rawPrompt: string;        // output of extractor step
  refinedPrompt?: string;   // output of prompt-critic step (undefined before planning completes)
  trustLevel: TrustLevel;   // defaults to 'semi' until prompt critic assigns it
  securityFlags: string[];  // from security reviewer
  dataFlags: string[];      // from data consistency reviewer
  status: TaskStatus;
  dependsOn?: string[];     // task ids
  result?: {
    summary: string;
    filesChanged: string[];
    testsRun: { command: string; passed: boolean; output?: string }[];
    errorMessage?: string;
  };
  startedAt?: number;
  completedAt?: number;
}

export interface PlanStage {
  name: 'extract' | 'security' | 'data_consistency' | 'prompt_critic';
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: number;
  completedAt?: number;
  output?: string;          // raw LLM response for debugging
  tokenUsage?: TokenUsage;
  errorMessage?: string;
}

export interface TokenUsage {
  worker: 'gemini-cli' | 'codex-cli' | 'claude-code';
  inputTokens: number;
  outputTokens: number;
  costEstimate?: number;    // optional, if worker reports it
  timestamp: number;
}

export interface ActionReport {
  generatedAt: number;
  summary: string;          // high-level narrative
  tasksCompleted: number;
  tasksFailed: number;
  totalTokens: TokenUsage[];
  diffPath?: string;        // optional: saved diff file
  userDecision?: 'approved' | 'rejected';
  userComment?: string;
}

export interface Action {
  id: string;
  projectId: string;        // which project this action targets
  projectPath: string;      // resolved absolute path (greenfield ok)
  title: string;
  originalMarkdown: string; // from Planner note
  status: ActionStatus;
  tasks: Task[];
  planStages: PlanStage[];
  tokenUsage: TokenUsage[]; // aggregated across planning + execution
  report?: ActionReport;
  createdAt: number;
  updatedAt: number;
}

export interface ActionsFile {
  version: 2;
  actions: Action[];
}
```

### Migration from version 1

The current `actions.json` has `version: 1` with a simpler shape. On first load of an `ActionsFile` with `version: 1`, the app migrates in place:

- `status` values mapped: `waiting` → `draft`, `processing` → `running`, `done` → `done`, `skipped` → `cancelled`
- `planStages` initialized to empty array; `tokenUsage` to empty array
- `tasks[].trustLevel` defaults to `'semi'` (middle-ground — forces review)
- `tasks[].securityFlags` and `tasks[].dataFlags` default to empty arrays
- `tasks[].refinedPrompt` left `undefined` — if the user re-runs planning on a migrated Action, the pipeline fills it; otherwise the raw prompt is used as fallback on execution
- `originalMarkdown` kept as-is
- Version bumped to `2`; a `.v1-backup.json` is written alongside before the rewrite

---

## 6. Planning Pipeline

The pipeline runs when the user clicks **Plan with AI** on a Planner note. It is a sequence of 4 async steps. Each step updates a `PlanStage` entry on the Action. On failure, the user can re-run from the failed step (no re-runs of earlier steps needed).

### Step 1 — Extract (`extract`)

**Worker:** Gemini CLI (cheapest, fastest, good at structured extraction)

**Input:** raw markdown note + project metadata (name, path, existing files summary if any)

**Output:** an array of `Task` stubs with `title` and `rawPrompt` filled, `trustLevel` unset.

**Prompt outline:**
> You are a task extractor. Given a development planning note, output a JSON array of atomic tasks. Each task has a title (≤80 chars) and rawPrompt (a detailed instruction the executor will follow). Preserve the user's intent literally; do not add creative tasks. If the project is greenfield (no files), include stack-decision and initial-scaffold tasks at the top. Return STRICT JSON.

### Step 2 — Security review (`security`)

**Worker:** Codex CLI (ChatGPT — good reasoning about adversarial inputs)

**Input:** the `Task[]` from step 1 + project context

**Output:** same `Task[]` with `securityFlags: string[]` populated. Flags are short descriptors (e.g., `"sanitize filename"`, `"validate user input"`, `"avoid logging secrets"`).

**Prompt outline:**
> You are a security reviewer. For each task, list concrete security concerns IF relevant (empty array if no concern). Focus on: input validation, injection, path traversal, secret handling, authz, SSRF, and data leakage. Do NOT flag generic advice — only concerns specific to what the task will do. Return the tasks array with `securityFlags` populated.

### Step 3 — Data consistency review (`data_consistency`)

**Worker:** Gemini CLI or Codex CLI (toss-up; MVP uses Gemini for cost, can swap)

**Input:** `Task[]` (with security flags) + project context

**Output:** `Task[]` with `dataFlags: string[]` populated. Flags cover: schema contracts, API shapes, data type mismatches, migration risks, referential integrity, cache invalidation.

**Prompt outline:**
> You are a data consistency reviewer. For each task that touches data (DB, files, API, state), list concrete risks to data integrity or consistency with existing contracts. If the task doesn't touch data, return empty array. Focus on: schema changes, API breakage, migration safety, referential integrity, serialization shape. Return tasks with `dataFlags` populated.

### Step 4 — Prompt critic (`prompt_critic`)

**Worker:** Claude Code CLI in headless mode with a plan-focused system prompt (best at refining prompts and classifying tasks). Note: Claude Code's interactive "plan mode" may not be available headless; if not, we use `claude --print --json` with a strong system prompt that enforces planning-only behavior. Confirmed in spike §15.1.

**Input:** `Task[]` with all flags + project context

**Output:** `Task[]` with `refinedPrompt` and `trustLevel` populated for every task. The refined prompt is what the executor will actually receive. It must be actionable, self-contained, reference the flags from previous steps as constraints, and include acceptance criteria.

**Prompt outline:**
> You are a senior staff engineer. For each task, produce:
> 1. `refinedPrompt` — a self-contained prompt the executor (another Claude Code instance) will follow. Must reference the securityFlags and dataFlags as constraints. Must include explicit acceptance criteria (what "done" looks like). Must assume the executor has read/write/shell access to the cwd.
> 2. `trustLevel` — classify as `auto` (cosmetic, low-risk, reversible), `semi` (feature dev, refactor, default), or `manual` (schema migration, auth, secrets, destructive ops, deploy). Err on the side of `semi`.
>
> Return the tasks array fully populated.

### Cost expectation (MVP estimate)

| Step | Worker | Tokens (in/out typical) |
|---|---|---|
| Extract | Gemini | 8k / 2k |
| Security | Codex | 10k / 3k |
| Data | Gemini | 10k / 3k |
| Prompt critic | Claude Code | 15k / 6k |
| **Total per Action plan** | — | **~60k / 14k** |

---

## 7. MCP Contract — Tools exposed to Claude Code

The MCP server is spawned by AgentTrack when an Action transitions to `running`. It dies when the Action reaches `report_review` or `failed`. One MCP server instance per Action.

**Server command:** `node notter-mcp-server.js --action-id <id> --state-dir <path>`
**Transport:** stdio
**SDK:** `@modelcontextprotocol/sdk` (TypeScript)

### Tool 1 — `notter.get_next_task`

```typescript
// input: { action_id: string }
// output:
{
  task_id: string;
  title: string;
  refined_prompt: string;
  security_flags: string[];
  data_flags: string[];
  trust_level: 'auto' | 'semi' | 'manual';
  project_context: {
    path: string;
    name: string;
    is_greenfield: boolean;
    tech_stack_hints?: string[];
  };
} | { done: true }
```

Claude Code calls this at session start and after each `mark_done`. Returns `{done: true}` when all tasks are completed.

### Tool 2 — `notter.report_progress`

```typescript
// input: { task_id: string, status: 'running'|'blocked_hitl', summary: string }
// output: { ok: true }
```

Claude Code calls this to update the UI as it works through a task. The `summary` is a short human-readable description ("Created file X", "Running tests", etc.) that shows in the live Task panel.

### Tool 3 — `notter.ask_user`

```typescript
// input: {
//   task_id: string,
//   question: string,
//   options?: string[]  // if provided, presented as buttons; otherwise free-text
// }
// output: {
//   answer: string,
//   timeout?: boolean  // true if user didn't answer in time and default triggered
// }
```

Claude Code calls this when it needs a human decision. AgentTrack opens a modal in the UI, sets Action status to `awaiting_hitl`, and blocks the MCP tool response until the user answers. Timeout behavior: configurable per Action (default: wait indefinitely; optional: 5min timeout with `"use your best judgment"` as default response).

### Tool 4 — `notter.mark_done`

```typescript
// input: {
//   task_id: string,
//   summary: string,
//   files_changed: string[],
//   tests_run?: { command: string, passed: boolean, output?: string }[],
//   error_message?: string  // if the task failed
// }
// output: { ok: true }
```

Finalizes a task. Updates `Task.status` to `done` or `failed` based on presence of `error_message`. Writes the `result` object on the Task.

### Tool 5 — `notter.get_project_context`

```typescript
// input: { project_id: string, include_file_tree?: boolean }
// output: {
//   path: string;
//   name: string;
//   is_greenfield: boolean;
//   file_tree?: string[];  // paths relative to project root, max 500 entries
//   prior_tasks?: { title: string, summary: string }[];  // already-completed tasks in this Action
// }
```

Let Claude Code orient itself without burning tokens re-reading files. Especially useful for the second task onward, so it knows what the previous tasks already produced.

---

## 8. Execution Flow

When an Action's plan is approved:

1. Action status → `queued`
2. Queue Worker (singleton, in the Zustand store) picks up the next queued Action
3. Worker spawns the MCP Server Notter subprocess:
   - `node notter-mcp-server.js --action-id <id>`
   - stdio piped
4. Worker spawns Claude Code CLI via existing PTY infrastructure:
   - `cwd = action.projectPath`
   - command: `claude --dangerously-skip-permissions --mcp-server notter=stdio:node notter-mcp-server.js --action-id <id>`
   - (exact flag names confirmed in the spike; see §15)
5. Worker injects an initial prompt into Claude Code:
   > "You are the executor. Use the `notter` MCP tools to retrieve and complete tasks for this Action. Start by calling `notter.get_next_task` with action_id=<id>. For each task, follow the `refined_prompt` literally. Respect the security_flags and data_flags as hard constraints. Call `notter.report_progress` frequently, `notter.ask_user` when you need a human decision, and `notter.mark_done` when the task is complete. Continue until `notter.get_next_task` returns `{done: true}`."
6. AgentTrack sets Action status → `running`; UI shows live task state via MCP reports
7. Claude Code iterates: get task → do work → report progress → (maybe ask user) → mark done → next task
8. When Claude Code receives `{done: true}`, it exits cleanly
9. Worker catches the exit, runs the **Report Generation** step:
   - Summary LLM call (Gemini, cheap) consolidates all task results into an ActionReport
   - Diff optionally saved to disk (`action-<id>.diff`)
10. Action status → `report_review`; UI shows the report to the user
11. User clicks Approve or Reject (with optional comment):
    - Approve → status `done`
    - Reject → status `failed`, comment attached, optionally re-enqueue for re-planning

### Concurrency

MVP runs **one Action at a time**. The Queue Worker is a singleton that processes the queue serially. If the user approves 5 plans, they run one after another. This avoids terminal collision, MCP server port chaos, and rate limit pileups. Parallel execution is a future optimization.

---

## 9. HITL Mechanism

When Claude Code calls `notter.ask_user`:

1. MCP Server receives the call and emits a message to the main AgentTrack process (via a local IPC file or a Tauri event forwarded through the subprocess stdout)
2. AgentTrack sets Action status → `awaiting_hitl`
3. A **global HITL Modal** opens in the current window showing:
   - Action title
   - Task title currently paused
   - The question
   - If options provided: buttons
   - If free-text: textarea + "Submit" button
   - Optional: "Always decide for me" checkbox (stores this preference per project, sets a future default)
4. User responds; AgentTrack sends the answer back to the MCP Server via the same IPC channel
5. MCP Server's `ask_user` tool returns the answer to Claude Code
6. Claude Code resumes

**Blocking guarantee:** the `ask_user` tool does not return until the user responds or a timeout fires. This keeps the execution deterministic.

**Crash safety:** if AgentTrack crashes while `awaiting_hitl`, on reopen the Action is still `awaiting_hitl`; the MCP subprocess is orphaned. The worker detects this (PID check) and re-spawns Claude Code from the current task; Claude Code re-asks via `ask_user`. (Not ideal but simple. A future improvement can persist open questions on disk and replay.)

---

## 10. Token Tracking

Every call through `LLMWorker` is wrapped to record a `TokenUsage` entry on the Action. Workers report tokens in different ways:

- **Gemini CLI** — emits usage via stderr in a structured format; adapter parses it
- **Codex CLI** — emits a `--json` mode with usage block at the end
- **Claude Code CLI** — can report cost via `/cost` slash command; in headless mode the adapter parses the trailing summary block emitted by `claude --print --json` (to confirm in spike)

For the executor Claude Code run (not the planning reviewers), tokens are accumulated by parsing the Claude Code session logs or by using a "checkpoint" query pattern (call `/cost` via MCP before/after the session). The exact mechanism is to be confirmed in the spike (§15.2).

**UI display:**
- Per Action: total input/output tokens + rough cost estimate (using published prices as reference only; subscription users see "included in plan")
- Global: a header badge shows cumulative tokens today / this month, and which CLI is closest to its limit
- Drill-down: click an Action → see breakdown by PlanStage + execution

**No hard limits in MVP.** If a subscription runs out, the worker surfaces the CLI's error and marks the Action `failed`. Future: circuit breaker that pauses queue when quota < 10%.

---

## 11. Trust Levels in Practice

Determined by the prompt critic step:

| Level | Examples | Behavior |
|---|---|---|
| `auto` | Fix typo, rename variable, format file, update README link, add missing test for pure function | Executor runs without asking; no intermediate check |
| `semi` (default) | Add new feature, refactor module, change function signature, write new component | Executor runs; result rolled into Action report for final human review |
| `manual` | Schema migration, auth change, touching secrets, deploy, destructive op, changing CI | Executor PAUSES before running this task and calls `notter.ask_user` with the refinedPrompt and a confirm/skip prompt; user must explicitly approve |

The initial prompt to Claude Code instructs it: *"Before starting any task marked `trust_level: manual`, call `notter.ask_user` with the refined prompt and wait for explicit approval."*

---

## 12. UI Changes

### Existing surfaces modified

- **Planner (unchanged mostly)** — the existing **Process** button on Planner becomes **Plan with AI** (same button, different behavior: instead of creating a skeleton Action, it kicks off the full 4-step pipeline)
- **Actions tab** — status badges updated for the new ActionStatus values; list shows `plan_review`, `queued`, `running`, `report_review` prominently

### New surfaces

- **Plan Review Panel** — opens when Action is in `plan_review`. Shows:
  - Timeline of the 4 planning stages (with durations and token counts)
  - Table of tasks: title, trust level (colored pill), security flags, data flags, refined prompt (collapsible)
  - "Approve plan" and "Reject & re-plan with comment" buttons
- **Live Execution View** — opens when Action is `running`. Shows:
  - Current task title + live progress summary (from `report_progress`)
  - Task list with check/running/pending indicators
  - Mini terminal viewport (reuses existing TerminalView) tailing the Claude Code PTY
  - Pause/Cancel buttons
- **HITL Modal** (global) — see §9
- **Report Review Panel** — opens when Action is `report_review`. Shows:
  - Action report narrative
  - Diff (saved file, read-only viewer using Monaco)
  - Task-by-task summary + tests run
  - Token breakdown
  - "Approve" / "Reject with comment" buttons
- **Token Dashboard** (new top-bar badge + drill-down) — see §10

---

## 13. Error Handling and Resume

**Principle:** every state transition persists immediately. Crashes never lose progress; they may waste LLM tokens on in-flight operations, but never corrupt the Action.

### Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Planning stage fails (LLM error) | Exception in async step | Mark PlanStage `failed`, surface error in UI, user clicks "Retry from this stage" |
| Plan rejected by user | Explicit user action | Action → `rejected`; user can edit note and re-plan |
| Worker spawn fails | Subprocess exit non-zero before reporting | Action → `failed` with error logged; user can re-queue |
| Claude Code exits unexpectedly | PTY close event before `{done: true}` | Mark Action `failed`; partial task results preserved; user sees "executor crashed at task N" and can re-plan the remaining tasks |
| MCP server subprocess dies | stdio close event | Same as above |
| AgentTrack app crashes mid-execution | On next boot, detect `running` Actions with no active PID | Mark orphaned Actions as `failed` with reason "app restart during execution"; user re-queues |
| HITL modal closed without answer | Modal has explicit Close button disabled; only Submit | Cannot close without answering (by design) |
| Rate limit / quota exceeded on CLI | CLI returns error text | Worker detects error keywords, marks PlanStage or Task `failed` with quota reason; user sees clear error |

### Persistence discipline

- After every Action field mutation: `schedulePersist()` (300ms debounce, existing mechanism)
- Before spawn/exit of subprocesses: flush immediately (`flushActionsStore()`)
- On app close: flush

---

## 14. Testing Strategy

### Unit tests (Vitest, existing setup)

- LLMWorker adapters: parse fixture outputs of each CLI (no real spawning)
- Migration from actions.json v1 → v2
- Trust level classification heuristics (if we add fallback logic beyond LLM output)
- State machine transitions of ActionStatus (allowed vs. forbidden transitions)

### Integration tests

- Planning pipeline end-to-end with a **mock LLMWorker** that returns fixed JSON — validates orchestration, state persistence, error handling
- MCP server tools called directly (no Claude Code involved) with an in-process MCP client — validates contract shape

### Manual validation (MVP)

- **The spike (§15)** is the critical manual validation before any large investment
- After the spike: run Scenario 1 (dogfood on AgentTrack itself) three times on real tasks and record:
  - Did the plan capture the intent?
  - Did the reviewers add value or noise?
  - Did Claude Code execute correctly?
  - How much was user intervention needed?
  - Token consumption vs. expectation

### What we explicitly don't test in MVP

- No UI component tests (Playwright/CT) — planning/execution logic matters more
- No benchmarks — performance is fine until proven otherwise

---

## 15. Technical Spike (Day 0 — MUST pass before implementation)

**Goal:** prove the core assumptions of the architecture in a single day, before committing to weeks of implementation.

### 15.1 — Can Claude Code CLI be spawned headless with an MCP server and actually call the MCP tools?

**Steps:**
1. Write a minimal MCP server (TypeScript, `@modelcontextprotocol/sdk`, stdio) exposing a single `notter.echo` tool
2. Spawn Claude Code CLI via the existing PTY with `--mcp-server` flag pointing at the minimal server
3. Send Claude Code a prompt like: *"Call the notter.echo tool with message='hello' and tell me what it returned"*
4. **Success:** Claude Code invokes the tool and echoes the response

**Risk if it fails:** either the flag syntax is different, Claude Code can't launch subprocess MCP servers in headless mode, or permission gating blocks it. Any of these breaks the architecture — we'd have to fall back to a different integration (e.g., reading Claude Code stdout patterns, or switching executor).

### 15.2 — Can we read token usage from the three CLIs?

**Steps:**
1. Run Gemini CLI with a tiny prompt; capture stderr; confirm token count parsable
2. Run Codex CLI with `--json`; confirm usage block in output
3. Run Claude Code CLI with `--print --json` (or equivalent headless mode); confirm token block

**Risk if it fails:** token tracking is a goal, not a hard requirement. If we can't read from one CLI, we degrade gracefully (estimate from input length or omit that CLI's tracking in MVP).

### 15.3 — Does MCP tool blocking work (for `ask_user`)?

**Steps:**
1. Extend the spike MCP server with a `notter.block` tool that sleeps 10 seconds before responding
2. Call it from Claude Code
3. **Success:** Claude Code waits for the full 10 seconds, receives the response, continues

**Risk if it fails:** we can't implement HITL via MCP tool blocking. Fallback: HITL via filesystem polling (Claude Code writes a `question.json`, user answers via AgentTrack which writes `answer.json`, Claude Code polls). Less elegant but works.

### Spike deliverable

A short markdown report (`docs/superpowers/specs/2026-04-08-spike-results.md`) documenting:
- Exact Claude Code CLI version and flag syntax used
- Whether each of 15.1, 15.2, 15.3 passed
- Any deviations from the plan
- **Go / No-Go decision** for the full implementation

**If the spike fails on 15.1:** we stop and redesign. Do NOT proceed to implementation.

---

## 16. Phased Roadmap (very high level — detailed plan comes next)

1. **Phase A — Spike (0.5–1 day)** — validate §15
2. **Phase B — Data model + migration** — update types, migrate actions.json v1→v2, tests pass with new shape
3. **Phase C — LLMWorker abstraction + 3 adapters** — Gemini, Codex, Claude Code (plan mode)
4. **Phase D — Planning pipeline (4 steps)** — full pipeline running on real notes, Plan Review Panel UI
5. **Phase E — MCP Server Notter** — 5 tools, integrated with the Zustand store
6. **Phase F — Queue Worker + Execution** — spawn subprocess, Live Execution View, basic HITL modal
7. **Phase G — Report generation + final review UI** — narrative report, approve/reject
8. **Phase H — Token tracking UI + dashboard** — badges and drill-down
9. **Phase I — Dogfood on real tasks** — 3+ real Actions on the AgentTrack project itself; refine prompts based on results

Each phase is its own spec+plan via the GSD workflow. No phase ships until the previous validates.

---

## 17. Out of Scope / Future Roadmap

- Pipeline visual (Abordagem 3) — nodes editáveis estilo n8n
- Parallel execution of multiple Actions
- Full 6-dimension review (add UI, UX, perf, observability reviewers)
- Auto-test gate as part of `auto` trust level
- Screenshots + diff visual for UI tasks
- Cross-project task dependencies
- Supabase sync of Actions/Plans
- Rate-limit-aware queue throttling (circuit breaker)
- Support for additional executors (OpenHands, Aider, local LLM)
- Replay / time-travel debugging of executed Actions
- Team/multi-user mode

---

## 18. Open Questions (to resolve in the spike or early implementation)

1. **Exact Claude Code CLI flags for MCP subprocess spawning** — confirmed in spike 15.1
2. **Best way to read Claude Code token usage in headless mode** — confirmed in spike 15.2
3. **Best IPC between MCP server subprocess and AgentTrack main process** — candidates: Tauri sidecar events, file polling in `state-dir`, Unix socket (cross-platform issue). Default to filesystem polling in a `state-dir` (simplest, works on Windows).
4. **Where to store project-specific Planner→Action mappings** — greenfield projects don't yet have a .planning/ dir; decide whether Actions live under the project folder or centrally in appLocalDataDir (MVP: centrally, as today).
5. **Per-CLI rate limits** — will we hit them often? To be observed during dogfooding.

---

## 19. Success Criteria for MVP

The MVP is considered successful if:

1. The spike (§15) passes and we have a confirmed Claude Code integration path
2. Guilherme can process 3 real Planner notes → approved plans → executed → approved reports on the AgentTrack project without manual shell intervention
3. At least one greenfield project (e.g., expense-tracker) is bootstrapped end-to-end by the pipeline
4. HITL modal triggers correctly in at least one realistic scenario
5. Token tracking shows coherent numbers for all three CLIs
6. State persists across an AgentTrack restart mid-execution (verified manually)
7. Total time to plan (4 steps) for a typical 5-task Action is under 3 minutes
8. Rejecting a plan and re-planning works without corrupting the Action

---
