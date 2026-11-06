use super::*;
use crate::desktop_frames::desktop_event_channel;
use tokio::net::TcpListener;

const RFB_38: &[u8] = b"RFB 003.008\n";
const CHALLENGE: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
// Independently generated DES-ECB vector for the VNC bit-reversed "password" key.
const RESPONSE: [u8; 16] = [
    0xb8, 0x66, 0x92, 0x41, 0x25, 0xc8, 0xee, 0xbb, 0x9d, 0xeb, 0xc1, 0xdb, 0x61, 0xc5, 0x38, 0xe2,
];

fn config(listener: &TcpListener, password: Option<&str>) -> VncConfig {
    VncConfig {
        host: "127.0.0.1".into(),
        port: listener.local_addr().unwrap().port(),
        password: password.map(str::to_owned),
        color_depth: 24,
    }
}

async fn expect_wire(stream: &mut (impl AsyncRead + Unpin), expected: &[u8]) {
    let mut actual = vec![0; expected.len()];
    stream.read_exact(&mut actual).await.unwrap();
    assert_eq!(actual, expected);
}

async fn challenge(stream: &mut TcpStream) -> [u8; 16] {
    stream.write_all(RFB_38).await.unwrap();
    expect_wire(stream, RFB_38).await;
    stream.write_all(&[2, 1, 2]).await.unwrap(); // Offer None first to test auth selection.
    expect_wire(stream, &[2]).await;
    stream.write_all(&CHALLENGE).await.unwrap();
    let mut response = [0; 16];
    stream.read_exact(&mut response).await.unwrap();
    response
}

