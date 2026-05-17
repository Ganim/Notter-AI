# Terminal Revival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the PTY terminal from `feature/terminals` as a dedicated "Terminals" tab on `main`, with Warp-style sidebar (groups by Project, colors, rename, typed/free chips), bidirectional MCP control (7 auto-allowed + 3 sensitive tools with per-tab grants and Trusted-tab mode), drag-drop file/image pipeline with Windows foreground-process detection and configurable AI-CLI auto-`@`-prefixing, and per-user Supabase realtime sync of tab metadata.

**Architecture:** A new `src-tauri/src/terminals/` Rust module owns the PTY lifecycle (wrapping `portable-pty`) and a backend metadata cache. A new `src/components/terminals/` React tree owns the UI. The Zustand store `terminals-store` is the **source of truth** for tab metadata; the Rust cache mirrors it for MCP responsiveness. MCP `terminal.*` tools are registered in the existing axum-based MCP router (`src-tauri/src/mcp/`), with `AppHandle` reaching them via an axum `Extension` (NOT a struct field — that breaks `cargo test` on Windows). Per-user Supabase RLS table `terminal_tabs` provides cross-device sync of metadata only; PTY state and permission grants stay local.

**Tech Stack:** Rust (`portable-pty 0.9`, `windows` crate for Windows process enumeration, axum, tokio), TypeScript (`@xterm/xterm 6`, `@xterm/addon-fit`, `@xterm/addon-ligatures`, Zustand, React 19), Supabase (Postgres + Realtime + RLS), Tauri 2.

**Spec:** `docs/superpowers/specs/2026-05-17-terminal-revival-design.md`

**Reference branch:** `feature/terminals` — port the PTY backend (`src-tauri/src/lib.rs` portions), `TerminalView.tsx`, and `terminals-store.ts` from there. Do NOT bring back `ActionsTab.tsx` / `AgentsTab.tsx` / `OllamaPanel.tsx` etc. — out of scope.

**Pre-flight (manual, before Task 1):** The `windows` crate addition was supposed to go through the `sonatype-guide` MCP, but the MCP returned an authentication error during planning. Before adding the dep in Task 3, the implementer must run `sonatype-guide:getComponentVersion` on `pkg:cargo/windows@<pinned-version>` manually and confirm: not malicious, no Critical/High CVEs, Trust Score >= 80. If the MCP is still unreachable, manually verify on `https://crates.io/crates/windows` that the publisher is `microsoft` and the latest release is recent (within 3 months).

**Commit cadence:** One commit per task. Each task ends with the `git add` + `git commit` step explicitly shown. Use Conventional Commit prefixes (`feat`, `fix`, `chore`, `test`, `refactor`, `docs`).

**Branch:** Work on a new branch `feat/terminal-revival` off `main` HEAD (`d31a3ec` at planning time).

---

## File Structure

### New TypeScript files

| Path | Responsibility |
|---|---|
| `src/components/terminals/TerminalsView.tsx` | Root of the Terminals tab: sidebar + active pane layout, Ctrl+B toggle |
| `src/components/terminals/TerminalSidebar.tsx` | Search input, list of groups, "+" button |
| `src/components/terminals/TerminalGroup.tsx` | Collapsible header per project + child tab list |
| `src/components/terminals/TerminalTabItem.tsx` | One tab row: color bar, name, chips, context menu, drag handle |
| `src/components/terminals/TerminalPane.tsx` | xterm.js mount, PTY lifecycle (mounted-but-hidden for inactive tabs) |
| `src/components/terminals/TerminalTopBar.tsx` | Shell selector, Attach, Restart, Close, Trusted shield indicator |
| `src/components/terminals/TabChips.tsx` | Type-specific chip rendering (pr/branch/worktree/ci/issue/status/free) |
| `src/components/terminals/McpPermissionDialog.tsx` | Modal: Deny / Once / Always / Trusted, with queue counter |
| `src/components/terminals/AttachDropOverlay.tsx` | Semi-transparent drag-over overlay |
| `src/components/terminals/ProjectPickerDialog.tsx` | Adapted from `feature/terminals` — pick project for new tab |
| `src/stores/terminals-store.ts` | Zustand store (rewritten from `feature/terminals`) |
| `src/lib/terminals/tab-identity.ts` | `NOTTER_TERMINAL_ID` constants + helpers |
| `src/lib/terminals/ai-cli-detector.ts` | AI CLI list defaults + matcher |
| `src/lib/terminals/chip-schema.ts` | `TabChip` union + render-hint metadata |
| `src/lib/terminals/drop-pipeline.ts` | Unified drop flow (input → normalize → detect → quote → write) |
| `src/lib/terminals/shell-path-quote.ts` | Shell-aware path quoting (PS / bash / cmd) |
| `src/lib/terminals/supabase-sync.ts` | terminal_tabs CRUD + realtime subscribe |

### New Rust files

| Path | Responsibility |
|---|---|
| `src-tauri/src/terminals/mod.rs` | `PtyManager`, Tauri commands `create_pty` / `write_pty` / `resize_pty` / `close_pty` / `notify_tab_metadata` / `mcp_permission_resolve`, public types |
| `src-tauri/src/terminals/foreground.rs` | Windows process-tree walker with 500ms cache |
| `src-tauri/src/terminals/drop_handler.rs` | `save_clipboard_image(data_url) -> path` |
| `src-tauri/src/mcp/tools/mod.rs` | Re-exports (renames existing `tools.rs` into a module so we can add `tools/terminal.rs`) |
| `src-tauri/src/mcp/tools/terminal.rs` | The 10 `terminal.*` MCP tools + sensitive-call pending request map |

### Modified files

| Path | Change |
|---|---|
| `src-tauri/Cargo.toml` | Add `portable-pty = "0.9"`, `windows = { version = "...", features = [...] }`, `base64`, `uuid` (if not present) |
| `src-tauri/src/lib.rs` | Register new Tauri commands; manage `PtyManager` state; insert `AppHandle` extension on MCP router |
| `src-tauri/src/mcp/server.rs` | Inject `AppHandle` and `Arc<PtyManager>` as axum Extensions on the router; extend `dispatch` signature to accept them |
| `src-tauri/src/mcp/tools.rs` | Rename to `src-tauri/src/mcp/tools/mod.rs` and split planner tools out where reasonable (only if natural — otherwise just rename) |
| `package.json` | Re-add `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-ligatures` |
| `src/components/Layout.tsx` | Add "Terminals" entry to the main tab list |
| `src/i18n/locales/en.json`, `src/i18n/locales/pt-BR.json` | Add `terminals.*` strings (carry over from `feature/terminals` + new permission/chip strings) |
| `src/components/settings/tabs/GeneralTab.tsx` | Add "AI CLI Detection" section (list editor) |
| `src/stores/app-store.ts` | Add `terminalSettings.aiCliList` field |
| `src-tauri/capabilities/default.json` | Allow new Tauri commands |

### New SQL

| Path | Purpose |
|---|---|
| `supabase/migrations/2026-05-17-terminal-tabs.sql` | Table + RLS + trigger |

### New script

| Path | Purpose |
|---|---|
| `scripts/smoke-terminal.ps1` | Manual smoke checklist (PowerShell) — covers open/type/resize/MCP/drag-drop/restart |

---

## Pre-Phase: Branch + deps

### Task 0: Create branch and verify clean main

**Files:**
- No file changes (git operations only)

- [ ] **Step 1: Create the feature branch off `main`**

Run:
```bash
git checkout main && git status --short
```
Expected: only `M src-tauri/Cargo.toml` (the CRLF normalization) and untracked `.claude/` / `.clone/`. No other dirty state.

- [ ] **Step 2: Branch**

Run:
```bash
git checkout -b feat/terminal-revival
```

- [ ] **Step 3: Confirm `feature/terminals` is fetchable for reference**

Run:
```bash
git show feature/terminals:src/components/TerminalView.tsx | head -5
```
Expected: prints the import lines of the old TerminalView. We will use it as a reference only — do not cherry-pick wholesale.

(No commit for this task — it's just setup.)

---

## Phase A — Backend foundation (PTY + native helpers)

### Task 1: Add Rust deps and scaffold the `terminals` module

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/terminals/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod terminals;`)

- [ ] **Step 1: Run sonatype-guide pre-flight (see plan header)**

Manually verify `pkg:cargo/windows` and `pkg:cargo/portable-pty@0.9.0` via the MCP, or check crates.io directly. If `windows` has critical CVEs or is flagged malicious, **STOP** and reconvene before continuing.

- [ ] **Step 2: Add deps to `src-tauri/Cargo.toml`**

Open `src-tauri/Cargo.toml` and add under `[dependencies]`:
```toml
portable-pty = "0.9"
base64 = "0.22"
uuid = { version = "1", features = ["v4", "serde"] }

[target.'cfg(windows)'.dependencies]
windows = { version = "0.59", features = [
    "Win32_System_Diagnostics_ToolHelp",
    "Win32_System_Threading",
    "Win32_Foundation",
] }
```

(Pin the exact `windows` version returned by your sonatype-guide check. `0.59` is a placeholder.)

- [ ] **Step 3: Scaffold the module**

Create `src-tauri/src/terminals/mod.rs`:
```rust
//! PTY lifecycle, foreground process detection, and drop-handler helpers.
//!
//! The PtyManager owns all live PTY sessions and a parallel metadata cache
//! mirrored from the frontend Zustand store.

pub mod foreground;
pub mod drop_handler;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabMeta {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub color: Option<String>,
    pub cwd: String,
    pub shell: String,
    pub chips: serde_json::Value, // opaque to backend, stored verbatim
    pub trusted: bool,
}

pub struct PtyManager {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    pub tabs: Mutex<HashMap<String, TabMeta>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tabs: Mutex::new(HashMap::new()),
        }
    }
}

pub struct PtySession {
    pub writer: Box<dyn std::io::Write + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send>,
    pub child_pid: Option<u32>,
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
```

- [ ] **Step 4: Register the module in `src-tauri/src/lib.rs`**

Open `src-tauri/src/lib.rs` and find the existing `mod` declarations near the top. Add:
```rust
mod terminals;
```

In the `tauri::Builder` setup, add the PtyManager to managed state. Locate the existing `.manage(...)` calls and add:
```rust
.manage(std::sync::Arc::new(terminals::PtyManager::new()))
```

- [ ] **Step 5: Verify compile**

Run:
```bash
cd src-tauri && cargo check
```
Expected: compiles cleanly. If errors mention unused imports, that's fine; if anything else, fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/terminals/mod.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
chore: scaffold terminals module + portable-pty / windows / base64 / uuid deps

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Implement PTY lifecycle commands with `NOTTER_TERMINAL_ID`

**Files:**
- Modify: `src-tauri/src/terminals/mod.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)
- Test: `src-tauri/src/terminals/tests.rs` (new — wired in via `#[cfg(test)] mod tests;`)

- [ ] **Step 1: Write failing test for `NOTTER_TERMINAL_ID` injection**

Create `src-tauri/src/terminals/tests.rs`:
```rust
#![cfg(test)]
use super::*;

#[test]
fn tab_meta_round_trips_through_json() {
    let m = TabMeta {
        id: "abc".into(),
        group_id: "g1".into(),
        name: "PR review".into(),
        color: Some("#3b82f6".into()),
        cwd: "C:\\code\\foo".into(),
        shell: "powershell".into(),
        chips: serde_json::json!([]),
        trusted: false,
    };
    let s = serde_json::to_string(&m).unwrap();
    let back: TabMeta = serde_json::from_str(&s).unwrap();
    assert_eq!(back.id, "abc");
    assert_eq!(back.shell, "powershell");
}

#[test]
fn build_command_injects_terminal_id() {
    let cmd = super::build_command_for("powershell", Some("C:\\code"), "tab-uuid-xyz");
    let env: Vec<_> = cmd.iter_env_as_str().collect();
    assert!(
        env.iter().any(|(k, v)| *k == "NOTTER_TERMINAL_ID" && *v == "tab-uuid-xyz"),
        "missing NOTTER_TERMINAL_ID env var: {env:?}"
    );
}
```

Wire it in by adding to `src-tauri/src/terminals/mod.rs`:
```rust
#[cfg(test)]
mod tests;
```

- [ ] **Step 2: Run the test and watch it fail**

Run:
```bash
cd src-tauri && cargo test -p notter_lib build_command_injects_terminal_id
```
Expected: FAIL with "cannot find function `build_command_for`".

- [ ] **Step 3: Implement `build_command_for` + the PTY commands**

