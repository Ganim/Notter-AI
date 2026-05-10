// src-tauri/src/mcp/tools.rs
// 6 MCP tools backed by Supabase REST. Filled in Phase G + H.
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
    let (sb, token) = crate::mcp::supabase::supabase_for(state, &auth.account_id).await?;
    // RLS scopes by user_id automatically.
    let body = sb
        .get(
            "subjects",
            "select=id,project_name,file_name,current_version_id,updated_at&order=updated_at.desc",
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
