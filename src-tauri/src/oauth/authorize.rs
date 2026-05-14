// src-tauri/src/oauth/authorize.rs
use axum::{
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Redirect},
    Form,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use std::sync::Arc;

use super::{consent_html, grants::AuthCode, AccountSummary, OAuthState};

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    pub response_type: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    #[serde(default)]
    pub state: String,
    #[serde(default = "default_scope")]
    pub scope: String,
}

fn default_scope() -> String { "notter:full".into() }

pub async fn authorize_get(
    State(state): State<OAuthState>,
    Extension(accounts): Extension<Arc<Vec<AccountSummary>>>,
    Query(q): Query<AuthorizeQuery>,
) -> impl IntoResponse {
    if q.response_type != "code" {
        return (StatusCode::BAD_REQUEST, "unsupported response_type").into_response();
    }
    if q.code_challenge_method != "S256" {
        return (StatusCode::BAD_REQUEST, "code_challenge_method must be S256").into_response();
    }

    let s = state.read().await;
    let client = match s.clients.find_by_id(&q.client_id) {
        Some(c) => c.clone(),
        None => return (StatusCode::BAD_REQUEST, "unknown client_id").into_response(),
    };
    if !client.redirect_uris.contains(&q.redirect_uri) {
        return (StatusCode::BAD_REQUEST, "redirect_uri not registered").into_response();
    }
    drop(s);

    let html = consent_html::render(
        &client.client_name,
        accounts.as_ref(),
        &q.client_id,
        &q.redirect_uri,
        &q.code_challenge,
        &q.state,
        &q.scope,
    );
    Html(html).into_response()
}

#[derive(Deserialize)]
pub struct AuthorizeForm {
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    #[serde(default)]
    pub state: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    pub account_id: Option<String>,
    pub deny: Option<String>,
}

pub async fn authorize_post(
    State(state): State<OAuthState>,
    Form(f): Form<AuthorizeForm>,
) -> impl IntoResponse {
    // Validate client + redirect_uri up front. RFC 6749 §4.1.2.1: any redirect
    // back to the client must use a redirect_uri the AS has previously
    // validated against the client's registered list. This guards the deny
    // branch from being weaponized as an open redirect.
    let s = state.read().await;
    let client = match s.clients.find_by_id(&f.client_id) {
        Some(c) => c.clone(),
        None => return (StatusCode::BAD_REQUEST, "unknown client_id").into_response(),
    };
    if !client.redirect_uris.contains(&f.redirect_uri) {
        return (StatusCode::BAD_REQUEST, "redirect_uri not registered").into_response();
    }
    drop(s);

    if f.deny.is_some() {
        let url = format!("{}?error=access_denied&state={}", f.redirect_uri, urlencoding::encode(&f.state));
        return Redirect::to(&url).into_response();
    }
    let Some(account_id) = f.account_id else {
        return (StatusCode::BAD_REQUEST, "account_id required").into_response();
    };
    if f.code_challenge_method != "S256" {
        return (StatusCode::BAD_REQUEST, "code_challenge_method must be S256").into_response();
    }

    let s = state.read().await;
    let mut code_bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut code_bytes);
    let code = URL_SAFE_NO_PAD.encode(code_bytes);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);

    let auth_code = AuthCode {
        client_id: f.client_id.clone(),
        account_id,
        code_challenge: f.code_challenge.clone(),
        redirect_uri: f.redirect_uri.clone(),
        scope: f.scope.clone(),
        expires_at: now + 600,
    };
    s.grants.insert(code.clone(), auth_code).await;
    drop(s);

    let url = format!(
        "{}?code={}&state={}",
        f.redirect_uri,
        urlencoding::encode(&code),
        urlencoding::encode(&f.state),
    );
    Redirect::to(&url).into_response()
}
