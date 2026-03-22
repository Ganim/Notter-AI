# Notter-AI System Redesign Spec

## Overview

Notter-AI is a local-first desktop application (Tauri + React + TypeScript) that serves as an intelligent workspace where users can plan, execute, and document development work through a collaborative multi-agent AI system.

The core principle: **you write rough ideas, AI agents refine and execute them, everything stays local on your machine.**

---

## Architecture

### Layers

```
┌─────────────────────────────────────────────────────┐
│                 NOTTER-AI (Tauri)                    │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │            React + Zustand                    │   │
│  │                                               │   │
│  │  ┌─────────┐ ┌───────┐ ┌──────┐ ┌─────────┐ │   │
│  │  │ Planner │ │ Board │ │Agents│ │Terminals│ │   │
│  │  │ Module  │ │Module │ │Module│ │ Module  │ │   │
│  │  └────┬────┘ └───┬───┘ └──┬───┘ └────┬────┘ │   │
│  │       └──────────┼────────┼──────────┘       │   │
│  │                  │        │                   │   │
│  │  ┌───────────────┴────────┴───────────────┐  │   │
│  │  │           Topic System                  │  │   │
│  │  │    (shared memory on filesystem)        │  │   │
│  │  └────────────────┬───────────────────────┘  │   │
│  │                   │                           │   │
│  │  ┌────────────────┴───────────────────────┐  │   │
│  │  │         Vercel AI SDK                   │  │   │
│  │  │   (orchestration + multi-provider)      │  │   │
│  │  └────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │               Rust (Tauri)                    │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │   │
│  │  │ PTY/Shell│ │ File I/O │ │  Auth/Sync   │ │   │
│  │  └──────────┘ └──────────┘ └──────────────┘ │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

1. **UI Modules** — Planner, Board, Agents, Terminals. Each isolated with its own Zustand store.
2. **Topic System** — JSON files on filesystem. Shared memory between agents and across sessions.
3. **Vercel AI SDK** — Agent orchestration, tool calling, streaming, multi-provider support.
4. **Rust/Tauri** — Real PTY for terminal, filesystem I/O, and future auth/sync.

### Core Principle

All data lives on the local filesystem (JSON/Markdown). Zustand is in-memory cache. Filesystem is source of truth.

### API Key Security

API keys for cloud providers (OpenAI, Anthropic, Gemini) are stored in the Rust backend via Tauri's secure credential store (or encrypted JSON in AppLocalData). The frontend never holds raw API keys. All LLM calls are proxied through Tauri commands:

1. Frontend calls `invoke("llm_request", { agentId, messages })`.
2. Rust backend reads the agent's provider config, injects the API key, and forwards to Vercel AI SDK (running server-side via a Tauri sidecar Node process) or directly to provider HTTP APIs.
3. Response streams back to frontend via Tauri events.

For Ollama (local), no key is needed — requests go directly to `localhost:11434`.

### Store-to-Filesystem Sync

Zustand stores sync with the filesystem through these mechanisms:

1. **On app launch** — stores hydrate from filesystem (read all project data).
2. **On agent writes** — Tauri filesystem watcher (`notify` crate) detects changes and emits events to frontend, which updates the relevant Zustand store.
3. **On user actions** — UI writes go through Zustand → filesystem (write-through).
4. **Debounced writes** — editor content saves are debounced (500ms) to avoid excessive I/O.

---

## Provider Layer

```
┌──────────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────┐
│   Ollama      │  │ OpenAI   │  │  Anthropic   │  │  Gemini  │
│  (default)    │  │  (paid)  │  │   (paid)     │  │  (paid)  │
│  free/local   │  │          │  │              │  │          │
└──────┬───────┘  └────┬─────┘  └──────┬───────┘  └────┬─────┘
       └───────────────┴───────────────┴───────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   Vercel AI SDK     │
                    │  (unified interface)│
                    └─────────────────────┘