#[tokio::test]
async fn password_vnc_streams_frames_and_delivers_input() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = config(&listener, Some("password"));
        let (incremental_sent, incremental_seen) = tokio::sync::oneshot::channel();
        let (refresh_sent, refresh_seen) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(challenge(&mut stream).await, RESPONSE);
            stream.write_u32(0).await.unwrap(); // SecurityResult.
            expect_wire(&mut stream, &[1]).await; // ClientInit shared flag.
            stream.write_all(&[0, 2, 0, 1]).await.unwrap();
            stream
                .write_all(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
                .await
                .unwrap();
            stream.write_u32(4).await.unwrap();
            stream.write_all(b"test").await.unwrap();

            expect_wire(
                &mut stream,
                &[
                    0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
                ],
            )
            .await;
            expect_wire(&mut stream, &[2, 0, 0, 2, 0, 0, 0, 0, 255, 255, 255, 33]).await;
            expect_wire(&mut stream, &[3, 0, 0, 0, 0, 0, 0, 2, 0, 1]).await;
            stream
                .write_all(&[0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0])
                .await
                .unwrap();
            stream
                .write_all(&[3, 2, 1, 0, 30, 20, 10, 0])
                .await
                .unwrap();
            expect_wire(&mut stream, &[3, 1, 0, 0, 0, 0, 0, 2, 0, 1]).await;
            incremental_sent.send(()).unwrap();

            expect_wire(&mut stream, &[4, 1, 0, 0, 0, 0, 0xff, 0x0d]).await; // Return down.
            expect_wire(&mut stream, &[4, 0, 0, 0, 0, 0, 0xff, 0x0d]).await; // Return up.
            expect_wire(&mut stream, &[5, 4, 0, 1, 0, 0]).await; // Right down.
            expect_wire(&mut stream, &[5, 6, 0, 1, 0, 0]).await; // Middle down.
            expect_wire(&mut stream, &[5, 2, 0, 1, 0, 0]).await; // Right up.
            expect_wire(&mut stream, &[5, 10, 0, 1, 0, 0, 5, 2, 0, 1, 0, 0]).await; // Scroll.
            expect_wire(&mut stream, &[6, 0, 0, 0, 0, 0, 0, 3, b'h', 0xe9, b'\n']).await;
            stream
                .write_all(&[3, 0, 0, 0, 0, 0, 0, 2, b'o', b'k'])
                .await
                .unwrap();

            stream
                .write_all(&[0, 0, 0, 1, 0, 0, 0, 0, 0, 3, 0, 2, 255, 255, 255, 33])
                .await
                .unwrap();
            expect_wire(&mut stream, &[3, 0, 0, 0, 0, 0, 0, 3, 0, 2]).await;
            refresh_sent.send(()).unwrap();
            // The client must close the socket when its stream is cancelled.
            assert_eq!(stream.read(&mut [0; 1]).await.unwrap(), 0);
        });

        let client = VncClient::connect(&config, Arc::new(|_| {})).await.unwrap();
        assert_eq!(client.desktop_size(), (2, 1));
        let (events, mut frames) = desktop_event_channel();
        let cancel = CancellationToken::new();
        client
            .start_frame_loop(events, cancel.clone())
            .await
            .unwrap();
        assert!(matches!(
            frames.recv().await,
            Some(DesktopEvent::Resized {
                width: 2,
                height: 1
            })
        ));
        let Some(DesktopEvent::Frame(frame)) = frames.recv().await else {
            panic!("missing frame")
        };
        assert_eq!(frame.rgba_data, [1, 2, 3, 255, 10, 20, 30, 255]);
        incremental_seen.await.unwrap();
        client.send_key(0xff0d, true).await.unwrap();
        client.send_key(0xff0d, false).await.unwrap();
        client.send_pointer_button(1, 0, 2, true).await.unwrap();
        client.send_pointer_button(1, 0, 4, true).await.unwrap();
        client.send_pointer_button(1, 0, 2, false).await.unwrap();
        client.send_pointer(1, 0, 8).await.unwrap();
        client.set_clipboard("hé\r\n".into()).await.unwrap();
        assert!(matches!(frames.recv().await, Some(DesktopEvent::Clipboard(text)) if text == "ok"));
        assert!(matches!(
            frames.recv().await,
            Some(DesktopEvent::Resized {
                width: 3,
                height: 2
            })
        ));
        assert_eq!(client.desktop_size(), (3, 2));
        refresh_seen.await.unwrap();
        cancel.cancel();
        assert!(frames.recv().await.is_none());
        assert!(!client.is_connected());
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn rejected_vnc_password_is_reported_before_starting_a_session() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = config(&listener, Some("wrong"));
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_ne!(challenge(&mut stream).await, RESPONSE);
            stream.write_u32(1).await.unwrap();
            stream.write_u32(8).await.unwrap();
            stream.write_all(b"Rejected").await.unwrap();
            assert_eq!(stream.read(&mut [0; 1]).await.unwrap(), 0);
        });
        let error = VncClient::connect(&config, Arc::new(|_| {}))
            .await
            .err()
            .unwrap();
        assert!(error
            .to_string()
            .contains("VNC authentication failed: Rejected"));
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn decodes_low_color_depth_frames_and_rejects_out_of_bounds_rectangles() {
    for (depth, mut raw, rgba) in [
        (8, &[0b111_001_10][..], [255, 36, 170, 255]),
        (16, &[0x1f, 0xf8][..], [255, 0, 255, 255]),
    ] {
        let format = PixelFormat::from_depth(depth).unwrap();
        let frame = format
            .read_raw(&mut raw, (0, 0, 1, 1), (1, 1))
            .await
            .unwrap();
        assert_eq!(frame.rgba_data, rgba);
        assert!(format
            .read_raw(&mut raw, (1, 0, 1, 1), (1, 1))
            .await
            .unwrap_err()
            .to_string()
            .contains("out of bounds"));
    }
}

#[tokio::test]
async fn passwordless_handshake_handles_security_result_by_rfb_version() {
    tokio::time::timeout(Duration::from_secs(5), async {
        for (banner, version) in [
            (b"RFB 003.003\n", 3),
            (b"RFB 003.007\n", 7),
            (b"RFB 003.008\n", 8),
        ] {
            let (mut client, mut server) = tokio::io::duplex(128);
            let server = async {
                server.write_all(banner).await.unwrap();
                expect_wire(&mut server, banner).await;
                if version == 3 {
                    server.write_u32(1).await.unwrap();
                } else {
                    server.write_all(&[1, 1]).await.unwrap();
                    expect_wire(&mut server, &[1]).await;
                }
                if version == 8 {
                    server.write_u32(0).await.unwrap();
                }
                expect_wire(&mut server, &[1]).await;
                server.write_all(&[0, 2, 0, 1]).await.unwrap();
                server.write_all(&[0; 20]).await.unwrap(); // Pixel format and empty name.
            };
            let (result, ()) = tokio::join!(
                rfb::handshake(&mut client, None, PixelFormat::Bgrx8888),
                server
            );
            assert_eq!(result.unwrap(), (2, 1));
        }
    })
    .await
    .unwrap();
}
