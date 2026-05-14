// src-tauri/src/oauth/token.rs
use axum::{extract::State, http::StatusCode, response::IntoResponse, Form, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{jwt::Claims, OAuthState};

#[derive(Deserialize)]
pub struct TokenForm {
    pub grant_type: String,
    pub client_id: String,
    pub client_secret: String,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub code_verifier: Option<String>,
    pub refresh_token: Option<String>,
}

const ACCESS_TTL_S: i64 = 3600;               // 1h
const REFRESH_TTL_S: i64 = 60 * 60 * 24 * 30; // 30d

pub async fn token(
    State(state): State<OAuthState>,
    Form(f): Form<TokenForm>,
) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    match f.grant_type.as_str() {
        "authorization_code" => handle_code(state, f, now).await,
        "refresh_token" => handle_refresh(state, f, now).await,
        other => err(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            &format!("grant_type '{other}' not supported"),
        ),
    }
}

async fn handle_code(state: OAuthState, f: TokenForm, now: i64) -> axum::response::Response {
    let Some(code) = f.code else {
        return err(StatusCode::BAD_REQUEST, "invalid_request", "code required");
    };
    let Some(redirect_uri) = f.redirect_uri else {
        return err(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri required");
    };
    let Some(verifier) = f.code_verifier else {
        return err(StatusCode::BAD_REQUEST, "invalid_request", "code_verifier required");
    };

    let s = state.read().await;
    if !verify_client(&s, &f.client_id, &f.client_secret) {
        return err(
            StatusCode::UNAUTHORIZED,
            "invalid_client",
            "client authentication failed",
        );
    }
    let grant = match s.grants.take(&code).await {
        Some(g) => g,
        None => {
            return err(
                StatusCode::BAD_REQUEST,
                "invalid_grant",
                "code unknown, used, or expired",
            )
        }
    };
    drop(s);

    if grant.client_id != f.client_id {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "client_id mismatch");
    }
    if grant.redirect_uri != redirect_uri {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "redirect_uri mismatch");
    }
    // PKCE: base64url-no-pad(sha256(verifier)) == code_challenge
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let computed = URL_SAFE_NO_PAD.encode(hasher.finalize());
    if computed != grant.code_challenge {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "code_verifier does not match challenge",
        );
    }

    issue_pair(state, &grant.client_id, &grant.account_id, &grant.scope, now).await
}

async fn handle_refresh(state: OAuthState, f: TokenForm, now: i64) -> axum::response::Response {
    let Some(refresh) = f.refresh_token else {
        return err(StatusCode::BAD_REQUEST, "invalid_request", "refresh_token required");
    };

    let s = state.read().await;
    if !verify_client(&s, &f.client_id, &f.client_secret) {
        return err(
            StatusCode::UNAUTHORIZED,
            "invalid_client",
            "client authentication failed",
        );
    }
    let claims = match s.jwt_key.verify(&refresh) {
        Ok(c) => c,
        Err(_) => return err(StatusCode::BAD_REQUEST, "invalid_grant", "refresh token invalid"),
    };
    if claims.token_type != "refresh" {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "not a refresh token");
    }
    if claims.client_id != f.client_id {
        return err(StatusCode::BAD_REQUEST, "invalid_grant", "client_id mismatch");
    }
    if s.clients.is_jti_revoked(&claims.jti) {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "refresh token already used or revoked",
        );
    }
    drop(s);

    // Rotate: revoke old JTI, then issue new pair.
    {
        let mut s = state.write().await;
        let _ = s.clients.revoke_jti(&claims.jti).await;
    }
    issue_pair(state, &claims.client_id, &claims.sub, &claims.scope, now).await
}

async fn issue_pair(
    state: OAuthState,
    client_id: &str,
    account_id: &str,
    scope: &str,
    now: i64,
) -> axum::response::Response {
    let s = state.read().await;
    let issuer = s.issuer.clone();
    let access_claims = Claims {
        iss: issuer.clone(),
        sub: account_id.into(),
        client_id: client_id.into(),
        scope: scope.into(),
        iat: now,
        exp: now + ACCESS_TTL_S,
        token_type: "access".into(),
        jti: rand_jti(),
    };
    let refresh_claims = Claims {
        iss: issuer,
        sub: account_id.into(),
        client_id: client_id.into(),
        scope: scope.into(),
        iat: now,
        exp: now + REFRESH_TTL_S,
        token_type: "refresh".into(),
        jti: rand_jti(),
    };
    let access = s.jwt_key.sign(&access_claims).unwrap();
    let refresh = s.jwt_key.sign(&refresh_claims).unwrap();
    drop(s);

    (
        StatusCode::OK,
        Json(json!({
            "token_type": "Bearer",
            "access_token": access,
            "refresh_token": refresh,
            "expires_in": ACCESS_TTL_S,
            "scope": scope,
        })),
    )
        .into_response()
}

fn verify_client(s: &super::OAuthStateInner, client_id: &str, secret: &str) -> bool {
    s.clients.find_by_id(client_id).is_some()
        && s.clients.verify_secret(client_id, secret).unwrap_or(false)
}

fn rand_jti() -> String {
    let mut b = [0u8; 16];
    rand::rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

fn err(status: StatusCode, code: &str, desc: &str) -> axum::response::Response {
    (status, Json(json!({"error": code, "error_description": desc}))).into_response()
}
