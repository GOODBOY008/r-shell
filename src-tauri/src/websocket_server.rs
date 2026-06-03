use crate::connection_manager::ConnectionManager;
use crate::WEBSOCKET_PORT;
use anyhow::Result;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Mutex};
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
    Input {
        connection_id: String,
        data: Vec<u8>,
    },
    /// Terminal output (from PTY)
    Output {
        connection_id: String,
        data: Vec<u8>,
    },
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

    // ===== Desktop (RDP/VNC) messages =====
    /// Start a desktop streaming session
    StartDesktop {
        connection_id: String,
        width: u16,
        height: u16,
    },
    /// Desktop session started confirmation
    DesktopStarted {
        connection_id: String,
        width: u16,
        height: u16,
    },
    /// Desktop keyboard event from frontend
    DesktopKeyEvent {
        connection_id: String,
        key_code: u32,
        down: bool,
    },
    /// Desktop pointer (mouse) event from frontend
    DesktopPointerEvent {
        connection_id: String,
        x: u16,
        y: u16,
        button_mask: u8,
    },
    /// Clipboard update (bidirectional)
    ClipboardUpdate { connection_id: String, text: String },
    /// Request full framebuffer refresh
    RequestFullFrame { connection_id: String },
    /// Close desktop session
    CloseDesktop { connection_id: String },
}

/// WebSocket server for terminal I/O
/// Handles bidirectional communication between frontend and PTY connections
pub struct WebSocketServer {
    connection_manager: Arc<ConnectionManager>,
}

const WS_OUTPUT_QUEUE_CAPACITY: usize = 256;
const OUTPUT_FLUSH_BYTES: usize = 16 * 1024;
const OUTPUT_FLUSH_INTERVAL_MS: u128 = 10;
const OUTPUT_QUEUE_SEND_TIMEOUT_MS: u64 = 100;
const BINARY_OUTPUT_COMMAND: u8 = 0x01;

type WsTx = mpsc::Sender<Message>;
type PauseControls = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;

#[derive(Debug, PartialEq, Eq)]
enum QueueSendOutcome {
    Sent,
    Dropped,
    Closed,
}

#[derive(Debug, PartialEq, Eq)]
enum PtyLifecycleEvent {
    None,
    Started {
        connection_id: String,
        generation: u64,
    },
    Closed {
        connection_id: String,
        generation: Option<u64>,
    },
}

fn encode_output_frame(connection_id: &str, data: &[u8]) -> Vec<u8> {
    let id_bytes = connection_id.as_bytes();
    let id_len = id_bytes.len().min(u16::MAX as usize);
    let mut frame = Vec::with_capacity(3 + id_len + data.len());
    frame.push(BINARY_OUTPUT_COMMAND);
    frame.extend_from_slice(&(id_len as u16).to_be_bytes());
    frame.extend_from_slice(&id_bytes[..id_len]);
    frame.extend_from_slice(data);
    frame
}

async fn queue_ws_frame(tx: &WsTx, frame: Message) -> QueueSendOutcome {
    match tokio::time::timeout(
        Duration::from_millis(OUTPUT_QUEUE_SEND_TIMEOUT_MS),
        tx.send(frame),
    )
    .await
    {
        Ok(Ok(())) => QueueSendOutcome::Sent,
        Ok(Err(_)) => QueueSendOutcome::Closed,
        Err(_) => QueueSendOutcome::Dropped,
    }
}

async fn queue_ws_json(tx: &WsTx, msg: &WsMessage) -> Result<QueueSendOutcome> {
    Ok(queue_ws_frame(tx, Message::Text(serde_json::to_string(msg)?)).await)
}

async fn flush_accumulated_output(
    tx: &WsTx,
    connection_id: &str,
    accumulated: &mut Vec<u8>,
) -> QueueSendOutcome {
    if accumulated.is_empty() {
        return QueueSendOutcome::Sent;
    }

    let frame = encode_output_frame(connection_id, accumulated);
    accumulated.clear();
    queue_ws_frame(tx, Message::Binary(frame)).await
}

fn should_remove_pty_state(active_generation: Option<u64>, closed_generation: Option<u64>) -> bool {
    match (active_generation, closed_generation) {
        (Some(active), Some(closed)) => active == closed,
        (Some(_), None) => true,
        _ => false,
    }
}