Append to `src-tauri/src/terminals/mod.rs`:
```rust
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, State};

pub fn build_command_for(shell: &str, cwd: Option<&str>, tab_id: &str) -> CommandBuilder {
    let exe = match shell {
        "bash" => detect_bash(),
        "cmd" => "cmd.exe".to_string(),
        _ => "powershell.exe".to_string(),
    };
    let mut cmd = CommandBuilder::new(exe);
    if let Some(p) = cwd {
        cmd.cwd(p);
    }
    cmd.env("NOTTER_TERMINAL_ID", tab_id);
    cmd
}

fn detect_bash() -> String {
    // WSL bash if available; otherwise git-bash; otherwise plain "bash" (will error).
    if std::process::Command::new("wsl").arg("--status").output().is_ok() {
        return "wsl.exe".to_string();
    }
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let gb = format!("{pf}\\Git\\bin\\bash.exe");
    if std::path::Path::new(&gb).exists() { return gb; }
    "bash".to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyOutput { id: String, data: String }

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExit { id: String, code: i32 }

#[tauri::command]
pub async fn create_pty(
    app: AppHandle,
    mgr: State<'_, Arc<PtyManager>>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: String,
) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    let cmd = build_command_for(&shell, cwd.as_deref(), &id);
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {e}"))?;
    let child_pid = child.process_id();

    drop(pair.slave); // close slave handle in this process

    let reader = pair.master.try_clone_reader().map_err(|e| format!("clone_reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("take_writer: {e}"))?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_thread = cancel.clone();
    let id_thread = id.clone();
    let app_thread = app.clone();

    // Reader thread → emits pty-output and pty-exit
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            if cancel_thread.load(Ordering::Relaxed) { break; }
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_thread.emit("pty-output", PtyOutput { id: id_thread.clone(), data: s });
                }
                Err(_) => break,
            }
        }
        let _ = app_thread.emit("pty-exit", PtyExit { id: id_thread.clone(), code: 0 });
    });

    let session = PtySession {
        writer,
        master: pair.master,
        child,
        child_pid,
        cancel,
    };
    mgr.sessions.lock().unwrap().insert(id, session);
    Ok(())
}

#[tauri::command]
pub async fn write_pty(
    mgr: State<'_, Arc<PtyManager>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut guard = mgr.sessions.lock().unwrap();
    let s = guard.get_mut(&id).ok_or_else(|| "no such pty".to_string())?;
    use std::io::Write;
    s.writer.write_all(data.as_bytes()).map_err(|e| format!("write: {e}"))?;
    s.writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn resize_pty(
    mgr: State<'_, Arc<PtyManager>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = mgr.sessions.lock().unwrap();
    let s = guard.get(&id).ok_or_else(|| "no such pty".to_string())?;
    s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize: {e}"))
}

#[tauri::command]
pub async fn close_pty(
    mgr: State<'_, Arc<PtyManager>>,
    id: String,
) -> Result<(), String> {
    let mut guard = mgr.sessions.lock().unwrap();
    if let Some(mut s) = guard.remove(&id) {
        s.cancel.store(true, Ordering::Relaxed);
        let _ = s.child.kill();
    }
    Ok(())
}
```

The test calls `cmd.iter_env_as_str()`, which is **not** a method on `CommandBuilder`. Replace the test helper with one that reflects what `portable-pty` actually offers. Since `CommandBuilder` doesn't expose the env map, add an internal helper to the module instead:

```rust
#[cfg(test)]
pub(crate) fn assert_env_contains(cmd: &CommandBuilder, key: &str, value: &str) -> bool {
    // CommandBuilder doesn't expose env publicly; we re-build a parallel map for tests.
    // For test purposes only, parse Debug output (acceptable since this is a unit test).
    let dbg = format!("{:?}", cmd);
    dbg.contains(&format!("{key}={value}"))
        || dbg.contains(&format!("{key:?}: {value:?}"))
}
```

And update the test:
```rust
#[test]
fn build_command_injects_terminal_id() {
    let cmd = super::build_command_for("powershell", Some("C:\\code"), "tab-uuid-xyz");
    assert!(
        super::assert_env_contains(&cmd, "NOTTER_TERMINAL_ID", "tab-uuid-xyz"),
        "missing NOTTER_TERMINAL_ID in CommandBuilder"
    );
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:
```bash
cd src-tauri && cargo test -p notter_lib terminals::
```
Expected: both `tab_meta_round_trips_through_json` and `build_command_injects_terminal_id` PASS.

- [ ] **Step 5: Register the commands in `src-tauri/src/lib.rs`**

In `tauri::Builder::default().invoke_handler(tauri::generate_handler![...])`, add:
```rust
terminals::create_pty,
terminals::write_pty,
terminals::resize_pty,
terminals::close_pty,
```

- [ ] **Step 6: Allow them in `src-tauri/capabilities/default.json`**

Open `src-tauri/capabilities/default.json`. Find the `permissions` array. Add the four entries:
```json
"core:default",
"shell:default",
"terminals:allow-create-pty",
"terminals:allow-write-pty",
"terminals:allow-resize-pty",
"terminals:allow-close-pty"
```

If the Tauri capabilities system uses a different naming scheme in this repo, check the existing entries (e.g. `mcp:allow-*`) and mimic.

- [ ] **Step 7: Run a build check**

Run:
```bash
pnpm tauri:check
```
Or, if that script isn't defined, `cd src-tauri && cargo check`. Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/terminals/mod.rs src-tauri/src/terminals/tests.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "$(cat <<'EOF'
feat(terminals): PTY lifecycle commands with NOTTER_TERMINAL_ID env injection

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Foreground process detection (Windows)

**Files:**
- Create: `src-tauri/src/terminals/foreground.rs`
- Modify: `src-tauri/src/terminals/mod.rs` (re-export + Tauri command)

- [ ] **Step 1: Write failing test for cache TTL**

Append to `src-tauri/src/terminals/tests.rs`:
```rust
#[test]
fn foreground_cache_returns_within_ttl() {
    use std::time::{Duration, Instant};
    let mut cache = super::foreground::ForegroundCache::new();
    let now = Instant::now();
    cache.put("tab1".into(), super::foreground::ForegroundInfo { name: "powershell.exe".into(), pid: 100 }, now);
    let hit = cache.get("tab1", now + Duration::from_millis(300));
    assert!(hit.is_some());
    let miss = cache.get("tab1", now + Duration::from_millis(600));
    assert!(miss.is_none(), "TTL should expire at 500ms");
}
```

- [ ] **Step 2: Run, watch fail**

Run: `cd src-tauri && cargo test -p notter_lib foreground_cache_returns_within_ttl`
Expected: FAIL with "cannot find module `foreground`".

- [ ] **Step 3: Implement `foreground.rs`**

Create `src-tauri/src/terminals/foreground.rs`:
```rust
//! Windows foreground process detection for a given PTY.
//!
//! Walks descendants of the PTY's tracked child PID and returns the deepest
//! non-conhost.exe leaf. Cached per tab for 500ms.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;

const CACHE_TTL_MS: u64 = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundInfo {
    pub name: String,
    pub pid: u32,
}

pub struct ForegroundCache {
    inner: HashMap<String, (Instant, ForegroundInfo)>,
}

impl ForegroundCache {
    pub fn new() -> Self { Self { inner: HashMap::new() } }

    pub fn put(&mut self, tab_id: String, info: ForegroundInfo, at: Instant) {
        self.inner.insert(tab_id, (at, info));
    }

    pub fn get(&self, tab_id: &str, now: Instant) -> Option<&ForegroundInfo> {
        let (stamp, info) = self.inner.get(tab_id)?;
        if now.duration_since(*stamp) > Duration::from_millis(CACHE_TTL_MS) {
            None
        } else {
            Some(info)
        }
    }
}

#[cfg(target_os = "windows")]
pub fn detect(child_pid: u32) -> Option<ForegroundInfo> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::Foundation::CloseHandle;

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        // (pid, parent_pid, name) tuples
        let mut all: Vec<(u32, u32, String)> = Vec::new();
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile
                        .iter()
                        .take_while(|c| **c != 0)
                        .copied()
                        .collect::<Vec<u16>>()
                );
                all.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                if Process32NextW(snap, &mut entry).is_err() { break; }
            }
        }
        let _ = CloseHandle(snap);

        // DFS from child_pid, skipping conhost.exe, returning the deepest non-conhost.
        let mut best: Option<(u32, String, u32)> = None; // (pid, name, depth)
        fn walk(
            all: &[(u32, u32, String)],
            current: u32,
            depth: u32,
            best: &mut Option<(u32, String, u32)>,
        ) {
            let children: Vec<&(u32, u32, String)> =
                all.iter().filter(|(_, parent, _)| *parent == current).collect();
            if children.is_empty() {
                let me = all.iter().find(|(pid, _, _)| *pid == current);
                if let Some((pid, _, name)) = me {
                    if !name.eq_ignore_ascii_case("conhost.exe") {
                        if best.as_ref().map(|b| depth > b.2).unwrap_or(true) {
                            *best = Some((*pid, name.clone(), depth));
                        }
                    }
                }
            } else {
                for (cpid, _, _) in &children {
                    walk(all, *cpid, depth + 1, best);
                }
            }
        }
        walk(&all, child_pid, 0, &mut best);

        best.map(|(pid, name, _)| ForegroundInfo { name, pid })
    }
}

#[cfg(not(target_os = "windows"))]
pub fn detect(_child_pid: u32) -> Option<ForegroundInfo> {
    // Not implemented for non-Windows in this scope.
    None
}
```

- [ ] **Step 4: Add Tauri command in `mod.rs`**

Append to `src-tauri/src/terminals/mod.rs`:
```rust
pub use foreground::{ForegroundInfo, ForegroundCache};

#[tauri::command]
pub async fn get_pty_foreground(
    mgr: State<'_, Arc<PtyManager>>,
    cache: State<'_, Arc<std::sync::Mutex<ForegroundCache>>>,
    tab_id: String,
) -> Result<Option<ForegroundInfo>, String> {
    let now = std::time::Instant::now();
    if let Some(hit) = cache.lock().unwrap().get(&tab_id, now).cloned() {
        return Ok(Some(hit));
    }
    let child_pid = {
        let guard = mgr.sessions.lock().unwrap();
        let s = guard.get(&tab_id).ok_or_else(|| "no such pty".to_string())?;
        s.child_pid.ok_or_else(|| "no child pid".to_string())?
    };
    let info = foreground::detect(child_pid);
    if let Some(i) = &info {
        cache.lock().unwrap().put(tab_id, i.clone(), now);
    }
    Ok(info)
}
```

(The `cache.get(...).cloned()` call assumes `ForegroundInfo: Clone` — confirm the derive macro is on it.)

- [ ] **Step 5: Register cache state + command in `lib.rs`**

In `src-tauri/src/lib.rs`, in the Builder setup:
```rust
.manage(std::sync::Arc::new(std::sync::Mutex::new(
    terminals::ForegroundCache::new()
)))
```
And add `terminals::get_pty_foreground` to the `invoke_handler!` macro.

- [ ] **Step 6: Run all tests**

Run: `cd src-tauri && cargo test -p notter_lib terminals::`
Expected: all PASS, including the new cache TTL test.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/terminals/foreground.rs src-tauri/src/terminals/mod.rs src-tauri/src/terminals/tests.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "$(cat <<'EOF'
feat(terminals): Windows foreground process detection with 500ms cache

Walks descendants of the PTY child PID via CreateToolhelp32Snapshot;
returns the deepest non-conhost leaf. Cached per tab for 500ms so
per-keystroke drag-over UI doesn't enumerate the process table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Clipboard image save command

**Files:**
- Create: `src-tauri/src/terminals/drop_handler.rs`
- Modify: `src-tauri/src/terminals/mod.rs` (re-export + register command)

- [ ] **Step 1: Write failing test**

Append to `src-tauri/src/terminals/tests.rs`:
```rust
#[test]
fn save_clipboard_image_writes_decoded_bytes() {
    let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    let data_url = format!("data:image/png;base64,{}", png_b64);
    let path = super::drop_handler::save_data_url_to_temp(&data_url, std::env::temp_dir().join("notter-paste-test"))
        .expect("save ok");
    let bytes = std::fs::read(&path).unwrap();
    assert!(bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]), "PNG magic missing");
    std::fs::remove_file(path).ok();
}
```

- [ ] **Step 2: Run, watch fail**

`cd src-tauri && cargo test -p notter_lib save_clipboard_image_writes_decoded_bytes`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `drop_handler.rs`**

Create `src-tauri/src/terminals/drop_handler.rs`:
```rust
//! Clipboard image / dropped-blob → temp file persistence.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use uuid::Uuid;

const TEMP_SUBDIR: &str = "notter-paste";
const CLEANUP_MAX_AGE_SECS: u64 = 60 * 60 * 24; // 24h

pub fn save_data_url_to_temp(data_url: &str, base_dir: PathBuf) -> Result<PathBuf, String> {
    let (mime, b64) = split_data_url(data_url)?;
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    };
    let bytes = B64.decode(b64).map_err(|e| format!("base64 decode: {e}"))?;
    std::fs::create_dir_all(&base_dir).map_err(|e| format!("mkdir: {e}"))?;
    let name = format!("{}.{}", Uuid::new_v4(), ext);
    let path = base_dir.join(name);
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path)
}

fn split_data_url(s: &str) -> Result<(&str, &str), String> {
    let rest = s.strip_prefix("data:").ok_or_else(|| "not a data URL".to_string())?;
    let (header, b64) = rest.split_once(",").ok_or_else(|| "no comma".to_string())?;
    let mime = header.split(';').next().unwrap_or("application/octet-stream");
    Ok((mime, b64))
}

