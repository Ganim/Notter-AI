mod ollama_install;
mod secure_store;
mod mcp;   // NEW — M3

use std::collections::HashMap;

use tauri::Manager;

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
            mcp::auth::mcp_clear_account_access_token,
            mcp::auth::mcp_set_supabase_config,
            mcp::auth::mcp_register_bearer,
            mcp::server::mcp_read_account_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
