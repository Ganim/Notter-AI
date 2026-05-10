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