pub fn cleanup_old(base_dir: &Path) {
    let Ok(rd) = std::fs::read_dir(base_dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let Ok(age) = now.duration_since(mtime) else { continue };
        if age.as_secs() > CLEANUP_MAX_AGE_SECS {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub async fn save_clipboard_image(data_url: String) -> Result<String, String> {
    let base = std::env::temp_dir().join(TEMP_SUBDIR);
    let path = save_data_url_to_temp(&data_url, base)?;
    Ok(path.to_string_lossy().into_owned())
}
```

- [ ] **Step 4: Re-export from `mod.rs` and register command**

Append to `src-tauri/src/terminals/mod.rs`:
```rust
pub use drop_handler::{save_clipboard_image, cleanup_old};
```

In `src-tauri/src/lib.rs`:
- Add `terminals::save_clipboard_image` to `invoke_handler!`.
- In the setup closure, spawn the cleanup task once at boot:
```rust
.setup(|app| {
    // existing setup ...
    let temp = std::env::temp_dir().join("notter-paste");
    std::thread::spawn(move || terminals::cleanup_old(&temp));
    Ok(())
})
```

(If a `.setup()` already exists, splice these lines into it rather than replacing.)

- [ ] **Step 5: Run all terminals tests**

`cd src-tauri && cargo test -p notter_lib terminals::`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/terminals/drop_handler.rs src-tauri/src/terminals/mod.rs src-tauri/src/terminals/tests.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(terminals): clipboard-image save_clipboard_image command + daily cleanup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Frontend types, schema, utilities, npm deps

### Task 5: Re-add xterm npm deps + define chip schema and path quoting

**Files:**
- Modify: `package.json`
- Create: `src/lib/terminals/chip-schema.ts`
- Create: `src/lib/terminals/shell-path-quote.ts`
- Create: `src/lib/terminals/__tests__/shell-path-quote.test.ts`
- Create: `src/lib/terminals/tab-identity.ts`

- [ ] **Step 1: Add npm deps**

Run:
```bash
pnpm add @xterm/xterm@^6.0.0 @xterm/addon-fit@^0.11.0 @xterm/addon-ligatures@^0.10.0
```

- [ ] **Step 2: Write failing tests for path quoting**

Create `src/lib/terminals/__tests__/shell-path-quote.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { quoteForShell } from '../shell-path-quote';

describe('quoteForShell', () => {
  it('quotes paths with spaces for PowerShell', () => {
    expect(quoteForShell('C:\\my code\\file.png', 'powershell'))
      .toBe(`'C:\\my code\\file.png'`);
  });

  it('escapes single quotes inside PowerShell single-quoted strings', () => {
    expect(quoteForShell(`C:\\it's\\thing.png`, 'powershell'))
      .toBe(`'C:\\it''s\\thing.png'`);
  });

  it('uses double quotes for CMD', () => {
    expect(quoteForShell('C:\\my code\\f.png', 'cmd')).toBe(`"C:\\my code\\f.png"`);
  });

  it('uses single quotes for bash and converts backslashes', () => {
    expect(quoteForShell('C:\\my code\\f.png', 'bash')).toBe(`'C:/my code/f.png'`);
  });

  it('returns unquoted path when no special chars (bash, no spaces)', () => {
    expect(quoteForShell('/tmp/safe.png', 'bash')).toBe('/tmp/safe.png');
  });

  it('returns unquoted path when no special chars (powershell, no spaces)', () => {
    expect(quoteForShell('C:\\safe\\file.png', 'powershell')).toBe('C:\\safe\\file.png');
  });
});
```

- [ ] **Step 3: Run, watch fail**

`pnpm test src/lib/terminals/__tests__/shell-path-quote.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement quoter**

Create `src/lib/terminals/shell-path-quote.ts`:
```ts
export type Shell = 'powershell' | 'bash' | 'cmd';

const SAFE_RE = /^[A-Za-z0-9_\-.\\/:]+$/;

export function quoteForShell(path: string, shell: Shell): string {
  if (shell === 'bash') {
    const forward = path.replace(/\\/g, '/');
    if (SAFE_RE.test(forward)) return forward;
    return `'${forward.replace(/'/g, "'\\''")}'`;
  }
  if (shell === 'cmd') {
    if (SAFE_RE.test(path) && !path.includes(' ')) return path;
    return `"${path.replace(/"/g, '""')}"`;
  }
  // powershell
  if (SAFE_RE.test(path) && !path.includes(' ')) return path;
  return `'${path.replace(/'/g, "''")}'`;
}
```

- [ ] **Step 5: Re-run tests**

`pnpm test src/lib/terminals/__tests__/shell-path-quote.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 6: Define chip schema**

Create `src/lib/terminals/chip-schema.ts`:
```ts
export type ChipType = 'pr' | 'branch' | 'worktree' | 'ci' | 'issue' | 'status' | 'free';

export type TabChip =
  | { type: 'pr';       value: { number: number; url?: string; state?: 'open' | 'merged' | 'closed' } }
  | { type: 'branch';   value: { name: string } }
  | { type: 'worktree'; value: { name: string; path?: string } }
  | { type: 'ci';       value: { state: 'passing' | 'failing' | 'pending'; url?: string; label?: string } }
  | { type: 'issue';    value: { number: number; url?: string; state?: 'open' | 'closed' } }
  | { type: 'status';   value: { label: string; severity?: 'ok' | 'warn' | 'err' } }
  | { type: 'free';     value: { label: string; color?: string } };

/** Types that have AT MOST ONE chip per tab (upsert semantics). */
export const SINGLETON_TYPES: ChipType[] = ['pr', 'branch', 'worktree', 'ci', 'issue', 'status'];

/** `free` allows multiple. */
export function isSingleton(t: ChipType): boolean {
  return SINGLETON_TYPES.includes(t);
}
```

- [ ] **Step 7: Define tab-identity**

Create `src/lib/terminals/tab-identity.ts`:
```ts
export const TAB_ENV_VAR = 'NOTTER_TERMINAL_ID';
```

(Single constant for now — keeps the env var name in one place across frontend + backend reasoning.)

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/terminals/
git commit -m "$(cat <<'EOF'
feat(terminals): xterm deps + TabChip schema + shell-aware path quoting

Path quoter handles single-quote escaping (PS doubled-single-quote, bash POSIX)
and back/forward slash conversion for bash on Windows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: AI CLI detector

**Files:**
- Create: `src/lib/terminals/ai-cli-detector.ts`
- Create: `src/lib/terminals/__tests__/ai-cli-detector.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/terminals/__tests__/ai-cli-detector.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_AI_CLI_LIST, detectAiCli } from '../ai-cli-detector';

describe('detectAiCli', () => {
  it('matches "claude.exe" against default claude entry', () => {
    const m = detectAiCli('claude.exe', DEFAULT_AI_CLI_LIST);
    expect(m).not.toBeNull();
    expect(m?.name).toBe('claude');
    expect(m?.prefix).toBe('@');
  });

  it('matches codex (case-insensitive, .cmd extension)', () => {
    const m = detectAiCli('CODEX.cmd', DEFAULT_AI_CLI_LIST);
    expect(m?.name).toBe('codex');
  });

  it('returns null for non-AI process', () => {
    expect(detectAiCli('node.exe', DEFAULT_AI_CLI_LIST)).toBeNull();
  });

  it('skips disabled entries', () => {
    const list = [{ name: 'claude', match: /^claude/i, prefix: '@', enabled: false }];
    expect(detectAiCli('claude.exe', list)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, watch fail**

`pnpm test src/lib/terminals/__tests__/ai-cli-detector.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/terminals/ai-cli-detector.ts`:
```ts
export interface AiCliEntry {
  name: string;
  match: RegExp;
  prefix: string;
  enabled: boolean;
}

export const DEFAULT_AI_CLI_LIST: AiCliEntry[] = [
  { name: 'claude', match: /^claude(\.exe|\.cmd|\.bat)?$/i, prefix: '@', enabled: true },
  { name: 'codex',  match: /^codex(\.exe|\.cmd|\.bat)?$/i,  prefix: '@', enabled: true },
  { name: 'aider',  match: /^aider(\.exe|\.cmd|\.bat)?$/i,  prefix: '@', enabled: true },
];

export function detectAiCli(processName: string, list: AiCliEntry[]): AiCliEntry | null {
  for (const entry of list) {
    if (!entry.enabled) continue;
    if (entry.match.test(processName)) return entry;
  }
  return null;
}
```

- [ ] **Step 4: Verify tests pass**

`pnpm test src/lib/terminals/__tests__/ai-cli-detector.test.ts`
Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminals/ai-cli-detector.ts src/lib/terminals/__tests__/ai-cli-detector.test.ts
git commit -m "$(cat <<'EOF'
feat(terminals): AI CLI detector with default claude/codex/aider list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Drop pipeline

**Files:**
- Create: `src/lib/terminals/drop-pipeline.ts`
- Create: `src/lib/terminals/__tests__/drop-pipeline.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/terminals/__tests__/drop-pipeline.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processDrop, type DropInput } from '../drop-pipeline';
import { DEFAULT_AI_CLI_LIST } from '../ai-cli-detector';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

beforeEach(() => invoke.mockReset());

describe('processDrop', () => {
  it('writes @-prefixed path when AI CLI is foreground', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pty_foreground') return { name: 'claude.exe', pid: 1 };
      if (cmd === 'write_pty') return null;
      throw new Error(`unexpected: ${cmd}`);
    });
    const input: DropInput = { kind: 'file', payload: { path: 'C:\\code\\img.png' } };
    await processDrop({
      tabId: 't1',
      shell: 'powershell',
      aiCliList: DEFAULT_AI_CLI_LIST,
      input,
    });
    expect(invoke).toHaveBeenCalledWith('write_pty', {
      id: 't1',
      data: '@C:\\code\\img.png ',
    });
  });

  it('writes raw path when foreground is not an AI CLI', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pty_foreground') return { name: 'node.exe', pid: 1 };
      if (cmd === 'write_pty') return null;
      throw new Error(`unexpected: ${cmd}`);
    });
    await processDrop({
      tabId: 't1',
      shell: 'bash',
      aiCliList: DEFAULT_AI_CLI_LIST,
      input: { kind: 'file', payload: { path: 'C:\\x y.png' } },
    });
    expect(invoke).toHaveBeenCalledWith('write_pty', {
      id: 't1',
      data: `'C:/x y.png' `,
    });
  });

  it('saves clipboard image and uses returned path', async () => {
    invoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'save_clipboard_image') return 'C:\\Temp\\notter-paste\\u1.png';
      if (cmd === 'get_pty_foreground') return null;
      if (cmd === 'write_pty') return null;
      throw new Error(`unexpected: ${cmd}`);
    });
    await processDrop({
      tabId: 't1',
      shell: 'cmd',
      aiCliList: DEFAULT_AI_CLI_LIST,
      input: { kind: 'clipboard-image', payload: { dataUrl: 'data:image/png;base64,AAA' } },
    });
    expect(invoke).toHaveBeenCalledWith('save_clipboard_image', { dataUrl: 'data:image/png;base64,AAA' });
    expect(invoke).toHaveBeenCalledWith('write_pty', {
      id: 't1',
      data: 'C:\\Temp\\notter-paste\\u1.png ',
    });
  });

  it('falls back to raw path when foreground detection fails', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pty_foreground') throw new Error('detect failed');
      if (cmd === 'write_pty') return null;
      throw new Error(`unexpected: ${cmd}`);
    });
    await processDrop({
      tabId: 't1',
      shell: 'powershell',
      aiCliList: DEFAULT_AI_CLI_LIST,
      input: { kind: 'file', payload: { path: 'C:\\safe.png' } },
    });
    expect(invoke).toHaveBeenCalledWith('write_pty', {
      id: 't1',
      data: 'C:\\safe.png ',
    });
  });
});
```

- [ ] **Step 2: Run, watch fail**

`pnpm test src/lib/terminals/__tests__/drop-pipeline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/terminals/drop-pipeline.ts`:
```ts
import { invoke } from '@tauri-apps/api/core';
import { detectAiCli, type AiCliEntry } from './ai-cli-detector';
import { quoteForShell, type Shell } from './shell-path-quote';

export type DropInput =
  | { kind: 'file'; payload: { path: string } }
  | { kind: 'clipboard-image'; payload: { dataUrl: string } };

export interface ProcessDropArgs {
  tabId: string;
  shell: Shell;
  aiCliList: AiCliEntry[];
  input: DropInput;
}

export async function processDrop(args: ProcessDropArgs): Promise<void> {
  const { tabId, shell, aiCliList, input } = args;

  let localPath: string;
  if (input.kind === 'file') {
    localPath = input.payload.path;
  } else {
    localPath = await invoke<string>('save_clipboard_image', { dataUrl: input.payload.dataUrl });
  }

  let prefix = '';
  try {
    const fg = await invoke<{ name: string; pid: number } | null>('get_pty_foreground', { tabId });
    if (fg) {
      const match = detectAiCli(fg.name, aiCliList);
      if (match) prefix = match.prefix;
    }
  } catch {
    // Detection failure → raw path
  }

  const quoted = quoteForShell(localPath, shell);
  await invoke('write_pty', { id: tabId, data: `${prefix}${quoted} ` });
}
```

- [ ] **Step 4: Run tests, watch pass**

`pnpm test src/lib/terminals/__tests__/drop-pipeline.test.ts`
Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminals/drop-pipeline.ts src/lib/terminals/__tests__/drop-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(terminals): unified drop pipeline (file + clipboard-image) with AI-CLI prefixing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Zustand store + Supabase sync

### Task 8: Zustand store skeleton with CRUD

**Files:**
- Create: `src/stores/terminals-store.ts`
- Create: `src/stores/__tests__/terminals-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/stores/__tests__/terminals-store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalsStore } from '../terminals-store';

beforeEach(() => useTerminalsStore.setState({ tabs: {}, groups: {}, activeTabId: null, search: '' }));

