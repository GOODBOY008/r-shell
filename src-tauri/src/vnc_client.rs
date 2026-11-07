mod rfb;
#[cfg(test)]
mod tests;

use crate::desktop_frames::DesktopEventSender;
use crate::desktop_protocol::{
    ConnectProgress, DesktopConnectProgress, DesktopEvent, DesktopProtocol, VncConfig,
};
use crate::proxy::{connect_via_proxy, Tunnel};
use anyhow::{bail, ensure, Context, Result};
use async_trait::async_trait;
use rfb::PixelFormat;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, WriteHalf};
use tokio::sync::{MappedMutexGuard, MutexGuard};
use tokio_util::sync::CancellationToken;

const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const PROXY_TIMEOUT: Duration = Duration::from_secs(30);

pub struct VncClient {
    session: Arc<Session>,
}

struct Session {
    cancel: CancellationToken,
    view: Mutex<View>,
    writer: tokio::sync::Mutex<Option<Writer>>,
}

struct View {
    size: (u16, u16),
    clipboard: Option<String>,
    events: Option<DesktopEventSender>,
}

struct Writer {
    stream: WriteHalf<Tunnel>,
    buttons: u8,
}

impl VncClient {
    pub async fn connect(config: &VncConfig, progress: ConnectProgress) -> Result<Self> {
        ensure!(!config.host.is_empty(), "VNC host cannot be empty");
        let format = PixelFormat::from_depth(config.color_depth)?;
        progress(DesktopConnectProgress::WaitingForNetwork);
        let mut stream = if let Some(proxy) = &config.proxy {
            connect_via_proxy(proxy, &config.host, config.port, PROXY_TIMEOUT).await?
        } else {
            // VNC reports progress around both direct and proxied dials.
            crate::desktop_tcp::connect(&config.host, config.port, |_| {})
                .await
                .map_err(|error| anyhow::anyhow!("Could not connect to VNC server: {error}"))?
                .into()
        };
        stream.set_nodelay(true)?;
        progress(DesktopConnectProgress::TcpConnected);
        let size = rfb::handshake(&mut stream, config.password.as_deref(), format)
            .await
            .map_err(|error| anyhow::anyhow!("VNC handshake failed: {error}"))?;
        let (reader, writer) = io::split(stream);
        let session = Arc::new(Session {
            cancel: CancellationToken::new(),
            view: Mutex::new(View {
                size,
                clipboard: None,
                events: None,
            }),
            writer: tokio::sync::Mutex::new(Some(Writer {
                stream: writer,
                buttons: 0,
            })),
        });
        tokio::spawn(session.clone().run(BufReader::new(reader), format));
        Ok(Self { session })
    }
}

impl Drop for VncClient {
    fn drop(&mut self) {
        self.session.cancel.cancel();
    }
}

impl Session {
    async fn run(self: Arc<Self>, mut reader: impl AsyncRead + Unpin, format: PixelFormat) {
        let result = self
            .cancel
            .run_until_cancelled(self.read_messages(&mut reader, format))
            .await;
        self.cancel.cancel();
        self.view.lock().unwrap().events.take();
        self.writer.lock().await.take();
        if let Some(Err(error)) = result {
            tracing::debug!("VNC session ended: {error}");
        }
    }

    async fn read_messages(
        &self,
        reader: &mut (impl AsyncRead + Unpin),
        format: PixelFormat,
    ) -> Result<()> {
        loop {
            match reader.read_u8().await? {
                0 => {
                    reader.read_u8().await?; // Padding.
                    let count = reader.read_u16().await?;
                    let mut resized = false;
                    for _ in 0..count {
                        let x = reader.read_u16().await?;
                        let y = reader.read_u16().await?;
                        let width = reader.read_u16().await?;
                        let height = reader.read_u16().await?;
                        match reader.read_i32().await? {
                            rfb::RAW => {
                                let size = self.view.lock().unwrap().size;
                                let frame =
                                    format.read_raw(reader, (x, y, width, height), size).await?;
                                self.view.lock().unwrap().send(DesktopEvent::Frame(frame));
                            }
                            rfb::DESKTOP_SIZE => {
                                rfb::validate_size(width, height)?;
                                let mut view = self.view.lock().unwrap();
                                view.size = (width, height);
                                view.send(DesktopEvent::Resized { width, height });
                                resized = true;
                            }
                            encoding => bail!("Unsupported VNC framebuffer encoding ({encoding})"),
                        }
                    }
                    self.request_frame(!resized).await?;
                }
                2 => {} // Bell.
                3 => {
                    reader.read_exact(&mut [0; 3]).await?; // Padding.
                    let bytes = rfb::read_payload(reader, rfb::MAX_CLIPBOARD_BYTES).await?;
                    let text = bytes.into_iter().map(char::from).collect();
                    self.view
                        .lock()
                        .unwrap()
                        .send(DesktopEvent::Clipboard(text));
                }
                message => bail!("Unsupported VNC server message ({message})"),
            }
        }
    }

