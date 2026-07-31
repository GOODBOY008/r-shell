use anyhow::{bail, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

/// Proxy protocol used to tunnel the SSH connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProxyType {
    Http,
    Socks4,
    Socks5,
}

/// Proxy server configuration applied when establishing the SSH connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub proxy_type: ProxyType,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// A TCP stream that may already hold bytes read past the proxy handshake.
///
/// The HTTP CONNECT read loop can consume more bytes than the header (e.g. the
/// server's SSH banner arriving early). Those bytes are parked in `pending` and
/// replayed on the first read so russh sees the full stream.
pub struct Tunnel {
    stream: TcpStream,
    pending: Vec<u8>,
}

impl AsyncRead for Tunnel {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.pending.is_empty() {
            let n = std::cmp::min(buf.remaining(), self.pending.len());
            buf.put_slice(&self.pending[..n]);
            self.pending.drain(..n);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Tunnel {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

/// Establish a TCP tunnel to (host, port) through the configured proxy.
///
/// The returned stream is connected to the target via the proxy's CONNECT
/// handshake and can be handed to russh's `connect_stream` so the SSH handshake
/// runs over the tunnel.
pub async fn connect_via_proxy(
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<Tunnel> {
    let mut stream = tokio::time::timeout(
        timeout,
        TcpStream::connect((proxy.host.as_str(), proxy.port)),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "Proxy connection timed out. Please check the proxy address and network connectivity."
        )
    })?
    .map_err(|e| {
        anyhow::anyhow!(
            "Failed to connect to proxy {}:{}: {}",
            proxy.host,
            proxy.port,
            e
        )
    })?;

    let pending = match proxy.proxy_type {
        ProxyType::Http => {
            http_connect(
                &mut stream,
                host,
                port,
                proxy.username.as_deref(),
                proxy.password.as_deref(),
            )
            .await?
        }
        ProxyType::Socks4 => {
            socks4_connect(&mut stream, host, port, proxy.username.as_deref()).await?;
            Vec::new()
        }
        ProxyType::Socks5 => {
            socks5_connect(
                &mut stream,
                host,
                port,
                proxy.username.as_deref(),
                proxy.password.as_deref(),
            )
            .await?;
            Vec::new()
        }
    };

    Ok(Tunnel { stream, pending })
}

/// Perform an HTTP CONNECT handshake so the stream is tunneled to host:port.
///
/// Returns any bytes read past the header block, which belong to the SSH
/// connection itself.
async fn http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<Vec<u8>> {
    let mut request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if let (Some(u), Some(p)) = (username, password) {
        let credentials = base64::engine::general_purpose::STANDARD.encode(format!("{u}:{p}"));
        request.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
    }
    request.push_str("\r\n");

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to send HTTP CONNECT request: {e}"))?;

    // Read until the terminating empty line, keeping any bytes that arrived
    // past the header (e.g. the SSH banner) for the caller.
    let mut response = Vec::new();
    let mut buf = [0u8; 1024];
    let header_end = loop {
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to read proxy response: {e}"))?;
        if n == 0 {
            bail!("Proxy closed the connection during the CONNECT handshake");
        }
        response.extend_from_slice(&buf[..n]);
        if let Some(pos) = find_header_end(&response) {
            break pos;
        }
    };

    let extra = response.split_off(header_end);
    let header_text = String::from_utf8_lossy(&response);
    let status_line = header_text.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        bail!("HTTP proxy CONNECT failed: {status_line}");
    }
    Ok(extra)
}

/// Returns the index just past the CRLFCRLF that terminates an HTTP header.
fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
}

