use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::sleep;

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

const OLLAMA_TAGS_URL: &str = "http://localhost:11434/api/tags";

#[tauri::command]
pub async fn ollama_check_running() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    match client.get(OLLAMA_TAGS_URL).send().await {
        Ok(res) => Ok(res.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn ollama_check_installed() -> Result<bool, String> {
    // Look for the `ollama` binary in PATH using `where` (Windows) or `which` (unix)
    #[cfg(target_os = "windows")]
    let cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let cmd = "which";

    let output = Command::new(cmd)
        .arg("ollama")
        .output()
        .await
        .map_err(|e| format!("{cmd} spawn failed: {e}"))?;

    Ok(output.status.success())
}

#[tauri::command]
pub async fn ollama_download_installer(
    url: String,
    dest_path: String,
    app: AppHandle,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {} from {}", res.status(), url));
    }

    let total = res.content_length().unwrap_or(0);
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir failed: {e}"))?;
    }

    let mut file = File::create(&dest)
        .await
        .map_err(|e| format!("create file failed: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "ollama-download-progress",
            DownloadProgress { downloaded, total },
        );
    }

    file.flush().await.ok();
    Ok(dest_path)
}

#[tauri::command]
pub async fn ollama_run_installer(path: String) -> Result<i32, String> {
    // Try silent flags in order of preference. Inno Setup uses /SILENT,
    // NSIS uses /S. Exit code 0 means success; 3010 means
    // "success, reboot required" (also acceptable).
    fn is_acceptable(code: Option<i32>) -> bool {
        matches!(code, Some(0) | Some(3010))
    }

    let mut last_err = String::new();
    for flag in &["/SILENT", "/S"] {
        let result = Command::new(&path).arg(flag).spawn();
        match result {
            Ok(mut child) => match child.wait().await {
                Ok(status) => {
                    let code = status.code();
                    if is_acceptable(code) {
                        return Ok(code.unwrap_or(0));
                    }
                    last_err = format!("flag {flag} exited with code {:?}", code);
                    // If the installer ran but chose to fail (non-acceptable
                    // non-zero), don't try the other flag — it would re-run
                    // and potentially install again.
                    break;
                }
                Err(e) => {
                    last_err = format!("wait failed for {flag}: {e}");
                }
            },
            Err(e) => {
                last_err = format!("spawn failed for {flag}: {e}");
            }
        }
    }
    Err(format!("installer failed: {last_err}"))
}

#[tauri::command]
pub async fn ollama_start_service() -> Result<(), String> {
    // Spawn `ollama serve` detached so it survives the app exit.
    Command::new("ollama")
        .arg("serve")
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    sleep(Duration::from_millis(500)).await;
    Ok(())
}
