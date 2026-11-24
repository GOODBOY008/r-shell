use super::{next_input, send_event, Input, LocalPtyEvent, OUTPUT_CHUNK};
use anyhow::{Context, Result};
use portable_pty::MasterPty;
use std::{
    fs::File,
    io::{self, Read, Write},
    os::fd::{AsRawFd, BorrowedFd},
    sync::Arc,
};
use tokio::{io::unix::AsyncFd, sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

pub(super) struct PtyIo(Arc<AsyncFd<File>>);

impl PtyIo {
    pub(super) fn open(master: &dyn MasterPty) -> Result<Self> {
        let fd = master
            .as_raw_fd()
            .context("Local PTY has no master descriptor")?;
        // The master owns fd throughout this function. Duplicate it for the async I/O tasks.
        let file = File::from(unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?);
        let fd = file.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error().into());
        }
        // File owns a stable descriptor until AsyncFd drops it.
        let pty = unsafe { AsyncFd::register(file) }?;
        Ok(Self(Arc::new(pty)))
    }

    pub(super) fn run(
        self,
        mut inputs: mpsc::Receiver<Input>,
        events: mpsc::Sender<LocalPtyEvent>,
        closing: CancellationToken,
        exited: CancellationToken,
    ) -> (JoinHandle<Result<()>>, JoinHandle<()>) {
        let input = self.0.clone();
        let stop_writing = closing.clone();
        let shell_exited = exited.clone();
        let writer = tokio::spawn(async move {
            while let Some((bytes, ack)) =
                next_input(&mut inputs, &stop_writing, &shell_exited).await
            {
                let result = tokio::select! {
                    _ = stop_writing.cancelled() => break,
                    _ = shell_exited.cancelled() => break,
                    result = write_all(&input, &bytes) => result,
                };
                let failed = result.is_err();
                let _ = ack.send(result.map_err(Into::into));
                if failed {
                    break;
                }
            }
        });

        let reader = tokio::spawn(async move {
            let mut buffer = vec![0; OUTPUT_CHUNK];
            loop {
                let read = if exited.is_cancelled() {
                    // A background process could still have the slave open. Once the
                    // shell exits, deliver its queued bytes without waiting for more.
                    let read = self.0.get_ref().read(&mut buffer);
                    if matches!(&read, Err(error) if error.kind() == io::ErrorKind::WouldBlock) {
                        break;
                    }
                    read
                } else {
                    tokio::select! {
                        biased;
                        _ = closing.cancelled() => break,
                        _ = exited.cancelled() => continue,
                        read = self.0.async_io(tokio::io::Interest::READABLE, |mut f| f.read(&mut buffer)) => read,
                    }
                };
                match read {
                    Ok(0) => break,
                    Ok(length) => {
                        if !send_event(
                            &events,
                            LocalPtyEvent::Output(buffer[..length].to_vec()),
                            &closing,
                        )
                        .await
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    // Linux indicates that the slave was closed with EIO.
                    Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(())
        });
        (reader, writer)
    }
}

async fn write_all(pty: &AsyncFd<File>, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        match pty
            .async_io(tokio::io::Interest::WRITABLE, |mut f| f.write(bytes))
            .await
        {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(length) => bytes = &bytes[length..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
