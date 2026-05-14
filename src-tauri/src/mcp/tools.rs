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

    let body = match &p.id {
        None => {
            let mut obj = serde_json::Map::new();
            obj.insert("name".into(), Value::String(p.name.clone()));
            if let Some(d) = p.is_default { obj.insert("is_default".into(), Value::Bool(d)); }
            sb.post("workspaces", &Value::Object(obj), &token, true).await?
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
            res.json::<Value>().await.unwrap_or(Value::Null)
        }
    };

    body.as_array().and_then(|a| a.first().cloned())
        .ok_or_else(|| McpError::SupabaseError("save_workspace: empty response".into()))
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
}