impl WebSocketServer {
    pub fn new(connection_manager: Arc<ConnectionManager>) -> Self {
        Self { connection_manager }
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

        let listener = listener
            .ok_or_else(|| anyhow::anyhow!("Failed to bind to any port in range 9001-9010"))?;

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
        let (tx, mut rx) = mpsc::channel::<Message>(WS_OUTPUT_QUEUE_CAPACITY);
        let pause_controls: PauseControls = Arc::new(Mutex::new(HashMap::new()));
        let mut active_pty_generations: HashMap<String, u64> = HashMap::new();

        // Task to forward messages from channel to WebSocket
        let ws_sender_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if ws_sender.send(msg).await.is_err() {
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
                            let _ = queue_ws_json(&tx, &error).await?;
                            continue;
                        }
                    };

                    // Handle the message
                    match self
                        .handle_message(ws_msg, tx.clone(), pause_controls.clone())
                        .await
                    {
                        Ok(PtyLifecycleEvent::Started {
                            connection_id,
                            generation,
                        }) => {
                            active_pty_generations.insert(connection_id, generation);
                        }
                        Ok(PtyLifecycleEvent::Closed {
                            connection_id,
                            generation,
                        }) => {
                            if should_remove_pty_state(
                                active_pty_generations.get(&connection_id).copied(),
                                generation,
                            ) {
                                active_pty_generations.remove(&connection_id);
                                pause_controls.lock().await.remove(&connection_id);
                            }
                        }
                        Ok(PtyLifecycleEvent::None) => {}
                        Err(e) => {
                            let error = WsMessage::Error {
                                message: format!("Error handling message: {}", e),
                            };
                            let _ = queue_ws_json(&tx, &error).await?;
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
        for (connection_id, generation) in active_pty_generations {
            if let Err(e) = self
                .connection_manager
                .close_pty_connection(&connection_id, Some(generation))
                .await
            {
                tracing::warn!(
                    "Failed to close PTY session {} on WebSocket cleanup: {}",
                    connection_id,
                    e
                );
            }
        }
        pause_controls.lock().await.clear();
        ws_sender_task.abort();

        Ok(())
    }

    /// Handle a WebSocket message
    async fn handle_message(
        &self,
        msg: WsMessage,
        tx: WsTx,
        pause_controls: PauseControls,
    ) -> Result<PtyLifecycleEvent> {
        match msg {
            WsMessage::StartPty {
                connection_id,
                cols,
                rows,
            } => {
                tracing::info!(
                    "Starting PTY connection: {} ({}x{})",
                    connection_id,
                    cols,
                    rows
                );

                // Start the PTY connection (returns the generation counter)
                let generation = self
                    .connection_manager
                    .start_pty_connection(&connection_id, cols, rows)
                    .await?;

                // Grab the cancel token for this session so the reader task can
                // stop promptly when the session is torn down.
                let cancel_token = self
                    .connection_manager
                    .get_pty_cancel_token(&connection_id)
                    .await
                    .ok_or_else(|| {
                        anyhow::anyhow!("PTY session disappeared immediately after creation")
                    })?;

                // Send success response with generation so frontend can use it in Close
                let response = WsMessage::Success {
                    message: format!("PTY connection started: {}", connection_id),
                };

                let started = WsMessage::PtyStarted {
                    connection_id: connection_id.clone(),
                    generation,
                };
                let _ = queue_ws_json(&tx, &response).await?;
                let _ = queue_ws_json(&tx, &started).await?;

                // Start reading from PTY and sending to WebSocket
                let connection_manager = self.connection_manager.clone();
                let connection_id_clone = connection_id.clone();
                let tx_clone = tx.clone();
                let (pause_tx, mut pause_rx) = watch::channel(false);
                pause_controls
                    .lock()
                    .await
                    .insert(connection_id.clone(), pause_tx);

                tokio::spawn(async move {
                    // Buffer for accumulating small chunks
                    let mut accumulated = Vec::with_capacity(OUTPUT_FLUSH_BYTES);
                    let mut last_send = tokio::time::Instant::now();

                    loop {
                        // Check cancellation before each read
                        if cancel_token.is_cancelled() {
                            tracing::info!("PTY reader task cancelled for {}", connection_id_clone);
                            break;
                        }

                        while *pause_rx.borrow_and_update() {
                            tokio::select! {
                                _ = cancel_token.cancelled() => {
                                    tracing::info!("PTY reader task cancelled while paused for {}", connection_id_clone);
                                    return;
                                }
                                changed = pause_rx.changed() => {
                                    if changed.is_err() {
                                        return;
                                    }
                                }
                            }
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
                                    if !accumulated.is_empty()
                                        && last_send.elapsed().as_millis()
                                            > OUTPUT_FLUSH_INTERVAL_MS
                                    {
                                        match flush_accumulated_output(
                                            &tx_clone,
                                            &connection_id_clone,
                                            &mut accumulated,
                                        )
                                        .await
                                        {
                                            QueueSendOutcome::Sent => {}
                                            QueueSendOutcome::Dropped => {
                                                tracing::warn!(
                                                    "Dropping PTY output for {} because WebSocket output queue is full",
                                                    connection_id_clone
                                                );
                                            }
                                            QueueSendOutcome::Closed => {
                                                tracing::error!(
                                                    "Failed to send output to WebSocket"
                                                );
                                                break;
                                            }
                                        }
                                        last_send = tokio::time::Instant::now();
                                    }
                                    continue;
                                }

                                // Accumulate data
                                accumulated.extend_from_slice(&data);

                                // Send immediately if:
                                // 1. Buffer is large enough
                                // 2. Or the flush interval has passed since last send
                                if accumulated.len() >= OUTPUT_FLUSH_BYTES
                                    || last_send.elapsed().as_millis() > OUTPUT_FLUSH_INTERVAL_MS
                                {
                                    match flush_accumulated_output(
                                        &tx_clone,
                                        &connection_id_clone,
                                        &mut accumulated,
                                    )
                                    .await
                                    {
                                        QueueSendOutcome::Sent => {}
                                        QueueSendOutcome::Dropped => {
                                            tracing::warn!(
                                                "Dropping PTY output for {} because WebSocket output queue is full",
                                                connection_id_clone
                                            );
                                        }
                                        QueueSendOutcome::Closed => {
                                            tracing::error!("Failed to send output to WebSocket");
                                            break;
                                        }
                                    }
                                    last_send = tokio::time::Instant::now();
                                }
                            }
                            Err(e) => {
                                tracing::error!("Error reading from PTY: {}", e);
                                let error_msg = WsMessage::Error {
                                    message: format!("Connection lost: {}", e),
                                };
                                let _ = queue_ws_json(&tx_clone, &error_msg).await;
                                break;
                            }
                        }
                    }
                });

                Ok(PtyLifecycleEvent::Started {
                    connection_id,
                    generation,
                })
            }
            WsMessage::Input {
                connection_id,
                data,
            } => {
                tracing::debug!(
                    "Received input for connection {}: {} bytes",
                    connection_id,
                    data.len()
                );
                self.connection_manager
                    .write_to_pty(&connection_id, data)
                    .await?;
                Ok(PtyLifecycleEvent::None)
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
                let _ = queue_ws_json(&tx, &response).await?;
                Ok(PtyLifecycleEvent::None)
            }
            WsMessage::Pause { connection_id } => {
                tracing::debug!("Pausing output for connection: {}", connection_id);
                if let Some(control) = pause_controls.lock().await.get(&connection_id) {
                    let _ = control.send(true);
                }
                Ok(PtyLifecycleEvent::None)
            }
            WsMessage::Resume { connection_id } => {
                tracing::debug!("Resuming output for connection: {}", connection_id);
                if let Some(control) = pause_controls.lock().await.get(&connection_id) {
                    let _ = control.send(false);
                }
                Ok(PtyLifecycleEvent::None)
            }
            WsMessage::Close {
                connection_id,
                generation,
            } => {
                tracing::info!(
                    "Closing PTY connection: {} (gen: {:?})",
                    connection_id,
                    generation
                );
                self.connection_manager
                    .close_pty_connection(&connection_id, generation)
                    .await?;
                let response = WsMessage::Success {
                    message: format!("PTY connection closed: {}", connection_id),
                };
                let _ = queue_ws_json(&tx, &response).await?;
                Ok(PtyLifecycleEvent::Closed {
                    connection_id,
                    generation,
                })
            }

            // ===== Desktop (RDP/VNC) message handling =====
            WsMessage::StartDesktop {
                connection_id,
                width: _width,
                height: _height,
            } => {
                tracing::info!("Starting desktop session: {}", connection_id);
                // The actual connection is established via the desktop_connect Tauri command.
                // StartDesktop requests the frame streaming loop.
                let client = self
                    .connection_manager
                    .get_desktop_connection(&connection_id)
                    .await;
                if let Some(client) = client {
                    let (w, h) = {
                        let c = client.read().await;
                        c.desktop_size()
                    };
                    let started = WsMessage::DesktopStarted {
                        connection_id: connection_id.clone(),
                        width: w,
                        height: h,
                    };
                    let _ = queue_ws_json(&tx, &started).await?;

                    // TODO: start frame streaming loop when protocol clients are implemented
                } else {
                    let error = WsMessage::Error {
                        message: format!("Desktop connection not found: {}", connection_id),
                    };
                    let _ = queue_ws_json(&tx, &error).await?;
                }
                Ok(PtyLifecycleEvent::None)
            }

            WsMessage::DesktopKeyEvent {
                connection_id,
                key_code,
                down,
            } => {
                if let Some(client) = self
                    .connection_manager
                    .get_desktop_connection(&connection_id)
                    .await
                {
                    let c = client.read().await;
                    if let Err(e) = c.send_key(key_code, down).await {
                        tracing::error!("Failed to send desktop key event: {}", e);
                    }
                }
                Ok(PtyLifecycleEvent::None)
            }

            WsMessage::DesktopPointerEvent {
                connection_id,
                x,
                y,
                button_mask,
            } => {
                if let Some(client) = self
                    .connection_manager
                    .get_desktop_connection(&connection_id)
                    .await
                {
                    let c = client.read().await;
                    if let Err(e) = c.send_pointer(x, y, button_mask).await {
                        tracing::error!("Failed to send desktop pointer event: {}", e);
                    }
                }
                Ok(PtyLifecycleEvent::None)
            }

            WsMessage::ClipboardUpdate {
                connection_id,
                text,
            } => {
                if let Some(client) = self
                    .connection_manager
                    .get_desktop_connection(&connection_id)
                    .await
                {
                    let c = client.read().await;
                    if let Err(e) = c.set_clipboard(text).await {
                        tracing::error!("Failed to set desktop clipboard: {}", e);
                    }
                }
                Ok(PtyLifecycleEvent::None)
            }

            WsMessage::RequestFullFrame { connection_id } => {
                if let Some(client) = self
                    .connection_manager
                    .get_desktop_connection(&connection_id)
                    .await
                {
                    let c = client.read().await;
                    if let Err(e) = c.request_full_frame().await {
                        tracing::error!("Failed to request full frame: {}", e);
                    }
                }
                Ok(PtyLifecycleEvent::None)
            }

            WsMessage::CloseDesktop { connection_id } => {
                tracing::info!("Closing desktop session: {}", connection_id);
                if let Err(e) = self
                    .connection_manager
                    .close_desktop_connection(&connection_id)
                    .await
                {
                    tracing::error!("Failed to close desktop connection: {}", e);
                }
                let response = WsMessage::Success {
                    message: format!("Desktop connection closed: {}", connection_id),
                };
                let _ = queue_ws_json(&tx, &response).await?;
                Ok(PtyLifecycleEvent::None)
            }

            _ => {
                tracing::warn!("Unexpected message type received");
                Ok(PtyLifecycleEvent::None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Message;

    #[test]
    fn output_frame_encodes_connection_id_and_payload() {
        let frame = encode_output_frame("conn-1", b"hello");

        assert_eq!(frame[0], BINARY_OUTPUT_COMMAND);
        assert_eq!(u16::from_be_bytes([frame[1], frame[2]]), 6);
        assert_eq!(&frame[3..9], b"conn-1");
        assert_eq!(&frame[9..], b"hello");
    }

    #[tokio::test]
    async fn bounded_ws_queue_drops_when_receiver_is_full() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<Message>(1);

        assert_eq!(
            queue_ws_frame(&tx, Message::Text("first".to_string())).await,
            QueueSendOutcome::Sent
        );
        assert_eq!(
            queue_ws_frame(&tx, Message::Text("second".to_string())).await,
            QueueSendOutcome::Dropped
        );
    }

    #[test]
    fn stale_lifecycle_close_does_not_remove_active_pause_control() {
        assert!(!should_remove_pty_state(Some(2), Some(1)));
        assert!(should_remove_pty_state(Some(2), Some(2)));
        assert!(should_remove_pty_state(Some(2), None));
        assert!(!should_remove_pty_state(None, Some(1)));
    }
}
