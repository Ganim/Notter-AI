# M3 — Persistent MCP HTTP Server (Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land M3 of the Phase 1 pivot — Notter-AI gains a persistent, in-process MCP HTTP server (Rust + axum) that boots alongside Tauri, binds `127.0.0.1:0`, and exposes 6 read/write tools for external CLIs (claude-code, codex, aider) to introspect and revise the user's subjects (markdown plans). The server uses per-account Bearer-token auth, holds a token map populated from the M1 secure store, and reads/writes Supabase via REST using the front-end's rotating access token (front-end remains the sole Supabase refresh owner per spec §6.2). M1 (multi-account, secure store, account-manager) and M2 (subject-versioning schema, `subject_versions` / `subject_comments`, `useSubjectVersionsStore`) must be fully merged to `main` before M3 begins.

**Architecture:** Bottom-up, six concentric rings:
1. **Cargo deps + module skeleton** — add `axum`, `tower`, `tower-http`, `rand`, `uuid`; carve `src-tauri/src/mcp/{mod,server,auth,tools,supabase,endpoint,types,error}.rs` empty so the rest of the milestone fills them in without churn.
2. **Endpoint discovery + nonce stale detection** — write/read `<appLocalData>/notter-ai/mcp/endpoint.json` with `{ url, pid, nonce, started_at }`; nonce-based health probe replaces PID liveness (per spec §6.1, observation 67 from 2026-05-09).
3. **Token map + Tauri bridge commands** — in-memory `HashMap<token, accountId>` and `HashMap<accountId, (access_token, expires_at)>`, populated from secure store at boot and updated via two new Tauri commands `mcp_update_account_token` / `mcp_remove_account_token` invoked from the front-end on every Supabase auth-state change.
4. **axum lifecycle + Bearer auth middleware + JSON-RPC dispatch** — single `POST /mcp` route + `GET /health`; Bearer extractor middleware injects the resolved `accountId` into request extensions; JSON-RPC 2.0 envelope decoded by hand (no `jsonrpc-core` dep) so error codes match MCP conventions.
5. **Supabase REST helper + 6 tools** — `reqwest`-based client wrapper using `Authorization: Bearer <user_access_token>` + `apikey: <publishable_anon_key>`; each tool maps directly to a `subjects` / `subject_versions` / `subject_comments` query.
6. **Front-end glue + UI surface** — auth-store pushes new access tokens via Tauri command on every refresh; account-manager `add` / `remove` publish/clear the per-account MCP token; "MCP config" entry in `UserMenu` opens a small dialog that copies the URL+token JSON to clipboard; per-account stable config file written to `<appLocalData>/notter-ai/mcp/<accountId>-config.json` on boot for users whose CLI accepts file-based config.

**Tech Stack:** Rust 1.74+ / Tauri 2 / `axum 0.8.9` / `tower-http 0.6` / `tokio 1` / `reqwest 0.12` (already dep, JSON feature) / `serde 1` / `serde_json 1` / `uuid 1` / `rand 0.9` / `keyring 3.6.3` (already dep). Front-end: TypeScript / React / `@tauri-apps/api` / `@tauri-apps/plugin-fs`.

**Spec references:** `docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md` §4 (architecture), §5.2 (local storage layout incl. `mcp/endpoint.json`), §6 (MCP server design — lifecycle, auth, transport, tools), §6.5 (happy-path sequence), §7 M3 (scope), §11 (out-of-scope), §13 (Codex review log — token-refresh race resolved via front-end-as-sole-refresh-owner; stale endpoint resolved via nonce). Live schema: `supabase/migrations/2026-05-10-subject-versioning.sql`. M1 foundation: `src-tauri/src/secure_store.rs`, `src/lib/accounts/secure-store.ts`, `src/lib/accounts/account-manager.ts`, `src/stores/auth-store.ts`. M2 foundation: `src/stores/subject-versions-store.ts`, `src/lib/sync.ts` (subject helpers).