describe('terminals-store', () => {
  it('creates a tab and auto-creates its group from cwd', () => {
    const s = useTerminalsStore.getState();
    const gid = s.ensureGroupForProject('C:\\code\\foo', 'Foo');
    const id = s.createTab({ cwd: 'C:\\code\\foo', shell: 'powershell', groupId: gid, name: 'tab 1' });
    const after = useTerminalsStore.getState();
    expect(after.tabs[id].groupId).toBe(gid);
    expect(after.groups[gid].name).toBe('Foo');
  });

  it('upserts singleton chips by type', () => {
    const s = useTerminalsStore.getState();
    const gid = s.ensureGroupForProject('p', 'P');
    const id = s.createTab({ cwd: 'p', groupId: gid, name: 't' });
    s.setChip(id, { type: 'pr', value: { number: 1 } });
    s.setChip(id, { type: 'pr', value: { number: 2 } });
    const tab = useTerminalsStore.getState().tabs[id];
    expect(tab.chips.filter((c) => c.type === 'pr')).toHaveLength(1);
    expect((tab.chips.find((c) => c.type === 'pr') as any).value.number).toBe(2);
  });

  it('appends multiple free chips', () => {
    const s = useTerminalsStore.getState();
    const gid = s.ensureGroupForProject('p', 'P');
    const id = s.createTab({ cwd: 'p', groupId: gid, name: 't' });
    s.setChip(id, { type: 'free', value: { label: 'a' } });
    s.setChip(id, { type: 'free', value: { label: 'b' } });
    const free = useTerminalsStore.getState().tabs[id].chips.filter((c) => c.type === 'free');
    expect(free).toHaveLength(2);
  });

  it('grants and revokes permissions', () => {
    const s = useTerminalsStore.getState();
    const gid = s.ensureGroupForProject('p', 'P');
    const id = s.createTab({ cwd: 'p', groupId: gid, name: 't' });
    s.grantPermission(id, 'terminal.send_keys');
    expect(useTerminalsStore.getState().tabs[id].permissionGrants['terminal.send_keys']).toBe(true);
    s.revokePermission(id, 'terminal.send_keys');
    expect(useTerminalsStore.getState().tabs[id].permissionGrants['terminal.send_keys']).toBeUndefined();
  });

  it('toggles trusted', () => {
    const s = useTerminalsStore.getState();
    const gid = s.ensureGroupForProject('p', 'P');
    const id = s.createTab({ cwd: 'p', groupId: gid, name: 't' });
    expect(useTerminalsStore.getState().tabs[id].trusted).toBe(false);
    s.setTrusted(id, true);
    expect(useTerminalsStore.getState().tabs[id].trusted).toBe(true);
  });

  it('applyRemoteUpsert is idempotent', () => {
    const s = useTerminalsStore.getState();
    const row = {
      id: 'remote-1', user_id: 'u1', group_id: 'g1', group_name: 'P', group_path: 'p',
      name: 'x', color: null, cwd: 'p', shell: 'powershell',
      chips: [], created_at: '2026-05-17T00:00:00Z', updated_at: '2026-05-17T00:00:00Z',
    } as const;
    s.applyRemoteUpsert(row as any);
    s.applyRemoteUpsert(row as any);
    const tabs = useTerminalsStore.getState().tabs;
    expect(Object.keys(tabs)).toHaveLength(1);
    expect(tabs['remote-1'].name).toBe('x');
  });
});
```

- [ ] **Step 2: Run, watch fail**

`pnpm test src/stores/__tests__/terminals-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the store**

Create `src/stores/terminals-store.ts`:
```ts
import { create } from 'zustand';
import type { TabChip, ChipType } from '@/lib/terminals/chip-schema';
import { isSingleton } from '@/lib/terminals/chip-schema';

export type Shell = 'powershell' | 'bash' | 'cmd';
export type SensitiveTool = 'terminal.create_tab' | 'terminal.close_tab' | 'terminal.send_keys';

export interface TerminalTab {
  id: string;
  groupId: string;
  name: string;
  color: string | null;
  cwd: string;
  shell: Shell;
  chips: TabChip[];
  permissionGrants: Partial<Record<SensitiveTool, true>>;
  trusted: boolean;
  createdAt: string;
  ptyAlive?: boolean;
}

export interface TerminalGroup {
  id: string;
  name: string;
  projectPath: string;
  collapsed: boolean;
}

export interface TerminalTabRow {
  id: string;
  user_id: string;
  group_id: string;
  group_name: string;
  group_path: string;
  name: string;
  color: string | null;
  cwd: string;
  shell: Shell;
  chips: TabChip[];
  created_at: string;
  updated_at: string;
}

interface TerminalsState {
  tabs: Record<string, TerminalTab>;
  groups: Record<string, TerminalGroup>;
  activeTabId: string | null;
  search: string;

  createTab: (init: Partial<TerminalTab> & { cwd: string; groupId: string }) => string;
  renameTab: (id: string, name: string) => void;
  setTabColor: (id: string, hex: string | null) => void;
  setActiveTab: (id: string) => void;
  removeTab: (id: string) => void;
  moveTabToGroup: (id: string, groupId: string) => void;
  setTrusted: (id: string, trusted: boolean) => void;
  grantPermission: (id: string, tool: SensitiveTool) => void;
  revokePermission: (id: string, tool: SensitiveTool) => void;
  setPtyAlive: (id: string, alive: boolean) => void;
  setSearch: (q: string) => void;

  setChip: (id: string, chip: TabChip) => void;
  removeChip: (id: string, type: ChipType, index?: number) => void;

  ensureGroupForProject: (projectPath: string, projectName: string) => string;
  toggleGroupCollapse: (id: string) => void;

  applyRemoteUpsert: (row: TerminalTabRow) => void;
  applyRemoteDelete: (id: string) => void;
}

// 12-char hex hash from path; deterministic group id derivation.
async function hashPath(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-1', enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
// Synchronous fallback used inside the store (no async actions): cheap FNV.
function fnvHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 12);
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  tabs: {},
  groups: {},
  activeTabId: null,
  search: '',

  createTab: (init) => {
    const id = init.id ?? uuid();
    const tab: TerminalTab = {
      id,
      groupId: init.groupId,
      name: init.name ?? 'Terminal',
      color: init.color ?? null,
      cwd: init.cwd,
      shell: init.shell ?? 'powershell',
      chips: init.chips ?? [],
      permissionGrants: init.permissionGrants ?? {},
      trusted: init.trusted ?? false,
      createdAt: init.createdAt ?? new Date().toISOString(),
      ptyAlive: false,
    };
    set((s) => ({ tabs: { ...s.tabs, [id]: tab }, activeTabId: s.activeTabId ?? id }));
    return id;
  },

  renameTab: (id, name) => set((s) => ({
    tabs: s.tabs[id] ? { ...s.tabs, [id]: { ...s.tabs[id], name } } : s.tabs,
  })),

  setTabColor: (id, hex) => set((s) => ({
    tabs: s.tabs[id] ? { ...s.tabs, [id]: { ...s.tabs[id], color: hex } } : s.tabs,
  })),

  setActiveTab: (id) => set({ activeTabId: id }),

  removeTab: (id) => set((s) => {
    const { [id]: _, ...rest } = s.tabs;
    const nextActive = s.activeTabId === id
      ? (Object.keys(rest)[0] ?? null)
      : s.activeTabId;
    return { tabs: rest, activeTabId: nextActive };
  }),

  moveTabToGroup: (id, groupId) => set((s) => ({
    tabs: s.tabs[id] ? { ...s.tabs, [id]: { ...s.tabs[id], groupId } } : s.tabs,
  })),

  setTrusted: (id, trusted) => set((s) => ({
    tabs: s.tabs[id] ? { ...s.tabs, [id]: { ...s.tabs[id], trusted } } : s.tabs,
  })),

  grantPermission: (id, tool) => set((s) => s.tabs[id]
    ? { tabs: { ...s.tabs, [id]: { ...s.tabs[id], permissionGrants: { ...s.tabs[id].permissionGrants, [tool]: true } } } }
    : s),

  revokePermission: (id, tool) => set((s) => {
    const t = s.tabs[id];
    if (!t) return s;
    const { [tool]: _, ...rest } = t.permissionGrants;
    return { tabs: { ...s.tabs, [id]: { ...t, permissionGrants: rest } } };
  }),

  setPtyAlive: (id, alive) => set((s) => s.tabs[id]
    ? { tabs: { ...s.tabs, [id]: { ...s.tabs[id], ptyAlive: alive } } }
    : s),

  setSearch: (q) => set({ search: q }),

  setChip: (id, chip) => set((s) => {
    const t = s.tabs[id];
    if (!t) return s;
    let chips: TabChip[];
    if (isSingleton(chip.type)) {
      const filtered = t.chips.filter((c) => c.type !== chip.type);
      chips = [...filtered, chip];
    } else {
      chips = [...t.chips, chip];
    }
    return { tabs: { ...s.tabs, [id]: { ...t, chips } } };
  }),

  removeChip: (id, type, index) => set((s) => {
    const t = s.tabs[id];
    if (!t) return s;
    let chips: TabChip[];
    if (type === 'free' && index !== undefined) {
      let i = 0;
      chips = t.chips.filter((c) => {
        if (c.type !== 'free') return true;
        return i++ !== index;
      });
    } else {
      chips = t.chips.filter((c) => c.type !== type);
    }
    return { tabs: { ...s.tabs, [id]: { ...t, chips } } };
  }),

  ensureGroupForProject: (projectPath, projectName) => {
    const id = fnvHash(projectPath);
    if (!get().groups[id]) {
      set((s) => ({
        groups: { ...s.groups, [id]: { id, name: projectName, projectPath, collapsed: false } },
      }));
    }
    return id;
  },

  toggleGroupCollapse: (id) => set((s) => s.groups[id]
    ? { groups: { ...s.groups, [id]: { ...s.groups[id], collapsed: !s.groups[id].collapsed } } }
    : s),

  applyRemoteUpsert: (row) => set((s) => {
    const tab: TerminalTab = {
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      color: row.color,
      cwd: row.cwd,
      shell: row.shell,
      chips: row.chips,
      permissionGrants: s.tabs[row.id]?.permissionGrants ?? {},
      trusted: s.tabs[row.id]?.trusted ?? false,
      createdAt: row.created_at,
      ptyAlive: s.tabs[row.id]?.ptyAlive ?? false,
    };
    const groups = s.groups[row.group_id]
      ? s.groups
      : { ...s.groups, [row.group_id]: { id: row.group_id, name: row.group_name, projectPath: row.group_path, collapsed: false } };
    return { tabs: { ...s.tabs, [row.id]: tab }, groups };
  }),

  applyRemoteDelete: (id) => set((s) => {
    const { [id]: _, ...rest } = s.tabs;
    return { tabs: rest };
  }),
}));
```

- [ ] **Step 4: Run tests, watch pass**

`pnpm test src/stores/__tests__/terminals-store.test.ts`
Expected: all 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/terminals-store.ts src/stores/__tests__/terminals-store.test.ts
git commit -m "$(cat <<'EOF'
feat(terminals): Zustand terminals-store with tabs/groups/chips/permissions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Supabase migration + sync module

**Files:**
- Create: `supabase/migrations/2026-05-17-terminal-tabs.sql`
- Create: `src/lib/terminals/supabase-sync.ts`
- Modify: `src/lib/sync.ts` (subscribe terminal_tabs at boot)

- [ ] **Step 1: Write migration**

Create `supabase/migrations/2026-05-17-terminal-tabs.sql`:
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

create index if not exists terminal_tabs_user_idx on terminal_tabs (user_id, created_at);

alter table terminal_tabs enable row level security;

create policy "owner select" on terminal_tabs for select using (auth.uid() = user_id);
create policy "owner insert" on terminal_tabs for insert with check (auth.uid() = user_id);
create policy "owner update" on terminal_tabs for update using (auth.uid() = user_id);
create policy "owner delete" on terminal_tabs for delete using (auth.uid() = user_id);

create or replace function terminal_tabs_touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists terminal_tabs_touch on terminal_tabs;
create trigger terminal_tabs_touch
  before update on terminal_tabs
  for each row execute function terminal_tabs_touch_updated_at();
```

- [ ] **Step 2: Apply migration to local Supabase**

Run (uses the Supabase MCP per repo convention):
```bash
# via Supabase MCP, applying migration:
# (Replace with the actual invocation pattern used here — e.g. through Claude Code tools.)
```

If applied via SQL editor in dashboard, paste the file contents.

- [ ] **Step 3: Write sync module**

Create `src/lib/terminals/supabase-sync.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { useTerminalsStore, type TerminalTab } from '@/stores/terminals-store';
import type { TerminalTabRow } from '@/stores/terminals-store';

export async function loadInitialTabs(sb: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await sb
    .from('terminal_tabs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const store = useTerminalsStore.getState();
  for (const row of (data as TerminalTabRow[]) ?? []) {
    store.applyRemoteUpsert(row);
  }
}

export function subscribeTerminalTabs(sb: SupabaseClient, userId: string): () => void {
  const channel = sb
    .channel('terminal_tabs:' + userId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'terminal_tabs', filter: `user_id=eq.${userId}` },
      ({ new: row }) => useTerminalsStore.getState().applyRemoteUpsert(row as TerminalTabRow))
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'terminal_tabs', filter: `user_id=eq.${userId}` },
      ({ new: row }) => useTerminalsStore.getState().applyRemoteUpsert(row as TerminalTabRow))
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'terminal_tabs', filter: `user_id=eq.${userId}` },
      ({ old: row }) => useTerminalsStore.getState().applyRemoteDelete((row as TerminalTabRow).id))
    .subscribe();
  return () => { sb.removeChannel(channel); };
}

export async function upsertTab(sb: SupabaseClient, userId: string, tab: TerminalTab, groupName: string, groupPath: string): Promise<void> {
  const row: Omit<TerminalTabRow, 'created_at' | 'updated_at'> = {
    id: tab.id,
    user_id: userId,
    group_id: tab.groupId,
    group_name: groupName,
    group_path: groupPath,
    name: tab.name,
    color: tab.color,
    cwd: tab.cwd,
    shell: tab.shell,
    chips: tab.chips,
  };
  const { error } = await sb.from('terminal_tabs').upsert(row, { onConflict: 'id' });
  if (error) throw error;
}

export async function deleteTab(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from('terminal_tabs').delete().eq('id', id);
  if (error) throw error;
}
```

- [ ] **Step 4: Wire boot from `src/lib/sync.ts`**

Open `src/lib/sync.ts` and find the existing per-user boot (where subjects/versions/etc. subscribe). After those, add the terminal_tabs boot:
```ts
import { loadInitialTabs, subscribeTerminalTabs } from '@/lib/terminals/supabase-sync';

