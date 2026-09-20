use anyhow::Result;
use russh::client::Msg;
use russh::ChannelMsg;
use socket2::{Domain, Protocol, Socket, Type};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use crate::ssh::Client;

/// Read bytes from `stream` until a null byte (0x00) is encountered.
/// Returns everything up to **and including** the null byte.
async fn read_until_null(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut single = [0u8; 1];
    loop {
        stream.read_exact(&mut single).await?;
        buf.push(single[0]);
        if single[0] == 0 {
            return Ok(buf);
        }
    }
}

/// Create a TCP listener with `SO_REUSEADDR` enabled so that restarting a
/// SOCKS proxy on the same port works immediately, even if the previous
/// listener's socket is still in `TIME_WAIT` (common on Windows).
fn bind_with_reuseaddr(addr: SocketAddr) -> Result<tokio::net::TcpListener> {
    let socket = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    socket.bind(&addr.into())?;
    socket.listen(128)?;
    socket.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(socket.into())?;
    Ok(listener)
}

/// Start a SOCKS4/5 proxy on `bind_addr:bind_port` that forwards through the
/// given SSH `handle`.  Returns the actual port the listener is bound to.
///
/// The proxy runs until `cancel` is fired, at which point the listener is
/// torn down and all in-flight connections are dropped.
pub async fn start_socks_proxy(
    ssh_handle: Arc<russh::client::Handle<Client>>,
    bind_addr: String,
    bind_port: u16,
    cancel: CancellationToken,
) -> Result<u16> {
    let addr: SocketAddr = format!("{bind_addr}:{bind_port}")
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid bind address {bind_addr}:{bind_port}: {e}"))?;

    let listener = bind_with_reuseaddr(addr)?;
    let actual_port = listener.local_addr()?.port();

    tracing::info!("SOCKS proxy listening on {bind_addr}:{actual_port} (requested {bind_port})");

    let accept_cancel = cancel.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = accept_cancel.cancelled() => {
                    tracing::info!("SOCKS proxy on {bind_addr}:{actual_port} shutting down");
                    break;
                }
                accept = listener.accept() => {
                    match accept {
                        Ok((stream, peer)) => {
                            tracing::debug!("SOCKS connection from {peer}");
                            let handle = ssh_handle.clone();
                            let peer_cancel = cancel.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_socks_connection(stream, handle, peer_cancel).await {
                                    tracing::warn!("SOCKS connection from {peer} failed: {e}");
                                }
                            });
                        }
                        Err(e) => {
                            tracing::error!("SOCKS accept error: {e}");
                        }
                    }
                }
            }
        }

        tracing::debug!("SOCKS proxy accept loop exited");
    });

    Ok(actual_port)
}

// ── SOCKS4 / SOCKS5 connection handler ──────────────────────────────────

