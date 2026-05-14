// src-tauri/src/oauth/clients.rs — filled in M2.3.
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default)]
pub struct ClientRegistry;

impl ClientRegistry {
    pub async fn load(_dir: &Path) -> Result<Self, String> { Ok(Self) }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret_hash: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub registered_at: String,
}
