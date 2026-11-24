//! Attach local shells to the authenticated terminal WebSocket.
use super::{
    encode_output_frame, LocalAttachment, LocalShells, OutputControls, OutputCredits, WsError,
    WsMessage, WsTx,
};
use crate::local_pty::LocalPtyEvent;
use crate::local_shell::LocalEvents;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

pub(super) async fn attach(
    manager: &Arc<LocalShells>,
    connection_id: String,
    cols: u16,
    rows: u16,
    local_attachments: &mut HashMap<String, LocalAttachment>,
    output_controls: OutputControls,
    tx: WsTx,
) -> Result<(), WsError> {
    if cols == 0 || rows == 0 {
        return Err(WsError::new("Invalid terminal dimensions"));
    }
    let attachment = manager
        .attach(&connection_id)
        .map_err(|e| WsError::coded("local_pty_unavailable", e.to_string()))?;
    let generation = attachment.generation;
    let attachment = local_attachments
        .entry(connection_id.clone())
        .insert_entry(attachment)
        .into_mut();
    if attachment.pty.is_running() {
        let resized = tokio::select! {
            biased;
            _ = attachment.cancel.cancelled() => return Ok(()),
            result = attachment.pty.resize(cols, rows) => result,
        };
        if let Err(e) = resized {
            // A short-lived shell can exit before the first attach.
            // Its final output and exit code are still readable.
            if attachment.pty.is_running() {
                return Err(e.into());
            }
        }
    }
    let credits = Arc::new(Semaphore::new(0));
    output_controls
        .lock()
        .await
        .insert(connection_id.clone(), credits.clone());
    let started = WsMessage::PtyStarted {
        connection_id: connection_id.clone(),
        generation,
        reattached: generation > 1,
    };
    tx.send(Message::Text(
        serde_json::to_string(&started)
            .map_err(anyhow::Error::from)?
            .into(),
    ))
    .await
    .map_err(|_| WsError::new("WebSocket closed"))?;
    tokio::spawn(forward_local_output(
        connection_id,
        attachment.events.clone(),
        attachment.cancel.clone(),
        credits,
        tx,
    ));
    Ok(())
}

/// A blocked stdin must leave the WebSocket dispatcher free to receive
/// output credits. The client sends its next chunk only once this one has
/// reached the native writer. Limit outstanding work even for a buggy client.
pub(super) fn write(
    attachment: &LocalAttachment,
    id: &str,
    data: Vec<u8>,
    tx: &WsTx,
) -> anyhow::Result<()> {
    if attachment.cancel.is_cancelled() {
        return Ok(());
    }
    anyhow::ensure!(
        data.len() <= super::OUTPUT_FLUSH_BYTES,
        "Local shell input frame is too large"
    );
    let credit = attachment
        .input_credit
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow::anyhow!("Local shell input is waiting for acknowledgement"))?;
    let pty = attachment.pty.clone();
    let cancel = attachment.cancel.clone();
    let generation = attachment.generation;
    let id = id.to_owned();
    let tx = tx.clone();
    tokio::spawn(async move {
        let written = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            result = pty.write(data) => result,
        };
        let response = match written {
            Ok(()) => WsMessage::LocalPtyInputAck {
                connection_id: id,
                generation,
            },
            // On normal exit the terminal event is authoritative and follows the last output.
            Err(_) if !pty.is_running() => return,
            Err(e) => WsMessage::Error {
                code: Some("local_pty_input_failed".into()),
                message: e.to_string(),
            },
        };
        // Publish the next credit before the ACK is visible to the client.
        drop(credit);
        let frame = Message::Text(
            serde_json::to_string(&response)
                .expect("serialize local input result")
                .into(),
        );
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {},
            _ = tx.send(frame) => {},
        }
    });
    Ok(())
}

pub(super) async fn resize(
    attachment: &LocalAttachment,
    cols: u32,
    rows: u32,
) -> Result<(), WsError> {
    let (cols, rows) = (
        u16::try_from(cols).ok().filter(|&n| n > 0),
        u16::try_from(rows).ok().filter(|&n| n > 0),
    );
    let (Some(cols), Some(rows)) = (cols, rows) else {
        return Err(WsError::new("Invalid terminal dimensions"));
    };
    tokio::select! {
        biased;
        _ = attachment.cancel.cancelled() => {},
        result = attachment.pty.resize(cols, rows) => result?,
    }
    Ok(())
}

/// Stream the local PTY with the same one-frame/one-credit protocol as SSH.
/// Reserve the socket slot before consuming a pending event, so replacing a
/// socket while it is blocked on credit leaves the data for its successor.
async fn forward_local_output(
    id: String,
    events: Arc<Mutex<LocalEvents>>,
    cancel: CancellationToken,
    credits: OutputCredits,
    tx: WsTx,
) {
    let mut events = tokio::select! {
        biased;
        _ = cancel.cancelled() => return,
        events = events.lock() => events,
    };
    loop {
        if events.pending.is_none() {
            let event = tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                event = events.receiver.recv() => event,
            };
            let Some(event) = event else { return };
            events.pending = Some(event);
        }
        let event = events.pending.as_ref().unwrap();
        let is_output = matches!(event, LocalPtyEvent::Output(_));
        if is_output {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                credit = credits.acquire() => match credit {
                    Ok(credit) => credit.forget(),
                    Err(_) => return,
                },
            }
        }
        let slot = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            slot = tx.reserve() => match slot { Ok(slot) => slot, Err(_) => return },
        };
        match event {
            LocalPtyEvent::Output(data) => {
                slot.send(Message::Binary(encode_output_frame(&id, data).into()));
            }
            LocalPtyEvent::Error(error) => {
                let error = WsMessage::Error {
                    message: error.clone(),
                    code: Some("local_pty_io".into()),
                };
                slot.send(Message::Text(
                    serde_json::to_string(&error)
                        .expect("serialize PTY error")
                        .into(),
                ));
            }
            LocalPtyEvent::Exited(code) => {
                let exited = WsMessage::LocalPtyExited {
                    connection_id: id.clone(),
                    exit_code: *code,
                };
                slot.send(Message::Text(
                    serde_json::to_string(&exited)
                        .expect("serialize PTY exit")
                        .into(),
                ));
                // Retain terminal status for an attach racing the final socket write.
                return;
            }
        }
        events.pending.take();
    }
}

#[cfg(test)]
mod tests;
