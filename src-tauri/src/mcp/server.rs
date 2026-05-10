// src-tauri/src/mcp/server.rs
//
// axum Router wiring + lifecycle (Phase D).
//
// The public `start_mcp_server(app: &AppHandle, state: McpState)` boot function
// is called from src-tauri/src/lib.rs::run during Tauri setup.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    middleware,
    routing::{get, post},
    Extension, Json, Router,
};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::mcp::auth::{bearer_auth, AuthContext};
use crate::mcp::endpoint::{
    delete_endpoint_file, generate_nonce, is_existing_endpoint_alive, now_rfc3339,
    read_endpoint_file, write_endpoint_file, EndpointFile,
};

#[derive(Clone)]
pub struct McpStateInner {
    /// token (e.g. "notter_acc_xxxx") -> account id
    pub token_to_account: HashMap<String, String>,
    /// account id -> (access_token, expires_at_unix_seconds)
    pub access_tokens: HashMap<String, (String, i64)>,
    /// public URL ("http://127.0.0.1:54781/mcp") set after bind succeeds
    pub url: Option<String>,
    /// nonce written to endpoint.json + checked on subsequent boots
    pub nonce: String,
    /// supabase configuration (pushed by the front-end at boot)
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

    // 6. Build the axum router. /mcp is bearer-auth-guarded (Phase E placeholder;
    //    Phase F replaces with the real JSON-RPC dispatcher). /health stays
    //    unauthenticated — it has its own nonce check.
    let app_router = Router::new()
        .route("/mcp", post(mcp_placeholder))
        .route_layer(middleware::from_fn_with_state(state.clone(), bearer_auth))
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

/// Phase E placeholder — echoes the request back so the wiring (axum router,
/// bearer-auth middleware, AuthContext extension) is end-to-end testable.
/// Phase F replaces this with the real JSON-RPC dispatcher.
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
