// src-tauri/src/oauth/jwt.rs
use std::path::{Path, PathBuf};

use jsonwebtoken::{
    decode, encode, errors::Error as JwtError, Algorithm, DecodingKey, EncodingKey, Header,
    Validation,
};
use rand::RngCore;

const SECRET_FILENAME: &str = "jwt-secret.bin";
const SECRET_LEN: usize = 32;

#[derive(Clone)]
pub struct JwtKey {
    secret: Vec<u8>,
}

impl JwtKey {
    pub async fn load_or_create(dir: &Path) -> Result<Self, String> {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("create_dir_all: {e}"))?;
        let path = Self::path(dir);
        match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() == SECRET_LEN => Ok(Self { secret: bytes }),
            Ok(bytes) => Err(format!(
                "jwt-secret.bin has unexpected length {} (expected {SECRET_LEN})",
                bytes.len()
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut buf = vec![0u8; SECRET_LEN];
                rand::rng().fill_bytes(&mut buf);
                tokio::fs::write(&path, &buf)
                    .await
                    .map_err(|e| format!("write jwt-secret.bin: {e}"))?;
                Ok(Self { secret: buf })
            }
            Err(e) => Err(format!("read jwt-secret.bin: {e}")),
        }
    }

    fn path(dir: &Path) -> PathBuf { dir.join(SECRET_FILENAME) }

    pub fn secret_len(&self) -> usize { self.secret.len() }
    pub fn secret_bytes(&self) -> &[u8] { &self.secret }

    pub fn sign(&self, claims: &Claims) -> Result<String, JwtError> {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(&self.secret),
        )
    }

    pub fn verify(&self, token: &str) -> Result<Claims, JwtError> {
        let mut validation = Validation::new(Algorithm::HS256);
        // We validate exp ourselves but jsonwebtoken does it too — leave on.
        validation.leeway = 0;
        // Don't require any specific issuer; tools accept whatever was signed.
        validation.validate_aud = false;
        let data = decode::<Claims>(token, &DecodingKey::from_secret(&self.secret), &validation)?;
        Ok(data.claims)
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Claims {
    pub iss: String,
    pub sub: String, // account_id
    pub client_id: String,
    pub scope: String,
    pub iat: i64,
    pub exp: i64,
    pub token_type: String, // "access" | "refresh"
    pub jti: String,
}
