use super::*;
use crate::websocket_server::*;

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn serve(
    manager: Arc<LocalShells>,
    connections: usize,
) -> (String, tokio::task::JoinHandle<()>) {
    let bridge = WebSocketServer::new(Arc::new(ConnectionManager::new()), manager);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let token = WEBSOCKET_TOKEN.get_or_init(generate_bridge_token);
    let server = tokio::spawn(async move {
        for _ in 0..connections {
            let (socket, _) = listener.accept().await.unwrap();
            bridge.handle_connection(socket).await.unwrap();
        }
    });
    (format!("ws://{endpoint}/?token={token}"), server)
}

async fn connect(url: &str, id: &str, expected_generation: u64) -> Socket {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let attach = WsMessage::AttachLocalPty {
            connection_id: id.to_owned(),
            cols: 90,
            rows: 25,
        };
        socket.send(control(attach)).await.unwrap();
        let started = socket.next().await.unwrap().unwrap();
        assert!(
            matches!(serde_json::from_str(started.to_text().unwrap()).unwrap(),
            WsMessage::PtyStarted { generation, reattached, .. }
            if generation == expected_generation && reattached == (generation > 1))
        );
        socket
    })
    .await
    .expect("local shell attachment")
}

fn input(id: &str, data: &[u8]) -> Message {
    let mut frame = vec![BINARY_INPUT_CMD];
    frame.extend_from_slice(&(id.len() as u16).to_be_bytes());
    frame.extend_from_slice(id.as_bytes());
    frame.extend_from_slice(data);
    Message::Binary(frame.into())
}

fn control(msg: WsMessage) -> Message {
    Message::Text(serde_json::to_string(&msg).unwrap().into())
}

async fn expect_input_ack(socket: &mut Socket, id: &str, generation: u64) {
    let ack = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .expect("missing local input acknowledgement")
        .unwrap()
        .unwrap();
    assert!(
        matches!(serde_json::from_str(ack.to_text().unwrap()).unwrap(),
        WsMessage::LocalPtyInputAck { connection_id, generation: received }
            if connection_id == id && received == generation)
    );
}

fn output_payload<'a>(frame: &'a [u8], id: &str) -> &'a [u8] {
    assert_eq!(frame[0], BINARY_OUTPUT_CMD);
    assert_eq!(u16::from_be_bytes([frame[1], frame[2]]) as usize, id.len());
    assert_eq!(&frame[3..3 + id.len()], id.as_bytes());
    &frame[3 + id.len()..]
}

#[cfg(windows)]
async fn answer_initial_cursor_query(socket: &mut Socket, id: &str) {
    use crate::local_pty::tests::CursorQuery;
    let mut cursor = CursorQuery::default();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            // Grant exactly one output frame so the cursor response's ACK cannot
            // be interleaved with shell output or mistaken for the command ACK.
            socket
                .send(control(WsMessage::Resume {
                    connection_id: id.into(),
                }))
                .await
                .unwrap();
            let frame = socket.next().await.unwrap().unwrap();
            let Message::Binary(frame) = frame else {
                panic!("unexpected ConPTY startup frame: {frame:?}")
            };
            if cursor.observe(output_payload(&frame, id)) {
                socket.send(input(id, CursorQuery::REPORT)).await.unwrap();
                expect_input_ack(socket, id, 1).await;
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Incomplete ConPTY cursor handshake; output: {:?}",
            crate::local_pty::tests::output_tail(&cursor.tail)
        )
    });
}

#[tokio::test]
async fn local_shell_roundtrip_over_authenticated_websocket() {
    let manager = Arc::new(LocalShells::default());
    #[cfg(unix)]
    let shell = Some("/bin/sh".into());
    #[cfg(windows)]
    let shell = std::env::var_os("SystemRoot").map(|root| {
        std::path::PathBuf::from(root)
            .join(r"System32\cmd.exe")
            .to_string_lossy()
            .into_owned()
    });
    let id = manager.start(80, 24, shell).await.unwrap().run_id;
    let (url, server) = serve(manager.clone(), 2).await;
    let mut first = connect(&url, &id, 1).await;
    #[cfg(windows)]
    answer_initial_cursor_query(&mut first, &id).await;
    #[cfg(unix)]
    let (set_variable, finish) = (
        b"RSHELL_ROUNDTRIP=37\r".as_slice(),
        b"echo local-pty-roundtrip\rexit \"$RSHELL_ROUNDTRIP\"\r".as_slice(),
    );
    #[cfg(windows)]
    let (set_variable, finish) = (
        b"set RSHELL_ROUNDTRIP=37\r".as_slice(),
        b"echo local-pty-roundtrip\rexit %RSHELL_ROUNDTRIP%\r".as_slice(),
    );
    first.send(input(&id, set_variable)).await.unwrap();
    expect_input_ack(&mut first, &id, 1).await;
    first.close(None).await.unwrap();

    // Only the original process knows the variable set before the drop.
    let mut socket = connect(&url, &id, 2).await;
    socket.send(input(&id, finish)).await.unwrap();
    let resume = control(WsMessage::Resume {
        connection_id: id.clone(),
    });
    socket.send(resume.clone()).await.unwrap();
    let mut output = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Binary(frame) => {
                    let payload = output_payload(&frame, &id);
                    output.extend_from_slice(payload);
                    socket.send(resume.clone()).await.unwrap();
                }
                Message::Text(text) => match serde_json::from_str(&text).unwrap() {
                    WsMessage::LocalPtyInputAck {
                        connection_id,
                        generation: 2,
                    } if connection_id == id => {}
                    WsMessage::LocalPtyExited {
                        connection_id,
                        exit_code: Some(37),
                    } if connection_id == id => break,
                    msg => panic!("unexpected response: {msg:?}"),
                },
                frame => panic!("unexpected frame: {frame:?}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Missing local shell exit; output: {:?}",
            crate::local_pty::tests::output_tail(&output)
        )
    });
    assert!(String::from_utf8_lossy(&output).contains("local-pty-roundtrip"));
    socket.close(None).await.unwrap();
    server.await.unwrap();
    manager.shutdown().await;
}