```

- **No API keys configured** → Ollama local. Works offline, zero cost.
- **User adds API key** → Unlocks cloud models (Claude, GPT, Gemini).
- **Configurable per agent** → Orchestrator on Opus, specialists on Ollama, reviewer on Sonnet.
- Vercel AI SDK abstracts all providers behind a unified interface.

---

## Navigation & Interface

### Top Navigation Bar

```
┌──────────────────────────────────────────────────────────┐
│  [Planner] [Board] [Agents] [Terminals]       [User ▾]  │
└──────────────────────────────────────────────────────────┘
```

**Left — Modules:**

| Tab | Purpose |
|-----|---------|
| **Planner** | Markdown editor with subjects/tasks. User writes rough ideas here. |
| **Board** | Kanban-style view of agent topics. Shows workflow status, task progress, agent discussions. |
| **Agents** | Agent profile configuration — roles, trust levels, provider per agent, pixel-office toggle. |
| **Terminals** | Grid of real PTY terminals. Agents can inject commands, users can type manually. |

**Right — User Menu (dropdown):**

- **Settings** — Default trust levels, project directory, shortcuts
- **Plugins** — List installed, enable/disable, future marketplace
- **Login** — Local by default, optional login for sync (Alpha 4.0)
- **Themes** — Light/dark + editor color themes
- **Language** — i18n selector (en, pt-BR as built-in)

---

## Internationalization (i18n)

### Structure

```
src/
  i18n/
    index.ts            ← setup (language detection, fallback)
    locales/
      en.json           ← English (default/fallback)
      pt-BR.json        ← Portuguese
```

### Principles

1. **English as base** — all keys in `en.json`, universal fallback.
2. **Portuguese as second native language** — maintained by core team.
3. **Extensible as plugin** — community dev creates `notter-plugin-lang-ja` with `ja.json`.
4. **Library: `i18next` + `react-i18next`** — industry standard, lightweight, supports interpolation, plurals, lazy loading.
5. **Auto-detection** — detects system language on first launch, user can override.
6. **Semantic keys** — `planner.createSubject`, `agents.trustLevel.restricted`.

### Community Language Plugin

```json
{
  "name": "notter-plugin-lang-ja",
  "type": "i18n",
  "locale": "ja",
  "file": "ja.json"
}
```

Core loads it automatically. Zero code required.

---

## Topic System (Agent Shared Memory)

### Filesystem Structure

```
AppLocalData/
  NotterAI/
    projects/
      my-project/
        planner/              ← user notes (markdown)
        topics/               ← agent discussion topics
          topic-001.json
          topic-002.json
        agents/               ← agent profiles
        config.json           ← project settings
```

### Topic Schema

```json
{
  "id": "topic-001",
  "title": "Define payment API architecture",
  "status": "in_review",
  "createdBy": "orchestrator",
  "assignedTo": ["backend-specialist", "security-specialist"],
  "priority": "high",
  "parentTask": "planner/feature-payments.md",
  "entries": [
    {
      "id": "e1",
      "agent": "orchestrator",
      "type": "assignment",
      "content": "We need to define the API architecture. Backend, propose. Security, review.",
      "timestamp": "2026-03-22T14:00:00Z",
      "status": "done"
    },
    {
      "id": "e2",
      "agent": "backend-specialist",
      "type": "proposal",
      "content": "I propose REST with JWT...",
      "timestamp": "2026-03-22T14:01:00Z",
      "status": "needs_review"
    }
  ]
}
```

### Status Flow

- **Topic:** `open` → `in_progress` → `in_review` → `approved` → `executing` → `completed` / `cancelled`
- **Entry:** `pending` → `done` / `needs_review` / `rejected`

### Concurrency Control

Multiple agents may write to the same topic. To prevent data loss:

1. **Single-writer queue per topic** — all writes to a topic go through a Rust-side write queue (one writer at a time per `topicId`).
2. **Append-only entries** — agents never modify existing entries, only append new ones. Status changes on existing entries go through a dedicated `update_entry_status` command that uses optimistic locking (read version → write if version matches).
3. **Topic-level version field** — each topic JSON has a `version: number` that increments on every write. Stale writes are rejected and retried.

### Agent Communication Contract

Entry types and their required content schema:

| Entry Type | Created By | Content Must Include | Valid Next Status |
|------------|-----------|---------------------|-------------------|
| `assignment` | Orchestrator | Task description, expected deliverables, assigned agents | `done` |
| `proposal` | Specialist | Solution description, rationale, trade-offs | `done`, `needs_review`, `rejected` |
| `review` | Analyst/Reviewer | Assessment, approval/rejection reason, action items | `done` |
| `question` | Any agent | Question text, context, who should answer | `done` |
| `execution` | Executor | Command(s) to run, target terminal(s), expected outcome | `done`, `needs_review` |
| `result` | Executor | Terminal output, success/failure status, artifacts | `done`, `needs_review` |
| `correction` | Reviewer | What failed, root cause analysis, corrective action | `done` |

### Why JSON, Not a Database

Filesystem is the project's core principle. JSON is human-readable, git-versionable, and easy to debug. If scale becomes an issue, SQLite local is a future option (Tauri supports it natively).

---

## Multi-Agent Pipeline

### Flow

```
User writes rough idea in Planner
            ↓
    [Translator Agent]
    Reads note, extracts intent,
    creates structured tasks on Board
            ↓
      [Orchestrator]
      Reads tasks, creates topics,
      assigns to specialists
            ↓
    ┌───────┼───────┐
    ↓       ↓       ↓
 [Back]  [Front]  [Sec]   ... (specialists discuss in topics)
    └───────┼───────┘
            ↓
       [Analyst]
       Validates topic maturity
            ↓
       [Executor]
       Distributes commands ──→ Terminal 1
       across terminals     ──→ Terminal 2
            ↓
       [Reviewer]
       Checks output
       OK? → next task
       Error? → correction loop