/// Perform a SOCKS5 handshake (method negotiation + CONNECT with a domain name).
async fn socks5_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<()> {
    // Method negotiation: advertise no-auth plus username/password (RFC 1929)
    // when credentials are provided, no-auth only otherwise.
    let methods: &[u8] = if username.is_some() {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream
        .write_all(methods)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to send SOCKS5 negotiation: {e}"))?;

    let mut resp = [0u8; 2];
    stream
        .read_exact(&mut resp)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read SOCKS5 negotiation response: {e}"))?;
    if resp[0] != 0x05 {
        bail!("SOCKS5: invalid version {}", resp[0]);
    }
    match resp[1] {
        0x00 => {}
        0x02 => {
            let user = username.unwrap_or("");
            let pass = password.unwrap_or("");
            let user_len = user.len().min(255) as u8;
            let pass_len = pass.len().min(255) as u8;
            let mut msg = Vec::with_capacity(1 + 1 + user_len as usize + 1 + pass_len as usize);
            msg.push(0x01); // auth version
            msg.push(user_len);
            msg.extend_from_slice(&user.as_bytes()[..user_len as usize]);
            msg.push(pass_len);
            msg.extend_from_slice(&pass.as_bytes()[..pass_len as usize]);
            stream
                .write_all(&msg)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to send SOCKS5 credentials: {e}"))?;

            let mut auth_resp = [0u8; 2];
            stream
                .read_exact(&mut auth_resp)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to read SOCKS5 auth response: {e}"))?;
            if auth_resp[1] != 0x00 {
                bail!("SOCKS5: username/password authentication failed");
            }
        }
        method => bail!("SOCKS5: no acceptable authentication method (server chose {method})"),
    }

    // CONNECT request with a domain-type address (ATYP = 0x03).
    let host_bytes = host.as_bytes();
    if host_bytes.len() > 255 {
        bail!("SOCKS5: hostname too long");
    }
    let mut msg = Vec::with_capacity(4 + host_bytes.len() + 2);
    msg.push(0x05); // version
    msg.push(0x01); // CONNECT
    msg.push(0x00); // reserved
    msg.push(0x03); // ATYP: domain name
    msg.push(host_bytes.len() as u8);
    msg.extend_from_slice(host_bytes);
    msg.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&msg)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to send SOCKS5 CONNECT request: {e}"))?;

    let mut resp = [0u8; 4];
    stream
        .read_exact(&mut resp)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read SOCKS5 CONNECT response: {e}"))?;
    if resp[0] != 0x05 || resp[1] != 0x00 {
        bail!("SOCKS5: connection failed (reply code {:#x})", resp[1]);
    }

    // Skip the bind address (ATYP + address + port).
    let skip = match resp[3] {
        0x01 => 4 + 2, // IPv4
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to read SOCKS5 address length: {e}"))?;
            len[0] as usize + 2
        }
        0x04 => 16 + 2, // IPv6
        atyp => bail!("SOCKS5: unknown address type {atyp}"),
    };
    let mut skip_buf = vec![0u8; skip];
    stream
        .read_exact(&mut skip_buf)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read SOCKS5 bind address: {e}"))?;

    Ok(())
}