**Out of scope (do not drift):** SSE / streaming tools (Phase 3 — happens once `subscribe_changes` is needed for realtime collab). `post_comment` MCP tool (humans author comments — spec §6.4). `delete_*` tools (UI only). Stdio MCP bridge (`notter-mcp-bridge.js` — Phase 1.5 if a target CLI lacks HTTP transport). Realtime push from MCP to UI (the UI's existing Supabase realtime channel handles it; the Rust server never broadcasts to the front-end). JSON-RPC batching (no MCP client uses it in Phase 1). `Mcp-Session-Id` header (the spec-2025-03-26 transport uses it for SSE re-attach; we have no SSE in Phase 1, so the header is parsed-and-ignored). Touching the legacy `notter-mcp-server/` Node stdio child (Phase 3 decision; coexists by table-isolation per spec §7 M3). Touching `PlannerTab.tsx`, `subject-versions-store.ts`, `useSubjectVersionsStore` callers — Rust is the only writer for `subject_versions` from MCP, but it does so via raw REST, not by touching the front-end store.

---

## Parallel-execution notes (CRITICAL — read before starting)

This plan is designed to execute in parallel with **`docs/superpowers/plans/2026-05-10-m4-import-export.md`** in a separate worktree and a separate `/do` session. Recommended setup:

```bash
git worktree add ../Notter-AI-m3 -b m3-mcp-server main
git worktree add ../Notter-AI-m4 -b m4-import-export main
```

Then run `/do docs/superpowers/plans/2026-05-10-m3-mcp-server.md` in one terminal pointed at `../Notter-AI-m3`, and `/do docs/superpowers/plans/2026-05-10-m4-import-export.md` in another pointed at `../Notter-AI-m4`.

### Why this is safe
- M3 is **almost entirely Rust** + a small Tauri-command bridge in TypeScript. The only TS surface area is `src/lib/mcp/index.ts`, `src/components/UserMenu.tsx` (one menu entry), `src/stores/auth-store.ts` (one extra `invoke` call), `src/lib/accounts/account-manager.ts` (already calls `secureSet` for `mcp_token` from M1 — only verifying behavior here, not modifying), and `src/i18n/locales/{en,pt-BR}.json` (new `mcp.*` keys).
- M4 is **entirely TypeScript** — markdown frontmatter parse/serialize, file pickers, `subject-versions-store.snapshotCurrent({ source: 'import' })` calls, and `PlannerTab` toolbar buttons.
- The Rust `src-tauri/Cargo.toml` is M3-only; `package.json` (adds `gray-matter`) is M4-only.

### Known potential merge points (resolve sequentially after both branches go green)
- `src/i18n/locales/en.json` + `pt-BR.json` — both branches add new keys (M3: `mcp.*`, M4: `import_export.*`). Different namespaces, so the diff hunks rarely collide. If they do, manual merge picks both blocks — nothing semantically conflicting.
- `src/components/UserMenu.tsx` — M3 adds one "MCP config" menu entry; M4 may add nothing here (Import/Export lives in `PlannerTab` toolbar). If M4 does touch `UserMenu` for any reason, accept both menu entries; order is cosmetic.
- `src/stores/auth-store.ts` — M3 adds an `invoke('mcp_update_account_token', ...)` call inside the existing `onAuthStateChange` block (or within `signInWithEmail` / `setSession` after-success branch). M4 does NOT touch `auth-store.ts`. No conflicts expected.
- `src/components/PlannerTab.tsx` — **M3 must NOT touch this file.** M4 owns it (adds Import/Export toolbar buttons). If you find yourself editing `PlannerTab.tsx` in M3, stop and re-route the change.
- `src/stores/subject-versions-store.ts` — **M3 must NOT touch this file.** Rust writes `subject_versions` rows via raw REST. M4 calls the existing `snapshotCurrent({ source: 'import' })` action; no conflicts.
- `package.json` / `package-lock.json` — M3 adds zero JS deps. M4 adds `gray-matter`. No conflicts on `dependencies` lines.
- `src-tauri/Cargo.toml` / `Cargo.lock` — M3 only.
- `src-tauri/src/lib.rs` — M3 modifies the `invoke_handler!` macro list (adds 2 commands) and adds `manage(McpState)` and `tokio::spawn` of the server. M4 does NOT touch this file.

### Suggested merge order
**M4 first (smaller surface, lower risk), M3 second.** Reasoning: M3 changes Rust + Cargo.lock + secure-store wiring; merging it on top of an already-landed M4 is straightforward (no Rust-side conflicts). Merging M4 on top of an already-landed M3 is also fine but slightly riskier if `auth-store.ts` rebases trigger spurious diffs. Either order works — pick M4 → M3 if you have the choice.

---

## File Structure

### New files (Rust)

- `src-tauri/src/mcp/mod.rs` — module entry. Re-exports public types and the `start_mcp_server(app: &AppHandle, state: Arc<McpState>) -> Result<(), String>` boot function called from `lib.rs::run`.
- `src-tauri/src/mcp/server.rs` — axum `Router` wiring; binds `127.0.0.1:0`; writes `endpoint.json`; runs the listener in `tokio::spawn`.
- `src-tauri/src/mcp/auth.rs` — `Bearer` extractor middleware; populates `request.extensions().insert(AuthContext { account_id })`.
- `src-tauri/src/mcp/tools.rs` — the 6 tool handlers. Each takes `&McpState`, `accountId`, and the parsed args; returns `serde_json::Value` or `McpError`.
- `src-tauri/src/mcp/supabase.rs` — `SupabaseClient` wrapper around `reqwest::Client`; methods `get` / `post` / `patch` with the standard headers `Authorization: Bearer <user_access_token>`, `apikey: <anon>`, `Content-Type: application/json`, `Prefer: return=representation` (for inserts).
- `src-tauri/src/mcp/endpoint.rs` — `EndpointFile { url, pid, nonce, started_at }` serde struct + `read_endpoint_file`, `write_endpoint_file`, `delete_endpoint_file`, `is_existing_endpoint_alive(file) -> bool` helpers.
- `src-tauri/src/mcp/types.rs` — JSON-RPC 2.0 envelope (`JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`); tool request param structs (`ListSubjectsParams`, `GetSubjectParams`, ...); tool result structs.
- `src-tauri/src/mcp/error.rs` — `McpError` enum + JSON-RPC error code mapping. Reserves the server-error range `-32000..=-32099` for Notter-specific codes (`auth_pending = -32001`, `unauthorized = -32002`, `not_found = -32003`, `supabase_error = -32004`, `bad_args = -32602` — standard Invalid Params).
- `src-tauri/src/mcp/__tests__/endpoint_test.rs` — unit tests for endpoint.json read/write + nonce check (in-tree `#[cfg(test)]` block, not a separate file in the strict sense — Rust convention).

### Modified Rust files

- `src-tauri/src/lib.rs`:
  - `mod mcp;` declaration after `mod secure_store;`.
  - In `run()`: build `McpState` (token map + access-token map + Supabase config); `manage` it on the Tauri app; spawn the server on a Tokio task during `setup()`; register `mcp_update_account_token` and `mcp_remove_account_token` in the `invoke_handler!` macro.
- `src-tauri/Cargo.toml`:
  - Add `axum = "0.8.9"` (latest stable as of 2026-05; no need to pull `hyper` directly — axum re-exports what we need).
  - Add `tower = "0.5"` (axum's transitive dep, but explicit because `tower::ServiceBuilder` is used in middleware composition).
  - Add `tower-http = { version = "0.6", features = ["trace", "cors"] }` (CORS only matters if a browser-based MCP client ever hits us; safe default).
  - Add `uuid = { version = "1", features = ["v4"] }`.
  - Add `rand = "0.9"`.
  - `reqwest`: extend the existing `features = ["json", "stream"]` to also include `"rustls-tls"` (avoids OpenSSL on Linux distros without it; matches Tauri's bundled-tls preference).
  - `tokio`: already `features = ["full"]` — no change needed.

### New files (TypeScript)

- `src/lib/mcp/index.ts` — front-end glue: `notifyMcpAccountTokenChanged(accountId, accessToken, expiresAt)` invokes `mcp_update_account_token`; `notifyMcpAccountRemoved(accountId)` invokes `mcp_remove_account_token`; `readMcpConfigForAccount(accountId)` reads the per-account config file for the "Copy MCP config" UI.
- `src/lib/mcp/__tests__/index.test.ts` — unit tests with mocked `@tauri-apps/api/core` `invoke`.
- `src/components/McpConfigDialog.tsx` — a small dialog rendered conditionally from `UserMenu`; shows the active account's MCP URL + bearer token + a "Copy JSON" button.

### Modified TS files

- `src/lib/accounts/account-manager.ts` — verify (do NOT modify the existing M1 logic) that `add()` already calls `secureSet(accountKeys.mcpToken(input.id), generateMcpToken())` (it does — verified at line 85 of the live file). Add a single line: after `secureSet(...)`, also push the new token to Rust by reading `accountKeys.mcpToken(...)` back and calling a new `notifyMcpAccountAdded(...)` — but this is OPTIONAL because Rust re-reads the secure store on next boot. Recommendation: skip the runtime-add-update in M3 (acceptable lag: until next app restart) and just rebuild the token map at server startup. Phase E shows the alternative.
- `src/stores/auth-store.ts` — inside the existing `supabase.auth.onAuthStateChange((event, session) => { ... })` block (currently lines 148–160), add an extra branch: on `'SIGNED_IN'` or `'TOKEN_REFRESHED'` or after `setSession()` succeeds in `initialize()`, `signInWithEmail`, `signUpWithEmail`, and `switchAccount` (lives in `account-manager.ts`), call `notifyMcpAccountTokenChanged(accountId, accessToken, expiresAt)`. Note: `src/lib/supabase.ts` already emits a Tauri event `mcp:account-token-refreshed` (line 47) — but that's a Tauri-event broadcast; the Rust handler for that event would need extra wiring. Simpler: call the Tauri command directly. The pre-existing `emit(...)` in `supabase.ts` becomes redundant once Phase I is done; leave it in (defensive — costs ~zero) but rely on the explicit `invoke` for the canonical path.
- `src/components/UserMenu.tsx` — add one menu entry "MCP config" (translated via `t('mcp.menu_label')`) gated behind `if (user)`; on click, opens `<McpConfigDialog>`.
- `src/i18n/locales/en.json` — new keys under `mcp.*`: `mcp.menu_label`, `mcp.dialog_title`, `mcp.dialog_description`, `mcp.url_label`, `mcp.token_label`, `mcp.copy_button`, `mcp.copied_toast`, `mcp.disabled_banner`, `mcp.disabled_reason`.
- `src/i18n/locales/pt-BR.json` — same keys translated.

### Deleted files

- None.

### Phase order

| # | Phase | Scope | Lands |
|---|---|---|---|
| A | Cargo deps + module skeleton | new `mcp/` dir, modules empty | first; compiles, no behavior |
| B | endpoint.json + nonce stale detection | `endpoint.rs` with unit tests | independent of axum |
| C | Token map + Tauri commands | `auth.rs` token map + `mcp_update/remove_account_token` | depends on A |
| D | axum lifecycle | bind 127.0.0.1:0, write `endpoint.json`, `/health` route | depends on A + B + C |
| E | Bearer auth middleware | extracts `accountId`, rejects 401 | depends on D |
| F | JSON-RPC envelope + dispatcher | `POST /mcp` decodes JSON-RPC, routes by `method` | depends on E |
| G | Supabase REST helper + `list_subjects` tool | smallest tool, validates the data path end-to-end | depends on F |
| H | Remaining 5 tools | `get_subject`, `list_versions`, `get_version`, `list_comments`, `post_subject_revision` | depends on G |
| I | Front-end glue — push tokens on auth events | `mcp/index.ts` + auth-store wiring | depends on C |
| J | "Copy MCP config" UI | `McpConfigDialog`, UserMenu entry, i18n | depends on I + D |
| K | Stable per-account config file | `<appLocalData>/notter-ai/mcp/<accountId>-config.json` written on boot | depends on D |
| L | End-to-end smoke (manual curl) | each tool exercised against a live account | last |

---

## Phase A — Cargo deps + module skeleton

This phase adds the dependencies and creates empty module files so the rest of the milestone can fill them without churn. End-of-phase: `cargo check` passes; nothing changes at runtime.

### Task A1: Add Cargo dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the new dependencies block**

Edit `src-tauri/Cargo.toml`. Replace the existing `[dependencies]` block (lines 20–35) with this — keep all existing entries, add the marked new lines:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
tauri-plugin-shell = "2"
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
portable-pty = "0.9"
reqwest = { version = "0.12", features = ["json", "stream", "rustls-tls"] }
tokio = { version = "1", features = ["full"] }
futures-util = "0.3"
keyring = "3"

# --- M3 (MCP server) ------------------------------------------------------
axum = "0.8.9"
tower = "0.5"
tower-http = { version = "0.6", features = ["trace", "cors"] }
uuid = { version = "1", features = ["v4"] }
rand = "0.9"
```

Pinning rationale: `axum 0.8.9` is the latest stable on crates.io (verified May 2026). The `0.8` series is API-stable since Dec 2024; pinning to a patch version avoids surprise breaking changes from a future minor bump that we wouldn't catch until the next dependency-audit pass. `tower 0.5` and `tower-http 0.6` are the matching versions in the axum 0.8 ecosystem. `uuid` v1 with `v4` only (we don't need `serde` integration — we serialize the `String` form, not the `Uuid` directly). `rand 0.9` is the post-`getrandom` 0.3 release; the minor bump from 0.8 doesn't affect our usage (`thread_rng().fill_bytes(...)`).

- [ ] **Step 2: Run `cargo check`**

```bash
cd src-tauri && cargo check
```

Expected: PASS. Cargo downloads the new crates; no compile errors because we haven't written any code yet that uses them. `cargo.lock` updates.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "$(cat <<'EOF'
chore(deps): add axum 0.8.9 + tower + tower-http + uuid + rand for M3 MCP server

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task A2: Create the empty `mcp/` module skeleton

**Files:**
- Create: `src-tauri/src/mcp/mod.rs`
- Create: `src-tauri/src/mcp/server.rs`
- Create: `src-tauri/src/mcp/auth.rs`
- Create: `src-tauri/src/mcp/tools.rs`
- Create: `src-tauri/src/mcp/supabase.rs`
- Create: `src-tauri/src/mcp/endpoint.rs`
- Create: `src-tauri/src/mcp/types.rs`
- Create: `src-tauri/src/mcp/error.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod mcp;` declaration.

- [ ] **Step 1: Create `mcp/mod.rs`**

```rust
// src-tauri/src/mcp/mod.rs
//
// Persistent MCP HTTP server (Phase 1 / M3 of the pivot). Boots as a Tokio
// task alongside Tauri main thread, binds 127.0.0.1:<dynamic>, exposes 6
// JSON-RPC 2.0 tools over MCP Streamable HTTP transport (single POST /mcp
// endpoint). Per-account Bearer auth; Supabase REST via reqwest using the
// front-end's rotating access token (front-end is sole refresh owner).
//
// See docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md §6.
pub mod auth;
pub mod endpoint;
pub mod error;
pub mod server;
pub mod supabase;
pub mod tools;
pub mod types;

pub use error::McpError;
pub use server::{start_mcp_server, McpState, McpStateInner};
pub use types::{JsonRpcRequest, JsonRpcResponse};
```

- [ ] **Step 2: Create the seven empty module files**

Each file contains only a doc-comment and any unconditional imports the rest of the milestone will fill. This is a no-op for Phase A; Phases B–H replace each body.

```rust
// src-tauri/src/mcp/server.rs
// axum Router wiring + lifecycle. Filled in Phase D.
//
// The public `start_mcp_server(app: &AppHandle, state: Arc<McpState>)` boot
// function is called from src-tauri/src/lib.rs::run during Tauri setup.
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::RwLock;

/// Inner state guarded by RwLock. Filled in Phase C.
pub struct McpStateInner {
    /// token (e.g. "notter_acc_xxxx") -> account id
    pub token_to_account: HashMap<String, String>,
    /// account id -> (access_token, expires_at_unix_seconds)
    pub access_tokens: HashMap<String, (String, i64)>,
    /// public URL ("http://127.0.0.1:54781/mcp") set after bind succeeds
    pub url: Option<String>,
    /// nonce written to endpoint.json + checked on subsequent boots
    pub nonce: String,
    /// supabase configuration (from Tauri config / env)
    pub supabase_url: String,
    pub supabase_anon_key: String,
}

pub type McpState = Arc<RwLock<McpStateInner>>;

/// Stub — Phase D fills this in.
pub async fn start_mcp_server(
    _app: &tauri::AppHandle,
    _state: McpState,
) -> Result<(), String> {
    Ok(())
}
```

```rust
// src-tauri/src/mcp/auth.rs
// Bearer-token middleware + token map mutators. Filled in Phase C + E.
```

```rust
// src-tauri/src/mcp/tools.rs
// 6 MCP tools backed by Supabase REST. Filled in Phase G + H.
```

```rust
// src-tauri/src/mcp/supabase.rs
// reqwest-based Supabase REST wrapper. Filled in Phase G.
```

```rust
// src-tauri/src/mcp/endpoint.rs
// endpoint.json read/write + nonce-based stale detection. Filled in Phase B.
```

```rust
// src-tauri/src/mcp/types.rs
// JSON-RPC 2.0 envelope + tool argument/result types. Filled in Phase F + G.
```

```rust
// src-tauri/src/mcp/error.rs
// MCP error enum + JSON-RPC error code mapping. Filled in Phase F.
```

- [ ] **Step 3: Wire `mod mcp;` into `lib.rs`**

Edit `src-tauri/src/lib.rs:1-3`:

```rust
mod ollama_install;
mod secure_store;
mod mcp;   // NEW — M3
```

- [ ] **Step 4: `cargo check`**

```bash
cd src-tauri && cargo check
```

Expected: PASS. The unused-import warning on `Arc` / `HashMap` / `RwLock` is acceptable for now; phases B+ consume them.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/mcp/
git commit -m "$(cat <<'EOF'
feat(mcp): add empty mcp/ module skeleton (Phase A)

Carves out the eight Rust modules that M3 will fill. No runtime behavior
yet; cargo check passes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — `endpoint.json` read/write + nonce stale detection

This phase implements the endpoint discovery file (per spec §6.1) and the nonce-based stale-detection path (per observation 67 from 2026-05-09). It is independent of axum and runs entirely on plain `tokio::fs` + `serde_json` + `reqwest`. Unit-tested via `#[cfg(test)]`.

### Task B1: Implement `endpoint.rs` with TDD

**Files:**
- Modify: `src-tauri/src/mcp/endpoint.rs`

- [ ] **Step 1: Write the failing tests first**

```rust
// src-tauri/src/mcp/endpoint.rs
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// On-disk shape of `<appLocalData>/notter-ai/mcp/endpoint.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EndpointFile {
    pub url: String,        // e.g. "http://127.0.0.1:54781/mcp"
    pub pid: u32,
    pub nonce: String,      // 16 random bytes hex
    pub started_at: String, // RFC 3339 timestamp
}

/// 16 random bytes -> 32-char lowercase hex.
pub fn generate_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Returns the path `<dir>/endpoint.json`. The caller resolves `dir` via
/// Tauri's `app_local_data_dir() + "notter-ai/mcp"`; we keep the function
/// pure for testability.
pub fn endpoint_path(dir: &Path) -> PathBuf {
    dir.join("endpoint.json")
}

pub async fn write_endpoint_file(
    dir: &Path,
    file: &EndpointFile,
) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("create_dir_all: {e}"))?;
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("serde: {e}"))?;
    tokio::fs::write(endpoint_path(dir), json)
        .await
        .map_err(|e| format!("write: {e}"))
}

pub async fn read_endpoint_file(dir: &Path) -> Result<Option<EndpointFile>, String> {
    let path = endpoint_path(dir);
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => match serde_json::from_str::<EndpointFile>(&s) {
            Ok(f) => Ok(Some(f)),
            Err(e) => {
                // Corrupt file — treat as absent. The boot path will overwrite.
                eprintln!("[mcp] endpoint.json malformed: {e}; treating as stale");
                Ok(None)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read: {e}")),
    }
}

pub async fn delete_endpoint_file(dir: &Path) -> Result<(), String> {
    let path = endpoint_path(dir);
    match tokio::fs::remove_file(&path).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove: {e}")),
    }
}

/// Probe an existing `endpoint.json` to decide whether ANOTHER instance
/// of Notter is currently bound on that URL.
///
/// Returns `Ok(true)`  -> ANOTHER instance is alive on that port; we should abort.
/// Returns `Ok(false)` -> file is stale; safe to delete + bind anew.
/// Returns `Err(_)`    -> network/IO error; treat as stale (safer than blocking
///                        a fresh boot; on the fence we bias toward "boot the
///                        app" because port 0 will assign a fresh free port if
///                        the old one is taken).
///
/// The probe path is `GET <url> with the host swapped from "/mcp" -> "/health"`,
/// passing `X-Notter-Nonce: <file's nonce>`. The /health route compares the
/// header against its in-memory nonce and returns 200 only on match.
pub async fn is_existing_endpoint_alive(file: &EndpointFile) -> Result<bool, String> {
    // Derive health URL from file.url. The recorded URL ends in /mcp;
    // we replace that suffix with /health.
    let health_url = if let Some(stripped) = file.url.strip_suffix("/mcp") {
        format!("{stripped}/health")
    } else {
        // Defensive: URL does not match the expected shape; treat as stale.
        return Ok(false);
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    match client
        .get(&health_url)
        .header("X-Notter-Nonce", &file.nonce)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => Ok(true),
        Ok(_) => Ok(false), // 401/403/etc → nonce mismatched → stale
        Err(_) => Ok(false), // connection refused / timeout → stale
    }
}

