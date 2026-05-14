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

    /// PATCH /auth/v1/user — used to update auth.users.raw_user_meta_data.
    /// This is the Supabase Auth API, NOT PostgREST. The same access_token
    /// the MCP server already holds for the account authorizes this call.
    pub async fn auth_patch_user(
        &self,
        body: &Value,
        access_token: &str,
    ) -> Result<Value, McpError> {
        let url = format!("{}/auth/v1/user", self.base_url);
        let res = self
            .http
            .patch(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| McpError::SupabaseError(format!("auth_patch_user: {e}")))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "auth_patch_user: HTTP {} body={body}",
                status.as_u16()
            )));
        }
        Ok(body)
    }

    /// POST /rest/v1/rpc/<name> — calls a Postgres function with JSON args.
    pub async fn rpc(
        &self,
        name: &str,
        args: &Value,
        access_token: &str,
    ) -> Result<Value, McpError> {
        let url = format!("{}/rest/v1/rpc/{}", self.base_url, name);
        let res = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Prefer", "return=representation")
            .json(args)
            .send()
            .await
            .map_err(|e| McpError::SupabaseError(format!("rpc {name}: {e}")))?;
        let status = res.status();
        let body: Value = if status == reqwest::StatusCode::NO_CONTENT {
            Value::Null
        } else {
            res.json().await.unwrap_or(Value::Null)
        };
        if !status.is_success() {
            return Err(McpError::SupabaseError(format!(
                "rpc {name}: HTTP {} body={body}",
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

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::{Method, MockServer};

    #[tokio::test]
    async fn auth_patch_user_hits_auth_v1_user() {
        let server = MockServer::start_async().await;
        let m = server.mock_async(|when, then| {
            when.method(Method::PATCH)
                .path("/auth/v1/user")
                .header("authorization", "Bearer access-tok")
                .header("apikey", "anon");
            then.status(200).json_body(serde_json::json!({
                "id": "user-1",
                "user_metadata": { "notter": { "theme": "dark" } }
            }));
        }).await;

        let sb = SupabaseClient::new(server.base_url(), "anon".into());
        let body = serde_json::json!({ "data": { "notter": { "theme": "dark" } } });
        let res = sb.auth_patch_user(&body, "access-tok").await.unwrap();

        m.assert_async().await;
        assert_eq!(res["user_metadata"]["notter"]["theme"], "dark");
    }

    #[tokio::test]
    async fn rpc_posts_to_rest_v1_rpc_name() {
        let server = MockServer::start_async().await;
        let m = server.mock_async(|when, then| {
            when.method(Method::POST)
                .path("/rest/v1/rpc/rename_project_cascade")
                .header("authorization", "Bearer access-tok")
                .header("apikey", "anon")
                .header("prefer", "return=representation")
                .json_body(serde_json::json!({
                    "old_name": "Old", "new_name": "New",
                    "workspace_uuid": "00000000-0000-0000-0000-000000000001"
                }));
            then.status(200).json_body(serde_json::json!(null));
        }).await;

        let sb = SupabaseClient::new(server.base_url(), "anon".into());
        let body = serde_json::json!({
            "old_name": "Old", "new_name": "New",
            "workspace_uuid": "00000000-0000-0000-0000-000000000001"
        });
        let res = sb.rpc("rename_project_cascade", &body, "access-tok").await.unwrap();
        assert_eq!(res, serde_json::Value::Null);
        m.assert_async().await;
    }
}
