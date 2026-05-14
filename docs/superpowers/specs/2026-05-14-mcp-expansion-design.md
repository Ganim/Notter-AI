# MCP expansion — OAuth 2.1, multi-client install, full CRUD surface

**Date:** 2026-05-14
**Status:** Awaiting user review
**Replaces (extends):** `2026-05-09-notter-pivot-phase1-design.md` §6 (MCP server)
**Touches:** `src-tauri/src/mcp/*`, `src/lib/mcp/*`, `src/components/settings/tabs/McpTab.tsx`, new migration `2026-05-14-mcp-expansion.sql`

## 1. Problem

The Notter MCP server today exposes 6 read-mostly tools, requires the user to copy-paste a JSON config (URL + bearer) into each AI client manually, and only writes to `subjects` via append-only snapshots. Two pressures are pushing on this:

- **Connection friction.** The "copy this JSON, paste into your client's config" flow is the part of Notter that feels least finished. The user wants to click a button and have Claude (Desktop and CLI), Codex CLI, Cursor, etc. just *know* about Notter.
- **Tool surface.** The current surface is read-only over most domains. The user wants AI clients to do real work inside Notter: create projects, rename workspaces, file new subjects, comment, archive obsolete material, tweak preferences. Snapshot-only writes on `subjects.content` stay (locked invariant from the pivot), but every other CRUD becomes legal.

## 2. Goals & non-goals

**Goals:**

- Replace bearer copy/paste with **OAuth 2.1** (per the MCP authorization spec). Bearer stays accepted for 1 release as a deprecated path.
- **Client-agnostic install flow.** Provider abstraction in the front-end with v1 modules for Claude Code CLI, Claude Desktop, Codex CLI, and Cursor IDE; manual-paste fallback covers everything else.
- **17-tool MCP surface** covering account settings, workspaces, projects, subjects (metadata + content), versions, and comments. Snapshot-only invariant on `subjects.content` preserved.
- **Soft-delete** on workspaces/projects/subjects via `archived_at`. Comments retain their existing `archived` boolean + a hard `delete_comment` path.
- **No new tables for account settings** — theme/language/update prefs/default workspace live in `auth.users.raw_user_meta_data` (JSONB).

**Non-goals:**

- Granular OAuth scopes. v1 ships a single `notter:full` scope. Scope splitting (read-only, etc.) waits for real demand.
- Deep-link install URIs (`claude://mcp/install?url=...`). Aspirational; revisit when MCP spec or Claude Desktop standardize one.
- Hard-delete on workspaces/projects/subjects. Soft-delete only; restore tool included.
- Direct mutation of `subjects.content` from MCP. The post_subject_revision invariant stays — every AI write produces a new version row.
- Per-account OAuth client isolation. A client registered via Dynamic Client Registration uses one `client_id` regardless of which account it ends up authorizing. Account binding happens at token issue time.

## 3. Decisions locked from brainstorming

1. Audience: Claude Code CLI + Claude Desktop + Codex CLI + Cursor IDE + universal manual fallback.
2. Account-settings write scope: `theme`, `language`, update settings (`auto_check`, `auto_install`), `default_workspace_id`. Profile (display_name, avatar) and email/linked accounts stay out.
3. Auth model: OAuth 2.1 with Dynamic Client Registration (RFC 7591) and PKCE S256. Bearer legacy accepted 1 version, then removed.
4. Write semantics: snapshot-only on subject content. Soft-delete via `archived_at` on workspaces/projects/subjects. Full comment CRUD including hard delete.
5. Tool surface shape: save+lifecycle consolidated (~17 tools total). `save_X` tools cover create/update by presence of `id`; generic `archive_resource` / `restore_resource` covers workspace/project/subject lifecycle.

## 4. Architecture

### 4.1 OAuth 2.1 stack (Rust, axum)

New routes on the same dynamic port `127.0.0.1:<port>` already running `/mcp` and `/health`:

