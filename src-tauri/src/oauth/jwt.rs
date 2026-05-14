// src-tauri/src/oauth/jwt.rs — filled in M2.2.
use std::path::Path;

#[derive(Clone)]
pub struct JwtKey { pub _secret: Vec<u8> }

impl JwtKey {
    pub async fn load_or_create(_dir: &Path) -> Result<Self, String> {
        Ok(Self { _secret: vec![] })
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub client_id: String,
    pub scope: String,
    pub iat: i64,
    pub exp: i64,
    pub token_type: String,
    pub jti: String,
}