    async fn writer(&self) -> Result<MappedMutexGuard<'_, Writer>> {
        let writer = self.writer.lock().await;
        ensure!(
            writer.is_some() && !self.cancel.is_cancelled(),
            "VNC session is closed"
        );
        Ok(MutexGuard::map(writer, |writer| writer.as_mut().unwrap()))
    }

    async fn write(&self, writer: &mut Writer, bytes: &[u8]) -> Result<()> {
        let result = match self
            .cancel
            .run_until_cancelled(tokio::time::timeout(
                WRITE_TIMEOUT,
                writer.stream.write_all(bytes),
            ))
            .await
        {
            Some(Ok(result)) => result.map_err(anyhow::Error::from),
            Some(Err(_)) => Err(anyhow::anyhow!("VNC write timed out")),
            None => Err(anyhow::anyhow!("VNC session is closed")),
        };
        if result.is_err() {
            self.cancel.cancel();
        }
        result
    }

    async fn request_frame(&self, incremental: bool) -> Result<()> {
        let mut writer = self.writer().await?;
        let (width, height) = self.view.lock().unwrap().size;
        let mut bytes = [3, u8::from(incremental), 0, 0, 0, 0, 0, 0, 0, 0];
        bytes[6..8].copy_from_slice(&width.to_be_bytes());
        bytes[8..10].copy_from_slice(&height.to_be_bytes());
        self.write(&mut writer, &bytes).await
    }

    async fn write_pointer(&self, writer: &mut Writer, x: u16, y: u16, scroll: u8) -> Result<()> {
        let (width, height) = self.view.lock().unwrap().size;
        let mut bytes = [0; 12];
        bytes[0] = 5;
        bytes[1] = writer.buttons | scroll;
        bytes[2..4].copy_from_slice(&x.min(width - 1).to_be_bytes());
        bytes[4..6].copy_from_slice(&y.min(height - 1).to_be_bytes());
        if scroll == 0 {
            return self.write(writer, &bytes[..6]).await;
        }
        // RFB scroll is a momentary button press and release.
        let (press, release) = bytes.split_at_mut(6);
        release.copy_from_slice(press);
        release[1] = writer.buttons;
        self.write(writer, &bytes).await
    }
}

impl View {
    fn send(&mut self, event: DesktopEvent) {
        if let DesktopEvent::Clipboard(text) = &event {
            self.clipboard = Some(text.clone());
        }
        if let Some(events) = &self.events {
            let _ = events.send(event);
        }
    }
}

fn rfb_button_mask(mask: u8) -> u8 {
    // The desktop bridge uses DOM/RDP ordering (left, right, middle).
    (mask & 1) | ((mask & 2) << 1) | ((mask & 4) >> 1)
}

#[async_trait]
impl DesktopProtocol for VncClient {
    fn is_connected(&self) -> bool {
        !self.session.cancel.is_cancelled()
    }

    async fn start_frame_loop(
        &self,
        event_tx: DesktopEventSender,
        cancel: CancellationToken,
    ) -> Result<()> {
        {
            let mut view = self.session.view.lock().unwrap();
            ensure!(self.is_connected(), "VNC session is closed");
            let (width, height) = view.size;
            event_tx
                .send(DesktopEvent::Resized { width, height })
                .map_err(|_| anyhow::anyhow!("VNC viewer is closed"))?;
            if let Some(text) = &view.clipboard {
                event_tx
                    .send(DesktopEvent::Clipboard(text.clone()))
                    .map_err(|_| anyhow::anyhow!("VNC viewer is closed"))?;
            }
            view.events = Some(event_tx);
        }
        let session_cancel = self.session.cancel.clone();
        tokio::spawn(async move {
            if session_cancel
                .run_until_cancelled(cancel.cancelled())
                .await
                .is_some()
            {
                session_cancel.cancel();
            }
        });
        self.request_full_frame().await
    }

    async fn send_key(&self, key_code: u32, down: bool) -> Result<()> {
        let mut bytes = [4, u8::from(down), 0, 0, 0, 0, 0, 0];
        bytes[4..].copy_from_slice(&key_code.to_be_bytes());
        let mut writer = self.session.writer().await?;
        self.session.write(&mut writer, &bytes).await
    }

    async fn send_pointer(&self, x: u16, y: u16, button_mask: u8) -> Result<()> {
        let mut writer = self.session.writer().await?;
        let scroll = button_mask & 0x18;
        if scroll == 0 {
            writer.buttons = rfb_button_mask(button_mask);
        }
        self.session.write_pointer(&mut writer, x, y, scroll).await
    }

    async fn send_pointer_button(&self, x: u16, y: u16, button: u8, pressed: bool) -> Result<()> {
        let mut writer = self.session.writer().await?;
        let button = rfb_button_mask(button);
        if pressed {
            writer.buttons |= button;
        } else {
            writer.buttons &= !button;
        }
        self.session.write_pointer(&mut writer, x, y, 0).await
    }

    async fn request_full_frame(&self) -> Result<()> {
        self.session.request_frame(false).await
    }

    async fn set_clipboard(&self, text: String) -> Result<()> {
        ensure!(
            text.len() <= rfb::MAX_CLIPBOARD_BYTES,
            "VNC clipboard text is too large"
        );
        let mut bytes = vec![6, 0, 0, 0, 0, 0, 0, 0];
        for character in text.replace("\r\n", "\n").replace('\r', "\n").chars() {
            bytes.push(
                u8::try_from(u32::from(character))
                    .context("VNC clipboard supports Latin-1 text")?,
            );
        }
        let len = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&len.to_be_bytes());
        let mut writer = self.session.writer().await?;
        self.session.write(&mut writer, &bytes).await
    }

    fn desktop_size(&self) -> (u16, u16) {
        self.session.view.lock().unwrap().size
    }

    async fn resize(&mut self, _width: u16, _height: u16) -> Result<()> {
        // VNC scales the canvas locally. Server-initiated changes arrive via DesktopSize.
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        self.session.cancel.cancel();
        Ok(())
    }
}
