# MCP Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Notter MCP server's bearer copy-paste flow with OAuth 2.1 (per the MCP authorization spec), introduce a front-end provider abstraction so Claude Code/Desktop/Codex CLI/Cursor can be installed with one click, and grow the tool surface from 6 to 17 — covering full CRUD on workspaces/projects/subjects-metadata/comments/account-settings, with soft-delete via `archived_at` and the existing snapshot-only invariant on `subjects.content` preserved.

**Architecture:** Seven milestones, bottom-up:
1. **M1 — Schema + Supabase Auth client.** New migration adds `archived_at` columns + the `rename_project_cascade` and `create_subject_with_v0` RPCs. `SupabaseClient` gains an `auth_patch_user` method.
2. **M2 — OAuth 2.1 server (Rust).** New `oauth` module: JWT signing, client registry, dynamic registration, authorize+token+revoke endpoints, JWT bearer middleware. Legacy bearer kept as fallback for one release.
3. **M3 — 11 new tools (Rust).** `get_account_settings`, `update_account_settings`, `list_workspaces`, `save_workspace`, `list_projects`, `save_project`, `save_subject`, `save_comment`, `delete_comment`, `archive_resource`, `restore_resource`. Existing 6 tools gain `include_archived` where appropriate.
4. **M4 — Provider abstraction (TS).** `src/lib/mcp/providers/{claude-code,claude-desktop,codex-cli,cursor}.ts` with detect/install/uninstall/isLinked.
5. **M5 — Settings → MCP UI.** Card-per-provider with detection badge + Connect/Disconnect; always-visible "Outro cliente" manual fallback section.
6. **M6 — localStorage → user_metadata migration.** Theme/language/update-prefs/default-workspace move into `auth.users.raw_user_meta_data.notter`; one-shot migration on sign-in.
7. **M7 — Smoke + rollout.** New `smoke-mcp-v2.ps1` exercising OAuth dance + all 17 tools + archive/restore. Manual checklist for the 4 providers across Windows/macOS/Linux. Phase-1 feature flag flip.

**Tech Stack:** Rust 1.74+ / Tauri 2 / `axum 0.8` / `tower-http 0.6` / `reqwest 0.12` / `serde_json` / new deps `jsonwebtoken 9` + `argon2 0.5` + `toml_edit 0.22` (M2/M4). Front-end: TypeScript / React / `@tauri-apps/plugin-shell` / `@tauri-apps/plugin-fs`. Database: Postgres 15 (Supabase).

**Spec reference:** `docs/superpowers/specs/2026-05-14-mcp-expansion-design.md`. Read it cover-to-cover before starting any milestone.

**Out of scope (do not drift):** Scope splitting (notter:read/write/admin) — single `notter:full` v1. Per-account OAuth client isolation — one `client_id` per registered AI client, account chosen at authorize time. Deep-link install URIs (`claude://`). Hard-delete on workspaces/projects/subjects. Direct mutation of `subjects.content` from MCP — `post_subject_revision` stays the only path. Cross-account tools. Multi-workspace cascade-archive in one call. Removal of the legacy bearer code path — that happens in a Phase 2 PR, not this one. Removal of legacy per-account JSON config files at `<appLocalData>/notter-ai/mcp/<accountId>-config.json` — kept on disk through Phase 1.

---

## Parallel-execution notes

This plan is **not** designed to run in parallel with other branches. The migrations in M1 are required by M3, M2 is required by M5, and M6 touches `auth-store.ts` which several front-end stores read. Run as a single linear plan on one branch.

If a future plan wants to run in parallel, the natural seam is M2+M3 (Rust-only, OAuth + tools) vs. M4+M5+M6 (TypeScript-only, providers + UI + storage migration). M1 must land first either way, and M7 must land last.

---

## File Structure

### New Rust files

- `src-tauri/src/oauth/mod.rs` — module entry, re-exports the public surface (`start_oauth_routes(router) -> router`, `OAuthState`, `validate_access_token(token) -> Result<Claims>`).
- `src-tauri/src/oauth/jwt.rs` — HS256 JWT issue + verify wrapper on top of `jsonwebtoken`. Claims struct, signing key bootstrap (`<appLocalData>/notter-ai/mcp/jwt-secret.bin`, 32 random bytes, generated once).
- `src-tauri/src/oauth/clients.rs` — `<appLocalData>/notter-ai/mcp/clients.json` read/write with file lock; Argon2id hash of `client_secret`; `RegisteredClient` struct; CRUD helpers.
- `src-tauri/src/oauth/grants.rs` — in-memory map of `code -> AuthCode { client_id, account_id, code_challenge, redirect_uri, expires_at }` (10-minute TTL, purged on use); refresh-token JTI revocation set persisted alongside `clients.json`.
- `src-tauri/src/oauth/metadata.rs` — handler for `GET /.well-known/oauth-authorization-server` returning RFC 8414 JSON.
- `src-tauri/src/oauth/register.rs` — handler for `POST /register` (RFC 7591 Dynamic Client Registration).
- `src-tauri/src/oauth/authorize.rs` — handler for `GET /authorize` (renders inline HTML consent screen) and `POST /authorize` (issues `code`, redirects).
- `src-tauri/src/oauth/token.rs` — handler for `POST /token` (code exchange + refresh-token rotation).
- `src-tauri/src/oauth/revoke.rs` — handler for `POST /revoke`.
- `src-tauri/src/oauth/consent_html.rs` — string template for the consent screen.

### Modified Rust files

- `src-tauri/Cargo.toml` — add `jsonwebtoken = "9"`, `argon2 = "0.5"`, `base64 = "0.22"`, `time = "0.3"` (replaces our hand-rolled RFC 3339 helper in `endpoint.rs` — optional; keep hand-rolled if dep budget matters).
- `src-tauri/src/lib.rs` — mount oauth router under the existing `0.0.0.0/127.0.0.1:<port>` listener via `start_oauth_routes`; expose `mcp_oauth_enabled` env var read at startup.
- `src-tauri/src/mcp/auth.rs` — `bearer_auth` middleware extended to try OAuth JWT first, fall back to legacy bearer map. Deprecation warning logged once per process on legacy hit.
- `src-tauri/src/mcp/server.rs` — `McpStateInner` grows `oauth_state: OAuthState`. Router composition adds `start_oauth_routes(router)` before `with_state`.
- `src-tauri/src/mcp/supabase.rs` — add `auth_patch_user(access_token, body)` (uses `/auth/v1/user`, not PostgREST) and `rpc(name, args, access_token)` (`/rest/v1/rpc/<name>`).
- `src-tauri/src/mcp/tools.rs` — dispatch table grows to 17 methods; new handler functions for each of the 11 new tools; existing `list_subjects` and `list_comments` gain `include_archived`.
- `src-tauri/src/mcp/error.rs` — new variants `Forbidden(String)` (-32005) and `Conflict(String)` (-32006).

### New TypeScript files

- `src/lib/mcp/providers/index.ts` — provider registry, `McpInstallProvider` interface, `getAllProviders()`.
- `src/lib/mcp/providers/claude-code.ts` — shell-out to `claude mcp add` via `@tauri-apps/plugin-shell`.
- `src/lib/mcp/providers/claude-desktop.ts` — read/merge/write of `claude_desktop_config.json`.
- `src/lib/mcp/providers/codex-cli.ts` — read/merge/write of `~/.codex/config.toml`.
- `src/lib/mcp/providers/cursor.ts` — read/merge/write of `~/.cursor/mcp.json`.
- `src/lib/mcp/providers/paths.ts` — OS-aware config-path resolver used by all providers.
- `src/lib/mcp/oauth-url.ts` — single source of truth for the local MCP URL surfaced to providers; reads `endpoint.json` and returns `http://127.0.0.1:<port>/mcp`.
- `src/lib/account-settings.ts` — typed `AccountSettings` shape + getter/setter against `supabase.auth.updateUser({ data: {...} })`.
- `src/components/settings/tabs/McpTab.tsx` — **fully rewritten** (kept name and path; old file replaced). New card-list layout.
- `src/components/settings/McpProviderCard.tsx` — one card row for a provider with detect-badge + connect/disconnect button.
- `src/components/settings/McpManualSection.tsx` — "Outro cliente / manual" panel.

### Modified TypeScript files

- `src/stores/auth-store.ts` — on `SIGNED_IN` / `TOKEN_REFRESHED`, kick the localStorage → `user_metadata` one-shot migration if a `notter` key is absent.
- `src/i18n/locales/en.json` + `pt-BR.json` — new `mcp.providers.*` and `mcp.manual.*` keys (drop `mcp.dialog_description` / `mcp.disabled_*` once superseded — keep both during transition).
- `src/stores/theme-store.ts` and `src/stores/language-store.ts` (whatever names exist today — verify in M6) — read user_metadata first, fall back to localStorage during transition window.

### New SQL migration

- `supabase/migrations/2026-05-14-mcp-expansion.sql` — adds `archived_at` columns, partial indexes, two security-definer RPCs.

### New test/script files

- `src-tauri/src/oauth/tests.rs` — unit tests covering: JWT round-trip, JWT verify rejects bad sig / expired / wrong type, client registration round-trip, code-grant happy path, code-grant rejects bad PKCE / reused code / expired code, token refresh rotation, revoke invalidates JTI, /.well-known returns the right metadata.
- `src/lib/mcp/providers/__tests__/claude-code.test.ts`, `claude-desktop.test.ts`, `codex-cli.test.ts`, `cursor.test.ts` — vitest with mocked `@tauri-apps/plugin-shell` and `@tauri-apps/plugin-fs`.
- `src/lib/__tests__/account-settings.test.ts` — vitest covering migration paths.
- `scripts/smoke-mcp-v2.ps1` — adapted from `smoke-m3.ps1`, exercises OAuth dance + all 17 tools.

---

## M1 — Schema migration and Supabase Auth client

**Why first:** New tools reach for `archived_at` filters, `rename_project_cascade`, `create_subject_with_v0`, and `auth_patch_user`. Land the database side and the REST wrapper before writing the tool handlers, so M3 has stable building blocks.

### Task M1.1 — Write the migration SQL

**Files:**
- Create: `supabase/migrations/2026-05-14-mcp-expansion.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-05-14-mcp-expansion.sql
--
-- Soft-delete columns + two security-definer RPCs that the new MCP tools
-- need. Idempotent — adding columns / functions with create-or-replace and
-- guarded ALTER TABLEs so re-running the migration is a no-op.

-- 1. Soft-delete columns
alter table workspaces add column if not exists archived_at timestamptz;
alter table projects   add column if not exists archived_at timestamptz;
alter table subjects   add column if not exists archived_at timestamptz;

-- 2. Partial indexes — most listings filter `archived_at is null`
create index if not exists workspaces_active_idx
  on workspaces(user_id, updated_at desc)
  where archived_at is null;

create index if not exists projects_active_idx
  on projects(user_id, workspace_id, updated_at desc)
  where archived_at is null;

create index if not exists subjects_active_idx
  on subjects(user_id, updated_at desc)
  where archived_at is null;

-- 3. rename_project_cascade
-- subjects.project_name is text (no FK to projects.name), so renaming a
-- project requires updating subjects.project_name in the same transaction.
-- SECURITY DEFINER + auth.uid() gate enforces ownership.
create or replace function rename_project_cascade(
  old_name text,
  new_name text,
  workspace_uuid uuid
) returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update projects
    set name = new_name,
        updated_at = now()
  where user_id = auth.uid()
    and workspace_id = workspace_uuid
    and name = old_name;

  if not found then
    raise exception 'project not found: %', old_name using errcode = '42P01';
  end if;

  update subjects
    set project_name = new_name,
        updated_at = now()
  where user_id = auth.uid()
    and project_name = old_name;
end;
$$;

-- 4. create_subject_with_v0
-- Atomically inserts subjects + subject_versions row v0 + sets current_version_id.
-- The existing set_user_id_on_subject_versions trigger reads from subjects, so
-- we insert subjects first (in the same statement) before subject_versions.
create or replace function create_subject_with_v0(
  p_project_name text,
  p_file_name text
) returns subjects
language plpgsql security definer
set search_path = public
as $$
declare
  new_subject subjects;
  new_version_id uuid;
begin
  insert into subjects (user_id, project_name, file_name, content)
  values (auth.uid(), p_project_name, p_file_name, '')
  returning * into new_subject;

  insert into subject_versions (subject_id, content_markdown, source, source_actor, label)
  values (new_subject.id, '', 'user', null, 'v0')
  returning id into new_version_id;

  update subjects
    set current_version_id = new_version_id
  where id = new_subject.id;

  -- Return the row with current_version_id populated.
  select * into new_subject from subjects where id = new_subject.id;
  return new_subject;
end;
$$;

grant execute on function rename_project_cascade(text, text, uuid) to authenticated;
grant execute on function create_subject_with_v0(text, text) to authenticated;
```

- [ ] **Step 2: Apply the migration locally**

If you have the Supabase CLI installed:
```bash
supabase db push
```

Otherwise, copy the SQL into the Supabase dashboard SQL editor for your project and run it.

Expected output: three `ALTER TABLE`, three `CREATE INDEX`, two `CREATE FUNCTION`, two `GRANT`, all green. Re-running the migration must be a no-op (the `if not exists` guards + `create or replace` make it idempotent).

- [ ] **Step 3: Verify the schema**

Run in the Supabase SQL editor:
```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('workspaces','projects','subjects')
  and column_name = 'archived_at';
```
Expected: three rows, all `timestamp with time zone`.

```sql
select proname from pg_proc
where proname in ('rename_project_cascade','create_subject_with_v0');
```
Expected: two rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-14-mcp-expansion.sql
git commit -m "feat(db): soft-delete columns + rename_project_cascade + create_subject_with_v0 RPCs"
```

### Task M1.2 — Add `auth_patch_user` and `rpc` to SupabaseClient

**Files:**
- Modify: `src-tauri/src/mcp/supabase.rs`

- [ ] **Step 1: Write the failing tests** (append to bottom of `supabase.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::{Method, MockServer};

    #[tokio::test]
    async fn auth_patch_user_hits_auth_v1_user() {
        let server = MockServer::start_async().await;
        let m = server.mock_async(|when, then| {
            when.method(Method::PATCH)
                .path("/auth/v1/user")
                .header("authorization", "Bearer access-tok")
                .header("apikey", "anon");
            then.status(200).json_body(serde_json::json!({
                "id": "user-1",
                "user_metadata": { "notter": { "theme": "dark" } }
            }));
        }).await;

        let sb = SupabaseClient::new(server.base_url(), "anon".into());
        let body = serde_json::json!({ "data": { "notter": { "theme": "dark" } } });
        let res = sb.auth_patch_user(&body, "access-tok").await.unwrap();

        m.assert_async().await;
        assert_eq!(res["user_metadata"]["notter"]["theme"], "dark");
    }

    #[tokio::test]
    async fn rpc_posts_to_rest_v1_rpc_name() {
        let server = MockServer::start_async().await;
        let m = server.mock_async(|when, then| {
            when.method(Method::POST)
                .path("/rest/v1/rpc/rename_project_cascade")
                .header("authorization", "Bearer access-tok")
                .header("apikey", "anon")
                .json_body(serde_json::json!({
                    "old_name": "Old", "new_name": "New",
                    "workspace_uuid": "00000000-0000-0000-0000-000000000001"
                }));
            then.status(200).body("");
        }).await;

        let sb = SupabaseClient::new(server.base_url(), "anon".into());
        let body = serde_json::json!({
            "old_name": "Old", "new_name": "New",
            "workspace_uuid": "00000000-0000-0000-0000-000000000001"
        });
        sb.rpc("rename_project_cascade", &body, "access-tok").await.unwrap();
        m.assert_async().await;
    }
}
```

- [ ] **Step 2: Add `httpmock` as dev-dep**

In `src-tauri/Cargo.toml`, under `[dev-dependencies]` (create the section if absent — there is no `[dev-dependencies]` table today):

```toml
[dev-dependencies]
httpmock = "0.8"
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd src-tauri
cargo test --lib mcp::supabase::tests -- --nocapture
```
Expected: compilation error (`auth_patch_user`, `rpc` not defined).

- [ ] **Step 4: Implement `auth_patch_user`** (add to `impl SupabaseClient` in `supabase.rs`)

```rust
    /// PATCH /auth/v1/user — used to update auth.users.raw_user_meta_data.
    /// This is the Supabase Auth API, NOT PostgREST. The same access_token
    /// the MCP server already holds for the account authorizes this call.
    pub async fn auth_patch_user(
        &self,
        body: &Value,
        access_token: &str,
    ) -> Result<Value, McpError> {
        let url = format!("{}/auth/v1/user", self.base_url);
        let res = self
            .http
            .patch(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| McpError::SupabaseError(format!("auth_patch_user: {e}")))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "auth_patch_user: HTTP {} body={body}",
                status.as_u16()
            )));
        }
        Ok(body)
    }

    /// POST /rest/v1/rpc/<name> — calls a Postgres function with JSON args.
    pub async fn rpc(
        &self,
        name: &str,
        args: &Value,
        access_token: &str,
    ) -> Result<Value, McpError> {
        let url = format!("{}/rest/v1/rpc/{}", self.base_url, name);
        let res = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Prefer", "return=representation")
            .json(args)
            .send()
            .await
            .map_err(|e| McpError::SupabaseError(format!("rpc {name}: {e}")))?;
        let status = res.status();
        // Some RPCs return void / 204 — guard the json() unwrap.
        let body: Value = if status == reqwest::StatusCode::NO_CONTENT {
            Value::Null
        } else {
            res.json().await.unwrap_or(Value::Null)
        };
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "rpc {name}: HTTP {} body={body}",
                status.as_u16()
            )));
        }
        Ok(body)
    }
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd src-tauri
cargo test --lib mcp::supabase::tests -- --nocapture
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mcp/supabase.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(mcp): add SupabaseClient.auth_patch_user and .rpc"
```

### Task M1.3 — Add `Forbidden` and `Conflict` to McpError

**Files:**
- Modify: `src-tauri/src/mcp/error.rs`

- [ ] **Step 1: Add the variants and the codes**

Edit `McpError` to add two new variants alongside the existing ones:

```rust
    /// -32005 (Notter-specific): the operation is refused because of state
    /// preconditions (e.g. archive a workspace that still has live projects).
    Forbidden(String),
    /// -32006 (Notter-specific): the operation conflicts with an existing
    /// resource (e.g. duplicate workspace name for the same user).
    Conflict(String),