pub fn now_rfc3339() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // chrono is not a dep — hand-format. The /health route ignores this anyway;
    // it's purely informational.
    format!("{}", iso8601(now.as_secs()))
}

/// Minimal RFC 3339 (UTC, no fractional seconds). Good enough for an
/// informational `started_at`.
fn iso8601(unix_seconds: u64) -> String {
    // Janky but dep-free. If chrono ever lands as a Tauri/Cargo dep,
    // replace with chrono::Utc::now().to_rfc3339().
    let days = unix_seconds / 86400;
    let secs_today = unix_seconds % 86400;
    let h = secs_today / 3600;
    let m = (secs_today % 3600) / 60;
    let s = secs_today % 60;
    let (y, mo, d) = days_to_ymd(days as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
}

fn days_to_ymd(days_since_epoch: i64) -> (i64, u32, u32) {
    // Algorithm from Howard Hinnant's chrono lib (public domain).
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let tmp = tempdir();
        let f = EndpointFile {
            url: "http://127.0.0.1:12345/mcp".into(),
            pid: 4242,
            nonce: "deadbeefcafebabe0011223344556677".into(),
            started_at: "2026-05-10T17:00:00Z".into(),
        };
        write_endpoint_file(&tmp, &f).await.unwrap();
        let read = read_endpoint_file(&tmp).await.unwrap().unwrap();
        assert_eq!(read, f);
    }

    #[tokio::test]
    async fn read_returns_none_when_missing() {
        let tmp = tempdir();
        assert!(read_endpoint_file(&tmp).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let tmp = tempdir();
        delete_endpoint_file(&tmp).await.unwrap(); // no-op when missing
        let f = EndpointFile {
            url: "http://127.0.0.1:1/mcp".into(),
            pid: 1, nonce: "x".into(), started_at: "x".into(),
        };
        write_endpoint_file(&tmp, &f).await.unwrap();
        delete_endpoint_file(&tmp).await.unwrap();
        assert!(read_endpoint_file(&tmp).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn corrupt_endpoint_json_is_treated_as_absent() {
        let tmp = tempdir();
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        tokio::fs::write(endpoint_path(&tmp), b"not json").await.unwrap();
        assert!(read_endpoint_file(&tmp).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn probe_returns_false_when_no_server_listening() {
        let f = EndpointFile {
            url: "http://127.0.0.1:1/mcp".into(), // port 1 → connection refused
            pid: 1, nonce: "x".into(), started_at: "x".into(),
        };
        // Either Ok(false) or some I/O error path that maps to stale.
        let alive = is_existing_endpoint_alive(&f).await.unwrap();
        assert!(!alive);
    }

    #[test]
    fn nonce_is_32_hex_chars() {
        let n = generate_nonce();
        assert_eq!(n.len(), 32);
        assert!(n.chars().all(|c| c.is_ascii_hexdigit()));
    }

    fn tempdir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "notter-mcp-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        p
    }
}
```

- [ ] **Step 2: `cargo test --package agenttrack -p agenttrack -- mcp::endpoint`**

Or simpler: `cargo test mcp::endpoint`. All 6 tests should pass.

Expected: 6 PASS. The `is_existing_endpoint_alive` probe test relies on `127.0.0.1:1` being closed (it is on every machine I've ever seen).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp/endpoint.rs
git commit -m "$(cat <<'EOF'
feat(mcp): endpoint.json read/write + nonce stale detection (Phase B)

Implements EndpointFile { url, pid, nonce, started_at } persistence and
the nonce-based health probe that replaces PID liveness for stale-file
detection on next boot. Covered by 6 unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Token map + Tauri commands

This phase fills `mcp/auth.rs` with the in-memory token maps and the two Tauri commands the front-end uses to push access tokens. The map population is split: stable per-account `mcp_token` is read from secure store at boot (Phase D); rotating `access_token` is pushed via `mcp_update_account_token` (this phase).

### Task C1: Implement the token-map types in `auth.rs`

**Files:**
- Modify: `src-tauri/src/mcp/auth.rs`

- [ ] **Step 1: Write the auth.rs module**

```rust
// src-tauri/src/mcp/auth.rs
//
// In-memory token maps + the Tauri commands that the front-end calls on every
// auth-state change to keep the access-token slice fresh.

use crate::mcp::server::{McpState, McpStateInner};
use serde::{Deserialize, Serialize};

/// Per-request authentication context inserted into axum's request extensions
/// by the Bearer-auth middleware.
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub account_id: String,
}

#[derive(Serialize, Deserialize)]
pub struct UpdateAccountTokenArgs {
    pub account_id: String,
    pub access_token: String,
    pub expires_at: i64, // unix seconds
}

/// Tauri command — front-end calls on every Supabase TOKEN_REFRESHED / SIGNED_IN.
#[tauri::command]
pub async fn mcp_update_account_token(
    args: UpdateAccountTokenArgs,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens
        .insert(args.account_id, (args.access_token, args.expires_at));
    Ok(())
}

/// Tauri command — front-end calls when an account is removed from
/// AccountManager. Drops both the bearer-token entry and the access-token
/// slice. The bearer-token entry is rebuilt at next boot from the secure
/// store, so this is mostly defensive (it prevents the removed account
/// from being usable until restart, which would otherwise be a security
/// hole if the secure store delete itself raced with this command).
#[tauri::command]
pub async fn mcp_remove_account_token(
    account_id: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens.remove(&account_id);
    // Drop any bearer token that maps to this account.
    s.token_to_account
        .retain(|_, owner| owner != &account_id);
    Ok(())
}

/// Resolve a Bearer token to an account id by reading the in-memory map.
/// Returns None on miss (the middleware turns that into 401).
pub async fn lookup_account_for_token(
    state: &McpState,
    bearer: &str,
) -> Option<String> {
    let s = state.read().await;
    s.token_to_account.get(bearer).cloned()
}

/// Return the current access-token for an account, plus its expiry.
/// Returns None if absent OR expired (caller maps to `auth_pending` JSON-RPC error).
pub async fn current_access_token(
    state: &McpState,
    account_id: &str,
) -> Option<String> {
    let s = state.read().await;
    let (tok, expires_at) = s.access_tokens.get(account_id)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Treat tokens within 30 s of expiry as expired so we don't race the
    // front-end's autoRefresh.
    if *expires_at - 30 < now {
        return None;
    }
    Some(tok.clone())
}
```

- [ ] **Step 2: `cargo check`**

Expected: PASS. The `lookup_account_for_token` and `current_access_token` are unused for now; allow the `dead_code` warning until Phase E + G consume them.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp/auth.rs
git commit -m "$(cat <<'EOF'
feat(mcp): token map + mcp_update/remove_account_token Tauri commands (Phase C)

Adds the in-memory access-token slice and the two front-end-facing Tauri
commands. Bearer-token lookup helper added but not yet consumed (Phase E).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C2: Wire the Tauri commands into `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Build initial McpState and register the commands**

Edit `src-tauri/src/lib.rs`. Inside the `run()` function, BEFORE `.invoke_handler(...)`:

```rust
// Build the MCP server state. Token maps are initially empty; Phase D's
// boot routine repopulates from the secure store, and the front-end pushes
// access tokens via mcp_update_account_token.
let supabase_url = std::env::var("VITE_SUPABASE_URL").unwrap_or_default();
let supabase_anon_key = std::env::var("VITE_SUPABASE_ANON_KEY").unwrap_or_default();
let mcp_state: mcp::McpState = std::sync::Arc::new(tokio::sync::RwLock::new(
    mcp::McpStateInner {
        token_to_account: std::collections::HashMap::new(),
        access_tokens: std::collections::HashMap::new(),
        url: None,
        nonce: mcp::endpoint::generate_nonce(),
        supabase_url,
        supabase_anon_key,
    },
));
```

Note on Supabase config: Vite's `import.meta.env.VITE_*` is bundled at build-time into the front-end JS, NOT exposed to Rust. To make Rust read the same values, the `tauri dev` and `tauri build` invocations must export them as process env vars before launch. Two options for the implementer to consider:

(a) **Recommended — Tauri config plugin.** Read from `tauri.conf.json` via a custom `[plugins.notter]` block. Cleaner.
(b) **Pragmatic stopgap (this phase).** Read from `std::env` and document that the user runs `npm run tauri dev` from a shell where `VITE_SUPABASE_URL` is exported (the `.env` file at repo root already loads via Vite; mirror it via shell before launch). The Tauri-app `.env` plugin is overkill for one-time read-once config.

Phase D will revisit this if option (b) is too brittle. For Phase C, just read `std::env`.

Then, in the `manage(...)` chain inside `run()`:

```rust
.manage(mcp_state.clone())
```

And inside `invoke_handler!`:

```rust
.invoke_handler(tauri::generate_handler![
    create_pty,
    write_pty,
    resize_pty,
    close_pty,
    llm_request,
    ollama_install::ollama_check_running,
    ollama_install::ollama_check_installed,
    ollama_install::ollama_download_installer,
    ollama_install::ollama_run_installer,
    ollama_install::ollama_start_service,
    secure_store::secure_set,
    secure_store::secure_get,
    secure_store::secure_delete,
    secure_store::secure_register_known_keys,
    mcp::auth::mcp_update_account_token,   // M3
    mcp::auth::mcp_remove_account_token,   // M3
])
```

- [ ] **Step 2: `cargo check && cargo build`**

Expected: PASS.

- [ ] **Step 3: Manual smoke**

Start the app: `npm run tauri dev`. From DevTools console:

```js
await window.__TAURI__.core.invoke('mcp_update_account_token', {
  args: { accountId: 'test', accessToken: 'abc', expiresAt: 9999999999 }
});
```

Expected: returns `null` (Ok). Repeat with `mcp_remove_account_token`. No errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(mcp): wire McpState + token Tauri commands into Tauri builder (Phase C)

McpState created at startup; mcp_update_account_token and
mcp_remove_account_token registered in invoke_handler. Manual DevTools
smoke confirms the bridge works.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase D — axum lifecycle (bind, health endpoint, write `endpoint.json`)

This phase implements the boot sequence: read existing `endpoint.json`; nonce-probe to decide stale-vs-alive; bind `127.0.0.1:0`; write the new `endpoint.json`; spawn the listener with a single `/health` route.

### Task D1: Implement `start_mcp_server` in `mcp/server.rs`

**Files:**
- Modify: `src-tauri/src/mcp/server.rs`

- [ ] **Step 1: Replace the stub with the real boot**

```rust
// src-tauri/src/mcp/server.rs
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    routing::get,
    Router,
};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::mcp::endpoint::{
    delete_endpoint_file, generate_nonce, is_existing_endpoint_alive, now_rfc3339,
    read_endpoint_file, write_endpoint_file, EndpointFile,
};

#[derive(Clone)]
pub struct McpStateInner {
    pub token_to_account: HashMap<String, String>,
    pub access_tokens: HashMap<String, (String, i64)>,
    pub url: Option<String>,
    pub nonce: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
}

pub type McpState = Arc<RwLock<McpStateInner>>;

const MAX_BIND_RETRIES: u32 = 3;

/// Returns `<appLocalData>/notter-ai/mcp` for the current app handle.
fn mcp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    Ok(base.join("notter-ai").join("mcp"))
}

pub async fn start_mcp_server(app: &AppHandle, state: McpState) -> Result<(), String> {
    let dir = mcp_dir(app)?;

    // 1. Stale detection.
    if let Some(existing) = read_endpoint_file(&dir).await? {
        match is_existing_endpoint_alive(&existing).await {
            Ok(true) => {
                return Err(format!(
                    "another Notter instance appears to be running on {}",
                    existing.url
                ));
            }
            _ => {
                // Stale — clean up.
                delete_endpoint_file(&dir).await?;
            }
        }
    }

    // 2. Repopulate token_to_account from secure store. Done elsewhere
    // (the front-end calls notifyMcpAccountAdded for each known account
    // during AccountManager.bootstrap) — but as a defense, we also try
    // to read directly from the keyring here. See repopulate_bearer_tokens.
    repopulate_bearer_tokens(&state).await;

    // 3. Bind 127.0.0.1:0 with retries.
    let listener = bind_with_retries().await?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;

    let url = format!("http://{}/mcp", addr);

    // 4. Write endpoint.json.
    let nonce = {
        let s = state.read().await;
        s.nonce.clone()
    };
    let endpoint_file = EndpointFile {
        url: url.clone(),
        pid: std::process::id(),
        nonce: nonce.clone(),
        started_at: now_rfc3339(),
    };
    write_endpoint_file(&dir, &endpoint_file).await?;

    // 5. Stash url back into state.
    {
        let mut s = state.write().await;
        s.url = Some(url.clone());
    }

    eprintln!("[mcp] listening on {url}");

    // 6. Build the axum router. Phase E + F add /mcp; this phase only adds /health.
    let app_router = Router::new()
        .route("/health", get(health))
        .with_state(state.clone());

    // 7. Spawn the server in the background.
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app_router).await {
            eprintln!("[mcp] server crashed: {e}");
        }
    });

    Ok(())
}

async fn bind_with_retries() -> Result<TcpListener, String> {
    let mut last_err = String::new();
    for attempt in 1..=MAX_BIND_RETRIES {
        match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => return Ok(l),
            Err(e) => {
                last_err = format!("attempt {attempt}/{MAX_BIND_RETRIES}: {e}");
                eprintln!("[mcp] bind failed — {last_err}");
                tokio::time::sleep(std::time::Duration::from_millis(100 * attempt as u64)).await;
            }
        }
    }
    Err(format!(
        "MCP server failed to bind after {MAX_BIND_RETRIES} retries: {last_err}"
    ))
}

/// Read every secure-store key matching `notter:account:<id>:mcp_token` and
/// populate the bearer-token map. Falls through silently on any error — the
/// front-end will repopulate via mcp_update_account_token + mcp_register on
/// the next auth event.
///
/// NOTE: at the time this runs, the keyring entries exist (M1 wrote them)
/// but the Rust SecureStoreState's known_keys index is empty (it is repopulated
/// by the front-end's `secure_register_known_keys` call during
/// AccountManager.bootstrap). To avoid a chicken-and-egg, this function
/// reads the index.json directly from disk to enumerate accounts, then
/// reads each account's mcp_token via the keyring.
async fn repopulate_bearer_tokens(state: &McpState) {
    let _ = state; // populated by the front-end on add; safe to leave empty
    // Future: we could read accounts/index.json here and pull each
    // account's mcp_token via keyring::Entry. For Phase D the front-end
    // does it via a dedicated `notifyMcpAccountAdded` Tauri command (added
    // in Phase I); leaving as a no-op keeps Phase D dependency-free.
}

async fn health(
    headers: HeaderMap,
    AxumState(state): AxumState<McpState>,
) -> (StatusCode, &'static str) {
    let provided = headers.get("X-Notter-Nonce").and_then(|h| h.to_str().ok());
    let expected = state.read().await.nonce.clone();
    match provided {
        Some(p) if p == expected => (StatusCode::OK, "ok"),
        _ => (StatusCode::UNAUTHORIZED, "nonce mismatch"),
    }
}

// Free helper — returns a fresh nonce. Pulled out so server.rs can re-export
// for endpoint.rs's tests without making them depend on rand directly.
pub fn fresh_nonce() -> String {
    generate_nonce()
}
```

- [ ] **Step 2: Wire the boot into `lib.rs`'s `setup` callback**

Edit `src-tauri/src/lib.rs`. Where the Tauri builder is constructed in `run()`, add a `.setup(...)` block BEFORE `.invoke_handler(...)`:

```rust
.setup(|app| {
    let handle = app.handle().clone();
    let state: mcp::McpState = handle.state::<mcp::McpState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = mcp::start_mcp_server(&handle, state).await {
            eprintln!("[mcp] server failed to start: {e}");
            // The app keeps running; the UI surfaces the disabled state via
            // the absence of endpoint.json (Phase J detects this).
        }
    });
    Ok(())
})
```

- [ ] **Step 3: `cargo build && npm run tauri dev`**

Expected: app boots; the terminal prints `[mcp] listening on http://127.0.0.1:<port>/mcp`. The file `<appLocalData>/notter-ai/mcp/endpoint.json` exists and contains the expected JSON shape.

- [ ] **Step 4: Verify the health probe**

In a separate shell:

```bash
# read URL + nonce from endpoint.json then:
curl -i -H "X-Notter-Nonce: <nonce>" http://127.0.0.1:<port>/health
# Expected: 200 OK / "ok"

curl -i -H "X-Notter-Nonce: wrong" http://127.0.0.1:<port>/health
# Expected: 401 / "nonce mismatch"
```

- [ ] **Step 5: Verify stale-detection on next launch**

Stop the app. Confirm `endpoint.json` was deleted (Tauri's close-requested handler will be wired in Phase L; for now the file is left behind on graceful exit, which lets us test the next-boot stale path). Restart the app. The boot path detects the file, probes the dead URL, sees connection-refused, deletes the file, binds anew. Verify a fresh URL is logged.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mcp/server.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(mcp): axum lifecycle — bind 127.0.0.1:0, /health, endpoint.json (Phase D)

Server boots in tokio task during Tauri setup. Nonce-based stale-file
detection runs first; bind retries 3x; endpoint.json written with URL +
PID + nonce + started_at. /health route returns 200 only when
X-Notter-Nonce matches in-memory nonce.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task D2: Wire `tauri://close-requested` to delete `endpoint.json`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add a window event handler**

In `run()`, after `.setup(...)`:

```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
        let app = window.app_handle().clone();
        // Best-effort sync delete; if it fails the next boot's stale
        // detection will clean it up.
        if let Ok(base) = app.path().app_local_data_dir() {
            let p = base.join("notter-ai").join("mcp").join("endpoint.json");
            let _ = std::fs::remove_file(p);
        }
    }
})
```

- [ ] **Step 2: Smoke test**

Start the app, observe `endpoint.json` exists. Close the window normally (X button). Confirm the file is gone.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(mcp): delete endpoint.json on window close (Phase D)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase E — Bearer auth middleware

This phase adds the middleware layer that extracts the `Authorization: Bearer ...` header on every `/mcp` request, resolves it to an `accountId` via the in-memory map, and rejects with 401 if missing or unknown. The `/health` route stays unauthenticated (it has its own nonce check).

### Task E1: Implement the Bearer-auth middleware

**Files:**
- Modify: `src-tauri/src/mcp/auth.rs`

- [ ] **Step 1: Add the middleware function**

Append to `src-tauri/src/mcp/auth.rs`:

```rust
use axum::{
    extract::{Request, State as AxumState},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

/// Bearer-auth middleware. Rejects with 401 + JSON-RPC unauthorized error if
/// the Authorization header is absent, malformed, or carries an unknown token.
/// On success, stores AuthContext in the request extensions for handlers to read.
pub async fn bearer_auth(
    AxumState(state): AxumState<crate::mcp::server::McpState>,
    mut req: Request,
    next: Next,
) -> Response {
    let bearer = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));

    let Some(token) = bearer else {
        return unauthorized_response("missing or malformed Authorization header");
    };

    let account_id = match lookup_account_for_token(&state, token).await {
        Some(a) => a,
        None => return unauthorized_response("unknown token"),
    };

    req.extensions_mut().insert(AuthContext { account_id });
    next.run(req).await
}

fn unauthorized_response(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": -32002,
                "message": format!("unauthorized: {msg}"),
            }
        })),
    )
        .into_response()
}
```

- [ ] **Step 2: Apply the middleware to the `/mcp` route in `server.rs`**

We will register the actual `/mcp` route in Phase F. For now, add a placeholder handler so the wiring is testable:

In `src-tauri/src/mcp/server.rs`, replace the `Router::new()` block:

```rust
use crate::mcp::auth::{bearer_auth, AuthContext};
use axum::{Extension, middleware, routing::post, Json};
use serde_json::Value as JsonValue;

let app_router = Router::new()
    .route("/mcp", post(mcp_placeholder))
    .route_layer(middleware::from_fn_with_state(state.clone(), bearer_auth))
    .route("/health", get(health))
    .with_state(state.clone());
```

And the placeholder handler:

```rust
async fn mcp_placeholder(
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<JsonValue>,
) -> Json<JsonValue> {
    Json(serde_json::json!({
        "jsonrpc": "2.0",
        "id": body.get("id").cloned().unwrap_or(JsonValue::Null),
        "result": {
            "echo": body,
            "account_id": auth.account_id,
            "note": "phase E placeholder — full dispatch lands in Phase F",
        }
    }))
}
```

- [ ] **Step 3: Manual smoke**

Add a test bearer token to the map via DevTools (in the running app):

```js
// First, register a known account+token pair via mcp_update_account_token.
// We don't have a "register bearer" command yet (added in Phase I); for a
// quick smoke, edit auth.rs's `repopulate_bearer_tokens` to insert a
// hard-coded ("test_token", "test_account") pair, then revert before commit.
```

Then in a separate shell:

```bash
curl -i -X POST http://127.0.0.1:<port>/mcp \
  -H "Authorization: Bearer test_token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}'
# Expected: 200 with echo + account_id "test_account"

curl -i -X POST http://127.0.0.1:<port>/mcp -d '{"jsonrpc":"2.0"}'
# Expected: 401 "unauthorized: missing or malformed Authorization header"

curl -i -X POST http://127.0.0.1:<port>/mcp \
  -H "Authorization: Bearer wrong_token" \
  -d '{"jsonrpc":"2.0"}'
# Expected: 401 "unauthorized: unknown token"
```

Revert the smoke-test hard-coded entry before committing.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/auth.rs src-tauri/src/mcp/server.rs
git commit -m "$(cat <<'EOF'
feat(mcp): Bearer-auth middleware (Phase E)

Authorization: Bearer <token> resolved to accountId via in-memory map;
401 on miss with JSON-RPC error envelope. Verified with curl.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase F — JSON-RPC envelope + tool dispatcher

This phase replaces the placeholder handler with a real JSON-RPC 2.0 dispatcher. Each tool name maps to a handler in `tools.rs`. Phase G adds the first real tool; this phase only stubs them with `method_not_found` errors to validate the dispatch shell.

### Task F1: JSON-RPC envelope types in `mcp/types.rs`

**Files:**
- Modify: `src-tauri/src/mcp/types.rs`

- [ ] **Step 1: Add the envelope types**

```rust
// src-tauri/src/mcp/types.rs
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)]
    pub jsonrpc: String,
    pub id: Option<Value>, // null | number | string per JSON-RPC 2.0
    pub method: String,
    #[serde(default)]
    pub params: Value, // can be object, array, or null
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str, // "2.0"
    pub id: Value,
    #[serde(flatten)]
    pub payload: JsonRpcPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum JsonRpcPayload {
    Result { result: Value },
    Error { error: JsonRpcErrorObject },
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    pub fn ok(id: Option<Value>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id: id.unwrap_or(Value::Null),
            payload: JsonRpcPayload::Result { result },
        }
    }
    pub fn err(id: Option<Value>, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0",
            id: id.unwrap_or(Value::Null),
            payload: JsonRpcPayload::Error {
                error: JsonRpcErrorObject {
                    code,
                    message,
                    data: None,
                },
            },
        }
    }
}
```

### Task F2: Error enum in `mcp/error.rs`

**Files:**
- Modify: `src-tauri/src/mcp/error.rs`

- [ ] **Step 1: Add the error type + code mapping**

```rust
// src-tauri/src/mcp/error.rs
use thiserror::Error;

// We don't currently have `thiserror` in Cargo.toml. To avoid bloating deps,
// hand-roll the Error impl instead.

#[derive(Debug)]
pub enum McpError {
    /// JSON-RPC -32700: parse error.
    ParseError(String),
    /// -32600: invalid request shape.
    InvalidRequest(String),
    /// -32601: method not found.
    MethodNotFound(String),
    /// -32602: invalid params.
    InvalidParams(String),
    /// -32603: internal error.
    InternalError(String),
    /// -32001 (Notter-specific): the front-end has not yet pushed a fresh
    /// access token (or the latest one is expired). The CLI is expected
    /// to retry once with a small backoff.
    AuthPending,
    /// -32002 (Notter-specific): unauthorized — bearer token absent / unknown.
    /// Normally caught by middleware; included for tool-level rejection too.
    Unauthorized(String),
    /// -32003 (Notter-specific): not found.
    NotFound(String),
    /// -32004 (Notter-specific): Supabase REST returned an error.
    SupabaseError(String),
}

impl McpError {
    pub fn code(&self) -> i32 {
        use McpError::*;
        match self {
            ParseError(_)        => -32700,
            InvalidRequest(_)    => -32600,
            MethodNotFound(_)    => -32601,
            InvalidParams(_)     => -32602,
            InternalError(_)     => -32603,
            AuthPending          => -32001,
            Unauthorized(_)      => -32002,
            NotFound(_)          => -32003,
            SupabaseError(_)     => -32004,
        }
    }
    pub fn message(&self) -> String {
        use McpError::*;
        match self {
            ParseError(m) | InvalidRequest(m) | MethodNotFound(m)
            | InvalidParams(m) | InternalError(m)
            | Unauthorized(m) | NotFound(m) | SupabaseError(m) => m.clone(),
            AuthPending => {
                "auth_pending: front-end has not yet refreshed the access token; retry once".into()
            }
        }
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code(), self.message())
    }
}

impl std::error::Error for McpError {}

#[allow(unused_imports)]
use thiserror as _; // suppress the import — we don't actually need it.
```

Drop the `use thiserror::Error;` line at the top — we are not adding `thiserror` as a dep. Hand-rolled error is simpler.

- [ ] **Step 2: `cargo check`**

Expected: PASS.

### Task F3: JSON-RPC dispatcher in `tools.rs` + handler wire-up

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`
- Modify: `src-tauri/src/mcp/server.rs`

- [ ] **Step 1: Add the dispatcher in `tools.rs`**

```rust
// src-tauri/src/mcp/tools.rs
use serde_json::Value;

use crate::mcp::auth::AuthContext;
use crate::mcp::error::McpError;
use crate::mcp::server::McpState;

/// Top-level tool dispatch. Each method name routes to a handler.
/// Phase G + H fill in the real implementations.
pub async fn dispatch(
    method: &str,
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    match method {
        "list_subjects"         => list_subjects(params, auth, state).await,
        "get_subject"           => get_subject(params, auth, state).await,
        "list_versions"         => list_versions(params, auth, state).await,
        "get_version"           => get_version(params, auth, state).await,
        "list_comments"         => list_comments(params, auth, state).await,
        "post_subject_revision" => post_subject_revision(params, auth, state).await,
        // MCP "ping" is sometimes used by clients as a liveness check;
        // accept it as an empty-result success.
        "ping"                  => Ok(Value::Object(Default::default())),
        other => Err(McpError::MethodNotFound(format!("method '{other}' not found"))),
    }
}

// ── stubs (filled in Phase G + H) ────────────────────────────────────────

async fn list_subjects(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError("list_subjects: not yet implemented (Phase G)".into()))
}
async fn get_subject(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError("get_subject: not yet implemented (Phase H)".into()))
}
async fn list_versions(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError("list_versions: not yet implemented (Phase H)".into()))
}
async fn get_version(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError("get_version: not yet implemented (Phase H)".into()))
}
async fn list_comments(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError("list_comments: not yet implemented (Phase H)".into()))
}
async fn post_subject_revision(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError("post_subject_revision: not yet implemented (Phase H)".into()))
}
```

- [ ] **Step 2: Replace `mcp_placeholder` in `server.rs` with the real dispatcher**

In `src-tauri/src/mcp/server.rs`, replace `mcp_placeholder` and its route:

```rust
use crate::mcp::types::JsonRpcResponse;
use crate::mcp::tools::dispatch;
use serde_json::Value as JsonValue;

