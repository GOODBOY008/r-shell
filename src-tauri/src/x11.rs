//! SSH X11 forwarding: DISPLAY parsing, cookie generation, local X-server bridging.

use std::path::PathBuf;

/// Parsed `$DISPLAY` value: how to reach the local X server and which screen.
pub struct ParsedDisplay {
    server: LocalXServer,
    screen: u32,
}

enum LocalXServer {
    /// Unix domain socket, e.g. `/tmp/.X11-unix/X0`.
    Unix(PathBuf),
    /// TCP endpoint: a host (DNS name or literal IP) and port. The host is
    /// resolved at connect time, so it may be a name like `myhost`.
    Tcp { host: String, port: u16 },
}

impl ParsedDisplay {
    pub fn screen(&self) -> u32 {
        self.screen
    }
}

/// Parse a `$DISPLAY` string into a local X-server endpoint + screen number.
///
/// Supported forms:
/// - `:N` / `:N.M`        -> Unix socket `/tmp/.X11-unix/X{N}`, screen M (default 0)
/// - `unix:N` / `unix:N.M` -> same as `:N`
/// - `localhost:N`        -> TCP `127.0.0.1:{6000+N}`
/// - `host:N`             -> TCP `host:{6000+N}` (resolved at connect time)
pub fn parse_display(display: &str) -> anyhow::Result<ParsedDisplay> {
    let display = display.trim();

    // Separate `[host]` from `:displaynum`. Split on ':' FIRST so that dots
    // inside a host part (e.g. `127.0.0.1`, `myhost.lab.local`) are not
    // mistaken for a screen suffix.
    let (host_part, num_part) = match display.rfind(':') {
        Some(idx) => (&display[..idx], &display[idx + 1..]),
        None => return Err(anyhow::anyhow!("invalid DISPLAY '{}': no ':' found", display)),
    };

    // The screen suffix `.M` lives only in the part after `:`.
    let (num_str, screen) = match num_part.rfind('.') {
        Some(i) => {
            let scr: u32 = num_part[i + 1..].parse().unwrap_or(0);
            (&num_part[..i], scr)
        }
        None => (num_part, 0),
    };

    let num: u32 = num_str
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid DISPLAY '{}': display number not numeric", display))?;

    let server = if host_part.is_empty() || host_part == "unix" {
        LocalXServer::Unix(PathBuf::from(format!("/tmp/.X11-unix/X{}", num)))
    } else {
        // `localhost` and arbitrary hosts both carry their host string as-is;
        // the canonical loopback IP is used for the `localhost` keyword. The
        // host is resolved at connect time, matching the X11 DISPLAY semantics.
        let host = if host_part == "localhost" {
            "127.0.0.1".to_string()
        } else {
            host_part.to_string()
        };
        // Checked arithmetic: DISPLAY comes from the environment and may be
        // untrusted. Avoid overflow panics / silent wrap on large `num`.
        let port = 6000u32
            .checked_add(num)
            .and_then(|p| u16::try_from(p).ok())
            .ok_or_else(|| {
                anyhow::anyhow!("invalid DISPLAY '{}': display number out of range", display)
            })?;
        LocalXServer::Tcp { host, port }
    };

    Ok(ParsedDisplay { server, screen })
}

/// Generate a fake MIT-MAGIC-COOKIE-1 (16 random bytes, 32 lowercase hex chars).
///
/// Uses `/dev/urandom` on Unix for cryptographic randomness without pulling a
/// new crate. On non-Unix (where X11 forwarding is uncommon), falls back to a
/// time+pid-seeded RNG and logs a warning.
pub fn generate_fake_cookie() -> String {
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let mut buf = [0u8; 16];
            if f.read_exact(&mut buf).is_ok() {
                return buf.iter().map(|b| format!("{:02x}", b)).collect();
            }
        }
        tracing::warn!("/dev/urandom unavailable; using weak fallback for X11 cookie");
        weak_cookie()
    }
    #[cfg(not(unix))]
    {
        tracing::warn!("X11 cookie generation on non-Unix uses a weak fallback");
        weak_cookie()
    }
}

#[allow(dead_code)]
fn weak_cookie() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xdeadbeef);
    seed ^= std::process::id() as u64;
    let mut out = String::with_capacity(32);
    for _ in 0..4 {
        // xorshift64
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.push_str(&format!("{:016x}", seed));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_display_unix() {
        let p = parse_display(":0").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
        assert_eq!(p.screen, 0);
    }

    #[test]
    fn parse_display_unix_screen() {
        let p = parse_display(":0.1").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
        assert_eq!(p.screen, 1);
    }

    #[test]
    fn parse_display_unix_keyword() {
        let p = parse_display("unix:0").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
    }

    #[test]
    fn parse_display_localhost_tcp() {
        let p = parse_display("localhost:10.0").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, 6010);
            }
            _ => panic!("expected Tcp"),
        }
        assert_eq!(p.screen, 0);
    }

    #[test]
    fn parse_display_host_tcp() {
        let p = parse_display("myhost:0").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "myhost");
                assert_eq!(port, 6000);
            }
            _ => panic!("expected Tcp"),
        }
    }

    #[test]
    fn parse_display_missing_colon_is_err() {
        assert!(parse_display("no_colon_here").is_err());
    }

    #[test]
    fn parse_display_non_numeric_displaynum_is_err() {
        assert!(parse_display(":abc").is_err());
    }

    #[test]
    fn parse_display_empty_is_err() {
        assert!(parse_display("").is_err());
    }

    #[test]
    fn parse_display_dotted_ipv4_host() {
        // Regression: the screen-suffix split must not grab the dot inside an IPv4 host.
        let p = parse_display("127.0.0.1:0").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, 6000);
            }
            _ => panic!("expected Tcp"),
        }
        assert_eq!(p.screen, 0);
    }

    #[test]
    fn parse_display_dotted_dns_host_with_screen() {
        let p = parse_display("myhost.lab.local:5.2").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "myhost.lab.local");
                assert_eq!(port, 6005);
            }
            _ => panic!("expected Tcp"),
        }
        assert_eq!(p.screen, 2);
    }

    #[test]
    fn cookie_is_hex_and_32_chars() {
        let c = generate_fake_cookie();
        assert_eq!(c.len(), 32, "MIT-MAGIC-COOKIE-1 is 16 bytes = 32 hex chars");
        assert!(c.chars().all(|ch| ch.is_ascii_hexdigit()), "must be hex");
    }

    #[test]
    fn cookie_is_unique_across_calls() {
        let a = generate_fake_cookie();
        let b = generate_fake_cookie();
        assert_ne!(a, b, "two generated cookies must differ");
    }
}