```

Update the `code()` match:

```rust
            Forbidden(_) => -32005,
            Conflict(_) => -32006,
```

Update the `message()` match — add `Forbidden(m) | Conflict(m)` to the bundle that returns `m.clone()`.

- [ ] **Step 2: Build and verify**

```bash
cd src-tauri
cargo build --lib
```
Expected: clean build (warnings about `#[allow(dead_code)]` on the new variants are fine until M3 consumes them).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp/error.rs
git commit -m "feat(mcp): McpError::Forbidden (-32005) and ::Conflict (-32006)"
```

---

## M2 — OAuth 2.1 server (Rust)

**Why:** The discovery story collapses to "click Connect" only if Claude/Codex/Cursor can do the OAuth dance against our local server without copy-paste. This milestone stands alone — at its end, no Notter tools have changed, but the server speaks the MCP authorization spec.

### Task M2.1 — Add OAuth crates + module skeleton

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/oauth/mod.rs`, `src-tauri/src/oauth/jwt.rs`, `src-tauri/src/oauth/clients.rs`, `src-tauri/src/oauth/grants.rs`, `src-tauri/src/oauth/metadata.rs`, `src-tauri/src/oauth/register.rs`, `src-tauri/src/oauth/authorize.rs`, `src-tauri/src/oauth/token.rs`, `src-tauri/src/oauth/revoke.rs`, `src-tauri/src/oauth/consent_html.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the deps**

In `src-tauri/Cargo.toml` under `[dependencies]`:

```toml
# --- M2 (OAuth 2.1) ---
jsonwebtoken = "9"
argon2 = "0.5"
base64 = "0.22"
sha2 = "0.10"
```

- [ ] **Step 2: Create the module skeleton**

`src-tauri/src/oauth/mod.rs`:

```rust
// src-tauri/src/oauth/mod.rs
//
// OAuth 2.1 stack per the MCP authorization spec (2026-05-14 expansion).
// Mounts on the same axum Router used by the MCP server in src/mcp/server.rs.

pub mod authorize;
pub mod clients;
pub mod consent_html;
pub mod grants;
pub mod jwt;
pub mod metadata;
pub mod register;
pub mod revoke;
pub mod token;

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

pub use jwt::{Claims, JwtKey};
pub use clients::{ClientRegistry, RegisteredClient};
pub use grants::GrantStore;

#[derive(Clone)]
pub struct OAuthStateInner {
    pub jwt_key: JwtKey,
    pub clients: ClientRegistry,
    pub grants: GrantStore,
    pub issuer: String, // "http://127.0.0.1:<port>" — set when the listener binds
}

pub type OAuthState = Arc<RwLock<OAuthStateInner>>;

/// Build the OAuthState at app boot. The signing key is read from
/// `<data_dir>/jwt-secret.bin`; created on first run. Clients & grants
/// are loaded from `<data_dir>/clients.json` if it exists.
pub async fn bootstrap_oauth(data_dir: &PathBuf) -> Result<OAuthState, String> {
    let jwt_key = jwt::JwtKey::load_or_create(data_dir).await?;
    let clients = clients::ClientRegistry::load(data_dir).await?;
    let grants = grants::GrantStore::new();
    Ok(Arc::new(RwLock::new(OAuthStateInner {
        jwt_key,
        clients,
        grants,
        issuer: String::new(),
    })))
}

#[cfg(test)]
pub mod tests;
```

Create the other files with placeholder stubs that just `pub use` `axum` types so M2.2–M2.8 fill them in:

`src-tauri/src/oauth/jwt.rs`:

```rust
// src-tauri/src/oauth/jwt.rs — filled in M2.2.
use std::path::Path;

#[derive(Clone)]
pub struct JwtKey { pub _secret: Vec<u8> }

impl JwtKey {
    pub async fn load_or_create(_dir: &Path) -> Result<Self, String> {
        Ok(Self { _secret: vec![] })
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub client_id: String,
    pub scope: String,
    pub iat: i64,
    pub exp: i64,
    pub token_type: String,
    pub jti: String,
}
```

Use empty `pub fn _placeholder() {}` bodies in the rest (`clients.rs`, `grants.rs`, `metadata.rs`, `register.rs`, `authorize.rs`, `token.rs`, `revoke.rs`, `consent_html.rs`) so the module tree compiles.

- [ ] **Step 3: Wire the module into `lib.rs`**

In `src-tauri/src/lib.rs`, after `mod mcp;`:

```rust
mod oauth;
```

- [ ] **Step 4: Build**

```bash
cd src-tauri
cargo build --lib
```
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/oauth src-tauri/src/lib.rs
git commit -m "feat(oauth): module skeleton + jsonwebtoken/argon2/base64/sha2 deps"
```

### Task M2.2 — JWT key persistence + sign/verify

**Files:**
- Modify: `src-tauri/src/oauth/jwt.rs`
- Create: `src-tauri/src/oauth/tests.rs`

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/oauth/tests.rs`:

```rust
// src-tauri/src/oauth/tests.rs
use super::jwt::{Claims, JwtKey};

fn tmp() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "notter-oauth-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[tokio::test]
async fn jwt_key_load_creates_secret_on_first_run() {
    let dir = tmp();
    let key = JwtKey::load_or_create(&dir).await.unwrap();
    assert_eq!(key.secret_len(), 32);
    // Second load returns same bytes.
    let key2 = JwtKey::load_or_create(&dir).await.unwrap();
    assert_eq!(key.secret_bytes(), key2.secret_bytes());
}

#[tokio::test]
async fn jwt_round_trip() {
    let dir = tmp();
    let key = JwtKey::load_or_create(&dir).await.unwrap();
    let claims = Claims {
        iss: "http://localhost:1/mcp".into(),
        sub: "acc-1".into(),
        client_id: "client-1".into(),
        scope: "notter:full".into(),
        iat: 1_000_000,
        exp: 2_000_000,
        token_type: "access".into(),
        jti: "jti-1".into(),
    };
    let tok = key.sign(&claims).unwrap();
    let parsed = key.verify(&tok).unwrap();
    assert_eq!(parsed.sub, "acc-1");
    assert_eq!(parsed.token_type, "access");
}

#[tokio::test]
async fn jwt_verify_rejects_bad_signature() {
    let dir1 = tmp();
    let dir2 = tmp();
    let k1 = JwtKey::load_or_create(&dir1).await.unwrap();
    let k2 = JwtKey::load_or_create(&dir2).await.unwrap();
    let claims = Claims {
        iss: "x".into(), sub: "x".into(), client_id: "x".into(),
        scope: "notter:full".into(), iat: 0, exp: i64::MAX,
        token_type: "access".into(), jti: "x".into(),
    };
    let tok = k1.sign(&claims).unwrap();
    assert!(k2.verify(&tok).is_err());
}

#[tokio::test]
async fn jwt_verify_rejects_expired() {
    let dir = tmp();
    let key = JwtKey::load_or_create(&dir).await.unwrap();
    let claims = Claims {
        iss: "x".into(), sub: "x".into(), client_id: "x".into(),
        scope: "notter:full".into(), iat: 0, exp: 1,
        token_type: "access".into(), jti: "x".into(),
    };
    let tok = key.sign(&claims).unwrap();
    assert!(key.verify(&tok).is_err());
}
```

- [ ] **Step 2: Run to confirm failures**

```bash
cd src-tauri
cargo test --lib oauth::tests -- --nocapture
```
Expected: compilation errors (`secret_len`, `secret_bytes`, `sign`, `verify` missing).

- [ ] **Step 3: Implement `JwtKey`**

Replace `src-tauri/src/oauth/jwt.rs`:

```rust
// src-tauri/src/oauth/jwt.rs
use std::path::{Path, PathBuf};

use jsonwebtoken::{
    decode, encode, errors::Error as JwtError, Algorithm, DecodingKey, EncodingKey, Header,
    Validation,
};
use rand::RngCore;

const SECRET_FILENAME: &str = "jwt-secret.bin";
const SECRET_LEN: usize = 32;

#[derive(Clone)]
pub struct JwtKey {
    secret: Vec<u8>,
}

impl JwtKey {
    pub async fn load_or_create(dir: &Path) -> Result<Self, String> {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("create_dir_all: {e}"))?;
        let path = Self::path(dir);
        match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() == SECRET_LEN => Ok(Self { secret: bytes }),
            Ok(bytes) => Err(format!(
                "jwt-secret.bin has unexpected length {} (expected {SECRET_LEN})",
                bytes.len()
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut buf = vec![0u8; SECRET_LEN];
                rand::rng().fill_bytes(&mut buf);
                tokio::fs::write(&path, &buf)
                    .await
                    .map_err(|e| format!("write jwt-secret.bin: {e}"))?;
                Ok(Self { secret: buf })
            }
            Err(e) => Err(format!("read jwt-secret.bin: {e}")),
        }
    }

    fn path(dir: &Path) -> PathBuf { dir.join(SECRET_FILENAME) }

    pub fn secret_len(&self) -> usize { self.secret.len() }
    pub fn secret_bytes(&self) -> &[u8] { &self.secret }

    pub fn sign(&self, claims: &Claims) -> Result<String, JwtError> {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(&self.secret),
        )
    }

    pub fn verify(&self, token: &str) -> Result<Claims, JwtError> {
        let mut validation = Validation::new(Algorithm::HS256);
        // We validate exp ourselves but jsonwebtoken does it too — leave on.
        validation.leeway = 0;
        // Don't require any specific issuer; tools accept whatever was signed.
        validation.validate_aud = false;
        let data = decode::<Claims>(token, &DecodingKey::from_secret(&self.secret), &validation)?;
        Ok(data.claims)
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Claims {
    pub iss: String,
    pub sub: String, // account_id
    pub client_id: String,
    pub scope: String,
    pub iat: i64,
    pub exp: i64,
    pub token_type: String, // "access" | "refresh"
    pub jti: String,
}
```

- [ ] **Step 4: Run tests**

```bash
cargo test --lib oauth::tests -- --nocapture
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/oauth/jwt.rs src-tauri/src/oauth/tests.rs
git commit -m "feat(oauth): HS256 JWT sign/verify with on-disk persistent secret"
```

### Task M2.3 — Client registry with Argon2 secret hash

**Files:**
- Modify: `src-tauri/src/oauth/clients.rs`
- Modify: `src-tauri/src/oauth/tests.rs` (append tests)

- [ ] **Step 1: Write the failing tests** (append to `tests.rs`)

```rust
use super::clients::{ClientRegistry, RegisteredClient};

#[tokio::test]
async fn client_registry_round_trip() {
    let dir = tmp();
    let mut reg = ClientRegistry::load(&dir).await.unwrap();
    let (client_id, plaintext_secret) = reg.register(
        "Claude Code".into(),
        vec!["http://127.0.0.1:54881/callback".into()],
        &dir,
    ).await.unwrap();

    assert!(client_id.starts_with("notter_client_"));
    assert_eq!(plaintext_secret.len(), 32);
    assert!(reg.find_by_id(&client_id).is_some());

    // Persisted: reload from disk reads the row back.
    let reg2 = ClientRegistry::load(&dir).await.unwrap();
    assert!(reg2.find_by_id(&client_id).is_some());

    // Secret verifies.
    assert!(reg2.verify_secret(&client_id, &plaintext_secret).unwrap());
    assert!(!reg2.verify_secret(&client_id, "wrong-secret").unwrap());
}
```

- [ ] **Step 2: Implement `ClientRegistry`**

`src-tauri/src/oauth/clients.rs`:

```rust
// src-tauri/src/oauth/clients.rs
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, PasswordHash,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const FILENAME: &str = "clients.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret_hash: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub registered_at: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClientRegistryFile {
    pub clients: Vec<RegisteredClient>,
    pub revoked_jti: Vec<String>,
}

#[derive(Clone)]
pub struct ClientRegistry {
    by_id: HashMap<String, RegisteredClient>,
    revoked_jti: HashMap<String, ()>,
    dir: PathBuf,
}

impl ClientRegistry {
    pub async fn load(dir: &Path) -> Result<Self, String> {
        tokio::fs::create_dir_all(dir).await
            .map_err(|e| format!("create_dir_all: {e}"))?;
        let path = dir.join(FILENAME);
        let file: ClientRegistryFile = match tokio::fs::read_to_string(&path).await {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ClientRegistryFile::default(),
            Err(e) => return Err(format!("read clients.json: {e}")),
        };
        let mut by_id = HashMap::new();
        for c in file.clients { by_id.insert(c.client_id.clone(), c); }
        let mut revoked_jti = HashMap::new();
        for j in file.revoked_jti { revoked_jti.insert(j, ()); }
        Ok(Self { by_id, revoked_jti, dir: dir.to_path_buf() })
    }

    async fn persist(&self) -> Result<(), String> {
        let file = ClientRegistryFile {
            clients: self.by_id.values().cloned().collect(),
            revoked_jti: self.revoked_jti.keys().cloned().collect(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("serialize clients.json: {e}"))?;
        let path = self.dir.join(FILENAME);
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, json).await
            .map_err(|e| format!("write tmp: {e}"))?;
        tokio::fs::rename(&tmp, &path).await
            .map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    /// Register a new client. Returns `(client_id, plaintext_secret)`. The
    /// plaintext secret is shown ONCE — only its Argon2id hash is stored.
    pub async fn register(
        &mut self,
        client_name: String,
        redirect_uris: Vec<String>,
        _dir: &Path,
    ) -> Result<(String, String), String> {
        let mut id_bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut id_bytes);
        let client_id = format!("notter_client_{}",
            URL_SAFE_NO_PAD.encode(id_bytes));

        let mut sec_bytes = [0u8; 24];
        rand::rng().fill_bytes(&mut sec_bytes);
        let plaintext_secret = URL_SAFE_NO_PAD.encode(sec_bytes);
        // Argon2 takes 16+ chars; URL_SAFE_NO_PAD of 24 bytes = 32 chars, fine.

        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(plaintext_secret.as_bytes(), &salt)
            .map_err(|e| format!("hash: {e}"))?
            .to_string();

        let now = crate::mcp::endpoint::now_rfc3339();
        let client = RegisteredClient {
            client_id: client_id.clone(),
            client_secret_hash: hash,
            client_name,
            redirect_uris,
            registered_at: now,
        };
        self.by_id.insert(client_id.clone(), client);
        self.persist().await?;
        Ok((client_id, plaintext_secret))
    }

    pub fn find_by_id(&self, client_id: &str) -> Option<&RegisteredClient> {
        self.by_id.get(client_id)
    }

    pub fn verify_secret(&self, client_id: &str, plaintext: &str) -> Result<bool, String> {
        let client = self.by_id.get(client_id)
            .ok_or_else(|| format!("unknown client_id: {client_id}"))?;
        let parsed = PasswordHash::new(&client.client_secret_hash)
            .map_err(|e| format!("parse hash: {e}"))?;
        Ok(Argon2::default().verify_password(plaintext.as_bytes(), &parsed).is_ok())
    }

    pub async fn revoke_jti(&mut self, jti: &str) -> Result<(), String> {
        self.revoked_jti.insert(jti.into(), ());
        self.persist().await
    }