| Route                                          | Purpose                                                                |
|------------------------------------------------|------------------------------------------------------------------------|
| `GET  /.well-known/oauth-authorization-server` | RFC 8414 metadata (issuer, endpoints, supported scopes, `code_challenge_methods_supported=["S256"]`) |
| `POST /register`                               | RFC 7591 Dynamic Client Registration. Returns `client_id`, `client_secret`, registration metadata. |
| `GET  /authorize`                              | Renders consent screen (account picker + scope display); on submit issues `code` and redirects with PKCE state. |
| `POST /token`                                  | Exchanges `code → access_token + refresh_token`. Refresh-token rotation enforced. |
| `POST /revoke`                                 | RFC 7009. Revokes access or refresh token.                              |

**Token format:** HS256 JWT signed with a per-app secret persisted at `<appLocalData>/notter-ai/mcp/jwt-secret.bin` (generated once on first boot, 32 random bytes). Claims:

```json
{
  "iss": "http://127.0.0.1:<port>",
  "sub": "<account_id>",
  "client_id": "<client_id>",
  "scope": "notter:full",
  "iat": 1715600000,
  "exp": 1715603600,
  "token_type": "access" | "refresh"
}
```

Access tokens: 1h. Refresh tokens: 30d, single-use (rotated on every refresh).

**Persistence:** `<appLocalData>/notter-ai/mcp/clients.json`:
```json
{
  "clients": [
    { "client_id": "...", "client_secret_hash": "...", "client_name": "Claude Code",
      "redirect_uris": ["http://127.0.0.1:54881/callback"],
      "registered_at": "2026-05-14T12:00:00Z" }
  ],
  "active_grants": [
    { "client_id": "...", "account_id": "...", "refresh_token_jti": "...",
      "expires_at": "..." }
  ]
}
```

`client_secret` is hashed (Argon2id) before storage. `refresh_token_jti` is a random 128-bit id embedded in refresh tokens so revoke can invalidate by jti without storing full tokens.

**Consent screen:** `/authorize` returns an HTML page (rendered inline; no Tauri webview window) that lists registered accounts (account display name + email), the client name pulled from `clients.json`, and the requested scope. Submit posts back to `/authorize` with the chosen account and PKCE state; server replies with `302 -> redirect_uri?code=<code>&state=<state>`. The redirect target is one of `http://127.0.0.1:<client-port>/callback` opened by the client. Auth codes: one-shot, 10-minute expiry, in-memory only.

**Bearer-auth middleware on `/mcp`** is extended to:
1. Try OAuth JWT validation first (verify signature, exp, token_type=access, extract `sub` as `account_id`).
2. Fall back to the legacy bearer-token-to-account map for one release. When a legacy bearer matches, log a deprecation warning once per process.

### 4.2 Provider abstraction (front-end)

New directory `src/lib/mcp/providers/`:

```
providers/
  index.ts          # registry + McpInstallProvider type
  claude-code.ts    # shell-out to `claude mcp add`
  claude-desktop.ts # writes claude_desktop_config.json
  codex-cli.ts      # writes ~/.codex/config.toml
  cursor.ts         # writes ~/.cursor/mcp.json
```

The "Outro cliente / manual" panel is **not** a provider module — it's a static UI section in `McpTab` showing the URL + per-client instructions, independent of the registry above.

**Interface:**

```ts
export interface McpInstallProvider {
  id: 'claude-code' | 'claude-desktop' | 'codex-cli' | 'cursor';
  label: string;
  iconSlug: string; // resolved by McpTab to a lucide-react icon or svg path
  detect(): Promise<'installed' | 'missing' | 'unknown'>;
  install(accountId: string, mcpUrl: string): Promise<void>;
  uninstall(accountId: string): Promise<void>;
  isLinked(accountId: string): Promise<boolean>;
  configPath(): string; // human-readable, displayed under "Detalhes"
}
```

**Detection strategy per provider:**

| Provider        | Detect by                                     | Timeout |
|-----------------|-----------------------------------------------|---------|
| Claude Code     | `which claude` / `where claude`               | 500ms   |
| Claude Desktop  | Existence of config dir (per OS, see below)   | 100ms   |
| Codex CLI       | `which codex` / `where codex`                 | 500ms   |
| Cursor          | Existence of `~/.cursor/` directory           | 100ms   |