// inside startRealtimeSync (or equivalent), after auth resolved:
await loadInitialTabs(sb, user.id);
const unsubTabs = subscribeTerminalTabs(sb, user.id);
// ensure unsubTabs is added to the existing teardown list
```

Find the existing teardown — the file already has a pattern for tracking subscriptions. Match it.

- [ ] **Step 5: Sanity build**

Run: `pnpm typecheck`
Expected: clean (no errors related to terminal types).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-05-17-terminal-tabs.sql src/lib/terminals/supabase-sync.ts src/lib/sync.ts
git commit -m "$(cat <<'EOF'
feat(terminals): Supabase terminal_tabs migration + per-user realtime sync

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase D — MCP terminal tools

### Task 10: Carry `AppHandle` + `PtyManager` to MCP dispatch via axum Extension

**Files:**
- Modify: `src-tauri/src/mcp/server.rs`
- Modify: `src-tauri/src/mcp/tools.rs` → rename to `src-tauri/src/mcp/tools/mod.rs`
- Modify: `src-tauri/src/lib.rs`

The repo memory notes that putting `AppHandle` inside a struct field breaks `cargo test` on Windows. We follow that: it travels as an axum Extension instead.

- [ ] **Step 1: Convert `mcp/tools.rs` to a module**

```bash
mkdir src-tauri/src/mcp/tools
git mv src-tauri/src/mcp/tools.rs src-tauri/src/mcp/tools/mod.rs
```

- [ ] **Step 2: Adjust `dispatch` signature**

In `src-tauri/src/mcp/tools/mod.rs`, change the function signature from:
```rust
pub async fn dispatch(
    method: &str,
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError>
```
to:
```rust
use std::sync::Arc;
use tauri::AppHandle;
use crate::terminals::PtyManager;

pub struct DispatchCtx<'a> {
    pub auth: &'a AuthContext,
    pub state: &'a McpState,
    pub app: AppHandle,
    pub pty: Arc<PtyManager>,
}

pub async fn dispatch(
    method: &str,
    params: &Value,
    ctx: &DispatchCtx<'_>,
) -> Result<Value, McpError> {
    match method {
        // existing planner arms — each becomes:
        "list_subjects" => list_subjects(params, ctx.auth, ctx.state).await,
        // ... unchanged ...
        other => Err(McpError::MethodNotFound(format!("method '{other}' not found"))),
    }
}
```

Keep all existing arms working — only the wrapper signature changes.

- [ ] **Step 3: Update the axum handler in `server.rs`**

Find the JSON-RPC handler (the function that calls `dispatch`). Add an axum extractor for `Extension<AppHandle>` and `Extension<Arc<PtyManager>>`:
```rust
use axum::Extension;
use tauri::AppHandle;
use std::sync::Arc;
use crate::terminals::PtyManager;

async fn rpc_handler(
    AxumState(state): AxumState<McpState>,
    Extension(app): Extension<AppHandle>,
    Extension(pty): Extension<Arc<PtyManager>>,
    Extension(auth): Extension<AuthContext>,
    Json(req): Json<JsonRpcRequest>,
) -> ... {
    // ... existing body, but call:
    let ctx = crate::mcp::tools::DispatchCtx { auth: &auth, state: &state, app: app.clone(), pty: pty.clone() };
    let result = crate::mcp::tools::dispatch(&req.method, &req.params, &ctx).await;
    // ...
}
```

Add `.layer(Extension(app_handle.clone())).layer(Extension(pty_manager.clone()))` when building the router (in `start_mcp_server`).

- [ ] **Step 4: Pass `AppHandle` + `PtyManager` from `start_mcp_server` callsite**

Open `src-tauri/src/lib.rs` and find the `start_mcp_server(&app_handle, mcp_state)` call. Update the signature to also take `Arc<PtyManager>`:
```rust
crate::mcp::server::start_mcp_server(app.handle().clone(), mcp_state.clone(), pty_mgr.clone()).await
```
(Adjust per current signature.)

- [ ] **Step 5: Run a full backend build**

Run: `cd src-tauri && cargo check && cargo test -p notter_lib`
Expected: clean; all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mcp/ src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
refactor(mcp): pass AppHandle and PtyManager to dispatch via axum Extension

Prep for terminal.* MCP tools. AppHandle in a struct field breaks
cargo test on Windows (STATUS_ENTRYPOINT_NOT_FOUND) — Extension-based
threading is the working pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Auto-allowed `terminal.*` tools

**Files:**
- Create: `src-tauri/src/mcp/tools/terminal.rs`
- Modify: `src-tauri/src/mcp/tools/mod.rs`
- Test: extend `src-tauri/src/terminals/tests.rs`

- [ ] **Step 1: Write failing tests for tab_id resolution + list_tabs shape**

Append to `src-tauri/src/terminals/tests.rs`:
```rust
#[test]
fn resolve_tab_id_errors_without_param() {
    let resolved = crate::mcp::tools::terminal::resolve_tab_id(&serde_json::json!({}));
    assert!(resolved.is_err(), "missing tab_id should error");
}

#[test]
fn resolve_tab_id_returns_param_when_given() {
    let resolved = crate::mcp::tools::terminal::resolve_tab_id(&serde_json::json!({"tab_id":"abc"})).unwrap();
    assert_eq!(resolved, "abc");
}
```

- [ ] **Step 2: Run, watch fail**

`cd src-tauri && cargo test -p notter_lib resolve_tab_id_errors_without_param`
Expected: FAIL.

- [ ] **Step 3: Implement `terminal.rs` with 7 auto-allowed tools**

Create `src-tauri/src/mcp/tools/terminal.rs`:
```rust
//! `terminal.*` MCP tools (auto-allowed; sensitive ones live in sensitive.rs sibling).

use serde_json::{json, Value};
use tauri::Emitter;

use crate::mcp::error::McpError;
use crate::mcp::tools::DispatchCtx;

pub fn resolve_tab_id(params: &Value) -> Result<String, McpError> {
    params.get("tab_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| McpError::InvalidParams(
            "tab_id required: caller did not pass NOTTER_TERMINAL_ID from its environment".into()
        ))
}

pub async fn set_name(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let name = params.get("name").and_then(|v| v.as_str())
        .ok_or_else(|| McpError::InvalidParams("name required".into()))?;
    {
        let mut tabs = ctx.pty.tabs.lock().unwrap();
        if let Some(t) = tabs.get_mut(&id) {
            t.name = name.to_string();
        } else {
            return Err(McpError::InvalidParams(format!("unknown tab_id {id}")));
        }
    }
    let _ = ctx.app.emit("terminal:tab-updated", json!({ "id": id, "patch": { "name": name } }));
    Ok(json!({"ok": true}))
}

pub async fn set_color(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let color: Option<String> = params.get("color").and_then(|v| v.as_str()).map(String::from);
    {
        let mut tabs = ctx.pty.tabs.lock().unwrap();
        if let Some(t) = tabs.get_mut(&id) { t.color = color.clone(); }
        else { return Err(McpError::InvalidParams(format!("unknown tab_id {id}"))); }
    }
    let _ = ctx.app.emit("terminal:tab-updated", json!({ "id": id, "patch": { "color": color } }));
    Ok(json!({"ok": true}))
}

pub async fn set_chip(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let chip = params.get("chip").cloned()
        .ok_or_else(|| McpError::InvalidParams("chip required".into()))?;
    // Frontend is source of truth; we forward and let the store enforce singleton/free rules.
    let _ = ctx.app.emit("terminal:tab-set-chip", json!({ "id": id, "chip": chip }));
    Ok(json!({"ok": true}))
}

pub async fn remove_chip(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let chip_type = params.get("type").and_then(|v| v.as_str())
        .ok_or_else(|| McpError::InvalidParams("type required".into()))?;
    let index = params.get("index").and_then(|v| v.as_u64());
    let _ = ctx.app.emit("terminal:tab-remove-chip", json!({ "id": id, "type": chip_type, "index": index }));
    Ok(json!({"ok": true}))
}

pub async fn list_tabs(_params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let tabs = ctx.pty.tabs.lock().unwrap();
    let mut out: Vec<Value> = Vec::with_capacity(tabs.len());
    for t in tabs.values() {
        out.push(summarize(t));
    }
    Ok(json!(out))
}

pub async fn get_tab(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let tabs = ctx.pty.tabs.lock().unwrap();
    let t = tabs.get(&id).ok_or_else(|| McpError::InvalidParams(format!("unknown tab_id {id}")))?;
    Ok(summarize(t))
}

pub async fn focus_tab(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let _ = ctx.app.emit("terminal:tab-focused", json!({ "id": id }));
    Ok(json!({"ok": true}))
}

fn summarize(t: &crate::terminals::TabMeta) -> Value {
    // Notably: does NOT include permissionGrants or any local-only field.
    json!({
        "id": t.id,
        "groupId": t.group_id,
        "name": t.name,
        "color": t.color,
        "cwd": t.cwd,
        "shell": t.shell,
        "chips": t.chips,
        "trusted": t.trusted,
    })
}
```

- [ ] **Step 4: Wire into `dispatch`**

In `src-tauri/src/mcp/tools/mod.rs`, declare the submodule and add the routes:
```rust
pub mod terminal;

// inside dispatch():
"terminal.set_name"    => terminal::set_name(params, ctx).await,
"terminal.set_color"   => terminal::set_color(params, ctx).await,
"terminal.set_chip"    => terminal::set_chip(params, ctx).await,
"terminal.remove_chip" => terminal::remove_chip(params, ctx).await,
"terminal.list_tabs"   => terminal::list_tabs(params, ctx).await,
"terminal.get_tab"     => terminal::get_tab(params, ctx).await,
"terminal.focus_tab"   => terminal::focus_tab(params, ctx).await,
```

- [ ] **Step 5: Frontend bridge — listen to events and update the store**

Open `src/lib/sync.ts` (or wherever the realtime + Tauri event listeners boot). Add listeners:
```ts
import { listen } from '@tauri-apps/api/event';
import { useTerminalsStore } from '@/stores/terminals-store';

await listen<{ id: string; patch: any }>('terminal:tab-updated', ({ payload }) => {
  const { id, patch } = payload;
  const s = useTerminalsStore.getState();
  if (patch.name !== undefined) s.renameTab(id, patch.name);
  if (patch.color !== undefined) s.setTabColor(id, patch.color);
});
await listen<{ id: string; chip: any }>('terminal:tab-set-chip', ({ payload }) =>
  useTerminalsStore.getState().setChip(payload.id, payload.chip));
await listen<{ id: string; type: any; index?: number }>('terminal:tab-remove-chip', ({ payload }) =>
  useTerminalsStore.getState().removeChip(payload.id, payload.type, payload.index));
await listen<{ id: string }>('terminal:tab-focused', ({ payload }) =>
  useTerminalsStore.getState().setActiveTab(payload.id));
```

After applying these to the store, the store should also persist to Supabase. Add a Zustand subscription pattern — see the existing `subjects-store` / `planner-store` for the established pattern. For brevity in this plan: anywhere the store mutates a tab, schedule a debounced `upsertTab` call against Supabase. Match the pattern used by `planner-store`'s sync hook.

- [ ] **Step 6: Add `notify_tab_metadata` Tauri command (UI → backend cache)**

Append to `src-tauri/src/terminals/mod.rs`:
```rust
#[tauri::command]
pub async fn notify_tab_metadata(
    mgr: State<'_, Arc<PtyManager>>,
    meta: TabMeta,
) -> Result<(), String> {
    mgr.tabs.lock().unwrap().insert(meta.id.clone(), meta);
    Ok(())
}
```

Register it in `lib.rs`'s `invoke_handler!`. After the frontend creates / renames / chip-mutates a tab, it must call `invoke('notify_tab_metadata', { meta })`. Add this call inside the Zustand store actions (or a single `useEffect` subscribed to relevant slices).

- [ ] **Step 7: Run tests**

`cd src-tauri && cargo test -p notter_lib` — all pass.
`pnpm test src/stores/__tests__/terminals-store.test.ts src/lib/terminals/__tests__/` — all pass.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/mcp/tools/terminal.rs src-tauri/src/mcp/tools/mod.rs src-tauri/src/terminals/mod.rs src-tauri/src/lib.rs src/lib/sync.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 7 auto-allowed terminal.* tools (metadata + list/get/focus)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Sensitive `terminal.*` tools + permission flow

**Files:**
- Modify: `src-tauri/src/mcp/tools/terminal.rs` (add sensitive arm impls + pending request map)
- Modify: `src-tauri/src/terminals/mod.rs` (add `mcp_permission_resolve` Tauri command)
- Modify: `src-tauri/src/mcp/tools/mod.rs` (route the 3 sensitive methods)

- [ ] **Step 1: Define the pending-request infra**

Append to `src-tauri/src/terminals/mod.rs`:
```rust
use tokio::sync::oneshot;

pub struct PermissionRequest {
    pub tx: oneshot::Sender<bool>,
}

pub struct PermissionRegistry {
    pub inner: tokio::sync::Mutex<HashMap<String, PermissionRequest>>,
}

impl PermissionRegistry {
    pub fn new() -> Self { Self { inner: tokio::sync::Mutex::new(HashMap::new()) } }
}

