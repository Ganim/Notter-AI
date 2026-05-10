// src-tauri/src/mcp/auth.rs
//
// In-memory token maps + the Tauri commands that the front-end calls on every
// auth-state change to keep the access-token slice fresh.
//
// Workspace-aware (M3.W / Phase H): bearer tokens are now mapped to
// `AuthOwner { account_id, workspace_id }` so a single account can have
// multiple workspaces, each with its own bearer. Access tokens are still
// per-account because Supabase sessions are per-user, not per-workspace.

use crate::mcp::server::{McpState, McpStateInner};
use serde::{Deserialize, Serialize};

/// In-memory owner record for a bearer token. One per `(account, workspace)`
/// pair — the bearer is the key; this is the value.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AuthOwner {
    pub account_id: String,
    pub workspace_id: String,
}

/// Per-request authentication context inserted into axum's request extensions
/// by the Bearer-auth middleware.
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub account_id: String,
    pub workspace_id: String,
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

/// Tauri command — front-end calls when an account is removed from
/// AccountManager (also on signOut). Drops the per-account access token AND
/// every bearer (across all workspaces) that belongs to this account.
#[tauri::command]
pub async fn mcp_remove_account_token(
    account_id: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens.remove(&account_id);
    // Drop every bearer mapped to this account, regardless of workspace.
    s.token_to_owner
        .retain(|_, owner| owner.account_id != account_id);
    Ok(())
}

/// Resolve a Bearer token to its `AuthOwner` by reading the in-memory map.
/// Returns None on miss (the middleware turns that into 401).
pub async fn lookup_owner_for_token(
    state: &McpState,
    bearer: &str,
) -> Option<AuthOwner> {
    let s = state.read().await;
    s.token_to_owner.get(bearer).cloned()
}

/// Return the current access-token for an account, plus its expiry.
/// Returns None if absent OR expired (caller maps to `auth_pending` JSON-RPC error).
#[allow(dead_code)] // Consumed in Phase G (Supabase REST client).
pub async fn current_access_token(
    state: &McpState,
    account_id: &str,
) -> Option<String> {
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

/// Tauri command — front-end calls at boot to push the Supabase URL + anon key
/// (which Vite bundles into the front-end JS via `import.meta.env.VITE_*` and
/// are NOT exposed to Rust). Replaces the planned `std::env::var` stopgap.
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
    pub workspace_id: String,
    pub bearer_token: String,
}

/// Tauri command — front-end calls at boot (for every known
/// (account, workspace) pair) and on WorkspaceManager.add() to register the
/// `(bearer -> AuthOwner)` mapping. Replaces any existing bearer pointing at
/// the same `(account_id, workspace_id)` pair so we don't accumulate stale
/// tokens if the bearer rotates. After updating the map, the per-workspace
/// config file is (re)written so external CLIs see the new bearer.
#[tauri::command]
pub async fn mcp_register_bearer(
    args: RegisterBearerArgs,
    app: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    {
        let mut s = state.write().await;
        // Drop any prior bearer mapped to the same (account, workspace) pair.
        s.token_to_owner.retain(|_, owner| {
            !(owner.account_id == args.account_id && owner.workspace_id == args.workspace_id)
        });
        s.token_to_owner.insert(
            args.bearer_token,
            AuthOwner {
                account_id: args.account_id.clone(),
                workspace_id: args.workspace_id.clone(),
            },
        );
    }
    // Drop the write lock above before calling write_per_workspace_configs —
    // it takes a read lock internally and tokio's RwLock is not reentrant.
    let _ = crate::mcp::server::write_per_workspace_configs(&app, state.inner()).await;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeBearerArgs {
    pub bearer_token: String,
}

/// Tauri command — drop a single bearer from the in-memory map.
/// Called by WorkspaceManager.remove() so a deleted workspace's CLI
/// immediately 401s without waiting for an app restart.
#[tauri::command]
pub async fn mcp_revoke_bearer(
    args: RevokeBearerArgs,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.token_to_owner.remove(&args.bearer_token);
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

    let owner = match lookup_owner_for_token(&state, token).await {
        Some(o) => o,
        None => return unauthorized_response("unknown token"),
    };

    req.extensions_mut().insert(AuthContext {
        account_id: owner.account_id,
        workspace_id: owner.workspace_id,
    });
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
            token_to_owner: HashMap::new(),
            access_tokens: HashMap::new(),
            url: None,
            nonce: "test-nonce".to_string(),
            supabase_url: String::new(),
            supabase_anon_key: String::new(),
        }))
    }

    #[tokio::test]
    async fn lookup_owner_for_token_returns_full_owner() {
        let state = make_state();
        {
            let mut s = state.write().await;
            s.token_to_owner.insert(
                "tok-a".into(),
                AuthOwner {
                    account_id: "acc-1".into(),
                    workspace_id: "ws-1".into(),
                },
            );
        }
        let owner = lookup_owner_for_token(&state, "tok-a").await;
        assert_eq!(
            owner,
            Some(AuthOwner {
                account_id: "acc-1".into(),
                workspace_id: "ws-1".into(),
            })
        );
    }

    #[tokio::test]
    async fn lookup_owner_for_token_misses_unknown_bearer() {
        let state = make_state();
        assert_eq!(lookup_owner_for_token(&state, "nope").await, None);
    }

    #[tokio::test]
    async fn remove_account_drops_every_workspace_bearer() {
        let state = make_state();
        {
            let mut s = state.write().await;
            s.access_tokens
                .insert("acc-1".into(), ("at".into(), i64::MAX));
            s.token_to_owner.insert(
                "tok-a".into(),
                AuthOwner {
                    account_id: "acc-1".into(),
                    workspace_id: "ws-1".into(),
                },
            );
            s.token_to_owner.insert(
                "tok-b".into(),
                AuthOwner {
                    account_id: "acc-1".into(),
                    workspace_id: "ws-2".into(),
                },
            );
            s.token_to_owner.insert(
                "tok-c".into(),
                AuthOwner {
                    account_id: "acc-2".into(),
                    workspace_id: "ws-3".into(),
                },
            );
        }
        // Simulate mcp_remove_account_token by exercising the same retain.
        {
            let mut s = state.write().await;
            s.access_tokens.remove("acc-1");
            s.token_to_owner
                .retain(|_, owner| owner.account_id != "acc-1");
        }
        let s = state.read().await;
        assert!(s.access_tokens.get("acc-1").is_none());
        assert_eq!(s.token_to_owner.len(), 1);
        assert!(s.token_to_owner.contains_key("tok-c"));
    }

    #[tokio::test]
    async fn auth_context_carries_workspace_id() {
        // The middleware constructs AuthContext from AuthOwner; this asserts
        // the shape is stable so handlers can read both fields.
        let ctx = AuthContext {
            account_id: "acc-1".into(),
            workspace_id: "ws-1".into(),
        };
        assert_eq!(ctx.account_id, "acc-1");
        assert_eq!(ctx.workspace_id, "ws-1");
    }
}