**Config paths by OS:**

| Provider        | Windows                                          | macOS                                                       | Linux                              |
|-----------------|--------------------------------------------------|-------------------------------------------------------------|------------------------------------|
| Claude Desktop  | `%APPDATA%\Claude\claude_desktop_config.json`    | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Codex CLI       | `%USERPROFILE%\.codex\config.toml`               | `~/.codex/config.toml`                                      | `~/.codex/config.toml`             |
| Cursor          | `%USERPROFILE%\.cursor\mcp.json`                 | `~/.cursor/mcp.json`                                        | `~/.cursor/mcp.json`               |

**Install payloads:**

- **Claude Code CLI:** `claude mcp add notter-<accountSlug> http://127.0.0.1:<port>/mcp --transport http` (no header — OAuth handled by Claude).
- **Claude Desktop:** merge into `mcpServers`: `{ "notter-<accountSlug>": { "type": "http", "url": "http://127.0.0.1:<port>/mcp" } }`.
- **Codex CLI:** append `[mcp_servers.notter-<accountSlug>]` table with `transport = "http"` and `url = "http://127.0.0.1:<port>/mcp"`.
- **Cursor:** merge into `mcpServers`: `{ "notter-<accountSlug>": { "url": "http://127.0.0.1:<port>/mcp" } }`.

`<accountSlug>` is `account.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-')` truncated to 24 chars — keeps multi-account installs distinct without leaking the full email into the client config.

All file mutations are atomic (write-temp + rename) and idempotent (re-installing same account upserts the same key). All shell-outs use `@tauri-apps/plugin-shell` with a fixed argument list (no shell interpolation).

### 4.3 UI: Settings → MCP redesign

Current `McpTab` (single URL + bearer + copy button) is replaced by:

```
┌── Conectar a clientes IA ───────────────────────────────┐
│ [Claude Code]   Detectado    [ Conectar ]               │
│ [Claude Desktop] Detectado   [ Desconectar ]            │
│ [Codex CLI]     Não detectado  Como instalar ↗          │
│ [Cursor]        Detectado    [ Conectar ]               │
├── Outro cliente ────────────────────────────────────────┤
│ URL:  http://127.0.0.1:54781/mcp           [Copiar]     │
│ Mostrar instruções por cliente ▼                        │
└─────────────────────────────────────────────────────────┘
```

The "Outro cliente" section is always present. The buttons are disabled with tooltip when `detect() === 'missing'`, but the manual section never disappears.

## 5. Tool surface (17 tools)

### 5.1 Catalog

| Tool                       | Status     | Notes                                                                                       |
|----------------------------|------------|---------------------------------------------------------------------------------------------|
| `get_account_settings`     | new        | Returns `{theme, language, update_settings, default_workspace_id}` from `user_metadata`.   |
| `update_account_settings`  | new        | Patch (any subset). Validates enums. Calls `supabase.auth.updateUser({data:...})`-equivalent via REST. |
| `list_workspaces`          | new        | `{include_archived?}`. Sorted by `is_default desc, name asc`.                                |
| `save_workspace`           | new        | `{id?, name, is_default?}`. Honors the existing `workspaces_one_default_per_user_idx`.       |
| `list_projects`            | new        | `{workspace_id?, include_archived?}`.                                                       |
| `save_project`             | new        | `{id?, name, workspace_id}`. Rename triggers `rename_project_cascade` RPC.                  |
| `list_subjects`            | kept       | Gains `include_archived?`.                                                                  |
| `get_subject`              | kept       | unchanged                                                                                   |
| `save_subject`             | new        | `{id?, project_name, file_name}`. Metadata only. Create path auto-snapshots v0 (`content` empty). |
| `post_subject_revision`    | kept       | **Only path to write subject content.** Unchanged semantics.                                 |
| `list_versions`            | kept       | unchanged                                                                                   |
| `get_version`              | kept       | unchanged                                                                                   |
| `list_comments`            | kept       | unchanged (already supports `include_archived`).                                            |
| `save_comment`             | new        | `{id?, subject_id?, version_id?, body?, resolved?, archived?, anchor_quote?, anchor_prefix?, anchor_suffix?}`. id absent ⇒ create (requires subject_id+version_id+body+anchors). |
| `delete_comment`           | new        | `{id}`. Hard delete.                                                                        |
| `archive_resource`         | new        | `{type: 'workspace'\|'project'\|'subject', id}`. Sets `archived_at = now()`.                |
| `restore_resource`         | new        | `{type, id}`. Sets `archived_at = null`.                                                    |