let app_router = Router::new()
    .route("/mcp", post(mcp_handler))
    .route_layer(middleware::from_fn_with_state(state.clone(), bearer_auth))
    .route("/health", get(health))
    .with_state(state.clone());
```

```rust
async fn mcp_handler(
    AxumState(state): AxumState<McpState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<serde_json::Value>,
) -> Json<JsonRpcResponse> {
    // Decode envelope.
    let req: crate::mcp::types::JsonRpcRequest = match serde_json::from_value(body.clone()) {
        Ok(r) => r,
        Err(e) => {
            return Json(JsonRpcResponse::err(
                body.get("id").cloned(),
                -32600,
                format!("invalid_request: {e}"),
            ));
        }
    };

    if req.jsonrpc != "2.0" {
        return Json(JsonRpcResponse::err(
            req.id,
            -32600,
            "invalid_request: jsonrpc must be '2.0'".into(),
        ));
    }

    let id = req.id.clone();
    match dispatch(&req.method, &req.params, &auth, &state).await {
        Ok(result) => Json(JsonRpcResponse::ok(id, result)),
        Err(e) => Json(JsonRpcResponse::err(id, e.code(), e.message())),
    }
}
```

- [ ] **Step 3: Manual smoke**

Restart the app. Use the same hard-coded test token approach from Phase E.

```bash
# Method not found
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Authorization: Bearer test_token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"unknown","params":{}}' | jq .
# Expected: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "..." } }

