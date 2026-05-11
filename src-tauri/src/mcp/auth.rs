// src-tauri/src/mcp/auth.rs
//
// In-memory token maps + Tauri commands the front-end calls on every auth
// event to keep state fresh.
//
// Token scope is per-account (M3.W2 refactor): 1 bearer per Supabase account.
// Workspaces are no longer part of the bearer surface — the CLI gets the same
// view as the signed-in user (RLS by user_id) and optionally narrows by
// workspace_id at tool-call time.

use crate::mcp::server::{McpState, McpStateInner};
use serde::{Deserialize, Serialize};

/// Per-request authentication context inserted into axum's request extensions
/// by the Bearer-auth middleware.
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub account_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAccountTokenArgs {
    pub account_id: String,
    pub access_token: String,
    pub expires_at: i64, // unix seconds
}

/// Tauri command — front-end calls on every Supabase TOKEN_REFRESHED / SIGNED_IN.
#[tauri::command]
pub async fn mcp_update_account_token(
    args: UpdateAccountTokenArgs,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens
        .insert(args.account_id, (args.access_token, args.expires_at));
    Ok(())
}

/// Tauri command — front-end calls when an account is REMOVED from
/// AccountManager (hard revocation). Drops the per-account access token AND
/// the bearer mapping. NOT called on signOut — signOut keeps the account
/// cadastrada and uses `mcp_clear_account_access_token` (soft) instead so the
/// bearer survives the round-trip.
#[tauri::command]
pub async fn mcp_remove_account_token(
    account_id: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens.remove(&account_id);
    s.token_to_account
        .retain(|_, owner| owner != &account_id);
    Ok(())
}

/// Tauri command — soft clear of the per-account access token. Used by
/// signOut: the Supabase session ends but the account stays cadastrada, so
/// the bearer (which represents the account identity, not the session) must
/// survive. Next sign-in re-pushes the access token via the
/// `SIGNED_IN` / `TOKEN_REFRESHED` listener.
#[tauri::command]
pub async fn mcp_clear_account_access_token(
    account_id: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens.remove(&account_id);
    Ok(())
}

/// Resolve a Bearer token to its account_id by reading the in-memory map.
/// Returns None on miss (the middleware turns that into 401).
pub async fn lookup_account_for_token(state: &McpState, bearer: &str) -> Option<String> {
    let s = state.read().await;
    s.token_to_account.get(bearer).cloned()
}