### 5.2 Validation rules

- `update_account_settings`:
  - `theme ∈ {'light','dark','system'}`
  - `language ∈ {'pt-BR','en-US'}` (matches `i18n` keys today)
  - `default_workspace_id` must reference a workspace owned by `auth.uid()` (Supabase RLS already enforces; tool returns `not_found` if RLS hides the row).
- `save_workspace`: if `is_default=true`, server-side `before-insert/update` trigger flips all other rows' `is_default` to false in the same transaction (already exists for the partial unique index).
- `save_project`: rename routes through `rename_project_cascade(old_name, new_name, workspace_id)` RPC because `subjects.project_name` is text, no FK.
- `save_subject`: create path inserts `subjects` row + immediately inserts `subject_versions` row #0 with empty `content_markdown`, sets `current_version_id`. Atomic via a new RPC `create_subject_with_v0`.
- `save_comment`: rejects if neither `id` nor a complete create payload is supplied.

### 5.3 Error model

Unchanged from current `McpError` enum, with two additions:

- `Forbidden(String)` — used when `archive_resource` targets a workspace that owns non-archived projects (refuse cascade-via-archive; user has to archive children first). Same when archiving a project with non-archived subjects.
- `Conflict(String)` — `save_workspace` with duplicate `(user_id, name)` (existing unique constraint will raise; we map to a friendly message).

## 6. Schema changes

New migration `supabase/migrations/2026-05-14-mcp-expansion.sql`:

```sql
-- 1. Soft-delete columns
alter table workspaces add column archived_at timestamptz;
alter table projects   add column archived_at timestamptz;
alter table subjects   add column archived_at timestamptz;

-- 2. Partial indexes — default listings filter on archived_at is null
create index workspaces_active_idx on workspaces(user_id, updated_at desc)
  where archived_at is null;
create index projects_active_idx   on projects(user_id, workspace_id, updated_at desc)
  where archived_at is null;
create index subjects_active_idx   on subjects(user_id, updated_at desc)
  where archived_at is null;

-- 3. Rename-project cascade (text FK to projects.name)
create or replace function rename_project_cascade(
  old_name text, new_name text, workspace_uuid uuid
) returns void
language plpgsql security definer as $$
begin
  update projects
    set name = new_name
  where user_id = auth.uid()
    and workspace_id = workspace_uuid
    and name = old_name;
  update subjects
    set project_name = new_name
  where user_id = auth.uid()
    and project_name = old_name;
end;
$$;

-- 4. Subject-with-v0 atomic create
create or replace function create_subject_with_v0(
  p_project_name text, p_file_name text
) returns subjects
language plpgsql security definer as $$
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

  update subjects set current_version_id = new_version_id where id = new_subject.id;
  return new_subject;
end;
$$;
```

**RLS:** existing user-isolation policies remain. No new policies needed; archived rows are still visible to the owner (necessary for restore).

**Account settings storage:** `auth.users.raw_user_meta_data` JSONB. New top-level key `notter`. Note: this lives behind Supabase's Auth API (`PATCH /auth/v1/user`), **not** PostgREST (`/rest/v1/...`). The existing `SupabaseClient` Rust struct gains an `auth_patch_user(token, body)` method that uses the `/auth/v1` base URL; the access token authorizes the call directly (no service-role key needed).

```json
{
  "notter": {
    "theme": "system",
    "language": "pt-BR",
    "update_settings": { "auto_check": true, "auto_install": false },
    "default_workspace_id": "uuid-here"
  }
}
```