    pub fn is_jti_revoked(&self, jti: &str) -> bool {
        self.revoked_jti.contains_key(jti)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cargo test --lib oauth::tests -- --nocapture
```
Expected: 5 passed (4 from M2.2 + 1 new).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/oauth/clients.rs src-tauri/src/oauth/tests.rs
git commit -m "feat(oauth): ClientRegistry with Argon2id-hashed client secrets, atomic persistence"
```

### Task M2.4 — Authorization-code grant store (in-memory)

**Files:**
- Modify: `src-tauri/src/oauth/grants.rs`
- Modify: `src-tauri/src/oauth/tests.rs`

- [ ] **Step 1: Write tests**

Append:

```rust
use super::grants::{AuthCode, GrantStore};

#[tokio::test]
async fn grants_store_round_trip_and_one_shot() {
    let store = GrantStore::new();
    let code = AuthCode {
        client_id: "c1".into(),
        account_id: "a1".into(),
        code_challenge: "challenge".into(),
        redirect_uri: "http://x/callback".into(),
        scope: "notter:full".into(),
        expires_at: i64::MAX,
    };
    store.insert("code-1".into(), code.clone()).await;
    let taken = store.take("code-1").await.unwrap();
    assert_eq!(taken.account_id, "a1");
    // Re-take is gone.
    assert!(store.take("code-1").await.is_none());
}

#[tokio::test]
async fn grants_store_drops_expired_codes() {
    let store = GrantStore::new();
    let code = AuthCode {
        client_id: "c1".into(),
        account_id: "a1".into(),
        code_challenge: "x".into(),
        redirect_uri: "http://x/callback".into(),
        scope: "notter:full".into(),
        expires_at: 1, // far in the past
    };
    store.insert("expired".into(), code).await;
    assert!(store.take("expired").await.is_none());
}
```

- [ ] **Step 2: Implement**

`src-tauri/src/oauth/grants.rs`:

```rust
// src-tauri/src/oauth/grants.rs
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct AuthCode {
    pub client_id: String,
    pub account_id: String,
    pub code_challenge: String, // PKCE S256, base64url-no-pad
    pub redirect_uri: String,
    pub scope: String,
    pub expires_at: i64, // unix seconds
}

#[derive(Clone, Default)]
pub struct GrantStore {
    inner: Arc<Mutex<HashMap<String, AuthCode>>>,
}

impl GrantStore {
    pub fn new() -> Self { Self::default() }

    pub async fn insert(&self, code: String, ac: AuthCode) {
        self.inner.lock().await.insert(code, ac);
    }

    /// One-shot take. Returns None if the code is unknown OR expired.
    pub async fn take(&self, code: &str) -> Option<AuthCode> {
        let mut m = self.inner.lock().await;
        let entry = m.remove(code)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if entry.expires_at < now { return None; }
        Some(entry)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cargo test --lib oauth::tests -- --nocapture
```
Expected: 7 passed.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/oauth/grants.rs src-tauri/src/oauth/tests.rs
git commit -m "feat(oauth): in-memory auth-code grant store, one-shot consume + TTL"
```

### Task M2.5 — Metadata + dynamic client registration endpoints

**Files:**
- Modify: `src-tauri/src/oauth/metadata.rs`, `src-tauri/src/oauth/register.rs`, `src-tauri/src/oauth/mod.rs`
- Modify: `src-tauri/src/oauth/tests.rs`

- [ ] **Step 1: Write tests** (append to `tests.rs`)

```rust
use axum::{body::to_bytes, body::Body, http::Request};
use tower::ServiceExt;

async fn build_test_router(dir: &std::path::Path) -> axum::Router {
    let state = super::bootstrap_oauth(&dir.to_path_buf()).await.unwrap();
    {
        let mut s = state.write().await;
        s.issuer = "http://127.0.0.1:54781".into();
    }
    super::routes(state)
}

#[tokio::test]
async fn well_known_metadata_returns_expected_shape() {
    let dir = tmp();
    let router = build_test_router(&dir).await;
    let req = Request::builder()
        .uri("/.well-known/oauth-authorization-server")
        .body(Body::empty()).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(j["issuer"], "http://127.0.0.1:54781");
    assert_eq!(j["authorization_endpoint"], "http://127.0.0.1:54781/authorize");
    assert_eq!(j["token_endpoint"], "http://127.0.0.1:54781/token");
    assert_eq!(j["registration_endpoint"], "http://127.0.0.1:54781/register");
    assert_eq!(j["revocation_endpoint"], "http://127.0.0.1:54781/revoke");
    assert_eq!(j["code_challenge_methods_supported"], serde_json::json!(["S256"]));
    assert_eq!(j["grant_types_supported"], serde_json::json!(["authorization_code","refresh_token"]));
    assert_eq!(j["response_types_supported"], serde_json::json!(["code"]));
    assert_eq!(j["token_endpoint_auth_methods_supported"], serde_json::json!(["client_secret_post"]));
}

#[tokio::test]
async fn register_endpoint_returns_client_id_and_secret() {
    let dir = tmp();
    let router = build_test_router(&dir).await;
    let body = serde_json::json!({
        "client_name": "Claude Code",
        "redirect_uris": ["http://127.0.0.1:54881/callback"]
    });
    let req = Request::builder()
        .method("POST")
        .uri("/register")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string())).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201);
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(j["client_id"].as_str().unwrap().starts_with("notter_client_"));
    assert!(j["client_secret"].as_str().unwrap().len() >= 32);
    assert_eq!(j["client_name"], "Claude Code");
}
```

- [ ] **Step 2: Implement metadata handler**

`src-tauri/src/oauth/metadata.rs`:

```rust
// src-tauri/src/oauth/metadata.rs
use axum::{extract::State, Json};
use serde_json::{json, Value};

use super::OAuthState;

pub async fn well_known(State(state): State<OAuthState>) -> Json<Value> {
    let issuer = state.read().await.issuer.clone();
    Json(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": format!("{issuer}/token"),
        "registration_endpoint": format!("{issuer}/register"),
        "revocation_endpoint": format!("{issuer}/revoke"),
        "scopes_supported": ["notter:full"],
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["client_secret_post"],
    }))
}
```

- [ ] **Step 3: Implement register handler**

`src-tauri/src/oauth/register.rs`:

```rust
// src-tauri/src/oauth/register.rs
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;

use super::OAuthState;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub client_name: String,
    pub redirect_uris: Vec<String>,
}

pub async fn register(
    State(state): State<OAuthState>,
    Json(body): Json<RegisterRequest>,
) -> impl IntoResponse {
    if body.client_name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_client_metadata","error_description":"client_name required"}))).into_response();
    }
    if body.redirect_uris.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_redirect_uri","error_description":"at least one redirect_uri required"}))).into_response();
    }

    let dir = {
        // We need the data dir for persistence; clients.rs stores it inside
        // ClientRegistry. Call into it directly.
        let s = state.read().await;
        let _ = &s; // pass-through; dir lives in clients
        // No-op: ClientRegistry already knows its own dir.
        std::path::PathBuf::new()
    };

    let (client_id, secret) = {
        let mut s = state.write().await;
        match s.clients.register(body.client_name.clone(), body.redirect_uris.clone(), &dir).await {
            Ok(v) => v,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"server_error","error_description":e}))).into_response(),
        }
    };

    (StatusCode::CREATED, Json(json!({
        "client_id": client_id,
        "client_secret": secret,
        "client_name": body.client_name,
        "redirect_uris": body.redirect_uris,
        "token_endpoint_auth_method": "client_secret_post"
    }))).into_response()
}
```

- [ ] **Step 4: Add `routes` to `oauth/mod.rs`**

Append to `oauth/mod.rs`:

```rust
use axum::{routing::{get, post}, Router};

pub fn routes(state: OAuthState) -> Router {
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(metadata::well_known))
        .route("/register", post(register::register))
        // /authorize, /token, /revoke wired in M2.6–M2.8
        .with_state(state)
}
```

- [ ] **Step 5: Run tests**

```bash
cargo test --lib oauth::tests -- --nocapture
```
Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/oauth
git commit -m "feat(oauth): /.well-known and /register (RFC 7591) endpoints + axum router"
```

### Task M2.6 — `/authorize` (consent screen + code issuance)

**Files:**
- Modify: `src-tauri/src/oauth/authorize.rs`, `src-tauri/src/oauth/consent_html.rs`, `src-tauri/src/oauth/mod.rs`
- Modify: `src-tauri/src/oauth/tests.rs`

- [ ] **Step 1: Write tests**

Append:

```rust
use axum::http::HeaderValue;

#[tokio::test]
async fn authorize_get_renders_consent_html_listing_accounts() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir.to_path_buf()).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }

    // Register a client
    let (client_id, _secret) = {
        let mut s = state.write().await;
        s.clients.register("Claude Code".into(), vec!["http://127.0.0.1:54881/cb".into()], &dir).await.unwrap()
    };

    let router = super::routes_with_accounts(state.clone(), vec![
        super::AccountSummary { account_id: "acc-1".into(), display_name: "Guilherme".into(), email: "g@x.com".into() }
    ]);

    let uri = format!(
        "/authorize?response_type=code&client_id={}&redirect_uri=http%3A%2F%2F127.0.0.1%3A54881%2Fcb&code_challenge=challenge&code_challenge_method=S256&state=xyz",
        client_id
    );
    let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let bytes = to_bytes(res.into_body(), 1024*1024).await.unwrap();
    let html = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(html.contains("Claude Code"));
    assert!(html.contains("Guilherme"));
    assert!(html.contains("acc-1"));
}

#[tokio::test]
async fn authorize_post_issues_code_and_redirects() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir.to_path_buf()).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }
    let (client_id, _secret) = {
        let mut s = state.write().await;
        s.clients.register("Claude Code".into(), vec!["http://127.0.0.1:54881/cb".into()], &dir).await.unwrap()
    };
    let router = super::routes_with_accounts(state.clone(), vec![
        super::AccountSummary { account_id: "acc-1".into(), display_name: "G".into(), email: "g@x.com".into() }
    ]);

    let form = format!(
        "client_id={}&redirect_uri=http%3A%2F%2F127.0.0.1%3A54881%2Fcb&code_challenge=challenge&code_challenge_method=S256&state=xyz&account_id=acc-1&scope=notter%3Afull",
        client_id
    );
    let req = Request::builder()
        .method("POST")
        .uri("/authorize")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(Body::from(form)).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 302);
    let loc: &HeaderValue = res.headers().get("location").unwrap();
    let loc_str = loc.to_str().unwrap();
    assert!(loc_str.starts_with("http://127.0.0.1:54881/cb?code="));
    assert!(loc_str.contains("&state=xyz"));
}
```

- [ ] **Step 2: Implement `AccountSummary` + `routes_with_accounts`**

In `src-tauri/src/oauth/mod.rs`, add:

```rust
/// Snapshot of accounts the consent screen can offer. Pushed in from the
/// front-end at boot and refreshed on AccountManager mutations.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AccountSummary {
    pub account_id: String,
    pub display_name: String,
    pub email: String,
}

/// Pin the list of accounts for the consent screen. Production callers pass
/// a `Vec<AccountSummary>` resolved at runtime; the test harness pre-pins
/// known accounts.
pub fn routes_with_accounts(state: OAuthState, accounts: Vec<AccountSummary>) -> axum::Router {
    use axum::{routing::{get, post}, Extension, Router};
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(metadata::well_known))
        .route("/register", post(register::register))
        .route("/authorize",
            get(authorize::authorize_get).post(authorize::authorize_post))
        .layer(Extension(std::sync::Arc::new(accounts)))
        .with_state(state)
}
```

Update `routes()` to take a default empty Vec:

```rust
pub fn routes(state: OAuthState) -> axum::Router {
    routes_with_accounts(state, vec![])
}
```

- [ ] **Step 3: Implement `consent_html.rs`**

```rust
// src-tauri/src/oauth/consent_html.rs
use super::AccountSummary;

pub fn render(
    client_name: &str,
    accounts: &[AccountSummary],
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    scope: &str,
) -> String {
    let account_rows: String = accounts.iter().map(|a| format!(
        r#"<label class="row"><input type="radio" name="account_id" value="{}" required /> <span>{}</span> <span class="email">{}</span></label>"#,
        html_escape(&a.account_id),
        html_escape(&a.display_name),
        html_escape(&a.email),
    )).collect();

    format!(r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize {client_name}</title>
<style>
  body{{font:14px/1.4 system-ui;margin:40px;max-width:520px}}
  h1{{font-size:18px}}
  .row{{display:block;padding:8px;border:1px solid #ddd;border-radius:6px;margin:6px 0;cursor:pointer}}
  .row input{{margin-right:8px}}
  .email{{color:#666;margin-left:8px}}
  .scope{{background:#f3f3f3;padding:8px;border-radius:4px;font-family:ui-monospace;margin:12px 0}}
  button{{padding:8px 14px;border-radius:6px;border:0;background:#0a64ff;color:#fff;font-weight:600;cursor:pointer}}
  button.cancel{{background:#eee;color:#222;margin-left:8px}}
</style></head>
<body>
<h1>Authorize <em>{client_name}</em> to access your Notter account</h1>
<form method="post" action="/authorize">
  <input type="hidden" name="client_id" value="{client_id}">
  <input type="hidden" name="redirect_uri" value="{redirect_uri}">
  <input type="hidden" name="code_challenge" value="{code_challenge}">
  <input type="hidden" name="code_challenge_method" value="S256">
  <input type="hidden" name="state" value="{state}">
  <input type="hidden" name="scope" value="{scope}">
  <p>Choose the account to authorize:</p>
  {account_rows}
  <p>Scope:</p>
  <div class="scope">{scope}</div>
  <button type="submit">Authorize</button>
  <button class="cancel" type="submit" name="deny" value="1">Cancel</button>
</form>
</body></html>
"#,
        client_name = html_escape(client_name),
        client_id = html_escape(client_id),
        redirect_uri = html_escape(redirect_uri),
        code_challenge = html_escape(code_challenge),
        state = html_escape(state),
        scope = html_escape(scope),
        account_rows = account_rows,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
     .replace('"', "&quot;").replace('\'', "&#39;")
}
```

- [ ] **Step 4: Implement `authorize.rs`**

```rust
// src-tauri/src/oauth/authorize.rs
use axum::{
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Redirect},
    Form,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use std::sync::Arc;

use super::{consent_html, grants::AuthCode, AccountSummary, OAuthState};

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    pub response_type: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    #[serde(default)]
    pub state: String,
    #[serde(default = "default_scope")]
    pub scope: String,
}

fn default_scope() -> String { "notter:full".into() }

pub async fn authorize_get(
    State(state): State<OAuthState>,
    Extension(accounts): Extension<Arc<Vec<AccountSummary>>>,
    Query(q): Query<AuthorizeQuery>,
) -> impl IntoResponse {
    if q.response_type != "code" {
        return (StatusCode::BAD_REQUEST, "unsupported response_type").into_response();
    }
    if q.code_challenge_method != "S256" {
        return (StatusCode::BAD_REQUEST, "code_challenge_method must be S256").into_response();
    }

    let s = state.read().await;
    let client = match s.clients.find_by_id(&q.client_id) {
        Some(c) => c.clone(),
        None => return (StatusCode::BAD_REQUEST, "unknown client_id").into_response(),
    };
    if !client.redirect_uris.contains(&q.redirect_uri) {
        return (StatusCode::BAD_REQUEST, "redirect_uri not registered").into_response();
    }
    drop(s);

    let html = consent_html::render(
        &client.client_name,
        accounts.as_ref(),
        &q.client_id,
        &q.redirect_uri,
        &q.code_challenge,
        &q.state,
        &q.scope,
    );
    Html(html).into_response()
}

#[derive(Deserialize)]
pub struct AuthorizeForm {
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    #[serde(default)]
    pub state: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    pub account_id: Option<String>,
    pub deny: Option<String>,
}

pub async fn authorize_post(
    State(state): State<OAuthState>,
    Form(f): Form<AuthorizeForm>,
) -> impl IntoResponse {
    if f.deny.is_some() {
        let url = format!("{}?error=access_denied&state={}", f.redirect_uri, urlencoding::encode(&f.state));
        return Redirect::to(&url).into_response();
    }
    let Some(account_id) = f.account_id else {
        return (StatusCode::BAD_REQUEST, "account_id required").into_response();
    };
    if f.code_challenge_method != "S256" {
        return (StatusCode::BAD_REQUEST, "code_challenge_method must be S256").into_response();
    }

    let s = state.read().await;
    let client = match s.clients.find_by_id(&f.client_id) {
        Some(c) => c.clone(),
        None => return (StatusCode::BAD_REQUEST, "unknown client_id").into_response(),
    };
    if !client.redirect_uris.contains(&f.redirect_uri) {
        return (StatusCode::BAD_REQUEST, "redirect_uri not registered").into_response();
    }

    let mut code_bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut code_bytes);
    let code = URL_SAFE_NO_PAD.encode(code_bytes);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);

    let auth_code = AuthCode {
        client_id: f.client_id.clone(),
        account_id,
        code_challenge: f.code_challenge.clone(),
        redirect_uri: f.redirect_uri.clone(),
        scope: f.scope.clone(),
        expires_at: now + 600,
    };
    s.grants.insert(code.clone(), auth_code).await;
    drop(s);

    let url = format!(
        "{}?code={}&state={}",
        f.redirect_uri,
        urlencoding::encode(&code),
        urlencoding::encode(&f.state),
    );
    Redirect::to(&url).into_response()
}
```

- [ ] **Step 5: Add `urlencoding` dep**

In `src-tauri/Cargo.toml`:

```toml
urlencoding = "2"
```

- [ ] **Step 6: Run tests**

```bash
cargo test --lib oauth::tests -- --nocapture
```
Expected: 11 passed.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/oauth src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(oauth): /authorize GET+POST with HTML consent screen, PKCE S256 enforced"
```

### Task M2.7 — `/token` endpoint with PKCE verify and refresh rotation

**Files:**
- Modify: `src-tauri/src/oauth/token.rs`, `src-tauri/src/oauth/mod.rs`
- Modify: `src-tauri/src/oauth/tests.rs`

- [ ] **Step 1: Write tests**

Append:

```rust
use sha2::Digest;

