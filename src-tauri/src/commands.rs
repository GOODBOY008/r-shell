use crate::session_manager::SessionManager;
use crate::ssh::{AuthMethod, SshConfig};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
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
    state: State<'_, Arc<SessionManager>>,
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

    match state.create_session(request.session_id.clone(), config).await {
        Ok(_) => Ok(CommandResponse {
            success: true,
            output: Some(format!("Connected: {}", request.session_id)),
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
pub async fn ssh_disconnect(
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<CommandResponse, String> {
    match state.close_session(&session_id).await {
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
    session_id: String,
    command: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<CommandResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
                    e.to_string(), 
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
    command.trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

#[tauri::command]
pub async fn get_system_stats(
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<String, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
    // Execute multiple commands to gather system stats
    let commands = vec![
        ("cpu", "top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'"),
        ("memory", "free -m | awk 'NR==2{printf \"{\\\"total\\\":%s,\\\"used\\\":%s,\\\"free\\\":%s}\\n\", $2,$3,$4}'"),
        ("swap", "free -m | awk 'NR==3{printf \"{\\\"total\\\":%s,\\\"used\\\":%s,\\\"free\\\":%s}\\n\", $2,$3,$4}'"),
        ("disk", "df -h / | awk 'NR==2{printf \"{\\\"size\\\":\\\"%s\\\",\\\"used\\\":\\\"%s\\\",\\\"avail\\\":\\\"%s\\\",\\\"use_percent\\\":\\\"%s\\\"}\\n\", $2,$3,$4,$5}'"),
    ];

    let mut results = serde_json::Map::new();
    for (key, cmd) in commands {
        match client.execute_command(cmd).await {
            Ok(output) => {
                results.insert(key.to_string(), serde_json::Value::String(output.trim().to_string()));
            }
            Err(_) => {
                results.insert(key.to_string(), serde_json::Value::Null);
            }
        }
    }

    Ok(serde_json::to_string(&results).unwrap())
}

#[tauri::command]
pub async fn list_files(
    session_id: String,
    path: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<String, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    let command = format!("ls -la --time-style=long-iso '{}'", path);
    
    match client.execute_command(&command).await {
        Ok(output) => Ok(output),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileTransferRequest {
    pub session_id: String,
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
    state: State<'_, Arc<SessionManager>>,
) -> Result<FileTransferResponse, String> {
    let session = state
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
    state: State<'_, Arc<SessionManager>>,
) -> Result<FileTransferResponse, String> {
    let session = state
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
    session_id: String,
    path: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<bool, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    let command = format!("mkdir -p '{}'", path);
    
    match client.execute_command(&command).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn delete_file(
    session_id: String,
    path: String,
    is_directory: bool,
    state: State<'_, Arc<SessionManager>>,
) -> Result<bool, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
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
    session_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<bool, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    let command = format!("mv '{}' '{}'", old_path, new_path);
    
    match client.execute_command(&command).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn create_file(
    session_id: String,
    path: String,
    content: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<bool, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
    // Upload the content as bytes
    match client.upload_file_from_bytes(content.as_bytes(), &path).await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn read_file_content(
    session_id: String,
    path: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<String, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    let command = format!("cat '{}'", path);
    
    match client.execute_command(&command).await {
        Ok(output) => Ok(output),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn copy_file(
    session_id: String,
    source_path: String,
    dest_path: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<bool, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
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
    session_id: String,
    sort_by: Option<String>,
    state: State<'_, Arc<SessionManager>>,
) -> Result<ProcessListResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
    session_id: String,
    pid: String,
    signal: Option<String>,
    state: State<'_, Arc<SessionManager>>,
) -> Result<CommandResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
pub async fn list_sessions(
    state: State<'_, Arc<SessionManager>>,
) -> Result<Vec<String>, String> {
    Ok(state.list_sessions().await)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TailLogRequest {
    pub session_id: String,
    pub log_path: String,
    pub lines: Option<u32>, // Number of lines to show (default 50)
}

#[tauri::command]
pub async fn tail_log(
    session_id: String,
    log_path: String,
    lines: Option<u32>,
    state: State<'_, Arc<SessionManager>>,
) -> Result<CommandResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<CommandResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<NetworkStatsResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<ConnectionsResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<BandwidthResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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

// Network latency monitoring (ping test)
#[derive(Debug, serde::Serialize)]
pub struct LatencyResponse {
    pub success: bool,
    pub latency_ms: Option<f64>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_network_latency(
    session_id: String,
    target: Option<String>,
    state: State<'_, Arc<SessionManager>>,
) -> Result<LatencyResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
    // Default to pinging gateway if no target specified
    let ping_target = target.unwrap_or_else(|| "8.8.8.8".to_string());
    
    // Use ping with count=1 and timeout=1 second
    let command = format!("ping -c 1 -W 1 {} 2>&1 | grep -oP 'time=\\K[0-9.]+' || echo 'timeout'", ping_target);
    
    match client.execute_command(&command).await {
        Ok(output) => {
            let trimmed = output.trim();
            
            if trimmed == "timeout" || trimmed.is_empty() {
                Ok(LatencyResponse {
                    success: false,
                    latency_ms: None,
                    error: Some("Ping timeout or unreachable".to_string()),
                })
            } else {
                match trimmed.parse::<f64>() {
                    Ok(latency) => Ok(LatencyResponse {
                        success: true,
                        latency_ms: Some(latency),
                        error: None,
                    }),
                    Err(_) => Ok(LatencyResponse {
                        success: false,
                        latency_ms: None,
                        error: Some("Failed to parse latency".to_string()),
                    }),
                }
            }
        }
        Err(e) => Ok(LatencyResponse {
            success: false,
            latency_ms: None,
            error: Some(e.to_string()),
        }),
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
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<DiskUsageResponse, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or("Session not found")?;

    let client = session.read().await;
    
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
