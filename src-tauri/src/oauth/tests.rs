// src-tauri/src/oauth/tests.rs
use super::jwt::{Claims, JwtKey};
use super::clients::ClientRegistry;

fn tmp() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "notter-oauth-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[tokio::test]
async fn jwt_key_load_creates_secret_on_first_run() {
    let dir = tmp();
    let key = JwtKey::load_or_create(&dir).await.unwrap();
    assert_eq!(key.secret_len(), 32);
    // Second load returns same bytes.
    let key2 = JwtKey::load_or_create(&dir).await.unwrap();
    assert_eq!(key.secret_bytes(), key2.secret_bytes());
}

#[tokio::test]
async fn jwt_round_trip() {
    let dir = tmp();
    let key = JwtKey::load_or_create(&dir).await.unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let claims = Claims {
        iss: "http://localhost:1/mcp".into(),
        sub: "acc-1".into(),
        client_id: "client-1".into(),
        scope: "notter:full".into(),
        iat: now,
        exp: now + 3600,
        token_type: "access".into(),
        jti: "jti-1".into(),
    };
    let tok = key.sign(&claims).unwrap();
    let parsed = key.verify(&tok).unwrap();
    assert_eq!(parsed.sub, "acc-1");
    assert_eq!(parsed.token_type, "access");
}

#[tokio::test]
async fn jwt_verify_rejects_bad_signature() {
    let dir1 = tmp();
    let dir2 = tmp();
    let k1 = JwtKey::load_or_create(&dir1).await.unwrap();
    let k2 = JwtKey::load_or_create(&dir2).await.unwrap();
    let claims = Claims {
        iss: "x".into(), sub: "x".into(), client_id: "x".into(),
        scope: "notter:full".into(), iat: 0, exp: i64::MAX,
        token_type: "access".into(), jti: "x".into(),
    };
    let tok = k1.sign(&claims).unwrap();
    assert!(k2.verify(&tok).is_err());
}

#[tokio::test]
async fn jwt_verify_rejects_expired() {
    let dir = tmp();
    let key = JwtKey::load_or_create(&dir).await.unwrap();
    let claims = Claims {
        iss: "x".into(), sub: "x".into(), client_id: "x".into(),
        scope: "notter:full".into(), iat: 0, exp: 1,
        token_type: "access".into(), jti: "x".into(),
    };
    let tok = key.sign(&claims).unwrap();
    assert!(key.verify(&tok).is_err());
}

#[tokio::test]
async fn client_registry_round_trip() {
    let dir = tmp();
    let mut reg = ClientRegistry::load(&dir).await.unwrap();
    let (client_id, plaintext_secret) = reg.register(
        "Claude Code".into(),
        vec!["http://127.0.0.1:54881/callback".into()],
    ).await.unwrap();

    assert!(client_id.starts_with("notter_client_"));
    assert_eq!(plaintext_secret.len(), 32);
    assert!(reg.find_by_id(&client_id).is_some());

    // Persisted: reload from disk reads the row back.
    let reg2 = ClientRegistry::load(&dir).await.unwrap();
    assert!(reg2.find_by_id(&client_id).is_some());

    // Secret verifies.
    assert!(reg2.verify_secret(&client_id, &plaintext_secret).unwrap());
    assert!(!reg2.verify_secret(&client_id, "wrong-secret").unwrap());
}

use super::grants::{AuthCode, GrantStore};

#[tokio::test]
async fn grants_store_round_trip_and_one_shot() {
    let store = GrantStore::new();
    let code = AuthCode {
        client_id: "c1".into(),
        account_id: "a1".into(),
        code_challenge: "challenge".into(),
        redirect_uri: "http://x/callback".into(),
        scope: "notter:full".into(),
        expires_at: i64::MAX,
    };
    store.insert("code-1".into(), code.clone()).await;
    let taken = store.take("code-1").await.unwrap();
    assert_eq!(taken.account_id, "a1");
    // Re-take is gone.
    assert!(store.take("code-1").await.is_none());
}

#[tokio::test]
async fn grants_store_drops_expired_codes() {
    let store = GrantStore::new();
    let code = AuthCode {
        client_id: "c1".into(),
        account_id: "a1".into(),
        code_challenge: "x".into(),
        redirect_uri: "http://x/callback".into(),
        scope: "notter:full".into(),
        expires_at: 1, // far in the past
    };
    store.insert("expired".into(), code).await;
    assert!(store.take("expired").await.is_none());
}

use axum::{body::to_bytes, body::Body, http::Request};
use tower::ServiceExt;

async fn build_test_router(dir: &std::path::Path) -> axum::Router {
    let state = super::bootstrap_oauth(dir).await.unwrap();
    {
        let mut s = state.write().await;
        s.issuer = "http://127.0.0.1:54781".into();
    }
    super::routes(state)
}

