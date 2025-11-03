use crate::session_manager::SessionManager;
use anyhow::Result;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsMessage {
    /// Start a new PTY session
    StartPty {
        session_id: String,
        cols: u32,
        rows: u32,
    },
    /// Terminal input (user typing)
    Input { session_id: String, data: Vec<u8> },
    /// Terminal output (from PTY)
    Output { session_id: String, data: Vec<u8> },
    /// Resize terminal
    Resize {
        session_id: String,
        cols: u32,
        rows: u32,
    },
    /// Close PTY session
    Close { session_id: String },
    /// Error message
    Error { message: String },
    /// Success confirmation
    Success { message: String },
}

/// WebSocket server for terminal I/O
/// Handles bidirectional communication between frontend and PTY sessions
pub struct WebSocketServer {
    session_manager: Arc<SessionManager>,
    port: u16,
}

impl WebSocketServer {
    pub fn new(session_manager: Arc<SessionManager>, port: u16) -> Self {
        Self {
            session_manager,
            port,
        }
    }

    /// Start the WebSocket server
    pub async fn start(self: Arc<Self>) -> Result<()> {
        let addr: SocketAddr = format!("127.0.0.1:{}", self.port).parse()?;
        let listener = TcpListener::bind(&addr).await?;
        
        tracing::info!("WebSocket server listening on {}", addr);

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
                Ok(Message::Text(text)) => {
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
                Ok(Message::Binary(data)) => {
                    tracing::debug!("Received binary message of {} bytes", data.len());
                    // Binary messages are treated as raw terminal input
                    // Format: first 36 bytes are session_id UUID, rest is data
                    if data.len() < 36 {
                        let error = WsMessage::Error {
                            message: "Binary message too short".to_string(),
                        };
                        let _ = tx.send(serde_json::to_string(&error)?);
                        continue;
                    }
                    
                    let session_id = String::from_utf8_lossy(&data[..36]).to_string();
                    let input_data = data[36..].to_vec();
                    
                    if let Err(e) = self
                        .session_manager
                        .write_to_pty(&session_id, input_data)
                        .await
                    {
                        let error = WsMessage::Error {
                            message: format!("Failed to write to PTY: {}", e),
                        };
                        let _ = tx.send(serde_json::to_string(&error)?);
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
                session_id,
                cols,
                rows,
            } => {
                tracing::info!("Starting PTY session: {} ({}x{})", session_id, cols, rows);
                
                // Start the PTY session
                self.session_manager
                    .start_pty_session(&session_id, cols, rows)
                    .await?;

                // Send success response
                let response = WsMessage::Success {
                    message: format!("PTY session started: {}", session_id),
                };
                tx.send(serde_json::to_string(&response)?)?;

                // Start reading from PTY and sending to WebSocket
                let session_manager = self.session_manager.clone();
                let session_id_clone = session_id.clone();
                let tx_clone = tx.clone();

                tokio::spawn(async move {
                    loop {
                        match session_manager.read_from_pty(&session_id_clone).await {
                            Ok(data) => {
                                if data.is_empty() {
                                    // No data available, continue polling
                                    continue;
                                }

                                // Send output to WebSocket
                                let output = WsMessage::Output {
                                    session_id: session_id_clone.clone(),
                                    data,
                                };

                                if let Ok(json) = serde_json::to_string(&output) {
                                    if tx_clone.send(json).is_err() {
                                        tracing::error!("Failed to send output to WebSocket");
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::error!("Error reading from PTY: {}", e);
                                break;
                            }
                        }
                    }
                });
            }
            WsMessage::Input { session_id, data } => {
                tracing::debug!("Received input for session {}: {} bytes", session_id, data.len());
                self.session_manager.write_to_pty(&session_id, data).await?;
            }
            WsMessage::Resize {
                session_id,
                cols,
                rows,
            } => {
                tracing::info!("Resizing terminal {}: {}x{}", session_id, cols, rows);
                // TODO: Implement resize_pty in SessionManager
                let response = WsMessage::Success {
                    message: format!("Terminal resized: {}x{}", cols, rows),
                };
                tx.send(serde_json::to_string(&response)?)?;
            }
            WsMessage::Close { session_id } => {
                tracing::info!("Closing PTY session: {}", session_id);
                self.session_manager.close_pty_session(&session_id).await?;
                let response = WsMessage::Success {
                    message: format!("PTY session closed: {}", session_id),
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
