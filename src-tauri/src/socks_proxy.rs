use anyhow::Result;
use russh::ChannelMsg;
use russh::client::Msg;
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

    tracing::info!(
        "SOCKS proxy listening on {bind_addr}:{actual_port} (requested {bind_port})"
    );

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
    let mut buf = [0u8; 1024];
    let n = stream.peek(&mut buf).await?;

    if n < 2 {
        return Err(anyhow::anyhow!("SOCKS header too short"));
    }

    match buf[0] {
        // ── SOCKS4 / SOCKS4a ──────────────────────────────────────────
        0x04 => {
            // Read the full 8-byte header
            let mut header = [0u8; 8];
            stream.read_exact(&mut header).await?;
            let cmd = header[1];
            if cmd != 1 {
                send_socks4_reply(&mut stream, 0x5b).await?;
                return Err(anyhow::anyhow!("SOCKS4 only supports CONNECT (1), got {cmd}"));
            }
            let port = u16::from_be_bytes([header[2], header[3]]);
            let ip_bytes = [header[4], header[5], header[6], header[7]];

            // SOCKS4a: domain name follows if ip is 0.0.0.x (with x != 0)
            let host = if ip_bytes[0] == 0 && ip_bytes[1] == 0 && ip_bytes[2] == 0 && ip_bytes[3] != 0
            {
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
            let nmethods = buf[1] as usize;
            if n < 2 + nmethods {
                return Err(anyhow::anyhow!("SOCKS5 method list truncated"));
            }
            // Consume the method list
            let mut method_hdr = vec![0u8; 2 + nmethods];
            stream.read_exact(&mut method_hdr).await?;
            let methods = &method_hdr[2..];
            if !methods.contains(&0x00) {
                send_socks5_method_response(&mut stream, 0xff).await?;
                return Err(anyhow::anyhow!("SOCKS5: no auth method (0x00) not offered by client"));
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
                    (std::net::Ipv4Addr::from(addr).to_string(), u16::from_be_bytes(p))
                }
                3 => {
                    let mut len = [0u8; 1];
                    stream.read_exact(&mut len).await?;
                    let mut domain = vec![0u8; len[0] as usize];
                    stream.read_exact(&mut domain).await?;
                    let mut p = [0u8; 2];
                    stream.read_exact(&mut p).await?;
                    (String::from_utf8_lossy(&domain).to_string(), u16::from_be_bytes(p))
                }
                4 => {
                    let mut addr = [0u8; 16];
                    stream.read_exact(&mut addr).await?;
                    let mut p = [0u8; 2];
                    stream.read_exact(&mut p).await?;
                    (std::net::Ipv6Addr::from(addr).to_string(), u16::from_be_bytes(p))
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
                    send_socks5_reply(&mut stream, 0x01).await?;
                    return Err(anyhow::anyhow!("SSH direct-tcpip failed: {e}"));
                }
            };

            send_socks5_reply(&mut stream, 0x00).await?;

            relay_with_cancel(stream, channel, cancel).await
        }

        _ => Err(anyhow::anyhow!("Unknown SOCKS version: {}", buf[0])),
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
        0x05,       // VER
        rep,        // REP
        0x00,       // RSV
        0x01,       // ATYP = IPv4
        0x00, 0x00, 0x00, 0x00,  // BND.ADDR = 0.0.0.0
        0x00, 0x00, // BND.PORT = 0
    ];
    stream.write_all(&reply).await?;
    Ok(())
}
