// src-tauri/src/mcp/supabase.rs
//
// Thin reqwest-based wrapper over Supabase REST. Every call carries:
//  - Authorization: Bearer <user's rotating access_token>
//  - apikey:        <project publishable anon key>
//  - Content-Type:  application/json
//
// We do NOT use service_role here — RLS handles isolation. The user's
// access_token IS the auth.uid() for RLS purposes.

use reqwest::Client;
use serde_json::Value;

use crate::mcp::error::McpError;

#[derive(Clone)]
pub struct SupabaseClient {
    pub base_url: String, // e.g. "https://abc.supabase.co"
    pub anon_key: String,
    http: Client,
}

impl SupabaseClient {
    pub fn new(base_url: String, anon_key: String) -> Self {
        Self {
            base_url,
            anon_key,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client build"),
        }
    }

    /// REST path is appended to `<base_url>/rest/v1/`.
    /// `query` is the unencoded querystring (e.g. "select=*&order=updated_at.desc").
    pub async fn get(
        &self,
        path: &str,
        query: &str,
        access_token: &str,
    ) -> Result<Value, McpError> {
        let url = format!("{}/rest/v1/{}?{}", self.base_url, path, query);
        let res = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| McpError::SupabaseError(format!("get {path}: {e}")))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| McpError::SupabaseError(format!("get {path} parse: {e}")))?;
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "get {path}: HTTP {} body={body}",
                status.as_u16()
            )));
        }
        Ok(body)
    }

    #[allow(dead_code)] // Consumed in Phase H (post_subject_revision).
    pub async fn post(
        &self,
        path: &str,
        body: &Value,
        access_token: &str,
        return_representation: bool,
    ) -> Result<Value, McpError> {
        let url = format!("{}/rest/v1/{}", self.base_url, path);
        let mut req = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(body);
        if return_representation {
            req = req.header("Prefer", "return=representation");
        }
        let res = req
            .send()
            .await
            .map_err(|e| McpError::SupabaseError(format!("post {path}: {e}")))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "post {path}: HTTP {} body={body}",
                status.as_u16()
            )));
        }
        Ok(body)
    }
}

/// Helper for tools — looks up the access token for the request's account
/// or returns AuthPending so the CLI retries once.
///
/// Lock-ordering note: `current_access_token` takes its own read lock, so we
/// call it BEFORE acquiring our own read lock for url/anon_key. This avoids
/// any reentrant-RwLock concern (tokio's `RwLock` is not reentrant, even
/// though sequential reads here would not actually deadlock).
pub async fn supabase_for(
    state: &crate::mcp::server::McpState,
    account_id: &str,
) -> Result<(SupabaseClient, String), McpError> {
    let token = crate::mcp::auth::current_access_token(state, account_id)
        .await
        .ok_or(McpError::AuthPending)?;
    let (base_url, anon_key) = {
        let s = state.read().await;
        (s.supabase_url.clone(), s.supabase_anon_key.clone())
    };
    Ok((SupabaseClient::new(base_url, anon_key), token))
}
