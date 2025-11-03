mod ssh;
mod session_manager;
mod commands;
mod websocket_server;

use session_manager::SessionManager;
use websocket_server::WebSocketServer;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Create session manager
    let session_manager = Arc::new(SessionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup({
            let session_manager_clone = session_manager.clone();
            move |_app| {
                // Start WebSocket server for terminal I/O on port 9001
                // This runs after Tauri's async runtime is initialized
                let ws_server = Arc::new(WebSocketServer::new(session_manager_clone, 9001));
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = ws_server.start().await {
                        tracing::error!("WebSocket server error: {}", e);
                    }
                });
                Ok(())
            }
        })
        .manage(session_manager)
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::ssh_execute_command,
            commands::ssh_tab_complete,
            commands::get_system_stats,
            commands::list_files,
            commands::list_sessions,
            commands::sftp_download_file,
            commands::sftp_upload_file,
            commands::get_processes,
            commands::kill_process,
            commands::tail_log,
            commands::list_log_files,
            commands::get_network_stats,
            commands::get_active_connections,
            commands::get_network_bandwidth,
            commands::get_network_latency,
            commands::get_disk_usage,
            commands::create_directory,
            commands::delete_file,
            commands::rename_file,
            commands::create_file,
            commands::read_file_content,
            commands::copy_file,
            // Note: PTY terminal I/O now uses WebSocket instead of IPC
            // WebSocket server runs on ws://127.0.0.1:9001
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
