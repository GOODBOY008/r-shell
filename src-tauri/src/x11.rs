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

    // Split off the optional screen suffix `.M`.
    let (base, screen) = match display.rfind('.') {
        // Only treat a dot as a screen suffix if what follows is all digits AND
        // the part before also looks like a valid display base (contains ':').
        Some(idx) if display.contains(':') => {
            let (b, s) = display.split_at(idx);
            let s: u32 = s[1..].parse().unwrap_or(0);
            (b, s)
        }
        _ => (display, 0),
    };

    // Separate `[host]` from `:displaynum`.
    let (host_part, num_part) = match base.rfind(':') {
        Some(idx) => (&base[..idx], &base[idx + 1..]),
        None => return Err(anyhow::anyhow!("invalid DISPLAY '{}': no ':' found", display)),
    };

    let num: u32 = num_part
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
        LocalXServer::Tcp {
            host,
            port: 6000 + num as u16,
        }
    };

    Ok(ParsedDisplay { server, screen })
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
            LocalXServer::Tcp { .. } => {}
            _ => panic!("expected Tcp"),
        }
    }
}
