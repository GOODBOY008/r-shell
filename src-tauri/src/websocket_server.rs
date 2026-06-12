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
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Back-pressure bound: maximum binary output frames queued between the PTY
/// reader task and the WebSocket sender task.  When this fills up the PTY
/// reader *blocks*, propagating pressure back through output_tx → SSH channel
/// → TCP window → the remote process (e.g. `yes`).
const WS_OUTPUT_QUEUE_CAPACITY: usize = 256;

/// Batch PTY output into frames of at most this size before sending.
const OUTPUT_FLUSH_BYTES: usize = 16 * 1024;

/// Maximum time (ms) between flushes — keeps latency low for slow output.
const OUTPUT_FLUSH_INTERVAL_MS: u128 = 10;

/// Timeout (ms) for sending JSON *control* messages.  Control messages are
/// best-effort: if the channel is saturated we drop the ACK rather than block
/// the message-dispatch loop.  Output frames use blocking sends instead.
const CONTROL_SEND_TIMEOUT_MS: u64 = 100;

/// Command byte that identifies a binary PTY output frame sent to the frontend.
const BINARY_OUTPUT_CMD: u8 = 0x01;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WsTx = mpsc::Sender<Message>;
/// Per-connection credit semaphore.  The PTY reader acquires 1 permit before
/// each flush; the frontend grants 1 permit per processed frame via Resume.
/// Starting with 0 permits guarantees the reader blocks until the frontend is
/// ready, bounding the WKWebView message queue to INITIAL_WINDOW frames.
type OutputCredits = Arc<Semaphore>;
type OutputControls = Arc<Mutex<HashMap<String, OutputCredits>>>;