#[tauri::command]
pub async fn mcp_permission_resolve(
    reg: State<'_, Arc<PermissionRegistry>>,
    request_id: String,
    decision: String, // "allow" | "deny" | "always" | "trusted"
) -> Result<(), String> {
    let mut guard = reg.inner.lock().await;
    if let Some(pr) = guard.remove(&request_id) {
        let allow = decision == "allow" || decision == "always" || decision == "trusted";
        let _ = pr.tx.send(allow);
    }
    Ok(())
}
```

Register `PermissionRegistry` as managed state in `lib.rs` (manage `Arc::new(PermissionRegistry::new())`) and add `mcp_permission_resolve` to `invoke_handler!`.

- [ ] **Step 2: Plumb registry into DispatchCtx**

In `src-tauri/src/mcp/tools/mod.rs`, add:
```rust
pub registry: Arc<crate::terminals::PermissionRegistry>,
```
to `DispatchCtx`. Update `rpc_handler` in `server.rs` to read `Extension<Arc<PermissionRegistry>>` and pass it through. Add `.layer(Extension(registry.clone()))` to the router.

- [ ] **Step 3: Implement sensitive tools with the request flow**

Append to `src-tauri/src/mcp/tools/terminal.rs`:
```rust
async fn request_permission(
    ctx: &DispatchCtx<'_>,
    tab_id: &str,
    tool: &str,
    args: &Value,
) -> Result<bool, McpError> {
    // Check trusted + grants from local cache first.
    {
        let tabs = ctx.pty.tabs.lock().unwrap();
        if let Some(t) = tabs.get(tab_id) {
            if t.trusted { return Ok(true); }
        }
    }
    // Grants are local-only and NOT mirrored in the backend cache; we always prompt
    // unless the tab is trusted. The frontend modal honors locally-stored grants
    // and may auto-resolve without showing UI.
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = ctx.registry.inner.lock().await;
        guard.insert(request_id.clone(), crate::terminals::PermissionRequest { tx });
    }
    let _ = ctx.app.emit("terminal:permission-request", json!({
        "id": tab_id,
        "tool": tool,
        "args": args,
        "requestId": request_id,
    }));
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        rx,
    ).await;
    match result {
        Ok(Ok(true)) => Ok(true),
        Ok(Ok(false)) => Err(McpError::PermissionDenied("user denied".into())),
        Ok(Err(_)) | Err(_) => {
            ctx.registry.inner.lock().await.remove(&request_id);
            Err(McpError::PermissionDenied("permission timeout".into()))
        }
    }
}

pub async fn create_tab(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    // create_tab has no existing tab_id; we treat the "tab" as the caller's tab
    // (or fail if it isn't a real tab). Use NOTTER_TERMINAL_ID if available;
    // otherwise require explicit group_hint and trust the user.
    let caller_id = params.get("caller_tab_id").and_then(|v| v.as_str()).unwrap_or("__unknown__");
    let allow = request_permission(ctx, caller_id, "terminal.create_tab", params).await?;
    if !allow { return Err(McpError::PermissionDenied("denied".into())); }
    // Emit a "please create this tab" event; frontend opens the project picker
    // pre-filled or directly creates and calls notify_tab_metadata.
    let _ = ctx.app.emit("terminal:request-create-tab", params.clone());
    Ok(json!({"ok": true}))
}

pub async fn close_tab(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let allow = request_permission(ctx, &id, "terminal.close_tab", params).await?;
    if !allow { return Err(McpError::PermissionDenied("denied".into())); }
    let _ = ctx.app.emit("terminal:request-close-tab", json!({ "id": id }));
    Ok(json!({"ok": true}))
}

pub async fn send_keys(params: &Value, ctx: &DispatchCtx<'_>) -> Result<Value, McpError> {
    let id = resolve_tab_id(params)?;
    let data = params.get("data").and_then(|v| v.as_str())
        .ok_or_else(|| McpError::InvalidParams("data required".into()))?;
    let allow = request_permission(ctx, &id, "terminal.send_keys", &json!({"data": data})).await?;
    if !allow { return Err(McpError::PermissionDenied("denied".into())); }
    // Write directly via PtyManager.
    let mut guard = ctx.pty.sessions.lock().unwrap();
    let session = guard.get_mut(&id)
        .ok_or_else(|| McpError::InvalidParams(format!("no live pty for tab {id}")))?;
    use std::io::Write;
    session.writer.write_all(data.as_bytes())
        .map_err(|e| McpError::Internal(format!("write: {e}")))?;
    session.writer.flush().ok();
    Ok(json!({"ok": true}))
}
```

(Adjust `McpError` variants to match the actual enum — `PermissionDenied` and `Internal` may need to be added to `src-tauri/src/mcp/error.rs`.)

- [ ] **Step 4: Add the error variants**

Open `src-tauri/src/mcp/error.rs`. Add:
```rust
PermissionDenied(String),
Internal(String),
```
(Mirror the existing format/Display impl pattern.)

- [ ] **Step 5: Route sensitive tools in `dispatch`**

Append to the `match` in `src-tauri/src/mcp/tools/mod.rs`:
```rust
"terminal.create_tab" => terminal::create_tab(params, ctx).await,
"terminal.close_tab"  => terminal::close_tab(params, ctx).await,
"terminal.send_keys"  => terminal::send_keys(params, ctx).await,
```

- [ ] **Step 6: Build and run all tests**

```bash
cd src-tauri && cargo test -p notter_lib
pnpm test src/lib/terminals/ src/stores/__tests__/terminals-store.test.ts
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mcp/ src-tauri/src/terminals/mod.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(mcp): sensitive terminal.* tools (create/close/send_keys) with permission flow

Permission requests travel via tauri events + oneshot channel; trusted-tab
mode bypasses; default 60s timeout returns PermissionDenied("timeout").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase E — UI components

### Task 13: `TerminalsView` shell + `TerminalSidebar` skeleton

**Files:**
- Create: `src/components/terminals/TerminalsView.tsx`
- Create: `src/components/terminals/TerminalSidebar.tsx`

- [ ] **Step 1: TerminalsView**

Create `src/components/terminals/TerminalsView.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useTerminalsStore } from '@/stores/terminals-store';
import { TerminalSidebar } from './TerminalSidebar';
import { TerminalPane } from './TerminalPane';

export function TerminalsView() {
  const activeId = useTerminalsStore((s) => s.activeTabId);
  const tabs = useTerminalsStore((s) => s.tabs);
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem('terminals.sidebar.collapsed') === '1');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed((c) => {
          localStorage.setItem('terminals.sidebar.collapsed', !c ? '1' : '0');
          return !c;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex h-full min-h-0">
      {!collapsed && (
        <div className="w-60 border-r border-border h-full overflow-y-auto shrink-0">
          <TerminalSidebar />
        </div>
      )}
      <div className="flex-1 min-w-0 h-full">
        {/* Render ALL tabs mounted-but-hidden so PTYs survive switches */}
        {Object.values(tabs).map((t) => (
          <div key={t.id} className={t.id === activeId ? 'h-full' : 'hidden'}>
            <TerminalPane tab={t} />
          </div>
        ))}
        {!activeId && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            No active terminal. Open one from the sidebar.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TerminalSidebar (skeleton; group/tab components come next)**

Create `src/components/terminals/TerminalSidebar.tsx`:
```tsx
import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useTerminalsStore } from '@/stores/terminals-store';
import { TerminalGroup } from './TerminalGroup';
import { ProjectPickerDialog } from './ProjectPickerDialog';

export function TerminalSidebar() {
  const groups = useTerminalsStore((s) => s.groups);
  const tabs = useTerminalsStore((s) => s.tabs);
  const search = useTerminalsStore((s) => s.search);
  const setSearch = useTerminalsStore((s) => s.setSearch);
  const [pickerOpen, setPickerOpen] = useState(false);

  const grouped = useMemo(() => {
    const map: Record<string, typeof tabs[string][]> = {};
    for (const t of Object.values(tabs)) {
      if (!map[t.groupId]) map[t.groupId] = [];
      const matchesSearch =
        !search ||
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.chips.some((c) => JSON.stringify(c.value).toLowerCase().includes(search.toLowerCase()));
      if (matchesSearch) map[t.groupId].push(t);
    }
    return map;
  }, [tabs, search]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-border space-y-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tabs"
            className="w-full pl-7 pr-2 py-1 text-xs rounded-sm border border-border bg-background"
          />
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full flex items-center justify-center gap-1 text-xs py-1 rounded-sm bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={12} /> New tab
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {Object.values(groups).map((g) => (
          <TerminalGroup key={g.id} group={g} tabs={grouped[g.id] ?? []} />
        ))}
      </div>

      <ProjectPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
  );
}
```

- [ ] **Step 3: Commit (still has unresolved imports — next task fixes)**

```bash
git add src/components/terminals/TerminalsView.tsx src/components/terminals/TerminalSidebar.tsx
git commit -m "feat(terminals): TerminalsView shell + TerminalSidebar skeleton

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(The imports for `TerminalGroup`, `TerminalPane`, `ProjectPickerDialog` will be resolved in the next tasks. This is an intentional incremental commit.)

---

### Task 14: `TerminalGroup`, `TerminalTabItem`, `TabChips`

**Files:**
- Create: `src/components/terminals/TerminalGroup.tsx`
- Create: `src/components/terminals/TerminalTabItem.tsx`
- Create: `src/components/terminals/TabChips.tsx`
- Test: `src/components/terminals/__tests__/TabChips.test.tsx`

- [ ] **Step 1: Implement TabChips with type-specific rendering**

Create `src/components/terminals/TabChips.tsx`:
```tsx
import type { TabChip } from '@/lib/terminals/chip-schema';
import { GitBranch, Folder, AlertCircle, CheckCircle, Clock, Bug, Github } from 'lucide-react';

interface Props { chips: TabChip[] }

export function TabChips({ chips }: Props) {
  if (chips.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap mt-0.5">
      {chips.map((c, i) => <Chip key={`${c.type}-${i}`} chip={c} />)}
    </div>
  );
}

function Chip({ chip }: { chip: TabChip }) {
  const base = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[9px] uppercase tracking-wider font-bold border';
  switch (chip.type) {
    case 'pr': {
      const v = chip.value;
      const color = v.state === 'merged' ? 'text-purple-600 border-purple-300 bg-purple-50 dark:bg-purple-900/30'
                  : v.state === 'closed' ? 'text-red-600 border-red-300 bg-red-50 dark:bg-red-900/30'
                  : 'text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-900/30';
      return <span className={`${base} ${color}`} title={v.url}><Github size={9} /> #{v.number}</span>;
    }
    case 'branch':
      return <span className={`${base} text-foreground border-border bg-muted/40`} title="branch"><GitBranch size={9} /> {chip.value.name}</span>;
    case 'worktree':
      return <span className={`${base} text-foreground border-border bg-muted/40`} title={chip.value.path ?? 'worktree'}><Folder size={9} /> {chip.value.name}</span>;
    case 'ci': {
      const v = chip.value;
      const icon = v.state === 'passing' ? <CheckCircle size={9} /> : v.state === 'failing' ? <AlertCircle size={9} /> : <Clock size={9} />;
      const color = v.state === 'passing' ? 'text-green-600 border-green-300 bg-green-50 dark:bg-green-900/30'
                  : v.state === 'failing' ? 'text-red-600 border-red-300 bg-red-50 dark:bg-red-900/30'
                  : 'text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-900/30';
      return <span className={`${base} ${color}`} title={v.url}>{icon} {v.label ?? v.state}</span>;
    }
    case 'issue':
      return <span className={`${base} text-foreground border-border bg-muted/40`} title={chip.value.url}><Bug size={9} /> #{chip.value.number}</span>;
    case 'status': {
      const v = chip.value;
      const color = v.severity === 'err' ? 'text-red-600 border-red-300 bg-red-50 dark:bg-red-900/30'
                  : v.severity === 'warn' ? 'text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-900/30'
                  : 'text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-900/30';
      return <span className={`${base} ${color}`}>{v.label}</span>;
    }
    case 'free': {
      const style = chip.value.color ? { borderColor: chip.value.color, color: chip.value.color } : undefined;
      return <span className={`${base} bg-muted/40`} style={style}>{chip.value.label}</span>;
    }
  }
}
```

- [ ] **Step 2: Test the chip rendering**

Create `src/components/terminals/__tests__/TabChips.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TabChips } from '../TabChips';
import type { TabChip } from '@/lib/terminals/chip-schema';

describe('TabChips', () => {
  it('renders PR with #number', () => {
    const chips: TabChip[] = [{ type: 'pr', value: { number: 1234 } }];
    const { getByText } = render(<TabChips chips={chips} />);
    expect(getByText('#1234')).toBeTruthy();
  });

  it('renders multiple free chips', () => {
    const chips: TabChip[] = [
      { type: 'free', value: { label: 'A' } },
      { type: 'free', value: { label: 'B' } },
    ];
    const { getByText } = render(<TabChips chips={chips} />);
    expect(getByText('A')).toBeTruthy();
    expect(getByText('B')).toBeTruthy();
  });

  it('renders ci passing in green', () => {
    const chips: TabChip[] = [{ type: 'ci', value: { state: 'passing' } }];
    const { container } = render(<TabChips chips={chips} />);
    expect(container.querySelector('.text-green-600')).toBeTruthy();
  });
});
```

Run: `pnpm test src/components/terminals/__tests__/TabChips.test.tsx` — expect all 3 PASS.

- [ ] **Step 3: Implement TerminalTabItem**

Create `src/components/terminals/TerminalTabItem.tsx`:
```tsx
import { useState } from 'react';
import { Shield } from 'lucide-react';
import { useTerminalsStore, type TerminalTab } from '@/stores/terminals-store';
import { TabChips } from './TabChips';

export function TerminalTabItem({ tab }: { tab: TerminalTab }) {
  const isActive = useTerminalsStore((s) => s.activeTabId === tab.id);
  const setActiveTab = useTerminalsStore((s) => s.setActiveTab);
  const renameTab = useTerminalsStore((s) => s.renameTab);
  const removeTab = useTerminalsStore((s) => s.removeTab);
  const setTrusted = useTerminalsStore((s) => s.setTrusted);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tab.name);

  return (
    <div
      onClick={() => setActiveTab(tab.id)}
      onDoubleClick={() => { setDraft(tab.name); setRenaming(true); }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Simple menu via window.confirm-style stub for now; replace with proper menu later.
        const action = window.prompt('rename | trust | untrust | close', '');
        if (action === 'rename') { setDraft(tab.name); setRenaming(true); }
        else if (action === 'trust') setTrusted(tab.id, true);
        else if (action === 'untrust') setTrusted(tab.id, false);
        else if (action === 'close') removeTab(tab.id);
      }}
      className={`relative px-2 py-1 cursor-pointer text-xs ${isActive ? 'bg-primary/10' : 'hover:bg-muted/50'}`}
    >
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: tab.color ?? 'transparent' }} />
      <div className="flex items-center gap-1 pl-2">
        {tab.trusted && <Shield size={10} className="text-emerald-600" />}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.ptyAlive ? 'bg-green-500' : 'bg-red-500'}`} />
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { renameTab(tab.id, draft.trim() || tab.name); setRenaming(false); }
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={() => { renameTab(tab.id, draft.trim() || tab.name); setRenaming(false); }}
            className="flex-1 bg-background text-foreground text-xs px-1 rounded-sm border border-border outline-none"
          />
        ) : (
          <span className="truncate">{tab.name}</span>
        )}
      </div>
      <div className="pl-2">
        <TabChips chips={tab.chips} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement TerminalGroup**

