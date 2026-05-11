// src-tauri/src/mcp/server.rs
//
// axum Router wiring + lifecycle (Phase D, refactored in M3.W2).
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
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::mcp::auth::{bearer_auth, AuthContext};
use crate::mcp::endpoint::{
    delete_endpoint_file, is_existing_endpoint_alive, now_rfc3339, read_endpoint_file,
    write_endpoint_file, EndpointFile,
};
use crate::mcp::error::McpError;
use crate::mcp::tools::dispatch;
use crate::mcp::types::JsonRpcResponse;

#[derive(Clone)]
pub struct McpStateInner {
    /// bearer token (e.g. "notter_acc_xxxx") -> account_id
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

    // 2. Token map is repopulated by the front-end (account-manager bootstrap
    // calls notifyMcpAccountRegistered for every known account). Defense
    // hook kept as a no-op in case we want to read the keyring directly later.
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

    // 5b. The front-end may have already called mcp_register_bearer before bind
    // completed (race), in which case write_per_account_configs ran with
    // s.url still None and produced files with empty url. Re-emit now that
    // url is set so the per-account files reflect the real URL.
    if let Err(e) = write_per_account_configs(app, &state).await {
        eprintln!("[mcp] post-bind write_per_account_configs failed: {e}");
    }

    eprintln!("[mcp] listening on {url}");

    // 6. Build the axum router. /mcp is bearer-auth-guarded and routes the
    //    JSON-RPC envelope to the tool dispatcher. /health stays
    //    unauthenticated — it has its own nonce check.
    let app_router = Router::new()
        .route("/mcp", post(mcp_handler))
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

/// Defense hook for a fresh launch where the front-end hasn't yet bootstrapped
/// accounts (rare race — the user must be signed in to copy the token). The
/// front-end always bootstraps before any MCP request can arrive, so this is
/// purely defensive and currently a no-op.
async fn repopulate_bearer_tokens(state: &McpState) {
    let _ = state;
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

/// JSON-RPC 2.0 entry point. Decodes the envelope, validates the protocol
/// version, then routes by method name to `tools::dispatch`. All errors are
/// returned as JSON-RPC error responses (HTTP 200 + `error` payload), per
/// the JSON-RPC 2.0 spec.
async fn mcp_handler(
    AxumState(state): AxumState<McpState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<serde_json::Value>,
) -> Json<JsonRpcResponse> {
    // Decode envelope.
    let req: crate::mcp::types::JsonRpcRequest = match serde_json::from_value(body.clone()) {
        Ok(r) => r,
        Err(e) => {
            let err = McpError::InvalidRequest(format!("invalid_request: {e}"));
            return Json(JsonRpcResponse::err(
                body.get("id").cloned(),
                err.code(),
                err.message(),
            ));
        }
    };

    if req.jsonrpc != "2.0" {
        let err = McpError::InvalidRequest("invalid_request: jsonrpc must be '2.0'".into());
        return Json(JsonRpcResponse::err(req.id, err.code(), err.message()));
    }

    let id = req.id.clone();
    match dispatch(&req.method, &req.params, &auth, &state).await {
        Ok(result) => Json(JsonRpcResponse::ok(id, result)),
        Err(e) => Json(JsonRpcResponse::err(id, e.code(), e.message())),
    }
}

// ---------------------------------------------------------------------------
// Per-account stable config file
// ---------------------------------------------------------------------------
//
// External CLIs prefer a stable file path they can point at in their MCP
// config. `endpoint.json` carries the live URL but is shared across all
// accounts. For each registered account we additionally write
// `<appLocalData>/notter-ai/mcp/<accountId>-config.json` containing the URL +
// that account's bearer token, refreshed on every `mcp_register_bearer` call.

#[derive(serde::Serialize, serde::Deserialize)]
pub struct McpAccountConfig {
    pub url: String,
    pub bearer_token: String,
    pub account_id: String,
    pub generated_at: String,
}

/// Iterate the current `token_to_account` map and write one
/// `<accountId>-config.json` per registered account. Each file is rewritten in
/// full on every call; we never merge/patch.
///
/// Also performs the M3.W → M3.W2 clean-break cleanup: any legacy
/// `<accountId>-<workspaceId>-config.json` files left over from the
/// workspace-scoped phase are deleted.
///
/// Takes a read lock internally — callers MUST drop any write lock on `state`
/// before invoking this (tokio's RwLock is not reentrant).
pub async fn write_per_account_configs(
    app: &AppHandle,
    state: &McpState,
) -> Result<(), String> {
    let dir = mcp_dir(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create_dir_all: {e}"))?;

    let (url, entries) = {
        let s = state.read().await;
        let url = s.url.clone().unwrap_or_default();
        let entries: Vec<(String, String)> = s
            .token_to_account
            .iter()
            .map(|(tok, account_id)| (tok.clone(), account_id.clone()))
            .collect();
        (url, entries)
    };

    let generated_at = crate::mcp::endpoint::now_rfc3339();

    for (bearer_token, account_id) in entries {
        let cfg = McpAccountConfig {
            url: url.clone(),
            bearer_token,
            account_id: account_id.clone(),
            generated_at: generated_at.clone(),
        };
        let json =
            serde_json::to_string_pretty(&cfg).map_err(|e| format!("serde: {e}"))?;
        let path = dir.join(format!("{}-config.json", account_id));
        tokio::fs::write(&path, json)
            .await
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }

    // M3.W2 cleanup: delete leftover `<accountId>-<workspaceId>-config.json`.
    // UUIDs already contain 4 dashes, so `<uuid>-config.json` has 5 dashes and
    // `<uuid>-<uuid>-config.json` has 10. Detect legacy by counting dashes in
    // the prefix (the part before `-config.json`) and removing anything with
    // more than one UUID's worth of dashes.
    const SUFFIX: &str = "-config.json";
    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(prefix) = name.strip_suffix(SUFFIX) else { continue };
            // A bare UUID has exactly 4 dashes. Anything with more is a
            // workspace-scoped legacy file (`<uuid>-<uuid>` = 9 dashes).
            if prefix.matches('-').count() > 4 {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAccountConfigArgs {
    pub account_id: String,
}

/// Tauri command — the McpConfigDialog calls this to display the active
/// account's MCP URL + bearer token. Synthesizes the config directly from
/// in-memory state.
#[tauri::command]
pub async fn mcp_read_account_config(
    args: ReadAccountConfigArgs,
    state: tauri::State<'_, McpState>,
) -> Result<McpAccountConfig, String> {
    let s = state.read().await;
    let url = s
        .url
        .clone()
        .ok_or_else(|| "MCP server not yet bound".to_string())?;
    let (bearer, account_id) = s
        .token_to_account
        .iter()
        .find(|(_, owner)| **owner == args.account_id)
        .map(|(tok, owner)| (tok.clone(), owner.clone()))
        .ok_or_else(|| format!("no bearer registered for account {}", args.account_id))?;
    Ok(McpAccountConfig {
        url,
        bearer_token: bearer,
        account_id,
        generated_at: crate::mcp::endpoint::now_rfc3339(),
    })
}