/// Return the current access-token for an account, plus its expiry.
/// Returns None if absent OR expired (caller maps to `auth_pending` JSON-RPC error).
#[allow(dead_code)] // consumed by Supabase REST client
pub async fn current_access_token(state: &McpState, account_id: &str) -> Option<String> {
    let s = state.read().await;
    let (tok, expires_at) = s.access_tokens.get(account_id)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Treat tokens within 30 s of expiry as expired so we don't race the
    // front-end's autoRefresh.
    if *expires_at - 30 < now {
        return None;
    }
    Some(tok.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSupabaseConfigArgs {
    pub url: String,
    pub anon_key: String,
}

/// Tauri command — front-end calls at boot to push the Supabase URL + anon key.
#[tauri::command]
pub async fn mcp_set_supabase_config(
    args: SetSupabaseConfigArgs,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s: tokio::sync::RwLockWriteGuard<'_, McpStateInner> = state.write().await;
    s.supabase_url = args.url;
    s.supabase_anon_key = args.anon_key;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterBearerArgs {
    pub account_id: String,
    pub bearer_token: String,
}

/// Tauri command — front-end calls at boot (per known account) and on
/// AccountManager.add() to register the `(bearer -> account_id)` mapping.
/// Replaces any existing bearer for the same account so rotation doesn't leave
/// stale tokens behind. After updating the map, the per-account stable config
/// file is (re)written so external CLIs see the new bearer.
#[tauri::command]
pub async fn mcp_register_bearer(
    args: RegisterBearerArgs,
    app: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    {
        let mut s = state.write().await;
        // Drop any prior bearer mapped to the same account.
        s.token_to_account
            .retain(|_, owner| owner != &args.account_id);
        s.token_to_account
            .insert(args.bearer_token, args.account_id.clone());
    }
    // Drop the write lock above before calling write_per_account_configs —
    // it takes a read lock internally and tokio's RwLock is not reentrant.
    let _ = crate::mcp::server::write_per_account_configs(&app, state.inner()).await;
    Ok(())
}

use axum::{
    extract::{Request, State as AxumState},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

/// Bearer-auth middleware. Rejects with 401 + JSON-RPC unauthorized error if
/// the Authorization header is absent, malformed, or carries an unknown token.
/// On success, stores AuthContext in the request extensions for handlers to read.
pub async fn bearer_auth(
    AxumState(state): AxumState<crate::mcp::server::McpState>,
    mut req: Request,
    next: Next,
) -> Response {
    let bearer = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));

    let Some(token) = bearer else {
        return unauthorized_response("missing or malformed Authorization header");
    };

    let account_id = match lookup_account_for_token(&state, token).await {
        Some(a) => a,
        None => return unauthorized_response("unknown token"),
    };

    req.extensions_mut().insert(AuthContext { account_id });
    next.run(req).await
}

fn unauthorized_response(msg: &str) -> Response {
    let err = crate::mcp::error::McpError::Unauthorized(format!("unauthorized: {msg}"));
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": err.code(),
                "message": err.message(),
            }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::server::McpStateInner;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn make_state() -> McpState {
        Arc::new(RwLock::new(McpStateInner {
            token_to_account: HashMap::new(),
            access_tokens: HashMap::new(),
            url: None,
            nonce: "test-nonce".to_string(),
            supabase_url: String::new(),
            supabase_anon_key: String::new(),
        }))
    }

    #[tokio::test]
    async fn lookup_account_for_token_returns_account_id() {
        let state = make_state();
        {
            let mut s = state.write().await;
            s.token_to_account.insert("tok-a".into(), "acc-1".into());
        }
        let owner = lookup_account_for_token(&state, "tok-a").await;
        assert_eq!(owner, Some("acc-1".to_string()));
    }

    #[tokio::test]
    async fn lookup_account_for_token_misses_unknown_bearer() {
        let state = make_state();
        assert_eq!(lookup_account_for_token(&state, "nope").await, None);
    }

    #[tokio::test]
    async fn remove_account_drops_account_bearer_and_access_token() {
        let state = make_state();
        {
            let mut s = state.write().await;
            s.access_tokens
                .insert("acc-1".into(), ("at".into(), i64::MAX));
            s.token_to_account.insert("tok-a".into(), "acc-1".into());
            s.token_to_account.insert("tok-c".into(), "acc-2".into());
        }
        // Simulate mcp_remove_account_token by exercising the same retain.
        {
            let mut s = state.write().await;
            s.access_tokens.remove("acc-1");
            s.token_to_account.retain(|_, owner| owner != "acc-1");
        }
        let s = state.read().await;
        assert!(s.access_tokens.get("acc-1").is_none());
        assert_eq!(s.token_to_account.len(), 1);
        assert!(s.token_to_account.contains_key("tok-c"));
    }

    #[tokio::test]
    async fn soft_clear_drops_only_access_token() {
        // Verifies the signOut contract: bearer stays, access token goes.
        let state = make_state();
        {
            let mut s = state.write().await;
            s.access_tokens
                .insert("acc-1".into(), ("at".into(), i64::MAX));
            s.token_to_account.insert("tok-a".into(), "acc-1".into());
        }
        // Simulate mcp_clear_account_access_token.
        {
            let mut s = state.write().await;
            s.access_tokens.remove("acc-1");
        }
        let s = state.read().await;
        assert!(s.access_tokens.get("acc-1").is_none());
        assert_eq!(s.token_to_account.len(), 1);
        assert_eq!(s.token_to_account.get("tok-a"), Some(&"acc-1".to_string()));
    }

    #[tokio::test]
    async fn register_bearer_replaces_existing_for_same_account() {
        // Verifies the rotation contract: a second register with a new bearer
        // for the same account drops the old bearer.
        let state = make_state();
        {
            let mut s = state.write().await;
            s.token_to_account.insert("tok-old".into(), "acc-1".into());
        }
        // Apply the same retain + insert mcp_register_bearer uses.
        {
            let mut s = state.write().await;
            s.token_to_account.retain(|_, owner| owner != "acc-1");
            s.token_to_account.insert("tok-new".into(), "acc-1".into());
        }
        let s = state.read().await;
        assert_eq!(s.token_to_account.len(), 1);
        assert!(s.token_to_account.contains_key("tok-new"));
        assert!(!s.token_to_account.contains_key("tok-old"));
    }
}