`update_account_settings` performs a deep-merge via PostgREST: `PATCH /auth/v1/user` with `{ data: { notter: { ...patch } } }` (Supabase merges shallow on `data`, so the tool client-side merges first then sends the full `notter` blob).

## 7. Front-end migration: localStorage → user_metadata

Theme and language live in `localStorage` today. The change:

1. On sign-in, read `user_metadata.notter`. If present, hydrate stores from it.
2. If absent AND localStorage has the legacy keys, perform a one-shot write to user_metadata and clear localStorage. Idempotent — re-running the migration after success is a no-op.
3. After the migration window (1 release), remove the localStorage read path.

Auto-update settings already live in `localStorage` (per the recent Settings refactor commit `30352d0`). Same migration path applies.

## 8. Rollout

**Phase 1 (this spec):**

1. Schema migration applied to staging, validated, then prod.
2. Rust OAuth stack lands behind a feature flag `mcp_oauth_enabled` (env var read at server boot) — default `true` on dev, `false` on the first prod build so we can flip it after smoke.
3. Bearer-legacy middleware path stays, deprecation warning logged once per process.
4. New 17-tool surface enabled.
5. Provider abstraction + new Settings → MCP UI shipped. Existing per-account JSON config files at `<appLocalData>/notter-ai/mcp/<accountId>-config.json` are **kept on disk** through Phase 1 so any client still wired to the legacy bearer keeps working; the UI no longer exposes them.
6. localStorage → user_metadata one-shot migration runs on first sign-in.

**Phase 2 (1 release later):**

1. Remove bearer-legacy code paths.
2. Remove the `mcp_oauth_enabled` flag.
3. Remove localStorage read fallback in front-end.
4. Delete the per-account JSON config files kept in Phase 1.

## 9. Testing

- **Rust unit tests** per OAuth endpoint (mirror existing `auth.rs` test pattern): metadata, register, authorize-issues-code, token-exchange happy path + bad PKCE + reused code + expired code, refresh-rotation, revoke, JWT-validation-on-/mcp.
- **Rust integration test** for each new tool (mirror existing `tools.rs` pattern but with a mocked Supabase REST). Per-tool: happy path + forbidden type + missing required field.
- **Front-end vitest** for each provider module: detect happy path, detect timeout, install (mock fs/shell), install idempotency, uninstall, isLinked.
- **Smoke script** `scripts/smoke-mcp-v2.ps1`: adapts smoke-m3.ps1. Sequence: register client → `/authorize` via headless POST (the dev-mode `?dev_auto_consent=<account_id>` query param bypasses the HTML consent screen and accepts directly; gated behind the `mcp_oauth_enabled=dev` env value, never available in prod builds) → token exchange → exercise all 17 tools → archive+restore round-trip → revoke → assertion that next call returns 401.
- **Manual checklist** appended to spec (post-merge): physically run "Conectar" for each of the 4 providers on a fresh OS install.

## 10. Open items

One verification item that surfaces during implementation, not a design hole:

- **Trigger interaction for `create_subject_with_v0`.** The RPC inserts into `subject_versions`, which has the denormalizing trigger `set_user_id_on_subject_versions` reading from `subjects` (set by the pivot's M2 migration). Because the RPC inserts the parent `subjects` row first and only then inserts the version, the trigger's lookup will succeed. To be confirmed against the actual trigger definition during M1 of the implementation plan; if it reads `subjects` via the snapshot at statement start, we need to commit + re-enter or split the RPC.

No design decisions are outstanding. Every other open question from brainstorming was either user-confirmed or locked by `2026-05-09-notter-pivot-phase1-design.md`.

## 11. Out of scope (for explicit YAGNI)

- Per-account OAuth client isolation (one client_id covers all accounts; account picked at /authorize time)
- Scope splitting (notter:read, notter:write, notter:admin) — single `notter:full` v1
- Trash/retention/restore-after-hard-delete — soft-delete only, restore lives forever
- Workspace cascade-archive in one call — user archives children first; tool refuses workspace archive with non-archived children
- Cross-account tools (an MCP call that touches account A and B) — bearer/JWT pins one account per call

---

*End of spec.*