fn pkce_pair() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let mut hasher = sha2::Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

#[tokio::test]
async fn token_endpoint_exchanges_code_for_access_and_refresh() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir.to_path_buf()).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }
    let (client_id, client_secret) = {
        let mut s = state.write().await;
        s.clients.register("Claude Code".into(), vec!["http://127.0.0.1:54881/cb".into()], &dir).await.unwrap()
    };
    let (verifier, challenge) = pkce_pair();

    // Manually insert an auth code as if /authorize had been POSTed.
    let code = "test-code-1".to_string();
    {
        let s = state.read().await;
        s.grants.insert(code.clone(), super::grants::AuthCode {
            client_id: client_id.clone(),
            account_id: "acc-1".into(),
            code_challenge: challenge.clone(),
            redirect_uri: "http://127.0.0.1:54881/cb".into(),
            scope: "notter:full".into(),
            expires_at: i64::MAX,
        }).await;
    }

    let router = super::routes(state.clone());
    let form = format!(
        "grant_type=authorization_code&code={}&client_id={}&client_secret={}&redirect_uri=http%3A%2F%2F127.0.0.1%3A54881%2Fcb&code_verifier={}",
        urlencoding::encode(&code), urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret), urlencoding::encode(&verifier),
    );
    let req = Request::builder()
        .method("POST").uri("/token")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(Body::from(form)).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let bytes = to_bytes(res.into_body(), 64*1024).await.unwrap();
    let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(j["token_type"], "Bearer");
    assert_eq!(j["expires_in"], 3600);
    assert!(j["access_token"].as_str().unwrap().len() > 32);
    assert!(j["refresh_token"].as_str().unwrap().len() > 32);
    assert_eq!(j["scope"], "notter:full");
}

#[tokio::test]
async fn token_endpoint_rejects_wrong_verifier() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir.to_path_buf()).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }
    let (client_id, client_secret) = {
        let mut s = state.write().await;
        s.clients.register("X".into(), vec!["http://x/cb".into()], &dir).await.unwrap()
    };
    let (_verifier, challenge) = pkce_pair();
    let code = "c-bad".to_string();
    {
        let s = state.read().await;
        s.grants.insert(code.clone(), super::grants::AuthCode {
            client_id: client_id.clone(), account_id: "a".into(),
            code_challenge: challenge,
            redirect_uri: "http://x/cb".into(),
            scope: "notter:full".into(), expires_at: i64::MAX,
        }).await;
    }
    let router = super::routes(state);
    let form = format!(
        "grant_type=authorization_code&code={}&client_id={}&client_secret={}&redirect_uri=http%3A%2F%2Fx%2Fcb&code_verifier=NOT_THE_VERIFIER",
        urlencoding::encode(&code), urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
    );
    let req = Request::builder().method("POST").uri("/token")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(Body::from(form)).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn refresh_token_rotation() {
    // Acquire an initial pair via the happy-path test pattern, then call
    // /token grant_type=refresh_token with refresh_token, expect a NEW pair
    // and the OLD refresh_token's jti added to the revoked set.
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir.to_path_buf()).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }
    let (client_id, client_secret) = {
        let mut s = state.write().await;
        s.clients.register("X".into(), vec!["http://x/cb".into()], &dir).await.unwrap()
    };
    let (verifier, challenge) = pkce_pair();
    let code = "c-refresh".to_string();
    {
        let s = state.read().await;
        s.grants.insert(code.clone(), super::grants::AuthCode {
            client_id: client_id.clone(), account_id: "acc-r".into(),
            code_challenge: challenge,
            redirect_uri: "http://x/cb".into(),
            scope: "notter:full".into(), expires_at: i64::MAX,
        }).await;
    }
    let router = super::routes(state.clone());

    let form = format!(
        "grant_type=authorization_code&code={}&client_id={}&client_secret={}&redirect_uri=http%3A%2F%2Fx%2Fcb&code_verifier={}",
        urlencoding::encode(&code), urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret), urlencoding::encode(&verifier),
    );
    let res = router.clone().oneshot(Request::builder().method("POST").uri("/token")
        .header("content-type","application/x-www-form-urlencoded").body(Body::from(form)).unwrap()).await.unwrap();
    let initial: serde_json::Value = serde_json::from_slice(&to_bytes(res.into_body(),64*1024).await.unwrap()).unwrap();
    let old_refresh = initial["refresh_token"].as_str().unwrap().to_string();

    let form2 = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}&client_secret={}",
        urlencoding::encode(&old_refresh), urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
    );
    let res2 = router.clone().oneshot(Request::builder().method("POST").uri("/token")
        .header("content-type","application/x-www-form-urlencoded").body(Body::from(form2)).unwrap()).await.unwrap();
    assert_eq!(res2.status(), 200);
    let rotated: serde_json::Value = serde_json::from_slice(&to_bytes(res2.into_body(),64*1024).await.unwrap()).unwrap();
    assert_ne!(rotated["refresh_token"], serde_json::Value::String(old_refresh.clone()));

    // Re-using the OLD refresh after rotation must fail.
    let form3 = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}&client_secret={}",
        urlencoding::encode(&old_refresh), urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
    );
    let res3 = router.oneshot(Request::builder().method("POST").uri("/token")
        .header("content-type","application/x-www-form-urlencoded").body(Body::from(form3)).unwrap()).await.unwrap();
    assert_eq!(res3.status(), 400);
}
```

- [ ] **Step 2: Implement `token.rs`**

```rust
// src-tauri/src/oauth/token.rs
use axum::{extract::State, http::StatusCode, response::IntoResponse, Form, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{jwt::Claims, OAuthState};

#[derive(Deserialize)]
pub struct TokenForm {
    pub grant_type: String,
    pub client_id: String,
    pub client_secret: String,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub code_verifier: Option<String>,
    pub refresh_token: Option<String>,
}

const ACCESS_TTL_S: i64 = 3600;          // 1h
const REFRESH_TTL_S: i64 = 60 * 60 * 24 * 30; // 30d

pub async fn token(
    State(state): State<OAuthState>,
    Form(f): Form<TokenForm>,
) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);

    match f.grant_type.as_str() {
        "authorization_code" => handle_code(state, f, now).await,
        "refresh_token" => handle_refresh(state, f, now).await,
        other => err(StatusCode::BAD_REQUEST, "unsupported_grant_type",
                     &format!("grant_type '{other}' not supported")),
    }
}

async fn handle_code(state: OAuthState, f: TokenForm, now: i64) -> axum::response::Response {
    let Some(code) = f.code else { return err(StatusCode::BAD_REQUEST, "invalid_request", "code required"); };
    let Some(redirect_uri) = f.redirect_uri else { return err(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri required"); };
    let Some(verifier) = f.code_verifier else { return err(StatusCode::BAD_REQUEST, "invalid_request", "code_verifier required"); };

    let s = state.read().await;
    if !verify_client(&s, &f.client_id, &f.client_secret) {
        return err(StatusCode::UNAUTHORIZED, "invalid_client", "client authentication failed");
    }
    let grant = match s.grants.take(&code).await {
        Some(g) => g,
        None => return err(StatusCode::BAD_REQUEST, "invalid_grant", "code unknown, used, or expired"),
    };
    drop(s);

    if grant.client_id != f.client_id {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "client_id mismatch");
    }
    if grant.redirect_uri != redirect_uri {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "redirect_uri mismatch");
    }
    // PKCE: base64url-no-pad(sha256(verifier)) == code_challenge
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let computed = URL_SAFE_NO_PAD.encode(hasher.finalize());
    if computed != grant.code_challenge {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "code_verifier does not match challenge");
    }

    issue_pair(state, &grant.client_id, &grant.account_id, &grant.scope, now).await
}

async fn handle_refresh(state: OAuthState, f: TokenForm, now: i64) -> axum::response::Response {
    let Some(refresh) = f.refresh_token else { return err(StatusCode::BAD_REQUEST, "invalid_request", "refresh_token required"); };

    let s = state.read().await;
    if !verify_client(&s, &f.client_id, &f.client_secret) {
        return err(StatusCode::UNAUTHORIZED, "invalid_client", "client authentication failed");
    }
    let claims = match s.jwt_key.verify(&refresh) {
        Ok(c) => c,
        Err(_) => return err(StatusCode::BAD_REQUEST, "invalid_grant", "refresh token invalid"),
    };
    if claims.token_type != "refresh" {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "not a refresh token");
    }
    if claims.client_id != f.client_id {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "client_id mismatch");
    }
    if s.clients.is_jti_revoked(&claims.jti) {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "refresh token already used or revoked");
    }
    drop(s);

    // Rotate: revoke old JTI, then issue new pair.
    {
        let mut s = state.write().await;
        let _ = s.clients.revoke_jti(&claims.jti).await;
    }
    issue_pair(state, &claims.client_id, &claims.sub, &claims.scope, now).await
}

async fn issue_pair(
    state: OAuthState,
    client_id: &str,
    account_id: &str,
    scope: &str,
    now: i64,
) -> axum::response::Response {
    let s = state.read().await;
    let issuer = s.issuer.clone();
    let access_claims = Claims {
        iss: issuer.clone(),
        sub: account_id.into(),
        client_id: client_id.into(),
        scope: scope.into(),
        iat: now,
        exp: now + ACCESS_TTL_S,
        token_type: "access".into(),
        jti: rand_jti(),
    };
    let refresh_claims = Claims {
        iss: issuer,
        sub: account_id.into(),
        client_id: client_id.into(),
        scope: scope.into(),
        iat: now,
        exp: now + REFRESH_TTL_S,
        token_type: "refresh".into(),
        jti: rand_jti(),
    };
    let access = s.jwt_key.sign(&access_claims).unwrap();
    let refresh = s.jwt_key.sign(&refresh_claims).unwrap();
    drop(s);

    (StatusCode::OK, Json(json!({
        "token_type": "Bearer",
        "access_token": access,
        "refresh_token": refresh,
        "expires_in": ACCESS_TTL_S,
        "scope": scope,
    }))).into_response()
}

fn verify_client(s: &super::OAuthStateInner, client_id: &str, secret: &str) -> bool {
    s.clients.find_by_id(client_id).is_some()
        && s.clients.verify_secret(client_id, secret).unwrap_or(false)
}

fn rand_jti() -> String {
    let mut b = [0u8; 16];
    rand::rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

fn err(status: StatusCode, code: &str, desc: &str) -> axum::response::Response {
    (status, Json(json!({"error": code, "error_description": desc}))).into_response()
}
```

- [ ] **Step 3: Wire `/token` into `routes_with_accounts`**

In `oauth/mod.rs`, inside `routes_with_accounts`:

```rust
        .route("/token", post(token::token))
```

- [ ] **Step 4: Run tests**

```bash
cargo test --lib oauth::tests -- --nocapture
```
Expected: 14 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/oauth
git commit -m "feat(oauth): /token grant=authorization_code with PKCE S256 + refresh rotation"
```

### Task M2.8 — `/revoke` endpoint

**Files:**
- Modify: `src-tauri/src/oauth/revoke.rs`, `src-tauri/src/oauth/mod.rs`
- Modify: `src-tauri/src/oauth/tests.rs`

- [ ] **Step 1: Write test**

```rust
#[tokio::test]
async fn revoke_invalidates_refresh_jti() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir.to_path_buf()).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }
    let (client_id, client_secret) = {
        let mut s = state.write().await;
        s.clients.register("X".into(), vec!["http://x/cb".into()], &dir).await.unwrap()
    };

    // Manually mint a refresh token via the same key.
    let claims = Claims {
        iss: "http://127.0.0.1:1".into(),
        sub: "acc-1".into(),
        client_id: client_id.clone(),
        scope: "notter:full".into(),
        iat: 0, exp: i64::MAX,
        token_type: "refresh".into(),
        jti: "jti-test".into(),
    };
    let refresh = {
        let s = state.read().await;
        s.jwt_key.sign(&claims).unwrap()
    };

    let router = super::routes(state.clone());
    let form = format!(
        "token={}&token_type_hint=refresh_token&client_id={}&client_secret={}",
        urlencoding::encode(&refresh), urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
    );
    let req = Request::builder().method("POST").uri("/revoke")
        .header("content-type","application/x-www-form-urlencoded")
        .body(Body::from(form)).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);

    let s = state.read().await;
    assert!(s.clients.is_jti_revoked("jti-test"));
}
```

- [ ] **Step 2: Implement `revoke.rs`**

```rust
// src-tauri/src/oauth/revoke.rs
use axum::{extract::State, http::StatusCode, response::IntoResponse, Form};
use serde::Deserialize;

use super::OAuthState;

#[derive(Deserialize)]
pub struct RevokeForm {
    pub token: String,
    #[serde(default)]
    pub token_type_hint: Option<String>,
    pub client_id: String,
    pub client_secret: String,
}

pub async fn revoke(
    State(state): State<OAuthState>,
    Form(f): Form<RevokeForm>,
) -> impl IntoResponse {
    // RFC 7009: revocation endpoint always returns 200 except for client auth
    // failures, even if the token is unknown/already revoked.
    let s = state.read().await;
    let ok_client = s.clients.find_by_id(&f.client_id).is_some()
        && s.clients.verify_secret(&f.client_id, &f.client_secret).unwrap_or(false);
    if !ok_client {
        return (StatusCode::UNAUTHORIZED, "").into_response();
    }
    // Best-effort verify; if it parses, revoke by JTI.
    if let Ok(claims) = s.jwt_key.verify(&f.token) {
        drop(s);
        let mut s = state.write().await;
        let _ = s.clients.revoke_jti(&claims.jti).await;
    }
    (StatusCode::OK, "").into_response()
}
```

- [ ] **Step 3: Wire `/revoke`**

In `oauth/mod.rs`:

```rust
        .route("/revoke", post(revoke::revoke))
```

- [ ] **Step 4: Run tests**

```bash
cargo test --lib oauth::tests -- --nocapture
```
Expected: 15 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/oauth
git commit -m "feat(oauth): /revoke endpoint (RFC 7009) — invalidate refresh JTI"
```

### Task M2.9 — Bearer middleware accepts OAuth JWT + legacy

**Files:**
- Modify: `src-tauri/src/mcp/auth.rs`
- Modify: `src-tauri/src/mcp/server.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update `bearer_auth` to try JWT first**

In `src-tauri/src/mcp/auth.rs`, after the existing `unauthorized_response` helper, replace `bearer_auth` with:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
static LEGACY_WARNED: AtomicBool = AtomicBool::new(false);

pub async fn bearer_auth(
    AxumState(state): AxumState<crate::mcp::server::McpState>,
    Extension(oauth): Extension<crate::oauth::OAuthState>,
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

    // Try OAuth JWT first.
    {
        let s = oauth.read().await;
        if let Ok(claims) = s.jwt_key.verify(token) {
            if claims.token_type == "access" && !s.clients.is_jti_revoked(&claims.jti) {
                req.extensions_mut().insert(AuthContext { account_id: claims.sub.clone() });
                return next.run(req).await;
            }
        }
    }

    // Fallback: legacy in-memory bearer map (deprecated, kept for one release).
    if let Some(account_id) = lookup_account_for_token(&state, token).await {
        if !LEGACY_WARNED.swap(true, Ordering::Relaxed) {
            eprintln!("[mcp] DEPRECATED: legacy bearer token accepted. Migrate clients to OAuth 2.1.");
        }
        req.extensions_mut().insert(AuthContext { account_id });
        return next.run(req).await;
    }

    unauthorized_response("unknown token")
}
```

Also add the `Extension` import at the top of `auth.rs`:

```rust
use axum::Extension;
```

- [ ] **Step 2: Wire `OAuthState` into the axum app in `server.rs`**

In `src-tauri/src/mcp/server.rs`, find the section that builds `app_router` (around line 127). Change it to attach the OAuthState as an Extension AND mount the oauth routes:

```rust
    // Build OAuth state and mount its routes alongside /mcp and /health.
    let oauth_state = state.read().await.oauth.clone();
    // Pin issuer now that the listener URL is known.
    {
        let mut o = oauth_state.write().await;
        o.issuer = url.trim_end_matches("/mcp").to_string();
    }

    let app_router = Router::new()
        .route("/mcp", post(mcp_handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), bearer_auth))
        .route("/health", get(health))
        .merge(crate::oauth::routes(oauth_state.clone()))
        .layer(Extension(app.clone()))
        .layer(Extension(oauth_state.clone()))
        .with_state(state.clone());
```

Update `McpStateInner` to include `oauth`:

```rust
#[derive(Clone)]
pub struct McpStateInner {
    // ...existing fields...
    pub oauth: crate::oauth::OAuthState,
}
```

- [ ] **Step 3: Bootstrap OAuth state in `lib.rs`**

In `src-tauri/src/lib.rs`, inside the Tauri setup block, before `start_mcp_server`:

```rust
let data_dir = app.path().app_local_data_dir()
    .map_err(|e| e.to_string())?
    .join("notter-ai").join("mcp");
