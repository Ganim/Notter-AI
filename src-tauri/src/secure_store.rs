// src-tauri/src/secure_store.rs
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const SERVICE: &str = "notter-ai";

pub struct SecureStoreState {
    pub known_keys: Mutex<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
pub struct SecureGetResponse {
    pub key: String,
    pub value: Option<String>,
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keyring entry({key}): {e}"))
}

#[tauri::command]
pub fn secure_set(
    key: String,
    value: String,
    state: tauri::State<'_, SecureStoreState>,
) -> Result<(), String> {
    let e = entry(&key)?;
    e.set_password(&value).map_err(|err| format!("keyring set({key}): {err}"))?;
    let mut keys = state.known_keys.lock().map_err(|e| e.to_string())?;
    if !keys.contains(&key) {
        keys.push(key);
    }
    Ok(())
}

#[tauri::command]
pub fn secure_get(key: String) -> Result<SecureGetResponse, String> {
    let e = entry(&key)?;
    match e.get_password() {
        Ok(value) => Ok(SecureGetResponse { key, value: Some(value) }),
        Err(keyring::Error::NoEntry) => Ok(SecureGetResponse { key, value: None }),
        Err(err) => Err(format!("keyring get({key}): {err}")),
    }
}

#[tauri::command]
pub fn secure_delete(
    key: String,
    state: tauri::State<'_, SecureStoreState>,
) -> Result<(), String> {
    let e = entry(&key)?;
    match e.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => {}
        Err(err) => return Err(format!("keyring delete({key}): {err}")),
    }
    let mut keys = state.known_keys.lock().map_err(|e| e.to_string())?;
    keys.retain(|k| k != &key);
    Ok(())
}

#[tauri::command]
pub fn secure_register_known_keys(
    keys: Vec<String>,
    state: tauri::State<'_, SecureStoreState>,
) -> Result<(), String> {
    let mut k = state.known_keys.lock().map_err(|e| e.to_string())?;
    for key in keys {
        if !k.contains(&key) {
            k.push(key);
        }
    }
    Ok(())
}
