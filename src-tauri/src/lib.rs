mod commands;
mod connection_manager;
mod desktop_protocol;
mod ftp_client;
mod os_detect;
mod proxy;
mod rdp_client;
mod sftp_client;
mod ssh;
mod vnc_client;
mod websocket_server;

use connection_manager::ConnectionManager;
use std::sync::atomic::AtomicU16;
use std::sync::Arc;
use tauri::Emitter;
use websocket_server::WebSocketServer;

// Global atomic to store the WebSocket port (shared between backend and frontend)
pub static WEBSOCKET_PORT: AtomicU16 = AtomicU16::new(0);

/// Build the native macOS menu bar (File / Edit / Tools / Connection / Window).
/// Only compiled on macOS; other platforms keep the web-based MenuBar component.
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    // ── r-shell (app) menu ────────────────────────────────────────────────────
    let app_menu = Submenu::with_id_and_items(
        app,
        "m_app",
        "r-shell",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // ── File menu ─────────────────────────────────────────────────────────────
    let file_menu = Submenu::with_id_and_items(
        app,
        "m_file",
        "File",
        true,
        &[
            &MenuItem::with_id(
                app,
                "new_connection",
                "New Connection...",
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "save_connection",
                "Save Connection",
                true,
                Some("CmdOrCtrl+S"),
            )?,
            &MenuItem::with_id(
                app,
                "close_connection",
                "Close Tab",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    // ── Edit menu (mix of predefined + custom) ────────────────────────────────
    let edit_menu = Submenu::with_id_and_items(
        app,
        "m_edit",
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "Find...", true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(
                app,
                "clear_screen",
                "Clear Screen",
                true,
                Some("CmdOrCtrl+L"),
            )?,
        ],
    )?;

    // ── Tools menu ────────────────────────────────────────────────────────────
    let tools_menu = Submenu::with_id_and_items(
        app,
        "m_tools",
        "Tools",
        true,
        &[
            &MenuItem::with_id(app, "settings", "Options...", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "check_updates",
                "Check for Updates",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    // ── Connection menu ───────────────────────────────────────────────────────
    let connection_menu = Submenu::with_id_and_items(
        app,
        "m_connection",
        "Connection",
        true,
        &[
            &MenuItem::with_id(app, "new_tab", "New Tab", true, Some("CmdOrCtrl+T"))?,
            &MenuItem::with_id(app, "clone_tab", "Duplicate Tab", true, Some("CmdOrCtrl+D"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "next_tab", "Next Tab", true, None::<&str>)?,
            &MenuItem::with_id(app, "prev_tab", "Previous Tab", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "reconnect", "Reconnect", true, Some("F5"))?,
            &MenuItem::with_id(app, "disconnect", "Disconnect", true, None::<&str>)?,
        ],
    )?;

    // ── Window menu ───────────────────────────────────────────────────────────
    let window_menu = Submenu::with_id_and_items(
        app,
        "m_window",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &tools_menu,
            &connection_menu,
            &window_menu,
        ],
    )
}

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
        .plugin(tauri_plugin_process::init())
        .setup({
            let connection_manager_clone = connection_manager.clone();
            move |app| {
                // Register native macOS menu and forward item events to the frontend
                #[cfg(target_os = "macos")]
                {
                    match build_app_menu(&app.handle()) {
                        Ok(menu) => {
                            if let Err(e) = app.set_menu(menu) {
                                tracing::warn!("Failed to set native menu: {}", e);
                            }
                        }
                        Err(e) => tracing::warn!("Failed to build native menu: {}", e),
                    }
                }

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
        .on_menu_event(|app, event| {
            // Forward custom menu item IDs to the frontend so React can handle them
            let _ = app.emit("menu-action", event.id().0.as_str());
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
            commands::discover_log_sources,
            commands::read_log,
            commands::search_log,
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
            commands::stat_local_path,
            // Directory synchronization commands
            commands::list_local_files_recursive,
            commands::list_remote_files_recursive,
            // Desktop (RDP/VNC) commands
            commands::desktop_connect,
            commands::desktop_disconnect,
            commands::desktop_send_key,
            commands::desktop_send_pointer,
            commands::desktop_request_frame,
            commands::desktop_set_clipboard,
            commands::desktop_resize,
            // Note: PTY terminal I/O now uses WebSocket instead of IPC
            // WebSocket server runs on a dynamically assigned port (9001-9010)
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
