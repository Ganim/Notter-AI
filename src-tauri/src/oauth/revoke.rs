// src-tauri/src/oauth/revoke.rs
use axum::{extract::State, http::StatusCode, response::IntoResponse, Form};
use serde::Deserialize;

use super::OAuthState;

#[derive(Deserialize)]
pub struct RevokeForm {
    pub token: String,
    #[serde(default)]
    pub token_type_hint: Option<String>,
    pub client_id: String,
    pub client_secret: String,
}

pub async fn revoke(
    State(state): State<OAuthState>,
    Form(f): Form<RevokeForm>,
) -> impl IntoResponse {
    // RFC 7009: revocation endpoint always returns 200 except for client auth
    // failures, even if the token is unknown/already revoked.
    let s = state.read().await;
    let ok_client = s.clients.find_by_id(&f.client_id).is_some()
        && s.clients
            .verify_secret(&f.client_id, &f.client_secret)
            .unwrap_or(false);
    if !ok_client {
        return (StatusCode::UNAUTHORIZED, "").into_response();
    }
    if let Ok(claims) = s.jwt_key.verify(&f.token) {
        drop(s);
        let mut s = state.write().await;
        let _ = s.clients.revoke_jti(&claims.jti).await;
    }
    (StatusCode::OK, "").into_response()
}