#[tokio::test]
async fn well_known_metadata_returns_expected_shape() {
    let dir = tmp();
    let router = build_test_router(&dir).await;
    let req = Request::builder()
        .uri("/.well-known/oauth-authorization-server")
        .body(Body::empty()).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(j["issuer"], "http://127.0.0.1:54781");
    assert_eq!(j["authorization_endpoint"], "http://127.0.0.1:54781/authorize");
    assert_eq!(j["token_endpoint"], "http://127.0.0.1:54781/token");
    assert_eq!(j["registration_endpoint"], "http://127.0.0.1:54781/register");
    assert_eq!(j["revocation_endpoint"], "http://127.0.0.1:54781/revoke");
    assert_eq!(j["code_challenge_methods_supported"], serde_json::json!(["S256"]));
    assert_eq!(j["grant_types_supported"], serde_json::json!(["authorization_code","refresh_token"]));
    assert_eq!(j["response_types_supported"], serde_json::json!(["code"]));
    assert_eq!(j["token_endpoint_auth_methods_supported"], serde_json::json!(["client_secret_post"]));
}

#[tokio::test]
async fn register_endpoint_returns_client_id_and_secret() {
    let dir = tmp();
    let router = build_test_router(&dir).await;
    let body = serde_json::json!({
        "client_name": "Claude Code",
        "redirect_uris": ["http://127.0.0.1:54881/callback"]
    });
    let req = Request::builder()
        .method("POST")
        .uri("/register")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string())).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 201);
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(j["client_id"].as_str().unwrap().starts_with("notter_client_"));
    assert!(j["client_secret"].as_str().unwrap().len() >= 32);
    assert_eq!(j["client_name"], "Claude Code");
}

use axum::http::HeaderValue;

#[tokio::test]
async fn authorize_get_renders_consent_html_listing_accounts() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }

    let (client_id, _secret) = {
        let mut s = state.write().await;
        s.clients.register("Claude Code".into(), vec!["http://127.0.0.1:54881/cb".into()]).await.unwrap()
    };

    let router = super::routes_with_accounts(state.clone(), vec![
        super::AccountSummary { account_id: "acc-1".into(), display_name: "Guilherme".into(), email: "g@x.com".into() }
    ]);

    let uri = format!(
        "/authorize?response_type=code&client_id={}&redirect_uri=http%3A%2F%2F127.0.0.1%3A54881%2Fcb&code_challenge=challenge&code_challenge_method=S256&state=xyz",
        client_id
    );
    let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let bytes = to_bytes(res.into_body(), 1024*1024).await.unwrap();
    let html = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(html.contains("Claude Code"));
    assert!(html.contains("Guilherme"));
    assert!(html.contains("acc-1"));
}

#[tokio::test]
async fn authorize_post_issues_code_and_redirects() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }
    let (client_id, _secret) = {
        let mut s = state.write().await;
        s.clients.register("Claude Code".into(), vec!["http://127.0.0.1:54881/cb".into()]).await.unwrap()
    };
    let router = super::routes_with_accounts(state.clone(), vec![
        super::AccountSummary { account_id: "acc-1".into(), display_name: "G".into(), email: "g@x.com".into() }
    ]);

    let form = format!(
        "client_id={}&redirect_uri=http%3A%2F%2F127.0.0.1%3A54881%2Fcb&code_challenge=challenge&code_challenge_method=S256&state=xyz&account_id=acc-1&scope=notter%3Afull",
        client_id
    );
    let req = Request::builder()
        .method("POST")
        .uri("/authorize")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(Body::from(form)).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 303);  // Redirect::to in axum uses 303 See Other for POST
    let loc: &HeaderValue = res.headers().get("location").unwrap();
    let loc_str = loc.to_str().unwrap();
    assert!(loc_str.starts_with("http://127.0.0.1:54881/cb?code="));
    assert!(loc_str.contains("&state=xyz"));
}

#[tokio::test]
async fn authorize_post_rejects_unregistered_redirect_uri_even_on_deny() {
    let dir = tmp();
    let state = super::bootstrap_oauth(&dir).await.unwrap();
    { let mut s = state.write().await; s.issuer = "http://127.0.0.1:1".into(); }
    let (client_id, _secret) = {
        let mut s = state.write().await;
        s.clients.register("X".into(), vec!["http://127.0.0.1:54881/cb".into()]).await.unwrap()
    };
    let router = super::routes_with_accounts(state.clone(), vec![
        super::AccountSummary { account_id: "a".into(), display_name: "G".into(), email: "g@x.com".into() }
    ]);

    // Attacker tries deny path with an attacker-controlled redirect_uri.
    let form = format!(
        "client_id={}&redirect_uri=https%3A%2F%2Fevil.example%2Fphish&code_challenge=x&code_challenge_method=S256&state=xyz&deny=1",
        client_id
    );
    let req = Request::builder()
        .method("POST").uri("/authorize")
        .header("content-type","application/x-www-form-urlencoded")
        .body(Body::from(form)).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 400);  // must reject — not redirect
}
