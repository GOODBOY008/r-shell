use std::{fs::File, sync::Arc, time::Duration};

use anyhow::{bail, ensure, Result};
use russh::{client, ChannelMsg};
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio_util::{io::InspectReader, sync::CancellationToken};

use super::{FolderProgress, Report};
use crate::ssh::{bounded_channel_close, remote_shell::sh_with_args, Client};

pub(super) type Session = Arc<client::Handle<Client>>;

// The transport wrapper encodes both the fixed script and the path as arguments
// for POSIX sh, even when the user's SSH login shell is fish or tcsh.
fn command(script: &str, path: &str) -> String {
    sh_with_args(r#"exec sh -c "$1" sh "$2""#, &[script, path])
}

pub(super) async fn available(
    session: &Session,
    upload: bool,
    cancel: &CancellationToken,
) -> Result<bool> {
    let mut channel = tokio::select! {
        opened = tokio::time::timeout(Duration::from_secs(8), session.channel_open_session()) => match opened {
            Ok(Ok(channel)) => channel,
            _ => return Ok(false),
        },
        _ = cancel.cancelled() => bail!(crate::sftp_transfer::CANCEL_ERROR),
    };
    let probe = async {
        let tools = if upload {
            "command -v tar >/dev/null && command -v gzip >/dev/null && command -v mktemp >/dev/null && (stat -c %a . >/dev/null 2>&1 || stat -f %Lp . >/dev/null 2>&1)"
        } else {
            "command -v tar >/dev/null && command -v gzip >/dev/null"
        };
        channel
            .exec(
                true,
                command(&format!("{tools} && printf RSHELL_TAR_GZIP"), ""),
            )
            .await?;
        channel.eof().await?;
        let mut output = Vec::new();
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } if output.len() + data.len() <= 64 => {
                    output.extend_from_slice(&data)
                }
                ChannelMsg::Data { .. } | ChannelMsg::Failure => return Ok(false),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, anyhow::Error>(status == Some(0) && output == b"RSHELL_TAR_GZIP")
    };
    let available = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(8), probe) => Ok(matches!(result, Ok(Ok(true)))),
        _ = cancel.cancelled() => Err(anyhow::anyhow!(crate::sftp_transfer::CANCEL_ERROR)),
    };
    bounded_channel_close(&channel).await;
    available
}

