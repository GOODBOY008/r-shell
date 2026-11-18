use std::fs::{self, File};
use std::io::{self, Read, Seek};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, ensure, Context, Result};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::check_cancel;

#[derive(Default)]
pub(super) struct Tree {
    pub dirs: Vec<String>,
    pub files: Vec<(String, u64)>,
}

impl Tree {
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|(_, size)| size).sum()
    }
}

// Validate components separately before joining archive, FTP or SFTP names
// to any OS path. Backslashes and drive prefixes have meaning on Windows.
pub(super) fn component(name: &str) -> Result<&str> {
    ensure!(!name.contains('/'), "Expected a single filename: {name}");
    crate::commands::validate_remote_relative_path(name).map_err(anyhow::Error::msg)?;
    #[cfg(windows)]
    {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        ensure!(
            !device
                && !name.ends_with(['.', ' '])
                && !name.contains([':', '<', '>', '"', '|', '?', '*'])
                && !name.chars().any(char::is_control),
            "Unsupported Windows filename: {name}"
        );
    }
    Ok(name)
}

fn no_link(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "Unsupported reparse point: {}",
            path.display()
        );
    }
    ensure!(
        !metadata.is_symlink(),
        "Symbolic links cannot be transferred as folder contents: {}",
        path.display()
    );
    Ok(metadata)
}

pub(super) fn scan(root: &Path, cancel: &CancellationToken) -> Result<Tree> {
    ensure!(
        no_link(root)?.is_dir(),
        "Expected a folder: {}",
        root.display()
    );
    let mut tree = Tree::default();
    let mut pending = vec![String::new()];
    while let Some(dir) = pending.pop() {
        for child in fs::read_dir(root.join(&dir))? {
            check_cancel(cancel)?;
            let child = child?;
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("Filename is not valid UTF-8"))?;
            component(&name)?;
            let relative = if dir.is_empty() {
                name
            } else {
                format!("{dir}/{name}")
            };
            let metadata = no_link(&child.path())?;
            if metadata.is_dir() {
                tree.dirs.push(relative.clone());
                pending.push(relative);
            } else if metadata.is_file() {
                tree.files.push((relative, metadata.len()));
            } else {
                bail!("Unsupported file type: {}", child.path().display());
            }
        }
    }
    Ok(tree)
}

struct CancellableReader<'a, R>(R, &'a CancellationToken);
impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.1.is_cancelled() {
            return Err(io::Error::other(crate::sftp_transfer::CANCEL_ERROR));
        }
        self.0.read(buf)
    }
}

