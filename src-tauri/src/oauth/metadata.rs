// src-tauri/src/oauth/metadata.rs
use axum::{extract::State, Json};
use serde_json::{json, Value};

use super::OAuthState;

pub async fn well_known(State(state): State<OAuthState>) -> Json<Value> {
    let issuer = state.read().await.issuer.clone();
    Json(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": format!("{issuer}/token"),
        "registration_endpoint": format!("{issuer}/register"),
        "revocation_endpoint": format!("{issuer}/revoke"),
        "scopes_supported": ["notter:full"],
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["client_secret_post"],
    }))
}
