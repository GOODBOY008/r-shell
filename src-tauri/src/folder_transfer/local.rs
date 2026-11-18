use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Seek};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
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

fn no_link(path: &Path) -> io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unsupported reparse point: {}", path.display()),
            ));
        }
    }
    if metadata.is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Symbolic links cannot be transferred as folder contents: {}",
                path.display()
            ),
        ));
    }
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

// The upload archive has a private envelope. User files live under tree/.
// An optional modes/ record contains a symbolic chmod operand, one space,
// and the exact UTF-8 directory path (including any trailing newlines).
pub(super) fn pack(root: &Path, tree: &Tree, cancel: &CancellationToken) -> Result<File> {
    let encoder = GzEncoder::new(tempfile::tempfile()?, Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    let contents = Path::new("tree");
    let mut restore_modes = Vec::new();
    for dir in &tree.dirs {
        check_cancel(cancel)?;
        let metadata = no_link(&root.join(dir))?;
        ensure!(metadata.is_dir(), "Source changed: {dir}");
        let mut header = transfer_header(&metadata)?;
        let mode = header.mode()?;
        if mode & 0o700 != 0o700 {
            // BusyBox applies the directory mode before extracting children.
            // Restore only the owner bits added here so the remote umask still applies.
            header.set_mode(mode | 0o700);
            let remove: String = [(0o400, 'r'), (0o200, 'w'), (0o100, 'x')]
                .into_iter()
                .filter_map(|(bit, letter)| (mode & bit == 0).then_some(letter))
                .collect();
            restore_modes.push(format!("u-{remove} {dir}"));
        }
        archive.append_data(&mut header, contents.join(dir), io::empty())?;
    }
    for (name, _) in &tree.files {
        check_cancel(cancel)?;
        let path = root.join(name);
        ensure!(no_link(&path)?.is_file(), "Source changed: {name}");
        let file = File::open(&path)?;
        let metadata = file.metadata()?;
        archive.append_data(
            &mut transfer_header(&metadata)?,
            contents.join(name),
            CancellableReader(file.take(metadata.len()), cancel),
        )?;
    }
    // scan() visits parents before descendants. Restore children first so a
    // restricted parent cannot prevent updates to its descendants.
    for (index, record) in restore_modes.iter().rev().enumerate() {
        check_cancel(cancel)?;
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_size(record.len() as u64);
        archive.append_data(&mut header, format!("modes/{index}"), record.as_bytes())?;
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

fn archive_name(raw: &str) -> Result<&str> {
    let name = raw.strip_prefix("./").unwrap_or(raw).trim_end_matches('/');
    ensure!(!name.is_empty(), "Empty archive path");
    for part in name.split('/') {
        component(part)?;
    }
    Ok(name)
}

fn write_archive_file(
    staging: &Path,
    name: &str,
    reader: impl Read,
    expected: u64,
    cancel: &CancellationToken,
) -> Result<()> {
    let target = staging.join(name);
    fs::create_dir_all(target.parent().context("Missing parent")?)?;
    let mut output = File::create_new(target)?;
    let bytes = io::copy(&mut CancellableReader(reader, cancel), &mut output)?;
    ensure!(bytes == expected, "Incomplete archive entry: {name}");
    Ok(())
}

pub(super) fn unpack(file: File, staging: &Path, cancel: &CancellationToken) -> Result<Tree> {
    let decoder = GzDecoder::new(CancellableReader(file, cancel));
    let mut archive = tar::Archive::new(decoder);
    let mut tree = Tree::default();
    let mut links: HashMap<String, Vec<String>> = HashMap::new();
    for entry in archive.entries()? {
        check_cancel(cancel)?;
        let mut entry = entry?;
        let path = entry.path()?;
        let raw = path.to_str().context("Archive filename is not UTF-8")?;
        let kind = entry.header().entry_type();
        if raw == "." || raw == "./" {
            ensure!(kind.is_dir(), "Invalid archive root");
            continue;
        }
        let name = archive_name(raw)?.to_owned();
        if kind.is_dir() {
            fs::create_dir_all(staging.join(&name))?;
            tree.dirs.push(name);
        } else if kind.is_file() {
            let expected = entry.size();
            write_archive_file(staging, &name, &mut entry, expected, cancel)?;
            tree.files.push((name, expected));
        } else if kind.is_hard_link() {
            let original = entry
                .link_name()?
                .context("Archive hard link has no target")?;
            let original =
                archive_name(original.to_str().context("Hard link target is not UTF-8")?)?;
            links.entry(original.to_owned()).or_default().push(name);
        } else {
            bail!("Unsupported archive entry (symbolic link or special file): {name}");
        }
    }
    // tar stops at the end marker. Read through the gzip trailer to verify its CRC.
    io::copy(&mut archive.into_inner(), &mut io::sink())?;
    // Only files supplied by this archive can be copy sources. Appending each
    // resolved alias also handles chains and forward references in one pass.
    let mut index = 0;
    while !links.is_empty() && index < tree.files.len() {
        check_cancel(cancel)?;
        let (name, size) = &tree.files[index];
        if let Some(aliases) = links.remove(name) {
            let original = staging.join(name);
            let size = *size;
            for alias in aliases {
                check_cancel(cancel)?;
                write_archive_file(staging, &alias, File::open(&original)?, size, cancel)?;
                tree.files.push((alias, size));
            }
        }
        index += 1;
    }
    if let Some(target) = links.keys().next() {
        bail!("Archive hard link does not resolve to a regular file: {target}");
    }
    Ok(tree)
}

pub(super) struct Destination {
    container: TempDir,
    tree: PathBuf,
    pub target: PathBuf,
}

fn private_container(parent: &Path) -> io::Result<TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(".r-shell-transfer-");
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(0o700));
    builder.tempdir_in(parent)
}

impl Destination {
    pub fn new(parent: &Path, name: &str) -> Result<Self> {
        ensure!(
            parent.is_absolute(),
            "The download destination must be absolute"
        );
        let target = parent.join(component(name)?);
        let container = match no_link(&target) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_dir(),
                    "Destination has a different file type: {}",
                    target.display()
                );
                // Stage on the destination filesystem. A sibling is still useful
                // if only subdirectories of an existing target are writable.
                private_container(&target).or_else(|_| private_container(parent))?
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => private_container(parent)?,
            Err(e) => return Err(e.into()),
        };
        // The private parent shields partial files. The child retains normal
        // directory permissions when renamed into a new download destination.
        let tree = container.path().join("tree");
        fs::create_dir(&tree)?;
        Ok(Self {
            container,
            tree,
            target,
        })
    }

    pub fn path(&self) -> &Path {
        &self.tree
    }

    fn staging_name_conflicts(&self) -> Result<bool> {
        let stage = self.container.path();
        if stage == self.target {
            return Ok(true);
        }
        if stage.parent() != Some(self.target.as_path()) {
            return Ok(false);
        }
        let name = stage
            .file_name()
            .context("Missing staging directory name")?;
        Ok(self.tree.join(name).try_exists()?)
    }

    pub fn publish(mut self, cancel: &CancellationToken) -> Result<()> {
        // If the incoming tree contains the same top-level name as our private
        // container, relocate staging before publishing any user files.
        while self.staging_name_conflicts()? {
            check_cancel(cancel)?;
            let parent = self
                .container
                .path()
                .parent()
                .context("Missing staging parent")?;
            let next = private_container(parent)?;
            let tree = next.path().join("tree");
            fs::rename(&self.tree, &tree)?;
            self.tree = tree;
            self.container = next;
        }
        // Check the complete merge before replacing any file. A pre-existing
        // link (including a dangling one) never becomes a destination ancestor.
        merge(self.path(), &self.target, true, cancel)?;
        merge(self.path(), &self.target, false, cancel)
    }
}