// Extract the locally generated archive into a private directory on the target filesystem.
// A successful transfer replaces matching files and leaves unrelated files alone.
// Positional parameters keep recursion and names with whitespace/newlines intact.
const INSTALL: &str = r#"
set -eu
case "$1" in /*) dest=$1 ;; *) dest=./$1 ;; esac
name=${dest##*/}
case "$name" in ""|"."|"..") exit 2 ;; esac
parent=${dest%/*}
CDPATH= cd -- "${parent:-/}"
dest=./$name
stage=
if [ -d "$dest" ] && [ ! -L "$dest" ]; then
    # A shared parent may be read-only even though the selected folder is writable.
    stage=$(mktemp -d "$dest/.r-shell-transfer.XXXXXXXX" 2>/dev/null) || stage=
fi
if [ -z "$stage" ]; then stage=$(mktemp -d ./.r-shell-transfer.XXXXXXXX); fi
cleanup() {
    rm -rf "$stage" 2>/dev/null || { chmod -R u+rwX "$stage" && rm -rf "$stage"; }
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
mkdir "$stage/tree" "$stage/modes"
tar -xzof - -C "$stage"
if stat -c %a . >/dev/null 2>&1; then
    stat_option=-c; stat_format=%a
else
    stat_option=-f; stat_format=%Lp
fi
merge() {
    if [ "$2" = "$stage" ]; then printf 'Destination name collides with staging: %s\n' "$2" >&2; return 1; fi
    if [ -L "$2" ]; then printf 'Destination is a symbolic link: %s\n' "$2" >&2; return 1; fi
    if [ ! -e "$2" ]; then
        if [ "$3" = install ]; then
            # Reparenting a directory may require write access to update "..".
            if [ -d "$1" ] && [ ! -w "$1" ]; then
                chmod u+w "$1" && mv "$1" "$2" && chmod u-w "$2"
            else
                mv "$1" "$2"
            fi
        fi
    elif [ -d "$1" ] && [ -d "$2" ]; then
        for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do
            [ -e "$child" ] || continue
            merge "$child" "$2/${child##*/}" "$3" || return 1
        done
    elif [ -f "$1" ] && [ -f "$2" ]; then
        if [ "$3" = install ]; then
            mode=$(stat "$stat_option" "$stat_format" "$2") || return 1
            case "$mode" in ""|*[!0-7]*) printf 'Invalid file mode for %s\n' "$2" >&2; return 1 ;; esac
            chmod "$(printf '%03o' "$((0$mode & 0777))")" "$1" && mv -f "$1" "$2"
        fi
    else
        printf 'Destination has a different file type: %s\n' "$2" >&2
        return 1
    fi
}
merge "$stage/tree" "$dest" check
# Existing directories keep their own modes and their staged counterparts
# stay writable until cleanup. Restore new subtrees in private, children first.
i=0
while [ -f "$stage/modes/$i" ]; do
    # The sentinel preserves trailing newlines in a filename.
    record=$(cat "$stage/modes/$i" && printf .)
    record=${record%.}
    rel=${record#* }
    if [ ! -d "$dest/$rel" ]; then chmod "${record%% *}" "$stage/tree/$rel"; fi
    i=$((i + 1))
done
merge "$stage/tree" "$dest" install
"#;

const EXPORT: &str = r#"
set -eu
CDPATH= cd -- "$1"
exec tar -czf - .
"#;

pub(super) async fn transfer(
    session: &Session,
    upload: bool,
    path: &str,
    archive: File,
    progress: FolderProgress,
    report: &Report,
    cancel: &CancellationToken,
) -> Result<u64> {
    let mut channel = tokio::select! {
        channel = session.channel_open_session() => channel?,
        _ = cancel.cancelled() => bail!(crate::sftp_transfer::CANCEL_ERROR),
    };
    let script = if upload { INSTALL } else { EXPORT };
    tokio::select! {
        result = channel.exec(true, command(script, path)) => result?,
        _ = cancel.cancelled() => {
            bounded_channel_close(&channel).await;
            bail!(crate::sftp_transfer::CANCEL_ERROR);
        }
    }
    let mut writer = channel.make_writer();

    // Drain stdout, stderr and exit status concurrently with stdin. In
    // particular a failed remote extraction must not leave a blocked writer.
    let operation = async {
        let (input, output) = if upload {
            (Some(archive), None)
        } else {
            (None, Some(archive))
        };
        let send = async {
            if let Some(input) = input {
                let mut bytes = 0;
                let input =
                    InspectReader::new(tokio::fs::File::from_std(input), |chunk: &[u8]| {
                        bytes += chunk.len() as u64;
                        report.tick(progress, bytes);
                    });
                tokio::io::copy(
                    &mut BufReader::with_capacity(128 * 1024, input),
                    &mut writer,
                )
                .await?;
            }
            // Shutdown on the russh channel writer sends SSH EOF, not CLOSE.
            writer.shutdown().await?;
            if upload {
                report.send(FolderProgress {
                    phase: super::Phase::Unpacking,
                    transferred: progress.total,
                    ..progress
                });
            }
            Ok::<_, anyhow::Error>(())
        };
        let receive = async {
            let mut sink = output
                .map(|file| BufWriter::with_capacity(256 * 1024, tokio::fs::File::from_std(file)));
            let mut stderr = Vec::new();
            let mut bytes = 0;
            let mut status = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if let Some(sink) = &mut sink {
                            sink.write_all(&data).await?;
                            bytes += data.len() as u64;
                            report.tick(progress, bytes);
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        let n = data.len().min(4096 - stderr.len());
                        stderr.extend_from_slice(&data[..n]);
                    }
                    ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                    ChannelMsg::Failure => bail!("Server refused the archive command"),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            ensure!(
                status == Some(0),
                "Remote archive command failed ({status:?}): {}",
                String::from_utf8_lossy(&stderr).trim()
            );
            if let Some(mut sink) = sink {
                sink.flush().await?;
            }
            Ok::<_, anyhow::Error>(if upload { progress.total } else { bytes })
        };
        let (_, bytes) = tokio::try_join!(send, receive)?;
        Ok(bytes)
    };
    let result = tokio::select! {
        result = operation => result,
        _ = cancel.cancelled() => Err(anyhow::anyhow!(crate::sftp_transfer::CANCEL_ERROR)),
    };
    bounded_channel_close(&channel).await;
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::folder_transfer::local;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::{Command, Output, Stdio};

    fn install_readonly_tree(dest: &Path) -> Result<Output> {
        let source = tempfile::tempdir()?;
        let folders = ["existing", "new"];
        for name in folders {
            let dir = source.path().join(name);
            fs::create_dir(&dir)?;
            fs::write(dir.join("item"), "uploaded")?;
            fs::set_permissions(dir.join("item"), fs::Permissions::from_mode(0o644))?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o555))?;
        }
        let cancel = CancellationToken::new();
        let tree = local::scan(source.path(), &cancel)?;
        let archive = local::pack(source.path(), &tree, &cancel)?;
        for name in folders {
            fs::set_permissions(source.path().join(name), fs::Permissions::from_mode(0o755))?;
        }
        Ok(Command::new("sh")
            .arg("-c")
            .arg(format!(
                "umask 022; {}",
                command(INSTALL, dest.to_str().unwrap())
            ))
            .stdin(Stdio::from(archive))
            .output()?)
    }

    #[test]
    fn upload_merges_readonly_staged_directories_and_preserves_published_modes() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let dest = parent.path().join("published");
        fs::create_dir_all(dest.join("existing"))?;
        fs::write(dest.join("existing/item"), "old")?;
        fs::write(dest.join("existing/keep"), "keep")?;
        fs::set_permissions(dest.join("existing"), fs::Permissions::from_mode(0o750))?;
        let result = install_readonly_tree(&dest)?;
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let new_mode = fs::metadata(dest.join("new"))?.permissions().mode() & 0o777;
        fs::set_permissions(dest.join("new"), fs::Permissions::from_mode(0o755))?;
        assert_eq!(new_mode, 0o555);
        assert_eq!(
            fs::metadata(dest.join("existing"))?.permissions().mode() & 0o777,
            0o750
        );
        assert_eq!(fs::read(dest.join("existing/item"))?, b"uploaded");
        assert_eq!(fs::read(dest.join("existing/keep"))?, b"keep");
        assert_eq!(fs::read(dest.join("new/item"))?, b"uploaded");
        assert_eq!(fs::read_dir(parent.path())?.count(), 1);
        Ok(())
    }

    #[test]
    fn failed_upload_removes_readonly_staging() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let dest = parent.path().join("conflict");
        fs::write(&dest, "keep")?;
        let result = install_readonly_tree(&dest)?;
        assert!(!result.status.success());
        assert_eq!(fs::read(&dest)?, b"keep");
        assert_eq!(fs::read_dir(parent.path())?.count(), 1);
        Ok(())
    }

    #[test]
    fn upload_replacements_keep_existing_access_and_execute_bits() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let dest = parent.path().join("site");
        let files = [("existing", 0o600), ("new", 0o755)];
        for (folder, mode) in files {
            fs::create_dir_all(dest.join(folder))?;
            let path = dest.join(folder).join("item");
            fs::write(&path, "old")?;
            fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
        }
        let result = install_readonly_tree(&dest)?;
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        for (folder, mode) in files {
            let path = dest.join(folder).join("item");
            assert_eq!(fs::read(&path)?, b"uploaded");
            assert_eq!(fs::metadata(path)?.permissions().mode() & 0o7777, mode);
        }
        Ok(())
    }

    #[test]
    fn writable_destination_under_readonly_parent_accepts_uploads_and_cleans_conflicts(
    ) -> Result<()> {
        let parent = tempfile::tempdir()?;
        let dest = parent.path().join("writable site");
        fs::create_dir(&dest)?;
        fs::write(dest.join("existing"), "conflict")?;
        fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o555))?;
        let failed = install_readonly_tree(&dest)?;
        assert!(!failed.status.success());
        assert_eq!(fs::read(dest.join("existing"))?, b"conflict");
        assert_eq!(fs::read_dir(&dest)?.count(), 1);
        fs::remove_file(dest.join("existing"))?;
        let result = install_readonly_tree(&dest);
        fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o755))?;
        let result = result?;
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        for name in ["existing", "new"] {
            fs::set_permissions(dest.join(name), fs::Permissions::from_mode(0o755))?;
            assert_eq!(fs::read(dest.join(name).join("item"))?, b"uploaded");
        }
        assert_eq!(fs::read_dir(&dest)?.count(), 2);
        assert_eq!(fs::read_dir(parent.path())?.count(), 1);
        Ok(())
    }
}
