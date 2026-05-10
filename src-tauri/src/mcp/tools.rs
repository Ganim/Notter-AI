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

// ── stubs (filled in Phase G + H) ────────────────────────────────────────

async fn list_subjects(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError(
        "list_subjects: not yet implemented (Phase G)".into(),
    ))
}
async fn get_subject(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError(
        "get_subject: not yet implemented (Phase H)".into(),
    ))
}
async fn list_versions(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError(
        "list_versions: not yet implemented (Phase H)".into(),
    ))
}
async fn get_version(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError(
        "get_version: not yet implemented (Phase H)".into(),
    ))
}
async fn list_comments(_p: &Value, _a: &AuthContext, _s: &McpState) -> Result<Value, McpError> {
    Err(McpError::InternalError(
        "list_comments: not yet implemented (Phase H)".into(),
    ))
}
async fn post_subject_revision(
    _p: &Value,
    _a: &AuthContext,
    _s: &McpState,
) -> Result<Value, McpError> {
    Err(McpError::InternalError(
        "post_subject_revision: not yet implemented (Phase H)".into(),
    ))
}
