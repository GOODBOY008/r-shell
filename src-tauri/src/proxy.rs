//! Proxy tunnel establishment for SSH / SFTP / FTP connections.
//!
//! Supports HTTP CONNECT, SOCKS4 / SOCKS4a, and SOCKS5 (with optional
//! username/password authentication). All three protocols return a plain
//! [`tokio::net::TcpStream`] once the tunnel is established, so the same
//! stream can be handed to `russh::client::connect_stream` (SSH/SFTP) or
//! `suppaftp::AsyncFtpStream::connect_with_stream` (FTP/FTPS) without any
//! further wrapping.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Proxy protocol type. `None` is treated identically to a missing
/// `ProxyConfig` — a direct TCP connection to the target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyType {
    Http,
    Socks4,
    Socks5,
    /// Sentinel value that lets the frontend send `proxyType: "none"`
    /// without breaking deserialization. `is_enabled()` reports false.
    None,
}

/// Configuration for connecting through a proxy. Mirrors the frontend
/// `ConnectionConfig.proxy*` fields. When `proxy_type` is `None`, callers
/// should fall back to a direct connection.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProxyConfig {
    pub proxy_type: Option<ProxyType>,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ProxyConfig {
    /// Returns `true` when the configuration actually requests a proxy.
    /// A config with `proxy_type = None`, `ProxyType::None`, or an empty
    /// host is treated as "no proxy" so that legacy callers passing an
    /// empty struct get direct-connect behaviour for free.
    pub fn is_enabled(&self) -> bool {
        match &self.proxy_type {
            Some(ProxyType::None) => false,
            Some(_) if !self.host.is_empty() => true,
            _ => false,
        }
    }
}

/// Establish a TCP connection to `target_host:target_port`, optionally
/// tunneled through the proxy described by `proxy`.
///
/// - If `proxy` is `None` or reports `!is_enabled()`, a direct
///   `TcpStream::connect` is performed.
/// - Otherwise the proxy is contacted first, the appropriate handshake is
///   performed, and the resulting tunnelled `TcpStream` is returned.
///
/// The returned stream is a fully transparent TCP byte channel — callers
/// can layer SSH, SFTP, FTP, or TLS on top without knowing a proxy is in
/// the path.
pub async fn connect_via_proxy(
    target_host: &str,
    target_port: u16,
    proxy: Option<&ProxyConfig>,
) -> Result<TcpStream> {
    let connect_timeout = Duration::from_secs(15);

    // No proxy → direct connect.
    let proxy = match proxy {
        Some(p) if p.is_enabled() => p,
        _ => {
            let stream = tokio::time::timeout(
                connect_timeout,
                TcpStream::connect((target_host, target_port)),
            )
            .await
            .map_err(|_| {
                anyhow!(
                    "Connection to {}:{} timed out after 15s",
                    target_host,
                    target_port
                )
            })??;
            return Ok(stream);
        }
    };

    tracing::info!(
        "Connecting to {}:{} via {} proxy {}:{}",
        target_host,
        target_port,
        match proxy.proxy_type {
            Some(ProxyType::Http) => "HTTP",
            Some(ProxyType::Socks4) => "SOCKS4",
            Some(ProxyType::Socks5) => "SOCKS5",
            None => "unknown",
            Some(ProxyType::None) => "none",
        },
        proxy.host,
        proxy.port
    );

    // Connect to the proxy itself first, with the same timeout.
    let mut stream = tokio::time::timeout(
        connect_timeout,
        TcpStream::connect((proxy.host.as_str(), proxy.port)),
    )
    .await
    .map_err(|_| {
        anyhow!(
            "Connecting to proxy {}:{} timed out after 15s",
            proxy.host,
            proxy.port
        )
    })?
    .map_err(|e| anyhow!("Failed to reach proxy {}:{}: {}", proxy.host, proxy.port, e))?;

    // Disable Nagle on the tunnel — interactive terminals want low latency.
    let _ = stream.set_nodelay(true);

    match proxy.proxy_type {
        Some(ProxyType::Http) => {
            http_connect(&mut stream, target_host, target_port, proxy).await?
        }
        Some(ProxyType::Socks4) => {
            socks4_connect(&mut stream, target_host, target_port, proxy).await?
        }
        Some(ProxyType::Socks5) => {
            socks5_connect(&mut stream, target_host, target_port, proxy).await?
        }
        // Unreachable: is_enabled() filters these out before we get here.
        Some(ProxyType::None) | None => {
            return Err(anyhow!("Proxy type is none but is_enabled() returned true"))
        }
    }

    Ok(stream)
}

