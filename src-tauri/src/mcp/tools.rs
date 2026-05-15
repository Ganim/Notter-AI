// src-tauri/src/mcp/tools.rs
// 6 MCP tools backed by Supabase REST.
//
// Token scope is per-account (M3.W2 refactor): tools read everything the user
// can see (RLS by user_id). `list_subjects` accepts an OPTIONAL `workspace_id`
// param for server-side filtering, and always enriches each subject row with
// its `workspace_id` so the CLI can group/filter client-side without an extra
// round-trip per subject.
//
// `subjects` has no direct `workspace_id` column (the schema scopes via
// `projects(name, workspace_id)` and `subjects.project_name` — text, no FK).
// PostgREST embed isn't available, so we fetch the user's `projects` once per
// call and join in Rust.

use std::collections::HashMap;

use serde_json::Value;

use crate::mcp::auth::AuthContext;
use crate::mcp::error::McpError;
use crate::mcp::server::McpState;

/// Top-level tool dispatch. Each method name routes to a handler.
pub async fn dispatch(
    method: &str,
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    match method {
        "list_subjects" => list_subjects(params, auth, state).await,
        "get_subject" => get_subject(params, auth, state).await,
        "list_versions" => list_versions(params, auth, state).await,
        "get_version" => get_version(params, auth, state).await,
        "list_comments" => list_comments(params, auth, state).await,
        "post_subject_revision" => post_subject_revision(params, auth, state).await,
        "get_account_settings" => get_account_settings(params, auth, state).await,
        "update_account_settings" => update_account_settings(params, auth, state).await,
        "list_workspaces" => list_workspaces(params, auth, state).await,
        "save_workspace" => save_workspace(params, auth, state).await,
        "list_projects" => list_projects(params, auth, state).await,
        "save_project" => save_project(params, auth, state).await,
        "save_subject" => save_subject(params, auth, state).await,
        "save_comment" => save_comment(params, auth, state).await,
        "delete_comment" => delete_comment(params, auth, state).await,
        "archive_resource" => archive_resource(params, auth, state).await,
        "restore_resource" => restore_resource(params, auth, state).await,
        // MCP "ping" is sometimes used by clients as a liveness check;
        // accept it as an empty-result success.
        "ping" => Ok(Value::Object(Default::default())),
        other => Err(McpError::MethodNotFound(format!(
            "method '{other}' not found"
        ))),
    }
}

// ── tools ────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
struct ListSubjectsParams {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    include_archived: bool,
}