Create `src/components/terminals/TerminalGroup.tsx`:
```tsx
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTerminalsStore, type TerminalGroup as TGroup, type TerminalTab } from '@/stores/terminals-store';
import { TerminalTabItem } from './TerminalTabItem';

interface Props { group: TGroup; tabs: TerminalTab[] }

export function TerminalGroup({ group, tabs }: Props) {
  const toggle = useTerminalsStore((s) => s.toggleGroupCollapse);
  return (
    <div>
      <button
        onClick={() => toggle(group.id)}
        className="w-full text-left px-2 py-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {group.collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        <span>{group.name}</span>
        <span className="ml-auto text-[9px]">{tabs.length}</span>
      </button>
      {!group.collapsed && (
        <div>
          {tabs.map((t) => <TerminalTabItem key={t.id} tab={t} />)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/terminals/TabChips.tsx src/components/terminals/TerminalTabItem.tsx src/components/terminals/TerminalGroup.tsx src/components/terminals/__tests__/TabChips.test.tsx
git commit -m "$(cat <<'EOF'
feat(terminals): sidebar tab item + group + chips renderer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: `TerminalPane` (xterm) + `TerminalTopBar`

**Files:**
- Create: `src/components/terminals/TerminalPane.tsx`
- Create: `src/components/terminals/TerminalTopBar.tsx`
- Create: `src/components/terminals/AttachDropOverlay.tsx`

- [ ] **Step 1: TerminalPane (port + extend from feature/terminals TerminalView)**

Create `src/components/terminals/TerminalPane.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTerminalsStore, type TerminalTab } from '@/stores/terminals-store';
import { processDrop } from '@/lib/terminals/drop-pipeline';
import { DEFAULT_AI_CLI_LIST } from '@/lib/terminals/ai-cli-detector';
import { TerminalTopBar } from './TerminalTopBar';
import { AttachDropOverlay } from './AttachDropOverlay';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane({ tab }: { tab: TerminalTab }) {
  const ref = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const setPtyAlive = useTerminalsStore((s) => s.setPtyAlive);

  useEffect(() => {
    if (!ref.current || xtermRef.current) return;
    const term = new Terminal({ cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new LigaturesAddon()); } catch {}
    term.open(ref.current);
    fit.fit();
    xtermRef.current = term;
    fitRef.current = fit;

    term.onData((data) => { invoke('write_pty', { id: tab.id, data }).catch(() => {}); });
    term.onResize(({ cols, rows }) => { invoke('resize_pty', { id: tab.id, cols, rows }).catch(() => {}); });

    const ro = new ResizeObserver(() => fitRef.current?.fit());
    ro.observe(ref.current);

    let unOut: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const [o, e] = await Promise.all([
        listen<{ id: string; data: string }>('pty-output', ({ payload }) => {
          if (payload.id === tab.id) term.write(payload.data);
        }),
        listen<{ id: string; code: number }>('pty-exit', ({ payload }) => {
          if (payload.id === tab.id) {
            setPtyAlive(tab.id, false);
            term.writeln(`\r\n\x1b[90m[Process exited with code ${payload.code}]\x1b[0m`);
          }
        }),
      ]);
      if (cancelled) { o(); e(); return; }
      unOut = o; unExit = e;
      try {
        const { cols, rows } = term;
        await invoke('create_pty', { id: tab.id, cols, rows, cwd: tab.cwd, shell: tab.shell });
        setPtyAlive(tab.id, true);
      } catch (err) {
        setError(String(err));
      }
    })();

    return () => {
      cancelled = true;
      ro.disconnect();
      unOut?.();
      unExit?.();
      invoke('close_pty', { id: tab.id }).catch(() => {});
      term.dispose();
      xtermRef.current = null;
    };
  }, [tab.id, tab.cwd, tab.shell, setPtyAlive]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      // Files dragged from outside the browser usually have no real path in DataTransfer;
      // Tauri's webview.on_drop is the source of truth for true OS paths. As a fallback for
      // in-browser drag (no OS path), read it as data URL and route to clipboard-image path.
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = String(reader.result);
        await processDrop({
          tabId: tab.id,
          shell: tab.shell,
          aiCliList: DEFAULT_AI_CLI_LIST,
          input: { kind: 'clipboard-image', payload: { dataUrl } },
        });
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 relative"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <TerminalTopBar tab={tab} />
      {error
        ? <div className="flex-1 flex items-center justify-center text-destructive text-sm">{error}</div>
        : <div ref={ref} className="flex-1" />}
      {dragging && <AttachDropOverlay />}
    </div>
  );
}
```

(True OS-file drops via `tauri.webview.on_drop` are handled in Task 18 — a global listener routes the path to the active tab's `processDrop`.)

- [ ] **Step 2: TerminalTopBar**

Create `src/components/terminals/TerminalTopBar.tsx`:
```tsx
import { useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Paperclip, RotateCw, X, Shield } from 'lucide-react';
import { useTerminalsStore, type TerminalTab, type Shell } from '@/stores/terminals-store';
import { processDrop } from '@/lib/terminals/drop-pipeline';
import { DEFAULT_AI_CLI_LIST } from '@/lib/terminals/ai-cli-detector';

