# Terminal Revival — Warp-style tabs + bidirectional MCP

**Date:** 2026-05-17
**Status:** Approved for implementation (single-PR / big-bang)
**Source branch reference:** `feature/terminals` (will be cherry-picked + extended)

---

## 1. Overview

Bring back the PTY terminal that was extracted from main into `feature/terminals` and extend it with two killer features that Warp lacks for our workflow:

1. **Warp-style sidebar with tab groups, colors, rename, and chips** (PR#, branch, worktree, CI status, issue#, free-form).
2. **Bidirectional MCP control** — the Claude CLI (or any AI CLI) running *inside* a tab can mutate its own tab's metadata via MCP tools, and orchestrate other tabs with user-granted permission.
3. **Drag-drop file/image into AI CLIs** — paths get pasted into the PTY automatically prefixed with `@` when an AI CLI is detected as the foreground process.

The terminal lives as a dedicated **"Terminals"** tab in the Notter shell, alongside the existing Planner tab.

### Goals

- Restore PTY-backed terminal with multi-shell support (PowerShell/Bash/CMD) for Notter's main developer workflow.
- Replace the old `≤4 grid` layout with a hierarchical groups → tabs sidebar.
- Expose a small, well-scoped **MCP terminal surface** so an AI CLI running inside a tab can self-identify and update its tab's display metadata in real time.
- Make sensitive MCP operations explicit through a per-tab grant system, with an optional **Trusted Tab** mode for power use.
- Implement Warp-style drag-drop attachment by saving clipboard images / dropped files to a temp path and writing the path into the PTY, conditionally prefixed with `@` when the foreground process matches a configurable AI CLI list.
- Persist tab metadata to Supabase per-user so it syncs across machines.

### Non-goals

- **Replace Warp entirely as a general-purpose terminal.** Out of scope: profile management, SSH integration, themes marketplace, AI assist inside the terminal, etc.
- **Network-attached PTYs.** Only local PTYs.
- **macOS / Linux foreground-process detection.** Phase ships Windows-only; other OSes get raw-path drag-drop fallback (no `@` auto-prefix).
- **End-to-end Playwright tests for the terminal.** xterm + PTY + native drag is too hostile to automate reliably; we rely on unit tests + a manual smoke checklist.
- **Reviving the Actions / Agents UI** that lived adjacent on `feature/terminals`. Only the terminal subsystem is brought back.

---

## 2. Architecture

```
src/components/terminals/                    (NEW)
├── TerminalsView.tsx           root: sidebar + active pane layout
├── TerminalSidebar.tsx         search + collapsible groups
├── TerminalGroup.tsx           group header (project name) + collapse
├── TerminalTabItem.tsx         row in sidebar (color bar, name, chips)
├── TerminalPane.tsx            xterm.js viewport + drop overlay host
├── TerminalTopBar.tsx          shell selector, Attach, Restart, Close
├── TabChips.tsx                typed chip rendering + free-form
├── McpPermissionDialog.tsx     grant modal (Deny / Once / Always / Trusted)
├── AttachDropOverlay.tsx       drag-over visual feedback
└── ProjectPickerDialog.tsx     reused/adapted from feature/terminals

src/stores/terminals-store.ts                (REWRITTEN)

src/lib/terminals/
├── tab-identity.ts             env var helper, tab_id resolution
├── ai-cli-detector.ts          foreground process pattern matching
├── chip-schema.ts              TabChip union type + render hints
├── drop-pipeline.ts            unified file/image → PTY write flow
└── shell-path-quote.ts         shell-aware path quoting

src-tauri/src/terminals/                     (NEW MODULE)
├── mod.rs                      PtyManager (from feature/terminals + extensions)
├── foreground.rs               Windows foreground-process detection
└── drop_handler.rs             save clipboard image to temp file

src-tauri/src/mcp/tools/terminal.rs          (NEW — registers terminal.* tools)

supabase/migrations/
└── 2026-05-17-terminal-tabs.sql            (NEW table + RLS)
```

The Rust side keeps a `PtyManager` with one entry per live tab; the frontend Zustand store is the **source of truth** for metadata (name/color/chips/grants); Rust mirrors a small cache so MCP calls can respond without IPC round-trips. The two are kept in sync through Tauri events.

---

## 3. Data Model

### 3.1 TypeScript (Zustand `useTerminalsStore`)

```ts
type TabId = string         // uuid v4
type GroupId = string       // project slug (sha1 of projectPath, 12 chars) | 'ungrouped'
type McpToolName =
  | 'terminal.create_tab'
  | 'terminal.close_tab'
  | 'terminal.send_keys'

interface TerminalTab {
  id: TabId
  groupId: GroupId
  name: string
  color: string | null            // hex, null = default
  cwd: string
  shell: 'powershell' | 'bash' | 'cmd'
  chips: TabChip[]
  permissionGrants: Partial<Record<McpToolName, true>>  // LOCAL only
  trusted: boolean                                       // LOCAL only
  createdAt: string               // ISO
  // Runtime-only (not persisted)
  ptyAlive?: boolean
}

type TabChip =
  | { type: 'pr',       value: { number: number; url?: string; state?: 'open' | 'merged' | 'closed' } }
  | { type: 'branch',   value: { name: string } }
  | { type: 'worktree', value: { name: string; path?: string } }
  | { type: 'ci',       value: { state: 'passing' | 'failing' | 'pending'; url?: string; label?: string } }
  | { type: 'issue',    value: { number: number; url?: string; state?: 'open' | 'closed' } }
  | { type: 'status',   value: { label: string; severity?: 'ok' | 'warn' | 'err' } }
  | { type: 'free',     value: { label: string; color?: string } }

interface TerminalGroup {
  id: GroupId
  name: string                    // display = project name
  projectPath: string
  collapsed: boolean              // LOCAL only
}

interface TerminalsState {
  tabs: Record<TabId, TerminalTab>
  groups: Record<GroupId, TerminalGroup>
  activeTabId: TabId | null
  search: string

  // Tab CRUD
  createTab: (init: Partial<TerminalTab> & { cwd: string; shell?: TerminalTab['shell'] }) => TabId
  renameTab: (id: TabId, name: string) => void
  setTabColor: (id: TabId, hex: string | null) => void
  setActiveTab: (id: TabId) => void
  removeTab: (id: TabId) => void
  moveTabToGroup: (id: TabId, groupId: GroupId) => void
  setTrusted: (id: TabId, trusted: boolean) => void
  grantPermission: (id: TabId, tool: McpToolName) => void
  revokePermission: (id: TabId, tool: McpToolName) => void

  // Chips
  setChip: (id: TabId, chip: TabChip) => void       // upsert by type (multi for 'free')
  removeChip: (id: TabId, type: TabChip['type'], index?: number) => void

  // Groups
  ensureGroupForProject: (projectPath: string, projectName: string) => GroupId
  toggleGroupCollapse: (id: GroupId) => void

  // Sync (Supabase realtime hook target)
  applyRemoteUpsert: (row: TerminalTabRow) => void
  applyRemoteDelete: (id: TabId) => void
}
```

Multiple `free` chips are allowed; the other types are upserted by type (one PR chip per tab, one branch, etc.).

### 3.2 Supabase schema

`supabase/migrations/2026-05-17-terminal-tabs.sql`:

```sql
create table if not exists terminal_tabs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  group_id     text not null,
  group_name   text not null,
  group_path   text not null,
  name         text not null,
  color        text,
  cwd          text not null,
  shell        text not null check (shell in ('powershell', 'bash', 'cmd')),
  chips        jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index terminal_tabs_user_idx on terminal_tabs (user_id, created_at);

alter table terminal_tabs enable row level security;

create policy "owner select" on terminal_tabs for select using (auth.uid() = user_id);
create policy "owner insert" on terminal_tabs for insert with check (auth.uid() = user_id);
create policy "owner update" on terminal_tabs for update using (auth.uid() = user_id);
create policy "owner delete" on terminal_tabs for delete using (auth.uid() = user_id);

create or replace function terminal_tabs_touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger terminal_tabs_touch
  before update on terminal_tabs
  for each row execute function terminal_tabs_touch_updated_at();
```

**Sync semantics:**
- Group identity is denormalized onto each row (`group_id` + `group_name` + `group_path`). Cheaper than a second table; groups have no other state worth syncing.
- `permissionGrants` and `trusted` are **intentionally local-only** — never sent to Supabase. Permission grants must be a deliberate per-machine choice; we never sync a permission decision.
- `ptyAlive` is local-only (PTY lifecycle does not survive `terminal_tabs` insert/select).
- Realtime: subscribe on login to `terminal_tabs` filtered by `user_id`. Other machines reconcile via `applyRemoteUpsert` / `applyRemoteDelete`.
- Tabs reopened from a different machine come up **PTY-cold**: the pane shows a "Start session" button instead of an immediately-spawned shell.

---

## 4. MCP Tool Surface

### 4.1 Tab identity

When a PTY is spawned, `CommandBuilder.env("NOTTER_TERMINAL_ID", tab.id)` injects the tab's UUID into the child shell's environment. **The AI CLI is responsible for reading its own `NOTTER_TERMINAL_ID` env var and passing it as `tab_id` on every relevant MCP call.** Notter does not snoop the caller's process tree (rationale in §9).

If `tab_id` is omitted and the call requires a tab target, the call returns an error: `"tab_id required: caller did not pass NOTTER_TERMINAL_ID from its environment"`.

### 4.2 Auto-allowed tools (whitelist)

| Tool | Args | Effect |
|---|---|---|
| `terminal.set_name` | `tab_id?, name: string` | Renames the tab. |
| `terminal.set_color` | `tab_id?, hex: string \| null` | Sets / clears the tab's color bar. |
| `terminal.set_chip` | `tab_id?, chip: TabChip` | Upserts a chip (by `type`; `free` allows multiple). |
| `terminal.remove_chip` | `tab_id?, type: TabChip['type'], index?: number` | Removes a chip; `index` only meaningful for `free`. |
| `terminal.list_tabs` | — | Returns array of tab summaries for the calling user. |
| `terminal.get_tab` | `tab_id?` | Returns one tab summary. |
| `terminal.focus_tab` | `tab_id` | Selects the tab in the sidebar. UI-only, no destructive effect → whitelisted. |

`list_tabs` / `get_tab` return shape: `{ id, groupId, groupName, name, color, cwd, shell, chips, trusted, ptyAlive }`. **Never** returns `permissionGrants`.

### 4.3 Sensitive tools (per-tab grant required)

| Tool | Args | Why sensitive |
|---|---|---|
| `terminal.create_tab` | `groupHint?, cwd?, shell?, name?` | Spawns a new PTY and the configured shell. |
| `terminal.close_tab` | `tab_id` | Kills a running PTY. |
| `terminal.send_keys` | `tab_id, data: string` | Equivalent to typing in the tab — can run arbitrary commands. |

A sensitive call without a matching `permissionGrants[tool]` entry and without `trusted: true` on the target tab triggers `McpPermissionDialog`. The dialog offers four resolutions:

- **Deny** — returns `error: "permission denied"` to MCP caller.
- **Allow once** — proceeds, no grant stored.
- **Always allow in this tab** — proceeds; sets `permissionGrants[tool] = true` (local, evicted on tab close).
- **Mark tab as Trusted** — proceeds; sets `trusted: true` on the tab. All future sensitive ops in this tab skip the modal.

A pending modal blocks the MCP tool call up to **60 seconds**, after which it returns `error: "permission timeout"`. Concurrent prompts for the same tab are queued and the modal shows "1 of N pending".

### 4.4 Wire-up

Tools are registered in `src-tauri/src/mcp/tools/terminal.rs` and added to the existing tool router in `src-tauri/src/mcp/tools.rs`. They live alongside the existing planner tools and use the same auth/session middleware.

**Bidirectional sync flow:**

- **MCP-originated changes** (e.g., `set_name` called by Claude): Rust updates its `TabMeta` cache → emits Tauri event → frontend receives event → frontend updates Zustand store → store writes to Supabase. Other devices receive via Supabase realtime.
- **UI-originated changes** (user renames a tab): frontend updates Zustand → writes to Supabase → calls Tauri command `notify_tab_metadata` so backend cache stays in sync for subsequent MCP `get_tab` / `list_tabs` calls.

Events emitted by Rust to the frontend:

- `terminal:tab-updated` → payload `{ id, patch: Partial<TerminalTab> }`
- `terminal:tab-created` → payload `TerminalTab`
- `terminal:tab-closed` → payload `{ id }`
- `terminal:permission-request` → payload `{ id, tool, args, requestId }`

Frontend listens once at boot. Permission responses go back via Tauri command `mcp_permission_resolve(requestId, decision)`.

---

## 5. Drag-Drop Pipeline

### 5.1 Inputs

1. **OS file drop** — `tauri::WebviewWindow::on_drop` (preferred over web DnD because it gives a real OS path, not a synthetic blob).
2. **Web file/image drop** — `dragover` / `drop` events on the xterm viewport for content originating from a browser (no real OS path; falls into "clipboard-image" path).
3. **Clipboard image paste** — xterm's `onPaste` intercept when the system clipboard contains an image.
4. **Explicit Attach button** — file picker in `TerminalTopBar`.

### 5.2 Unified flow

In `src/lib/terminals/drop-pipeline.ts`:

```
input { kind, payload }
  ↓
normalize to { localPath: string }
  ├ kind 'file':            payload.path (already a real path)
  └ kind 'clipboard-image': invoke('save_clipboard_image', { dataUrl }) → temp path
  ↓
detect foreground:
  invoke('get_pty_foreground', { tabId }) → { name, pid }
  match name against aiCliList → matched: boolean
  ↓
quote path per current shell:
  bash:        forward slash, single-quote if contains space/special
  powershell:  backslash, single-quote with '' escape, or backtick-escape
  cmd:         backslash, double-quote
  ↓
prefix = matched ? '@' : ''
write_pty(tabId, `${prefix}${quotedPath} `)
```

### 5.3 Foreground detection (Windows)

`src-tauri/src/terminals/foreground.rs`:

- `portable-pty` on Windows uses ConPTY, which spawns `conhost.exe` as a wrapper around the user-requested shell.
- Use `windows-rs` `CreateToolhelp32Snapshot` + `Process32First` / `Process32Next` to enumerate processes and build a parent→child map.
- Starting from the PTY's tracked child PID, walk descendants depth-first; pick the deepest non-`conhost.exe` process.
- Cache result per tab for 500ms (`Mutex<HashMap<TabId, (Instant, ForegroundInfo)>>`) so the per-keystroke drag-over detection doesn't enumerate processes 60 times/second.

If the snapshot returns no descendants or the call fails, foreground detection returns `{ name: shell, pid: ptyChildPid }` as a graceful fallback.

### 5.4 AI CLI list

Default (in `src/lib/terminals/ai-cli-detector.ts`):

```ts
[
  { name: 'claude', match: /^claude(\.exe|\.cmd|\.bat)?$/i, prefix: '@', enabled: true },
  { name: 'codex',  match: /^codex(\.exe|\.cmd|\.bat)?$/i,  prefix: '@', enabled: true },
  { name: 'aider',  match: /^aider(\.exe|\.cmd|\.bat)?$/i,  prefix: '@', enabled: true },
]
```

Editable in **Settings → Terminal → AI CLI Detection**: add / remove / disable entries. Per-entry custom `prefix` (default `@`).

### 5.5 Temp file lifecycle

- Path: `%TEMP%/notter-paste/<uuid>.<ext>`.
- On Tauri app startup: spawn a background task that deletes files older than 24 h in that directory.
- No immediate cleanup after paste — the user might paste the same path into a second command.

---

## 6. Permission UX

`McpPermissionDialog` is a single global modal mounted at the app root. Only one is visible at a time; further requests queue.

### 6.1 Modal contents

```
┌────────────────────────────────────────────────────────┐
│  Claude (tab "PR review") wants to:                    │
│                                                        │
│    Send keystrokes:                                    │
│      > pnpm test --watch                               │
│                                                        │
│  [ Deny ]  [ Allow once ]  [ Always in this tab ]      │
│                                                        │
│  ☐ Mark this tab as Trusted (skip all prompts here)    │
│                                                        │
│  (1 of 3 pending)                                      │
└────────────────────────────────────────────────────────┘
```

- The title identifies the caller and the target tab.
- The body shows the tool action verb + its primary argument, truncated to 500 characters with "…(N more chars)" indicator.
- Decision buttons return through `mcp_permission_resolve(requestId, decision)`.
- "Mark as Trusted" is an independent checkbox: when checked, *whichever* primary action is taken also flips `trusted: true` for the tab.
- Footer shows queue depth.

### 6.2 Trusted Tab indicator

A tab marked `trusted: true` shows a small shield/check glyph in `TerminalTabItem` and in `TerminalTopBar`. Right-click the tab → context menu has "Unmark trusted".

### 6.3 Timeout

60 seconds without resolution → MCP call returns `error: "permission timeout"`. The modal stays open until dismissed but its decision becomes a no-op for the timed-out call (next-in-queue takes over).

---

## 7. Components — key behaviors

| Component | Key behavior |
|---|---|
| `TerminalsView` | Flex layout: fixed 240px sidebar + flex-1 active pane. `Ctrl+B` toggles sidebar collapse (persisted local). |
| `TerminalSidebar` | Search input filters tabs by name and chip values. `+` opens `ProjectPickerDialog`. Drag-reorder of tabs within a group. |
| `TerminalGroup` | Header: project name + tab count + collapse chevron. Acts as drop target for moving tabs between groups. Collapsed state local-only. |
| `TerminalTabItem` | 3px left color bar (from `color`). Tab name (single line). Chips row below (overflow-x clipped, tooltip on hover). Active tab = highlighted bg. Right-click context menu: Rename, Set color, Mark trusted, Close, Move to group. |
| `TerminalPane` | xterm.js mounted-but-hidden for inactive tabs to preserve scrollback + PTY state (mirrors the `635496d` fix from `feature/terminals`). Listens to `pty-output` / `pty-exit` events filtered by tab id. Hosts `AttachDropOverlay`. |
| `TerminalTopBar` | Shell selector (PS / Bash / CMD). Attach button (paperclip). Restart. Close. Trusted shield indicator when applicable. |
| `TabChips` | Per-type rendering: `pr` (GitHub icon, blue, click → open url), `branch` (git icon), `worktree` (folder icon), `ci` (status icon colored by state), `issue` (bug icon), `status` (label colored by severity), `free` (label with optional color). |
| `McpPermissionDialog` | Described in §6. |
| `AttachDropOverlay` | Full-pane semi-transparent overlay on `dragover` with "Drop to attach" text. |

---

## 8. Backend Rust — changes beyond the `feature/terminals` baseline

- Module reshuffle: move PTY code from a flat file into `src-tauri/src/terminals/` module. Keep the existing `portable-pty` based `PtyManager` API surface (`create_pty`, `write_pty`, `resize_pty`, `close_pty`) — these stay command-compatible.
- Add to `PtyManager`: `tabs: HashMap<TabId, TabMeta>` parallel to `sessions`. `TabMeta { name, color, chips, trusted, group_id }`. This is the **backend cache** for MCP responsiveness; frontend is still source of truth and updates flow via Tauri command `notify_tab_metadata(tab_id, patch)`.
- `CommandBuilder.env("NOTTER_TERMINAL_ID", tab.id)` injected at spawn time inside `create_pty`.
- New Tauri commands:
  - `save_clipboard_image(data_url: String) -> Result<String, String>` — decodes data URL, writes to `%TEMP%/notter-paste/<uuid>.<ext>`, returns full path.
  - `get_pty_foreground(tab_id: String) -> Result<ForegroundInfo, String>` — calls into `foreground.rs`.
  - `notify_tab_metadata(tab_id: String, patch: serde_json::Value) -> Result<(), String>` — frontend → backend metadata mirror.
  - `mcp_permission_resolve(request_id: String, decision: String)` — frontend → backend response channel for pending sensitive MCP calls.
- New MCP tools registered in `src-tauri/src/mcp/tools/terminal.rs` (the 10 tools from §4). Sensitive tools `await` on a oneshot channel attached to a pending request map keyed by `request_id`.
- New Tauri events listed in §4.4.

`MasterPty`-based resize keeps working as in the original branch.

---

## 9. Tab-Identity Mechanism

The `NOTTER_TERMINAL_ID` environment variable is the canonical handshake between an MCP-aware AI CLI and the tab it's running inside:

1. On `create_pty`, the Rust side adds `NOTTER_TERMINAL_ID=<tab.id>` to the `CommandBuilder` environment before spawning.
2. The shell inherits it. Any process spawned by the shell (e.g., `claude`, `codex`) also inherits it.
3. When such a process issues an MCP call to Notter (over the existing MCP HTTP/stdio server), Notter resolves `tab_id` defaults by:
   - First, checking the incoming MCP session/connection metadata if the client passes it explicitly (preferred when possible).
   - Otherwise, MCP requires `tab_id` to be explicit; **the env var is consumed client-side by the CLI itself** (the AI CLI is expected to read `NOTTER_TERMINAL_ID` from its own environment and include it on calls).

We document this contract in a new `docs/MCP-TERMINAL.md` so wrapper scripts and AI CLIs can adopt it. We do **not** rely on Notter snooping the caller's process tree — that's both fragile and a privacy footgun. The env var is the contract; the AI CLI is responsible for carrying it through.

For internal Notter callers (we may, in future, add a "post message into terminal X" helper from within the app), the same env var convention applies; if missing, `tab_id` is mandatory.

---

## 10. AI CLI Detection (drag-drop only)

Distinct from §9. Drag-drop foreground detection uses Windows process enumeration (§5.3) because it answers "what is currently running interactively in this PTY?" — a question the AI CLI cannot answer on Notter's behalf because the user might drop *while* a command is running.

This is **purely best-effort**:
- Detection fails → no `@` prefix, raw path written. The user can still add `@` manually.
- Detection succeeds but matches no entry in the AI CLI list → raw path.
- Match → prefix configured per-entry.

---

## 11. Testing

| Layer | Approach |
|---|---|
| Zustand store | Vitest. Cover CRUD, chip upsert (single vs `free` multi), permission grant lifecycle, Supabase realtime merge (`applyRemoteUpsert` idempotency, late-arriving deletes). |
| MCP tools (Rust) | Unit tests with a `MockPtyManager`. Verify auto-allowed vs sensitive routing, `tab_id` resolution error path, response shape for `list_tabs` excluding `permissionGrants`. |
| Foreground detection (Rust) | Integration test (Windows only, gated `#[cfg(target_os = "windows")]`). Spawn a known process under a fake PTY and assert detection picks the right name. Cache TTL verified. |
| Drag-drop pipeline (TS) | Vitest unit on `drop-pipeline.ts` mocking `invoke`. Cover: file with space in path → quoted correctly per shell; clipboard image → save then path; AI CLI matched → `@` prefix; not matched → no prefix; detection failure → no prefix. |
| Permission modal | RTL render + button-click tests. Verify Deny / Once / Always / Trusted produce the right state mutations and resolve the request id. |
| Path quoting | Vitest unit on `shell-path-quote.ts` against a fixture of paths with spaces, single quotes, backticks. |
| Supabase RLS | `supabase test db` SQL test verifying a second user cannot select / update another user's `terminal_tabs`. |
| End-to-end | Manual smoke checklist (PowerShell script `scripts/smoke-terminal.ps1`) covering: open tab, type, drag image, switch shell, kill PTY + restart, MCP set_name from a script, sensitive op modal flow. Not Playwright. |

Coverage target: > 85 % on the Zustand store, drop pipeline, and path quoting (the highest-leverage logic). MCP tools tested for happy-path + error-path on each tool.

---

## 12. Dependencies

New crates (run through Sonatype-guide before adding):
- `windows` (with features `Win32_System_Diagnostics_ToolHelp`, `Win32_System_Threading`) — Windows process enumeration.

Existing crates already on `feature/terminals` to bring over:
- `portable-pty = "0.9"`

New npm packages already present on `feature/terminals`:
- `@xterm/xterm` `^6.0.0`
- `@xterm/addon-fit` `^0.11.0`
- `@xterm/addon-ligatures` `^0.10.0`

No additional npm packages needed for drag-drop (uses native Tauri + browser APIs).

---

## 13. Open questions / future work

- **Cross-platform foreground detection.** macOS / Linux ship later. Until then, those platforms drop raw paths.
- **Process-tree-aware MCP auth.** Today the AI CLI passes `NOTTER_TERMINAL_ID` itself. Future enhancement: Notter MCP server inspects the connection origin and resolves automatically.
- **Multiple Notter windows.** PTYs and tabs are app-wide singletons. If we later support multiple windows, the active tab becomes window-scoped; sidebar still global.
- **Tab archiving.** No archive UX in this scope. A closed tab is gone (PTY + row). If users complain about losing context, we can revisit.
- **Group reordering / renaming.** Groups are derived from project paths; their names follow the project name. No manual rename. If the user wants a different display name, they can rename the project in the planner.
- **Sharing tabs across workspaces.** Out of scope. Tabs are per-user (RLS), not per-workspace; this matches the user's mental model that the terminal is "their" workspace tool.

---

## 14. Acceptance criteria (single PR)

The PR merges to `main` when **all** of the following hold:

1. New "Terminals" tab is reachable in the Notter shell on Windows.
2. Opening a tab in a known project path puts it in the right group automatically.
3. Renaming, recoloring, and adding/removing each chip type works via UI **and** via MCP.
4. `terminal.set_name` called by an external MCP client (with `NOTTER_TERMINAL_ID` set) updates the right tab live.
5. Sensitive MCP call without a grant triggers the modal; each of the four resolutions behaves as specified.
6. Trusted-tab toggle skips sensitive modals as expected.
7. Dragging an image from the OS into a tab where `claude` is the foreground writes `@<temp-path> ` into the PTY; with a non-AI shell, the same drag writes the raw path.
8. Tab metadata persists across app restart and syncs to a second logged-in machine.
9. Closing a tab kills its PTY and removes the row from Supabase.
10. Vitest + Rust test suites pass; manual smoke checklist passes.
11. Codex review run completes (per the Plan 2 workflow precedent), and any actionable findings are applied or explicitly deferred with rationale.