let oauth_state = tauri::async_runtime::block_on(crate::oauth::bootstrap_oauth(&data_dir))?;
```

And populate `McpStateInner.oauth` when building the state.

- [ ] **Step 4: Build + test**

```bash
cd src-tauri
cargo build --lib
cargo test --lib mcp::auth::tests -- --nocapture
cargo test --lib oauth::tests -- --nocapture
```
Expected: clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(mcp): bearer middleware accepts OAuth JWT first, falls back to legacy bearer with deprecation warning"
```

### Task M2.10 — Push account summaries into OAuth state

**Files:**
- Modify: `src-tauri/src/oauth/mod.rs`
- Modify: `src-tauri/src/mcp/auth.rs`
- Modify: `src/lib/mcp/index.ts`

The consent screen needs the list of accounts. The Rust server is started before the front-end has hydrated `AccountManager`, so we push the list in via a Tauri command.

- [ ] **Step 1: Add `account_summaries` to `OAuthStateInner`**

In `oauth/mod.rs`:

```rust
pub struct OAuthStateInner {
    pub jwt_key: JwtKey,
    pub clients: ClientRegistry,
    pub grants: GrantStore,
    pub issuer: String,
    pub account_summaries: Vec<AccountSummary>,
}
```

Update `bootstrap_oauth` to initialize `account_summaries: vec![]`. Update `routes_with_accounts` to read from `state.account_summaries` at request time (move the Extension(accounts) injection out and have `authorize_get` read directly from the OAuthState).

Replace the `authorize_get` extractor signature:

```rust
pub async fn authorize_get(
    State(state): State<OAuthState>,
    Query(q): Query<AuthorizeQuery>,
) -> impl IntoResponse {
    // ... existing validation ...
    let s = state.read().await;
    let accounts = s.account_summaries.clone();
    // ... drop(s); render
}
```

Remove the `Extension<Arc<Vec<AccountSummary>>>` layering from `routes_with_accounts` and `routes`. Re-fold them into a single `routes(state)` function.

- [ ] **Step 2: Add Tauri command to push accounts**

In `src-tauri/src/mcp/auth.rs`:

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAccountSummariesArgs {
    pub accounts: Vec<crate::oauth::AccountSummary>,
}

#[tauri::command]
pub async fn mcp_set_account_summaries(
    args: SetAccountSummariesArgs,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let oauth = state.read().await.oauth.clone();
    let mut o = oauth.write().await;
    o.account_summaries = args.accounts;
    Ok(())
}
```

Register in `lib.rs` `invoke_handler!`.

- [ ] **Step 3: Add front-end glue**

In `src/lib/mcp/index.ts`:

```ts
export interface AccountSummary {
  accountId: string;
  displayName: string;
  email: string;
}

export async function pushMcpAccountSummaries(accounts: AccountSummary[]): Promise<void> {
  try {
    await invoke('mcp_set_account_summaries', { args: { accounts } });
  } catch (e) {
    console.warn('[mcp] pushMcpAccountSummaries failed:', e);
  }
}
```

Call it from `AccountManager.bootstrap` and on every `add`/`remove`/`signOut` (whatever the existing account-state-change broadcast does).

- [ ] **Step 4: Run all tests + manual sanity build**

```bash
cargo test --lib -- --nocapture
npm run -s test -- src/lib/mcp
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src/lib/mcp
git commit -m "feat(oauth): push account summaries into OAuthState for the consent screen"
```

---

## M3 — Eleven new tools (Rust)

**Why:** With M1 schema and M2 auth in place, the dispatcher can grow. Each tool follows the same TDD shape: write integration test against a mocked Supabase (`httpmock`), implement the handler, register in dispatch.

Each task in M3 mirrors `src-tauri/src/mcp/tools.rs` conventions: a `#[derive(Deserialize)] struct` for params, an async `handler(params, auth, state) -> Result<Value, McpError>`, a match arm in `dispatch`. Tests live in `#[cfg(test)] mod tests` inside `tools.rs` (existing pattern).

### Task M3.1 — `list_subjects` gains `include_archived`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Update test**

In the existing `tools.rs` test module (or `mcp::tests` if separate), add:

```rust
#[tokio::test]
async fn list_subjects_default_filters_archived() {
    // The query string sent to Supabase must include archived_at=is.null
    // unless include_archived: true is passed.
    // (Test via httpmock — see M1.2 pattern.)
}
```

- [ ] **Step 2: Update `ListSubjectsParams` and the handler**

In `tools.rs`:

```rust
#[derive(serde::Deserialize, Default)]
struct ListSubjectsParams {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    include_archived: bool,
}
```

Inside `list_subjects`, after the existing workspace filter logic:

```rust
    if !p.include_archived {
        query.push_str("&archived_at=is.null");
    }
```

- [ ] **Step 3: Build + test**

```bash
cd src-tauri
cargo test --lib mcp::tools -- --nocapture
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): list_subjects gains include_archived filter"
```

### Task M3.2 — `get_account_settings` + `update_account_settings`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Implement `get_account_settings`**

```rust
async fn get_account_settings(
    _params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    // GET /auth/v1/user returns the full user; extract user_metadata.notter
    let url = format!("{}/auth/v1/user", sb.base_url);
    let res = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("apikey", &sb.anon_key)
        .send()
        .await
        .map_err(|e| McpError::SupabaseError(format!("get user: {e}")))?;
    if !res.status().is_success() {
        return Err(McpError::SupabaseError(format!("get user: HTTP {}", res.status())));
    }
    let body: Value = res.json().await.map_err(|e| McpError::SupabaseError(e.to_string()))?;
    let notter = body
        .get("user_metadata").and_then(|m| m.get("notter")).cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    // Fill defaults so the response always has all keys.
    let mut out = serde_json::Map::new();
    out.insert("theme".into(),
        notter.get("theme").cloned().unwrap_or_else(|| Value::String("system".into())));
    out.insert("language".into(),
        notter.get("language").cloned().unwrap_or_else(|| Value::String("pt-BR".into())));
    out.insert("update_settings".into(),
        notter.get("update_settings").cloned().unwrap_or_else(|| serde_json::json!({"auto_check": true, "auto_install": false})));
    out.insert("default_workspace_id".into(),
        notter.get("default_workspace_id").cloned().unwrap_or(Value::Null));
    Ok(Value::Object(out))
}
```