#[derive(Debug, PartialEq, Eq)]
enum SendOutcome {
    Sent,
    /// WS sender task exited — treat as a fatal error in the reader loop.
    Closed,
    /// Only returned for control messages that timed out.
    Dropped,
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

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Encode a binary PTY output frame:
///   [0x01][id_len: u16 BE][connection_id bytes][payload bytes]
fn encode_output_frame(connection_id: &str, data: &[u8]) -> Vec<u8> {
    let id_bytes = connection_id.as_bytes();
    let id_len = id_bytes.len().min(u16::MAX as usize);
    let mut frame = Vec::with_capacity(3 + id_len + data.len());
    frame.push(BINARY_OUTPUT_CMD);
    frame.extend_from_slice(&(id_len as u16).to_be_bytes());
    frame.extend_from_slice(&id_bytes[..id_len]);
    frame.extend_from_slice(data);
    frame
}

/// Send a JSON control message with a timeout.
/// Control messages are best-effort — a saturated channel returns `Dropped`.
async fn send_control(tx: &WsTx, msg: &WsMessage) -> Result<SendOutcome> {
    let frame = Message::Text(serde_json::to_string(msg)?.into());
    match tokio::time::timeout(Duration::from_millis(CONTROL_SEND_TIMEOUT_MS), tx.send(frame)).await {
        Ok(Ok(())) => Ok(SendOutcome::Sent),
        Ok(Err(_)) => Ok(SendOutcome::Closed),
        Err(_) => Ok(SendOutcome::Dropped),
    }
}

/// Flush accumulated PTY bytes as a binary output frame.
///
/// **Blocks** until the WS channel has room or the session is cancelled.
/// This is the end-to-end backpressure mechanism: a full WS channel stalls
/// the PTY reader, which stalls `output_tx`, which stalls `channel.wait()`,
/// which exhausts the SSH window and stops the remote process from sending.
async fn flush_output(
    tx: &WsTx,
    connection_id: &str,
    accumulated: &mut Vec<u8>,
    cancel: &CancellationToken,
) -> SendOutcome {
    if accumulated.is_empty() {
        return SendOutcome::Sent;
    }
    let frame = encode_output_frame(connection_id, accumulated);
    accumulated.clear();
    tokio::select! {
        biased;
        _ = cancel.cancelled() => SendOutcome::Closed,
        result = tx.send(Message::Binary(frame.into())) => match result {
            Ok(()) => SendOutcome::Sent,
            Err(_) => SendOutcome::Closed,
        }
    }
}

fn should_remove_pty_state(active_gen: Option<u64>, closed_gen: Option<u64>) -> bool {
    match (active_gen, closed_gen) {
        (Some(a), Some(c)) => a == c,
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

        // Bounded channel: when full the PTY reader blocks, providing backpressure
        // all the way back to the SSH channel and the remote process.
        let (tx, mut rx) = mpsc::channel::<Message>(WS_OUTPUT_QUEUE_CAPACITY);
        let output_controls: OutputControls = Arc::new(Mutex::new(HashMap::new()));
        let mut active_pty_generations: HashMap<String, u64> = HashMap::new();

        // Forward messages from the bounded channel to the WebSocket.
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
                    // Binary INPUT command from frontend (fast path, no JSON).
                    // Format: [0x00][connection_id: 36 bytes][data bytes]
                    if data.is_empty() {
                        continue;
                    }
                    match data[0] {
                        0x00 => {
                            if data.len() < 37 {
                                tracing::warn!("Binary INPUT message too short");
                                continue;
                            }
                            let connection_id = String::from_utf8_lossy(&data[1..37]).to_string();
                            let input_data = data[37..].to_vec();
                            if let Err(e) = self
                                .connection_manager
                                .write_to_pty(&connection_id, input_data)
                                .await
                            {
                                tracing::error!("Failed to write to PTY: {}", e);
                            }
                        }
                        _ => {
                            tracing::warn!("Unknown binary command: {}", data[0]);
                        }
                    }
                }
                Ok(Message::Text(text)) => {
                    tracing::debug!("Received text message: {}", text);
                    let ws_msg: WsMessage = match serde_json::from_str(&text) {
                        Ok(msg) => msg,
                        Err(e) => {
                            let error = WsMessage::Error {
                                message: format!("Invalid message format: {}", e),
                            };
                            let _ = send_control(&tx, &error).await?;
                            continue;
                        }
                    };
                    match self
                        .handle_message(ws_msg, tx.clone(), output_controls.clone())
                        .await
                    {
                        Ok(PtyLifecycleEvent::Started { connection_id, generation }) => {
                            active_pty_generations.insert(connection_id, generation);
                        }
                        Ok(PtyLifecycleEvent::Closed { connection_id, generation }) => {
                            if should_remove_pty_state(
                                active_pty_generations.get(&connection_id).copied(),
                                generation,
                            ) {
                                active_pty_generations.remove(&connection_id);
                                output_controls.lock().await.remove(&connection_id);
                            }
                        }
                        Ok(PtyLifecycleEvent::None) => {}
                        Err(e) => {
                            let error = WsMessage::Error {
                                message: format!("Error handling message: {}", e),
                            };
                            let _ = send_control(&tx, &error).await?;
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    tracing::info!("WebSocket connection closed by client");
                    break;
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                Err(e) => {
                    tracing::error!("WebSocket error: {}", e);
                    break;
                }
            }
        }

        // Clean up all active PTY sessions so the SSH channel and reader task
        // are torn down promptly when the browser tab closes.
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
        output_controls.lock().await.clear();
        ws_sender_task.abort();

        Ok(())
    }

    /// Handle a WebSocket message
    async fn handle_message(
        &self,
        msg: WsMessage,
        tx: WsTx,
        output_controls: OutputControls,
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

                let generation = self
                    .connection_manager
                    .start_pty_connection(&connection_id, cols, rows)
                    .await?;

                let cancel_token = self
                    .connection_manager
                    .get_pty_cancel_token(&connection_id)
                    .await
                    .ok_or_else(|| {
                        anyhow::anyhow!("PTY session disappeared immediately after creation")
                    })?;

                // Credit semaphore: 0 initial permits.  The PTY reader acquires
                // 1 permit before each flush; the frontend grants permits via
                // Resume messages (1 per frame processed by xterm).
                let credits: OutputCredits = Arc::new(Semaphore::new(0));
                output_controls.lock().await.insert(connection_id.clone(), Arc::clone(&credits));

                let response = WsMessage::Success {
                    message: format!("PTY connection started: {}", connection_id),
                };
                send_control(&tx, &response).await?;

                let started = WsMessage::PtyStarted {
                    connection_id: connection_id.clone(),
                    generation,
                };
                send_control(&tx, &started).await?;

                // Spawn the PTY reader task.
                // `flush_output` blocks when the WS channel is full — this
                // propagates back-pressure through output_tx to the SSH window.
                let connection_manager = self.connection_manager.clone();
                let connection_id_clone = connection_id.clone();
                let tx_clone = tx.clone();

                tokio::spawn(async move {
                    let mut accumulated = Vec::with_capacity(OUTPUT_FLUSH_BYTES);
                    let mut last_flush = tokio::time::Instant::now();

                    loop {
                        // --- Read from PTY (1 ms poll) ---
                        let read_result = tokio::select! {
                            biased;
                            _ = cancel_token.cancelled() => {
                                tracing::info!(
                                    "PTY reader task cancelled for {}",
                                    connection_id_clone
                                );
                                // Flush any remaining data before exiting.
                                let _ = flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                ).await;
                                return;
                            }
                            result = connection_manager.read_from_pty(&connection_id_clone) => result,
                        };

                        match read_result {
                            Ok(data) if data.is_empty() => {
                                // 1 ms poll returned nothing — flush if interval elapsed.
                                if !accumulated.is_empty()
                                    && last_flush.elapsed().as_millis()
                                        >= OUTPUT_FLUSH_INTERVAL_MS
                                {
                                    // Wait for 1 frontend ACK before sending.
                                    let ok = tokio::select! {
                                        biased;
                                        _ = cancel_token.cancelled() => false,
                                        r = credits.acquire() => r.map(|p| { p.forget(); true }).unwrap_or(false),
                                    };
                                    if !ok {
                                        break;
                                    }
                                    if flush_output(
                                        &tx_clone,
                                        &connection_id_clone,
                                        &mut accumulated,
                                        &cancel_token,
                                    )
                                    .await
                                        == SendOutcome::Closed
                                    {
                                        break;
                                    }
                                    last_flush = tokio::time::Instant::now();
                                }
                            }
                            Ok(data) => {
                                accumulated.extend_from_slice(&data);
                                if accumulated.len() >= OUTPUT_FLUSH_BYTES
                                    || last_flush.elapsed().as_millis()
                                        >= OUTPUT_FLUSH_INTERVAL_MS
                                {
                                    // Wait for 1 frontend ACK before sending.
                                    let ok = tokio::select! {
                                        biased;
                                        _ = cancel_token.cancelled() => false,
                                        r = credits.acquire() => r.map(|p| { p.forget(); true }).unwrap_or(false),
                                    };
                                    if !ok {
                                        break;
                                    }
                                    if flush_output(
                                        &tx_clone,
                                        &connection_id_clone,
                                        &mut accumulated,
                                        &cancel_token,
                                    )
                                    .await
                                        == SendOutcome::Closed
                                    {
                                        break;
                                    }
                                    last_flush = tokio::time::Instant::now();
                                }
                            }
                            Err(e) => {
                                tracing::error!(
                                    "Error reading from PTY {}: {}",
                                    connection_id_clone,
                                    e
                                );
                                let error_msg = WsMessage::Error {
                                    message: format!("Connection lost: {}", e),
                                };
                                let _ = send_control(&tx_clone, &error_msg).await;
                                break;
                            }
                        }
                    }

                    tracing::info!("PTY reader task exiting for {}", connection_id_clone);
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
                send_control(&tx, &response).await?;
                Ok(PtyLifecycleEvent::None)
            }
            WsMessage::Pause { connection_id } => {
                // With credit-based flow control the frontend no longer sends
                // Pause — when credits run out the PTY reader blocks naturally.
                // This handler is kept for protocol compatibility.
                tracing::debug!(
                    "Pause received for connection: {} (no-op with credit flow control)",
                    connection_id
                );
                Ok(PtyLifecycleEvent::None)
            }
            WsMessage::Resume { connection_id } => {
                tracing::debug!("Credit granted for connection: {}", connection_id);
                if let Some(credits) = output_controls.lock().await.get(&connection_id) {
                    credits.add_permits(1);
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
                send_control(&tx, &response).await?;
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
                    send_control(&tx, &started).await?;
                } else {
                    let error = WsMessage::Error {
                        message: format!("Desktop connection not found: {}", connection_id),
                    };
                    send_control(&tx, &error).await?;
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
                send_control(&tx, &response).await?;
                Ok(PtyLifecycleEvent::None)
            }

            _ => {
                tracing::warn!("Unexpected message type received");
                Ok(PtyLifecycleEvent::None)
            }
        }
    }
}