```

### Core Agents (Built-in)

| Agent | Suggested Model | Function |
|-------|----------------|----------|
| **Translator** | Medium (Sonnet/Haiku) | Reads raw notes, extracts intent, generates structured tasks on Board with acceptance criteria |
| **Orchestrator** | Strong (Opus/GPT-4o) | Reads tasks, decomposes, creates topics, delegates to specialists |
| **Specialists** | Light (Ollama/Haiku) | Discuss, propose, refine within topics |
| **Analyst** | Medium (Sonnet) | Evaluates if topic is mature enough for execution |
| **Executor** | Medium (Sonnet) | Translates plan into commands, manages terminals |
| **Reviewer** | Strong (Opus/Sonnet) | Validates terminal output, creates correction topics if needed |

### Parallelism

The orchestrator can have multiple active topics simultaneously. While the executor works on topic A, specialists can be discussing topic B. Tasks don't necessarily wait for each other.

### Note-to-Task Flow

1. User writes rough idea in Planner: "quero um login com google e github, bonito, com dark mode"
2. User triggers "Transform to Tasks" action (button or automatic)
3. **Translator agent** reads the note, generates 4-5 structured tasks with description, priority, dependencies
4. Tasks appear on Board for user review (optional — depends on trust level)
5. **Orchestrator** picks up approved tasks and starts the pipeline

---

## Trust Levels

Configurable per agent or per project.

| Level | Permissions |
|-------|------------|
| **Restricted** | Executor runs only whitelisted commands. All external actions require approval. |
| **Standard** | Executor runs anything within project directory. External actions (push, deploy) require approval. |
| **Autonomous** | Executor runs everything including push/deploy. Full trust in the pipeline. |

Users configure the default trust level in settings and can override per agent profile.

### Enforcement

Trust levels are enforced at the **Rust/Tauri layer**, not in agent prompts (which can hallucinate past restrictions):

1. Every command the Executor wants to run goes through `invoke("execute_command", { terminalId, command, agentId })`.
2. Rust backend checks the agent's trust level against a policy engine:
   - `restricted`: command must match whitelist patterns (configurable in `config.json`).
   - `standard`: command allowed if working directory is within project root. External commands (git push, curl, deploy scripts) trigger an approval request to the frontend.
   - `autonomous`: all commands pass.
3. Denied commands return an error to the agent, which can request user approval or try an alternative.

### Error Recovery & Cost Control

- **Retry limit:** Reviewer correction loops are capped at 3 retries per task. After 3 failures, the task is marked `stuck` and the user is notified.
- **Stuck detection:** If an agent produces no new entries in a topic for 5 minutes, the Orchestrator flags it as stalled.
- **Cost budget:** Each project has an optional `maxTokenBudget` in `config.json`. When reached, cloud provider calls pause and the user is prompted to increase or switch to Ollama.
- **Provider fallback:** If a cloud provider returns 429/500, the system retries once, then falls back to the next configured provider (or Ollama).

---

## Terminal System

### Hybrid Terminal

- **Rust backend** uses `portable-pty` crate for real PTY sessions
- **Windows:** Connects to PowerShell or bash via WSL automatically
- **Frontend:** xterm.js (already exists) receives PTY stream
- **Agent injection:** Executor can inject commands via IPC and read output
- **Terminal IDs:** Each terminal has a `terminalId` that the executor references in topics

### Terminal / Pixel Office Toggle

```
┌─────────────────────────────────────┐
│  [Terminal]  [Office]               │
├─────────────────────────────────────┤
│  (active view based on selection)   │
└─────────────────────────────────────┘
```

- **Terminal** — Grid of real PTY terminals
- **Office** — Canvas 2D pixel art (inspired by pixel-agents). Each agent is a character. Animation reflects state (typing = executing, reading = analyzing topic, waiting = idle).
- The Office view ships bundled with core (not a plugin), since it is a flagship feature of the product. However, it is architecturally built as a `type: "view"` component to serve as a reference implementation for the plugin system.

---

## Plugin System (Superpowers)

### Plugin Structure

```
notter-plugins/
├── plugin.json              ← manifest (name, version, hooks)
├── index.ts                 ← entry point
└── ...
```

### Plugin Types

| Type | What it does | Example |
|------|-------------|---------|
| `agent-role` | New specialist agent role | Docker plugin, AWS plugin, Database plugin |
| `provider` | New LLM provider | Groq, Mistral, custom local LLM |
| `tool` | New tool agents can use | Linter, test runner, deploy tool |
| `view` | New UI visualization | Burndown chart, Kanban, pixel-office |
| `hook` | Reacts to system events | Slack notification, external logging |
| `i18n` | New language translation | Japanese, Spanish, French |

### Plugin Manifest Example

```json
{
  "name": "notter-plugin-docker",
  "description": "Docker/container specialist agent",
  "version": "1.0.0",
  "type": "agent-role",
  "hooks": ["on-topic-created", "on-task-assigned"]
}
```

### Principles

1. **Convention over configuration** — `plugin.json` + entry point, nothing more.
2. **Sandbox** — Plugins run with permissions the user authorizes (respects trust levels).
3. **Discovery** — Core scans `AppLocalData/NotterAI/plugins/` directory on startup. Each subdirectory with a valid `plugin.json` is loaded. Future: marketplace with install/uninstall commands.
4. **Zero plugins required** — Core works standalone, plugins are extras.

### Plugin API Surface (minimum interfaces)

```typescript
// agent-role plugin
export interface AgentRolePlugin {
  systemPrompt: string;
  suggestedModel: "strong" | "medium" | "light";
  tools?: ToolDefinition[];
  onTopicCreated?(topic: Topic): void;
  onTaskAssigned?(task: BoardTask): void;
}