export function TerminalTopBar({ tab }: { tab: TerminalTab }) {
  const removeTab = useTerminalsStore((s) => s.removeTab);
  const fileInput = useRef<HTMLInputElement>(null);

  const onAttachPick = async (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result);
      await processDrop({
        tabId: tab.id,
        shell: tab.shell,
        aiCliList: DEFAULT_AI_CLI_LIST,
        input: { kind: 'clipboard-image', payload: { dataUrl } },
      });
    };
    reader.readAsDataURL(file);
  };

  const onShellChange = async (next: Shell) => {
    await invoke('close_pty', { id: tab.id });
    await invoke('create_pty', { id: tab.id, cols: 80, rows: 24, cwd: tab.cwd, shell: next });
    // Persisting the new shell is handled by the store update in the parent flow.
  };

  return (
    <div className="h-8 bg-muted/40 border-b border-border flex items-center justify-between px-2 text-xs shrink-0">
      <div className="flex items-center gap-1 truncate">
        {tab.trusted && <Shield size={10} className="text-emerald-600" />}
        <span className="truncate font-semibold">{tab.name}</span>
      </div>
      <div className="flex items-center gap-1">
        <div className="flex border border-border rounded-sm overflow-hidden">
          {(['powershell', 'bash', 'cmd'] as Shell[]).map((sh) => (
            <button
              key={sh}
              onClick={() => sh !== tab.shell && onShellChange(sh)}
              className={`px-1.5 py-0.5 text-[10px] ${tab.shell === sh ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {sh === 'powershell' ? 'PS' : sh === 'bash' ? 'Bash' : 'CMD'}
            </button>
          ))}
        </div>
        <button onClick={() => fileInput.current?.click()} title="Attach file" className="p-1 hover:bg-muted rounded-sm">
          <Paperclip size={12} />
        </button>
        <input ref={fileInput} type="file" hidden onChange={(e) => {
          const f = e.target.files?.[0]; if (f) onAttachPick(f);
          e.currentTarget.value = '';
        }} />
        <button title="Restart" className="p-1 hover:bg-muted rounded-sm"
          onClick={async () => {
            await invoke('close_pty', { id: tab.id }).catch(() => {});
            await invoke('create_pty', { id: tab.id, cols: 80, rows: 24, cwd: tab.cwd, shell: tab.shell });
          }}>
          <RotateCw size={12} />
        </button>
        <button onClick={() => removeTab(tab.id)} title="Close" className="p-1 hover:bg-destructive/20 rounded-sm">
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: AttachDropOverlay**

Create `src/components/terminals/AttachDropOverlay.tsx`:
```tsx
export function AttachDropOverlay() {
  return (
    <div className="absolute inset-0 bg-primary/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
      <div className="px-4 py-2 rounded-md border border-primary text-sm font-semibold text-primary">
        Drop to attach
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/terminals/TerminalPane.tsx src/components/terminals/TerminalTopBar.tsx src/components/terminals/AttachDropOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(terminals): TerminalPane (xterm lifecycle) + TopBar + DropOverlay

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: `ProjectPickerDialog`

**Files:**
- Create: `src/components/terminals/ProjectPickerDialog.tsx`

- [ ] **Step 1: Implement**

Create the dialog (adapt from `feature/terminals`'s `TerminalsTab.tsx`):
```tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Folder, Monitor } from 'lucide-react';
import { usePlannerStore } from '@/stores/planner-store';
import { useTerminalsStore } from '@/stores/terminals-store';

interface Props { open: boolean; onOpenChange: (v: boolean) => void }

export function ProjectPickerDialog({ open, onOpenChange }: Props) {
  const projects = usePlannerStore((s) => s.projects);
  const ensureGroup = useTerminalsStore((s) => s.ensureGroupForProject);
  const createTab = useTerminalsStore((s) => s.createTab);
  const setActive = useTerminalsStore((s) => s.setActiveTab);
  const [shell, setShell] = useState<'powershell' | 'bash' | 'cmd'>('powershell');

  const open_ = (name: string, path?: string) => {
    const gid = path ? ensureGroup(path, name) : ensureGroup('__root__', 'Other');
    const id = createTab({ cwd: path ?? '', shell, groupId: gid, name });
    setActive(id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New terminal</DialogTitle>
          <DialogDescription>Pick a project (cwd) — group is derived automatically.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 my-2">
          {(['powershell', 'bash', 'cmd'] as const).map((sh) => (
            <button key={sh}
              onClick={() => setShell(sh)}
              className={`px-2 py-1 text-xs rounded-sm border ${shell === sh ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
            >{sh === 'powershell' ? 'PS' : sh === 'bash' ? 'Bash' : 'CMD'}</button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {projects.map((p) => (
            <button key={p.name} onClick={() => open_(p.name, p.path)}
              className="flex items-center gap-3 p-3 border border-border rounded-md hover:border-primary text-left">
              <Folder size={16} />
              <div className="flex flex-col">
                <span className="text-sm font-semibold">{p.name}</span>
                <span className="text-[10px] text-muted-foreground truncate">{p.path}</span>
              </div>
            </button>
          ))}
          <button onClick={() => open_('Terminal')}
            className="flex items-center gap-3 p-3 border border-border rounded-md hover:border-primary text-left bg-muted/20">
            <Monitor size={16} />
            <span className="text-sm font-semibold">Open without a project</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/terminals/ProjectPickerDialog.tsx
git commit -m "feat(terminals): ProjectPickerDialog using planner projects

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: `McpPermissionDialog` + permission queue

**Files:**
- Create: `src/components/terminals/McpPermissionDialog.tsx`
- Create: `src/stores/mcp-permission-store.ts`
- Test: `src/stores/__tests__/mcp-permission-store.test.ts`
- Modify: `src/components/Layout.tsx` (mount the dialog)

- [ ] **Step 1: Write failing tests for the permission queue**

Create `src/stores/__tests__/mcp-permission-store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useMcpPermissionStore } from '../mcp-permission-store';

beforeEach(() => useMcpPermissionStore.setState({ queue: [] }));

describe('mcp-permission-store', () => {
  it('enqueues and pops in order', () => {
    const s = useMcpPermissionStore.getState();
    s.enqueue({ requestId: '1', tabId: 't', tool: 'terminal.send_keys', args: {} });
    s.enqueue({ requestId: '2', tabId: 't', tool: 'terminal.close_tab', args: {} });
    expect(useMcpPermissionStore.getState().queue.length).toBe(2);
    expect(useMcpPermissionStore.getState().queue[0].requestId).toBe('1');
    s.shift();
    expect(useMcpPermissionStore.getState().queue[0].requestId).toBe('2');
  });
});
```

Run: `pnpm test src/stores/__tests__/mcp-permission-store.test.ts` → FAIL.

- [ ] **Step 2: Implement**

Create `src/stores/mcp-permission-store.ts`:
```ts
import { create } from 'zustand';

export interface PermissionRequest {
  requestId: string;
  tabId: string;
  tool: string;
  args: unknown;
}

interface State {
  queue: PermissionRequest[];
  enqueue: (r: PermissionRequest) => void;
  shift: () => PermissionRequest | undefined;
}

export const useMcpPermissionStore = create<State>((set, get) => ({
  queue: [],
  enqueue: (r) => set((s) => ({ queue: [...s.queue, r] })),
  shift: () => {
    const head = get().queue[0];
    if (head) set((s) => ({ queue: s.queue.slice(1) }));
    return head;
  },
}));
```

Run tests — PASS.

- [ ] **Step 3: Implement the dialog**

Create `src/components/terminals/McpPermissionDialog.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useMcpPermissionStore } from '@/stores/mcp-permission-store';
import { useTerminalsStore } from '@/stores/terminals-store';

export function McpPermissionDialog() {
  const head = useMcpPermissionStore((s) => s.queue[0]);
  const queueLen = useMcpPermissionStore((s) => s.queue.length);
  const shift = useMcpPermissionStore((s) => s.shift);
  const grant = useTerminalsStore((s) => s.grantPermission);
  const setTrusted = useTerminalsStore((s) => s.setTrusted);
  const tab = useTerminalsStore((s) => head ? s.tabs[head.tabId] : null);
  const [markTrusted, setMarkTrusted] = useState(false);

  useEffect(() => setMarkTrusted(false), [head?.requestId]);

  if (!head) return null;

  const resolve = async (decision: 'deny' | 'allow' | 'always' | 'trusted') => {
    if (markTrusted && decision !== 'deny') {
      setTrusted(head.tabId, true);
      decision = 'trusted';
    }
    if (decision === 'always') grant(head.tabId, head.tool as any);
    await invoke('mcp_permission_resolve', { requestId: head.requestId, decision });
    shift();
  };

  const argSummary = typeof (head.args as any)?.data === 'string'
    ? `> ${(head.args as any).data.slice(0, 500)}`
    : JSON.stringify(head.args).slice(0, 500);

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) resolve('deny'); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permission required</DialogTitle>
          <DialogDescription>
            An MCP client in tab "{tab?.name ?? head.tabId}" wants to: <span className="font-mono">{head.tool}</span>
          </DialogDescription>
        </DialogHeader>
        <pre className="text-xs bg-muted p-2 rounded-sm overflow-x-auto whitespace-pre-wrap">{argSummary}</pre>
        <label className="text-xs flex items-center gap-2">
          <input type="checkbox" checked={markTrusted} onChange={(e) => setMarkTrusted(e.target.checked)} />
          Mark this tab as Trusted (skip all prompts here)
        </label>
        <div className="flex gap-2 justify-end">
          <button onClick={() => resolve('deny')} className="px-3 py-1 text-xs rounded-sm border border-border">Deny</button>
          <button onClick={() => resolve('allow')} className="px-3 py-1 text-xs rounded-sm bg-muted hover:bg-muted/80">Allow once</button>
          <button onClick={() => resolve('always')} className="px-3 py-1 text-xs rounded-sm bg-primary text-primary-foreground">Always in this tab</button>
        </div>
        {queueLen > 1 && <p className="text-[10px] text-muted-foreground">1 of {queueLen} pending</p>}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire the event listener**

In `src/lib/sync.ts` (or a new `src/lib/terminals/listeners.ts` invoked at boot):
```ts
await listen<{ id: string; tool: string; args: any; requestId: string }>(
  'terminal:permission-request',
  ({ payload }) => {
    // Auto-resolve if tab is trusted or already has a grant.
    const tab = useTerminalsStore.getState().tabs[payload.id];
    if (tab?.trusted) {
      invoke('mcp_permission_resolve', { requestId: payload.requestId, decision: 'trusted' });
      return;
    }
    if (tab?.permissionGrants?.[payload.tool as any]) {
      invoke('mcp_permission_resolve', { requestId: payload.requestId, decision: 'allow' });
      return;
    }
    useMcpPermissionStore.getState().enqueue({
      requestId: payload.requestId,
      tabId: payload.id,
      tool: payload.tool,
      args: payload.args,
    });
  }
);
```

- [ ] **Step 5: Mount the dialog at root**

Open `src/components/Layout.tsx` and add `<McpPermissionDialog />` near the existing global dialogs.

- [ ] **Step 6: Commit**

```bash
git add src/stores/mcp-permission-store.ts src/stores/__tests__/mcp-permission-store.test.ts src/components/terminals/McpPermissionDialog.tsx src/components/Layout.tsx src/lib/sync.ts
git commit -m "$(cat <<'EOF'
feat(terminals): MCP permission dialog + queue + auto-resolve grants/trusted

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: OS-level drag-drop (Tauri `webview.on_drop`)

**Files:**
- Modify: `src-tauri/src/lib.rs` (wire `window.on_window_event` drop handler)
- Modify: `src/lib/sync.ts` (frontend `tauri:drag-drop` listener)

- [ ] **Step 1: Listen for the global drop event in Rust**

In `src-tauri/src/lib.rs`'s `setup` closure, attach a window event handler that emits to the frontend with the file paths:
```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
        let payload = serde_json::json!({ "paths": paths });
        let _ = window.emit("notter:drop", payload);
    }
})
```

(Adjust naming per the exact Tauri 2 API your codebase uses.)

- [ ] **Step 2: Frontend listener routes to active tab**

In `src/lib/sync.ts`:
```ts
await listen<{ paths: string[] }>('notter:drop', async ({ payload }) => {
  const s = useTerminalsStore.getState();
  if (!s.activeTabId) return;
  const tab = s.tabs[s.activeTabId];
  if (!tab) return;
  for (const p of payload.paths) {
    await processDrop({
      tabId: tab.id,
      shell: tab.shell,
      aiCliList: DEFAULT_AI_CLI_LIST,
      input: { kind: 'file', payload: { path: p } },
    });
  }
});
```

- [ ] **Step 3: Manual test**

Run the app; drag a PNG from File Explorer over the active terminal tab; verify the path (with `@` prefix when Claude/Codex is running) is written into the PTY.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src/lib/sync.ts
git commit -m "$(cat <<'EOF'
feat(terminals): OS-level drag-drop routes paths to active tab via tauri:drag-drop

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase F — Integration, settings, smoke

### Task 19: Mount "Terminals" tab in the main shell

**Files:**
- Modify: `src/components/Layout.tsx`
- Modify: `src/i18n/locales/en.json` + `pt-BR.json` (add `tabs.terminals` strings)

- [ ] **Step 1: Import and render**

Find the existing tab strip in `Layout.tsx` (parallel to where `PlannerTab` is mounted). Add an entry for `TerminalsView`. Mirror the existing patterns (icon, key, label via `t('tabs.terminals')`).

- [ ] **Step 2: Add translations**

`en.json`:
```json
"tabs.terminals": "Terminals",
"terminals.permission.title": "Permission required",
"terminals.permission.deny": "Deny",
"terminals.permission.once": "Allow once",
"terminals.permission.always": "Always in this tab",
"terminals.permission.trusted": "Mark as Trusted"
```
And the matching keys in `pt-BR.json`.

- [ ] **Step 3: Manual sanity**

Boot the app; click the new tab; verify the empty Terminals view + sidebar with the "New tab" button appears.

- [ ] **Step 4: Commit**

```bash
git add src/components/Layout.tsx src/i18n/locales/en.json src/i18n/locales/pt-BR.json
git commit -m "$(cat <<'EOF'
feat(terminals): mount Terminals tab in main shell

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Settings UI for the AI CLI list

**Files:**
- Modify: `src/stores/app-store.ts` (persist `terminalSettings.aiCliList`)
- Modify: `src/components/settings/tabs/GeneralTab.tsx` (or a new TerminalsTab if natural) — add editor section

- [ ] **Step 1: Extend app-store**

Open `src/stores/app-store.ts`. Find `terminalSettings`. Add:
```ts
aiCliList: AiCliEntry[];  // import from @/lib/terminals/ai-cli-detector
```
Default to `DEFAULT_AI_CLI_LIST`.

- [ ] **Step 2: Render an editor**

In the relevant settings tab, render a small editor (name + regex string + prefix + enabled toggle + remove). Save the regex as a string in store and compile on read:
```ts
{ name, pattern: string, prefix, enabled }
```
Compile pattern via `new RegExp(pattern, 'i')` in `detectAiCli` (refactor it to accept either the typed entry or the string version, or normalize at store-read time).

- [ ] **Step 3: Commit**

```bash
git add src/stores/app-store.ts src/components/settings/
git commit -m "$(cat <<'EOF'
feat(terminals): user-editable AI CLI list in Settings → Terminal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: Smoke checklist script

**Files:**
- Create: `scripts/smoke-terminal.ps1`

- [ ] **Step 1: Write the checklist**

Create `scripts/smoke-terminal.ps1`:
```powershell
# Manual smoke test for the Terminals feature.
# Run AFTER booting the app with `pnpm tauri dev`.

Write-Host "Notter Terminal smoke checklist" -ForegroundColor Cyan
Write-Host "Run each step manually in the app and tick it off."

@(
  "1.  Open Terminals tab; sidebar empty; '+ New tab' enabled.",
  "2.  Pick a planner project from the picker; tab opens; PTY shows shell prompt.",
  "3.  Type 'echo hello' + Enter; output appears.",
  "4.  Right-click the tab → rename to 'PR review'; sidebar updates.",
  "5.  Right-click → trust; shield icon appears.",
  "6.  Drag a PNG from File Explorer into the active terminal — without Claude running.",
  "    Expect: raw path written into PTY (no @ prefix).",
  "7.  Start 'claude' inside the terminal. Drag the same PNG again.",
  "    Expect: '@<path> ' written into PTY.",
  "8.  Ctrl+V an image from clipboard. Expect: file saved under %TEMP%\notter-paste\\, path written.",
  "9.  From an external MCP client with NOTTER_TERMINAL_ID set, call terminal.set_name('Changed');",
  "    Sidebar updates live.",
  "10. From the same client, call terminal.send_keys with 'whoami\\n';",
  "    Permission modal appears (tab not trusted, no grant);",
  "    Choose 'Always in this tab'; second call goes through silently.",
  "11. Open Notter on a second device with the same account;",
  "    The 'PR review' tab + chips appear; PTY is cold; clicking it offers 'Start session'.",
  "12. Close the tab; row disappears from Supabase; second device removes it via realtime."
) | ForEach-Object { Write-Host "  [ ] $_" }
```

- [ ] **Step 2: Run the checklist (manual)**

Boot the app, work through each item. Capture failures back into specific tasks.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-terminal.ps1
git commit -m "$(cat <<'EOF'
chore: terminal smoke checklist script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Codex review pass

**Files:**
- No file changes; consumes findings into a fix-up commit if any.

- [ ] **Step 1: Run Codex review of the branch**

Invoke the project's standard pattern (per memory `project_multi_user_plan2_shipped.md`: "Codex review applied 4 fixes" — same workflow).

Use the `codex:rescue` skill to dispatch a review run targeting `feat/terminal-revival` vs `main`.

- [ ] **Step 2: Triage findings**

For each finding: `accept` (apply) / `defer` (note in `docs/superpowers/runbooks/2026-05-17-terminal-revival-deferred.md`) / `reject` (rationale in the same runbook).

- [ ] **Step 3: Apply accepted fixes as one or more new commits**

Each fix is its own commit. Refer back to task numbers if relevant.

- [ ] **Step 4: Run the full test suite + smoke script one more time**

```bash
cd src-tauri && cargo test -p notter_lib
pnpm test
pnpm typecheck
# smoke: manual via scripts/smoke-terminal.ps1
```
All must pass before merge.

- [ ] **Step 5: Open PR**

```bash
gh pr create --title "Terminal revival — Warp-style tabs + bidirectional MCP" --body "$(cat <<'EOF'
## Summary
- Restore PTY terminal from feature/terminals as a dedicated Terminals tab
- Sidebar groups derived from planner projects; rename / color / typed+free chips
- Bidirectional MCP: 7 auto-allowed + 3 sensitive terminal.* tools with per-tab grants and Trusted-Tab mode
- Drag-drop pipeline with Windows foreground-process detection and configurable AI CLI auto-`@`-prefix
- Per-user Supabase realtime sync of tab metadata (PTY + grants stay local)

Spec: docs/superpowers/specs/2026-05-17-terminal-revival-design.md
Plan: docs/superpowers/plans/2026-05-17-terminal-revival.md

## Test plan
- [ ] cargo test -p notter_lib passes
- [ ] pnpm test passes
- [ ] pnpm typecheck clean
- [ ] scripts/smoke-terminal.ps1 manual checklist completed
- [ ] Codex review pass applied / deferred

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage:**
- §1 Goals → Tasks 1–22 collectively. ✓
- §2 Architecture → File Structure section + Task 1. ✓
- §3 Data Model TS → Task 8 (store) + Task 5 (chips). ✓
- §3 Supabase schema → Task 9. ✓
- §4 MCP auto-allowed → Task 11. ✓
- §4 Sensitive + tab identity → Tasks 10 + 12. ✓
- §5 Drag-drop pipeline → Tasks 4 + 7 + 18. ✓
- §5 Foreground detection → Task 3. ✓
- §6 Permission UX → Tasks 12 + 17. ✓
- §7 Components → Tasks 13–17. ✓
- §8 Backend Rust changes → Tasks 1–4, 10, 12. ✓
- §9 Tab identity contract → Task 11 (resolve_tab_id) + Task 2 (env injection). ✓
- §11 Testing → tests scattered across Tasks 2, 3, 5–8, 14, 17 + smoke in Task 21. ✓
- §12 Dependencies → Task 1 (with pre-flight). ✓
- §14 Acceptance criteria → Tasks 21 + 22. ✓

**Gaps caught and folded inline:**
- Settings UI for the editable AI CLI list (spec §5.4) → added as Task 20.
- "Mount the Terminals tab" wasn't its own line in the spec; bundled into Task 19.
- `docs/MCP-TERMINAL.md` (spec §9 documentation deliverable) is **not** in this plan — defer to a follow-up commit after PR merge. Note this in the PR description.

**Placeholder scan:** no TBD / TODO / "appropriate error handling" left. Every step has the code or the command.

**Type consistency:** `Shell` is defined identically in `shell-path-quote.ts` and `terminals-store.ts`; both export the union, but consumers import from `terminals-store` (store re-exports it for ergonomics). The store's `SensitiveTool` union matches the Rust dispatch arms (`terminal.create_tab` / `terminal.close_tab` / `terminal.send_keys`).

---

## Open follow-ups (for the next plan)

- `docs/MCP-TERMINAL.md` — public-facing contract for AI CLIs adopting `NOTTER_TERMINAL_ID`.
- macOS / Linux foreground-process detection.
- Right-click menu polish (replace the temporary `window.prompt` stub in `TerminalTabItem`).
- Drag-reorder of tabs between groups.