async fn handle_socks_connection(
    mut stream: TcpStream,
    ssh_handle: Arc<russh::client::Handle<Client>>,
    cancel: CancellationToken,
) -> Result<()> {
    // Read the fixed greeting first: version byte + one protocol-specific
    // byte (SOCKS4 command / SOCKS5 method count). Reading exactly this much
    // — instead of peeking — tolerates clients whose greeting arrives split
    // across TCP segments.
    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).await?;

    match greeting[0] {
        // ── SOCKS4 / SOCKS4a ──────────────────────────────────────────
        0x04 => {
            let cmd = greeting[1];
            if cmd != 1 {
                send_socks4_reply(&mut stream, 0x5b).await?;
                return Err(anyhow::anyhow!(
                    "SOCKS4 only supports CONNECT (1), got {cmd}"
                ));
            }
            // Remainder of the 8-byte header: DSTPORT(2) + DSTIP(4)
            let mut rest = [0u8; 6];
            stream.read_exact(&mut rest).await?;
            let port = u16::from_be_bytes([rest[0], rest[1]]);
            let ip_bytes = [rest[2], rest[3], rest[4], rest[5]];

            // SOCKS4a: domain name follows if ip is 0.0.0.x (with x != 0)
            let host =
                if ip_bytes[0] == 0 && ip_bytes[1] == 0 && ip_bytes[2] == 0 && ip_bytes[3] != 0 {
                    // SOCKS4a: read USERID (null-terminated), then domain name (null-terminated)
                    let _userid = read_until_null(&mut stream).await?;
                    let mut domain = read_until_null(&mut stream).await?;
                    if !domain.is_empty() && domain[domain.len() - 1] == 0 {
                        domain.pop();
                    }
                    String::from_utf8_lossy(&domain).to_string()
                } else {
                    // SOCKS4: read and discard USERID
                    let _userid = read_until_null(&mut stream).await?;
                    std::net::Ipv4Addr::from(ip_bytes).to_string()
                };

            tracing::debug!("SOCKS4 CONNECT {host}:{port}");

            let channel = match ssh_handle
                .channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", 0)
                .await
            {
                Ok(ch) => {
                    tracing::debug!("SSH direct-tcpip channel opened to {host}:{port}");
                    ch
                }
                Err(e) => {
                    tracing::warn!("SSH direct-tcpip failed to {host}:{port}: {e}");
                    send_socks4_reply(&mut stream, 0x5b).await?;
                    return Err(anyhow::anyhow!("SSH direct-tcpip failed: {e}"));
                }
            };

            send_socks4_reply(&mut stream, 0x5a).await?;

            relay_with_cancel(stream, channel, cancel).await
        }

        // ── SOCKS5 ────────────────────────────────────────────────────
        0x05 => {
            let nmethods = greeting[1] as usize;
            let mut methods = vec![0u8; nmethods];
            stream.read_exact(&mut methods).await?;
            if !methods.contains(&0x00) {
                send_socks5_method_response(&mut stream, 0xff).await?;
                return Err(anyhow::anyhow!(
                    "SOCKS5: no auth method (0x00) not offered by client"
                ));
            }
            send_socks5_method_response(&mut stream, 0x00).await?;

            // Read CONNECT request (VER, CMD, RSV, ATYP)
            let mut hdr = [0u8; 4];
            stream.read_exact(&mut hdr).await?;
            if hdr[0] != 5 || hdr[1] != 1 {
                send_socks5_reply(&mut stream, 0x07).await?;
                return Err(anyhow::anyhow!("SOCKS5 only supports CONNECT (1)"));
            }
            let atyp = hdr[3];

            let (host, port) = match atyp {
                1 => {
                    let mut addr = [0u8; 4];
                    stream.read_exact(&mut addr).await?;
                    let mut p = [0u8; 2];
                    stream.read_exact(&mut p).await?;
                    (
                        std::net::Ipv4Addr::from(addr).to_string(),
                        u16::from_be_bytes(p),
                    )
                }
                3 => {
                    let mut len = [0u8; 1];
                    stream.read_exact(&mut len).await?;
                    let mut domain = vec![0u8; len[0] as usize];
                    stream.read_exact(&mut domain).await?;
                    let mut p = [0u8; 2];
                    stream.read_exact(&mut p).await?;
                    (
                        String::from_utf8_lossy(&domain).to_string(),
                        u16::from_be_bytes(p),
                    )
                }
                4 => {
                    let mut addr = [0u8; 16];
                    stream.read_exact(&mut addr).await?;
                    let mut p = [0u8; 2];
                    stream.read_exact(&mut p).await?;
                    (
                        std::net::Ipv6Addr::from(addr).to_string(),
                        u16::from_be_bytes(p),
                    )
                }
                _ => {
                    send_socks5_reply(&mut stream, 0x08).await?;
                    return Err(anyhow::anyhow!("SOCKS5 unknown address type {atyp}"));
                }
            };

            tracing::debug!("SOCKS5 CONNECT {host}:{port}");

            let channel = match ssh_handle
                .channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", 0)
                .await
            {
                Ok(ch) => {
                    tracing::debug!("SSH direct-tcpip channel opened to {host}:{port}");
                    ch
                }
                Err(e) => {
                    tracing::warn!("SSH direct-tcpip failed to {host}:{port}: {e}");
                    let rep = socks5_rep_for_channel_error(&e);
                    send_socks5_reply(&mut stream, rep).await?;
                    return Err(anyhow::anyhow!("SSH direct-tcpip failed: {e}"));
                }
            };

            send_socks5_reply(&mut stream, 0x00).await?;

            relay_with_cancel(stream, channel, cancel).await
        }

        _ => Err(anyhow::anyhow!("Unknown SOCKS version: {}", greeting[0])),
    }
}

// ── bidirectional relay ─────────────────────────────────────────────────

