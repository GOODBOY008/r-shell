use crate::connection_manager::ConnectionManager;
use crate::WEBSOCKET_PORT;
use anyhow::Result;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsMessage {
    /// Start a new PTY connection
    StartPty {
        connection_id: String,
        cols: u32,
        rows: u32,
    },
    /// Terminal input (user typing)
    Input { connection_id: String, data: Vec<u8> },
    /// Terminal output (from PTY)
    Output { connection_id: String, data: Vec<u8> },
    /// Resize terminal
    Resize {
        connection_id: String,
        cols: u32,
        rows: u32,
    },
    /// Pause output (flow control - like ttyd)
    Pause { connection_id: String },
    /// Resume output (flow control - like ttyd)
    Resume { connection_id: String },
    /// Close PTY connection
    Close {
        connection_id: String,
        /// If provided, the close is only applied when the generation matches
        /// the current session. This prevents a stale close (from a remounting
        /// component) from killing a newly created PTY session.
        #[serde(default)]
        generation: Option<u64>,
    },
    /// Error message
    Error { message: String },
    /// Success confirmation
    Success { message: String },
    /// PTY session started — includes the generation counter so the frontend
    /// can send it back in Close to avoid stale-close races.
    PtyStarted {
        connection_id: String,
        generation: u64,
    },
}

/// WebSocket server for terminal I/O
/// Handles bidirectional communication between frontend and PTY connections
pub struct WebSocketServer {
    connection_manager: Arc<ConnectionManager>,
}

impl WebSocketServer {
    pub fn new(connection_manager: Arc<ConnectionManager>) -> Self {
        Self {
            connection_manager,
        }
    }

