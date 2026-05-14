// src-tauri/src/oauth/clients.rs
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use argon2::{
    password_hash::{PasswordHasher, PasswordVerifier, SaltString},
    Argon2, PasswordHash,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const FILENAME: &str = "clients.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret_hash: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub registered_at: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClientRegistryFile {
    pub clients: Vec<RegisteredClient>,
    pub revoked_jti: Vec<String>,
}

#[derive(Clone)]
pub struct ClientRegistry {
    by_id: HashMap<String, RegisteredClient>,
    revoked_jti: HashMap<String, ()>,
    dir: PathBuf,
}

impl ClientRegistry {
    pub async fn load(dir: &Path) -> Result<Self, String> {
        tokio::fs::create_dir_all(dir).await
            .map_err(|e| format!("create_dir_all: {e}"))?;
        let path = dir.join(FILENAME);
        let file: ClientRegistryFile = match tokio::fs::read_to_string(&path).await {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ClientRegistryFile::default(),
            Err(e) => return Err(format!("read clients.json: {e}")),
        };
        let mut by_id = HashMap::new();
        for c in file.clients { by_id.insert(c.client_id.clone(), c); }
        let mut revoked_jti = HashMap::new();
        for j in file.revoked_jti { revoked_jti.insert(j, ()); }
        Ok(Self { by_id, revoked_jti, dir: dir.to_path_buf() })
    }

    async fn persist(&self) -> Result<(), String> {
        let file = ClientRegistryFile {
            clients: self.by_id.values().cloned().collect(),
            revoked_jti: self.revoked_jti.keys().cloned().collect(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("serialize clients.json: {e}"))?;
        let path = self.dir.join(FILENAME);
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, json).await
            .map_err(|e| format!("write tmp: {e}"))?;
        tokio::fs::rename(&tmp, &path).await
            .map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    /// Register a new client. Returns `(client_id, plaintext_secret)`. The
    /// plaintext secret is shown ONCE — only its Argon2id hash is stored.
    pub async fn register(
        &mut self,
        client_name: String,
        redirect_uris: Vec<String>,
        _dir: &Path,
    ) -> Result<(String, String), String> {
        let mut id_bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut id_bytes);
        let client_id = format!("notter_client_{}",
            URL_SAFE_NO_PAD.encode(id_bytes));

        let mut sec_bytes = [0u8; 24];
        rand::rng().fill_bytes(&mut sec_bytes);
        let plaintext_secret = URL_SAFE_NO_PAD.encode(sec_bytes);

        // Generate salt using rand 0.9 (avoids rand_core version mismatch with password-hash 0.5).
        let mut salt_bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut salt_bytes);
        let salt = SaltString::encode_b64(&salt_bytes)
            .map_err(|e| format!("salt: {e}"))?;
        let hash = Argon2::default()
            .hash_password(plaintext_secret.as_bytes(), &salt)
            .map_err(|e| format!("hash: {e}"))?
            .to_string();

        let now = crate::mcp::endpoint::now_rfc3339();
        let client = RegisteredClient {
            client_id: client_id.clone(),
            client_secret_hash: hash,
            client_name,
            redirect_uris,
            registered_at: now,
        };
        self.by_id.insert(client_id.clone(), client);
        self.persist().await?;
        Ok((client_id, plaintext_secret))
    }

    pub fn find_by_id(&self, client_id: &str) -> Option<&RegisteredClient> {
        self.by_id.get(client_id)
    }

    pub fn verify_secret(&self, client_id: &str, plaintext: &str) -> Result<bool, String> {
        let client = self.by_id.get(client_id)
            .ok_or_else(|| format!("unknown client_id: {client_id}"))?;
        let parsed = PasswordHash::new(&client.client_secret_hash)
            .map_err(|e| format!("parse hash: {e}"))?;
        Ok(Argon2::default().verify_password(plaintext.as_bytes(), &parsed).is_ok())
    }

    pub async fn revoke_jti(&mut self, jti: &str) -> Result<(), String> {
        self.revoked_jti.insert(jti.into(), ());
        self.persist().await
    }

    pub fn is_jti_revoked(&self, jti: &str) -> bool {
        self.revoked_jti.contains_key(jti)
    }
}