/// Relay data bidirectionally between a local TCP socket and an SSH channel.
///
/// Properly terminates the SSH channel:
/// - Sends `SSH_MSG_CHANNEL_EOF` when local reads EOF
/// - Sends `SSH_MSG_CHANNEL_CLOSE` if the server hasn't already closed
/// - Shuts down the local socket writer on exit
async fn relay_with_cancel(
    local: TcpStream,
    channel: russh::Channel<Msg>,
    cancel: CancellationToken,
) -> Result<()> {
    let (mut local_r, mut local_w) = tokio::io::split(local);
    let mut channel = channel;
    let mut buf = vec![0u8; 65536];
    let mut server_closed = false;

    tracing::debug!("relay started");

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                tracing::debug!("relay cancelled");
                break;
            }
            msg = channel.wait() => {
                match msg {
                    None => {
                        tracing::debug!("relay channel wait returned None (closed)");
                        server_closed = true;
                        break;
                    }
                    Some(ChannelMsg::Data { data }) => {
                        tracing::trace!("relay channel -> local: {} bytes", data.len());
                        if local_w.write_all(&data[..]).await.is_err() {
                            tracing::debug!("relay local write error (peer disconnected)");
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) => {
                        server_closed = true;
                        tracing::debug!("relay received SSH channel close/eof");
                        let _ = local_w.shutdown().await;
                        break;
                    }
                    _ => {}
                }
            }
            result = local_r.read(&mut buf) => {
                match result {
                    Ok(0) => {
                        tracing::debug!("relay local EOF");
                        let _ = channel.eof().await;
                        break;
                    }
                    Ok(n) => {
                        tracing::trace!("relay local -> channel: {} bytes", n);
                        if channel.data(&buf[..n]).await.is_err() {
                            tracing::debug!("relay channel write error");
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::debug!("relay local read error: {e}");
                        break;
                    }
                }
            }
        }
    }

    let _ = local_w.shutdown().await;

    if !server_closed {
        tracing::debug!("relay sending SSH channel close");
        let _ = channel.close().await;
    }

    tracing::debug!("relay finished");
    Ok(())
}

/// Map an SSH channel-open failure to the closest SOCKS5 reply code
/// (RFC 1928 REP): 0x02 "connection not allowed by ruleset" for a forwarding
/// administratively prohibited by the server, 0x05 "connection refused" when
/// the server could not reach the target, 0x01 otherwise.
fn socks5_rep_for_channel_error(e: &russh::Error) -> u8 {
    match e {
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited) => {
            0x02
        }
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed) => 0x05,
        _ => 0x01,
    }
}

// ── SOCKS4 helpers ──────────────────────────────────────────────────────

async fn send_socks4_reply(stream: &mut TcpStream, status: u8) -> Result<()> {
    let reply = [0u8, status, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8];
    stream.write_all(&reply).await?;
    Ok(())
}

// ── SOCKS5 helpers ──────────────────────────────────────────────────────

async fn send_socks5_method_response(stream: &mut TcpStream, method: u8) -> Result<()> {
    stream.write_all(&[0x05, method]).await?;
    Ok(())
}