// provider plugin
export interface ProviderPlugin {
  name: string;
  createModel(config: { apiKey: string; model: string }): LanguageModel;
}

// view plugin
export interface ViewPlugin {
  name: string;
  navLabel: string;
  component: React.ComponentType;
}

// hook plugin
export interface HookPlugin {
  events: string[];
  handler(event: SystemEvent): void | Promise<void>;
}

// i18n plugin — no code, just locale JSON file
// tool plugin — follows Vercel AI SDK tool definition format
```

---

## Alpha Roadmap

| Alpha | Focus | Key Deliverables |
|-------|-------|-----------------|
| **1.0** | Planner polished | Markdown editor functional, new navigation (Planner/Board/Agents/Terminals), App.tsx decomposition, Zustand state management, i18n (en + pt-BR), user menu, themes. New deps: `zustand`, `i18next`, `react-i18next`. Existing `src/lib/llm.ts` is deprecated (will be replaced by Vercel AI SDK in 3.0). |
| **2.0** | Real terminal | PTY via Rust (portable-pty), bash/PowerShell/WSL, xterm.js with real stream, programmatic command injection, terminal/office toggle (office placeholder) |
| **3.0a** | Agent foundation | Topic system with concurrency control, Vercel AI SDK integration (replaces `llm.ts`), Board data model and basic UI, single-agent pipeline (translator + executor), trust level enforcement in Rust |
| **3.0b** | Full multi-agent | Full pipeline (orchestrator→specialists→analyst→executor→reviewer), Board Kanban view, pixel-office view, plugin system base with API surface, cost budgets |
| **4.0** | Sync + Login | Local authentication, optional paid sync, backup/restore, multi-device support |

---

## Tech Stack Summary

### Frontend
- React 19 + TypeScript
- Zustand (state management)
- Tailwind CSS + shadcn/ui
- Monaco Editor (markdown editing)
- xterm.js (terminal)
- Canvas 2D (pixel-office)
- i18next + react-i18next (internationalization)
- Vercel AI SDK (agent orchestration)
- react-resizable-panels (layout)

### Backend (Rust/Tauri)
- Tauri 2.x
- portable-pty (real terminal PTY)
- serde/serde_json (serialization)
- tauri-plugin-fs (filesystem)
- tauri-plugin-dialog (file dialogs)

### Data Storage
- Local filesystem (JSON + Markdown)
- AppLocalData directory
- Future: SQLite for scale, cloud sync for paid tier