# Tool stub
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Authorization: Bearer test_token" \
  -d '{"jsonrpc":"2.0","id":2,"method":"list_subjects","params":{}}' | jq .
# Expected: { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "...not yet implemented..." } }

# Ping
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Authorization: Bearer test_token" \
  -d '{"jsonrpc":"2.0","id":3,"method":"ping"}' | jq .
# Expected: { jsonrpc: "2.0", id: 3, result: {} }
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/types.rs src-tauri/src/mcp/error.rs src-tauri/src/mcp/tools.rs src-tauri/src/mcp/server.rs
git commit -m "$(cat <<'EOF'
feat(mcp): JSON-RPC 2.0 envelope + tool dispatcher with stubs (Phase F)

POST /mcp now decodes JSON-RPC 2.0 requests and routes by method name.
All 6 tool slots return -32603 (not yet implemented); ping works; unknown
methods return -32601. Codex/claude-code can now connect (handshake-wise).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase G — Supabase REST helper + first tool (`list_subjects`)

The smallest tool. Validates the entire path: bearer auth → access-token lookup → Supabase REST → response. Once this works end-to-end, Phase H is a fan-out of variations on the same pattern.

### Task G1: `mcp/supabase.rs` — REST client wrapper

**Files:**
- Modify: `src-tauri/src/mcp/supabase.rs`

- [ ] **Step 1: Implement the wrapper**

```rust
// src-tauri/src/mcp/supabase.rs
//
// Thin reqwest-based wrapper over Supabase REST. Every call carries:
//  - Authorization: Bearer <user's rotating access_token>
//  - apikey:        <project publishable anon key>
//  - Content-Type:  application/json
//
// We do NOT use service_role here — RLS handles isolation. The user's
// access_token IS the auth.uid() for RLS purposes.

use reqwest::Client;
use serde_json::Value;

use crate::mcp::error::McpError;

#[derive(Clone)]
pub struct SupabaseClient {
    pub base_url: String,    // e.g. "https://abc.supabase.co"
    pub anon_key: String,
    http: Client,
}

impl SupabaseClient {
    pub fn new(base_url: String, anon_key: String) -> Self {
        Self {
            base_url,
            anon_key,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client build"),
        }
    }

    /// REST path is appended to `<base_url>/rest/v1/`.
    /// `query` is the unencoded querystring (e.g. "select=*&order=updated_at.desc").
    pub async fn get(
        &self,
        path: &str,
        query: &str,
        access_token: &str,
    ) -> Result<Value, McpError> {
        let url = format!("{}/rest/v1/{}?{}", self.base_url, path, query);
        let res = self.http.get(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Accept", "application/json")
            .send().await
            .map_err(|e| McpError::SupabaseError(format!("get {path}: {e}")))?;
        let status = res.status();
        let body: Value = res.json().await
            .map_err(|e| McpError::SupabaseError(format!("get {path} parse: {e}")))?;
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "get {path}: HTTP {} body={body}", status.as_u16()
            )));
        }
        Ok(body)
    }

    pub async fn post(
        &self,
        path: &str,
        body: &Value,
        access_token: &str,
        return_representation: bool,
    ) -> Result<Value, McpError> {
        let url = format!("{}/rest/v1/{}", self.base_url, path);
        let mut req = self.http.post(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(body);
        if return_representation {
            req = req.header("Prefer", "return=representation");
        }
        let res = req.send().await
            .map_err(|e| McpError::SupabaseError(format!("post {path}: {e}")))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "post {path}: HTTP {} body={body}", status.as_u16()
            )));
        }
        Ok(body)
    }
}

/// Helper for tools — looks up the access token for the request's account
/// or returns AuthPending so the CLI retries once.
pub async fn supabase_for(
    state: &crate::mcp::server::McpState,
    account_id: &str,
) -> Result<(SupabaseClient, String), McpError> {
    let s = state.read().await;
    let token = crate::mcp::auth::current_access_token(state, account_id).await
        .ok_or(McpError::AuthPending)?;
    Ok((SupabaseClient::new(s.supabase_url.clone(), s.supabase_anon_key.clone()), token))
}
```

Note on `supabase_for` borrow: the `read` lock is dropped before `current_access_token` is called (which takes its own read lock). To make the lifetime explicit, restructure:

```rust
pub async fn supabase_for(
    state: &crate::mcp::server::McpState,
    account_id: &str,
) -> Result<(SupabaseClient, String), McpError> {
    let token = crate::mcp::auth::current_access_token(state, account_id).await
        .ok_or(McpError::AuthPending)?;
    let (base_url, anon_key) = {
        let s = state.read().await;
        (s.supabase_url.clone(), s.supabase_anon_key.clone())
    };
    Ok((SupabaseClient::new(base_url, anon_key), token))
}
```

(The two `read()`s do not deadlock; tokio's `RwLock` is not reentrant but they don't overlap in scope here.)

- [ ] **Step 2: `cargo check`**

Expected: PASS.

### Task G2: Implement `list_subjects` in `tools.rs`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Replace the stub**

```rust
async fn list_subjects(
    _params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    // RLS scopes by user_id automatically.
    let body = sb.get(
        "subjects",
        "select=id,project_name,file_name,current_version_id,updated_at\
         &order=updated_at.desc",
        &token,
    ).await?;
    Ok(body)
}
```

- [ ] **Step 2: Manual smoke (this is the first end-to-end test)**

In the running app:
1. Sign in to a real Supabase account.
2. From DevTools, ensure the account's `mcp_token` is registered. For now, the front-end glue (Phase I) is not done, so manually invoke:
   ```js
   await window.__TAURI__.core.invoke('mcp_update_account_token', {
     args: {
       accountId: '<your user id>',
       accessToken: '<copy from supabase.auth.getSession()>',
       expiresAt: Math.floor(Date.now()/1000) + 3600,
     }
   });
   ```
3. Manually inject the bearer token into the Rust map. Two options:
   (a) Edit `repopulate_bearer_tokens` to read `notter:account:<id>:mcp_token` from the keyring at boot. Requires writing a small `keyring::Entry::get_password` call.
   (b) Add a temporary command `mcp_register_bearer(account_id, bearer_token)` in `auth.rs` for smoke testing only; remove before commit. **Recommended.** Phase I formalizes this with a real `notifyMcpAccountAdded`.
4. Read the bearer from secure store via the existing `secureGet`:
   ```js
   const t = await window.__TAURI__.core.invoke('secure_get', {
     key: `notter:account:<your user id>:mcp_token`
   });
   await window.__TAURI__.core.invoke('mcp_register_bearer', {
     accountId: '<id>', bearerToken: t.value
   });
   ```
5. Read `endpoint.json` for the URL.
6. `curl`:
   ```bash
   curl -s -X POST http://127.0.0.1:<port>/mcp \
     -H "Authorization: Bearer notter_acc_<...>" \
     -d '{"jsonrpc":"2.0","id":1,"method":"list_subjects","params":{}}' | jq .
   ```
   Expected: `{ jsonrpc: "2.0", id: 1, result: [ { id, project_name, file_name, current_version_id, updated_at }, ... ] }`. The result is the subject list visible in PlannerTab for that account.

- [ ] **Step 3: Verify error paths**

```bash
# auth_pending — call mcp_remove_account_token first to clear, then:
curl -s -X POST http://...
# Expected: { error: { code: -32001, ... } }
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/supabase.rs src-tauri/src/mcp/tools.rs
git commit -m "$(cat <<'EOF'
feat(mcp): Supabase REST helper + list_subjects tool (Phase G)

End-to-end data path validated: bearer auth -> access-token lookup ->
Supabase REST query with RLS. Returns the subject list for the active
account.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase H — Remaining 5 tools

Each tool follows the same shape as `list_subjects`. Schema reference: `supabase/migrations/2026-05-10-subject-versioning.sql`. Tools renamed from spec §6.4: `plan_id` → `subject_id`; `plans` → `subjects`; `current_snapshot_id` → `current_version_id`; `working_content` → `content` (subjects' editable content lives at `subjects.content`, not `subjects.working_content`).

### Task H1: `get_subject`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Implement**

```rust
#[derive(serde::Deserialize)]
struct GetSubjectParams { subject_id: String }

async fn get_subject(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: GetSubjectParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("get_subject: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb.get(
        "subjects",
        &format!(
            "select=id,project_name,file_name,content,current_version_id,updated_at\
             &id=eq.{}&limit=1",
            url_encode(&p.subject_id)
        ),
        &token,
    ).await?;
    let row = body.as_array()
        .and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::NotFound(format!("subject {} not found", p.subject_id)))?;
    Ok(row)
}

fn url_encode(s: &str) -> String {
    // Minimal — uuids and identifiers don't contain special chars,
    // but be defensive. percent-encode reserved chars.
    s.chars()
        .flat_map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            vec![c]
        } else {
            format!("%{:02X}", c as u8).chars().collect()
        })
        .collect()
}
```

### Task H2: `list_versions`

```rust
#[derive(serde::Deserialize)]
struct ListVersionsParams { subject_id: String }

async fn list_versions(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: ListVersionsParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("list_versions: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb.get(
        "subject_versions",
        &format!(
            "select=id,source,source_actor,label,created_at\
             &subject_id=eq.{}&order=created_at.desc",
            url_encode(&p.subject_id)
        ),
        &token,
    ).await?;
    Ok(body)
}
```

### Task H3: `get_version`

```rust
#[derive(serde::Deserialize)]
struct GetVersionParams { version_id: String }

