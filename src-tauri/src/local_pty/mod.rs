//! One native PTY per local terminal tab. The transport owns attachment and replay.
use anyhow::{anyhow, ensure, Context, Result};
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use std::{path::Path, sync::mpsc as control_channel, time::Duration};
use tokio::{
    sync::{mpsc, oneshot},
    task,
};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
#[path = "unix.rs"]
mod io;
#[cfg(windows)]
#[path = "windows.rs"]
mod io;
mod shell;

const OUTPUT_CHUNK: usize = 16 * 1024;
const OUTPUT_QUEUE: usize = 16;

pub enum LocalPtyEvent {
    Output(Vec<u8>),
    Error(String),
    Exited(Option<u32>),
}

type Input = (Vec<u8>, oneshot::Sender<Result<()>>);

enum Control {
    Resize(PtySize, oneshot::Sender<Result<()>>),
    Close,
    ReaderFailed,
}

pub struct LocalPty {
    shell_name: String,
    input: mpsc::Sender<Input>,
    control: control_channel::Sender<Control>,
    closing: CancellationToken,
    exited: CancellationToken,
    finished: CancellationToken,
}

impl LocalPty {
    pub async fn spawn(
        cols: u16,
        rows: u16,
        shell_path: Option<String>,
    ) -> Result<(Self, mpsc::Receiver<LocalPtyEvent>)> {
        let size = dimensions(cols, rows)?;
        task::spawn_blocking(move || Self::start(size, shell_path.as_deref().map(Path::new)))
            .await?
    }

    fn start(
        size: PtySize,
        shell_path: Option<&Path>,
    ) -> Result<(Self, mpsc::Receiver<LocalPtyEvent>)> {
        let (command, shell_name) = shell::command(shell_path)?;
        let pair = native_pty_system()
            .openpty(size)
            .context("Could not create local terminal")?;
        // Acquire all fallible resources before starting the child.
        let io = io::PtyIo::open(&*pair.master)?;
        let child = pair
            .slave
            .spawn_command(command)
            .context("Could not start local shell")?;
        drop(pair.slave);

        let (output, events) = mpsc::channel(OUTPUT_QUEUE);
        let (input, inputs) = mpsc::channel(8);
        let (control, controls) = control_channel::channel();
        let closing = CancellationToken::new();
        let exited = CancellationToken::new();
        let finished = CancellationToken::new();
        let handle = Self {
            shell_name,
            input,
            control,
            closing: closing.clone(),
            exited: exited.clone(),
            finished: finished.clone(),
        };
        let (reader, writer) = io.run(inputs, output.clone(), closing.clone(), exited.clone());
        let on_read_error = handle.control.clone();
        let supervisor_closing = closing.clone();
        let supervisor = task::spawn_blocking(move || {
            supervise(pair.master, child, controls, &supervisor_closing, &exited)
        });
        tokio::spawn(async move {
            // A final PTY frame may still be in the kernel when the child exits.
            let read_result = reader.await.map_err(anyhow::Error::from).and_then(|r| r);
            if read_result.is_err() {
                let _ = on_read_error.send(Control::ReaderFailed);
            }
            let (status, _) = tokio::join!(supervisor, writer);
            finished.cancel();
            let status = status.map_err(anyhow::Error::from).and_then(|s| s);
            if let Some(error) = read_result.as_ref().err().or_else(|| status.as_ref().err()) {
                send_event(&output, LocalPtyEvent::Error(error.to_string()), &closing).await;
            }
            send_event(&output, LocalPtyEvent::Exited(status.ok()), &closing).await;
        });
        Ok((handle, events))
    }

    pub fn shell_name(&self) -> &str {
        &self.shell_name
    }

    pub fn is_running(&self) -> bool {
        !self.closing.is_cancelled() && !self.exited.is_cancelled()
    }

    /// Resolve only after the OS has accepted the entire chunk. The transport uses
    /// this completion to grant input credit independently of the output stream.
    pub async fn write(&self, data: Vec<u8>) -> Result<()> {
        ensure!(self.is_running(), "Local shell has exited");
        let (ack, completed) = oneshot::channel();
        self.input
            .send((data, ack))
            .await
            .map_err(|_| anyhow!("Local shell has exited"))?;
        completed.await.context("Local shell has exited")?
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let size = dimensions(cols, rows)?;
        let (reply, result) = oneshot::channel();
        self.control
            .send(Control::Resize(size, reply))
            .map_err(|_| anyhow!("Local shell has exited"))?;
        result.await.context("Local shell has exited")?
    }

    pub async fn close(&self) {
        self.request_close();
        self.finished.cancelled().await;
    }

    fn request_close(&self) {
        self.closing.cancel();
        let _ = self.control.send(Control::Close);
    }
}

impl Drop for LocalPty {
    fn drop(&mut self) {
        self.request_close();
    }
}

fn dimensions(cols: u16, rows: u16) -> Result<PtySize> {
    // ConPTY uses signed 16-bit coordinates.
    ensure!(
        (1..=i16::MAX as u16).contains(&cols) && (1..=i16::MAX as u16).contains(&rows),
        "Invalid local terminal dimensions"
    );
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

async fn send_event(
    events: &mpsc::Sender<LocalPtyEvent>,
    event: LocalPtyEvent,
    closing: &CancellationToken,
) -> bool {
    tokio::select! {
        biased;
        _ = closing.cancelled() => false,
        result = events.send(event) => {
            if result.is_err() { closing.cancel(); }
            result.is_ok()
        }
    }
}

async fn next_input(
    inputs: &mut mpsc::Receiver<Input>,
    closing: &CancellationToken,
    exited: &CancellationToken,
) -> Option<Input> {
    tokio::select! {
        biased;
        _ = closing.cancelled() => None,
        _ = exited.cancelled() => None,
        input = inputs.recv() => input,
    }
}

fn supervise(
    master: Box<dyn MasterPty + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    controls: control_channel::Receiver<Control>,
    closing: &CancellationToken,
    exited: &CancellationToken,
) -> Result<u32> {
    let mut reader_failed = false;
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.exit_code()),
            Ok(None) => {}
            Err(error) => {
                exited.cancel();
                drop(master);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
        }
        if closing.is_cancelled() || reader_failed {
            #[cfg(unix)]
            if let Some(group) = master.process_group_leader() {
                // Job-control shells give the foreground pipeline its own process group.
                // This group is reported by our PTY, which is private to this tab.
                if group > 1 && group != unsafe { libc::getpgrp() } {
                    unsafe {
                        libc::kill(-group, libc::SIGKILL);
                    }
                }
            }
            // On Darwin the shell can be exiting inside ttywait() with a full
            // output buffer. Close the master before waiting, or both sides wait
            // for a reader that was already cancelled. ConPTY drains independently.
            exited.cancel();
            drop(master);
            let _ = child.kill();
            return child.wait().map(|s| s.exit_code()).map_err(Into::into);
        }
        match controls.recv_timeout(Duration::from_millis(75)) {
            Ok(Control::Resize(size, reply)) => {
                let _ = reply.send(master.resize(size));
            }
            Ok(Control::Close) | Err(control_channel::RecvTimeoutError::Disconnected) => {
                closing.cancel()
            }
            Ok(Control::ReaderFailed) => reader_failed = true,
            Err(control_channel::RecvTimeoutError::Timeout) => {}
        }
    };
    exited.cancel();
    // Closing ConPTY can flush output and block on older Windows builds; the reader is
    // independent and continues draining the pipe while this blocking worker drops it.
    drop(master);
    result
}

#[cfg(test)]
pub(crate) mod tests;
