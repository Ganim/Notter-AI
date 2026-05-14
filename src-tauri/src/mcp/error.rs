// src-tauri/src/mcp/error.rs
// MCP error enum + JSON-RPC error code mapping.
//
// We don't currently have `thiserror` in Cargo.toml. To avoid bloating deps,
// hand-roll the Error impl instead.

#[derive(Debug)]
pub enum McpError {
    /// JSON-RPC -32700: parse error. Reserved — axum's Json extractor rejects
    /// malformed JSON at the HTTP layer before our handler runs, so we never
    /// emit this today. Kept for future SSE / batch parsers.
    #[allow(dead_code)]
    ParseError(String),
    /// -32600: invalid request shape.
    InvalidRequest(String),
    /// -32601: method not found.
    MethodNotFound(String),
    /// -32602: invalid params.
    InvalidParams(String),
    /// -32603: internal error. Reserved as a generic fallback for future
    /// dispatch panics or tool-side bugs.
    #[allow(dead_code)]
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
    /// -32005 (Notter-specific): the operation is refused because of state
    /// preconditions (e.g. archive a workspace that still has live projects).
    #[allow(dead_code)]
    Forbidden(String),
    /// -32006 (Notter-specific): the operation conflicts with an existing
    /// resource (e.g. duplicate workspace name for the same user).
    #[allow(dead_code)]
    Conflict(String),
}

impl McpError {
    pub fn code(&self) -> i32 {
        use McpError::*;
        match self {
            ParseError(_) => -32700,
            InvalidRequest(_) => -32600,
            MethodNotFound(_) => -32601,
            InvalidParams(_) => -32602,
            InternalError(_) => -32603,
            AuthPending => -32001,
            Unauthorized(_) => -32002,
            NotFound(_) => -32003,
            SupabaseError(_) => -32004,
            Forbidden(_) => -32005,
            Conflict(_) => -32006,
        }
    }
    pub fn message(&self) -> String {
        use McpError::*;
        match self {
            ParseError(m)
            | InvalidRequest(m)
            | MethodNotFound(m)
            | InvalidParams(m)
            | InternalError(m)
            | Unauthorized(m)
            | NotFound(m)
            | SupabaseError(m)
            | Forbidden(m)
            | Conflict(m) => m.clone(),
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
