// src-tauri/src/oauth/revoke.rs
use axum::{extract::State, http::StatusCode, response::IntoResponse, Form};
use serde::Deserialize;

use super::OAuthState;

#[derive(Deserialize)]
pub struct RevokeForm {
    pub token: String,
    /// Per RFC 7009 §2.1 this is an optional optimization hint; we accept
    /// any value and use the JWT's own claims to identify the token type.
    #[serde(default)]
    #[allow(dead_code)]
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
    let parsed_jti = {
        let s = state.read().await;
        let ok_client = s.clients.find_by_id(&f.client_id).is_some()
            && s.clients
                .verify_secret(&f.client_id, &f.client_secret)
                .unwrap_or(false);
        if !ok_client {
            return (StatusCode::UNAUTHORIZED, "").into_response();
        }
        // Try to parse the JWT under the read lock; collect the JTI if it parses.
        s.jwt_key.verify(&f.token).ok().map(|c| c.jti)
    };

    if let Some(jti) = parsed_jti {
        let mut s = state.write().await;
        let _ = s.clients.revoke_jti(&jti).await;
    }
    (StatusCode::OK, "").into_response()
}
