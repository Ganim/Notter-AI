// src-tauri/src/mcp/tools.rs
// 6 MCP tools backed by Supabase REST. Filled in Phase G + H.
//
// Workspace scoping (Phase H): every tool restricts its reads/writes to the
// projects belonging to the request's workspace. Two helpers:
//   * `workspace_project_names` returns the project names for the current
//     `(account, workspace)` — used by tools that filter the `subjects`
//     table.
//   * `assert_subject_in_workspace` is the guard called at the top of every
//     subject-keyed tool. Without it, a workspace A bearer could read a
//     subject in workspace B by guessing the UUID (RLS only enforces user_id,
//     not workspace_id — subjects don't carry workspace_id directly).

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
        // MCP "ping" is sometimes used by clients as a liveness check;
        // accept it as an empty-result success.
        "ping" => Ok(Value::Object(Default::default())),
        other => Err(McpError::MethodNotFound(format!(
            "method '{other}' not found"
        ))),
    }
}

// ── tools ────────────────────────────────────────────────────────────────

async fn list_subjects(
    _params: &Value,
    auth: &AuthContext,
    state: &McpState,
) -> Result<Value, McpError> {
    let names = workspace_project_names(auth, state).await?;
    if names.is_empty() {
        return Ok(serde_json::json!([]));
    }
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subjects",
            &format!(
                "select=id,project_name,file_name,current_version_id,updated_at&project_name={}&order=updated_at.desc",
                build_in_clause(&names),
            ),
            &token,
        )
        .await?;
    Ok(body)
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
    assert_subject_in_workspace(auth, state, &p.subject_id).await?;
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
    assert_subject_in_workspace(auth, state, &p.subject_id).await?;
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
    // Workspace guard — the subject_id is included in the row above; assert
    // it belongs to the request's workspace before returning.
    let subject_id = row
        .get("subject_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::SupabaseError("get_version: missing subject_id".into()))?
        .to_string();
    assert_subject_in_workspace(auth, state, &subject_id).await?;
    Ok(row)
}

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
    assert_subject_in_workspace(auth, state, &p.subject_id).await?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let mut q = format!(
        "select=id,version_id,body,resolved,author_user_id,created_at&subject_id=eq.{}&order=created_at.asc",
        url_encode(&p.subject_id)
    );
    if let Some(vid) = p.version_id {
        q.push_str(&format!("&version_id=eq.{}", url_encode(&vid)));
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
    assert_subject_in_workspace(auth, state, &p.subject_id).await?;
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
    let response = sb
        .post("subject_versions", &payload, &token, true)
        .await?;

    // Supabase returns the inserted row(s) as an array when Prefer:return=representation is set.
    let row = response
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| {
            McpError::SupabaseError("post_subject_revision: insert returned no row".into())
        })?;
    let id = row
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(serde_json::json!({ "version_id": id }))
}

// ── helpers ──────────────────────────────────────────────────────────────

/// Resolve the project names belonging to the current `(account, workspace)`.
/// Subject-table tools then filter `project_name in (...)` against this list.
/// One Supabase round-trip per call — acceptable in Phase 1; tighten later if
/// it shows up in profiling.
async fn workspace_project_names(
    auth: &AuthContext,
    state: &McpState,
) -> Result<Vec<String>, McpError> {
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "projects",
            &format!(
                "select=name&workspace_id=eq.{}",
                url_encode(&auth.workspace_id),
            ),
            &token,
        )
        .await?;
    let names: Vec<String> = body
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|row| {
                    row.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(names)
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

/// Workspace guard for every subject-keyed tool. Fetches the subject's
/// `project_name`, then verifies that name appears in the workspace's project
/// list. Returns `NotFound` (not `Forbidden`) on miss to avoid leaking the
/// fact that the subject exists in another workspace.
async fn assert_subject_in_workspace(
    auth: &AuthContext,
    state: &McpState,
    subject_id: &str,
) -> Result<(), McpError> {
    let names = workspace_project_names(auth, state).await?;
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    let body = sb
        .get(
            "subjects",
            &format!(
                "select=project_name&id=eq.{}&limit=1",
                url_encode(subject_id)
            ),
            &token,
        )
        .await?;
    let pname = body
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.get("project_name"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::NotFound(format!("subject {subject_id} not found")))?;
    if !names.iter().any(|n| n == pname) {
        return Err(McpError::NotFound(format!(
            "subject {subject_id} not found"
        )));
    }
    Ok(())
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
