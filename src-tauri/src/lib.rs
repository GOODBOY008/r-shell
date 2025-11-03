mod ssh;
mod session_manager;
mod commands;

use session_manager::SessionManager;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Create session manager
    let session_manager = Arc::new(SessionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            // PTY session commands for interactive terminal (like ttyd)
            commands::start_pty_session,
            commands::write_to_pty,
            commands::read_from_pty,
            commands::close_pty_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
