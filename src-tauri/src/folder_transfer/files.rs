use anyhow::{anyhow, bail, ensure, Result};
use russh_sftp::client::SftpSession;
use std::collections::HashSet;
use std::path::Path;
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

use super::{
    check_cancel,
    local::{component, Tree},
    ssh_archive::Session,
    FolderProgress, Method, Report,
};
use crate::{
    ftp_client::FtpClient,
    sftp_client::{list_sftp_dir, FileEntry, FileEntryType},
    sftp_transfer,
};

pub(super) enum Remote {
    Ftp(OwnedMutexGuard<FtpClient>),
    Sftp(Session, SftpSession),
}

fn remote_join(root: &str, relative: &str) -> String {
    format!("{}/{relative}", root.trim_end_matches('/'))
}

impl Remote {
    async fn list(&mut self, path: &str) -> Result<Vec<FileEntry>> {
        match self {
            Self::Ftp(client) => client.folder_entries(path).await,
            Self::Sftp(_, sftp) => list_sftp_dir(sftp, path).await,
        }
    }

    pub async fn scan(&mut self, root: &str, cancel: &CancellationToken) -> Result<Tree> {
        let mut tree = Tree::default();
        let mut pending = vec![(root.to_owned(), String::new())];
        while let Some((path, relative)) = pending.pop() {
            for entry in self.list(&path).await? {
                check_cancel(cancel)?;
                component(&entry.name)?;
                let name = if relative.is_empty() {
                    entry.name
                } else {
                    remote_join(&relative, &entry.name)
                };
                match entry.file_type {
                    FileEntryType::Directory => {
                        pending.push((remote_join(root, &name), name.clone()));
                        tree.dirs.push(name);
                    }
                    FileEntryType::File => tree.files.push((name, entry.size)),
                    FileEntryType::Symlink => {
                        bail!("Symbolic links cannot be transferred as folder contents: {name}")
                    }
                }
            }
        }
        Ok(tree)
    }

    async fn prepare_upload_dir(
        &mut self,
        root: &str,
        relative: &str,
        files: &HashSet<&str>,
    ) -> Result<()> {
        let path = if relative.is_empty() {
            root.to_owned()
        } else {
            remote_join(root, relative)
        };
        let result = match self {
            Self::Ftp(client) => client.create_dir(&path).await,
            Self::Sftp(_, sftp) => sftp
                .create_dir(path.as_str())
                .await
                .map_err(anyhow::Error::from),
        };
        if let Err(error) = result {
            let (parent, name) = path.rsplit_once('/').unwrap_or((".", &path));
            let entries = self
                .list(if parent.is_empty() { "/" } else { parent })
                .await?;
            if !entries
                .iter()
                .any(|e| e.name == name && e.file_type == FileEntryType::Directory)
            {
                return Err(error);
            }
            for entry in self.list(&path).await? {
                let name = if relative.is_empty() {
                    entry.name
                } else {
                    remote_join(relative, &entry.name)
                };
                ensure!(
                    !files.contains(name.as_str()) || entry.file_type == FileEntryType::File,
                    "Destination has a different file type: {name}"
                );
            }
        }
        Ok(())
    }

    async fn copy_file(
        &mut self,
        upload: bool,
        mode_z: bool,
        remote: &str,
        local: &Path,
        progress: &(dyn Fn(u64, u64) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<u64> {
        if let Self::Ftp(client) = self {
            if mode_z {
                return client
                    .transfer_zlib_file(upload, remote, local, &|n| progress(n, 0))
                    .await;
            }
        }
        let local = local
            .to_str()
            .ok_or_else(|| anyhow!("Invalid local filename"))?;
        match self {
            Self::Ftp(client) if upload => {
                client
                    .upload_file_with_progress(local, remote, Some(progress), cancel)
                    .await
            }
            Self::Ftp(client) => {
                client
                    .download_file_with_progress(remote, local, Some(progress), cancel)
                    .await
            }
            Self::Sftp(handle, _) if upload => {
                sftp_transfer::upload_file(
                    std::slice::from_ref(handle),
                    local,
                    remote,
                    Some(progress),
                    cancel,
                )
                .await
            }
            Self::Sftp(handle, _) => {
                sftp_transfer::download_file(
                    std::slice::from_ref(handle),
                    remote,
                    local,
                    Some(progress),
                    cancel,
                )
                .await
            }
        }
    }

    pub async fn transfer(
        &mut self,
        upload: bool,
        local: &Path,
        remote: &str,
        tree: &Tree,
        report: &Report,
        cancel: &CancellationToken,
    ) -> Result<u64> {
        let make_dirs = async {
            if upload {
                let files = tree.files.iter().map(|(name, _)| name.as_str()).collect();
                for dir in std::iter::once("").chain(tree.dirs.iter().map(String::as_str)) {
                    check_cancel(cancel)?;
                    self.prepare_upload_dir(remote, dir, &files).await?;
                }
            } else {
                for name in &tree.dirs {
                    check_cancel(cancel)?;
                    tokio::fs::create_dir_all(local.join(name)).await?;
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::select! {
            result = make_dirs => result?,
            _ = cancel.cancelled() => bail!(sftp_transfer::CANCEL_ERROR),
        }
        // Listings and directory preparation complete in stream mode. Only file
        // data passes through zlib, and the mutex prevents unrelated LIST/RETRs.
        let mut mode_z = if let Self::Ftp(client) = self {
            client.enable_mode_z().await?
        } else {
            false
        };
        let mut state = FolderProgress::new(if mode_z {
            Method::FtpZlib
        } else {
            Method::Plain
        })
        .with_tree(tree);
        state.total = tree.bytes();
        report.send(state);
        let result = async {
            let mut completed = 0;
            for (name, _) in &tree.files {
                let local_file = local.join(name);
                let remote_file = remote_join(remote, name);
                loop {
                    check_cancel(cancel)?;
                    let progress = |bytes, _| report.tick(state, completed + bytes);
                    let result = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => bail!(sftp_transfer::CANCEL_ERROR),
                        result = self.copy_file(upload, mode_z, &remote_file, &local_file, &progress, cancel) => result,
                    };
                    match result {
                        Ok(bytes) => { completed += bytes; break; }
                        Err(error) if mode_z && FtpClient::rejected_compressed_transfer(&error) => {
                            // Some servers accept MODE Z but reject a compressed data
                            // transfer. Retry only this file from the start in MODE S.
                            if let Self::Ftp(client) = self {
                                client.restore_stream_mode().await?;
                            }
                            mode_z = false;
                            state.method = Method::Plain;
                            state.transferred = completed;
                            report.send(state);
                        }
                        Err(error) => return Err(anyhow!("{name}: {error:#}")),
                    }
                }
            }
            Ok::<_, anyhow::Error>(completed)
        }.await;
        if let Self::Ftp(client) = self {
            if mode_z {
                client.restore_stream_mode().await?;
            }
        }
        let bytes = result?;
        // Some FTP LIST implementations cannot report a reliable file size.
        state.total = bytes;
        state.transferred = bytes;
        report.send(state);
        Ok(bytes)
    }
}
