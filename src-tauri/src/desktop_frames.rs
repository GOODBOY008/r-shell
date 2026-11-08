//! A bounded, lossless mailbox for desktop updates. Producers never wait for
//! WebSocket I/O: dirty rectangles are composited into one current framebuffer.
//! A slow consumer gets the latest pixels, including every disjoint update.
use crate::desktop_protocol::{DesktopEvent, FrameUpdate};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Default)]
struct Framebuffer {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
    dirty: Option<(u16, u16, u16, u16)>, // left, top, right, bottom (exclusive)
    resized: bool,
    session_info: Option<crate::rdp::diagnostics::SessionInfo>,
    clipboard: Option<String>,
}

impl Framebuffer {
    fn update(&mut self, event: DesktopEvent) {
        match event {
            DesktopEvent::SessionInfo(info) => self.session_info = Some(info),
            DesktopEvent::Clipboard(text) => self.clipboard = Some(text),
            DesktopEvent::Resized { width, height } => {
                if width == 0 || height == 0 || width > 8192 || height > 8192 {
                    return;
                }
                self.width = width;
                self.height = height;
                self.pixels = vec![0; usize::from(width) * usize::from(height) * 4];
                self.dirty = None;
                self.resized = true;
            }
            DesktopEvent::Frame(frame) => {
                let right = u32::from(frame.x) + u32::from(frame.width);
                let bottom = u32::from(frame.y) + u32::from(frame.height);
                if frame.width == 0
                    || frame.height == 0
                    || right > u32::from(self.width)
                    || bottom > u32::from(self.height)
                    || frame.rgba_data.len()
                        != usize::from(frame.width) * usize::from(frame.height) * 4
                {
                    return;
                }
                let row_bytes = usize::from(frame.width) * 4;
                for row in 0..usize::from(frame.height) {
                    let dst = ((usize::from(frame.y) + row) * usize::from(self.width)
                        + usize::from(frame.x))
                        * 4;
                    self.pixels[dst..dst + row_bytes]
                        .copy_from_slice(&frame.rgba_data[row * row_bytes..(row + 1) * row_bytes]);
                }
                self.dirty = Some(match self.dirty {
                    Some((l, t, r, b)) => (
                        l.min(frame.x),
                        t.min(frame.y),
                        r.max(right as u16),
                        b.max(bottom as u16),
                    ),
                    None => (frame.x, frame.y, right as u16, bottom as u16),
                });
            }
        }
    }

    fn take(&mut self) -> Option<DesktopEvent> {
        if let Some(info) = self.session_info.take() {
            return Some(DesktopEvent::SessionInfo(info));
        }
        if let Some(text) = self.clipboard.take() {
            return Some(DesktopEvent::Clipboard(text));
        }
        if self.resized {
            self.resized = false;
            return Some(DesktopEvent::Resized {
                width: self.width,
                height: self.height,
            });
        }
        let (x, y, right, bottom) = self.dirty.take()?;
        let width = right - x;
        let height = bottom - y;
        let row_bytes = usize::from(width) * 4;
        let mut rgba_data = Vec::with_capacity(row_bytes * usize::from(height));
        for row in usize::from(y)..usize::from(bottom) {
            let offset = (row * usize::from(self.width) + usize::from(x)) * 4;
            rgba_data.extend_from_slice(&self.pixels[offset..offset + row_bytes]);
        }
        Some(DesktopEvent::Frame(FrameUpdate {
            x,
            y,
            width,
            height,
            rgba_data,
        }))
    }
}

#[derive(Clone)]
pub struct DesktopEventSender {
    buffer: Arc<Mutex<Framebuffer>>,
    changed: watch::Sender<()>,
}

pub struct DesktopEventReceiver {
    buffer: Arc<Mutex<Framebuffer>>,
    changed: watch::Receiver<()>,
}

pub fn desktop_event_channel() -> (DesktopEventSender, DesktopEventReceiver) {
    let buffer = Arc::new(Mutex::new(Framebuffer::default()));
    let (tx, rx) = watch::channel(());
    (
        DesktopEventSender {
            buffer: buffer.clone(),
            changed: tx,
        },
        DesktopEventReceiver {
            buffer,
            changed: rx,
        },
    )
}

impl DesktopEventSender {
    /// Native rendering keeps only the metadata mailbox alive. Release its
    /// canvas framebuffer until a later Resized event starts pixel delivery.
    pub fn release_framebuffer(&self) {
        let mut buffer = self.buffer.lock().unwrap();
        let session_info = buffer.session_info.take();
        *buffer = Framebuffer { session_info, ..Default::default() };
    }

    pub fn send(&self, event: DesktopEvent) -> Result<(), ()> {
        if self.changed.is_closed() {
            return Err(());
        }
        self.buffer.lock().unwrap().update(event);
        self.changed.send_replace(());
        Ok(())
    }
}

impl DesktopEventReceiver {
    /// Status must still reach the viewer while a pixel frame is waiting for
    /// paint acknowledgement (e.g. a background tab or native pop-out).
    pub async fn recv_session_info(&mut self) -> Option<crate::rdp::diagnostics::SessionInfo> {
        loop {
            if let Some(info) = self.buffer.lock().unwrap().session_info.take() {
                return Some(info);
            }
            if self.changed.changed().await.is_err() {
                return self.buffer.lock().unwrap().session_info.take();
            }
        }
    }

