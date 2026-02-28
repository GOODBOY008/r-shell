mod ssh;
mod connection_manager;
mod commands;
mod websocket_server;
mod sftp_client;
mod ftp_client;

use connection_manager::ConnectionManager;
use websocket_server::WebSocketServer;
use std::sync::Arc;
use std::sync::atomic::AtomicU16;

// Global atomic to store the WebSocket port (shared between backend and frontend)
pub static WEBSOCKET_PORT: AtomicU16 = AtomicU16::new(0);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Create connection manager
    let connection_manager = Arc::new(ConnectionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup({
            let connection_manager_clone = connection_manager.clone();
            move |_app| {
                // Start WebSocket server for terminal I/O
                // Try ports 9001-9010 to avoid conflicts with other instances
                let ws_server = Arc::new(WebSocketServer::new(connection_manager_clone));
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = ws_server.start().await {
                        tracing::error!("WebSocket server error: {}", e);
                    }
                });
                Ok(())
            }
        })
        .manage(connection_manager)
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_cancel_connect,
            commands::ssh_disconnect,
            commands::ssh_execute_command,
            commands::ssh_tab_complete,
            commands::get_system_stats,
            commands::list_files,
            commands::list_connections,
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
            commands::detect_gpu,
            commands::get_gpu_stats,
            commands::get_websocket_port,
            // Standalone SFTP/FTP commands
            commands::sftp_connect,
            commands::sftp_standalone_disconnect,
            commands::ftp_connect,
            commands::ftp_disconnect,
            // Unified file operation commands
            commands::list_remote_files,
            commands::download_remote_file,
            commands::upload_remote_file,
            commands::delete_remote_item,
            commands::create_remote_directory,
            commands::rename_remote_item,
            // Local filesystem commands
            commands::list_local_files,
            commands::get_home_directory,
            commands::delete_local_item,
            commands::rename_local_item,
            commands::create_local_directory,
            commands::open_in_os,
            // Directory synchronization commands
            commands::list_local_files_recursive,
            commands::list_remote_files_recursive,
            // Note: PTY terminal I/O now uses WebSocket instead of IPC
            // WebSocket server runs on a dynamically assigned port (9001-9010)
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}