use super::*;
use tokio::time::timeout;

/// The headless test clients stand in for xterm. portable-pty requests
/// PSEUDOCONSOLE_INHERIT_CURSOR, so ConPTY sends DSR before accepting input.
#[derive(Default)]
pub(crate) struct CursorQuery {
    pub(crate) tail: Vec<u8>,
}

impl CursorQuery {
    #[cfg(windows)]
    pub(crate) const REPORT: &[u8] = b"\x1b[1;1R";

    pub(crate) fn observe(&mut self, bytes: &[u8]) -> bool {
        const QUERY: &[u8] = b"\x1b[6n";
        // Include up to three preceding bytes when a PTY frame splits the query.
        let start = self.tail.len().saturating_sub(QUERY.len() - 1);
        self.tail.extend_from_slice(bytes);
        let requested = self.tail[start..].windows(QUERY.len()).any(|w| w == QUERY);
        let discard = self.tail.len().saturating_sub(96);
        self.tail.drain(..discard);
        requested
    }
}

pub(crate) fn output_tail(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(96)..])
}

#[test]
fn headless_cursor_query_survives_output_chunk_boundaries() {
    for split in 0..=4 {
        let mut query = CursorQuery::default();
        assert!(!query.observe(b"unrelated status: \x1b[5n"));
        let request = b"\x1b[6n";
        assert_eq!(query.observe(&request[..split]), split == 4);
        assert_eq!(query.observe(&request[split..]), split != 4);
    }
}

#[cfg(windows)]
async fn answer_initial_cursor_query(shell: &LocalPty, events: &mut mpsc::Receiver<LocalPtyEvent>) {
    let mut query = CursorQuery::default();
    timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Some(LocalPtyEvent::Output(bytes)) => {
                    if query.observe(&bytes) {
                        shell.write(CursorQuery::REPORT.to_vec()).await.unwrap();
                        return;
                    }
                }
                Some(LocalPtyEvent::Error(e)) => panic!("ConPTY startup: {e}"),
                Some(LocalPtyEvent::Exited(code)) => {
                    panic!("ConPTY exited during startup: {code:?}")
                }
                None => panic!("ConPTY output closed during startup"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Missing initial ConPTY cursor query; output: {:?}",
            output_tail(&query.tail)
        )
    });
}

fn shell_path() -> String {
    #[cfg(unix)]
    {
        "/bin/sh".into()
    }
    #[cfg(windows)]
    {
        std::env::var("ComSpec").expect("Windows command interpreter")
    }
}

#[tokio::test]
async fn native_pty_transfers_input_resizes_and_drains_before_exit() {
    let (shell, mut events) = LocalPty::spawn(80, 24, Some(shell_path())).await.unwrap();
    #[cfg(windows)]
    answer_initial_cursor_query(&shell, &mut events).await;
    shell.resize(92, 31).await.unwrap();
    #[cfg(unix)]
    let command = b"stty size; printf 'last-frame-%d\\n' 771; exit 23\r";
    #[cfg(windows)]
    let command = b"@echo off\rset NUMBER=771\recho last-frame-%NUMBER%\rexit 23\r";
    shell.write(command.to_vec()).await.unwrap();
    let mut bytes = Vec::new();
    let code = timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await.unwrap() {
                LocalPtyEvent::Output(data) => bytes.extend(data),
                LocalPtyEvent::Exited(code) => break code,
                LocalPtyEvent::Error(error) => panic!("{error}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Missing shell exit; output: {:?}", output_tail(&bytes)));
    assert_eq!(code, Some(23));
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("last-frame-771"), "{text}");
    #[cfg(unix)]
    assert!(text.contains("31 92"), "{text}");
    assert!(!shell.is_running());
    shell.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn ctrl_d_returns_from_inner_shell_then_exits_top_level_pty() {
    let (shell, mut events) = LocalPty::spawn(80, 24, Some(shell_path())).await.unwrap();
    timeout(Duration::from_secs(10), async {
        shell.write(b"/bin/sh -c 'printf \"inner-%s\\n\" ready; read value'; printf 'parent-%s\\n' ready\r".to_vec()).await.unwrap();
        for marker in ["inner-ready", "parent-ready"] {
            let mut output = Vec::new();
            while !String::from_utf8_lossy(&output).contains(marker) {
                match events.recv().await.unwrap() {
                    LocalPtyEvent::Output(bytes) => output.extend(bytes),
                    LocalPtyEvent::Error(error) => panic!("{error}"),
                    LocalPtyEvent::Exited(code) => panic!("exited before {marker}: {code:?}"),
                }
            }
            assert!(shell.is_running());
            shell.write(vec![0x04]).await.unwrap();
        }
        loop {
            match events.recv().await.unwrap() {
                LocalPtyEvent::Output(_) => {}
                LocalPtyEvent::Error(error) => panic!("{error}"),
                LocalPtyEvent::Exited(code) => {
                    assert_eq!(code, Some(0));
                    break;
                }
            }
        }
    }).await.expect("both shell EOFs should complete");
    shell.close().await;
}