async fn get_version(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: GetVersionParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("get_version: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb.get(
        "subject_versions",
        &format!(
            "select=id,subject_id,content_markdown,parent_version_id,source,source_actor,label,created_at\
             &id=eq.{}&limit=1",
            url_encode(&p.version_id)
        ),
        &token,
    ).await?;
    let row = body.as_array()
        .and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::NotFound(format!("version {} not found", p.version_id)))?;
    Ok(row)
}
```

### Task H4: `list_comments`

```rust
#[derive(serde::Deserialize)]
struct ListCommentsParams {
    subject_id: String,
    #[serde(default)]
    version_id: Option<String>,
}

async fn list_comments(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: ListCommentsParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("list_comments: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let mut q = format!(
        "select=id,version_id,body,resolved,author_user_id,created_at\
         &subject_id=eq.{}&order=created_at.asc",
        url_encode(&p.subject_id)
    );
    if let Some(vid) = p.version_id {
        q.push_str(&format!("&version_id=eq.{}", url_encode(&vid)));
    }
    let body = sb.get("subject_comments", &q, &token).await?;
    Ok(body)
}
```

### Task H5: `post_subject_revision`

This is the only write-tool in Phase 1. It inserts a `subject_versions` row and **does NOT** advance `subjects.current_version_id` (per spec §6.4 — the UI handles adoption opt-in to match the in-app `snapshotCurrent` UX from M2).

```rust
#[derive(serde::Deserialize)]
struct PostRevisionParams {
    subject_id: String,
    content_markdown: String,
    #[serde(default)]
    parent_version_id: Option<String>,
    #[serde(default)]
    source_actor: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

async fn post_subject_revision(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: PostRevisionParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("post_subject_revision: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;

    let payload = serde_json::json!({
        "subject_id": p.subject_id,
        "content_markdown": p.content_markdown,
        "parent_version_id": p.parent_version_id,
        "source": "ai", // every MCP-side write is "ai" by definition
        "source_actor": p.source_actor,
        "label": p.label,
    });

    // The set_user_id_on_subject_versions trigger fills user_id server-side;
    // the column is intentionally absent from the payload.
    let response = sb.post("subject_versions", &payload, &token, true).await?;

    // Supabase returns the inserted row(s) as an array when Prefer:return=representation is set.
    let row = response.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| McpError::SupabaseError(
            "post_subject_revision: insert returned no row".into()
        ))?;
    let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok(serde_json::json!({ "version_id": id }))
}
```

- [ ] **Step (per task): manual curl smoke test**

For each of the 5 tools, write a curl invocation against your live account's data:

```bash
SUBJ=$(curl -s ... list_subjects | jq -r '.result[0].id')
curl -s ... -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"get_subject\",\"params\":{\"subject_id\":\"$SUBJ\"}}" | jq .
curl -s ... -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"list_versions\",\"params\":{\"subject_id\":\"$SUBJ\"}}" | jq .
# ...etc for get_version, list_comments
curl -s ... -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"post_subject_revision\",\"params\":{\"subject_id\":\"$SUBJ\",\"content_markdown\":\"# revised by curl\",\"label\":\"smoke test\",\"source_actor\":\"curl\"}}" | jq .
```

After `post_subject_revision`, verify in the running Notter UI (PlannerTab, version history panel) that the new version appears via the existing realtime subscription. Do NOT verify by re-querying `list_versions` — that proves the row was inserted but doesn't validate the realtime path.

- [ ] **Step (final): Commit**

```bash
git add src-tauri/src/mcp/tools.rs
git commit -m "$(cat <<'EOF'
feat(mcp): implement get_subject, list_versions, get_version, list_comments, post_subject_revision (Phase H)

Five remaining Phase 1 tools. post_subject_revision inserts a
subject_versions row only; UI handles adoption opt-in. All five
exercised via curl + live Supabase against the active account.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase I — Front-end glue: push tokens on auth events

This phase replaces the manual DevTools-driven token registration with proper auth-store wiring. After this phase, signing in / refreshing / switching accounts automatically keeps the Rust state in sync.

### Task I1: Create `src/lib/mcp/index.ts`

**Files:**
- Create: `src/lib/mcp/index.ts`

- [ ] **Step 1: Write the module**

```ts
// src/lib/mcp/index.ts
import { invoke } from '@tauri-apps/api/core';

/**
 * Notify the Rust MCP server that an account's Supabase access token has
 * rotated. Front-end is the SOLE Supabase refresh owner per spec §6.2; the
 * Rust server is a passive consumer of these pushes.
 */
export async function notifyMcpAccountTokenChanged(
  accountId: string,
  accessToken: string,
  expiresAt: number, // unix seconds
): Promise<void> {
  try {
    await invoke('mcp_update_account_token', {
      args: { accountId, accessToken, expiresAt },
    });
  } catch (e) {
    // Non-fatal — the MCP server may be disabled (bind failed).
    console.warn('[mcp] notifyMcpAccountTokenChanged failed:', e);
  }
}

/**
 * Notify the Rust MCP server that an account has been removed (or signed out).
 * Drops the per-account access-token slice and any active bearer mapping.
 */
export async function notifyMcpAccountRemoved(accountId: string): Promise<void> {
  try {
    await invoke('mcp_remove_account_token', { accountId });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountRemoved failed:', e);
  }
}

/**
 * Register a per-account Bearer token with the Rust server. Called from
 * AccountManager.bootstrap() and AccountManager.add() so the server knows
 * which Bearer corresponds to which account.
 */
export async function notifyMcpAccountAdded(
  accountId: string,
  bearerToken: string,
): Promise<void> {
  try {
    await invoke('mcp_register_bearer', { accountId, bearerToken });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountAdded failed:', e);
  }
}

/**
 * Read the per-account stable config file at
 * `<appLocalData>/notter-ai/mcp/<accountId>-config.json`.
 * Used by the "Copy MCP config" UI in Phase J.
 */
export interface McpConfig {
  url: string;
  bearer_token: string;
  generated_at: string;
}

export async function readMcpConfigForAccount(
  accountId: string,
): Promise<McpConfig | null> {
  try {
    return await invoke<McpConfig>('mcp_read_account_config', { accountId });
  } catch (e) {
    console.warn('[mcp] readMcpConfigForAccount failed:', e);
    return null;
  }
}
```

(`mcp_register_bearer` and `mcp_read_account_config` are added in Tasks I2 + K1 respectively.)

- [ ] **Step 2: Add tests**

```ts
// src/lib/mcp/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  notifyMcpAccountTokenChanged,
  notifyMcpAccountRemoved,
  notifyMcpAccountAdded,
  readMcpConfigForAccount,
} from '@/lib/mcp';

beforeEach(() => invokeMock.mockReset());

describe('mcp glue', () => {
  it('notifyMcpAccountTokenChanged forwards to mcp_update_account_token', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountTokenChanged('acc1', 'tok1', 9999);
    expect(invokeMock).toHaveBeenCalledWith('mcp_update_account_token', {
      args: { accountId: 'acc1', accessToken: 'tok1', expiresAt: 9999 },
    });
  });

  it('swallows errors from invoke', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await expect(
      notifyMcpAccountTokenChanged('acc1', 'tok1', 9999),
    ).resolves.toBeUndefined();
  });

  it('notifyMcpAccountRemoved forwards to mcp_remove_account_token', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountRemoved('acc1');
    expect(invokeMock).toHaveBeenCalledWith('mcp_remove_account_token', { accountId: 'acc1' });
  });

  it('notifyMcpAccountAdded forwards to mcp_register_bearer', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountAdded('acc1', 'tok-bearer');
    expect(invokeMock).toHaveBeenCalledWith('mcp_register_bearer', {
      accountId: 'acc1', bearerToken: 'tok-bearer',
    });
  });

  it('readMcpConfigForAccount returns null on error', async () => {
    invokeMock.mockRejectedValue(new Error('not found'));
    expect(await readMcpConfigForAccount('acc1')).toBeNull();
  });
});
```

- [ ] **Step 3: `npm run test -- mcp/index.test`**

Expected: 5 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mcp/
git commit -m "$(cat <<'EOF'
feat(mcp): TS glue notify* + readMcpConfigForAccount + tests (Phase I)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task I2: Add the `mcp_register_bearer` Tauri command

**Files:**
- Modify: `src-tauri/src/mcp/auth.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the command in `auth.rs`**

```rust
#[derive(serde::Deserialize)]
pub struct RegisterBearerArgs {
    pub account_id: String,
    pub bearer_token: String,
}

#[tauri::command]
pub async fn mcp_register_bearer(
    account_id: String,
    bearer_token: String,
    state: tauri::State<'_, crate::mcp::server::McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    // Replace any existing mapping for this account (account-rotated tokens
    // would be unusual but defensible).
    s.token_to_account.retain(|_, v| v != &account_id);
    s.token_to_account.insert(bearer_token, account_id);
    Ok(())
}
```

- [ ] **Step 2: Register in `lib.rs`'s `invoke_handler!`**

```rust
mcp::auth::mcp_register_bearer,
```

- [ ] **Step 3: `cargo build`**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/auth.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(mcp): mcp_register_bearer Tauri command (Phase I)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task I3: Wire `notifyMcpAccountTokenChanged` into auth-store

**Files:**
- Modify: `src/stores/auth-store.ts`

- [ ] **Step 1: Inject the call in `onAuthStateChange`**

In `src/stores/auth-store.ts:148-160`, the existing `onAuthStateChange` block emits a Tauri event but does not yet invoke our command. Add an import at the top:

```ts
import { notifyMcpAccountTokenChanged, notifyMcpAccountRemoved } from '@/lib/mcp';
```

Then replace lines 148–160:

```ts
supabase.auth.onAuthStateChange((event, session) => {
  set({
    session,
    user: session?.user ?? null,
  });
  if (event === 'SIGNED_IN' && session?.user) {
    syncOnLogin(session.user.id);
    startRealtimeSync(session.user.id);
  }
  if (event === 'TOKEN_REFRESHED' && session?.user && session.access_token) {
    void notifyMcpAccountTokenChanged(
      session.user.id,
      session.access_token,
      session.expires_at ?? 0,
    );
  }
  if (event === 'SIGNED_IN' && session?.user && session.access_token) {
    void notifyMcpAccountTokenChanged(
      session.user.id,
      session.access_token,
      session.expires_at ?? 0,
    );
  }
  if (event === 'SIGNED_OUT') {
    stopRealtimeSync();
  }
});
```

Also wire the initial-session push in `initialize()` immediately after the `set({ session, user: ..., loading: false })` calls — Supabase's `onAuthStateChange` only fires on subsequent changes, not on the initial load.

- [ ] **Step 2: Wire `signOut` to remove the token**

```ts
signOut: async () => {
  if (!isSupabaseConfigured) return;
  stopRealtimeSync();
  const previousId = (await supabase.auth.getSession()).data.session?.user?.id;
  await supabase.auth.signOut();
  if (previousId) await notifyMcpAccountRemoved(previousId);
  await getAccountManager().setActiveAccountId(null);
  set({ user: null, session: null });
  resetAllStores();
},
```

- [ ] **Step 3: Wire `AccountManager.add` to register the bearer**

In `src/lib/accounts/account-manager.ts`, append to the existing `add()` method (after the `secureSet(accountKeys.mcpToken(...))` call):

```ts
const newBearer = await secureGet(accountKeys.mcpToken(input.id));
if (newBearer) {
  const { notifyMcpAccountAdded } = await import('@/lib/mcp');
  await notifyMcpAccountAdded(input.id, newBearer);
}
```

And in `bootstrap()`, after the existing `secureRegisterKnownKeys` block (around line 70), add a loop that re-registers each account's bearer with the Rust server:

```ts
// Push every known account's MCP bearer to Rust so it knows which
// (token -> accountId) mappings to honor on POST /mcp. Phase I (M3).
const { notifyMcpAccountAdded } = await import('@/lib/mcp');
for (const a of this.accounts) {
  const bearer = await secureGet(accountKeys.mcpToken(a.id));
  if (bearer) {
    await notifyMcpAccountAdded(a.id, bearer);
  }
}
```

The dynamic `import` avoids the circular-import problem flagged in `src/lib/supabase.ts:10-21`. (`@/lib/mcp` does not import account-manager or supabase, so the only risk is at the import-graph level — using a dynamic `import()` keeps the bootstrap path clean.)

- [ ] **Step 4: Wire `AccountManager.remove` to unregister**

```ts
async remove(id: string): Promise<void> {
  if (this.active === id) {
    throw new Error('Cannot remove the active account; switch to another account first.');
  }
  const before = this.accounts.length;
  this.accounts = this.accounts.filter((a) => a.id !== id);
  if (this.accounts.length === before) return;
  await secureDelete(accountKeys.refreshToken(id));
  await secureDelete(accountKeys.mcpToken(id));
  await writeAccountIndex({ accounts: this.accounts });
  // Phase I (M3) — drop server-side token map entries.
  const { notifyMcpAccountRemoved } = await import('@/lib/mcp');
  await notifyMcpAccountRemoved(id);
  this.notify();
}
```

- [ ] **Step 5: Manual smoke**

Restart the app cold. Without doing any DevTools manipulation, fire the same `list_subjects` curl from Phase G (read URL + bearer from secure store + endpoint.json). Expected: 200 with the subject list.

Then sign out and back in. `endpoint.json` URL stays stable across signout (no rebind); the bearer should still work because it's per-account, not per-session.

- [ ] **Step 6: Commit**

```bash
git add src/stores/auth-store.ts src/lib/accounts/account-manager.ts
git commit -m "$(cat <<'EOF'
feat(mcp): push tokens to Rust on auth events (Phase I)

auth-store: invokes notifyMcpAccountTokenChanged on SIGNED_IN /
TOKEN_REFRESHED, notifyMcpAccountRemoved on SIGNED_OUT.
account-manager: registers each account's bearer with Rust at bootstrap
and add(), unregisters on remove().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase J — "Copy MCP config" UI in `UserMenu`

A small dialog that surfaces the per-account URL + bearer token + a "Copy JSON" button. Discoverability surface for users who don't know to read `endpoint.json` manually.

### Task J1: Add the dialog component

**Files:**
- Create: `src/components/McpConfigDialog.tsx`

- [ ] **Step 1: Build the component**

```tsx
// src/components/McpConfigDialog.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useAuthStore } from '@/stores/auth-store';
import { readMcpConfigForAccount, type McpConfig } from '@/lib/mcp';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function McpConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !user) {
      setConfig(null);
      return;
    }
    setLoading(true);
    readMcpConfigForAccount(user.id)
      .then(setConfig)
      .finally(() => setLoading(false));
  }, [open, user]);

  const onCopy = async () => {
    if (!config) return;
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    toast.success(t('mcp.copied_toast'));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('mcp.dialog_title')}</DialogTitle>
          <DialogDescription>{t('mcp.dialog_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {loading && <p className="text-sm text-muted-foreground">…</p>}
          {!loading && !config && (
            <div className="space-y-1">
              <p className="text-sm text-destructive font-medium">{t('mcp.disabled_banner')}</p>
              <p className="text-xs text-muted-foreground">{t('mcp.disabled_reason')}</p>
            </div>
          )}
          {config && (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('mcp.url_label')}</label>
                <code className="block text-xs bg-muted rounded px-2 py-1 break-all">{config.url}</code>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('mcp.token_label')}</label>
                <code className="block text-xs bg-muted rounded px-2 py-1 break-all">{config.bearer_token}</code>
              </div>
              <button
                onClick={onCopy}
                className="w-full mt-2 px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
              >
                {t('mcp.copy_button')}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### Task J2: Wire the dialog into UserMenu

**Files:**
- Modify: `src/components/UserMenu.tsx`

- [ ] **Step 1: Add a state hook + menu item**

At the top, add:

```tsx
import { McpConfigDialog } from '@/components/McpConfigDialog';
import { Network } from 'lucide-react';
```

Add a state hook with the others:

```tsx
const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
```

After the "Manage AI" button (around line 112–115), add:

```tsx
<button
  onClick={() => { setOpen(false); setMcpConfigOpen(true); }}
  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
>
  <Network size={14} />
  {t('mcp.menu_label')}
</button>
```

At the bottom, alongside the other dialogs:

```tsx
<McpConfigDialog open={mcpConfigOpen} onOpenChange={setMcpConfigOpen} />
```

The menu entry only renders when there is an active `user` — wrap inside the existing `{user && ...}` if you want to gate it (recommended; the dialog is meaningless without an account).

### Task J3: Add i18n keys

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/pt-BR.json`

- [ ] **Step 1: en.json — add an `"mcp"` block**

```json
{
  "mcp": {
    "menu_label": "MCP config",
    "dialog_title": "MCP server config",
    "dialog_description": "Point your external CLI (claude-code, codex, aider) at this URL with the bearer token below.",
    "url_label": "URL",
    "token_label": "Bearer token",
    "copy_button": "Copy JSON",
    "copied_toast": "MCP config copied to clipboard",
    "disabled_banner": "MCP server unavailable",
    "disabled_reason": "The local server failed to bind. Restart the app; if it persists, check the logs."
  }
}
```

- [ ] **Step 2: pt-BR.json — translated**

```json
{
  "mcp": {
    "menu_label": "Configurar MCP",
    "dialog_title": "Configuração do servidor MCP",
    "dialog_description": "Aponte sua CLI externa (claude-code, codex, aider) para esta URL usando o token abaixo.",
    "url_label": "URL",
    "token_label": "Token",
    "copy_button": "Copiar JSON",
    "copied_toast": "Configuração MCP copiada",
    "disabled_banner": "Servidor MCP indisponível",
    "disabled_reason": "O servidor local não conseguiu iniciar. Reinicie o app; se persistir, verifique os logs."
  }
}
```

- [ ] **Step 3: Manual smoke**

Open the user menu. Click "MCP config". The dialog opens. Either:
- Phase K is done → URL + token render → "Copy JSON" copies a real config.
- Phase K is NOT done yet → "MCP server unavailable" banner shows (because `mcp_read_account_config` does not exist yet). Acceptable interim state.

- [ ] **Step 4: Commit**

```bash
git add src/components/McpConfigDialog.tsx src/components/UserMenu.tsx src/i18n/locales/en.json src/i18n/locales/pt-BR.json
git commit -m "$(cat <<'EOF'
feat(mcp): McpConfigDialog + UserMenu entry + i18n (Phase J)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase K — Stable per-account config file

The dynamic-port URL changes on every app restart. To give users a stable file path their CLI can ingest, the server writes
`<appLocalData>/notter-ai/mcp/<accountId>-config.json` on every boot for every known account. This is the same data the dialog shows; the file form lets MCP clients with file-based config skip the manual copy step.

### Task K1: Implement `mcp_read_account_config` Tauri command + boot-time writer

**Files:**
- Modify: `src-tauri/src/mcp/server.rs`

- [ ] **Step 1: Add the writer + reader**

In `src-tauri/src/mcp/server.rs`:

```rust
use crate::mcp::endpoint::endpoint_path;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct McpAccountConfig {
    pub url: String,
    pub bearer_token: String,
    pub generated_at: String,
}

/// Write a per-account config file. Called from start_mcp_server after
/// bind succeeds, ONCE PER known account. Token map population happens
/// after this in many launches; for accounts whose bearer hasn't been
/// pushed yet, the writer skips that account and re-runs on the next
/// notifyMcpAccountAdded call.
pub async fn write_per_account_configs(
    app: &tauri::AppHandle,
    state: &McpState,
) -> Result<(), String> {
    let dir = mcp_dir(app)?;
    tokio::fs::create_dir_all(&dir).await
        .map_err(|e| format!("create_dir: {e}"))?;
    let s = state.read().await;
    let url = s.url.clone().ok_or_else(|| "url not set".to_string())?;
    let now = crate::mcp::endpoint::now_rfc3339();
    for (token, account_id) in s.token_to_account.iter() {
        let cfg = McpAccountConfig {
            url: url.clone(),
            bearer_token: token.clone(),
            generated_at: now.clone(),
        };
        let path = dir.join(format!("{}-config.json", account_id));
        let json = serde_json::to_string_pretty(&cfg)
            .map_err(|e| format!("serde: {e}"))?;
        let _ = tokio::fs::write(path, json).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_read_account_config(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<McpAccountConfig, String> {
    let dir = mcp_dir(&app)?;
    let path = dir.join(format!("{}-config.json", account_id));
    let body = tokio::fs::read_to_string(&path).await
        .map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("parse: {e}"))
}
```

- [ ] **Step 2: Re-run the writer after every `mcp_register_bearer` call**

Modify `mcp::auth::mcp_register_bearer` to also call `write_per_account_configs`:

```rust
#[tauri::command]
pub async fn mcp_register_bearer(
    account_id: String,
    bearer_token: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::mcp::server::McpState>,
) -> Result<(), String> {
    {
        let mut s = state.write().await;
        s.token_to_account.retain(|_, v| v != &account_id);
        s.token_to_account.insert(bearer_token, account_id.clone());
    }
    // Re-write per-account configs so the new entry's file is created.
    let _ = crate::mcp::server::write_per_account_configs(&app, state.inner()).await;
    Ok(())
}
```

- [ ] **Step 3: Register `mcp_read_account_config` in `lib.rs`**

```rust
mcp::server::mcp_read_account_config,
```

- [ ] **Step 4: Manual smoke**

Restart the app cold (or sign in to a fresh account). After the bootstrap registers the bearer, verify `<appLocalData>/notter-ai/mcp/<accountId>-config.json` exists with `{ url, bearer_token, generated_at }`. Open the McpConfigDialog from UserMenu — content should now load.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/server.rs src-tauri/src/mcp/auth.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(mcp): per-account stable config file (Phase K)

<appLocalData>/notter-ai/mcp/<accountId>-config.json written on every
mcp_register_bearer call. mcp_read_account_config Tauri command exposes
it to the UI dialog from Phase J. Path is stable across restarts; URL
inside updates on every dynamic-port assignment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase L — End-to-end smoke (manual)

Before declaring M3 done, exercise every tool against a live Supabase project with a real account, and verify the UI reflects the changes.

### Task L1: End-to-end checklist

- [ ] **Step 1: Cold start a clean profile**

```bash
# Kill any running Notter instance.
# Wipe the test profile (NOT a real user account):
rm -rf "$LOCALAPPDATA/com.guilh.notterai"   # Windows
# or rm -rf "~/Library/Application Support/com.guilh.notterai"   # macOS
# or rm -rf "~/.local/share/com.guilh.notterai"                  # Linux
npm run tauri dev
```

- [ ] **Step 2: Sign in fresh and create test data**

Sign in with a Supabase account that already has at least one project + subject from M2. If there is none, create:
1. New project "MCP smoke".
2. New subject "test plan" with markdown body `# Hello\n\nFirst plan.`.

- [ ] **Step 3: Open McpConfigDialog and copy the config**

UserMenu → "MCP config" → "Copy JSON". Paste into a scratch file. Confirm `url` looks like `http://127.0.0.1:5xxxx/mcp` and `bearer_token` starts with `notter_acc_`.

- [ ] **Step 4: Run all 6 tools via curl**

Save URL + bearer to env:

```bash
export MCP_URL="http://127.0.0.1:5xxxx/mcp"
export MCP_TOKEN="notter_acc_xxxxx"

call() {
  curl -s -X POST "$MCP_URL" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1" | jq .
}

# 1. list_subjects
call '{"jsonrpc":"2.0","id":1,"method":"list_subjects","params":{}}'
# verify: array of objects, each with id/project_name/file_name/...

# Capture an id:
SUBJ=$(call '{"jsonrpc":"2.0","id":1,"method":"list_subjects","params":{}}' | jq -r '.result[0].id')
echo "subject: $SUBJ"

# 2. get_subject
call "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"get_subject\",\"params\":{\"subject_id\":\"$SUBJ\"}}"

# 3. list_versions
call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"list_versions\",\"params\":{\"subject_id\":\"$SUBJ\"}}"

# 4. get_version (use one returned by step 3, if any)
VID=$(call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"list_versions\",\"params\":{\"subject_id\":\"$SUBJ\"}}" | jq -r '.result[0].id // empty')
if [ -n "$VID" ]; then
  call "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"get_version\",\"params\":{\"version_id\":\"$VID\"}}"
fi

# 5. list_comments
call "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"list_comments\",\"params\":{\"subject_id\":\"$SUBJ\"}}"

# 6. post_subject_revision (THE write — verify in UI afterwards)
call "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"post_subject_revision\",\"params\":{\"subject_id\":\"$SUBJ\",\"content_markdown\":\"# Hello\\n\\nRevised by curl smoke.\",\"label\":\"smoke L4\",\"source_actor\":\"curl\"}}"
```

- [ ] **Step 5: Verify the new version surfaces in the UI**

Open the subject in PlannerTab. The version history side panel should show "smoke L4" as the newest entry (via the existing realtime subscription set up in M2 — Rust did NOT push to the UI; Supabase's realtime did). Click it; preview mode should render the new content. Click "Adotar"; the editor swaps and `subjects.current_version_id` advances.

- [ ] **Step 6: Verify auth_pending behavior**

Expire the access token in the Rust map: `mcp_remove_account_token('<your account id>')` from DevTools. `curl` again:

```bash
call '{"jsonrpc":"2.0","id":7,"method":"list_subjects","params":{}}'
# Expected: { error: { code: -32001, message: "auth_pending: ..." } }
```

Wait ~1 minute for the front-end to refresh; the call should succeed again automatically.

- [ ] **Step 7: Verify multi-account isolation**

Add a second Supabase account (use a separate test email). Verify that account-2's bearer token cannot read account-1's subjects (RLS enforces this; the Rust server doesn't filter on its end).

```bash
# Use account-1's bearer to read account-2's subjects → should return [].
```

- [ ] **Step 8: Verify stale-detection on relaunch**

Kill the dev process via Ctrl-C without going through window-close. Confirm `endpoint.json` is left behind (close-requested handler doesn't fire on SIGINT). Relaunch — the boot path probes the dead URL, sees connection-refused, deletes the file, binds anew. `endpoint.json` now contains a different URL.

- [ ] **Step 9: Document any defects**

If any tool fails, file an issue and either fix in this milestone or punt to M3.1 as appropriate. Do not declare M3 done with broken tools.

- [ ] **Step 10: Final commit (no code changes — just announce)**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
chore(m3): end-to-end smoke complete

All 6 MCP tools exercised against live Supabase. Multi-account isolation
verified. Stale-endpoint detection verified. M3 ready to merge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Tools (renamed from spec to match shipped schema)

The pivot spec §6.4 was drafted before the schema redirect documented in `2026-05-09-m2-plan-model.md`'s retrospective. The shipped schema is `subjects` + `subject_versions` + `subject_comments`, NOT `plans` + `plan_versions` + `plan_comments`. This plan renames every tool argument and result field to match the live schema. Tool semantics are unchanged from the spec.

| Tool | Args | Returns | Backed by |
|---|---|---|---|
| `list_subjects` | _(none)_ | `[ { id, project_name, file_name, current_version_id, updated_at } ]` ordered by `updated_at desc` | `GET /rest/v1/subjects?select=...` |
| `get_subject` | `subject_id` (uuid) | `{ id, project_name, file_name, content, current_version_id, updated_at }` | `GET /rest/v1/subjects?id=eq.<id>&limit=1` |
| `list_versions` | `subject_id` (uuid) | `[ { id, source, source_actor, label, created_at } ]` ordered by `created_at desc` | `GET /rest/v1/subject_versions?subject_id=eq.<id>` |
| `get_version` | `version_id` (uuid) | `{ id, subject_id, content_markdown, parent_version_id, source, source_actor, label, created_at }` | `GET /rest/v1/subject_versions?id=eq.<id>&limit=1` |
| `list_comments` | `subject_id` (uuid), `version_id?` (uuid, optional) | `[ { id, version_id, body, resolved, author_user_id, created_at } ]` ordered by `created_at asc` | `GET /rest/v1/subject_comments?subject_id=eq.<id>[&version_id=eq.<id>]` |
| `post_subject_revision` | `subject_id`, `content_markdown`, `parent_version_id?`, `source_actor?`, `label?` | `{ version_id }` | `POST /rest/v1/subject_versions Prefer: return=representation` |

Behavioral notes:
- **`post_subject_revision` does NOT mutate `subjects.content` or `subjects.current_version_id`.** The newly inserted `subject_versions` row is a "candidate" until the user adopts it via the in-app `enterPreview` → `adoptVersion` flow. This matches the M2-shipped UX (`useSubjectVersionsStore.snapshotCurrent`, `subject-versions-store.ts:154-189`).
- **The trigger `set_user_id_on_subject_versions` fills `user_id` server-side.** `post_subject_revision` MUST omit `user_id` from its insert payload. Same for `subject_comments` (not exposed in M3 anyway).
- **All reads rely on RLS** (`auth.uid() = user_id`). The Rust server never bypasses RLS — the user's rotating access token IS `auth.uid()`.
- **No batching.** Each request is a single JSON-RPC envelope. The MCP spec permits batching but no Phase 1 client uses it.

---

## Out of scope (explicit non-goals)

- **Streaming tools / SSE.** The MCP Streamable HTTP transport supports SSE upgrades for streaming responses; Phase 1 has no streaming tools and the SSE machinery would be wasted code. Phase 3 may add `subscribe_changes` for realtime collab.
- **`post_comment` MCP tool.** Comments are human-authored. AI revises in response (writes a new version), it doesn't chat back. Spec §6.4.
- **`delete_*` tools.** Subjects/versions/comments are deleted via UI only.
- **Stdio MCP bridge (`notter-mcp-bridge.js`).** Phase 1.5 if a target CLI lacks HTTP transport. Not in M3.
- **Realtime push from Rust to UI.** The UI's existing Supabase realtime subscription (set up in M2 — `subscribeUserTable('subject_versions', ...)`) handles the "Codex posted v4" path. Rust never broadcasts to the front-end.
- **Touching `notter-mcp-server/` (legacy Node stdio).** Coexists by table-isolation per spec §7 M3. Phase 3 decision.
- **Modifying `PlannerTab.tsx`, `subject-versions-store.ts`, or any UI store.** Rust is the only writer for `subject_versions` from MCP, but it does so via raw REST. The UI store re-reads via realtime.
- **JSON-RPC batching, `Mcp-Session-Id` re-attach.** No client uses these in Phase 1.
- **OS keychain / TLS hardening.** The bearer token is only valid on `127.0.0.1`; localhost confidentiality is left to the OS. No TLS termination in Phase 1.
- **CORS preflight.** `tower-http`'s `cors` is added to Cargo but not applied in Phase 1 (no browser client). Reserved for Phase 3+ if a web-based MCP inspector is added.

---

## Open items expected to surface during execution

These are not blockers for the plan but will need decisions in implementation:

- **Where does the Supabase URL + anon key come from in Rust?** Phase C uses `std::env::var("VITE_SUPABASE_URL")`. This relies on the dev / build invocation having those env vars set in the shell (Vite's `.env` file is read by Vite, not by Rust). Two follow-ups: (a) read from a custom `[plugins.notter]` block in `tauri.conf.json` (cleaner, more discoverable for production builds; needs a `tauri::Config` lookup at startup); (b) accept the values via a Tauri command `mcp_set_supabase_config` called from the front-end at startup (the front-end already has them via Vite). Option (b) is the simplest and most foolproof; option (a) is the cleanest.
- **`tauri::async_runtime::spawn` vs `tokio::spawn`** in `lib.rs::run::setup`. Tauri 2 wraps tokio; either works, but matching the existing convention (`ollama_install` doesn't spawn tasks itself, so there's no example) deserves a glance at any existing background-task patterns. Default: `tauri::async_runtime::spawn` for consistency with Tauri docs.
- **Cross-platform `127.0.0.1:0` behavior.** Tested on Windows during development. macOS and Linux are confirmed by the Tauri runtime (no Tauri-specific issue exists). One edge case: on Windows, the Defender Firewall sometimes prompts on first bind. Localhost binds usually skip the prompt; if the implementer hits a UAC dialog during smoke testing, document the behavior and the user-facing message.
- **`State::inner()` cloning.** `tauri::State<'_, McpState>::inner()` returns `&McpState`. Where `Arc<RwLock<...>>` clone is needed (e.g. handing the state to a spawned task), `.inner().clone()` works. Confirm during D1.
- **`thiserror` vs hand-rolled `Display`/`Error`.** Phase F uses hand-rolled because adding `thiserror` for one enum is overkill. If Phase H or beyond accumulates more error types, revisit.
- **`tower-http::trace::TraceLayer`.** Added to Cargo features but not applied in any `Router` layer in this plan. Easy add (`router.layer(TraceLayer::new_for_http())`) if the implementer wants request logging. Recommendation: add it conditionally on `cfg(debug_assertions)`.
- **Front-end emit at `src/lib/supabase.ts:43-52`.** That existing `emit('mcp:account-token-refreshed', ...)` becomes redundant once Phase I is complete. Two choices: (a) leave it in, harmless; (b) delete it. Recommendation: leave for now; revisit in a "M3 cleanup" follow-up commit.

---

## Self-review notes

### Review pass — 2026-05-10

A pre-execution review (manual, by the plan-author subagent — no Codex pass on this draft yet; only the upstream Phase 1 spec was Codex-reviewed) found and addressed the following:

| Issue | Fix |
|---|---|
| Spec §6.4 used `plan_id` / `plans` semantics; live schema is `subject_id` / `subjects` | Every tool renamed (`list_plans` → `list_subjects`, etc.). The Tools table documents the rename verbatim. |
| Spec §6.4 `post_revision` returns `{ version_id }` and writes to `plan_versions`; live `subject_versions` schema requires the same shape but different column name (`subject_id` not `plan_id`) | `post_subject_revision` payload uses `subject_id`. Trigger fills `user_id`. Tool name renamed. |
| Spec implies the Rust server reads the Supabase access token from a per-account refresh→access exchange held alongside the MCP token (§7 M3) | Spec §6.2 SUPERSEDES this with the "front-end is sole refresh owner" decision (Codex blocker). Plan reflects §6.2: access tokens are pushed via `mcp_update_account_token`; Rust never refreshes. |
| Spec `endpoint.json` shape (§6.1) includes `nonce`; observation 67 documents the fix | Plan implements the nonce + `X-Notter-Nonce` health probe as specified. Phase B unit tests cover it. |
| Spec mentions `chrono` implicitly via timestamp formatting | Hand-rolled RFC 3339 formatter to avoid a new dep (used only in informational `started_at`; the consumer is the user, not parsed by code). |
| Spec mentions `axum or hyper` | Picked `axum 0.8.9` per Context7 lookup. `hyper` direct would force us to write what axum gives us for free. |
| The smoke-test approach in Phase E + G requires a temporary `mcp_register_bearer` command; Phase I formalizes this | Plan calls this out explicitly. The temporary code paths in Phase G are reverted before commit; Phase I lands the real `mcp_register_bearer`. |
| `axum::middleware::from_fn_with_state` requires the state to be `Clone`; `McpState = Arc<RwLock<...>>` is Clone | Confirmed; no extra Clone derive needed. |
| Token-map race during account-rotation (rare): if a user removes account A and adds account B with the same bearer token (impossibly unlikely — 32 random bytes — but worth noting) | The `retain` + `insert` in `mcp_register_bearer` is idempotent; even if a stale token was somehow re-issued, the latest mapping wins. |
| Spec mentions a "MCP server disabled" UI surface | Phase J's `<McpConfigDialog>` shows the "MCP server unavailable" banner when `readMcpConfigForAccount` returns null (which happens when the per-account file is missing — i.e. the bind failed). The full "disabled state" propagation to a top-of-app banner is deferred to Phase J+ if the user requests it. |
| Phase D's `tauri://close-requested` deletion is best-effort; Ctrl-C / kill -9 leave the file behind | Phase B's nonce-based stale detection handles this on the next boot. Documented in Phase L step 8. |

### Original notes (still valid)

- **Schema reference is `2026-05-10-subject-versioning.sql`, NOT `2026-05-09-plan-model.sql` (which was dropped).** Re-confirm by `\d subject_versions` in psql before writing any tool that hits the table.
- **`set_subject_owner_id` trigger.** All inserts to `subject_versions` and `subject_comments` MUST omit `user_id` from the payload — the trigger fills it from `subjects.user_id`. This is exactly the same pattern as M2's `pushSubjectVersion` (`src/lib/sync.ts`).
- **No `pushSubjectComment` exposure.** Spec §6.4 explicitly excludes `post_comment` from the MCP tool surface. AI flows revise (write a new version), they do not chat in comments. UI is the only writer for `subject_comments`.
- **Realtime path is unchanged.** M2 already wired `subject_versions` and `subject_comments` into `realtime.ts` via `subscribeUserTable`. When the Rust server inserts a `subject_versions` row, the UI's existing subscription fires and `useSubjectVersionsStore.applyRemoteVersions` updates the in-memory slice. This means M3 does NOT need to touch the UI store at all to make the "Codex posted v4" toast / panel-update happen — it is already wired.
- **The 6 tools collectively form a read-then-revise loop.** A typical session: `list_subjects` → user picks one → `get_subject` (current `content`) → `list_versions` (history) → `get_version` (snapshot to compare against) → `list_comments` (review feedback) → AI computes new markdown → `post_subject_revision` (insert candidate). The user then sees it in PlannerTab and adopts via `adoptVersion`. Spec §6.5 happy-path matches this verbatim modulo the rename.
- **PATHFINDER systems referenced in M1/M2 do not affect M3.** M3's surface is Rust + a tiny TS bridge. No store-pattern unification is in scope.
- **`tower-http::cors` is unused in Phase 1** but added to Cargo features anyway. Adding it later would force a `cargo update`; including it now means future "drop in CORS" is a one-line addition. Three additional features were considered (`compression`, `auth`, `request-id`); none would benefit Phase 1 traffic patterns (localhost, single client, single envelope per request).
- **Two known follow-ups for M3.1 (post-merge):**
  1. The `emit('mcp:account-token-refreshed', ...)` in `src/lib/supabase.ts:43` is redundant once Phase I is in place. Delete in a small cleanup commit after merge.
  2. Replace `repopulate_bearer_tokens`'s no-op body with a direct keyring read at boot, so a fresh launch where the front-end hasn't yet bootstrapped accounts (rare race) still serves successfully. Currently the front-end always bootstraps before any MCP request can arrive (the user must be signed in to copy the token), so this is purely defensive.
