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
            "command -v tar >/dev/null && command -v gzip >/dev/null && command -v mktemp >/dev/null"
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

// Extract only the locally generated archive into a private sibling, then merge.
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
stage=$(mktemp -d ./.r-shell-transfer.XXXXXXXX)
trap 'rm -rf "$stage"' 0
trap 'exit 1' HUP INT TERM
mkdir "$stage/tree"
tar -xzof - -C "$stage/tree"
merge() {
    if [ -L "$2" ]; then printf 'Destination is a symbolic link: %s\n' "$2" >&2; return 1; fi
    if [ ! -e "$2" ]; then
        if [ "$3" = install ]; then mv "$1" "$2"; fi
    elif [ -d "$1" ] && [ -d "$2" ]; then
        for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do
            [ -e "$child" ] || continue
            merge "$child" "$2/${child##*/}" "$3" || return 1
        done
    elif [ -f "$1" ] && [ -f "$2" ]; then
        if [ "$3" = install ]; then mv -f "$1" "$2"; fi
    else
        printf 'Destination has a different file type: %s\n' "$2" >&2
        return 1
    fi
}
merge "$stage/tree" "$dest" check
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