fn merge(src: &Path, dest: &Path, preflight: bool, cancel: &CancellationToken) -> Result<()> {
    check_cancel(cancel)?;
    let existing = match no_link(dest) {
        Ok(metadata) => metadata,
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
            #[cfg(unix)]
            {
                // Preserve access and execute bits. Downloaded contents must
                // not inherit set-user-ID or set-group-ID privileges.
                let mode = existing.permissions().mode() & 0o777;
                fs::set_permissions(src, fs::Permissions::from_mode(mode))?;
            }
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

    fn append_hard_link(
        archive: &mut tar::Builder<GzEncoder<File>>,
        name: &str,
        original: &str,
    ) -> Result<()> {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Link);
        header.set_size(0);
        archive.append_link(&mut header, name, original)?;
        Ok(())
    }

    #[test]
    fn archive_hard_links_download_as_independent_files() -> Result<()> {
        let mut archive =
            tar::Builder::new(GzEncoder::new(tempfile::tempfile()?, Compression::fast()));
        append_hard_link(&mut archive, "nested/first", "./original")?;
        let mut header = tar::Header::new_gnu();
        header.set_size(7);
        archive.append_data(&mut header, "original", &b"content"[..])?;
        append_hard_link(&mut archive, "second", "nested/first")?;
        let mut file = archive.into_inner()?.finish()?;
        file.rewind()?;
        let parent = tempfile::tempdir()?;
        let dest = Destination::new(parent.path(), "download")?;
        let cancel = CancellationToken::new();
        let tree = unpack(file, dest.path(), &cancel)?;
        assert_eq!((tree.files.len(), tree.bytes()), (3, 21));
        let target = dest.target.clone();
        dest.publish(&cancel)?;
        for name in ["original", "nested/first", "second"] {
            assert_eq!(fs::read(target.join(name))?, b"content");
        }
        fs::write(target.join("nested/first"), "changed")?;
        assert_eq!(fs::read(target.join("original"))?, b"content");
        assert_eq!(fs::read(target.join("second"))?, b"content");
        Ok(())
    }

    #[test]
    fn hard_links_must_resolve_to_regular_files_in_the_archive() -> Result<()> {
        for original in ["missing", "alias", "ambient", "../outside"] {
            let mut archive =
                tar::Builder::new(GzEncoder::new(tempfile::tempfile()?, Compression::fast()));
            append_hard_link(&mut archive, "alias", original)?;
            let mut file = archive.into_inner()?.finish()?;
            file.rewind()?;
            let parent = tempfile::tempdir()?;
            let dest = Destination::new(parent.path(), "download")?;
            fs::write(dest.path().join("ambient"), "not in the archive")?;
            assert!(unpack(file, dest.path(), &CancellationToken::new()).is_err());
            assert!(!dest.target.exists());
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn replacing_downloaded_files_preserves_private_and_executable_modes() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let dest = Destination::new(parent.path(), "download")?;
        let target = dest.target.clone();
        fs::create_dir(&target)?;
        let files = [
            ("credentials", 0o600),
            ("run.sh", 0o755),
            ("privileged", 0o6755),
        ];
        for (name, mode) in files {
            fs::write(target.join(name), "old")?;
            fs::set_permissions(target.join(name), fs::Permissions::from_mode(mode))?;
            fs::write(dest.path().join(name), "new")?;
            fs::set_permissions(dest.path().join(name), fs::Permissions::from_mode(0o644))?;
        }
        dest.publish(&CancellationToken::new())?;
        for (name, mode) in files {
            assert_eq!(fs::read(target.join(name))?, b"new");
            assert_eq!(
                fs::metadata(target.join(name))?.permissions().mode() & 0o7777,
                mode & 0o777
            );
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn staging_is_private_while_new_folders_use_normal_directory_permissions() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let reference = parent.path().join("ordinary-directory");
        fs::create_dir(&reference)?;
        let dest = Destination::new(parent.path(), "download")?;
        let container = dest.path().parent().unwrap().to_owned();
        assert_eq!(fs::metadata(&container)?.permissions().mode() & 0o077, 0);
        let target = dest.target.clone();
        dest.publish(&CancellationToken::new())?;
        assert!(!container.exists());
        assert_eq!(
            fs::metadata(&target)?.permissions().mode() & 0o777,
            fs::metadata(&reference)?.permissions().mode() & 0o777
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn existing_writable_download_under_readonly_parent_can_be_cancelled_or_published() -> Result<()>
    {
        let parent = tempfile::tempdir()?;
        let target = parent.path().join("download");
        fs::create_dir(&target)?;
        fs::write(target.join("keep"), "original")?;
        fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o555))?;
        let attempt = (|| -> Result<()> {
            let dest = Destination::new(parent.path(), "download")?;
            let container = dest.path().parent().unwrap().to_owned();
            assert_eq!(container.parent(), Some(target.as_path()));
            assert_eq!(fs::metadata(&container)?.permissions().mode() & 0o077, 0);
            fs::write(dest.path().join("keep"), "cancelled")?;
            let token = CancellationToken::new();
            token.cancel();
            assert!(dest.publish(&token).is_err());
            assert!(!container.exists());
            assert_eq!(fs::read(target.join("keep"))?, b"original");
            let dest = Destination::new(parent.path(), "download")?;
            fs::write(dest.path().join("item"), "downloaded")?;
            dest.publish(&CancellationToken::new())
        })();
        fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o755))?;
        attempt?;
        assert_eq!(fs::read(target.join("item"))?, b"downloaded");
        assert_eq!(fs::read_dir(&target)?.count(), 2);
        Ok(())
    }

    #[test]
    fn downloaded_entry_can_share_the_temporary_container_name() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let target = parent.path().join("download");
        fs::create_dir(&target)?;
        let dest = Destination::new(parent.path(), "download")?;
        let container = dest.path().parent().unwrap();
        assert_eq!(container.parent(), Some(target.as_path()));
        let name = container.file_name().unwrap().to_owned();
        fs::create_dir(dest.path().join(&name))?;
        fs::write(dest.path().join(&name).join("item"), "user data")?;
        dest.publish(&CancellationToken::new())?;
        assert_eq!(fs::read(target.join(name).join("item"))?, b"user data");
        assert_eq!(fs::read_dir(target)?.count(), 1);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn staging_refuses_a_destination_directory_symlink() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let other = tempfile::tempdir()?;
        std::os::unix::fs::symlink(other.path(), parent.path().join("link"))?;
        assert!(Destination::new(parent.path(), "link").is_err());
        assert!(other.path().read_dir()?.next().is_none());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn upload_directory_headers_allow_eager_extractors_to_create_children() -> Result<()> {
        let source = tempfile::tempdir()?;
        let names = ["modes", "modes/odd name\n"];
        let nested = source.path().join(names[1]);
        fs::create_dir_all(&nested)?;
        fs::write(nested.join("item"), "contents")?;
        for name in names.iter().rev() {
            fs::set_permissions(source.path().join(name), fs::Permissions::from_mode(0o555))?;
        }
        let cancel = CancellationToken::new();
        let tree = scan(source.path(), &cancel)?;
        let file = pack(source.path(), &tree, &cancel)?;
        for name in names {
            fs::set_permissions(source.path().join(name), fs::Permissions::from_mode(0o755))?;
        }
        let mut archive = tar::Archive::new(GzDecoder::new(file));
        let mut directories = Vec::new();
        let mut modes = Vec::new();
        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            if entry.header().entry_type().is_dir() {
                assert_eq!(entry.header().mode()? & 0o700, 0o700);
                directories.push(path);
            } else if path.starts_with("modes") {
                let mut record = String::new();
                entry.read_to_string(&mut record)?;
                modes.push((path, record));
            }
        }
        assert_eq!(directories, names.map(|name| Path::new("tree").join(name)));
        assert_eq!(
            modes,
            [
                (PathBuf::from("modes/0"), format!("u-w {}", names[1])),
                (PathBuf::from("modes/1"), format!("u-w {}", names[0]))
            ]
        );
        Ok(())
    }

    #[test]
    fn gzip_round_trip_preserves_contents_and_merges_empty_directories() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let source = parent.path().join("发布 '!");
        fs::create_dir_all(source.join("sub/empty"))?;
        fs::write(source.join("sub/.file with spaces"), vec![b'a'; 500_000])?;
        fs::write(source.join("zero"), [])?;
        let cancel = CancellationToken::new();
        // Model the ordinary tar stream produced by the remote export command.
        let mut server =
            tar::Builder::new(GzEncoder::new(tempfile::tempfile()?, Compression::fast()));
        server.append_dir_all(".", &source)?;
        let mut archive = server.into_inner()?.finish()?;
        archive.rewind()?;
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
