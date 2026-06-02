mod commands;
mod connection_manager;
mod desktop_protocol;
mod ftp_client;
mod os_detect;
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

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_app_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    let menu = build_app_menu(&app, &locale).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_app_locale(_locale: String) -> Result<(), String> {
    Ok(())
}

/// Build the native macOS menu bar (File / Edit / Tools / Connection / Window).
/// Only compiled on macOS; other platforms keep the web-based MenuBar component.
#[cfg(target_os = "macos")]
fn menu_text(locale: &str, key: &str) -> &'static str {
    let language = locale
        .split('-')
        .next()
        .unwrap_or("en")
        .to_ascii_lowercase();
    match language.as_str() {
        "zh" => match key {
            "file" => "文件",
            "new_connection" => "新建连接...",
            "save_connection" => "保存连接",
            "close_tab" => "关闭标签页",
            "edit" => "编辑",
            "find" => "查找...",
            "clear_screen" => "清屏",
            "tools" => "工具",
            "options" => "选项...",
            "check_updates" => "检查更新",
            "connection" => "连接",
            "new_tab" => "新建标签页",
            "duplicate_tab" => "复制标签页",
            "next_tab" => "下一个标签页",
            "prev_tab" => "上一个标签页",
            "reconnect" => "重新连接",
            "disconnect" => "断开连接",
            "window" => "窗口",
            _ => english_menu_text(key),
        },
        "de" => match key {
            "file" => "Datei",
            "new_connection" => "Neue Verbindung...",
            "save_connection" => "Verbindung speichern",
            "close_tab" => "Tab schließen",
            "edit" => "Bearbeiten",
            "find" => "Suchen...",
            "clear_screen" => "Bildschirm leeren",
            "tools" => "Werkzeuge",
            "options" => "Optionen...",
            "check_updates" => "Nach Updates suchen",
            "connection" => "Verbindung",
            "new_tab" => "Neuer Tab",
            "duplicate_tab" => "Tab duplizieren",
            "next_tab" => "Nächster Tab",
            "prev_tab" => "Vorheriger Tab",
            "reconnect" => "Neu verbinden",
            "disconnect" => "Trennen",
            "window" => "Fenster",
            _ => english_menu_text(key),
        },
        "ja" => match key {
            "file" => "ファイル",
            "new_connection" => "新規接続...",
            "save_connection" => "接続を保存",
            "close_tab" => "タブを閉じる",
            "edit" => "編集",
            "find" => "検索...",
            "clear_screen" => "画面をクリア",
            "tools" => "ツール",
            "options" => "オプション...",
            "check_updates" => "更新を確認",
            "connection" => "接続",
            "new_tab" => "新規タブ",
            "duplicate_tab" => "タブを複製",
            "next_tab" => "次のタブ",
            "prev_tab" => "前のタブ",
            "reconnect" => "再接続",
            "disconnect" => "切断",
            "window" => "ウィンドウ",
            _ => english_menu_text(key),
        },
        "ru" => match key {
            "file" => "Файл",
            "new_connection" => "Новое подключение...",
            "save_connection" => "Сохранить подключение",
            "close_tab" => "Закрыть вкладку",
            "edit" => "Правка",
            "find" => "Найти...",
            "clear_screen" => "Очистить экран",
            "tools" => "Инструменты",
            "options" => "Параметры...",
            "check_updates" => "Проверить обновления",
            "connection" => "Подключение",
            "new_tab" => "Новая вкладка",
            "duplicate_tab" => "Дублировать вкладку",
            "next_tab" => "Следующая вкладка",
            "prev_tab" => "Предыдущая вкладка",
            "reconnect" => "Переподключиться",
            "disconnect" => "Отключиться",
            "window" => "Окно",
            _ => english_menu_text(key),
        },
        _ => english_menu_text(key),
    }
}

#[cfg(target_os = "macos")]
fn english_menu_text(key: &str) -> &'static str {
    match key {
        "file" => "File",
        "new_connection" => "New Connection...",
        "save_connection" => "Save Connection",
        "close_tab" => "Close Tab",
        "edit" => "Edit",
        "find" => "Find...",
        "clear_screen" => "Clear Screen",
        "tools" => "Tools",
        "options" => "Options...",
        "check_updates" => "Check for Updates",
        "connection" => "Connection",
        "new_tab" => "New Tab",
        "duplicate_tab" => "Duplicate Tab",
        "next_tab" => "Next Tab",
        "prev_tab" => "Previous Tab",
        "reconnect" => "Reconnect",
        "disconnect" => "Disconnect",
        "window" => "Window",
        _ => "",
    }
}
#[cfg(target_os = "macos")]
fn build_app_menu(
    app: &tauri::AppHandle,
    locale: &str,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
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
        menu_text(locale, "file"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "new_connection",
                menu_text(locale, "new_connection"),
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "save_connection",
                menu_text(locale, "save_connection"),
                true,
                Some("CmdOrCtrl+S"),
            )?,
            &MenuItem::with_id(
                app,
                "close_connection",
                menu_text(locale, "close_tab"),
                true,
                Some("CmdOrCtrl+W"),
            )?,
        ],
    )?;

    // ── Edit menu (mix of predefined + custom) ────────────────────────────────
    let edit_menu = Submenu::with_id_and_items(
        app,
        "m_edit",
        menu_text(locale, "edit"),
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
            &MenuItem::with_id(
                app,
                "find",
                menu_text(locale, "find"),
                true,
                Some("CmdOrCtrl+F"),
            )?,
            &MenuItem::with_id(
                app,
                "clear_screen",
                menu_text(locale, "clear_screen"),
                true,
                Some("CmdOrCtrl+L"),
            )?,
        ],
    )?;

    // ── Tools menu ────────────────────────────────────────────────────────────
    let tools_menu = Submenu::with_id_and_items(
        app,
        "m_tools",
        menu_text(locale, "tools"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "settings",
                menu_text(locale, "options"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "check_updates",
                menu_text(locale, "check_updates"),
                true,
                None::<&str>,
            )?,
        ],
    )?;

    // ── Connection menu ───────────────────────────────────────────────────────
    let connection_menu = Submenu::with_id_and_items(
        app,
        "m_connection",
        menu_text(locale, "connection"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "new_tab",
                menu_text(locale, "new_tab"),
                true,
                Some("CmdOrCtrl+T"),
            )?,
            &MenuItem::with_id(
                app,
                "clone_tab",
                menu_text(locale, "duplicate_tab"),
                true,
                Some("CmdOrCtrl+D"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "next_tab",
                menu_text(locale, "next_tab"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "prev_tab",
                menu_text(locale, "prev_tab"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "reconnect",
                menu_text(locale, "reconnect"),
                true,
                Some("F5"),
            )?,
            &MenuItem::with_id(
                app,
                "disconnect",
                menu_text(locale, "disconnect"),
                true,
                None::<&str>,
            )?,
        ],
    )?;

    // ── Window menu ───────────────────────────────────────────────────────────
    let window_menu = Submenu::with_id_and_items(
        app,
        "m_window",
        menu_text(locale, "window"),
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
                #[cfg(not(target_os = "macos"))]
                let _ = app;

                // Register native macOS menu and forward item events to the frontend
                #[cfg(target_os = "macos")]
                {
                    match build_app_menu(&app.handle(), "en-US") {
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
            set_app_locale,
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