#[tokio::test]
async fn local_reattach_preserves_blocked_output_and_reports_exit_last() {
    let (source, receiver) = mpsc::channel(2);
    source
        .send(LocalPtyEvent::Output(b"last line".to_vec()))
        .await
        .unwrap();
    source.send(LocalPtyEvent::Exited(Some(37))).await.unwrap();
    let events = Arc::new(Mutex::new(LocalEvents {
        receiver,
        pending: None,
    }));
    let id = "local-test".to_owned();

    // Put the first writer behind a full socket, after it obtained a credit.
    let cancel = CancellationToken::new();
    let (old, mut old_frames) = mpsc::channel(1);
    old.send(Message::Text("busy".into())).await.unwrap();
    let first_credits = Arc::new(Semaphore::new(1));
    let first = tokio::spawn(forward_local_output(
        id.clone(),
        events.clone(),
        cancel.clone(),
        first_credits.clone(),
        old,
    ));
    tokio::time::timeout(Duration::from_secs(2), async {
        while first_credits.available_permits() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    first.await.unwrap();
    assert!(matches!(old_frames.recv().await, Some(Message::Text(_))));
    assert!(old_frames.recv().await.is_none());

    let (new, mut frames) = mpsc::channel(2);
    let credits = Arc::new(Semaphore::new(0));
    let second = tokio::spawn(forward_local_output(
        id.clone(),
        events,
        CancellationToken::new(),
        credits.clone(),
        new,
    ));
    assert!(frames.try_recv().is_err());
    credits.add_permits(1);
    tokio::time::timeout(Duration::from_secs(2), second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        frames.recv().await.unwrap(),
        Message::Binary(encode_output_frame(&id, b"last line").into())
    );
    let exited: WsMessage =
        serde_json::from_str(frames.recv().await.unwrap().to_text().unwrap()).unwrap();
    assert!(
        matches!(exited, WsMessage::LocalPtyExited { connection_id, exit_code: Some(37) } if connection_id == id)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn local_blocked_stdin_keeps_output_credits_and_input_order() {
    let manager = Arc::new(LocalShells::default());
    let id = manager
        .start(80, 24, Some("/bin/sh".into()))
        .await
        .unwrap()
        .run_id;
    let (url, server) = serve(manager.clone(), 1).await;
    let mut socket = connect(&url, &id, 1).await;
    let resume = control(WsMessage::Resume {
        connection_id: id.clone(),
    });
    socket.send(resume.clone()).await.unwrap();

    // The shell outputs 1 MiB before reading a single keystroke. One pending
    // input fills its tty buffer and blocks while the same socket must process
    // output ACKs. Then verify the complete contents of every queued input.
    let script = concat!(
        "stty -echo -icanon; printf 'rs-accept-%s\\n' input; sleep 0.2; ",
        "head -c 1048576 /dev/zero; zeros=$(printf '%04096d' 0); i=0; ",
        "while [ \"$i\" -lt 24 ]; do IFS= read -r line || exit 62; ",
        "[ \"$line\" = \"$i:$zeros\" ] || exit 63; i=$((i+1)); done; exit 37\r"
    );
    socket.send(input(&id, script.as_bytes())).await.unwrap();
    let zeros = "0".repeat(4096);
    let mut next = 0;
    let mut got_credit = false;
    let mut ready = false;
    let mut initial = Vec::new();
    let mut zero_bytes = 0;
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Binary(frame) => {
                    let bytes = &frame[3 + id.len()..];
                    zero_bytes += bytes.iter().filter(|&&b| b == 0).count();
                    if !ready {
                        initial.extend_from_slice(bytes);
                        ready = String::from_utf8_lossy(&initial).contains("rs-accept-input");
                    }
                    socket.send(resume.clone()).await.unwrap();
                }
                Message::Text(text) => match serde_json::from_str(&text).unwrap() {
                    WsMessage::LocalPtyInputAck {
                        connection_id,
                        generation: 1,
                    } if connection_id == id => got_credit = true,
                    WsMessage::LocalPtyExited {
                        connection_id,
                        exit_code: Some(37),
                    } if connection_id == id => break,
                    msg => panic!("unexpected local shell response: {msg:?}"),
                },
                frame => panic!("unexpected frame: {frame:?}"),
            }
            if ready && got_credit && next < 24 {
                let line = format!("{next}:{zeros}\n");
                socket.send(input(&id, line.as_bytes())).await.unwrap();
                got_credit = false;
                next += 1;
            }
        }
    })
    .await
    .expect("blocked PTY input must not starve output acknowledgements");
    assert_eq!(next, 24);
    assert_eq!(zero_bytes, 1024 * 1024);
    socket.close(None).await.unwrap();
    server.await.unwrap();
    manager.shutdown().await;
}
