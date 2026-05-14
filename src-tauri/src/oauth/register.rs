// src-tauri/src/oauth/register.rs
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;

use super::OAuthState;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub client_name: String,
    pub redirect_uris: Vec<String>,
}

pub async fn register(
    State(state): State<OAuthState>,
    Json(body): Json<RegisterRequest>,
) -> impl IntoResponse {
    if body.client_name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_client_metadata","error_description":"client_name required"}))).into_response();
    }
    if body.redirect_uris.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_redirect_uri","error_description":"at least one redirect_uri required"}))).into_response();
    }

    let (client_id, secret) = {
        let mut s = state.write().await;
        match s.clients.register(body.client_name.clone(), body.redirect_uris.clone()).await {
            Ok(v) => v,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"server_error","error_description":e}))).into_response(),
        }
    };

    (StatusCode::CREATED, Json(json!({
        "client_id": client_id,
        "client_secret": secret,
        "client_name": body.client_name,
        "redirect_uris": body.redirect_uris,
        "token_endpoint_auth_method": "client_secret_post"
    }))).into_response()
}