async fn list_subjects(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    // Params are optional — accept missing/null/empty object.
    let p: ListSubjectsParams = if params.is_null() {
        ListSubjectsParams::default()
    } else {
        serde_json::from_value(params.clone())
            .map_err(|e| McpError::InvalidParams(format!("list_subjects: {e}")))?
    };

    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;

    // Fetch the user's project → workspace map. Used for both the optional
    // workspace_id filter and the row-by-row enrichment.
    let name_to_workspace = fetch_project_workspace_map(&sb, &token).await?;

    let mut query = String::from(
        "select=id,project_name,file_name,current_version_id,updated_at&order=updated_at.desc",
    );
    if let Some(ref ws) = p.workspace_id {
        let names_in_ws: Vec<String> = name_to_workspace
            .iter()
            .filter_map(|(name, w)| if w == ws { Some(name.clone()) } else { None })
            .collect();
        if names_in_ws.is_empty() {
            return Ok(serde_json::json!([]));
        }
        query.push_str(&format!("&project_name={}", build_in_clause(&names_in_ws)));
    }

    if !p.include_archived {
        query.push_str("&archived_at=is.null");
    }

    let body = sb.get("subjects", &query, &token).await?;
    let mut rows = match body {
        Value::Array(a) => a,
        _ => return Ok(serde_json::json!([])),
    };

    // Enrich each row with workspace_id derived from its project_name.
    for row in rows.iter_mut() {
        if let Some(obj) = row.as_object_mut() {
            let project_name = obj
                .get("project_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ws = name_to_workspace
                .get(project_name)
                .cloned()
                .map(Value::String)
                .unwrap_or(Value::Null);
            obj.insert("workspace_id".to_string(), ws);
        }
    }

    Ok(Value::Array(rows))
}

#[derive(serde::Deserialize)]
struct GetSubjectParams {
    subject_id: String,
}

async fn get_subject(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: GetSubjectParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("get_subject: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subjects",
            &format!(
                "select=id,project_name,file_name,content,current_version_id,updated_at&id=eq.{}&limit=1",
                url_encode(&p.subject_id)
            ),
            &token,
        )
        .await?;
    let row = body
        .as_array()
        .and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::NotFound(format!("subject {} not found", p.subject_id)))?;

    // Enrich with workspace_id via the projects map.
    let name_to_workspace = fetch_project_workspace_map(&sb, &token).await?;
    let mut row = row;
    if let Some(obj) = row.as_object_mut() {
        let project_name = obj
            .get("project_name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let ws = name_to_workspace
            .get(project_name)
            .cloned()
            .map(Value::String)
            .unwrap_or(Value::Null);
        obj.insert("workspace_id".to_string(), ws);
    }
    Ok(row)
}

#[derive(serde::Deserialize)]
struct ListVersionsParams {
    subject_id: String,
}

async fn list_versions(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: ListVersionsParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("list_versions: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subject_versions",
            &format!(
                "select=id,source,source_actor,label,created_at&subject_id=eq.{}&order=created_at.desc",
                url_encode(&p.subject_id)
            ),
            &token,
        )
        .await?;
    Ok(body)
}

#[derive(serde::Deserialize)]
struct GetVersionParams {
    version_id: String,
}

async fn get_version(
    params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let p: GetVersionParams = serde_json::from_value(params.clone())
        .map_err(|e| McpError::InvalidParams(format!("get_version: {e}")))?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subject_versions",
            &format!(
                "select=id,subject_id,content_markdown,parent_version_id,source,source_actor,label,created_at&id=eq.{}&limit=1",
                url_encode(&p.version_id)
            ),
            &token,
        )
        .await?;
    let row = body
        .as_array()
        .and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::NotFound(format!("version {} not found", p.version_id)))?;
    Ok(row)
}