#[tokio::test]
async fn invalid_override_and_size_do_not_start_a_shell() {
    assert!(LocalPty::spawn(80, 24, Some("relative-shell".into()))
        .await
        .is_err());
    let missing = tempfile::tempdir()
        .unwrap()
        .path()
        .join("no such executable.exe");
    assert!(
        LocalPty::spawn(80, 24, Some(missing.to_string_lossy().into_owned()))
            .await
            .is_err()
    );
    assert!(LocalPty::spawn(0, 24, None).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn close_with_backpressure_terminates_foreground_group() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("foreground-pid");
    let (shell, _unread_output) = LocalPty::spawn(80, 24, Some(shell_path())).await.unwrap();
    // The foreground shell writes its own PID before flooding stdout. Leave output
    // unread to verify that a saturated event queue cannot prevent teardown.
    let script = format!("sh -c 'echo $$ > \"{}\"; exec yes'\r", pid_file.display());
    shell.write(script.into_bytes()).await.unwrap();
    let pid: libc::pid_t = timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(raw) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = raw.trim().parse() {
                    break pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    timeout(Duration::from_secs(5), async {
        tokio::join!(shell.close(), shell.close());
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(!shell.is_running());
    assert!(shell.write(vec![0]).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn custom_executable_with_spaces_is_one_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("my local shell");
    std::os::unix::fs::symlink("/bin/sh", &path).unwrap();
    let (shell, _events) = LocalPty::spawn(80, 24, Some(path.to_str().unwrap().into()))
        .await
        .unwrap();
    assert_eq!(shell.shell_name(), "my local shell");
    shell.close().await;
}

#[test]
fn default_command_starts_at_home_with_terminal_environment() {
    let (command, name) = shell::command(None).unwrap();
    assert!(!name.is_empty());
    assert_eq!(
        command.get_cwd().map(Path::new),
        dirs::home_dir().as_deref()
    );
    assert_eq!(command.get_env("TERM").unwrap(), "xterm-256color");
}

#[cfg(windows)]
#[tokio::test]
async fn close_while_conpty_output_is_backpressured() {
    let (shell, mut events) = LocalPty::spawn(80, 24, Some(shell_path())).await.unwrap();
    answer_initial_cursor_query(&shell, &mut events).await;
    shell
        .write(b"for /l %i in (1,1,999999) do @echo frame-%i\r".to_vec())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    timeout(Duration::from_secs(10), shell.close())
        .await
        .unwrap();
    assert!(!shell.is_running());
}

#[cfg(unix)]
#[tokio::test]
async fn acknowledges_each_input_chunk_in_order() {
    let (shell, mut events) = LocalPty::spawn(80, 24, Some(shell_path())).await.unwrap();
    shell
        .write(
            b"stty -echo; IFS= read -r typed; printf 'received=[%s]\\n' \"$typed\"; exit\r"
                .to_vec(),
        )
        .await
        .unwrap();
    let typed = "abcdefghijklmnopqrstuvwxyz0123456789";
    for byte in typed.bytes() {
        shell.write(vec![byte]).await.unwrap();
    }
    shell.write(vec![b'\r']).await.unwrap();
    let bytes = timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                LocalPtyEvent::Output(chunk) => bytes.extend(chunk),
                LocalPtyEvent::Exited(Some(0)) => return bytes,
                _ => panic!("Local shell failed to read all input"),
            }
        }
        panic!("Missing shell exit")
    })
    .await
    .unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains(&format!("received=[{typed}]")));
}
