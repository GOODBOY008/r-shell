//! A directory is one cancellable queue item. SSH streams a gzip tar archive;
//! FTP negotiates MODE Z for individual data connections. Restricted servers
//! use ordinary file transfers and produce the same directory layout.
mod files;
mod local;
mod ssh_archive;

use anyhow::{bail, ensure, Context, Result};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::{
    io::{Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::{
    connection_manager::ConnectionManager,
    sftp_transfer::{CANCEL_ERROR, PROGRESS_INTERVAL},
};
use files::Remote;
use local::{Destination, Tree};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Method {
    TarGzip,
    FtpZlib,
    Plain,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Packing,
    Transferring,
    Unpacking,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderProgress {
    method: Method,
    phase: Phase,
    transferred: u64,
    total: u64,
    files: usize,
    dirs: usize,
}
impl FolderProgress {
    fn new(method: Method) -> Self {
        Self {
            method,
            phase: Phase::Transferring,
            transferred: 0,
            total: 0,
            files: 0,
            dirs: 0,
        }
    }
    fn with_tree(mut self, tree: &Tree) -> Self {
        self.files = tree.files.len();
        self.dirs = tree.dirs.len();
        self
    }
}

struct Report {
    callback: Box<dyn Fn(FolderProgress) + Send + Sync>,
    last: Mutex<Instant>,
}
impl Report {
    fn send(&self, event: FolderProgress) {
        (self.callback)(event);
    }
    fn tick(&self, mut event: FolderProgress, bytes: u64) {
        let mut last = self.last.lock().expect("folder progress clock");
        if last.elapsed() >= PROGRESS_INTERVAL {
            *last = Instant::now();
            event.transferred = bytes;
            self.send(event);
        }
    }
}

fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), CANCEL_ERROR);
    Ok(())
}

async fn local_tree(root: PathBuf, cancel: CancellationToken) -> Result<Tree> {
    tokio::task::spawn_blocking(move || local::scan(&root, &cancel)).await?
}

async fn archive_transfer(
    session: &ssh_archive::Session,
    upload: bool,
    local: &Path,
    remote: &str,
    destination: Option<&Destination>,
    report: &Report,
    cancel: &CancellationToken,
) -> Result<u64> {
    let mut progress = FolderProgress::new(Method::TarGzip);
    if upload {
        progress.phase = Phase::Packing;
        report.send(progress);
        let root = local.to_owned();
        let token = cancel.clone();
        let (archive, tree) = tokio::task::spawn_blocking(move || {
            let tree = local::scan(&root, &token)?;
            Ok::<_, anyhow::Error>((local::pack(&root, &tree, &token)?, tree))
        })
        .await??;
        progress = progress.with_tree(&tree);
        progress.total = archive.metadata()?.len();
        progress.phase = Phase::Transferring;
        report.send(progress);
        let bytes =
            ssh_archive::transfer(session, true, remote, archive, progress, report, cancel).await?;
        progress.transferred = bytes;
        progress.phase = Phase::Unpacking;
        report.send(progress);
        Ok(bytes)
    } else {
        report.send(progress);
        let mut archive = tempfile::tempfile()?;
        let bytes = ssh_archive::transfer(
            session,
            false,
            remote,
            archive.try_clone()?,
            progress,
            report,
            cancel,
        )
        .await?;
        progress.transferred = bytes;
        progress.total = bytes;
        progress.phase = Phase::Unpacking;
        report.send(progress);
        archive.seek(SeekFrom::Start(0))?;
        let staging = destination
            .context("Missing download destination")?
            .path()
            .to_owned();
        let token = cancel.clone();
        let tree =
            tokio::task::spawn_blocking(move || local::unpack(archive, &staging, &token)).await??;
        report.send(progress.with_tree(&tree));
        Ok(bytes)
    }
}

pub(crate) async fn run(
    manager: &Arc<ConnectionManager>,
    connection_id: &str,
    upload: bool,
    local_path: &Path,
    remote_path: &str,
    directory_name: Option<&str>,
    callback: impl Fn(FolderProgress) + Send + Sync + 'static,
    cancel: CancellationToken,
) -> Result<u64> {
    check_cancel(&cancel)?;
    ensure!(
        !remote_path.is_empty() && !remote_path.contains('\0'),
        "Invalid remote folder path"
    );
    if upload {
        local::component(remote_path.rsplit('/').next().unwrap_or(""))?;
    }
    let destination = if upload {
        None
    } else {
        Some(Destination::new(
            local_path,
            directory_name.context("Missing download directory name")?,
        )?)
    };
    let report = Report {
        callback: Box::new(callback),
        last: Mutex::new(Instant::now() - PROGRESS_INTERVAL),
    };
    let protocol = manager.get_connection_type(connection_id).await;
    let mut remote = if protocol.as_deref() == Some("FTP") {
        let map = manager.get_ftp_connection().await;
        let client = map
            .read()
            .await
            .get(connection_id)
            .cloned()
            .context("FTP connection not found")?;
        let guard = tokio::select! {
            guard = client.lock_owned() => guard,
            _ = cancel.cancelled() => bail!(CANCEL_ERROR),
        };
        Remote::Ftp(guard)
    } else {
        let session = match protocol.as_deref() {
            Some("SFTP") => {
                let map = manager.get_sftp_connection().await;
                let clients = map.read().await;
                clients
                    .get(connection_id)
                    .context("SFTP connection not found")?
                    .transfer_session()?
            }
            None | Some("SSH") => {
                let client = manager
                    .get_connection(connection_id)
                    .await
                    .context("SSH connection not found")?;
                let guard = client.read().await;
                guard.transfer_session()?
            }
            Some(other) => bail!("Unsupported folder transfer protocol: {other}"),
        };
        if ssh_archive::available(&session, upload, &cancel).await? {
            let n = archive_transfer(
                &session,
                upload,
                local_path,
                remote_path,
                destination.as_ref(),
                &report,
                &cancel,
            )
            .await?;
            if let Some(dest) = destination {
                tokio::task::spawn_blocking(move || dest.publish(&cancel)).await??;
            }
            return Ok(n);
        }
        let sftp = tokio::select! {
            sftp = async {
                let channel = session.channel_open_session().await?;
                channel.request_subsystem(true, "sftp").await?;
                Ok::<_, anyhow::Error>(SftpSession::new(channel.into_stream()).await?)
            } => sftp?,
            _ = cancel.cancelled() => bail!(CANCEL_ERROR),
        };
        Remote::Sftp(session, sftp)
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow::anyhow!(CANCEL_ERROR)),
        result = async {
            let tree = if upload {
                local_tree(local_path.to_owned(), cancel.clone()).await?
            } else {
                remote.scan(remote_path, &cancel).await?
            };
            let root = destination.as_ref().map_or(local_path, Destination::path);
            remote.transfer(upload, root, remote_path, &tree, &report, &cancel).await
        } => result,
    };
    if cancel.is_cancelled() {
        if let Remote::Ftp(client) = &mut remote {
            // A cancelled LIST, PASV, RETR or STOR can leave an unread reply.
            // The next operation opens a fresh authenticated stream in MODE S.
            client.discard_interrupted_transport();
        }
        bail!(CANCEL_ERROR);
    }
    let n = result?;
    if let Some(dest) = destination {
        tokio::task::spawn_blocking(move || dest.publish(&cancel)).await??;
    }
    Ok(n)
}