pub(super) fn pack(root: &Path, tree: &Tree, cancel: &CancellationToken) -> Result<File> {
    let encoder = GzEncoder::new(tempfile::tempfile()?, Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    for dir in &tree.dirs {
        check_cancel(cancel)?;
        let metadata = no_link(&root.join(dir))?;
        ensure!(metadata.is_dir(), "Source changed: {dir}");
        archive.append_data(&mut transfer_header(&metadata)?, dir, io::empty())?;
    }
    for (name, _) in &tree.files {
        check_cancel(cancel)?;
        let path = root.join(name);
        ensure!(no_link(&path)?.is_file(), "Source changed: {name}");
        let file = File::open(&path)?;
        let metadata = file.metadata()?;
        archive.append_data(
            &mut transfer_header(&metadata)?,
            name,
            CancellableReader(file.take(metadata.len()), cancel),
        )?;
    }
    let mut file = archive.into_inner()?.finish()?;
    file.rewind()?;
    Ok(file)
}

fn transfer_header(metadata: &fs::Metadata) -> Result<tar::Header> {
    let mut header = tar::Header::new_gnu();
    header.set_metadata(metadata);
    header.set_mode(header.mode()? & 0o777);
    header.set_uid(0);
    header.set_gid(0);
    Ok(header)
}

pub(super) fn unpack(file: File, staging: &Path, cancel: &CancellationToken) -> Result<Tree> {
    let decoder = GzDecoder::new(CancellableReader(file, cancel));
    let mut archive = tar::Archive::new(decoder);
    let mut tree = Tree::default();
    for entry in archive.entries()? {
        check_cancel(cancel)?;
        let mut entry = entry?;
        let path = entry.path()?;
        let raw = path.to_str().context("Archive filename is not UTF-8")?;
        let name = raw.strip_prefix("./").unwrap_or(raw).trim_end_matches('/');
        let kind = entry.header().entry_type();
        if raw == "." || raw == "./" {
            ensure!(kind.is_dir(), "Invalid archive root");
            continue;
        }
        ensure!(!name.is_empty(), "Empty archive path");
        for part in name.split('/') {
            component(part)?;
        }
        let name = name.to_owned();
        let target = staging.join(&name);
        if kind.is_dir() {
            fs::create_dir_all(target)?;
            tree.dirs.push(name);
        } else if kind.is_file() {
            fs::create_dir_all(target.parent().context("Missing parent")?)?;
            let mut output = File::create_new(&target)?;
            let expected = entry.size();
            let bytes = io::copy(&mut CancellableReader(&mut entry, cancel), &mut output)?;
            ensure!(bytes == expected, "Incomplete archive entry: {name}");
            tree.files.push((name, bytes));
        } else {
            bail!("Unsupported archive entry (link or special file): {name}");
        }
    }
    // tar stops at the end marker. Read through the gzip trailer to verify its CRC.
    io::copy(&mut archive.into_inner(), &mut io::sink())?;
    Ok(tree)
}

pub(super) struct Destination {
    stage: TempDir,
    pub target: PathBuf,
}
impl Destination {
    pub fn new(parent: &Path, name: &str) -> Result<Self> {
        ensure!(
            parent.is_absolute(),
            "The download destination must be absolute"
        );
        let target = parent.join(component(name)?);
        let stage = tempfile::Builder::new()
            .prefix(".r-shell-transfer-")
            .tempdir_in(parent)?;
        Ok(Self { stage, target })
    }

    pub fn path(&self) -> &Path {
        self.stage.path()
    }

    pub fn publish(self, cancel: &CancellationToken) -> Result<()> {
        // Check the complete merge before replacing any file. A pre-existing
        // link (including a dangling one) never becomes a destination ancestor.
        merge(self.path(), &self.target, true, cancel)?;
        merge(self.path(), &self.target, false, cancel)
    }
}

fn merge(src: &Path, dest: &Path, preflight: bool, cancel: &CancellationToken) -> Result<()> {
    check_cancel(cancel)?;
    let existing = match fs::symlink_metadata(dest) {
        Ok(_) => no_link(dest)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if !preflight {
                fs::rename(src, dest)?;
            }
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    let from = no_link(src)?;
    if from.is_dir() && existing.is_dir() {
        for child in fs::read_dir(src)? {
            let child = child?;
            merge(
                &child.path(),
                &dest.join(child.file_name()),
                preflight,
                cancel,
            )?;
        }
    } else if from.is_file() && existing.is_file() {
        if !preflight {
            fs::rename(src, dest)?;
        }
    } else {
        bail!("Destination has a different file type: {}", dest.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn gzip_round_trip_preserves_contents_and_merges_empty_directories() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let source = parent.path().join("发布 '!");
        fs::create_dir_all(source.join("sub/empty"))?;
        fs::write(source.join("sub/.file with spaces"), vec![b'a'; 500_000])?;
        fs::write(source.join("zero"), [])?;
        let cancel = CancellationToken::new();
        let tree = scan(&source, &cancel)?;
        let archive = pack(&source, &tree, &cancel)?;
        assert!(archive.metadata()?.len() < 10_000);
        let dest = Destination::new(parent.path(), "target")?;
        fs::create_dir(&dest.target)?;
        fs::write(dest.target.join("keep"), "other")?;
        fs::write(dest.target.join("zero"), "old")?;
        let restored = unpack(archive, dest.path(), &cancel)?;
        assert_eq!((restored.files.len(), restored.dirs.len()), (2, 2));
        let target = dest.target.clone();
        dest.publish(&cancel)?;
        assert!(target.join("sub/empty").is_dir());
        assert_eq!(
            fs::read(target.join("sub/.file with spaces"))?,
            vec![b'a'; 500_000]
        );
        assert_eq!(fs::read(target.join("keep"))?, b"other");
        assert!(fs::read(target.join("zero"))?.is_empty());
        Ok(())
    }

    #[test]
    fn cancelled_or_corrupt_archives_are_not_published() -> Result<()> {
        let parent = tempfile::tempdir()?;
        fs::write(parent.path().join("file"), "content")?;
        let cancel = CancellationToken::new();
        let tree = scan(parent.path(), &cancel)?;
        let archive = pack(parent.path(), &tree, &cancel)?;
        archive.set_len(archive.metadata()?.len() - 5)?;
        let dest = Destination::new(parent.path(), "target")?;
        assert!(unpack(archive, dest.path(), &cancel).is_err());
        cancel.cancel();
        assert!(pack(parent.path(), &tree, &cancel).is_err());
        assert!(dest.publish(&cancel).is_err());
        assert!(!parent.path().join("target").exists());
        Ok(())
    }

    #[test]
    fn remote_names_must_be_single_portable_components() -> Result<()> {
        let parent = tempfile::tempdir()?;
        for name in ["", ".", "..", "/root", "a/b", "a\\b", "C:drive", "a\0b"] {
            assert!(Destination::new(parent.path(), name).is_err(), "{name:?}");
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_destination_link_never_receives_downloaded_bytes() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let dest = Destination::new(parent.path(), "target")?;
        fs::create_dir(&dest.target)?;
        fs::create_dir(dest.path().join("sub"))?;
        fs::write(dest.path().join("sub/new"), "download")?;
        let other = tempfile::tempdir()?;
        std::os::unix::fs::symlink(other.path(), dest.target.join("sub"))?;
        assert!(dest.publish(&CancellationToken::new()).is_err());
        assert!(!other.path().join("new").exists());
        Ok(())
    }

    #[test]
    fn links_in_server_archives_are_rejected_in_private_staging() -> Result<()> {
        let mut archive =
            tar::Builder::new(GzEncoder::new(tempfile::tempfile()?, Compression::fast()));
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        archive.append_link(&mut header, "shortcut", "nested/file")?;
        let mut file = archive.into_inner()?.finish()?;
        file.flush()?;
        file.rewind()?;
        let staging = tempfile::tempdir()?;
        assert!(unpack(file, staging.path(), &CancellationToken::new()).is_err());
        assert!(staging.path().read_dir()?.next().is_none());
        Ok(())
    }
}
