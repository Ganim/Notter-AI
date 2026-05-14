// src-tauri/src/oauth/grants.rs
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct AuthCode {
    pub client_id: String,
    pub account_id: String,
    pub code_challenge: String, // PKCE S256, base64url-no-pad
    pub redirect_uri: String,
    pub scope: String,
    pub expires_at: i64, // unix seconds
}

#[derive(Clone, Default)]
pub struct GrantStore {
    inner: Arc<Mutex<HashMap<String, AuthCode>>>,
}

impl GrantStore {
    pub fn new() -> Self { Self::default() }

    pub async fn insert(&self, code: String, ac: AuthCode) {
        self.inner.lock().await.insert(code, ac);
    }

    /// One-shot take. Returns None if the code is unknown OR expired.
    pub async fn take(&self, code: &str) -> Option<AuthCode> {
        let mut m = self.inner.lock().await;
        let entry = m.remove(code)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if entry.expires_at < now { return None; }
        Some(entry)
    }
}