// ---------------------------------------------------------------------------
// HTTP CONNECT — RFC 7231 §4.3.6
// ---------------------------------------------------------------------------

async fn http_connect(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    proxy: &ProxyConfig,
) -> Result<()> {
    let host_port = format!("{}:{}", target_host, target_port);

    let mut request = format!(
        "CONNECT {host_port} HTTP/1.1\r\nHost: {host_port}\r\nUser-Agent: r-shell\r\n"
    );

    // Proxy authentication (Basic).
    if let (Some(user), Some(pass)) = (proxy.username.as_ref(), proxy.password.as_ref()) {
        if !user.is_empty() {
            let credentials = base64_encode(format!("{}:{}", user, pass).as_bytes());
            request.push_str(&format!("Proxy-Authorization: Basic {}\r\n", credentials));
        }
    }
    request.push_str("\r\n");

    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    // Read the HTTP response line + headers up to the blank line.
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            return Err(anyhow!("HTTP proxy closed connection during CONNECT"));
        }
        buf.push(byte[0]);
        // End of headers is `\r\n\r\n`.
        if buf.len() >= 4 && &buf[buf.len() - 4..] == b"\r\n\r\n" {
            break;
        }
        if buf.len() > 8192 {
            return Err(anyhow!("HTTP proxy response too large (>{})", buf.len()));
        }
    }

    let response = String::from_utf8_lossy(&buf);
    let status_line = response
        .lines()
        .next()
        .ok_or_else(|| anyhow!("Empty HTTP proxy response"))?;

    // Status line looks like `HTTP/1.1 200 Connection established\r\n`.
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| anyhow!("Malformed HTTP proxy status line: {}", status_line))?;

    if status_code != "200" {
        // Trim trailing CR if present for a cleaner error message.
        return Err(anyhow!(
            "HTTP proxy refused CONNECT to {}: status {} ({})",
            host_port,
            status_code,
            status_line.trim_end_matches('\r')
        ));
    }

    tracing::debug!("HTTP proxy tunnel established to {}", host_port);
    Ok(())
}

// ---------------------------------------------------------------------------
// SOCKS4 / SOCKS4a — no auth, or userid only (ignored by most servers)
// ---------------------------------------------------------------------------

async fn socks4_connect(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    proxy: &ProxyConfig,
) -> Result<()> {
    // SOCKS4 request: VN=0x04, CD=0x01 (CONNECT), DSTPORT (2 bytes, BE),
    // DSTIP (4 bytes), USERID (null-terminated). For SOCKS4a, DSTIP is set to
    // 0.0.0.x (x != 0) and the hostname is appended after the USERID.
    let port_bytes = target_port.to_be_bytes();

    // Try to parse the host as an IPv4 address. If it succeeds we use plain
    // SOCKS4; otherwise we fall back to SOCKS4a with a domain literal.
    let ip_bytes: Option<[u8; 4]> = target_host
        .parse::<std::net::Ipv4Addr>()
        .ok()
        .map(|ip| ip.octets());

    let userid = proxy.username.as_deref().unwrap_or("");

    let mut packet = Vec::with_capacity(32);
    packet.push(0x04); // VN
    packet.push(0x01); // CD = CONNECT
    packet.extend_from_slice(&port_bytes);

    let is_socks4a = ip_bytes.is_none();
    if let Some(ip) = ip_bytes {
        packet.extend_from_slice(&ip);
    } else {
        // SOCKS4a indicator: 0.0.0.x with non-zero last octet.
        packet.extend_from_slice(&[0, 0, 0, 1]);
    }
    packet.extend_from_slice(userid.as_bytes());
    packet.push(0x00); // terminate USERID

    if is_socks4a {
        packet.extend_from_slice(target_host.as_bytes());
        packet.push(0x00); // terminate DOMAIN
    }

    stream.write_all(&packet).await?;
    stream.flush().await?;

    // Reply is 8 bytes: VN=0x00, CD (status), DSTPORT (2), DSTIP (4).
    let mut reply = [0u8; 8];
    stream.read_exact(&mut reply).await?;

    // CD: 0x5A = request granted; anything else is a failure variant.
    let status = reply[1];
    if status != 0x5A {
        return Err(anyhow!(
            "SOCKS4 proxy rejected connection to {}:{} (status 0x{:02X})",
            target_host,
            target_port,
            status
        ));
    }

    tracing::debug!("SOCKS4{} tunnel established to {}:{}", if is_socks4a { "a" } else { "" }, target_host, target_port);
    Ok(())
}