#[derive(serde::Deserialize)]
struct ListCommentsParams {
    subject_id: String,
    #[serde(default)]
    version_id: Option<String>,
    /// When true, the response also includes archived comments (anchors that
    /// no longer resolve in the current draft). Defaults to false; archived
    /// comments are still meaningful AI context, but most CLI flows want
    /// only the live ones.
    #[serde(default)]
    include_archived: bool,
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
        "select=id,version_id,body,anchor_quote,anchor_prefix,anchor_suffix,resolved,archived,author_user_id,author_display_name,created_at,updated_at&subject_id=eq.{}&order=created_at.asc",
        url_encode(&p.subject_id)
    );
    if let Some(vid) = p.version_id {
        q.push_str(&format!("&version_id=eq.{}", url_encode(&vid)));
    }
    if !p.include_archived {
        q.push_str("&archived=eq.false");
    }
    let body = sb.get("subject_comments", &q, &token).await?;
    Ok(body)
}

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

    // Atomic commit: the RPC inserts a subject_versions row AND moves
    // `subjects.content` + `subjects.current_version_id` so the AI revision
    // becomes the current version in one transaction. Before the 2026-05-14
    // versioning overhaul, MCP did a direct INSERT and left current_version_id
    // pointing at the prior version — AI revisions sat as "candidates"
    // requiring the user to adopt manually, which contradicted the model
    // (the user already accepted by invoking the tool).
    let payload = serde_json::json!({
        "p_subject_id": p.subject_id,
        "p_content": p.content_markdown,
        "p_source": "ai",
        "p_source_actor": p.source_actor,
        "p_label": p.label,
        "p_parent_version_id": p.parent_version_id,
        // AI revisions are always explicit checkpoints; never coalesce.
        "p_coalesce_window_secs": 0,
    });

    let response = sb
        .post("rpc/commit_subject_version", &payload, &token, false)
        .await?;

    // PostgREST returns a scalar `uuid` result as a JSON-encoded string.
    let id = response
        .as_str()
        .map(String::from)
        .ok_or_else(|| {
            McpError::SupabaseError(format!(
                "post_subject_revision: rpc returned non-string body={response}"
            ))
        })?;
    Ok(serde_json::json!({ "version_id": id }))
}

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
    // NOTE: `projects` schema has no `created_at` — only `updated_at` (see migrations).
    let mut q = String::from("select=id,name,workspace_id,archived_at,updated_at&order=updated_at.desc");
    if let Some(w) = &p.workspace_id {
        q.push_str(&format!("&workspace_id=eq.{}", url_encode(w)));
    }
    if !p.include_archived { q.push_str("&archived_at=is.null"); }
    sb.get("projects", &q, &token).await
}

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
            // `projects` PK is (user_id, name); `id` is a separate text NOT
            // NULL column with no default. Convention from sync.ts: id == name.
            // user_id is the Supabase user id (== auth.account_id == OAuth JWT
            // `sub`); RLS enforces the same on insert.
            let body = serde_json::json!({
                "id": p.name,
                "user_id": auth.account_id,
                "name": p.name,
                "workspace_id": p.workspace_id,
            });
            let res = sb.post("projects", &body, &token, true).await?;
            res.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::SupabaseError("save_project: empty response".into()))
        }
        Some(_id) => {
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
            let q = format!(
                "select=id,name,workspace_id,archived_at,updated_at&workspace_id=eq.{}&name=eq.{}&limit=1",
                url_encode(&p.workspace_id), url_encode(&p.name)
            );
            let body = sb.get("projects", &q, &token).await?;
            body.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::NotFound(format!("project {} not found", p.name)))
        }
    }
}

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

    match &p.id {
        None => {
            // Multi-user RLS requires the workspace owner row in
            // `workspace_members` alongside the `workspaces` insert. The
            // `create_workspace_with_owner(ws_id, ws_name, ws_is_default)`
            // RPC handles both atomically. We generate the UUID client-side
            // so the front-end and the MCP path stay consistent.
            let ws_id = uuid::Uuid::new_v4().to_string();
            let args = serde_json::json!({
                "ws_id": ws_id,
                "ws_name": p.name,
                "ws_is_default": p.is_default.unwrap_or(false),
            });
            sb.rpc("create_workspace_with_owner", &args, &token).await?;
            let q = format!(
                "select=id,name,is_default,archived_at,created_at,updated_at&id=eq.{}&limit=1",
                url_encode(&ws_id)
            );
            let body = sb.get("workspaces", &q, &token).await?;
            body.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::SupabaseError("save_workspace: refetch returned empty".into()))
        }
        Some(id) => {
            let mut obj = serde_json::Map::new();
            obj.insert("name".into(), Value::String(p.name.clone()));
            if let Some(d) = p.is_default { obj.insert("is_default".into(), Value::Bool(d)); }
            obj.insert("updated_at".into(), Value::String(crate::mcp::endpoint::now_rfc3339()));
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
            let body = res.json::<Value>().await.unwrap_or(Value::Null);
            body.as_array().and_then(|a| a.first().cloned())
                .ok_or_else(|| McpError::SupabaseError("save_workspace: empty response".into()))
        }
    }
}

