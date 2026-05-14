// src-tauri/src/oauth/mod.rs
//
// OAuth 2.1 stack per the MCP authorization spec (2026-05-14 expansion).
// Mounts on the same axum Router used by the MCP server in src/mcp/server.rs.

pub mod authorize;
pub mod clients;
pub mod consent_html;
pub mod grants;
pub mod jwt;
pub mod metadata;
pub mod register;
pub mod revoke;
pub mod token;

use std::sync::Arc;
use tokio::sync::RwLock;

// Public API surface. Re-exports are consumed by `mcp::auth` bearer middleware
// (M2D) and any external crate code paths added in later milestones.
#[allow(unused_imports)]
pub use jwt::{Claims, JwtKey};
#[allow(unused_imports)]
pub use clients::{ClientRegistry, RegisteredClient};
#[allow(unused_imports)]
pub use grants::GrantStore;

#[derive(Clone)]
pub struct OAuthStateInner {
    pub jwt_key: JwtKey,
    pub clients: ClientRegistry,
    pub grants: GrantStore,
    pub issuer: String, // "http://127.0.0.1:<port>" — set when the listener binds
    /// Snapshot of registered accounts pushed from the front-end at boot and on
    /// every AccountManager mutation. Used by the OAuth consent screen.
    pub account_summaries: Vec<AccountSummary>,
}

pub type OAuthState = Arc<RwLock<OAuthStateInner>>;

/// Build the OAuthState at app boot. The signing key is read from
/// `<data_dir>/jwt-secret.bin`; created on first run. Clients & grants
/// are loaded from `<data_dir>/clients.json` if it exists.
pub async fn bootstrap_oauth(data_dir: &std::path::Path) -> Result<OAuthState, String> {
    let jwt_key = jwt::JwtKey::load_or_create(data_dir).await?;
    let clients = clients::ClientRegistry::load(data_dir).await?;
    let grants = grants::GrantStore::new();
    Ok(Arc::new(RwLock::new(OAuthStateInner {
        jwt_key,
        clients,
        grants,
        issuer: String::new(),
        account_summaries: vec![],
    })))
}

/// Snapshot of accounts the consent screen can offer. Pushed in from the
/// front-end at boot and refreshed on AccountManager mutations.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AccountSummary {
    pub account_id: String,
    pub display_name: String,
    pub email: String,
}

pub fn routes(state: OAuthState) -> axum::Router {
    use axum::{routing::{get, post}, Router};
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(metadata::well_known))
        .route("/register", post(register::register))
        .route("/authorize",
            get(authorize::authorize_get).post(authorize::authorize_post))
        .route("/token", post(token::token))
        .route("/revoke", post(revoke::revoke))
        .with_state(state)
}

#[cfg(test)]
pub mod tests;