    /// Start the WebSocket server, trying ports 9001-9010 to find an available one
    pub async fn start(self: Arc<Self>) -> Result<()> {
        // Try ports 9001-9010 to find an available one
        let mut listener = None;
        let mut bound_port = 0u16;

        for port in 9001..=9010 {
            let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;
            match TcpListener::bind(&addr).await {
                Ok(l) => {
                    tracing::info!("WebSocket server listening on {}", addr);
                    listener = Some(l);
                    bound_port = port;
                    break;
                }
                Err(e) => {
                    tracing::warn!("Port {} unavailable: {}, trying next...", port, e);
                }
            }
        }

        let listener = listener.ok_or_else(|| {
            anyhow::anyhow!("Failed to bind to any port in range 9001-9010")
        })?;

        // Store the bound port in the global atomic for frontend to query
        WEBSOCKET_PORT.store(bound_port, Ordering::SeqCst);
        tracing::info!("WebSocket port stored: {}", bound_port);

        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    tracing::info!("New WebSocket connection from: {}", addr);
                    let server = self.clone();
                    tokio::spawn(async move {
                        if let Err(e) = server.handle_connection(stream).await {
                            tracing::error!("WebSocket connection error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    tracing::error!("Failed to accept connection: {}", e);
                }
            }
        }
    }

    /// Handle a single WebSocket connection
    async fn handle_connection(&self, stream: TcpStream) -> Result<()> {
        let ws_stream = accept_async(stream).await?;
        let (mut ws_sender, mut ws_receiver) = ws_stream.split();

        // Create a channel for sending messages back to WebSocket from PTY reader task
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        // Task to forward messages from channel to WebSocket
        let ws_sender_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if ws_sender.send(Message::Text(msg)).await.is_err() {
                    break;
                }
            }
        });

        // Handle incoming WebSocket messages
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    // CRITICAL: Binary protocol for maximum performance (like ttyd)
                    // Format: [command byte][connection_id bytes][data bytes]
                    if data.is_empty() {
                        continue;
                    }

                    let command = data[0];

                    match command {
                        0x00 => {
                            // INPUT command - fastest path
                            if data.len() < 37 {
                                tracing::warn!("Binary INPUT message too short");
                                continue;
                            }

                            let connection_id = String::from_utf8_lossy(&data[1..37]).to_string();
                            let input_data = data[37..].to_vec();

                            // Direct write - no JSON overhead
                            if let Err(e) = self
                                .connection_manager
                                .write_to_pty(&connection_id, input_data)
                                .await
                            {
                                tracing::error!("Failed to write to PTY: {}", e);
                            }
                        }
                        _ => {
                            tracing::warn!("Unknown binary command: {}", command);
                        }
                    }
                }
                Ok(Message::Text(text)) => {
                    // Fallback: JSON protocol for control messages
                    tracing::debug!("Received text message: {}", text);

                    // Parse the message
                    let ws_msg: WsMessage = match serde_json::from_str(&text) {
                        Ok(msg) => msg,
                        Err(e) => {
                            let error = WsMessage::Error {
                                message: format!("Invalid message format: {}", e),
                            };
                            let _ = tx.send(serde_json::to_string(&error)?);
                            continue;
                        }
                    };

                    // Handle the message
                    match self.handle_message(ws_msg, tx.clone()).await {
                        Ok(_) => {}
                        Err(e) => {
                            let error = WsMessage::Error {
                                message: format!("Error handling message: {}", e),
                            };
                            let _ = tx.send(serde_json::to_string(&error)?);
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    tracing::info!("WebSocket connection closed by client");
                    break;
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                    // Ignore ping/pong frames
                }
                Ok(Message::Frame(_)) => {
                    // Ignore raw frames
                }
                Err(e) => {
                    tracing::error!("WebSocket error: {}", e);
                    break;
                }
            }
        }

        // Cleanup
        ws_sender_task.abort();

        Ok(())
    }

    /// Handle a WebSocket message
    async fn handle_message(
        &self,
        msg: WsMessage,
        tx: tokio::sync::mpsc::UnboundedSender<String>,
    ) -> Result<()> {
        match msg {
            WsMessage::StartPty {
                connection_id,
                cols,
                rows,
            } => {
                tracing::info!("Starting PTY connection: {} ({}x{})", connection_id, cols, rows);

                // Start the PTY connection (returns the generation counter)
                let generation = self.connection_manager
                    .start_pty_connection(&connection_id, cols, rows)
                    .await?;

                // Grab the cancel token for this session so the reader task can
                // stop promptly when the session is torn down.
                let cancel_token = self.connection_manager
                    .get_pty_cancel_token(&connection_id)
                    .await
                    .ok_or_else(|| {
                        anyhow::anyhow!("PTY session disappeared immediately after creation")
                    })?;

                // Send success response with generation so frontend can use it in Close
                let response = WsMessage::Success {
                    message: format!("PTY connection started: {}", connection_id),
                };
                tx.send(serde_json::to_string(&response)?)?;

                let started = WsMessage::PtyStarted {
                    connection_id: connection_id.clone(),
                    generation,
                };
                tx.send(serde_json::to_string(&started)?)?;

                // Start reading from PTY and sending to WebSocket
                let connection_manager = self.connection_manager.clone();
                let connection_id_clone = connection_id.clone();
                let tx_clone = tx.clone();

                tokio::spawn(async move {
                    // Buffer for accumulating small chunks
                    let mut accumulated = Vec::with_capacity(8192);
                    let mut last_send = tokio::time::Instant::now();

                    loop {
                        // Check cancellation before each read
                        if cancel_token.is_cancelled() {
                            tracing::info!("PTY reader task cancelled for {}", connection_id_clone);
                            break;
                        }

                        let read_result = tokio::select! {
                            _ = cancel_token.cancelled() => {
                                tracing::info!("PTY reader task cancelled for {}", connection_id_clone);
                                break;
                            }
                            result = connection_manager.read_from_pty(&connection_id_clone) => result,
                        };

                        match read_result {
                            Ok(data) => {
                                if data.is_empty() {
                                    // Send accumulated data if we have any and timeout reached
                                    if !accumulated.is_empty() && last_send.elapsed().as_millis() > 5 {
                                        let output = WsMessage::Output {
                                            connection_id: connection_id_clone.clone(),
                                            data: accumulated.clone(),
                                        };

                                        if let Ok(json) = serde_json::to_string(&output) {
                                            if tx_clone.send(json).is_err() {
                                                tracing::error!("Failed to send output to WebSocket");
                                                break;
                                            }
                                        }
                                        accumulated.clear();
                                        last_send = tokio::time::Instant::now();
                                    }
                                    continue;
                                }

                                // Accumulate data
                                accumulated.extend_from_slice(&data);

                                // Send immediately if:
                                // 1. Buffer is large enough (> 4KB)
                                // 2. Or 5ms has passed since last send
                                if accumulated.len() > 4096 || last_send.elapsed().as_millis() > 5 {
                                    let output = WsMessage::Output {
                                        connection_id: connection_id_clone.clone(),
                                        data: accumulated.clone(),
                                    };

                                    if let Ok(json) = serde_json::to_string(&output) {
                                        if tx_clone.send(json).is_err() {
                                            tracing::error!("Failed to send output to WebSocket");
                                            break;
                                        }
                                    }
                                    accumulated.clear();
                                    last_send = tokio::time::Instant::now();
                                }
                            }
                            Err(e) => {
                                tracing::error!("Error reading from PTY: {}", e);
                                let error_msg = WsMessage::Error {
                                    message: format!("Connection lost: {}", e),
                                };
                                if let Ok(json) = serde_json::to_string(&error_msg) {
                                    let _ = tx_clone.send(json);
                                }
                                break;
                            }
                        }
                    }
                });
            }
            WsMessage::Input { connection_id, data } => {
                tracing::debug!("Received input for connection {}: {} bytes", connection_id, data.len());
                self.connection_manager.write_to_pty(&connection_id, data).await?;
            }
            WsMessage::Resize {
                connection_id,
                cols,
                rows,
            } => {
                tracing::info!("Resizing terminal {}: {}x{}", connection_id, cols, rows);
                self.connection_manager
                    .resize_pty(&connection_id, cols, rows)
                    .await?;
                let response = WsMessage::Success {
                    message: format!("Terminal resized: {}x{}", cols, rows),
                };
                tx.send(serde_json::to_string(&response)?)?;
            }
            WsMessage::Pause { connection_id } => {
                tracing::debug!("Pausing output for connection: {}", connection_id);
                // Flow control: pause reading from PTY
                // In a full implementation, we'd pause the output task
                // For now, just acknowledge
            }
            WsMessage::Resume { connection_id } => {
                tracing::debug!("Resuming output for connection: {}", connection_id);
                // Flow control: resume reading from PTY
                // In a full implementation, we'd resume the output task
                // For now, just acknowledge
            }
            WsMessage::Close { connection_id, generation } => {
                tracing::info!("Closing PTY connection: {} (gen: {:?})", connection_id, generation);
                self.connection_manager.close_pty_connection(&connection_id, generation).await?;
                let response = WsMessage::Success {
                    message: format!("PTY connection closed: {}", connection_id),
                };
                tx.send(serde_json::to_string(&response)?)?;
            }
            _ => {
                tracing::warn!("Unexpected message type received");
            }
        }

        Ok(())
    }
}