async fn send_socks5_reply(stream: &mut TcpStream, rep: u8) -> Result<()> {
    let reply = [
        0x05, // VER
        rep,  // REP
        0x00, // RSV
        0x01, // ATYP = IPv4
        0x00, 0x00, 0x00, 0x00, // BND.ADDR = 0.0.0.0
        0x00, 0x00, // BND.PORT = 0
    ];
    stream.write_all(&reply).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    // End-to-end tests against the docker fixture in
    // src-tauri/docker/default-key-sshd (user `testuser`, committed throwaway
    // keypair — see that directory's README). The stock image disables TCP
    // forwarding, so run the container with the override:
    //
    //   docker build -t rshell-default-key-sshd src-tauri/docker/default-key-sshd
    //   docker run -d --name rshell-sshd-default-key -p 2224:22 \
    //     rshell-default-key-sshd /usr/sbin/sshd -D -e -o AllowTcpForwarding=yes
    //
    // Then: cargo test --lib socks_proxy -- --ignored --nocapture
    //
    // The curl test MUST use the multi_thread runtime flavor: a blocking
    // std::process::Command on the default current-thread runtime starves
    // the proxy's accept-loop task and turns every request into a timeout
    // that looks like a relay bug.
    use super::*;
    use crate::ssh::{AuthMethod, SshClient, SshConfig};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn endpoint() -> (String, u16) {
        let host =
            std::env::var("RSHELL_TEST_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("RSHELL_TEST_SSH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(2224);
        (host, port)
    }

    fn fixture_key() -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("docker/default-key-sshd/id_rsa")
            .to_string_lossy()
            .into_owned()
    }

    /// Connect to the fixture over SSH and return the session handle the
    /// SOCKS proxy relays through (the same primitive the Tauri command uses
    /// via ConnectionManager::start_socks_proxy).
    async fn connected_handle() -> (SshClient, Arc<russh::client::Handle<Client>>) {
        let (host, port) = endpoint();
        let mut client = SshClient::new();
        client
            .connect(&SshConfig {
                host,
                port,
                username: "testuser".to_string(),
                auth_method: AuthMethod::PublicKey {
                    key_path: fixture_key(),
                    passphrase: None,
                },
                compression: true,
                keepalive_interval: Some(60),
                keepalive_max: Some(3),
                proxy: None,
                host_key_policy: crate::ssh::HostKeyPolicy::default(),
                tunnel: None,
            })
            .await
            .expect("SSH connect to fixture");
        let handle = client.get_session_handle().expect("session handle");
        (client, handle)
    }

    /// Minimal SOCKS5 client: negotiate no-auth, CONNECT, return the stream
    /// and the reply's REP byte.
    async fn socks5_connect(
        proxy_port: u16,
        atyp: u8,
        host: &str,
        dst_port: u16,
    ) -> (TcpStream, u8) {
        let mut s = TcpStream::connect(("127.0.0.1", proxy_port))
            .await
            .expect("connect to local SOCKS listener");
        s.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut method = [0u8; 2];
        tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut method))
            .await
            .expect("method reply timeout")
            .unwrap();
        assert_eq!([0x05, 0x00], method, "server must pick no-auth");

        let mut req = vec![0x05, 0x01, 0x00, atyp];
        match atyp {
            1 => {
                let ip: std::net::Ipv4Addr = host.parse().expect("ipv4");
                req.extend_from_slice(&ip.octets());
            }
            3 => {
                req.push(host.len() as u8);
                req.extend_from_slice(host.as_bytes());
            }
            _ => panic!("test only uses atyp 1/3"),
        }
        req.extend_from_slice(&dst_port.to_be_bytes());
        s.write_all(&req).await.unwrap();

        let mut reply_head = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut reply_head))
            .await
            .expect("connect reply timeout")
            .unwrap();
        assert_eq!(0x05, reply_head[0], "reply VER");
        let rep = reply_head[1];
        let addr_len = match reply_head[3] {
            1 => 4,
            4 => 16,
            3 => {
                let mut l = [0u8; 1];
                s.read_exact(&mut l).await.unwrap();
                l[0] as usize
            }
            _ => 0,
        };
        let mut rest = vec![0u8; addr_len + 2];
        s.read_exact(&mut rest).await.unwrap();
        (s, rep)
    }

    /// Minimal SOCKS4 client (empty userid).
    async fn socks4_connect(proxy_port: u16, dst_port: u16) -> (TcpStream, u8) {
        let mut s = TcpStream::connect(("127.0.0.1", proxy_port))
            .await
            .expect("connect to local SOCKS listener");
        let port_hi = (dst_port >> 8) as u8;
        let port_lo = (dst_port & 0xff) as u8;
        s.write_all(&[0x04, 0x01, port_hi, port_lo, 127, 0, 0, 1, 0x00])
            .await
            .unwrap();
        let mut reply = [0u8; 8];
        tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut reply))
            .await
            .expect("socks4 reply timeout")
            .unwrap();
        assert_eq!(0, reply[0], "socks4 reply VN");
        (s, reply[1])
    }

    /// Read the target's SSH banner through the relay (server → client).
    async fn read_ssh_banner(s: &mut TcpStream) -> String {
        let mut buf = vec![0u8; 256];
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
            .await
            .expect("banner read timeout")
            .expect("banner read");
        let banner = String::from_utf8_lossy(&buf[..n]).into_owned();
        assert!(
            banner.starts_with("SSH-"),
            "expected SSH banner through relay, got: {banner}"
        );
        banner
    }

    async fn start_proxy_on_ephemeral_port(
        handle: Arc<russh::client::Handle<Client>>,
    ) -> (u16, CancellationToken) {
        let cancel = CancellationToken::new();
        let port = start_socks_proxy(handle, "127.0.0.1".to_string(), 0, cancel.clone())
            .await
            .expect("start proxy");
        assert_ne!(0, port, "ephemeral bind must report a real port");
        (port, cancel)
    }

    #[tokio::test]
    #[ignore]
    async fn socks5_ipv4_relay_is_bidirectional() {
        let (mut client, handle) = connected_handle().await;
        let (port, cancel) = start_proxy_on_ephemeral_port(handle).await;

        let (mut s, rep) = socks5_connect(port, 1, "127.0.0.1", 22).await;
        assert_eq!(0, rep, "SOCKS5 CONNECT to sshd should succeed");

        // server → client: banner arrives through the tunnel
        read_ssh_banner(&mut s).await;

        // client → server: send our banner, the server must keep talking
        s.write_all(b"SSH-2.0-rshell-socks-e2e\r\n").await.unwrap();
        let mut buf = vec![0u8; 512];
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
            .await
            .expect("post-banner read timeout")
            .expect("post-banner read");
        assert!(n > 0, "server should send kexinit after our banner");

        cancel.cancel();
        client.disconnect().await.ok();
    }

    #[tokio::test]
    #[ignore]
    async fn socks5_domain_relay_works() {
        let (mut client, handle) = connected_handle().await;
        let (port, cancel) = start_proxy_on_ephemeral_port(handle).await;

        let (mut s, rep) = socks5_connect(port, 3, "localhost", 22).await;
        assert_eq!(0, rep, "SOCKS5 CONNECT by domain should succeed");
        read_ssh_banner(&mut s).await;

        cancel.cancel();
        client.disconnect().await.ok();
    }

    #[tokio::test]
    #[ignore]
    async fn socks4_relay_works() {
        let (mut client, handle) = connected_handle().await;
        let (port, cancel) = start_proxy_on_ephemeral_port(handle).await;

        let (mut s, status) = socks4_connect(port, 22).await;
        assert_eq!(0x5A, status, "SOCKS4 request granted code");
        read_ssh_banner(&mut s).await;

        cancel.cancel();
        client.disconnect().await.ok();
    }

    #[tokio::test]
    #[ignore]
    async fn refused_target_returns_error_reply() {
        let (mut client, handle) = connected_handle().await;
        let (port, cancel) = start_proxy_on_ephemeral_port(handle).await;

        // Port 9 (discard) is not listening in the Alpine fixture.
        let (_s, rep) = socks5_connect(port, 1, "127.0.0.1", 9).await;
        assert_ne!(0, rep, "refused target must yield a non-zero REP");

        let (_s, status) = socks4_connect(port, 9).await;
        assert_eq!(0x5B, status, "SOCKS4 refused target code");

        cancel.cancel();
        client.disconnect().await.ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn curl_http_through_proxy_end_to_end() {
        // HTTP server on the local host; the container reaches it via
        // host.docker.internal, so the full path is
        // curl → local SOCKS → SSH channel → container → host HTTP server.
        let dir = std::env::temp_dir().join("rshell-socks-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), "socks-e2e-ok").unwrap();

        let mut python = std::process::Command::new("python3")
            .args(["-m", "http.server", "18080", "--bind", "127.0.0.1"])
            .arg("--directory")
            .arg(&dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn python http.server");
        for _ in 0..50 {
            if TcpStream::connect("127.0.0.1:18080").await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let (mut client, handle) = connected_handle().await;
        let (port, cancel) = start_proxy_on_ephemeral_port(handle).await;

        // --socks5-hostname: DNS resolution happens on the SSH side (ATYP=3).
        let out = std::process::Command::new("curl")
            .args([
                "-s",
                "--max-time",
                "10",
                "--socks5-hostname",
                &format!("127.0.0.1:{port}"),
                "http://host.docker.internal:18080/marker.txt",
            ])
            .output()
            .expect("run curl");
        assert!(
            out.status.success(),
            "curl through SOCKS5 failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            "socks-e2e-ok",
            String::from_utf8_lossy(&out.stdout).trim(),
            "HTTP body through the tunnel"
        );

        // --socks4a: remote-DNS SOCKS4 path.
        let out4 = std::process::Command::new("curl")
            .args([
                "-s",
                "--max-time",
                "10",
                "--socks4a",
                &format!("127.0.0.1:{port}"),
                "http://host.docker.internal:18080/marker.txt",
            ])
            .output()
            .expect("run curl socks4a");
        assert!(
            out4.status.success(),
            "curl through SOCKS4a failed: {}",
            String::from_utf8_lossy(&out4.stderr)
        );
        assert_eq!("socks-e2e-ok", String::from_utf8_lossy(&out4.stdout).trim());

        cancel.cancel();
        client.disconnect().await.ok();
        python.kill().ok();
    }

    #[tokio::test]
    #[ignore]
    async fn cancel_shuts_down_listener() {
        let (mut client, handle) = connected_handle().await;
        let (port, cancel) = start_proxy_on_ephemeral_port(handle).await;

        // The listener accepts before cancel…
        TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("listener should accept before cancel");

        cancel.cancel();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let gone = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match TcpStream::connect(("127.0.0.1", port)).await {
                    Ok(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                    Err(_) => return,
                }
            }
        })
        .await;
        assert!(gone.is_ok(), "listener must stop accepting after cancel");

        client.disconnect().await.ok();
    }
}
