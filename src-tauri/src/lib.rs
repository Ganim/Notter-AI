mod secure_store;
mod mcp;   // NEW — M3
mod oauth;

use tauri::Manager;

// --- Tauri entry ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .manage(secure_store::SecureStoreState {
            known_keys: std::sync::Mutex::new(Vec::new()),
        })
        .setup(|app| {
            // Bootstrap the OAuth 2.1 state (JWT signing key, client registry, grant
            // store). We use Tauri's official cross-platform resolver so the data dir
            // is correct on all three platforms:
            //   Windows:  %LOCALAPPDATA%\com.guilh.notterai\
            //   macOS:    ~/Library/Application Support/com.guilh.notterai/
            //   Linux:    $XDG_DATA_HOME/com.guilh.notterai/  (typically ~/.local/share/…)
            let mcp_data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("app_local_data_dir: {e}"))?
                .join("notter-ai")
                .join("mcp");

            let oauth_state = tauri::async_runtime::block_on(
                crate::oauth::bootstrap_oauth(&mcp_data_dir)
            ).unwrap_or_else(|e| {
                eprintln!("[oauth] bootstrap failed ({e}), using in-memory-only state");
                tauri::async_runtime::block_on(async {
                    crate::oauth::bootstrap_oauth(
                        &std::env::temp_dir().join(format!("notter-oauth-fallback-{}", std::process::id()))
                    ).await.expect("even temp bootstrap_oauth failed")
                })
            });

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
                    oauth: oauth_state,
                },
            ));

            app.manage(mcp_state.clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::start_mcp_server(&handle, mcp_state).await {
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
            secure_store::secure_set,
            secure_store::secure_get,
            secure_store::secure_delete,
            secure_store::secure_register_known_keys,
            mcp::auth::mcp_update_account_token,
            mcp::auth::mcp_remove_account_token,
            mcp::auth::mcp_clear_account_access_token,
            mcp::auth::mcp_set_supabase_config,
            mcp::auth::mcp_register_bearer,
            mcp::auth::mcp_set_account_summaries,
            mcp::server::mcp_read_account_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