// ---------------------------------------------------------------------------
// SOCKS5 — RFC 1928, with RFC 1929 user/pass auth
// ---------------------------------------------------------------------------

async fn socks5_connect(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    proxy: &ProxyConfig,
) -> Result<()> {
    let has_auth = proxy
        .username
        .as_ref()
        .map(|u| !u.is_empty())
        .unwrap_or(false);

    // Greeting: VER=5, NMETHODS, METHODS. 0x00 = no auth, 0x02 = user/pass.
    let greeting: &[u8] = if has_auth {
        &[0x05, 0x01, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream.write_all(greeting).await?;
    stream.flush().await?;

    // Server picks a method: VER=5, METHOD.
    let mut method = [0u8; 2];
    stream.read_exact(&mut method).await?;
    if method[0] != 0x05 {
        return Err(anyhow!("SOCKS5 proxy returned unexpected version 0x{:02X}", method[0]));
    }
    match method[1] {
        0x00 => { /* no auth */ }
        0x02 => {
            // RFC 1929 user/pass sub-negotiation.
            let user = proxy.username.as_deref().unwrap_or("");
            let pass = proxy.password.as_deref().unwrap_or("");
            if user.len() > 255 || pass.len() > 255 {
                return Err(anyhow!("SOCKS5 username/password must be ≤ 255 bytes"));
            }
            let mut auth = Vec::with_capacity(3 + user.len() + pass.len());
            auth.push(0x01); // sub-negotiation version
            auth.push(user.len() as u8);
            auth.extend_from_slice(user.as_bytes());
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass.as_bytes());
            stream.write_all(&auth).await?;
            stream.flush().await?;

            let mut resp = [0u8; 2];
            stream.read_exact(&mut resp).await?;
            if resp[0] != 0x01 {
                return Err(anyhow!("SOCKS5 auth returned unexpected version 0x{:02X}", resp[0]));
            }
            if resp[1] != 0x00 {
                return Err(anyhow!("SOCKS5 proxy authentication failed (status 0x{:02X})", resp[1]));
            }
        }
        0xFF => {
            return Err(anyhow!("SOCKS5 proxy offered no acceptable auth method"));
        }
        other => {
            return Err(anyhow!("SOCKS5 proxy selected unsupported method 0x{:02X}", other));
        }
    }

    // CONNECT request: VER=5, CMD=1 (CONNECT), RSV=0, ATYP, DST.ADDR, DST.PORT
    let mut req = Vec::with_capacity(32);
    req.push(0x05);
    req.push(0x01);
    req.push(0x00);

    if let Ok(ip) = target_host.parse::<std::net::Ipv4Addr>() {
        req.push(0x01); // IPv4
        req.extend_from_slice(&ip.octets());
    } else if let Ok(ip) = target_host.parse::<std::net::Ipv6Addr>() {
        req.push(0x04); // IPv6
        req.extend_from_slice(&ip.octets());
    } else {
        req.push(0x03); // domain
        let host_bytes = target_host.as_bytes();
        if host_bytes.len() > 255 {
            return Err(anyhow!("SOCKS5 target hostname too long ({} bytes)", host_bytes.len()));
        }
        req.push(host_bytes.len() as u8);
        req.extend_from_slice(host_bytes);
    }
    req.extend_from_slice(&target_port.to_be_bytes());

    stream.write_all(&req).await?;
    stream.flush().await?;

    // Reply: VER, REP, RSV, ATYP, BND.ADDR, BND.PORT.
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 0x05 {
        return Err(anyhow!("SOCKS5 reply version 0x{:02X}", header[0]));
    }
    if header[1] != 0x00 {
        return Err(anyhow!(
            "SOCKS5 proxy refused connection to {}:{} (reply 0x{:02X}: {})",
            target_host,
            target_port,
            header[1],
            socks5_reply_str(header[1])
        ));
    }

    // Discard the bound-address field — its length depends on ATYP.
    let addr_len = match header[3] {
        0x01 => 4,  // IPv4
        0x04 => 16, // IPv6
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            len[0] as usize
        }
        other => return Err(anyhow!("SOCKS5 reply has unknown ATYP 0x{:02X}", other)),
    };
    let mut addr = vec![0u8; addr_len];
    stream.read_exact(&mut addr).await?;
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await?;

    tracing::debug!("SOCKS5 tunnel established to {}:{}", target_host, target_port);
    Ok(())
}

