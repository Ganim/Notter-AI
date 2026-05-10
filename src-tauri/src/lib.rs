mod ollama_install;
mod secure_store;
mod mcp;   // NEW — M3

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// --- Event payloads ---

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
    code: i32,
}

// --- PTY Session ---

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    cancel: Arc<AtomicBool>,
}

struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

// --- Shell detection ---

fn get_shell(shell_type: &str) -> (String, Vec<String>) {
    match shell_type {
        "bash" => ("wsl".to_string(), vec!["bash".to_string()]),
        "cmd" => ("cmd".to_string(), vec![]),
        _ => ("powershell".to_string(), vec!["-NoLogo".to_string()]),
    }
}

// --- Tauri commands ---

#[tauri::command]
fn create_pty(
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell_type = shell.unwrap_or_else(|| "powershell".to_string());
    let (shell_bin, args) = get_shell(&shell_type);
    let mut cmd = CommandBuilder::new(&shell_bin);
    for arg in &args {
        cmd.arg(arg);
    }
    if let Some(dir) = &cwd {
        cmd.cwd(dir);
    }
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{}': {}", shell_bin, e))?;

    // Drop slave — no longer needed after spawn
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();
    let id_clone = id.clone();

    // Spawn reader thread
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            if cancel_clone.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF
                    let _ = app.emit("pty-exit", PtyExitPayload { id: id_clone.clone(), code: 0 });
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("pty-output", PtyOutputPayload { id: id_clone.clone(), data });
                }
                Err(_) => {
                    let _ = app.emit("pty-exit", PtyExitPayload { id: id_clone.clone(), code: -1 });
                    break;
                }
            }
        }
    });

    let session = PtySession {
        writer,
        master: pair.master,
        child,
        cancel,
    };

    state
        .sessions
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?
        .insert(id, session);

    Ok(())
}

#[tauri::command]
fn write_pty(id: String, data: String, state: tauri::State<'_, PtyManager>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| format!("Lock error: {}", e))?;
    let session = sessions.get_mut(&id).ok_or("Session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}

#[tauri::command]
fn resize_pty(id: String, cols: u16, rows: u16, state: tauri::State<'_, PtyManager>) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| format!("Lock error: {}", e))?;
    let session = sessions.get(&id).ok_or("Session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {}", e))?;
    Ok(())
}

#[tauri::command]
fn close_pty(id: String, state: tauri::State<'_, PtyManager>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(mut session) = sessions.remove(&id) {
        session.cancel.store(true, Ordering::Relaxed);
        let _ = session.child.kill();
    }
    Ok(())
}

// --- LLM proxy (avoids CORS issues from webview) ---

#[derive(serde::Deserialize)]
struct LlmRequestPayload {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
async fn llm_request(payload: LlmRequestPayload) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut req = match payload.method.to_uppercase().as_str() {
        "POST" => client.post(&payload.url),
        "GET" => client.get(&payload.url),
        _ => return Err(format!("Unsupported method: {}", payload.method)),
    };

    for (key, value) in &payload.headers {
        req = req.header(key.as_str(), value.as_str());
    }

    if !payload.body.is_empty() {
        req = req.body(payload.body);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }

    Ok(text)
}

// --- Tauri entry ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Build the MCP server state. Token maps are initially empty; Phase D's
    // boot routine repopulates from the secure store, and the front-end pushes
    // access tokens via mcp_update_account_token. Supabase URL + anon key are
    // pushed by the front-end at boot via mcp_set_supabase_config (Vite's
    // import.meta.env.VITE_* values are bundled into the front-end JS and not
    // visible to Rust).
    let mcp_state: mcp::McpState = std::sync::Arc::new(tokio::sync::RwLock::new(
        mcp::McpStateInner {
            token_to_account: std::collections::HashMap::new(),
            access_tokens: std::collections::HashMap::new(),
            url: None,
            nonce: mcp::endpoint::generate_nonce(),
            supabase_url: String::new(),
            supabase_anon_key: String::new(),
        },
    ));

    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // single-instance + deep-link feature: deep link event auto-fires on the existing instance
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager {
            sessions: Mutex::new(HashMap::new()),
        })
        .manage(secure_store::SecureStoreState {
            known_keys: std::sync::Mutex::new(Vec::new()),
        })
        .manage(mcp_state.clone())
        .setup(|app| {
            let handle = app.handle().clone();
            let state: mcp::McpState = handle.state::<mcp::McpState>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::start_mcp_server(&handle, state).await {
                    eprintln!("[mcp] server failed to start: {e}");
                    // The app keeps running; the UI surfaces the disabled state via
                    // the absence of endpoint.json (Phase J detects this).
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle().clone();
                // Best-effort sync delete; if it fails the next boot's stale
                // detection will clean it up.
                if let Ok(base) = app.path().app_local_data_dir() {
                    let p = base.join("notter-ai").join("mcp").join("endpoint.json");
                    let _ = std::fs::remove_file(p);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            create_pty,
            write_pty,
            resize_pty,
            close_pty,
            llm_request,
            ollama_install::ollama_check_running,
            ollama_install::ollama_check_installed,
            ollama_install::ollama_download_installer,
            ollama_install::ollama_run_installer,
            ollama_install::ollama_start_service,
            secure_store::secure_set,
            secure_store::secure_get,
            secure_store::secure_delete,
            secure_store::secure_register_known_keys,
            mcp::auth::mcp_update_account_token,
            mcp::auth::mcp_remove_account_token,
            mcp::auth::mcp_set_supabase_config,
            mcp::auth::mcp_register_bearer,
            mcp::server::mcp_read_account_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
