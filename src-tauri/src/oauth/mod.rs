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

pub use jwt::{Claims, JwtKey};
pub use clients::{ClientRegistry, RegisteredClient};
pub use grants::GrantStore;

#[derive(Clone)]
pub struct OAuthStateInner {
    pub jwt_key: JwtKey,
    pub clients: ClientRegistry,
    pub grants: GrantStore,
    pub issuer: String, // "http://127.0.0.1:<port>" — set when the listener binds
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
    })))
}

pub fn routes(state: OAuthState) -> axum::Router {
    use axum::{routing::{get, post}, Router};
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(metadata::well_known))
        .route("/register", post(register::register))
        // /authorize, /token, /revoke wired in M2.6–M2.8
        .with_state(state)
}

#[cfg(test)]
pub mod tests;