fn socks5_reply_str(code: u8) -> &'static str {
    match code {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown error",
    }
}

// ---------------------------------------------------------------------------
// Minimal Base64 encoder — avoids pulling in a new crate for one call site.
// Standard alphabet, no padding stripping (we always pad to a 4-byte boundary).
// ---------------------------------------------------------------------------

fn base64_encode(input: &[u8]) -> String {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let chunks = input.chunks(3);
    for chunk in chunks {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);

        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHA[((n >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHA[(n & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_config_disabled_when_type_none() {
        let cfg = ProxyConfig {
            proxy_type: None,
            host: "proxy.example.com".to_string(),
            port: 8080,
            ..Default::default()
        };
        assert!(!cfg.is_enabled());
    }

    #[test]
    fn proxy_config_disabled_when_proxy_type_is_none_variant() {
        // Frontend sends `proxyType: "none"` — deserialized to ProxyType::None.
        let cfg = ProxyConfig {
            proxy_type: Some(ProxyType::None),
            host: "proxy.example.com".to_string(),
            port: 8080,
            ..Default::default()
        };
        assert!(!cfg.is_enabled());
    }

    #[test]
    fn proxy_config_disabled_when_host_empty() {
        let cfg = ProxyConfig {
            proxy_type: Some(ProxyType::Socks5),
            host: "".to_string(),
            port: 1080,
            ..Default::default()
        };
        assert!(!cfg.is_enabled());
    }

    #[test]
    fn proxy_config_enabled_when_type_and_host_present() {
        let cfg = ProxyConfig {
            proxy_type: Some(ProxyType::Http),
            host: "proxy.example.com".to_string(),
            port: 8080,
            ..Default::default()
        };
        assert!(cfg.is_enabled());
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // RFC 1929 example credentials "user:pass"
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
    }

    #[test]
    fn socks5_reply_str_covers_known_codes() {
        assert_eq!(socks5_reply_str(0x05), "connection refused");
        assert_eq!(socks5_reply_str(0x08), "address type not supported");
        assert_eq!(socks5_reply_str(0xFF), "unknown error");
    }

    /// Drives the HTTP CONNECT handshake against an in-memory pipe and
    /// verifies that the request line, Proxy-Authorization header, and
    /// response parsing all behave.
    #[tokio::test]
    async fn http_connect_handshake_with_auth() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Build a fake proxy by pairing two ends of a TCP loopback.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 256];
            let n = sock.read(&mut buf).await.unwrap();
            let req = std::str::from_utf8(&buf[..n]).unwrap();
            assert!(req.starts_with("CONNECT target.example.com:22 HTTP/1.1\r\n"));
            assert!(req.contains("Proxy-Authorization: Basic dXNlcjpwYXNz\r\n"));
            sock.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
        });

        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let proxy_cfg = ProxyConfig {
            proxy_type: Some(ProxyType::Http),
            host: "127.0.0.1".to_string(),
            port: proxy_addr.port(),
            username: Some("user".to_string()),
            password: Some("pass".to_string()),
            ..Default::default()
        };
        http_connect(&mut client, "target.example.com", 22, &proxy_cfg)
            .await
            .unwrap();
        server.await.unwrap();
    }

    /// Same idea for SOCKS5: a fake proxy that speaks the RFC 1928/1929
    /// handshake with username/password auth and verifies every byte we send.
    #[tokio::test]
    async fn socks5_connect_handshake_with_auth() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();

            // Greeting: client offers user/pass (0x02).
            let mut g = [0u8; 3];
            sock.read_exact(&mut g).await.unwrap();
            assert_eq!(g, [0x05, 0x01, 0x02]);
            sock.write_all(&[0x05, 0x02]).await.unwrap();

            // User/pass sub-negotiation: VER=1, ULEN, UNAME, PLEN, PASSWD.
            let mut hdr = [0u8; 2];
            sock.read_exact(&mut hdr).await.unwrap();
            assert_eq!(hdr[0], 0x01);
            assert_eq!(hdr[1] as usize, 3); // "joe"
            let mut user = [0u8; 3];
            sock.read_exact(&mut user).await.unwrap();
            assert_eq!(&user, b"joe");
            let mut plen = [0u8; 1];
            sock.read_exact(&mut plen).await.unwrap();
            assert_eq!(plen[0] as usize, 2); // "pw"
            let mut pass = [0u8; 2];
            sock.read_exact(&mut pass).await.unwrap();
            assert_eq!(&pass, b"pw");
            sock.write_all(&[0x01, 0x00]).await.unwrap(); // auth OK

            // CONNECT request: domain "target.example.com", port 22.
            let mut prefix = [0u8; 5]; // VER, CMD, RSV, ATYP, DLEN
            sock.read_exact(&mut prefix).await.unwrap();
            assert_eq!(prefix[0..4], [0x05, 0x01, 0x00, 0x03]);
            let dlen = prefix[4] as usize;
            assert_eq!(dlen, "target.example.com".len());
            let mut domain = vec![0u8; dlen];
            sock.read_exact(&mut domain).await.unwrap();
            assert_eq!(domain, b"target.example.com");
            let mut port = [0u8; 2];
            sock.read_exact(&mut port).await.unwrap();
            assert_eq!(port, [0x00, 22]);

            // Reply: success, bound address 0.0.0.0:0 (ATYP=IPv4).
            sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
        });

        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let proxy_cfg = ProxyConfig {
            proxy_type: Some(ProxyType::Socks5),
            host: "127.0.0.1".to_string(),
            port: proxy_addr.port(),
            username: Some("joe".to_string()),
            password: Some("pw".to_string()),
            ..Default::default()
        };
        socks5_connect(&mut client, "target.example.com", 22, &proxy_cfg)
            .await
            .unwrap();
        server.await.unwrap();
    }

    /// SOCKS5 with no auth and an IPv4 target — verifies the connect request
    /// is well-formed and the success reply is accepted.
    #[tokio::test]
    async fn socks5_connect_handshake_no_auth_ipv4() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Greeting: no-auth only.
            let mut g = [0u8; 3];
            sock.read_exact(&mut g).await.unwrap();
            assert_eq!(g, [0x05, 0x01, 0x00]);
            sock.write_all(&[0x05, 0x00]).await.unwrap();

            // CONNECT request: VER 5, CMD 1, RSV 0, ATYP 1 (IPv4), 127.0.0.1, port 22.
            let mut req = [0u8; 10];
            sock.read_exact(&mut req).await.unwrap();
            assert_eq!(req[0..4], [0x05, 0x01, 0x00, 0x01]);
            assert_eq!(req[4..8], [127, 0, 0, 1]);
            assert_eq!(req[8..10], [0x00, 22]);

            // Reply: success, bound address 0.0.0.0:0.
            sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
        });

        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let proxy_cfg = ProxyConfig {
            proxy_type: Some(ProxyType::Socks5),
            host: "127.0.0.1".to_string(),
            port: proxy_addr.port(),
            ..Default::default()
        };
        socks5_connect(&mut client, "127.0.0.1", 22, &proxy_cfg)
            .await
            .unwrap();
        server.await.unwrap();
    }

    /// SOCKS4a with a domain target — verifies the 0.0.0.x indicator and
    /// trailing null-terminated domain are sent correctly.
    #[tokio::test]
    async fn socks4a_connect_handshake_domain() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Read the 9-byte fixed prefix (VN, CD, PORT, IP, USERID terminator).
            let mut buf = [0u8; 9];
            sock.read_exact(&mut buf).await.unwrap();
            assert_eq!(buf[0], 0x04);
            assert_eq!(buf[1], 0x01);
            assert_eq!(buf[2..4], [0x00, 22]);
            // 0.0.0.1 indicator → SOCKS4a.
            assert_eq!(buf[4..8], [0, 0, 0, 1]);
            assert_eq!(buf[8], 0); // empty USERID terminator
            // Then the domain + terminator.
            let mut domain = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                sock.read_exact(&mut byte).await.unwrap();
                if byte[0] == 0 {
                    break;
                }
                domain.push(byte[0]);
            }
            assert_eq!(domain, b"target.example.com");
            // Reply: success (0x5A).
            sock.write_all(&[0x00, 0x5A, 0, 0, 0, 0, 0, 0]).await.unwrap();
        });

        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let proxy_cfg = ProxyConfig {
            proxy_type: Some(ProxyType::Socks4),
            host: "127.0.0.1".to_string(),
            port: proxy_addr.port(),
            ..Default::default()
        };
        socks4_connect(&mut client, "target.example.com", 22, &proxy_cfg)
            .await
            .unwrap();
        server.await.unwrap();
    }
}
