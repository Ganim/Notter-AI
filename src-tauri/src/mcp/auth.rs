// src-tauri/src/mcp/auth.rs
//
// In-memory token maps + the Tauri commands that the front-end calls on every
// auth-state change to keep the access-token slice fresh.

use crate::mcp::server::{McpState, McpStateInner};
use serde::{Deserialize, Serialize};

/// Per-request authentication context inserted into axum's request extensions
/// by the Bearer-auth middleware.
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub account_id: String,
}

#[derive(Serialize, Deserialize)]
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
/// AccountManager. Drops both the bearer-token entry and the access-token
/// slice. The bearer-token entry is rebuilt at next boot from the secure
/// store, so this is mostly defensive (it prevents the removed account
/// from being usable until restart, which would otherwise be a security
/// hole if the secure store delete itself raced with this command).
#[tauri::command]
pub async fn mcp_remove_account_token(
    account_id: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.access_tokens.remove(&account_id);
    // Drop any bearer token that maps to this account.
    s.token_to_account
        .retain(|_, owner| owner != &account_id);
    Ok(())
}

/// Resolve a Bearer token to an account id by reading the in-memory map.
/// Returns None on miss (the middleware turns that into 401).
#[allow(dead_code)] // Consumed in Phase E (Bearer-auth middleware).
pub async fn lookup_account_for_token(
    state: &McpState,
    bearer: &str,
) -> Option<String> {
    let s = state.read().await;
    s.token_to_account.get(bearer).cloned()
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
