use crate::connection_manager::ConnectionManager;
use crate::ssh::{AuthMethod, SshConfig};
use crate::sftp_client::{FileEntry, FileEntryType, RemoteFileEntry, SftpConfig, SftpAuthMethod};
use crate::ftp_client::FtpConfig;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectRequest {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryStats {
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub available: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiskStats {
    pub total: String,
    pub used: String,
    pub available: String,
    pub use_percent: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemStats {
    pub cpu_percent: f64,
    pub memory: MemoryStats,
    pub swap: MemoryStats,
    pub disk: DiskStats,
    pub uptime: String,
    pub load_average: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CommandResponse {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn ssh_connect(
    request: ConnectRequest,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let auth_method = match request.auth_method.as_str() {
        "password" => AuthMethod::Password {
            password: request.password.ok_or("Password required")?,
        },
        "publickey" => AuthMethod::PublicKey {
            key_path: request.key_path.ok_or("Key path required")?,
            passphrase: request.passphrase,
        },
        _ => return Err("Invalid auth method".to_string()),
    };

    let config = SshConfig {
        host: request.host,
        port: request.port,
        username: request.username,
        auth_method,
    };

    match state.create_connection(request.connection_id.clone(), config).await {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some(format!("Connected: {}", request.connection_id)),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn ssh_cancel_connect(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    if state.cancel_pending_connection(&connection_id).await {
        Ok(CommandResponse {
            success: true,
            output: Some("Connection cancelled".to_string()),
            error: None,
        })
    } else {
        Ok(CommandResponse {
            success: false,
            output: None,
            error: Some("No pending connection to cancel".to_string()),
        })
    }
}

#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    match state.close_connection(&connection_id).await {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some("Disconnected".to_string()),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn ssh_execute_command(
    connection_id: String,
    command: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Transform interactive commands to batch mode
    let transformed_command = transform_interactive_command(&command);

    match client.execute_command(&transformed_command).await {
        Ok(output) => Ok(CommandResponse {
            success: true,
            output: Some(output),
            error: None,
        }),
        Err(e) => {
            // Check if it's an interactive command that failed
            let error_msg = if is_interactive_command(&command) {
                format!("{}\n\nNote: Interactive commands like '{}' may not work in this terminal. Try using batch mode alternatives.",
                    e,
                    get_command_name(&command))
            } else {
                e.to_string()
            };

            Ok(CommandResponse {
                success: false,
                output: None,
                error: Some(error_msg),
            })
        }
    }
}

// Helper function to transform interactive commands to batch mode
fn transform_interactive_command(command: &str) -> String {
    let cmd = command.trim();

    // Handle 'top' - convert to batch mode with 1 iteration
    if cmd == "top" || cmd.starts_with("top ") {
        return format!("{} -bn1", cmd);
    }

    // Handle 'htop' - suggest alternative
    if cmd == "htop" || cmd.starts_with("htop ") {
        return "top -bn1".to_string();
    }

    // Return original command if no transformation needed
    command.to_string()
}

// Helper function to check if a command is interactive
fn is_interactive_command(command: &str) -> bool {
    let cmd_name = get_command_name(command);
    matches!(cmd_name.as_str(),
        "top" | "htop" | "vim" | "vi" | "nano" | "emacs" |
        "less" | "more" | "man" | "tmux" | "screen"
    )
}

// Helper function to extract command name
fn get_command_name(command: &str) -> String {
    command
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

#[tauri::command]
pub async fn get_system_stats(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<SystemStats, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // CPU usage (percentage)
    let cpu_cmd = "top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'";
    let cpu_percent = client
        .execute_command(cpu_cmd)
        .await
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0);

    // Memory stats (in MB)
    let mem_cmd = "free -m | awk 'NR==2{printf \"%s %s %s %s\", $2,$3,$4,$7}'";
    let mem_output = client.execute_command(mem_cmd).await.unwrap_or_default();
    let mem_parts: Vec<&str> = mem_output.split_whitespace().collect();
    let memory = MemoryStats {
        total: mem_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
        used: mem_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
        free: mem_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
        available: mem_parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0),
    };

    // Swap stats (in MB)
    let swap_cmd = "free -m | awk 'NR==3{printf \"%s %s %s\", $2,$3,$4}'";
    let swap_output = client.execute_command(swap_cmd).await.unwrap_or_default();
    let swap_parts: Vec<&str> = swap_output.split_whitespace().collect();
    let swap = MemoryStats {
        total: swap_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
        used: swap_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
        free: swap_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
        available: 0, // Swap doesn't have 'available' concept
    };

    // Disk stats for root filesystem
    let disk_cmd = "df -h / | awk 'NR==2{printf \"%s %s %s %s\", $2,$3,$4,$5}'";
    let disk_output = client.execute_command(disk_cmd).await.unwrap_or_default();
    let disk_parts: Vec<&str> = disk_output.trim().split_whitespace().collect();
    let disk = DiskStats {
        total: disk_parts.get(0).unwrap_or(&"0").to_string(),
        used: disk_parts.get(1).unwrap_or(&"0").to_string(),
        available: disk_parts.get(2).unwrap_or(&"0").to_string(),
        use_percent: disk_parts
            .get(3)
            .and_then(|s| s.trim_end_matches('%').parse().ok())
            .unwrap_or(0.0),
    };

    // Uptime
    let uptime_cmd = "uptime -p 2>/dev/null || uptime | awk '{print $3\" \"$4}'";
    let uptime = client
        .execute_command(uptime_cmd)
        .await
        .unwrap_or_else(|_| "Unknown".to_string())
        .trim()
        .to_string();

    // Load average
    let load_cmd = "uptime | awk -F'load average:' '{print $2}' | xargs";
    let load_average = client
        .execute_command(load_cmd)
        .await
        .ok()
        .map(|s| s.trim().to_string());

    Ok(SystemStats {
        cpu_percent,
        memory,
        swap,
        disk,
        uptime,
        load_average,
    })
}

#[tauri::command]
pub async fn list_files(
    connection_id: String,
    path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<String, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;
    let command = format!("ls -la --time-style=long-iso '{}'", path);

    match client.execute_command(&command).await {
        Ok(output) => Ok(output),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileTransferRequest {
    pub connection_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub data: Option<Vec<u8>>, // For upload: file contents
}

#[derive(Debug, Serialize)]
pub struct FileTransferResponse {
    pub success: bool,
    pub bytes_transferred: Option<u64>,
    pub data: Option<Vec<u8>>, // For download: file contents
    pub error: Option<String>,
}

#[tauri::command]
pub async fn sftp_download_file(
    request: FileTransferRequest,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let connection = state
        .get_connection(&request.connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // If local_path is empty, download to memory (for browser download)
    if request.local_path.is_empty() {
        match client.download_file_to_memory(&request.remote_path).await {
            Ok(data) => {
                let bytes = data.len() as u64;
                Ok(FileTransferResponse {
                    success: true,
                    bytes_transferred: Some(bytes),
                    data: Some(data),
                    error: None,
                })
            },
            Err(e) => Ok(FileTransferResponse {
                success: false,
                bytes_transferred: None,
                data: None,
                error: Some(e.to_string()),
            }),
        }
    } else {
        // Download to local file
        match client.download_file(&request.remote_path, &request.local_path).await {
            Ok(bytes) => Ok(FileTransferResponse {
                success: true,
                bytes_transferred: Some(bytes),
                data: None,
                error: None,
            }),
            Err(e) => Ok(FileTransferResponse {
                success: false,
                bytes_transferred: None,
                data: None,
                error: Some(e.to_string()),
            }),
        }
    }
}

#[tauri::command]
pub async fn sftp_upload_file(
    request: FileTransferRequest,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let connection = state
        .get_connection(&request.connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // If data is provided, write directly; otherwise read from local_path
    let result = if let Some(data) = &request.data {
        client.upload_file_from_bytes(data, &request.remote_path).await
    } else {
        client.upload_file(&request.local_path, &request.remote_path).await
    };

    match result {
        Ok(bytes) => Ok(FileTransferResponse {
            success: true,
            bytes_transferred: Some(bytes),
            data: None,
            error: None,
        }),
        Err(e) => Ok(FileTransferResponse {
            success: false,
            bytes_transferred: None,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}

// File operation commands
#[tauri::command]
pub async fn create_directory(
    connection_id: String,
    path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<bool, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;
    let command = format!("mkdir -p '{}'", path);

    match client.execute_command(&command).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn delete_file(
    connection_id: String,
    path: String,
    is_directory: bool,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<bool, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;
    let command = if is_directory {
        format!("rm -rf '{}'", path)
    } else {
        format!("rm -f '{}'", path)
    };

    match client.execute_command(&command).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn rename_file(
    connection_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<bool, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;
    let command = format!("mv '{}' '{}'", old_path, new_path);

    match client.execute_command(&command).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn create_file(
    connection_id: String,
    path: String,
    content: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<bool, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Upload the content as bytes
    match client.upload_file_from_bytes(content.as_bytes(), &path).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn read_file_content(
    connection_id: String,
    path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<String, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;
    let command = format!("cat '{}'", path);

    match client.execute_command(&command).await {
        Ok(output) => Ok(output),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn copy_file(
    connection_id: String,
    source_path: String,
    dest_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<bool, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;
    let command = format!("cp -r '{}' '{}'", source_path, dest_path);

    match client.execute_command(&command).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: String,
    pub user: String,
    pub cpu: String,
    pub mem: String,
    pub command: String,
}

#[derive(Debug, Serialize)]
pub struct ProcessListResponse {
    pub success: bool,
    pub processes: Option<Vec<ProcessInfo>>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_processes(
    connection_id: String,
    sort_by: Option<String>,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<ProcessListResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Execute ps command to get process list
    // Using ps aux for detailed process information
    // Support sorting by cpu (default) or memory
    let sort_option = match sort_by.as_deref() {
        Some("mem") => "-%mem",
        _ => "-%cpu", // Default to CPU sorting
    };
    let command = format!("ps aux --sort={} | head -50", sort_option);

    match client.execute_command(&command).await {
        Ok(output) => {
            let mut processes = Vec::new();

            // Parse ps output (skip header line)
            for line in output.lines().skip(1) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 11 {
                    processes.push(ProcessInfo {
                        user: parts[0].to_string(),
                        pid: parts[1].to_string(),
                        cpu: parts[2].to_string(),
                        mem: parts[3].to_string(),
                        command: parts[10..].join(" "),
                    });
                }
            }

            Ok(ProcessListResponse {
                success: true,
                processes: Some(processes),
                error: None,
            })
        },
        Err(e) => Ok(ProcessListResponse {
            success: false,
            processes: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn kill_process(
    connection_id: String,
    pid: String,
    signal: Option<String>,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Default to SIGTERM (15), can also use SIGKILL (9)
    let sig = signal.unwrap_or_else(|| "15".to_string());
    let command = format!("kill -{} {}", sig, pid);

    match client.execute_command(&command).await {
        Ok(output) => Ok(CommandResponse {
            success: true,
            output: Some(output),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn list_connections(
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<Vec<String>, String> {
    Ok(state.list_connections().await)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TailLogRequest {
    pub connection_id: String,
    pub log_path: String,
    pub lines: Option<u32>, // Number of lines to show (default 50)
}

#[tauri::command]
pub async fn tail_log(
    connection_id: String,
    log_path: String,
    lines: Option<u32>,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    let line_count = lines.unwrap_or(50);
    let command = format!("tail -n {} '{}'", line_count, log_path);

    match client.execute_command(&command).await {
        Ok(output) => Ok(CommandResponse {
            success: true,
            output: Some(output),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn list_log_files(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Common log directories
    let command = "find /var/log -type f -name '*.log' 2>/dev/null | head -50";

    match client.execute_command(command).await {
        Ok(output) => Ok(CommandResponse {
            success: true,
            output: Some(output),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

// ── Enhanced Log Monitor Commands ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogSource {
    pub id: String,
    pub name: String,
    pub source_type: String, // "file" | "journal" | "docker"
    pub path: String,
    pub category: String,    // "system" | "auth" | "kernel" | "service" | "container" | "application" | ...
    pub size_human: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LogSourcesResponse {
    pub success: bool,
    pub sources: Vec<LogSource>,
    pub error: Option<String>,
}

fn categorize_log_file(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.contains("auth") || lower.contains("secure") || lower.contains("faillog") {
        "auth".into()
    } else if lower.contains("kern") || lower.contains("dmesg") {
        "kernel".into()
    } else if lower.contains("syslog") || lower.contains("messages") || lower.contains("boot") {
        "system".into()
    } else if lower.contains("cron") {
        "cron".into()
    } else if lower.contains("mail") {
        "mail".into()
    } else if lower.contains("dpkg") || lower.contains("yum") || lower.contains("apt") {
        "package".into()
    } else if lower.contains("nginx") || lower.contains("apache") || lower.contains("httpd") {
        "web".into()
    } else {
        "application".into()
    }
}

#[tauri::command]
pub async fn discover_log_sources(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<LogSourcesResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;
    let client = connection.read().await;

    let mut sources: Vec<LogSource> = Vec::new();

    // 1. Discover log files in /var/log (broad search)
    let file_cmd = concat!(
        "find /var/log -maxdepth 3 -type f \\( ",
        "-name '*.log' -o -name '*.log.*' -o ",
        "-name 'syslog' -o -name 'syslog.*' -o ",
        "-name 'messages' -o -name 'messages.*' -o ",
        "-name 'auth.log' -o -name 'auth.log.*' -o ",
        "-name 'secure' -o -name 'secure.*' -o ",
        "-name 'kern.log' -o -name 'daemon.log' -o ",
        "-name 'dmesg' -o -name 'mail.log' -o ",
        "-name 'cron' -o -name 'cron.log' -o ",
        "-name 'boot.log' -o -name 'dpkg.log' -o ",
        "-name 'yum.log' -o -name 'alternatives.log' ",
        "\\) -readable 2>/dev/null | head -80"
    );

    if let Ok(output) = client.execute_command(file_cmd).await {
        for line in output.lines() {
            let path = line.trim().to_string();
            if path.is_empty() {
                continue;
            }
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            let category = categorize_log_file(&name);
            sources.push(LogSource {
                id: format!("file:{}", path),
                name,
                source_type: "file".into(),
                path,
                category,
                size_human: None,
            });
        }
    }

    // Get file sizes using du -h
    if !sources.is_empty() {
        let file_paths: Vec<String> = sources
            .iter()
            .filter(|s| s.source_type == "file")
            .map(|s| format!("'{}'", s.path))
            .collect();

        if !file_paths.is_empty() {
            let size_cmd = format!("du -h {} 2>/dev/null", file_paths.join(" "));
            if let Ok(output) = client.execute_command(&size_cmd).await {
                for line in output.lines() {
                    let parts: Vec<&str> = line.trim().split('\t').collect();
                    if parts.len() >= 2 {
                        let size = parts[0].trim();
                        let path = parts[1].trim();
                        if let Some(src) = sources.iter_mut().find(|s| s.path == path) {
                            src.size_human = Some(size.to_string());
                        }
                    }
                }
            }
        }
    }

    // 2. Discover journalctl services
    let journal_cmd = "systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -30";
    if let Ok(output) = client.execute_command(journal_cmd).await {
        for line in output.lines() {
            let unit = line.trim().to_string();
            if unit.is_empty() || unit.starts_with("UNIT") {
                continue;
            }
            let name = unit
                .strip_suffix(".service")
                .unwrap_or(&unit)
                .to_string();
            sources.push(LogSource {
                id: format!("journal:{}", unit),
                name,
                source_type: "journal".into(),
                path: unit,
                category: "service".to_string(),
                size_human: None,
            });
        }
    }

    // 3. Discover docker containers
    let docker_cmd = r#"docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | head -20"#;
    if let Ok(output) = client.execute_command(docker_cmd).await {
        if !output.contains("command not found") && !output.contains("Cannot connect") {
            for line in output.lines() {
                let parts: Vec<&str> = line.trim().splitn(2, '\t').collect();
                if parts.is_empty() || parts[0].is_empty() {
                    continue;
                }
                let container = parts[0].to_string();
                let status = parts.get(1).map(|s| s.to_string());
                sources.push(LogSource {
                    id: format!("docker:{}", container),
                    name: container.clone(),
                    source_type: "docker".into(),
                    path: container,
                    category: "container".to_string(),
                    size_human: status,
                });
            }
        }
    }

    // Sort: files first (by category), then journals, then docker
    sources.sort_by(|a, b| {
        let type_order = |t: &str| match t {
            "file" => 0,
            "journal" => 1,
            "docker" => 2,
            _ => 3,
        };
        type_order(&a.source_type)
            .cmp(&type_order(&b.source_type))
            .then(a.category.cmp(&b.category))
            .then(a.name.cmp(&b.name))
    });

    Ok(LogSourcesResponse {
        success: true,
        sources,
        error: None,
    })
}

#[tauri::command]
pub async fn read_log(
    connection_id: String,
    source_type: String,   // "file" | "journal" | "docker" | "custom"
    path: String,
    lines: Option<u32>,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;
    let client = connection.read().await;

    let line_count = lines.unwrap_or(200);

    let cmd = match source_type.as_str() {
        "journal" => format!(
            "journalctl -u '{}' -n {} --no-pager 2>/dev/null",
            path, line_count
        ),
        "docker" => format!(
            "docker logs --tail {} '{}' 2>&1",
            line_count, path
        ),
        _ => format!("tail -n {} '{}' 2>/dev/null", line_count, path),
    };

    match client.execute_command(&cmd).await {
        Ok(output) => Ok(CommandResponse {
            success: true,
            output: Some(output),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn search_log(
    connection_id: String,
    source_type: String,
    path: String,
    pattern: String,
    is_regex: Option<bool>,
    max_results: Option<u32>,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;
    let client = connection.read().await;

    let limit = max_results.unwrap_or(500);
    let escaped = pattern.replace('\'', "'\\''");
    let grep_flag = if is_regex.unwrap_or(false) {
        "-nE"
    } else {
        "-nF"
    };

    let cmd = match source_type.as_str() {
        "journal" => format!(
            "journalctl -u '{}' --no-pager 2>/dev/null | grep {} -i '{}' | tail -n {}",
            path, grep_flag, escaped, limit
        ),
        "docker" => format!(
            "docker logs '{}' 2>&1 | grep {} -i '{}' | tail -n {}",
            path, grep_flag, escaped, limit
        ),
        _ => format!(
            "grep {} -i '{}' '{}' 2>/dev/null | tail -n {}",
            grep_flag, escaped, path, limit
        ),
    };

    match client.execute_command(&cmd).await {
        Ok(output) => Ok(CommandResponse {
            success: true,
            output: Some(output),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

// Network interface statistics
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct NetworkInterface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct NetworkStatsResponse {
    pub success: bool,
    pub interfaces: Vec<NetworkInterface>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_network_stats(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<NetworkStatsResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Use /sys/class/net to get interface statistics
    let command = r#"
for iface in /sys/class/net/*; do
    name=$(basename $iface)
    if [ "$name" != "lo" ]; then
        rx_bytes=$(cat $iface/statistics/rx_bytes 2>/dev/null || echo 0)
        tx_bytes=$(cat $iface/statistics/tx_bytes 2>/dev/null || echo 0)
        rx_packets=$(cat $iface/statistics/rx_packets 2>/dev/null || echo 0)
        tx_packets=$(cat $iface/statistics/tx_packets 2>/dev/null || echo 0)
        echo "$name,$rx_bytes,$tx_bytes,$rx_packets,$tx_packets"
    fi
done
"#;

    match client.execute_command(command).await {
        Ok(output) => {
            let mut interfaces = Vec::new();

            for line in output.lines() {
                if line.trim().is_empty() {
                    continue;
                }

                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() == 5 {
                    if let (Ok(rx_bytes), Ok(tx_bytes), Ok(rx_packets), Ok(tx_packets)) = (
                        parts[1].parse::<u64>(),
                        parts[2].parse::<u64>(),
                        parts[3].parse::<u64>(),
                        parts[4].parse::<u64>(),
                    ) {
                        interfaces.push(NetworkInterface {
                            name: parts[0].to_string(),
                            rx_bytes,
                            tx_bytes,
                            rx_packets,
                            tx_packets,
                        });
                    }
                }
            }

            Ok(NetworkStatsResponse {
                success: true,
                interfaces,
                error: None,
            })
        }
        Err(e) => Ok(NetworkStatsResponse {
            success: false,
            interfaces: Vec::new(),
            error: Some(e.to_string()),
        }),
    }
}

// Active network connections
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct NetworkConnection {
    pub protocol: String,
    pub local_address: String,
    pub remote_address: String,
    pub state: String,
    pub pid_program: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ConnectionsResponse {
    pub success: bool,
    pub connections: Vec<NetworkConnection>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_active_connections(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<ConnectionsResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Use ss command (modern replacement for netstat)
    // -t: TCP, -u: UDP, -n: numeric, -p: show process
    let command = "ss -tunp 2>/dev/null | tail -n +2 | head -50";

    match client.execute_command(command).await {
        Ok(output) => {
            let mut connections = Vec::new();

            for line in output.lines() {
                if line.trim().is_empty() {
                    continue;
                }

                // Parse ss output format: Proto Recv-Q Send-Q Local-Address:Port Peer-Address:Port Process
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 5 {
                    let protocol = parts[0].to_string();
                    let local_address = parts[4].to_string();
                    let remote_address = parts[5].to_string();
                    let state = if parts.len() > 1 && parts[1] != "0" {
                        "ESTAB".to_string()
                    } else {
                        parts.get(1).unwrap_or(&"").to_string()
                    };
                    let pid_program = parts.get(6).unwrap_or(&"").to_string();

                    connections.push(NetworkConnection {
                        protocol,
                        local_address,
                        remote_address,
                        state,
                        pid_program,
                    });
                }
            }

            Ok(ConnectionsResponse {
                success: true,
                connections,
                error: None,
            })
        }
        Err(e) => Ok(ConnectionsResponse {
            success: false,
            connections: Vec::new(),
            error: Some(e.to_string()),
        }),
    }
}

// Network bandwidth monitoring (real-time)
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct NetworkBandwidth {
    pub interface: String,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
}

#[derive(Debug, serde::Serialize)]
pub struct BandwidthResponse {
    pub success: bool,
    pub bandwidth: Vec<NetworkBandwidth>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_network_bandwidth(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<BandwidthResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Sample network stats twice with 1 second interval to calculate rates
    let command = r#"
iface_list=""
for iface in /sys/class/net/*; do
    name=$(basename $iface)
    if [ "$name" != "lo" ]; then
        iface_list="$iface_list $name"
    fi
done

for iface in $iface_list; do
    rx1=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null || echo 0)
    tx1=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null || echo 0)
    echo "$iface,$rx1,$tx1"
done
sleep 1
for iface in $iface_list; do
    rx2=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null || echo 0)
    tx2=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null || echo 0)
    echo "$iface,$rx2,$tx2"
done
"#;

    match client.execute_command(command).await {
        Ok(output) => {
            let lines: Vec<&str> = output.lines().collect();
            let mut bandwidth = Vec::new();

            // Split into before and after measurements
            let mid = lines.len() / 2;
            let before = &lines[0..mid];
            let after = &lines[mid..];

            for (before_line, after_line) in before.iter().zip(after.iter()) {
                let before_parts: Vec<&str> = before_line.split(',').collect();
                let after_parts: Vec<&str> = after_line.split(',').collect();

                if before_parts.len() == 3 && after_parts.len() == 3 && before_parts[0] == after_parts[0] {
                    if let (Ok(rx1), Ok(tx1), Ok(rx2), Ok(tx2)) = (
                        before_parts[1].parse::<f64>(),
                        before_parts[2].parse::<f64>(),
                        after_parts[1].parse::<f64>(),
                        after_parts[2].parse::<f64>(),
                    ) {
                        // Calculate bytes per second
                        let rx_bytes_per_sec = rx2 - rx1;
                        let tx_bytes_per_sec = tx2 - tx1;

                        bandwidth.push(NetworkBandwidth {
                            interface: before_parts[0].to_string(),
                            rx_bytes_per_sec,
                            tx_bytes_per_sec,
                        });
                    }
                }
            }

            Ok(BandwidthResponse {
                success: true,
                bandwidth,
                error: None,
            })
        }
        Err(e) => Ok(BandwidthResponse {
            success: false,
            bandwidth: Vec::new(),
            error: Some(e.to_string()),
        }),
    }
}


// Network latency monitoring (SSH connection latency)
#[derive(Debug, serde::Serialize)]
pub struct LatencyResponse {
    pub success: bool,
    pub latency_ms: Option<f64>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_network_latency(
    connection_id: String,
    target: Option<String>,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<LatencyResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Measure SSH connection latency by timing a simple command execution
    // This gives us the round-trip time between client and remote server
    let start = std::time::Instant::now();

    // Execute a lightweight command (echo) to measure latency
    match client.execute_command("echo ping").await {
        Ok(output) => {
            let duration = start.elapsed();
            let latency_ms = duration.as_secs_f64() * 1000.0;

            // Verify the command executed successfully
            if output.trim() == "ping" {
                Ok(LatencyResponse {
                    success: true,
                    latency_ms: Some(latency_ms),
                    error: None,
                })
            } else {
                Ok(LatencyResponse {
                    success: false,
                    latency_ms: None,
                    error: Some("Command verification failed".to_string()),
                })
            }
        }
        Err(e) => {
            Ok(LatencyResponse {
                success: false,
                latency_ms: None,
                error: Some(format!("SSH connection error: {}", e)),
            })
        }
    }
}

// Disk usage details
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DiskInfo {
    pub filesystem: String,
    pub path: String,
    pub total: String,
    pub used: String,
    pub available: String,
    pub usage: u32,
}

#[derive(Debug, serde::Serialize)]
pub struct DiskUsageResponse {
    pub success: bool,
    pub disks: Vec<DiskInfo>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_disk_usage(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<DiskUsageResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Use df command to get disk usage information
    // -h: human readable, -T: show filesystem type, exclude tmpfs and devtmpfs
    let command = "df -hT | grep -v 'tmpfs\\|devtmpfs\\|Filesystem' | awk '{print $1\"|\"$7\"|\"$3\"|\"$4\"|\"$5\"|\"$6}' | head -10";

    match client.execute_command(command).await {
        Ok(output) => {
            let mut disks = Vec::new();

            for line in output.lines() {
                if line.trim().is_empty() {
                    continue;
                }

                // Parse format: filesystem|mountpoint|size|used|avail|use%
                let parts: Vec<&str> = line.split('|').collect();
                if parts.len() == 6 {
                    // Parse usage percentage (remove % sign)
                    let usage_str = parts[5].trim_end_matches('%');
                    let usage = usage_str.parse::<u32>().unwrap_or(0);

                    disks.push(DiskInfo {
                        filesystem: parts[0].to_string(),
                        path: parts[1].to_string(),
                        total: parts[2].to_string(),
                        used: parts[3].to_string(),
                        available: parts[4].to_string(),
                        usage,
                    });
                }
            }

            Ok(DiskUsageResponse {
                success: true,
                disks,
                error: None,
            })
        }
        Err(e) => Ok(DiskUsageResponse {
            success: false,
            disks: Vec::new(),
            error: Some(e.to_string()),
        }),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TabCompletionRequest {
    pub connection_id: String,
    pub input: String,
    pub cursor_position: usize,
}

#[derive(Debug, Serialize)]
pub struct TabCompletionResponse {
    pub success: bool,
    pub completions: Vec<String>,
    pub common_prefix: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn ssh_tab_complete(
    connection_id: String,
    input: String,
    cursor_position: usize,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<TabCompletionResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Extract the word to complete (last word before cursor)
    let text_before_cursor = &input[..cursor_position.min(input.len())];
    let words: Vec<&str> = text_before_cursor.split_whitespace().collect();
    let word_to_complete = words.last().copied().unwrap_or("");

    // Determine completion type
    let is_first_word = words.len() <= 1;

    // Build completion command based on context
    let completion_cmd = if is_first_word {
        // Command completion: use compgen -c for commands
        format!("compgen -c {} 2>/dev/null || echo", word_to_complete)
    } else {
        // File/directory completion: use compgen -f for files
        format!("compgen -f {} 2>/dev/null || ls -1ap {} 2>/dev/null | grep '^{}' || echo",
                word_to_complete,
                if word_to_complete.is_empty() { "." } else { word_to_complete },
                word_to_complete)
    };

    match client.execute_command(&completion_cmd).await {
        Ok(output) => {
            let completions: Vec<String> = output
                .lines()
                .filter(|s| !s.is_empty() && s.starts_with(word_to_complete))
                .map(|s| s.trim().to_string())
                .take(50) // Limit to 50 completions
                .collect();

            // Find common prefix
            let common_prefix = if completions.len() > 1 {
                find_common_prefix(&completions)
            } else {
                None
            };

            Ok(TabCompletionResponse {
                success: true,
                completions,
                common_prefix,
                error: None,
            })
        }
        Err(e) => Ok(TabCompletionResponse {
            success: false,
            completions: Vec::new(),
            common_prefix: None,
            error: Some(e.to_string()),
        }),
    }
}

// Helper function to find common prefix among strings
fn find_common_prefix(strings: &[String]) -> Option<String> {
    if strings.is_empty() {
        return None;
    }
    if strings.len() == 1 {
        return Some(strings[0].clone());
    }

    let first = &strings[0];
    let mut prefix = String::new();

    for (i, ch) in first.chars().enumerate() {
        if strings.iter().all(|s| s.chars().nth(i) == Some(ch)) {
            prefix.push(ch);
        } else {
            break;
        }
    }

    if prefix.is_empty() || prefix == strings[0] {
        None
    } else {
        Some(prefix)
    }
}

// ========== GPU Monitoring ==========

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub vendor: GpuVendor,
    pub driver_version: Option<String>,
    pub cuda_version: Option<String>, // NVIDIA only
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuStats {
    pub index: u32,
    pub name: String,
    pub vendor: GpuVendor,
    pub utilization: f64,         // GPU core usage %
    pub memory_used: u64,         // MiB
    pub memory_total: u64,        // MiB
    pub memory_percent: f64,      // Calculated
    pub temperature: Option<f64>, // Celsius
    pub power_draw: Option<f64>,  // Watts
    pub power_limit: Option<f64>, // Watts
    pub fan_speed: Option<f64>,   // %
    pub encoder_util: Option<f64>, // NVIDIA NVENC %
    pub decoder_util: Option<f64>, // NVIDIA NVDEC %
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GpuDetectionResult {
    pub available: bool,
    pub vendor: GpuVendor,
    pub gpus: Vec<GpuInfo>,
    pub detection_method: String, // "nvidia-smi", "rocm-smi", "sysfs", "none"
}

#[derive(Debug, Serialize)]
pub struct GpuStatsResponse {
    pub success: bool,
    pub gpus: Vec<GpuStats>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn detect_gpu(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<GpuDetectionResult, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Check for NVIDIA GPU first (most common)
    let nvidia_check = client
        .execute_command("which nvidia-smi 2>/dev/null && nvidia-smi --query-gpu=index,name,driver_version --format=csv,noheader 2>/dev/null")
        .await;

    if let Ok(output) = nvidia_check {
        let output = output.trim();
        if !output.is_empty() && !output.contains("not found") && !output.contains("No such file") {
            let mut gpus = Vec::new();
            // Skip first line if it's the path to nvidia-smi
            for line in output.lines() {
                if line.contains("nvidia-smi") || line.trim().is_empty() {
                    continue;
                }
                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 2 {
                    let index = parts[0].parse::<u32>().unwrap_or(0);
                    let name = parts[1].to_string();
                    let driver_version = parts.get(2).map(|s| s.to_string());

                    // Get CUDA version from nvidia-smi header (more reliable than query flag)
                    let cuda_version = client
                        .execute_command("nvidia-smi | sed -n 's/.*CUDA Version: \\([0-9.]*\\).*/\\1/p' | head -1")
                        .await
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());

                    gpus.push(GpuInfo {
                        index,
                        name,
                        vendor: GpuVendor::Nvidia,
                        driver_version,
                        cuda_version,
                    });
                }
            }

            if !gpus.is_empty() {
                return Ok(GpuDetectionResult {
                    available: true,
                    vendor: GpuVendor::Nvidia,
                    gpus,
                    detection_method: "nvidia-smi".to_string(),
                });
            }
        }
    }

    // Check for AMD GPU with rocm-smi
    let amd_rocm_check = client
        .execute_command("which rocm-smi 2>/dev/null && rocm-smi --showid --showproductname 2>/dev/null")
        .await;

    if let Ok(output) = amd_rocm_check {
        let output = output.trim();
        if !output.is_empty() && !output.contains("not found") && output.contains("GPU") {
            let mut gpus = Vec::new();
            let mut current_index = 0u32;
            let mut current_name = String::new();

            for line in output.lines() {
                if line.contains("rocm-smi") || line.trim().is_empty() || line.starts_with("=") {
                    continue;
                }
                // Parse rocm-smi output format
                if line.contains("GPU[") {
                    // Extract GPU index from GPU[X]
                    if let Some(start) = line.find("GPU[") {
                        if let Some(end) = line[start..].find(']') {
                            let idx_str = &line[start + 4..start + end];
                            current_index = idx_str.parse::<u32>().unwrap_or(current_index);
                        }
                    }
                }
                if line.contains("Card series:") || line.contains("Card model:") {
                    if let Some(name) = line.split(':').nth(1) {
                        current_name = name.trim().to_string();
                    }
                }
            }

            // If we couldn't parse properly, create a generic entry
            if current_name.is_empty() {
                current_name = "AMD GPU".to_string();
            }

            gpus.push(GpuInfo {
                index: current_index,
                name: current_name,
                vendor: GpuVendor::Amd,
                driver_version: None,
                cuda_version: None,
            });

            if !gpus.is_empty() {
                return Ok(GpuDetectionResult {
                    available: true,
                    vendor: GpuVendor::Amd,
                    gpus,
                    detection_method: "rocm-smi".to_string(),
                });
            }
        }
    }

    // Fallback: Check for AMD GPU via sysfs
    let amd_sysfs_check = client
        .execute_command("ls /sys/class/drm/card*/device/gpu_busy_percent 2>/dev/null | head -1")
        .await;

    if let Ok(output) = amd_sysfs_check {
        let output = output.trim();
        if !output.is_empty() && output.contains("gpu_busy_percent") {
            // Count available cards
            let card_count = client
                .execute_command("ls -d /sys/class/drm/card[0-9]*/device/gpu_busy_percent 2>/dev/null | wc -l")
                .await
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
                .unwrap_or(1);

            let gpus: Vec<GpuInfo> = (0..card_count)
                .map(|i| GpuInfo {
                    index: i,
                    name: format!("AMD GPU {}", i),
                    vendor: GpuVendor::Amd,
                    driver_version: None,
                    cuda_version: None,
                })
                .collect();

            return Ok(GpuDetectionResult {
                available: true,
                vendor: GpuVendor::Amd,
                gpus,
                detection_method: "sysfs".to_string(),
            });
        }
    }

    // No GPU detected
    Ok(GpuDetectionResult {
        available: false,
        vendor: GpuVendor::Unknown,
        gpus: Vec::new(),
        detection_method: "none".to_string(),
    })
}

#[tauri::command]
pub async fn get_gpu_stats(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<GpuStatsResponse, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;

    // Try NVIDIA first
    let nvidia_cmd = "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,utilization.encoder,utilization.decoder --format=csv,noheader,nounits 2>/dev/null";

    if let Ok(output) = client.execute_command(nvidia_cmd).await {
        let output = output.trim();
        if !output.is_empty() && !output.contains("not found") && !output.contains("Failed") {
            let mut gpus = Vec::new();

            for line in output.lines() {
                if line.trim().is_empty() {
                    continue;
                }

                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 5 {
                    let index = parts[0].parse::<u32>().unwrap_or(0);
                    let name = parts[1].to_string();
                    let utilization = parts[2].parse::<f64>().unwrap_or(0.0);
                    let memory_used = parts[3].parse::<u64>().unwrap_or(0);
                    let memory_total = parts[4].parse::<u64>().unwrap_or(1);
                    let memory_percent = if memory_total > 0 {
                        (memory_used as f64 / memory_total as f64) * 100.0
                    } else {
                        0.0
                    };

                    let temperature = parts.get(5)
                        .and_then(|s| s.parse::<f64>().ok());
                    let power_draw = parts.get(6)
                        .and_then(|s| s.parse::<f64>().ok());
                    let power_limit = parts.get(7)
                        .and_then(|s| s.parse::<f64>().ok());
                    let fan_speed = parts.get(8)
                        .and_then(|s| s.parse::<f64>().ok());
                    let encoder_util = parts.get(9)
                        .and_then(|s| s.parse::<f64>().ok());
                    let decoder_util = parts.get(10)
                        .and_then(|s| s.parse::<f64>().ok());

                    gpus.push(GpuStats {
                        index,
                        name,
                        vendor: GpuVendor::Nvidia,
                        utilization,
                        memory_used,
                        memory_total,
                        memory_percent,
                        temperature,
                        power_draw,
                        power_limit,
                        fan_speed,
                        encoder_util,
                        decoder_util,
                    });
                }
            }

            if !gpus.is_empty() {
                return Ok(GpuStatsResponse {
                    success: true,
                    gpus,
                    error: None,
                });
            }
        }
    }

    // Try AMD rocm-smi with JSON output
    let amd_rocm_cmd = "rocm-smi --showuse --showmeminfo vram --showtemp --showpower --showfan --json 2>/dev/null";

    if let Ok(output) = client.execute_command(amd_rocm_cmd).await {
        let output = output.trim();
        if !output.is_empty() && output.starts_with('{') {
            // Parse JSON output from rocm-smi
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(output) {
                let mut gpus = Vec::new();

                // rocm-smi JSON format varies, try to extract data
                if let Some(obj) = json.as_object() {
                    for (key, value) in obj {
                        if key.starts_with("card") {
                            let index = key.trim_start_matches("card")
                                .parse::<u32>()
                                .unwrap_or(0);

                            let utilization = value.get("GPU use (%)")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.trim_end_matches('%').parse::<f64>().ok())
                                .unwrap_or(0.0);

                            let memory_used = value.get("VRAM Total Used Memory (B)")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<u64>().ok())
                                .map(|b| b / (1024 * 1024)) // Convert to MiB
                                .unwrap_or(0);

                            let memory_total = value.get("VRAM Total Memory (B)")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<u64>().ok())
                                .map(|b| b / (1024 * 1024))
                                .unwrap_or(1);

                            let memory_percent = if memory_total > 0 {
                                (memory_used as f64 / memory_total as f64) * 100.0
                            } else {
                                0.0
                            };

                            let temperature = value.get("Temperature (Sensor edge) (C)")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<f64>().ok());

                            let power_draw = value.get("Average Graphics Package Power (W)")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<f64>().ok());

                            let fan_speed = value.get("Fan speed (%)")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.trim_end_matches('%').parse::<f64>().ok());

                            gpus.push(GpuStats {
                                index,
                                name: format!("AMD GPU {}", index),
                                vendor: GpuVendor::Amd,
                                utilization,
                                memory_used,
                                memory_total,
                                memory_percent,
                                temperature,
                                power_draw,
                                power_limit: None,
                                fan_speed,
                                encoder_util: None,
                                decoder_util: None,
                            });
                        }
                    }
                }

                if !gpus.is_empty() {
                    return Ok(GpuStatsResponse {
                        success: true,
                        gpus,
                        error: None,
                    });
                }
            }
        }
    }

    // Fallback: AMD sysfs
    let amd_sysfs_cmd = r#"
for card in /sys/class/drm/card[0-9]*; do
    if [ -f "$card/device/gpu_busy_percent" ]; then
        idx=$(basename $card | sed 's/card//')
        util=$(cat "$card/device/gpu_busy_percent" 2>/dev/null || echo "0")
        vram_used=$(cat "$card/device/mem_info_vram_used" 2>/dev/null || echo "0")
        vram_total=$(cat "$card/device/mem_info_vram_total" 2>/dev/null || echo "0")
        hwmon=$(ls -d "$card/device/hwmon/hwmon"* 2>/dev/null | head -1)
        if [ -n "$hwmon" ]; then
            temp=$(cat "$hwmon/temp1_input" 2>/dev/null || echo "0")
            power=$(cat "$hwmon/power1_average" 2>/dev/null || echo "0")
            fan=$(cat "$hwmon/fan1_input" 2>/dev/null || echo "0")
            fan_max=$(cat "$hwmon/fan1_max" 2>/dev/null || echo "1")
        else
            temp="0"
            power="0"
            fan="0"
            fan_max="1"
        fi
        echo "$idx|$util|$vram_used|$vram_total|$temp|$power|$fan|$fan_max"
    fi
done
"#;

    if let Ok(output) = client.execute_command(amd_sysfs_cmd).await {
        let output = output.trim();
        if !output.is_empty() {
            let mut gpus = Vec::new();

            for line in output.lines() {
                if line.trim().is_empty() {
                    continue;
                }

                let parts: Vec<&str> = line.split('|').collect();
                if parts.len() >= 8 {
                    let index = parts[0].parse::<u32>().unwrap_or(0);
                    let utilization = parts[1].parse::<f64>().unwrap_or(0.0);
                    let memory_used = parts[2].parse::<u64>().unwrap_or(0) / (1024 * 1024); // bytes to MiB
                    let memory_total = parts[3].parse::<u64>().unwrap_or(1) / (1024 * 1024);
                    let memory_percent = if memory_total > 0 {
                        (memory_used as f64 / memory_total as f64) * 100.0
                    } else {
                        0.0
                    };

                    // Temperature is in millidegrees
                    let temperature = parts[4].parse::<f64>().ok().map(|t| t / 1000.0);
                    // Power is in microwatts
                    let power_draw = parts[5].parse::<f64>().ok().map(|p| p / 1_000_000.0);
                    // Fan speed as percentage of max
                    let fan_speed = match (parts[6].parse::<f64>(), parts[7].parse::<f64>()) {
                        (Ok(fan), Ok(max)) if max > 0.0 => Some((fan / max) * 100.0),
                        _ => None,
                    };

                    gpus.push(GpuStats {
                        index,
                        name: format!("AMD GPU {}", index),
                        vendor: GpuVendor::Amd,
                        utilization,
                        memory_used,
                        memory_total,
                        memory_percent,
                        temperature,
                        power_draw,
                        power_limit: None,
                        fan_speed,
                        encoder_util: None,
                        decoder_util: None,
                    });
                }
            }

            if !gpus.is_empty() {
                return Ok(GpuStatsResponse {
                    success: true,
                    gpus,
                    error: None,
                });
            }
        }
    }

    // No GPU stats available
    Ok(GpuStatsResponse {
        success: false,
        gpus: Vec::new(),
        error: Some("No GPU detected or drivers not installed".to_string()),
    })
}

// ========== WebSocket Port ==========

/// Get the dynamically assigned WebSocket port for PTY terminal connections
#[tauri::command]
pub async fn get_websocket_port() -> Result<u16, String> {
    use crate::WEBSOCKET_PORT;
    use std::sync::atomic::Ordering;

    let port = WEBSOCKET_PORT.load(Ordering::SeqCst);
    if port == 0 {
        Err("WebSocket server not yet started".to_string())
    } else {
        Ok(port)
    }
}

// ========== PTY Connection ==========
// PTY terminal I/O now uses WebSocket instead of IPC for better performance
// WebSocket server runs on a dynamically assigned port (9001-9010)
// Use get_websocket_port() command to get the actual port
// See src/websocket_server.rs for implementation

// ========== Standalone SFTP Connection ==========

#[derive(Debug, Deserialize)]
pub struct SftpConnectRequest {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[tauri::command]
pub async fn sftp_connect(
    request: SftpConnectRequest,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let auth = match request.auth_method.as_str() {
        "password" => SftpAuthMethod::Password {
            password: request.password.unwrap_or_default(),
        },
        "publickey" => SftpAuthMethod::PublicKey {
            key_path: request.key_path.ok_or("Key path required for SFTP")?,
            passphrase: request.passphrase,
        },
        _ => return Err("Invalid SFTP auth method".to_string()),
    };

    let config = SftpConfig {
        host: request.host,
        port: request.port,
        username: request.username,
        auth_method: auth,
    };

    match state.create_sftp_connection(request.connection_id.clone(), config).await {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some(format!("SFTP connected: {}", request.connection_id)),
            error: None,
        }),
        Err(e) => Err(format!("SFTP connection failed: {}", e)),
    }
}

#[tauri::command]
pub async fn sftp_standalone_disconnect(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    match state.close_sftp_connection(&connection_id).await {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some("SFTP disconnected".to_string()),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

// ========== FTP Connection ==========

#[derive(Debug, Deserialize)]
pub struct FtpConnectRequest {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub ftps_enabled: bool,
    pub anonymous: bool,
}

#[tauri::command]
pub async fn ftp_connect(
    request: FtpConnectRequest,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    tracing::info!(
        "ftp_connect: id={}, host={}:{}, user={}, ftps={}, anon={}",
        request.connection_id, request.host, request.port,
        request.username, request.ftps_enabled, request.anonymous
    );

    let config = FtpConfig {
        host: request.host,
        port: request.port,
        username: if request.anonymous {
            "anonymous".to_string()
        } else {
            request.username
        },
        password: if request.anonymous {
            "anonymous@".to_string()
        } else {
            request.password.unwrap_or_default()
        },
        ftps_enabled: request.ftps_enabled,
        anonymous: request.anonymous,
    };

    match state.create_ftp_connection(request.connection_id.clone(), config).await {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some(format!("FTP connected: {}", request.connection_id)),
            error: None,
        }),
        Err(e) => Err(format!("FTP connection failed: {}", e)),
    }
}

#[tauri::command]
pub async fn ftp_disconnect(
    connection_id: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    match state.close_ftp_connection(&connection_id).await {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some("FTP disconnected".to_string()),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

// ========== Unified File Operations ==========

#[tauri::command]
pub async fn list_remote_files(
    connection_id: String,
    path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<Vec<FileEntry>, String> {
    let conn_type = state
        .get_connection_type(&connection_id)
        .await
        .ok_or_else(|| format!("No file connection found for '{}'", connection_id))?;

    match conn_type.as_str() {
        "SFTP" => {
            let sftp_map = state.get_sftp_connection().await;
            let connections = sftp_map.read().await;
            let client = connections
                .get(&connection_id)
                .ok_or("SFTP connection not found")?;
            client.list_dir(&path).await.map_err(|e| e.to_string())
        }
        "FTP" => {
            let ftp_map = state.get_ftp_connection().await;
            let mut connections = ftp_map.write().await;
            let client = connections
                .get_mut(&connection_id)
                .ok_or("FTP connection not found")?;
            client.list_dir(&path).await.map_err(|e| e.to_string())
        }
        _ => Err(format!("Unsupported protocol: {}", conn_type)),
    }
}

#[tauri::command]
pub async fn download_remote_file(
    connection_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let conn_type = state
        .get_connection_type(&connection_id)
        .await
        .ok_or_else(|| format!("No file connection found for '{}'", connection_id))?;

    let result = match conn_type.as_str() {
        "SFTP" => {
            let sftp_map = state.get_sftp_connection().await;
            let connections = sftp_map.read().await;
            let client = connections
                .get(&connection_id)
                .ok_or("SFTP connection not found".to_string())?;
            client.download_file(&remote_path, &local_path).await
        }
        "FTP" => {
            let ftp_map = state.get_ftp_connection().await;
            let mut connections = ftp_map.write().await;
            let client = connections
                .get_mut(&connection_id)
                .ok_or("FTP connection not found".to_string())?;
            client.download_file(&remote_path, &local_path).await
        }
        _ => return Err(format!("Unsupported protocol: {}", conn_type)),
    };

    match result {
        Ok(bytes) => Ok(FileTransferResponse {
            success: true,
            bytes_transferred: Some(bytes),
            data: None,
            error: None,
        }),
        Err(e) => Ok(FileTransferResponse {
            success: false,
            bytes_transferred: None,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn upload_remote_file(
    connection_id: String,
    local_path: String,
    remote_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<FileTransferResponse, String> {
    let conn_type = state
        .get_connection_type(&connection_id)
        .await
        .ok_or_else(|| format!("No file connection found for '{}'", connection_id))?;

    let result = match conn_type.as_str() {
        "SFTP" => {
            let sftp_map = state.get_sftp_connection().await;
            let connections = sftp_map.read().await;
            let client = connections
                .get(&connection_id)
                .ok_or("SFTP connection not found".to_string())?;
            client.upload_file(&local_path, &remote_path).await
        }
        "FTP" => {
            let ftp_map = state.get_ftp_connection().await;
            let mut connections = ftp_map.write().await;
            let client = connections
                .get_mut(&connection_id)
                .ok_or("FTP connection not found".to_string())?;
            client.upload_file(&local_path, &remote_path).await
        }
        _ => return Err(format!("Unsupported protocol: {}", conn_type)),
    };

    match result {
        Ok(bytes) => Ok(FileTransferResponse {
            success: true,
            bytes_transferred: Some(bytes),
            data: None,
            error: None,
        }),
        Err(e) => Ok(FileTransferResponse {
            success: false,
            bytes_transferred: None,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn delete_remote_item(
    connection_id: String,
    path: String,
    is_directory: bool,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let conn_type = state
        .get_connection_type(&connection_id)
        .await
        .ok_or_else(|| format!("No file connection found for '{}'", connection_id))?;

    let result = match conn_type.as_str() {
        "SFTP" => {
            let sftp_map = state.get_sftp_connection().await;
            let connections = sftp_map.read().await;
            let client = connections
                .get(&connection_id)
                .ok_or("SFTP connection not found".to_string())?;
            if is_directory {
                client.delete_dir(&path).await
            } else {
                client.delete_file(&path).await
            }
        }
        "FTP" => {
            let ftp_map = state.get_ftp_connection().await;
            let mut connections = ftp_map.write().await;
            let client = connections
                .get_mut(&connection_id)
                .ok_or("FTP connection not found".to_string())?;
            if is_directory {
                client.delete_dir(&path).await
            } else {
                client.delete_file(&path).await
            }
        }
        _ => return Err(format!("Unsupported protocol: {}", conn_type)),
    };

    match result {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some(format!("Deleted: {}", path)),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn create_remote_directory(
    connection_id: String,
    path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let conn_type = state
        .get_connection_type(&connection_id)
        .await
        .ok_or_else(|| format!("No file connection found for '{}'", connection_id))?;

    let result = match conn_type.as_str() {
        "SFTP" => {
            let sftp_map = state.get_sftp_connection().await;
            let connections = sftp_map.read().await;
            let client = connections
                .get(&connection_id)
                .ok_or("SFTP connection not found".to_string())?;
            client.create_dir(&path).await
        }
        "FTP" => {
            let ftp_map = state.get_ftp_connection().await;
            let mut connections = ftp_map.write().await;
            let client = connections
                .get_mut(&connection_id)
                .ok_or("FTP connection not found".to_string())?;
            client.create_dir(&path).await
        }
        _ => return Err(format!("Unsupported protocol: {}", conn_type)),
    };

    match result {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some(format!("Created directory: {}", path)),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn rename_remote_item(
    connection_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<CommandResponse, String> {
    let conn_type = state
        .get_connection_type(&connection_id)
        .await
        .ok_or_else(|| format!("No file connection found for '{}'", connection_id))?;

    let result = match conn_type.as_str() {
        "SFTP" => {
            let sftp_map = state.get_sftp_connection().await;
            let connections = sftp_map.read().await;
            let client = connections
                .get(&connection_id)
                .ok_or("SFTP connection not found".to_string())?;
            client.rename(&old_path, &new_path).await
        }
        "FTP" => {
            let ftp_map = state.get_ftp_connection().await;
            let mut connections = ftp_map.write().await;
            let client = connections
                .get_mut(&connection_id)
                .ok_or("FTP connection not found".to_string())?;
            client.rename(&old_path, &new_path).await
        }
        _ => return Err(format!("Unsupported protocol: {}", conn_type)),
    };

    match result {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some(format!("Renamed '{}' to '{}'", old_path, new_path)),
            error: None,
        }),
        Err(e) => Ok(CommandResponse {
            success: false,
            output: None,
            error: Some(e.to_string()),
        }),
    }
}

// ========== Local Filesystem Commands ==========

#[tauri::command]
pub async fn list_local_files(path: String) -> Result<Vec<FileEntry>, String> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let dir_path = std::path::Path::new(&path);
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let read_dir = fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory '{}': {}", path, e))?;

    let mut entries: Vec<FileEntry> = Vec::new();
    for item in read_dir {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };

        let name = item.file_name().to_string_lossy().to_string();
        // Skip hidden files starting with . (optional, but common in FTP clients)
        // Actually, let's show all files like FileZilla does

        let metadata = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let file_type = if metadata.is_dir() {
            FileEntryType::Directory
        } else if metadata.file_type().is_symlink() {
            FileEntryType::Symlink
        } else {
            FileEntryType::File
        };

        let size = metadata.len();

        let modified = metadata.modified().ok().map(|t| {
            let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
            let secs = duration.as_secs() as i64;
            format_unix_timestamp(secs)
        });

        let permissions = {
            let mode = metadata.permissions().mode();
            Some(format_unix_permissions(mode))
        };

        entries.push(FileEntry {
            name,
            size,
            modified,
            permissions,
            file_type,
        });
    }

    // Sort: directories first, then files, alphabetical within each group
    entries.sort_by(|a, b| {
        let a_is_dir = matches!(a.file_type, FileEntryType::Directory);
        let b_is_dir = matches!(b.file_type, FileEntryType::Directory);
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// Format a unix timestamp (seconds since epoch) into an ISO-like datetime string.
fn format_unix_timestamp(secs: i64) -> String {
    // Simple manual conversion for local display
    // This avoids pulling in chrono — we just need a readable date string
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Compute year, month, day from days since epoch (1970-01-01)
    let mut y = 1970i64;
    let mut remaining_days = days;

    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }

    let month_days = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining_days < md as i64 {
            m = i;
            break;
        }
        remaining_days -= md as i64;
    }

    let d = remaining_days + 1;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m + 1,
        d,
        hours,
        minutes,
        seconds
    )
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

/// Format Unix file mode bits into a human-readable rwx string.
fn format_unix_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(10);
    // File type
    s.push(match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        _ => '-',
    });
    // Owner
    s.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o100 != 0 { 'x' } else { '-' });
    // Group
    s.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o010 != 0 { 'x' } else { '-' });
    // Other
    s.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o001 != 0 { 'x' } else { '-' });
    s
}

#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[tauri::command]
pub async fn delete_local_item(path: String, is_directory: bool) -> Result<(), String> {
    use std::fs;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if is_directory {
        fs::remove_dir_all(p)
            .map_err(|e| format!("Failed to delete directory '{}': {}", path, e))
    } else {
        fs::remove_file(p)
            .map_err(|e| format!("Failed to delete file '{}': {}", path, e))
    }
}

#[tauri::command]
pub async fn rename_local_item(old_path: String, new_path: String) -> Result<(), String> {
    use std::fs;
    let p = std::path::Path::new(&old_path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", old_path));
    }
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))
}

#[tauri::command]
pub async fn create_local_directory(path: String) -> Result<(), String> {
    use std::fs;
    fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create directory '{}': {}", path, e))
}

#[tauri::command]
pub async fn open_in_os(path: String) -> Result<(), String> {
    open::that(&path)
        .map_err(|e| format!("Failed to open '{}': {}", path, e))
}

// ========== Directory Synchronization ==========

/// A file entry with a relative path (used for recursive listing comparisons).
#[derive(Debug, Clone, Serialize)]
pub struct SyncFileEntry {
    pub relative_path: String,
    pub name: String,
    pub size: u64,
    pub modified: Option<String>,
    pub file_type: FileEntryType,
}

/// Recursively list all files/dirs under a local directory, returning relative paths.
#[tauri::command]
pub async fn list_local_files_recursive(
    path: String,
    exclude_patterns: Vec<String>,
) -> Result<Vec<SyncFileEntry>, String> {
    use std::fs;
    use std::os::unix::fs::MetadataExt;

    fn walk_dir(
        base: &std::path::Path,
        current: &std::path::Path,
        exclude: &[String],
        results: &mut Vec<SyncFileEntry>,
    ) -> Result<(), String> {
        let read_dir = fs::read_dir(current)
            .map_err(|e| format!("Failed to read '{}': {}", current.display(), e))?;

        for item in read_dir {
            let item = match item {
                Ok(i) => i,
                Err(_) => continue,
            };
            let name = item.file_name().to_string_lossy().to_string();

            // Check exclude patterns
            if matches_exclude(&name, exclude) {
                continue;
            }

            let metadata = match item.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let rel_path = item
                .path()
                .strip_prefix(base)
                .unwrap_or(item.path().as_path())
                .to_string_lossy()
                .to_string();

            let file_type = if metadata.is_dir() {
                FileEntryType::Directory
            } else if metadata.file_type().is_symlink() {
                FileEntryType::Symlink
            } else {
                FileEntryType::File
            };

            let modified = metadata.modified().ok().map(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                let secs = duration.as_secs() as i64;
                format_unix_timestamp(secs)
            });

            results.push(SyncFileEntry {
                relative_path: rel_path.clone(),
                name: name.clone(),
                size: metadata.len(),
                modified,
                file_type: file_type.clone(),
            });

            // Recurse into directories
            if metadata.is_dir() {
                walk_dir(base, &item.path(), exclude, results)?;
            }
        }
        Ok(())
    }

    let base_path = std::path::Path::new(&path);
    if !base_path.exists() || !base_path.is_dir() {
        return Err(format!("Path does not exist or is not a directory: {}", path));
    }

    let mut results = Vec::new();
    walk_dir(base_path, base_path, &exclude_patterns, &mut results)?;

    // Sort: directories first, then by relative path
    results.sort_by(|a, b| {
        let a_dir = matches!(a.file_type, FileEntryType::Directory);
        let b_dir = matches!(b.file_type, FileEntryType::Directory);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.relative_path.cmp(&b.relative_path),
        }
    });

    Ok(results)
}

/// Recursively list all files/dirs under a remote directory (SFTP/FTP).
#[tauri::command]
pub async fn list_remote_files_recursive(
    connection_id: String,
    path: String,
    exclude_patterns: Vec<String>,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<Vec<SyncFileEntry>, String> {
    let conn_type = state
        .get_connection_type(&connection_id)
        .await
        .ok_or_else(|| format!("No file connection found for '{}'", connection_id))?;

    let mut results = Vec::new();

    match conn_type.as_str() {
        "SFTP" => {
            let sftp_map = state.get_sftp_connection().await;
            let connections = sftp_map.read().await;
            let client = connections
                .get(&connection_id)
                .ok_or("SFTP connection not found")?;

            fn walk_sftp<'a>(
                client: &'a crate::sftp_client::StandaloneSftpClient,
                base: &'a str,
                current: &'a str,
                exclude: &'a [String],
                results: &'a mut Vec<SyncFileEntry>,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
                Box::pin(async move {
                    let entries = client.list_dir(current).await.map_err(|e| e.to_string())?;
                    for entry in entries {
                        if matches_exclude(&entry.name, exclude) {
                            continue;
                        }
                        let full_path = if current == "/" {
                            format!("/{}", entry.name)
                        } else {
                            format!("{}/{}", current, entry.name)
                        };
                        let rel = full_path
                            .strip_prefix(base)
                            .unwrap_or(&full_path)
                            .trim_start_matches('/')
                            .to_string();

                        let is_dir = matches!(entry.file_type, FileEntryType::Directory);

                        results.push(SyncFileEntry {
                            relative_path: rel.clone(),
                            name: entry.name.clone(),
                            size: entry.size,
                            modified: entry.modified.clone(),
                            file_type: entry.file_type.clone(),
                        });

                        if is_dir {
                            walk_sftp(client, base, &full_path, exclude, results).await?;
                        }
                    }
                    Ok(())
                })
            }

            walk_sftp(client, &path, &path, &exclude_patterns, &mut results).await?;
        }
        "FTP" => {
            let ftp_map = state.get_ftp_connection().await;
            let mut connections = ftp_map.write().await;
            let client = connections
                .get_mut(&connection_id)
                .ok_or("FTP connection not found")?;

            // FTP recursive walk — iterative with a queue since we need &mut
            let mut dirs_to_visit: Vec<String> = vec![path.clone()];
            while let Some(dir) = dirs_to_visit.pop() {
                let entries = client.list_dir(&dir).await.map_err(|e| e.to_string())?;
                for entry in entries {
                    if matches_exclude(&entry.name, &exclude_patterns) {
                        continue;
                    }
                    let full_path = if dir == "/" {
                        format!("/{}", entry.name)
                    } else {
                        format!("{}/{}", dir, entry.name)
                    };
                    let rel = full_path
                        .strip_prefix(&path)
                        .unwrap_or(&full_path)
                        .trim_start_matches('/')
                        .to_string();

                    let is_dir = matches!(entry.file_type, FileEntryType::Directory);

                    results.push(SyncFileEntry {
                        relative_path: rel.clone(),
                        name: entry.name.clone(),
                        size: entry.size,
                        modified: entry.modified.clone(),
                        file_type: entry.file_type.clone(),
                    });

                    if is_dir {
                        dirs_to_visit.push(full_path);
                    }
                }
            }
        }
        _ => return Err(format!("Unsupported protocol: {}", conn_type)),
    }

    // Sort similarly
    results.sort_by(|a, b| {
        let a_dir = matches!(a.file_type, FileEntryType::Directory);
        let b_dir = matches!(b.file_type, FileEntryType::Directory);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.relative_path.cmp(&b.relative_path),
        }
    });

    Ok(results)
}

/// Simple glob-like pattern matching for exclude filter.
fn matches_exclude(name: &str, patterns: &[String]) -> bool {
    for pat in patterns {
        if pat.starts_with("*.") {
            // Extension match
            let ext = &pat[1..]; // e.g., ".log"
            if name.ends_with(ext) {
                return true;
            }
        } else if name == pat {
            return true;
        }
    }
    false
}

// ========== Local Filesystem Tests ==========

#[cfg(test)]
mod local_fs_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        // Create some test files and directories
        fs::write(dir.path().join("file1.txt"), "hello").unwrap();
        fs::write(dir.path().join("file2.rs"), "fn main() {}").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("subdir").join("nested.txt"), "nested").unwrap();
        dir
    }

    #[tokio::test]
    async fn test_list_local_files() {
        let dir = create_test_dir();
        let path = dir.path().to_string_lossy().to_string();
        let result = list_local_files(path).await;
        assert!(result.is_ok());
        let entries = result.unwrap();
        // subdir should come first (directories first)
        assert_eq!(entries[0].name, "subdir");
        assert!(matches!(entries[0].file_type, FileEntryType::Directory));
        // Then files alphabetically
        let file_names: Vec<&str> = entries[1..].iter().map(|e| e.name.as_str()).collect();
        assert!(file_names.contains(&"file1.txt"));
        assert!(file_names.contains(&"file2.rs"));
    }

    #[tokio::test]
    async fn test_list_local_files_nonexistent() {
        let result = list_local_files("/nonexistent/path/xyz".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[tokio::test]
    async fn test_get_home_directory() {
        let result = get_home_directory().await;
        assert!(result.is_ok());
        let home = result.unwrap();
        assert!(!home.is_empty());
        assert!(std::path::Path::new(&home).exists());
    }

    #[tokio::test]
    async fn test_delete_local_file() {
        let dir = create_test_dir();
        let file_path = dir.path().join("file1.txt").to_string_lossy().to_string();
        assert!(std::path::Path::new(&file_path).exists());
        let result = delete_local_item(file_path.clone(), false).await;
        assert!(result.is_ok());
        assert!(!std::path::Path::new(&file_path).exists());
    }

    #[tokio::test]
    async fn test_delete_local_directory() {
        let dir = create_test_dir();
        let sub_path = dir.path().join("subdir").to_string_lossy().to_string();
        assert!(std::path::Path::new(&sub_path).exists());
        let result = delete_local_item(sub_path.clone(), true).await;
        assert!(result.is_ok());
        assert!(!std::path::Path::new(&sub_path).exists());
    }

    #[tokio::test]
    async fn test_rename_local_item() {
        let dir = create_test_dir();
        let old_path = dir.path().join("file1.txt").to_string_lossy().to_string();
        let new_path = dir.path().join("renamed.txt").to_string_lossy().to_string();
        let result = rename_local_item(old_path.clone(), new_path.clone()).await;
        assert!(result.is_ok());
        assert!(!std::path::Path::new(&old_path).exists());
        assert!(std::path::Path::new(&new_path).exists());
    }

    #[tokio::test]
    async fn test_create_local_directory() {
        let dir = create_test_dir();
        let new_dir = dir.path().join("new_subdir").to_string_lossy().to_string();
        let result = create_local_directory(new_dir.clone()).await;
        assert!(result.is_ok());
        assert!(std::path::Path::new(&new_dir).is_dir());
    }

    #[test]
    fn test_format_unix_permissions() {
        assert_eq!(format_unix_permissions(0o100644), "-rw-r--r--");
        assert_eq!(format_unix_permissions(0o040755), "drwxr-xr-x");
        assert_eq!(format_unix_permissions(0o100755), "-rwxr-xr-x");
        assert_eq!(format_unix_permissions(0o120777), "lrwxrwxrwx");
    }

    #[test]
    fn test_format_unix_timestamp() {
        // 2024-01-01 00:00:00 UTC = 1704067200
        let s = format_unix_timestamp(1704067200);
        assert_eq!(s, "2024-01-01 00:00:00");
    }
}