    pub async fn recv(&mut self) -> Option<DesktopEvent> {
        loop {
            if let Some(event) = self.buffer.lock().unwrap().take() {
                return Some(event);
            }
            if self.changed.changed().await.is_err() {
                // The last sender may have published between take() and closure.
                return self.buffer.lock().unwrap().take();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_metadata_route_does_not_retain_the_canvas_framebuffer() {
        let (tx, mut rx) = desktop_event_channel();
        tx.send(DesktopEvent::Resized { width: 1000, height: 1000 }).unwrap();
        tx.send(patch(0, 0, 42)).unwrap();
        let metadata = tx.clone();
        metadata.send(DesktopEvent::SessionInfo(Default::default())).unwrap();
        metadata.release_framebuffer();
        assert_eq!(metadata.buffer.lock().unwrap().pixels.capacity(), 0);
        assert!(matches!(rx.recv().await, Some(DesktopEvent::SessionInfo(_))));
        // The same channel can safely resume after an explicit new size.
        tx.send(DesktopEvent::Resized { width: 1, height: 1 }).unwrap();
        tx.send(patch(0, 0, 7)).unwrap();
        assert!(matches!(rx.recv().await, Some(DesktopEvent::Resized { .. })));
        assert!(matches!(rx.recv().await, Some(DesktopEvent::Frame(frame)) if frame.rgba_data == vec![7; 4]));
    }

    #[tokio::test]
    async fn session_info_survives_resize_and_coalesces_without_losing_pixels() {
        use crate::rdp::diagnostics::{LogonNotification, SessionInfo};
        let (tx, mut rx) = desktop_event_channel();
        let info = SessionInfo {
            session_id: Some(7),
            notification: Some(LogonNotification { code: 0xc000_006d, data: 0 }),
            ..Default::default()
        };
        for _ in 0..10_000 {
            tx.send(DesktopEvent::SessionInfo(info.clone())).unwrap();
        }
        tx.send(DesktopEvent::Resized { width: 1, height: 1 }).unwrap();
        tx.send(patch(0, 0, 77)).unwrap();
        drop(tx);
        assert!(matches!(rx.recv().await, Some(DesktopEvent::SessionInfo(actual)) if actual == info));
        assert!(matches!(rx.recv().await, Some(DesktopEvent::Resized { .. })));
        assert!(matches!(rx.recv().await, Some(DesktopEvent::Frame(frame)) if frame.rgba_data == vec![77; 4]));
        assert!(rx.recv().await.is_none());
    }

    fn patch(x: u16, y: u16, value: u8) -> DesktopEvent {
        DesktopEvent::Frame(FrameUpdate {
            x,
            y,
            width: 1,
            height: 1,
            rgba_data: vec![value; 4],
        })
    }

    #[tokio::test]
    async fn slow_consumer_preserves_disjoint_updates_and_latest_overlapping_pixels() {
        let (tx, mut rx) = desktop_event_channel();
        tx.send(DesktopEvent::Resized {
            width: 4,
            height: 3,
        })
        .unwrap();
        for i in 0..10_000 {
            tx.send(patch(0, 0, (i % 255) as u8)).unwrap();
        }
        tx.send(patch(3, 2, 77)).unwrap();
        assert_eq!(tx.buffer.lock().unwrap().pixels.len(), 4 * 3 * 4);
        assert!(matches!(
            rx.recv().await,
            Some(DesktopEvent::Resized {
                width: 4,
                height: 3
            })
        ));
        let Some(DesktopEvent::Frame(frame)) = rx.recv().await else {
            panic!("missing frame")
        };
        assert_eq!((frame.x, frame.y, frame.width, frame.height), (0, 0, 4, 3));
        assert_eq!(&frame.rgba_data[..4], &[54; 4]);
        assert_eq!(&frame.rgba_data[44..], &[77; 4]);
        drop(tx);
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn resize_discards_old_pixels_and_precedes_new_frames() {
        let (tx, mut rx) = desktop_event_channel();
        tx.send(DesktopEvent::Resized {
            width: 4,
            height: 3,
        })
        .unwrap();
        tx.send(patch(3, 2, 99)).unwrap();
        tx.send(DesktopEvent::Resized {
            width: 2,
            height: 2,
        })
        .unwrap();
        tx.send(patch(1, 1, 42)).unwrap();
        drop(tx);
        assert!(matches!(
            rx.recv().await,
            Some(DesktopEvent::Resized {
                width: 2,
                height: 2
            })
        ));
        let Some(DesktopEvent::Frame(frame)) = rx.recv().await else {
            panic!("missing frame")
        };
        assert_eq!((frame.x, frame.y, frame.width, frame.height), (1, 1, 1, 1));
        assert_eq!(frame.rgba_data, vec![42; 4]);
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn malformed_rectangles_are_ignored_and_receiver_drop_closes_sender() {
        let (tx, mut rx) = desktop_event_channel();
        tx.send(DesktopEvent::Resized {
            width: 2,
            height: 2,
        })
        .unwrap();
        rx.recv().await.unwrap();
        tx.send(patch(u16::MAX, u16::MAX, 1)).unwrap();
        tx.send(DesktopEvent::Frame(FrameUpdate {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            rgba_data: vec![0; 3],
        }))
        .unwrap();
        assert!(tx.buffer.lock().unwrap().dirty.is_none());
        drop(rx);
        assert!(tx.send(patch(0, 0, 1)).is_err());
    }
}
