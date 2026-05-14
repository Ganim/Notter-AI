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