/// Perform a SOCKS4 CONNECT handshake. SOCKS4 only carries IPv4 addresses, so
/// the hostname is resolved locally before the request is sent.
async fn socks4_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    username: Option<&str>,
) -> Result<()> {
    let ip = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| anyhow::anyhow!("SOCKS4: failed to resolve {host}: {e}"))?
        .find_map(|addr| match addr {
            std::net::SocketAddr::V4(v4) => Some(*v4.ip()),
            _ => None,
        })
        .ok_or_else(|| anyhow::anyhow!("SOCKS4: no IPv4 address found for {host}"))?;

    let mut msg = Vec::with_capacity(9);
    msg.push(0x04); // version
    msg.push(0x01); // CONNECT
    msg.extend_from_slice(&port.to_be_bytes());
    msg.extend_from_slice(&ip.octets());
    msg.extend_from_slice(username.unwrap_or("").as_bytes());
    msg.push(0x00);
    stream
        .write_all(&msg)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to send SOCKS4 request: {e}"))?;

    let mut resp = [0u8; 8];
    stream
        .read_exact(&mut resp)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read SOCKS4 response: {e}"))?;
    if resp[0] != 0x00 || resp[1] != 0x5a {
        bail!("SOCKS4: connection failed (reply code {:#x})", resp[1]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn test_proxy(proxy_type: ProxyType) -> ProxyConfig {
        ProxyConfig {
            proxy_type,
            host: "127.0.0.1".to_string(),
            port: 0, // filled in by each test
            username: None,
            password: None,
        }
    }

    /// Read until the blank line that terminates an HTTP header block.
    async fn read_http_headers(sock: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let n = sock.read(&mut chunk).await.unwrap();
            assert!(n > 0, "connection closed mid-header");
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                return buf;
            }
        }
    }

    const TIMEOUT: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn http_connect_success_with_basic_auth() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let request = String::from_utf8_lossy(&read_http_headers(&mut sock).await).to_string();
            assert!(
                request.starts_with("CONNECT example.com:443 HTTP/1.1\r\n"),
                "unexpected request: {request}"
            );
            assert!(
                request.contains("Proxy-Authorization: Basic dXNlcjpwYXNz\r\n"),
                "missing basic auth: {request}"
            );
            sock.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Http);
        proxy.port = addr.port();
        proxy.username = Some("user".to_string());
        proxy.password = Some("pass".to_string());

        let result = connect_via_proxy(&proxy, "example.com", 443, TIMEOUT).await;
        assert!(
            result.is_ok(),
            "HTTP CONNECT should succeed: {:?}",
            result.err()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_connect_keeps_bytes_past_the_header() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            read_http_headers(&mut sock).await;
            // Header and SSH banner arrive in a single write to simulate the
            // bytes being coalesced on the wire.
            sock.write_all(b"HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-test-banner\r\n")
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Http);
        proxy.port = addr.port();

        let mut tunnel = connect_via_proxy(&proxy, "example.com", 443, TIMEOUT)
            .await
            .expect("HTTP CONNECT should succeed");
        let mut banner = String::new();
        // Read from the tunnel: the pending bytes must be replayed first.
        tokio::time::timeout(TIMEOUT, tunnel.read_to_string(&mut banner))
            .await
            .unwrap()
            .unwrap();
        assert!(
            banner.starts_with("SSH-2.0-test-banner"),
            "pending bytes should be replayed, got: {banner}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_connect_rejects_non_200() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            read_http_headers(&mut sock).await;
            sock.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Http);
        proxy.port = addr.port();

        let err = match connect_via_proxy(&proxy, "example.com", 443, TIMEOUT).await {
            Ok(_) => panic!("expected a proxy failure"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("403"),
            "error should mention the status line: {err}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks5_no_auth_success() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();

            // Method negotiation: client advertises no-auth only.
            let mut greeting = [0u8; 3];
            sock.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x00]);
            sock.write_all(&[0x05, 0x00]).await.unwrap();

            // CONNECT request with a domain address.
            let mut req = Vec::new();
            let mut buf = [0u8; 128];
            let n = sock.read(&mut buf).await.unwrap();
            req.extend_from_slice(&buf[..n]);
            assert_eq!(req[0], 0x05); // version
            assert_eq!(req[1], 0x01); // CONNECT
            assert_eq!(req[3], 0x03); // ATYP domain
            assert_eq!(req[4], 11, "example.com is 11 bytes");
            assert_eq!(&req[5..16], b"example.com");
            assert_eq!(&req[16..18], &443u16.to_be_bytes());

            // Success reply with an IPv4 bind address.
            sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x1f, 0x90])
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Socks5);
        proxy.port = addr.port();

        let result = connect_via_proxy(&proxy, "example.com", 443, TIMEOUT).await;
        assert!(result.is_ok(), "SOCKS5 should succeed: {:?}", result.err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks5_username_password_success() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();

            // Greeting advertises no-auth + username/password.
            let mut greeting = [0u8; 4];
            sock.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [0x05, 0x02, 0x00, 0x02]);
            sock.write_all(&[0x05, 0x02]).await.unwrap();

            // RFC 1929 auth: version, ulen, user, plen, pass.
            let mut auth = Vec::new();
            let mut buf = [0u8; 128];
            let n = sock.read(&mut buf).await.unwrap();
            auth.extend_from_slice(&buf[..n]);
            assert_eq!(auth[0], 0x01);
            assert_eq!(auth[1] as usize, 4);
            assert_eq!(&auth[2..6], b"user");
            assert_eq!(auth[6] as usize, 4);
            assert_eq!(&auth[7..11], b"pass");
            sock.write_all(&[0x01, 0x00]).await.unwrap();

            // CONNECT then success. Domain-type request is 18 bytes:
            // ver(1) cmd(1) rsv(1) atyp(1) len(1) host(11) port(2).
            let mut req = [0u8; 18];
            sock.read_exact(&mut req).await.unwrap();
            assert_eq!(req[0], 0x05);
            assert_eq!(req[1], 0x01);
            assert_eq!(req[3], 0x03);
            sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x1f, 0x90])
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Socks5);
        proxy.port = addr.port();
        proxy.username = Some("user".to_string());
        proxy.password = Some("pass".to_string());

        let result = connect_via_proxy(&proxy, "example.com", 443, TIMEOUT).await;
        assert!(
            result.is_ok(),
            "SOCKS5 auth should succeed: {:?}",
            result.err()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks5_rejects_connect_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            sock.read_exact(&mut greeting).await.unwrap();
            sock.write_all(&[0x05, 0x00]).await.unwrap();
            let mut req = [0u8; 18];
            sock.read_exact(&mut req).await.unwrap();
            // Connection refused (0x05).
            sock.write_all(&[0x05, 0x05, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x1f, 0x90])
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Socks5);
        proxy.port = addr.port();

        let err = match connect_via_proxy(&proxy, "example.com", 443, TIMEOUT).await {
            Ok(_) => panic!("expected a proxy failure"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("0x5"),
            "error should mention code: {err}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks4_success() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 128];
            let n = sock.read(&mut buf).await.unwrap();
            req.extend_from_slice(&buf[..n]);
            assert_eq!(req[0], 0x04);
            assert_eq!(req[1], 0x01);
            // Host is resolved to 127.0.0.1 in the test, so the address bytes
            // carry the loopback IP.
            assert_eq!(&req[4..8], &[127, 0, 0, 1]);
            sock.write_all(&[0x00, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Socks4);
        proxy.port = addr.port();

        // Use a literal IPv4 host so lookup_host resolves without DNS.
        let result = connect_via_proxy(&proxy, "127.0.0.1", 22, TIMEOUT).await;
        assert!(result.is_ok(), "SOCKS4 should succeed: {:?}", result.err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks4_rejects_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 128];
            sock.read(&mut buf).await.unwrap();
            sock.write_all(&[0x00, 0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
                .await
                .unwrap();
        });

        let mut proxy = test_proxy(ProxyType::Socks4);
        proxy.port = addr.port();

        let err = match connect_via_proxy(&proxy, "127.0.0.1", 22, TIMEOUT).await {
            Ok(_) => panic!("expected a proxy failure"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("0x5b"),
            "error should mention code: {err}"
        );
        server.await.unwrap();
    }
}
