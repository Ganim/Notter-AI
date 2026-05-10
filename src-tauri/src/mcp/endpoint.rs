// src-tauri/src/mcp/endpoint.rs
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// On-disk shape of `<appLocalData>/notter-ai/mcp/endpoint.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EndpointFile {
    pub url: String,        // e.g. "http://127.0.0.1:54781/mcp"
    pub pid: u32,
    pub nonce: String,      // 16 random bytes hex
    pub started_at: String, // RFC 3339 timestamp
}

/// 16 random bytes -> 32-char lowercase hex.
pub fn generate_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Returns the path `<dir>/endpoint.json`. The caller resolves `dir` via
/// Tauri's `app_local_data_dir() + "notter-ai/mcp"`; we keep the function
/// pure for testability.
pub fn endpoint_path(dir: &Path) -> PathBuf {
    dir.join("endpoint.json")
}

pub async fn write_endpoint_file(
    dir: &Path,
    file: &EndpointFile,
) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("create_dir_all: {e}"))?;
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("serde: {e}"))?;
    tokio::fs::write(endpoint_path(dir), json)
        .await
        .map_err(|e| format!("write: {e}"))
}

pub async fn read_endpoint_file(dir: &Path) -> Result<Option<EndpointFile>, String> {
    let path = endpoint_path(dir);
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => match serde_json::from_str::<EndpointFile>(&s) {
            Ok(f) => Ok(Some(f)),
            Err(e) => {
                // Corrupt file — treat as absent. The boot path will overwrite.
                eprintln!("[mcp] endpoint.json malformed: {e}; treating as stale");
                Ok(None)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read: {e}")),
    }
}

pub async fn delete_endpoint_file(dir: &Path) -> Result<(), String> {
    let path = endpoint_path(dir);
    match tokio::fs::remove_file(&path).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove: {e}")),
    }
}

/// Probe an existing `endpoint.json` to decide whether ANOTHER instance
/// of Notter is currently bound on that URL.
///
/// Returns `Ok(true)`  -> ANOTHER instance is alive on that port; we should abort.
/// Returns `Ok(false)` -> file is stale; safe to delete + bind anew.
/// Returns `Err(_)`    -> network/IO error; treat as stale (safer than blocking
///                        a fresh boot; on the fence we bias toward "boot the
///                        app" because port 0 will assign a fresh free port if
///                        the old one is taken).
///
/// The probe path is `GET <url> with the host swapped from "/mcp" -> "/health"`,
/// passing `X-Notter-Nonce: <file's nonce>`. The /health route compares the
/// header against its in-memory nonce and returns 200 only on match.
pub async fn is_existing_endpoint_alive(file: &EndpointFile) -> Result<bool, String> {
    // Derive health URL from file.url. The recorded URL ends in /mcp;
    // we replace that suffix with /health.
    let health_url = if let Some(stripped) = file.url.strip_suffix("/mcp") {
        format!("{stripped}/health")
    } else {
        // Defensive: URL does not match the expected shape; treat as stale.
        return Ok(false);
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    match client
        .get(&health_url)
        .header("X-Notter-Nonce", &file.nonce)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => Ok(true),
        Ok(_) => Ok(false), // 401/403/etc → nonce mismatched → stale
        Err(_) => Ok(false), // connection refused / timeout → stale
    }
}

pub fn now_rfc3339() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // chrono is not a dep — hand-format. The /health route ignores this anyway;
    // it's purely informational.
    format!("{}", iso8601(now.as_secs()))
}

/// Minimal RFC 3339 (UTC, no fractional seconds). Good enough for an
/// informational `started_at`.
fn iso8601(unix_seconds: u64) -> String {
    // Janky but dep-free. If chrono ever lands as a Tauri/Cargo dep,
    // replace with chrono::Utc::now().to_rfc3339().
    let days = unix_seconds / 86400;
    let secs_today = unix_seconds % 86400;
    let h = secs_today / 3600;
    let m = (secs_today % 3600) / 60;
    let s = secs_today % 60;
    let (y, mo, d) = days_to_ymd(days as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
}

fn days_to_ymd(days_since_epoch: i64) -> (i64, u32, u32) {
    // Algorithm from Howard Hinnant's chrono lib (public domain).
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let tmp = tempdir();
        let f = EndpointFile {
            url: "http://127.0.0.1:12345/mcp".into(),
            pid: 4242,
            nonce: "deadbeefcafebabe0011223344556677".into(),
            started_at: "2026-05-10T17:00:00Z".into(),
        };
        write_endpoint_file(&tmp, &f).await.unwrap();
        let read = read_endpoint_file(&tmp).await.unwrap().unwrap();
        assert_eq!(read, f);
    }

    #[tokio::test]
    async fn read_returns_none_when_missing() {
        let tmp = tempdir();
        assert!(read_endpoint_file(&tmp).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let tmp = tempdir();
        delete_endpoint_file(&tmp).await.unwrap(); // no-op when missing
        let f = EndpointFile {
            url: "http://127.0.0.1:1/mcp".into(),
            pid: 1, nonce: "x".into(), started_at: "x".into(),
        };
        write_endpoint_file(&tmp, &f).await.unwrap();
        delete_endpoint_file(&tmp).await.unwrap();
        assert!(read_endpoint_file(&tmp).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn corrupt_endpoint_json_is_treated_as_absent() {
        let tmp = tempdir();
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        tokio::fs::write(endpoint_path(&tmp), b"not json").await.unwrap();
        assert!(read_endpoint_file(&tmp).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn probe_returns_false_when_no_server_listening() {
        let f = EndpointFile {
            url: "http://127.0.0.1:1/mcp".into(), // port 1 → connection refused
            pid: 1, nonce: "x".into(), started_at: "x".into(),
        };
        // Either Ok(false) or some I/O error path that maps to stale.
        let alive = is_existing_endpoint_alive(&f).await.unwrap();
        assert!(!alive);
    }

    #[test]
    fn nonce_is_32_hex_chars() {
        let n = generate_nonce();
        assert_eq!(n.len(), 32);
        assert!(n.chars().all(|c| c.is_ascii_hexdigit()));
    }

    fn tempdir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "notter-mcp-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        p
    }
}