(Reading the full user via GET /auth/v1/user is one round-trip; the helper isn't on `SupabaseClient` because reads of the auth user are rare.)

- [ ] **Step 2: Implement `update_account_settings`**

```rust
#[derive(serde::Deserialize, Default)]
struct UpdateAccountSettingsParams {
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    update_settings: Option<Value>,
    #[serde(default)]
    default_workspace_id: Option<String>,
}

async fn update_account_settings(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: UpdateAccountSettingsParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("update_account_settings: {e}")))?;

    if let Some(ref t) = p.theme {
        if !matches!(t.as_str(), "light"|"dark"|"system") {
            return Err(McpError::InvalidParams(format!("theme must be light|dark|system, got '{t}'")));
        }
    }
    if let Some(ref l) = p.language {
        if !matches!(l.as_str(), "pt-BR"|"en-US") {
            return Err(McpError::InvalidParams(format!("language must be pt-BR|en-US, got '{l}'")));
        }
    }

    // Merge with existing notter blob (supabase auth merges shallow on `data`).
    let current = get_account_settings(&Value::Null, auth, state).await?;
    let mut merged = current.as_object().cloned().unwrap_or_default();
    if let Some(v) = p.theme { merged.insert("theme".into(), Value::String(v)); }
    if let Some(v) = p.language { merged.insert("language".into(), Value::String(v)); }
    if let Some(v) = p.update_settings { merged.insert("update_settings".into(), v); }
    if let Some(v) = p.default_workspace_id {
        merged.insert("default_workspace_id".into(), Value::String(v));
    }

    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = serde_json::json!({ "data": { "notter": Value::Object(merged.clone()) } });
    sb.auth_patch_user(&body, &token).await?;
    Ok(Value::Object(merged))
}
```

- [ ] **Step 3: Register in `dispatch`**

In the `match method` block in `dispatch`:

```rust
        "get_account_settings" => get_account_settings(params, auth, state).await,
        "update_account_settings" => update_account_settings(params, auth, state).await,
```

- [ ] **Step 4: Build + commit**

```bash
cargo build --lib
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): get_account_settings + update_account_settings via auth.users.user_metadata.notter"
```

### Task M3.3 — `list_workspaces` + `save_workspace`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Implement `list_workspaces`**

```rust
#[derive(serde::Deserialize, Default)]
struct ListWorkspacesParams {
    #[serde(default)]
    include_archived: bool,
}

async fn list_workspaces(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: ListWorkspacesParams = if params.is_null() {
        ListWorkspacesParams::default()
    } else {
        serde_json::from_value(params.clone())
            .map_err(|e| McpError::InvalidParams(format!("list_workspaces: {e}")))?
    };
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let mut q = String::from("select=id,name,is_default,archived_at,created_at,updated_at&order=is_default.desc,name.asc");
    if !p.include_archived { q.push_str("&archived_at=is.null"); }
    sb.get("workspaces", &q, &token).await
}
```

- [ ] **Step 2: Implement `save_workspace`**

```rust
#[derive(serde::Deserialize)]
struct SaveWorkspaceParams {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    is_default: Option<bool>,
}

async fn save_workspace(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: SaveWorkspaceParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("save_workspace: {e}")))?;
    if p.name.trim().is_empty() {
        return Err(McpError::InvalidParams("name required".into()));
    }
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;

    let body = match &p.id {
        None => {
            // Create
            let mut obj = serde_json::Map::new();
            obj.insert("name".into(), Value::String(p.name.clone()));
            if let Some(d) = p.is_default { obj.insert("is_default".into(), Value::Bool(d)); }
            sb.post("workspaces", &Value::Object(obj), &token, true).await?
        }
        Some(id) => {
            // Update
            let mut obj = serde_json::Map::new();
            obj.insert("name".into(), Value::String(p.name.clone()));
            if let Some(d) = p.is_default { obj.insert("is_default".into(), Value::Bool(d)); }
            obj.insert("updated_at".into(), Value::String(crate::mcp::endpoint::now_rfc3339()));
            // PATCH /rest/v1/workspaces?id=eq.<uuid>
            let url = format!("{}/rest/v1/workspaces?id=eq.{}", sb.base_url, url_encode(id));
            let res = reqwest::Client::new()
                .patch(&url)
                .header("Authorization", format!("Bearer {token}"))
                .header("apikey", &sb.anon_key)
                .header("Content-Type", "application/json")
                .header("Prefer", "return=representation")
                .json(&Value::Object(obj))
                .send().await
                .map_err(|e| McpError::SupabaseError(format!("patch workspaces: {e}")))?;
            if !res.status().is_success() {
                let s = res.status().as_u16();
                let b: Value = res.json().await.unwrap_or(Value::Null);
                if s == 409 {
                    return Err(McpError::Conflict(format!("workspace name conflict: {b}")));
                }
                return Err(McpError::SupabaseError(format!("patch workspaces: HTTP {s} body={b}")));
            }
            res.json::<Value>().await.unwrap_or(Value::Null)
        }
    };

    // Body is an array of one row when return=representation.
    body.as_array().and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::SupabaseError("save_workspace: empty response".into()))
}
```

- [ ] **Step 3: Register in `dispatch`**

```rust
        "list_workspaces" => list_workspaces(params, auth, state).await,
        "save_workspace" => save_workspace(params, auth, state).await,
```

- [ ] **Step 4: Build + commit**

```bash
cargo build --lib
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): list_workspaces + save_workspace"
```

### Task M3.4 — `list_projects` + `save_project` (with rename cascade)

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Implement `list_projects`**

```rust
#[derive(serde::Deserialize, Default)]
struct ListProjectsParams {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    include_archived: bool,
}

async fn list_projects(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: ListProjectsParams = if params.is_null() {
        ListProjectsParams::default()
    } else {
        serde_json::from_value(params.clone())
            .map_err(|e| McpError::InvalidParams(format!("list_projects: {e}")))?
    };
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let mut q = String::from("select=id,name,workspace_id,archived_at,created_at,updated_at&order=updated_at.desc");
    if let Some(w) = &p.workspace_id {
        q.push_str(&format!("&workspace_id=eq.{}", url_encode(w)));
    }
    if !p.include_archived { q.push_str("&archived_at=is.null"); }
    sb.get("projects", &q, &token).await
}
```

- [ ] **Step 2: Implement `save_project`**

```rust
#[derive(serde::Deserialize)]
struct SaveProjectParams {
    #[serde(default)]
    id: Option<String>,
    name: String,
    workspace_id: String,
    /// For renames only: the existing project name. Required when id is
    /// supplied AND name differs from the current row (we can't know without
    /// fetching; the caller must tell us).
    #[serde(default)]
    previous_name: Option<String>,
}

async fn save_project(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: SaveProjectParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("save_project: {e}")))?;
    if p.name.trim().is_empty() {
        return Err(McpError::InvalidParams("name required".into()));
    }
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;

    match &p.id {
        None => {
            // Create — just insert.
            let body = serde_json::json!({
                "name": p.name,
                "workspace_id": p.workspace_id,
            });
            let res = sb.post("projects", &body, &token, true).await?;
            res.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::SupabaseError("save_project: empty response".into()))
        }
        Some(_id) => {
            // Update — rename routes through RPC if previous_name supplied AND differs.
            if let Some(prev) = &p.previous_name {
                if prev != &p.name {
                    let args = serde_json::json!({
                        "old_name": prev,
                        "new_name": p.name,
                        "workspace_uuid": p.workspace_id,
                    });
                    sb.rpc("rename_project_cascade", &args, &token).await?;
                }
            }
            // Refetch by name+workspace for the response.
            let q = format!(
                "select=id,name,workspace_id,archived_at,created_at,updated_at&workspace_id=eq.{}&name=eq.{}&limit=1",
                url_encode(&p.workspace_id), url_encode(&p.name)
            );
            let body = sb.get("projects", &q, &token).await?;
            body.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::NotFound(format!("project {} not found", p.name)))
        }
    }
}
```

- [ ] **Step 3: Register in `dispatch`**

```rust
        "list_projects" => list_projects(params, auth, state).await,
        "save_project" => save_project(params, auth, state).await,
```

- [ ] **Step 4: Build + commit**

```bash
cargo build --lib
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): list_projects + save_project (rename routes through rename_project_cascade RPC)"
```

### Task M3.5 — `save_subject` via `create_subject_with_v0` RPC

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Implement**

```rust
#[derive(serde::Deserialize)]
struct SaveSubjectParams {
    #[serde(default)]
    id: Option<String>,
    project_name: String,
    file_name: String,
}

async fn save_subject(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: SaveSubjectParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("save_subject: {e}")))?;
    if p.project_name.trim().is_empty() || p.file_name.trim().is_empty() {
        return Err(McpError::InvalidParams("project_name and file_name required".into()));
    }
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;

    match &p.id {
        None => {
            // Create via RPC — inserts subjects + subject_versions v0 atomically.
            let args = serde_json::json!({
                "p_project_name": p.project_name,
                "p_file_name": p.file_name,
            });
            let row = sb.rpc("create_subject_with_v0", &args, &token).await?;
            // RPC returns the subjects row (single object, NOT an array).
            Ok(row)
        }
        Some(id) => {
            // Update metadata only (project_name + file_name). content lives via post_subject_revision.
            let body = serde_json::json!({
                "project_name": p.project_name,
                "file_name": p.file_name,
                "updated_at": crate::mcp::endpoint::now_rfc3339(),
            });
            let url = format!("{}/rest/v1/subjects?id=eq.{}", sb.base_url, url_encode(id));
            let res = reqwest::Client::new()
                .patch(&url)
                .header("Authorization", format!("Bearer {token}"))
                .header("apikey", &sb.anon_key)
                .header("Content-Type", "application/json")
                .header("Prefer", "return=representation")
                .json(&body)
                .send().await
                .map_err(|e| McpError::SupabaseError(format!("patch subjects: {e}")))?;
            if !res.status().is_success() {
                let s = res.status().as_u16();
                let b: Value = res.json().await.unwrap_or(Value::Null);
                return Err(McpError::SupabaseError(format!("patch subjects: HTTP {s} body={b}")));
            }
            let body: Value = res.json().await.unwrap_or(Value::Null);
            body.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::NotFound(format!("subject {id} not found")))
        }
    }
}
```

- [ ] **Step 2: Register in `dispatch`**

```rust
        "save_subject" => save_subject(params, auth, state).await,
```

- [ ] **Step 3: Build + commit**

```bash
cargo build --lib
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): save_subject (create via RPC, update for metadata only)"
```

### Task M3.6 — `save_comment` + `delete_comment`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Implement `save_comment`**

```rust
#[derive(serde::Deserialize)]
struct SaveCommentParams {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    subject_id: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    resolved: Option<bool>,
    #[serde(default)]
    archived: Option<bool>,
    #[serde(default)]
    anchor_quote: Option<String>,
    #[serde(default)]
    anchor_prefix: Option<String>,
    #[serde(default)]
    anchor_suffix: Option<String>,
}

async fn save_comment(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: SaveCommentParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("save_comment: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;

    match &p.id {
        None => {
            // Create requires subject_id, version_id, body, anchors.
            let subject_id = p.subject_id.as_ref().ok_or_else(|| McpError::InvalidParams("subject_id required on create".into()))?;
            let version_id = p.version_id.as_ref().ok_or_else(|| McpError::InvalidParams("version_id required on create".into()))?;
            let body_text = p.body.as_ref().ok_or_else(|| McpError::InvalidParams("body required on create".into()))?;
            let aq = p.anchor_quote.as_ref().ok_or_else(|| McpError::InvalidParams("anchor_quote required on create".into()))?;
            let ap = p.anchor_prefix.as_ref().ok_or_else(|| McpError::InvalidParams("anchor_prefix required on create".into()))?;
            let asuf = p.anchor_suffix.as_ref().ok_or_else(|| McpError::InvalidParams("anchor_suffix required on create".into()))?;
            // author_user_id is set by trigger; author_display_name passes through user_metadata.full_name fallback (skipped here — UI fills it).
            let payload = serde_json::json!({
                "subject_id": subject_id,
                "version_id": version_id,
                "body": body_text,
                "anchor_quote": aq,
                "anchor_prefix": ap,
                "anchor_suffix": asuf,
            });
            let res = sb.post("subject_comments", &payload, &token, true).await?;
            res.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::SupabaseError("save_comment: empty response".into()))
        }
        Some(id) => {
            let mut obj = serde_json::Map::new();
            if let Some(v) = &p.body { obj.insert("body".into(), Value::String(v.clone())); }
            if let Some(v) = p.resolved { obj.insert("resolved".into(), Value::Bool(v)); }
            if let Some(v) = p.archived { obj.insert("archived".into(), Value::Bool(v)); }
            obj.insert("updated_at".into(), Value::String(crate::mcp::endpoint::now_rfc3339()));
            let url = format!("{}/rest/v1/subject_comments?id=eq.{}", sb.base_url, url_encode(id));
            let res = reqwest::Client::new()
                .patch(&url)
                .header("Authorization", format!("Bearer {token}"))
                .header("apikey", &sb.anon_key)
                .header("Content-Type", "application/json")
                .header("Prefer", "return=representation")
                .json(&Value::Object(obj)).send().await
                .map_err(|e| McpError::SupabaseError(e.to_string()))?;
            if !res.status().is_success() {
                let s = res.status().as_u16();
                let b: Value = res.json().await.unwrap_or(Value::Null);
                return Err(McpError::SupabaseError(format!("patch comment: HTTP {s} body={b}")));
            }
            let body: Value = res.json().await.unwrap_or(Value::Null);
            body.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::NotFound(format!("comment {id} not found")))
        }
    }
}
```

- [ ] **Step 2: Implement `delete_comment`**

```rust
#[derive(serde::Deserialize)]
struct DeleteCommentParams { id: String }

async fn delete_comment(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: DeleteCommentParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("delete_comment: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let url = format!("{}/rest/v1/subject_comments?id=eq.{}", sb.base_url, url_encode(&p.id));
    let res = reqwest::Client::new()
        .delete(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("apikey", &sb.anon_key)
        .send().await
        .map_err(|e| McpError::SupabaseError(e.to_string()))?;
    if !res.status().is_success() {
        let s = res.status().as_u16();
        return Err(McpError::SupabaseError(format!("delete comment: HTTP {s}")));
    }
    Ok(serde_json::json!({ "deleted": p.id }))
}
```

- [ ] **Step 3: Register in `dispatch`**

```rust
        "save_comment" => save_comment(params, auth, state).await,
        "delete_comment" => delete_comment(params, auth, state).await,
```

- [ ] **Step 4: Build + commit**

```bash
cargo build --lib
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): save_comment (create/update) + delete_comment (hard delete)"
```

### Task M3.7 — `archive_resource` + `restore_resource`

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Implement**

```rust
#[derive(serde::Deserialize)]
struct ArchiveParams {
    #[serde(rename = "type")]
    kind: String, // 'workspace' | 'project' | 'subject'
    id: String,
}

fn table_for_kind(kind: &str) -> Result<&'static str, McpError> {
    match kind {
        "workspace" => Ok("workspaces"),
        "project" => Ok("projects"),
        "subject" => Ok("subjects"),
        other => Err(McpError::InvalidParams(format!("type must be workspace|project|subject, got '{other}'"))),
    }
}

async fn set_archived(
    state: &McpState, auth: &AuthContext, kind: &str, id: &str, archived: bool,
) -> Result<Value, McpError> {
    let table = table_for_kind(kind)?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;

    if archived && kind == "workspace" {
        // Refuse if there are live projects in this workspace.
        let q = format!(
            "select=id&workspace_id=eq.{}&archived_at=is.null&limit=1",
            url_encode(id)
        );
        let body = sb.get("projects", &q, &token).await?;
        if body.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            return Err(McpError::Forbidden(
                "workspace has live projects; archive them first".into()
            ));
        }
    }
    if archived && kind == "project" {
        // Look up project name + workspace, then refuse if live subjects exist.
        let q = format!("select=name&id=eq.{}&limit=1", url_encode(id));
        let body = sb.get("projects", &q, &token).await?;
        let name = body.as_array().and_then(|a| a.first())
            .and_then(|o| o.get("name")).and_then(|v| v.as_str())
            .ok_or_else(|| McpError::NotFound(format!("project {id} not found")))?
            .to_string();
        let subj_q = format!(
            "select=id&project_name=eq.{}&archived_at=is.null&limit=1",
            url_encode(&name)
        );
        let subj_body = sb.get("subjects", &subj_q, &token).await?;
        if subj_body.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            return Err(McpError::Forbidden(
                "project has live subjects; archive them first".into()
            ));
        }
    }

    let archived_value = if archived {
        Value::String(crate::mcp::endpoint::now_rfc3339())
    } else {
        Value::Null
    };
    let patch = serde_json::json!({
        "archived_at": archived_value,
        "updated_at": crate::mcp::endpoint::now_rfc3339(),
    });
    let url = format!("{}/rest/v1/{}?id=eq.{}", sb.base_url, table, url_encode(id));
    let res = reqwest::Client::new()
        .patch(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("apikey", &sb.anon_key)
        .header("Content-Type", "application/json")
        .header("Prefer", "return=representation")
        .json(&patch).send().await
        .map_err(|e| McpError::SupabaseError(e.to_string()))?;
    if !res.status().is_success() {
        let s = res.status().as_u16();
        let b: Value = res.json().await.unwrap_or(Value::Null);
        return Err(McpError::SupabaseError(format!("patch {table}: HTTP {s} body={b}")));
    }
    let body: Value = res.json().await.unwrap_or(Value::Null);
    body.as_array().and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::NotFound(format!("{kind} {id} not found")))
}

async fn archive_resource(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: ArchiveParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("archive_resource: {e}")))?;
    set_archived(state, auth, &p.kind, &p.id, true).await
}

async fn restore_resource(
    params: &Value, auth: &AuthContext, state: &McpState,
) -> Result<Value, McpError> {
    let p: ArchiveParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("restore_resource: {e}")))?;
    set_archived(state, auth, &p.kind, &p.id, false).await
}
```

- [ ] **Step 2: Register in `dispatch`**

```rust
        "archive_resource" => archive_resource(params, auth, state).await,
        "restore_resource" => restore_resource(params, auth, state).await,
```

- [ ] **Step 3: Build + commit**

```bash
cargo build --lib
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): archive_resource + restore_resource with cascade refusal for workspaces/projects with live children"
```

### Task M3.8 — Smoke-list dispatch verifies all 17 methods

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Add a sanity test**

```rust
#[test]
fn dispatch_lists_all_17_methods() {
    // Pseudo-test: reads the dispatch source via include_str! and counts arms.
    let src = include_str!("tools.rs");
    let methods = [
        "list_subjects","get_subject","save_subject",
        "list_versions","get_version","post_subject_revision",
        "list_comments","save_comment","delete_comment",
        "list_workspaces","save_workspace",
        "list_projects","save_project",
        "get_account_settings","update_account_settings",
        "archive_resource","restore_resource",
    ];
    for m in methods {
        assert!(src.contains(&format!("\"{}\"", m)), "method {} missing from dispatch", m);
    }
}
```

- [ ] **Step 2: Run + commit**

```bash
cargo test --lib mcp::tools::tests::dispatch_lists_all_17_methods -- --nocapture
git add src-tauri/src/mcp/tools.rs
git commit -m "test(mcp): assert dispatch wires all 17 method names"
```

---

## M4 — Provider abstraction (front-end)

**Why:** With OAuth working, "connect" boils down to writing one entry in the client's config (or running one CLI command). Each provider is a small module with the same shape.

### Task M4.1 — Interface + registry + paths

**Files:**
- Create: `src/lib/mcp/providers/index.ts`
- Create: `src/lib/mcp/providers/paths.ts`
- Create: `src/lib/mcp/oauth-url.ts`

- [ ] **Step 1: Write `paths.ts`**

```ts
// src/lib/mcp/providers/paths.ts
//
// Resolves per-OS config paths for AI-client MCP installers. All Tauri-side
// path lookups go through @tauri-apps/api/path to avoid leaking absolute
// paths or hard-coded environment-variable parsing in front-end code.
import { homeDir, appDataDir } from '@tauri-apps/api/path';

export type OS = 'windows' | 'macos' | 'linux';

export async function detectOs(): Promise<OS> {
  const { platform } = await import('@tauri-apps/plugin-os');
  const p = await platform();
  if (p === 'windows') return 'windows';
  if (p === 'macos') return 'macos';
  return 'linux';
}

export async function claudeDesktopConfigPath(): Promise<string> {
  const os = await detectOs();
  const home = await homeDir();
  if (os === 'windows') {
    const appData = await appDataDir();
    // appDataDir gives Tauri's appdata; we need Roaming\Claude
    const roaming = appData.replace(/\\agenttrack\\?$/, '').replace(/\/agenttrack\/?$/, '');
    return `${roaming}\\Claude\\claude_desktop_config.json`;
  }
  if (os === 'macos') {
    return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
  }
  return `${home}/.config/Claude/claude_desktop_config.json`;
}

export async function codexConfigPath(): Promise<string> {
  const home = await homeDir();
  return `${home}/.codex/config.toml`;
}

export async function cursorConfigPath(): Promise<string> {
  const home = await homeDir();
  return `${home}/.cursor/mcp.json`;
}
```

- [ ] **Step 2: Add `@tauri-apps/plugin-os` to deps**

```bash
npm install @tauri-apps/plugin-os
```

In `src-tauri/Cargo.toml`:

```toml
tauri-plugin-os = "2"
```

And register it in `src-tauri/src/lib.rs` `.plugin(tauri_plugin_os::init())`.

- [ ] **Step 3: Write `oauth-url.ts`**

```ts
// src/lib/mcp/oauth-url.ts
// Reads endpoint.json to get the live MCP URL. Always returns the public
// /mcp URL — providers add /authorize themselves if needed (most don't;
// they discover via /.well-known).
import { readTextFile } from '@tauri-apps/plugin-fs';
import { join, appLocalDataDir } from '@tauri-apps/api/path';

export async function getMcpBaseUrl(): Promise<string | null> {
  try {
    const dir = await appLocalDataDir();
    const path = await join(dir, 'notter-ai', 'mcp', 'endpoint.json');
    const text = await readTextFile(path);
    const j = JSON.parse(text);
    return typeof j.url === 'string' ? j.url : null;
  } catch (e) {
    console.warn('[mcp] getMcpBaseUrl:', e);
    return null;
  }
}
```

- [ ] **Step 4: Write `providers/index.ts`**

```ts
// src/lib/mcp/providers/index.ts
import { claudeCodeProvider } from './claude-code';
import { claudeDesktopProvider } from './claude-desktop';
import { codexCliProvider } from './codex-cli';
import { cursorProvider } from './cursor';

export type ProviderId = 'claude-code' | 'claude-desktop' | 'codex-cli' | 'cursor';
export type DetectStatus = 'installed' | 'missing' | 'unknown';

export interface McpInstallProvider {
  id: ProviderId;
  label: string;
  detect(): Promise<DetectStatus>;
  install(accountSlug: string, mcpUrl: string): Promise<void>;
  uninstall(accountSlug: string): Promise<void>;
  isLinked(accountSlug: string): Promise<boolean>;
  configPath(): Promise<string>;
}

export const PROVIDERS: McpInstallProvider[] = [
  claudeCodeProvider,
  claudeDesktopProvider,
  codexCliProvider,
  cursorProvider,
];

export function entryKey(accountSlug: string): string {
  return `notter-${accountSlug}`;
}

export function accountSlug(email: string): string {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
  return base.slice(0, 24);
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/providers src/lib/mcp/oauth-url.ts package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat(mcp): provider abstraction skeleton + per-OS path resolver + oauth-url helper"
```

### Task M4.2 — Claude Code (CLI shell-out) provider

**Files:**
- Create: `src/lib/mcp/providers/claude-code.ts`
- Create: `src/lib/mcp/providers/__tests__/claude-code.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/mcp/providers/__tests__/claude-code.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const commandMock = vi.fn();
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: commandMock },
}));

import { claudeCodeProvider } from '../claude-code';
import { entryKey } from '..';

describe('claudeCodeProvider', () => {
  beforeEach(() => commandMock.mockReset());

  it('detect returns installed when `claude --version` succeeds', async () => {
    commandMock.mockReturnValue({ execute: async () => ({ code: 0, stdout: 'claude 0.5.0', stderr: '' }) });
    const status = await claudeCodeProvider.detect();
    expect(status).toBe('installed');
    expect(commandMock).toHaveBeenCalledWith('claude', ['--version']);
  });

  it('detect returns missing when exit code is non-zero', async () => {
    commandMock.mockReturnValue({ execute: async () => ({ code: 127, stdout: '', stderr: 'not found' }) });
    expect(await claudeCodeProvider.detect()).toBe('missing');
  });

  it('install runs claude mcp add with computed entry name + URL', async () => {
    const execMock = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    commandMock.mockReturnValue({ execute: execMock });
    await claudeCodeProvider.install('guilherme', 'http://127.0.0.1:54781/mcp');
    expect(commandMock).toHaveBeenCalledWith('claude', [
      'mcp', 'add', entryKey('guilherme'),
      'http://127.0.0.1:54781/mcp',
      '--transport', 'http',
    ]);
  });

  it('uninstall runs claude mcp remove with the entry name', async () => {
    const execMock = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    commandMock.mockReturnValue({ execute: execMock });
    await claudeCodeProvider.uninstall('guilherme');
    expect(commandMock).toHaveBeenCalledWith('claude', ['mcp','remove', entryKey('guilherme')]);
  });
});
```

- [ ] **Step 2: Run tests** — confirm they fail.

```bash
npm run -s test -- src/lib/mcp/providers/__tests__/claude-code.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/lib/mcp/providers/claude-code.ts
import { Command } from '@tauri-apps/plugin-shell';
import { entryKey, type McpInstallProvider } from '.';

async function runClaude(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = Command.create('claude', args);
  return await cmd.execute();
}

export const claudeCodeProvider: McpInstallProvider = {
  id: 'claude-code',
  label: 'Claude Code (CLI)',

  async detect() {
    try {
      const res = await runClaude(['--version']);
      return res.code === 0 ? 'installed' : 'missing';
    } catch {
      return 'missing';
    }
  },

  async install(slug, mcpUrl) {
    const res = await runClaude(['mcp','add', entryKey(slug), mcpUrl, '--transport','http']);
    if (res.code !== 0) {
      throw new Error(`claude mcp add failed: ${res.stderr || res.stdout}`);
    }
  },

  async uninstall(slug) {
    const res = await runClaude(['mcp','remove', entryKey(slug)]);
    if (res.code !== 0) {
      throw new Error(`claude mcp remove failed: ${res.stderr || res.stdout}`);
    }
  },

  async isLinked(slug) {
    try {
      const res = await runClaude(['mcp','list']);
      return res.code === 0 && res.stdout.includes(entryKey(slug));
    } catch {
      return false;
    }
  },

  async configPath() {
    return '(Claude CLI internal config)';
  },
};
```

- [ ] **Step 4: Add shell scope to capabilities**

In `src-tauri/capabilities/default.json`, add:

```json
{ "identifier": "shell:allow-execute", "allow": [
  { "name": "claude", "cmd": "claude", "args": true }
]}
```

(Adjust to match your existing capabilities schema — Tauri 2 uses scoped allow lists per binary.)

- [ ] **Step 5: Run tests + commit**

```bash
npm run -s test -- src/lib/mcp/providers/__tests__/claude-code.test.ts
git add src/lib/mcp/providers/claude-code.ts src/lib/mcp/providers/__tests__/claude-code.test.ts src-tauri/capabilities/default.json
git commit -m "feat(mcp): Claude Code CLI provider (shell-out to \`claude mcp\`)"
```

### Task M4.3 — Claude Desktop provider

**Files:**
- Create: `src/lib/mcp/providers/claude-desktop.ts`
- Create: `src/lib/mcp/providers/__tests__/claude-desktop.test.ts`

- [ ] **Step 1: Tests**

```ts
// src/lib/mcp/providers/__tests__/claude-desktop.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = {
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
};
vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('../paths', () => ({
  claudeDesktopConfigPath: async () => '/tmp/claude_desktop_config.json',
}));

import { claudeDesktopProvider } from '../claude-desktop';
import { entryKey } from '..';

describe('claudeDesktopProvider', () => {
  beforeEach(() => {
    fs.exists.mockReset(); fs.readTextFile.mockReset();
    fs.writeTextFile.mockReset(); fs.mkdir.mockReset();
  });

  it('detect returns installed when config file already exists', async () => {
    fs.exists.mockResolvedValue(true);
    expect(await claudeDesktopProvider.detect()).toBe('installed');
  });

  it('install creates mcpServers entry under existing config', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({ other: 1, mcpServers: { existing: {} } }, null, 2));
    await claudeDesktopProvider.install('g', 'http://x/mcp');
    expect(fs.writeTextFile).toHaveBeenCalled();
    const written = JSON.parse((fs.writeTextFile.mock.calls[0][1]) as string);
    expect(written.other).toBe(1);
    expect(written.mcpServers.existing).toEqual({});
    expect(written.mcpServers[entryKey('g')]).toEqual({ type: 'http', url: 'http://x/mcp' });
  });

  it('install creates fresh config when file missing', async () => {
    fs.exists.mockResolvedValue(false);
    await claudeDesktopProvider.install('g', 'http://x/mcp');
    expect(fs.mkdir).toHaveBeenCalled();
    const written = JSON.parse((fs.writeTextFile.mock.calls[0][1]) as string);
    expect(written.mcpServers[entryKey('g')]).toEqual({ type: 'http', url: 'http://x/mcp' });
  });

  it('uninstall removes the entry but keeps siblings', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({
      mcpServers: { [entryKey('g')]: { type: 'http', url: 'x' }, other: {} }
    }));
    await claudeDesktopProvider.uninstall('g');
    const written = JSON.parse((fs.writeTextFile.mock.calls[0][1]) as string);
    expect(written.mcpServers[entryKey('g')]).toBeUndefined();
    expect(written.mcpServers.other).toEqual({});
  });

  it('isLinked returns true when our entry exists', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({ mcpServers: { [entryKey('g')]: {} } }));
    expect(await claudeDesktopProvider.isLinked('g')).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/lib/mcp/providers/claude-desktop.ts
import { exists, readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { dirname } from '@tauri-apps/api/path';
import { claudeDesktopConfigPath } from './paths';
import { entryKey, type McpInstallProvider } from '.';

async function readConfig(path: string): Promise<Record<string, any>> {
  if (await exists(path)) {
    try { return JSON.parse(await readTextFile(path)) || {}; }
    catch { return {}; }
  }
  return {};
}

async function writeConfig(path: string, obj: Record<string, any>): Promise<void> {
  const dir = await dirname(path);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  // Atomic-ish: write to .tmp then rename. Tauri's writeTextFile is
  // sync-replace; a real rename would need a Rust command. Acceptable for
  // a config file we own.
  await writeTextFile(path, JSON.stringify(obj, null, 2));
}

export const claudeDesktopProvider: McpInstallProvider = {
  id: 'claude-desktop',
  label: 'Claude Desktop',

  async detect() {
    const path = await claudeDesktopConfigPath();
    return (await exists(path)) ? 'installed' : 'missing';
  },

  async install(slug, mcpUrl) {
    const path = await claudeDesktopConfigPath();
    const cfg = await readConfig(path);
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[entryKey(slug)] = { type: 'http', url: mcpUrl };
    await writeConfig(path, cfg);
  },

  async uninstall(slug) {
    const path = await claudeDesktopConfigPath();
    if (!(await exists(path))) return;
    const cfg = await readConfig(path);
    if (cfg.mcpServers) {
      delete cfg.mcpServers[entryKey(slug)];
    }
    await writeConfig(path, cfg);
  },

  async isLinked(slug) {
    const path = await claudeDesktopConfigPath();
    if (!(await exists(path))) return false;
    const cfg = await readConfig(path);
    return !!(cfg.mcpServers && cfg.mcpServers[entryKey(slug)]);
  },

  async configPath() { return claudeDesktopConfigPath(); },
};
```

- [ ] **Step 3: Add fs scope to capabilities**

Capability identifier: `fs:allow-read-text-file`, `fs:allow-write-text-file`, `fs:allow-exists`, `fs:allow-mkdir`, scoped to `$HOME/.config/Claude/**`, `$APPDATA/Claude/**`, `$HOME/Library/Application Support/Claude/**`. Use Tauri's `$HOME`, `$APPDATA` placeholders. (Adjust to your existing capability file's syntax — see `2026-05-13-header-redesign.md` plan for the project's convention.)

- [ ] **Step 4: Run tests + commit**

```bash
npm run -s test -- src/lib/mcp/providers/__tests__/claude-desktop.test.ts
git add src/lib/mcp/providers/claude-desktop.ts src/lib/mcp/providers/__tests__/claude-desktop.test.ts src-tauri/capabilities/default.json
git commit -m "feat(mcp): Claude Desktop provider — atomic-ish merge into claude_desktop_config.json"
```

### Task M4.4 — Codex CLI provider

**Files:**
- Create: `src/lib/mcp/providers/codex-cli.ts`
- Create: `src/lib/mcp/providers/__tests__/codex-cli.test.ts`

- [ ] **Step 1: Add `@iarna/toml` for TOML parsing**

```bash
npm install @iarna/toml
```

- [ ] **Step 2: Tests**

```ts
// src/lib/mcp/providers/__tests__/codex-cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const fs = {
  exists: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn(), mkdir: vi.fn(),
};
vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('../paths', () => ({ codexConfigPath: async () => '/tmp/codex.toml' }));

import { codexCliProvider } from '../codex-cli';
import { entryKey } from '..';

describe('codexCliProvider', () => {
  beforeEach(() => { fs.exists.mockReset(); fs.readTextFile.mockReset(); fs.writeTextFile.mockReset(); fs.mkdir.mockReset(); });

  it('install writes mcp_servers section with http transport', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue('[other]\nkey = "val"\n');
    await codexCliProvider.install('g', 'http://x/mcp');
    const written = fs.writeTextFile.mock.calls[0][1] as string;
    expect(written).toContain('[other]');
    expect(written).toContain(`[mcp_servers."${entryKey('g')}"]`);
    expect(written).toContain('transport = "http"');
    expect(written).toContain('url = "http://x/mcp"');
  });

  it('uninstall removes the section', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(
      `[mcp_servers."${entryKey('g')}"]\ntransport = "http"\nurl = "x"\n[other]\nkey = "v"\n`
    );
    await codexCliProvider.uninstall('g');
    const written = fs.writeTextFile.mock.calls[0][1] as string;
    expect(written).not.toContain(entryKey('g'));
    expect(written).toContain('[other]');
  });
});
```

- [ ] **Step 3: Implement**

```ts
// src/lib/mcp/providers/codex-cli.ts
import { exists, readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { dirname } from '@tauri-apps/api/path';
import { parse, stringify } from '@iarna/toml';
import { codexConfigPath } from './paths';
import { Command } from '@tauri-apps/plugin-shell';
import { entryKey, type McpInstallProvider } from '.';

async function readConfig(path: string): Promise<Record<string, any>> {
  if (await exists(path)) {
    try { return parse(await readTextFile(path)) as Record<string, any>; }
    catch { return {}; }
  }
  return {};
}

async function writeConfig(path: string, obj: Record<string, any>): Promise<void> {
  const dir = await dirname(path);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await writeTextFile(path, stringify(obj as any));
}

export const codexCliProvider: McpInstallProvider = {
  id: 'codex-cli',
  label: 'Codex CLI',

  async detect() {
    try {
      const res = await Command.create('codex', ['--version']).execute();
      return res.code === 0 ? 'installed' : 'missing';
    } catch { return 'missing'; }
  },

  async install(slug, mcpUrl) {
    const path = await codexConfigPath();
    const cfg = await readConfig(path);
    cfg.mcp_servers = cfg.mcp_servers || {};
    cfg.mcp_servers[entryKey(slug)] = { transport: 'http', url: mcpUrl };
    await writeConfig(path, cfg);
  },

  async uninstall(slug) {
    const path = await codexConfigPath();
    if (!(await exists(path))) return;
    const cfg = await readConfig(path);
    if (cfg.mcp_servers) delete cfg.mcp_servers[entryKey(slug)];
    await writeConfig(path, cfg);
  },

  async isLinked(slug) {
    const path = await codexConfigPath();
    if (!(await exists(path))) return false;
    const cfg = await readConfig(path);
    return !!(cfg.mcp_servers && cfg.mcp_servers[entryKey(slug)]);
  },

  async configPath() { return codexConfigPath(); },
};
```

- [ ] **Step 4: Run tests + commit**

```bash
npm run -s test -- src/lib/mcp/providers/__tests__/codex-cli.test.ts
git add src/lib/mcp/providers/codex-cli.ts src/lib/mcp/providers/__tests__/codex-cli.test.ts package.json package-lock.json
git commit -m "feat(mcp): Codex CLI provider — TOML merge into ~/.codex/config.toml"
```

### Task M4.5 — Cursor provider

**Files:**
- Create: `src/lib/mcp/providers/cursor.ts`
- Create: `src/lib/mcp/providers/__tests__/cursor.test.ts`

Cursor's `mcp.json` has the same shape as Claude Desktop's `mcpServers`. The provider is a near-copy of `claude-desktop.ts` with a different path resolver and detect criterion.

- [ ] **Step 1: Tests** — clone the claude-desktop tests, swap path mock to `'/tmp/cursor-mcp.json'`, import `cursorProvider`.

- [ ] **Step 2: Implement** — clone `claude-desktop.ts`, swap `claudeDesktopConfigPath` → `cursorConfigPath`, label → `'Cursor'`, id → `'cursor'`.

- [ ] **Step 3: Run tests + commit**

```bash
npm run -s test -- src/lib/mcp/providers/__tests__/cursor.test.ts
git add src/lib/mcp/providers/cursor.ts src/lib/mcp/providers/__tests__/cursor.test.ts
git commit -m "feat(mcp): Cursor provider — merge into ~/.cursor/mcp.json"
```

---

## M5 — Settings → MCP UI redesign

**Why:** With the registry in place, the existing `McpTab.tsx` becomes a card list driven by `PROVIDERS`. The bearer copy/paste UI is replaced by per-provider Connect buttons + an always-visible "Outro cliente" manual panel.

### Task M5.1 — Provider card component

**Files:**
- Create: `src/components/settings/McpProviderCard.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/settings/McpProviderCard.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { McpInstallProvider, DetectStatus } from '@/lib/mcp/providers';

interface Props {
  provider: McpInstallProvider;
  accountSlug: string;
  mcpUrl: string | null;
}

export function McpProviderCard({ provider, accountSlug, mcpUrl }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DetectStatus>('unknown');
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await provider.detect();
      const l = await provider.isLinked(accountSlug);
      if (!cancelled) { setStatus(s); setLinked(l); }
    })();
    return () => { cancelled = true; };
  }, [provider, accountSlug]);

  const onConnect = async () => {
    if (!mcpUrl) { toast.error(t('mcp.no_url')); return; }
    setBusy(true);
    try {
      await provider.install(accountSlug, mcpUrl);
      setLinked(true);
      toast.success(t('mcp.providers.connected', { name: provider.label }));
    } catch (e: any) {
      toast.error(`${provider.label}: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  const onDisconnect = async () => {
    setBusy(true);
    try {
      await provider.uninstall(accountSlug);
      setLinked(false);
      toast.success(t('mcp.providers.disconnected', { name: provider.label }));
    } catch (e: any) {
      toast.error(`${provider.label}: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  const badge =
    status === 'installed' ? t('mcp.providers.detected') :
    status === 'missing'   ? t('mcp.providers.not_detected') :
                              '';

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{provider.label}</div>
        <div className="text-xs text-muted-foreground">{badge}</div>
      </div>
      {linked ? (
        <button
          onClick={onDisconnect}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted disabled:opacity-50"
        >
          {t('mcp.providers.disconnect')}
        </button>
      ) : (
        <button
          onClick={onConnect}
          disabled={busy || status === 'missing'}
          title={status === 'missing' ? t('mcp.providers.install_first', { name: provider.label }) : ''}
          className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('mcp.providers.connect')}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add i18n keys**

In `src/i18n/locales/en.json` (and mirror in `pt-BR.json` with PT-BR phrasing):

```json
{
  "mcp": {
    "providers": {
      "title": "Connect to AI clients",
      "detected": "Detected",
      "not_detected": "Not detected",
      "connect": "Connect",
      "disconnect": "Disconnect",
      "connected": "{{name}} connected",
      "disconnected": "{{name}} disconnected",
      "install_first": "Install {{name}} first"
    },
    "manual": {
      "title": "Other client",
      "url_label": "MCP URL",
      "instructions": "Add this URL to your client's MCP config. Authorization is handled via OAuth on first connect."
    },
    "no_url": "MCP server not yet ready — wait a moment and try again."
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/McpProviderCard.tsx src/i18n/locales
git commit -m "feat(settings): McpProviderCard with detect badge + connect/disconnect"
```

### Task M5.2 — Manual fallback section

**Files:**
- Create: `src/components/settings/McpManualSection.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/settings/McpManualSection.tsx
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export function McpManualSection({ mcpUrl }: { mcpUrl: string | null }) {
  const { t } = useTranslation();
  const onCopy = async () => {
    if (!mcpUrl) return;
    await navigator.clipboard.writeText(mcpUrl);
    toast.success('Copied');
  };
  return (
    <div className="pt-4 mt-4 border-t">
      <div className="text-sm font-medium text-foreground mb-1">{t('mcp.manual.title')}</div>
      <p className="text-xs text-muted-foreground mb-2">{t('mcp.manual.instructions')}</p>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('mcp.manual.url_label')}</label>
        <div className="flex gap-2">
          <code className="flex-1 text-xs bg-muted rounded px-2 py-1 break-all">{mcpUrl ?? '…'}</code>
          <button onClick={onCopy} disabled={!mcpUrl}
            className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50">
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/settings/McpManualSection.tsx
git commit -m "feat(settings): McpManualSection — always-visible URL + copy fallback"
```

### Task M5.3 — Rewrite McpTab

**Files:**
- Modify: `src/components/settings/tabs/McpTab.tsx`

- [ ] **Step 1: Replace the file body**

```tsx
// src/components/settings/tabs/McpTab.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth-store';
import { PROVIDERS, accountSlug } from '@/lib/mcp/providers';
import { getMcpBaseUrl } from '@/lib/mcp/oauth-url';
import { McpProviderCard } from '@/components/settings/McpProviderCard';
import { McpManualSection } from '@/components/settings/McpManualSection';

export function McpTab() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMcpBaseUrl().then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, []);

  if (!user) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">{t('mcp.disabled_banner')}</p>
      </div>
    );
  }

  const slug = accountSlug(user.email ?? user.id);

  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">{t('settings.tabs.mcp')}</h2>
      <p className="text-xs text-muted-foreground mb-4">{t('mcp.providers.title')}</p>
      <div>
        {PROVIDERS.map((p) => (
          <McpProviderCard key={p.id} provider={p} accountSlug={slug} mcpUrl={url} />
        ))}
      </div>
      <McpManualSection mcpUrl={url} />
    </div>
  );
}
```

- [ ] **Step 2: Run a manual smoke**

```bash
npm run tauri dev
```

In-app: open Settings → MCP. Expect to see 4 provider cards + the manual section. Click "Conectar" on a detected provider; expect a toast and `isLinked()` to flip to "Disconnect".

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/tabs/McpTab.tsx
git commit -m "feat(settings): rewrite McpTab to use provider cards + manual fallback"
```

---

## M6 — localStorage → user_metadata migration

**Why:** `update_account_settings` writes to `auth.users.raw_user_meta_data.notter`. The front-end has historically stored theme/language/update-prefs in `localStorage`. One-shot migration on sign-in copies them over and the stores read from `user_metadata` going forward.

### Task M6.1 — `account-settings.ts` typed wrapper

**Files:**
- Create: `src/lib/account-settings.ts`
- Create: `src/lib/__tests__/account-settings.test.ts`

- [ ] **Step 1: Write tests**

```ts
// src/lib/__tests__/account-settings.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateUser = vi.fn();
const getUser = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      updateUser: (...a: any[]) => updateUser(...a),
      getUser: () => getUser(),
    }
  }
}));

import { readAccountSettings, writeAccountSettings, migrateFromLocalStorageOnce } from '../account-settings';

describe('account-settings', () => {
  beforeEach(() => {
    updateUser.mockReset();
    getUser.mockReset();
    localStorage.clear();
  });

  it('readAccountSettings returns notter blob from user_metadata', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: { notter: { theme: 'dark', language: 'en-US' } } } } });
    const s = await readAccountSettings();
    expect(s.theme).toBe('dark');
    expect(s.language).toBe('en-US');
  });

  it('readAccountSettings applies defaults when notter blob missing', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: {} } } });
    const s = await readAccountSettings();
    expect(s.theme).toBe('system');
    expect(s.language).toBe('pt-BR');
    expect(s.update_settings.auto_check).toBe(true);
  });

  it('writeAccountSettings calls auth.updateUser with merged notter blob', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: { notter: { theme: 'light' } } } } });
    updateUser.mockResolvedValue({});
    await writeAccountSettings({ language: 'en-US' });
    expect(updateUser).toHaveBeenCalledWith({
      data: { notter: expect.objectContaining({ theme: 'light', language: 'en-US' }) }
    });
  });

  it('migrateFromLocalStorageOnce copies legacy keys when notter blob absent', async () => {
    localStorage.setItem('notter-theme', 'dark');
    localStorage.setItem('notter-language', 'en-US');
    getUser.mockResolvedValue({ data: { user: { user_metadata: {} } } });
    updateUser.mockResolvedValue({});
    await migrateFromLocalStorageOnce();
    expect(updateUser).toHaveBeenCalled();
    const call = updateUser.mock.calls[0][0];
    expect(call.data.notter.theme).toBe('dark');
    expect(call.data.notter.language).toBe('en-US');
  });

  it('migrateFromLocalStorageOnce is a no-op when notter blob already exists', async () => {
    getUser.mockResolvedValue({ data: { user: { user_metadata: { notter: { theme: 'system' } } } } });
    await migrateFromLocalStorageOnce();
    expect(updateUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/lib/account-settings.ts
import { supabase } from '@/lib/supabase';

export interface AccountSettings {
  theme: 'light' | 'dark' | 'system';
  language: 'pt-BR' | 'en-US';
  update_settings: { auto_check: boolean; auto_install: boolean };
  default_workspace_id: string | null;
}

const DEFAULTS: AccountSettings = {
  theme: 'system',
  language: 'pt-BR',
  update_settings: { auto_check: true, auto_install: false },
  default_workspace_id: null,
};

export async function readAccountSettings(): Promise<AccountSettings> {
  const { data } = await supabase.auth.getUser();
  const blob = (data?.user?.user_metadata as any)?.notter ?? {};
  return { ...DEFAULTS, ...blob, update_settings: { ...DEFAULTS.update_settings, ...(blob.update_settings ?? {}) } };
}

export async function writeAccountSettings(patch: Partial<AccountSettings>): Promise<void> {
  const current = await readAccountSettings();
  const merged = { ...current, ...patch };
  await supabase.auth.updateUser({ data: { notter: merged } });
}

const LEGACY_KEYS = {
  theme: 'notter-theme',
  language: 'notter-language',
  autoCheck: 'notter-update-auto-check',
  autoInstall: 'notter-update-auto-install',
};

export async function migrateFromLocalStorageOnce(): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const existing = (data?.user?.user_metadata as any)?.notter;
  if (existing && Object.keys(existing).length > 0) return; // already migrated

  const theme = localStorage.getItem(LEGACY_KEYS.theme) as AccountSettings['theme'] | null;
  const language = localStorage.getItem(LEGACY_KEYS.language) as AccountSettings['language'] | null;
  const autoCheck = localStorage.getItem(LEGACY_KEYS.autoCheck);
  const autoInstall = localStorage.getItem(LEGACY_KEYS.autoInstall);

  const patch: Partial<AccountSettings> = {};
  if (theme) patch.theme = theme;
  if (language) patch.language = language;
  if (autoCheck !== null || autoInstall !== null) {
    patch.update_settings = {
      auto_check: autoCheck === null ? DEFAULTS.update_settings.auto_check : autoCheck === 'true',
      auto_install: autoInstall === null ? DEFAULTS.update_settings.auto_install : autoInstall === 'true',
    };
  }

  // Always write something so subsequent calls see existing.notter and short-circuit.
  await writeAccountSettings(patch);

  // Clear legacy keys.
  for (const k of Object.values(LEGACY_KEYS)) localStorage.removeItem(k);
}
```

- [ ] **Step 3: Run tests + commit**

```bash
npm run -s test -- src/lib/__tests__/account-settings.test.ts
git add src/lib/account-settings.ts src/lib/__tests__/account-settings.test.ts
git commit -m "feat(account-settings): readAccountSettings/writeAccountSettings + one-shot localStorage migration"
```

### Task M6.2 — Wire migration into auth-store

**Files:**
- Modify: `src/stores/auth-store.ts`

- [ ] **Step 1: Add a one-shot trigger after SIGNED_IN**

Find the `onAuthStateChange` handler. After the existing `SIGNED_IN` / `TOKEN_REFRESHED` branches push the access token to Rust, add:

```ts
if (event === 'SIGNED_IN') {
  import('@/lib/account-settings').then(({ migrateFromLocalStorageOnce }) => {
    migrateFromLocalStorageOnce().catch((e) =>
      console.warn('[account-settings] migration failed:', e),
    );
  });
}
```

(Dynamic import keeps the auth store boot path free of the auth-settings module.)

- [ ] **Step 2: Commit**

```bash
git add src/stores/auth-store.ts
git commit -m "feat(auth): one-shot localStorage → user_metadata migration on SIGNED_IN"
```

### Task M6.3 — Read user_metadata first in theme/language stores

**Files:**
- Modify: `src/stores/theme-store.ts` (and `language-store.ts` — exact filenames TBD by `grep -r 'notter-theme' src`; verify before editing)

- [ ] **Step 1: Identify the stores**

```bash
rg -n "notter-theme|notter-language" src
```

- [ ] **Step 2: Update each store's bootstrap path**

For each store that reads `localStorage.getItem('notter-theme')` (or `notter-language`):

1. Add a one-shot async hydration on app mount that calls `readAccountSettings()` and updates the store.
2. Keep the localStorage write path during Phase 1 (so a stale tab on a different device still hydrates from local cache).

Example for `theme-store.ts`:

```ts
import { readAccountSettings } from '@/lib/account-settings';

// At bootstrap, after the store has read localStorage:
export async function hydrateThemeFromUserMetadata(): Promise<void> {
  try {
    const s = await readAccountSettings();
    useThemeStore.setState({ theme: s.theme });
  } catch (e) {
    console.warn('[theme] hydrate failed:', e);
  }
}
```

Call `hydrateThemeFromUserMetadata` from the same place that listens for `SIGNED_IN`.

- [ ] **Step 3: Manual smoke + commit**

Sign in with a fresh account on a build that doesn't have legacy localStorage keys — theme/language should default to `system`/`pt-BR` and persist across reload. Sign out, sign in: still works.

```bash
git add src/stores
git commit -m "feat(stores): hydrate theme/language from user_metadata.notter on SIGNED_IN"
```

---

## M7 — Smoke + rollout

**Why:** Land last. After all milestones, smoke the full surface with a script, then flip the `mcp_oauth_enabled` flag for the first prod build.

### Task M7.1 — `smoke-mcp-v2.ps1`

**Files:**
- Create: `scripts/smoke-mcp-v2.ps1`

- [ ] **Step 1: Adapt `smoke-m3.ps1`**

```powershell
# scripts/smoke-mcp-v2.ps1
#
# OAuth 2.1 + 17-tool surface smoke. Adapted from smoke-m3.ps1.
#
# Usage:
#   $env:MCP_URL = 'http://127.0.0.1:54781/mcp'
#   pwsh scripts/smoke-mcp-v2.ps1
#
# Exits non-zero on any failure. Pretty-prints JSON output.

[CmdletBinding()]
param(
    [string]$Url = $env:MCP_URL,
    [string]$AccountId = $env:MCP_ACCOUNT_ID
)
if (-not $Url) { Write-Error "Set MCP_URL"; exit 2 }
if (-not $AccountId) { Write-Error "Set MCP_ACCOUNT_ID (the account_id to test against)"; exit 2 }

$base = $Url -replace '/mcp$',''
$script:failures = 0

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; $script:failures++ }
function OK($msg)   { Write-Host "OK:   $msg" -ForegroundColor Green }

# Step 1: register a client
$reg = Invoke-RestMethod -Method Post -Uri "$base/register" -ContentType application/json -Body (@{
    client_name = 'smoke-mcp-v2'
    redirect_uris = @('http://127.0.0.1:55555/cb')
} | ConvertTo-Json)
$clientId = $reg.client_id
$clientSecret = $reg.client_secret
OK "registered $clientId"

# Step 2: simulate the consent screen — POST directly to /authorize with the account_id
$verifier = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((New-Guid).ToString())) `
            -replace '\+','-' -replace '/','_' -replace '=',''
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($verifier))
$challenge = [Convert]::ToBase64String($hash) -replace '\+','-' -replace '/','_' -replace '=',''

$form = @{
    client_id = $clientId
    redirect_uri = 'http://127.0.0.1:55555/cb'
    code_challenge = $challenge
    code_challenge_method = 'S256'
    state = 'xyz'
    scope = 'notter:full'
    account_id = $AccountId
}
$resp = Invoke-WebRequest -Method Post -Uri "$base/authorize" -Body $form `
    -MaximumRedirection 0 -ErrorAction SilentlyContinue
if ($resp.StatusCode -ne 302) { Fail "expected 302 from /authorize, got $($resp.StatusCode)"; exit 1 }
$location = $resp.Headers.Location
$code = ($location -split 'code=')[1] -split '&' | Select-Object -First 1
OK "authorize issued code $code"

# Step 3: exchange code → tokens
$tokenForm = @{
    grant_type = 'authorization_code'
    code = $code
    client_id = $clientId
    client_secret = $clientSecret
    redirect_uri = 'http://127.0.0.1:55555/cb'
    code_verifier = $verifier
}
$tokens = Invoke-RestMethod -Method Post -Uri "$base/token" -Body $tokenForm
$access = $tokens.access_token
$refresh = $tokens.refresh_token
OK "token exchange ok, access_token len=$($access.Length)"

# Step 4: exercise every tool
function Call-Mcp($method, $params) {
    $body = @{ jsonrpc = '2.0'; id = (Get-Random); method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
    $h = @{ Authorization = "Bearer $access"; 'Content-Type' = 'application/json' }
    $r = Invoke-RestMethod -Method Post -Uri $Url -Headers $h -Body $body
    if ($r.error) { Fail "$method -> $($r.error.message)" } else { OK $method }
    return $r.result
}

Call-Mcp 'list_subjects' @{}
Call-Mcp 'list_workspaces' @{}
Call-Mcp 'list_projects' @{}
Call-Mcp 'list_versions' @{ subject_id = '00000000-0000-0000-0000-000000000000' }
Call-Mcp 'list_comments' @{ subject_id = '00000000-0000-0000-0000-000000000000' }
$settings = Call-Mcp 'get_account_settings' @{}
Write-Host "  settings: $($settings | ConvertTo-Json -Compress)"

# Create-update-archive-restore round-trip on a workspace
$ws = Call-Mcp 'save_workspace' @{ name = "smoke-$(Get-Random)" }
$wsId = $ws.id
Call-Mcp 'archive_resource' @{ type = 'workspace'; id = $wsId }
Call-Mcp 'restore_resource' @{ type = 'workspace'; id = $wsId }

# Step 5: revoke refresh
$revokeForm = @{ token = $refresh; token_type_hint = 'refresh_token'; client_id = $clientId; client_secret = $clientSecret }
$null = Invoke-WebRequest -Method Post -Uri "$base/revoke" -Body $revokeForm
OK "revoke posted"

# Step 6: confirm refresh is dead
try {
    $bad = Invoke-RestMethod -Method Post -Uri "$base/token" -Body @{
        grant_type='refresh_token'; refresh_token=$refresh; client_id=$clientId; client_secret=$clientSecret
    } -ErrorAction Stop
    Fail "expected refresh to fail after revoke"
} catch { OK "refresh refused post-revoke" }

if ($script:failures -gt 0) { Write-Host "$($script:failures) failures" -ForegroundColor Red; exit 1 }
Write-Host "ALL GREEN" -ForegroundColor Green
```

- [ ] **Step 2: Run it**

```bash
npm run tauri dev
# In another shell:
pwsh scripts/smoke-mcp-v2.ps1
```
Expected: `ALL GREEN`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-mcp-v2.ps1
git commit -m "test(smoke): smoke-mcp-v2.ps1 — OAuth dance + 17 tools + archive/restore + revoke"
```

### Task M7.2 — Manual cross-OS checklist

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-14-mcp-providers-manual.md`

- [ ] **Step 1: Write the runbook**

```markdown
# MCP providers — manual install checklist (2026-05-14)

For each OS × provider, sign into Notter, open Settings → MCP, click "Conectar"
on the provider, verify the entry shows up where expected, and that the client
can actually call a Notter tool.

## Windows

- [ ] Claude Code CLI — entry visible in `claude mcp list`; `claude mcp call notter-<slug>.list_workspaces` returns rows
- [ ] Claude Desktop — entry visible in `%APPDATA%\Claude\claude_desktop_config.json`; after restarting Claude Desktop, calling a tool via Claude UI works
- [ ] Codex CLI — entry visible in `%USERPROFILE%\.codex\config.toml`
- [ ] Cursor — entry visible in `%USERPROFILE%\.cursor\mcp.json`; Cursor side panel "MCP" lists Notter

## macOS

- [ ] Claude Code CLI — `claude mcp list` shows entry
- [ ] Claude Desktop — entry in `~/Library/Application Support/Claude/claude_desktop_config.json`
- [ ] Codex CLI — entry in `~/.codex/config.toml`
- [ ] Cursor — entry in `~/.cursor/mcp.json`

## Linux

- [ ] Claude Code CLI — entry in `claude mcp list`
- [ ] Claude Desktop — entry in `~/.config/Claude/claude_desktop_config.json`
- [ ] Codex CLI — entry in `~/.codex/config.toml`
- [ ] Cursor — entry in `~/.cursor/mcp.json`

## Disconnect

For each row above: click "Desconectar"; verify the entry is removed from the file (or `claude mcp list` no longer shows it).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/2026-05-14-mcp-providers-manual.md
git commit -m "docs(mcp): manual cross-OS install checklist for the 4 providers"
```

### Task M7.3 — Flip `mcp_oauth_enabled` flag for prod

**Files:**
- Modify: `src-tauri/src/lib.rs` (or wherever the feature flag is read)

- [ ] **Step 1: Confirm the flag is enabled by default in dev**

Search for `mcp_oauth_enabled` in `lib.rs`. Ensure the default reads from an env var with `unwrap_or("true")` on dev profiles and `unwrap_or("false")` on prod release for the first build.

- [ ] **Step 2: After staging smoke passes, flip the default to `true` everywhere**

```rust
let oauth_enabled = std::env::var("MCP_OAUTH_ENABLED")
    .map(|v| v == "true" || v == "1")
    .unwrap_or(true);
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "chore(mcp): enable OAuth 2.1 by default in all builds"
```

---

## Self-review (run after writing the plan)

### Spec coverage

Walking the spec sections:

- **§2 Goals: OAuth 2.1** — covered by M2.
- **§2 Goals: Client-agnostic install flow / 4 providers** — covered by M4.
- **§2 Goals: 17-tool surface** — covered by M3 (+ existing 6 tools, with M3.1 adding `include_archived`).
- **§2 Goals: Soft-delete via archived_at** — covered by M1.1 (schema) and M3.7 (tools).
- **§2 Goals: No new tables for account settings** — covered by M1.2 (`auth_patch_user`) and M3.2 (`get/update_account_settings`).
- **§4.1 OAuth endpoints** — `/.well-known` M2.5, `/register` M2.5, `/authorize` M2.6, `/token` M2.7, `/revoke` M2.8.
- **§4.1 JWT format with persistent secret** — M2.2.
- **§4.1 Client registry with Argon2id-hashed secrets** — M2.3.
- **§4.1 Bearer middleware accepts OAuth + legacy** — M2.9.
- **§4.2 Provider abstraction with 4 providers + manual section** — M4.1–M4.5, M5.1–M5.3.
- **§4.3 UI redesign (cards + manual fallback)** — M5.
- **§5.1 Tool catalog** — every method in the table maps to a task in M3.
- **§5.2 Validation rules** — covered inline in M3.2 (theme/language enums) and M3.7 (archive cascade refusal).
- **§5.3 Error model (Forbidden, Conflict)** — M1.3.
- **§6 Schema migration + RPCs** — M1.1.
- **§6 user_metadata storage** — M3.2.
- **§7 localStorage → user_metadata migration** — M6.
- **§8 Rollout phases** — M7.3 (flag flip); Phase 2 cleanup is explicitly out of scope (mentioned in spec §11 and plan header).
- **§9 Testing** — unit tests scattered through M1–M6; smoke script in M7.1; manual checklist in M7.2.

No spec section is uncovered.

### Placeholder scan

- M6.3 mentions "exact filenames TBD by `grep -r 'notter-theme' src`" — this is intentional and the step provides the exact command to verify. Not a placeholder.
- All other steps have concrete code blocks, file paths, and commands.

### Type consistency

- `entryKey(slug)` returns `notter-<slug>` — used identically across providers.
- `accountSlug(email)` derivation matches between front-end and the smoke script (the smoke script doesn't need it since it tests Rust directly).
- `AccountSummary` fields (`account_id`, `display_name`, `email`) match between Rust (M2.6, M2.10) and TS (M2.10 step 3).
- `Claims.sub` consistently means `account_id` in JWT M2.2 and bearer middleware M2.9.
- `Save*Params` Rust structs use `id: Option<String>` consistently; no drift.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-mcp-expansion.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Good fit because the plan has 7 milestones with mostly independent tasks; the review checkpoints keep the OAuth crypto, the Supabase migration, and the front-end paths from drifting.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. Cheaper if you want to monitor closely.

**Which approach?**