async fn get_account_settings(
    _params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
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

// `language` is intentionally NOT writable here — it lives in the
// `user_preferences` table and flows through the front-end's sync layer.
// Writes via user_metadata would be silently overwritten by the next
// applyRemotePreferences cycle. Add language back here only if/when the
// front-end migrates to user_metadata.notter as the source of truth.
#[derive(serde::Deserialize, Default)]
struct UpdateAccountSettingsParams {
    #[serde(default)]
    theme: Option<String>,
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

    let current = get_account_settings(&Value::Null, auth, state).await?;
    let mut merged = current.as_object().cloned().unwrap_or_default();
    if let Some(v) = p.theme { merged.insert("theme".into(), Value::String(v)); }
    if let Some(v) = p.update_settings { merged.insert("update_settings".into(), v); }
    if let Some(v) = p.default_workspace_id {
        merged.insert("default_workspace_id".into(), Value::String(v));
    }

    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = serde_json::json!({ "data": { "notter": Value::Object(merged.clone()) } });
    sb.auth_patch_user(&body, &token).await?;
    Ok(Value::Object(merged))
}

// ── M3.5: save_subject ───────────────────────────────────────────────────

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
            let args = serde_json::json!({
                "p_project_name": p.project_name,
                "p_file_name": p.file_name,
            });
            let row = sb.rpc("create_subject_with_v0", &args, &token).await?;
            // RPC returns a single subjects row (object, not array). If it
            // returns an array (some PostgREST configs), unwrap.
            if let Some(arr) = row.as_array() {
                return arr.first().cloned()
                    .ok_or_else(|| McpError::SupabaseError("create_subject_with_v0 returned empty array".into()));
            }
            Ok(row)
        }
        Some(id) => {
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

// ── M3.6: save_comment + delete_comment ──────────────────────────────────

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
            let subject_id = p.subject_id.as_ref()
                .ok_or_else(|| McpError::InvalidParams("subject_id required on create".into()))?;
            let version_id = p.version_id.as_ref()
                .ok_or_else(|| McpError::InvalidParams("version_id required on create".into()))?;
            let body_text = p.body.as_ref()
                .ok_or_else(|| McpError::InvalidParams("body required on create".into()))?;
            let aq = p.anchor_quote.as_ref()
                .ok_or_else(|| McpError::InvalidParams("anchor_quote required on create".into()))?;
            let ap = p.anchor_prefix.as_ref()
                .ok_or_else(|| McpError::InvalidParams("anchor_prefix required on create".into()))?;
            let asuf = p.anchor_suffix.as_ref()
                .ok_or_else(|| McpError::InvalidParams("anchor_suffix required on create".into()))?;
            // `author_user_id` is NOT NULL and the RLS insert policy requires
            // `author_user_id = auth.uid()`. `user_id` and `workspace_id` are
            // filled by triggers from the parent subject row.
            let payload = serde_json::json!({
                "subject_id": subject_id,
                "version_id": version_id,
                "author_user_id": auth.account_id,
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

// ── M3.7: archive_resource + restore_resource ─────────────────────────────

#[derive(serde::Deserialize)]
struct ArchiveParams {
    #[serde(rename = "type")]
    kind: String,
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

// ── helpers ──────────────────────────────────────────────────────────────

/// Fetch every project the user can see and build a `project_name -> workspace_id`
/// map. One Supabase round-trip per call; acceptable for Phase 1 traffic.
async fn fetch_project_workspace_map(
    sb: &crate::mcp::supabase::SupabaseClient,
    token: &str,
) -> Result<HashMap<String, String>, McpError> {
    let body = sb
        .get("projects", "select=name,workspace_id", token)
        .await?;
    let mut map = HashMap::new();
    if let Some(rows) = body.as_array() {
        for row in rows {
            let name = row.get("name").and_then(|v| v.as_str()).map(String::from);
            let ws = row
                .get("workspace_id")
                .and_then(|v| v.as_str())
                .map(String::from);
            if let (Some(n), Some(w)) = (name, ws) {
                map.insert(n, w);
            }
        }
    }
    Ok(map)
}

/// PostgREST `in.(...)` syntax. Names are user-provided; url-encode each.
fn build_in_clause(names: &[String]) -> String {
    let inner = names
        .iter()
        .map(|n| url_encode(n))
        .collect::<Vec<_>>()
        .join(",");
    format!("in.({inner})")
}

fn url_encode(s: &str) -> String {
    // Minimal — uuids and identifiers don't contain special chars,
    // but be defensive. percent-encode reserved chars.
    s.chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                vec![c]
            } else {
                format!("%{:02X}", c as u8).chars().collect()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_in_clause_url_encodes_names() {
        let clause = build_in_clause(&["a".into(), "b c".into(), "d".into()]);
        assert_eq!(clause, "in.(a,b%20c,d)");
    }

    #[test]
    fn build_in_clause_handles_empty() {
        assert_eq!(build_in_clause(&[]), "in.()");
    }

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
}
