//! Rekey repro: verifies whether russh's time-based rekey kills the transport.
//!
//! Usage: cargo run -p r-shell --example rekey_repro -- [host] [port] [user] [pass] [rekey_secs] [keepalive_secs] [run_secs]
//! Defaults target the docker test server: 127.0.0.1 2222 testuser testpass 15 5 60
use russh::*;
use russh::client;
use russh_keys::key;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone)]
struct Handler;

#[async_trait::async_trait]
impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().collect();
    let host = args.get(1).map(String::as_str).unwrap_or("127.0.0.1").to_string();
    let port: u16 = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(2222);
    let user = args.get(3).map(String::as_str).unwrap_or("testuser").to_string();
    let pass = args.get(4).map(String::as_str).unwrap_or("testpass").to_string();
    let rekey_s: u64 = args.get(5).map(|s| s.parse().unwrap()).unwrap_or(15);
    let keepalive_s: u64 = args.get(6).map(|s| s.parse().unwrap()).unwrap_or(5);
    let run_s: u64 = args.get(7).map(|s| s.parse().unwrap()).unwrap_or(60);

    let config = Arc::new(client::Config {
        limits: Limits::new(1 << 30, 1 << 30, Duration::from_secs(rekey_s)),
        keepalive_interval: Some(Duration::from_secs(keepalive_s)),
        keepalive_max: 3,
        ..client::Config::default()
    });
    eprintln!(
        "[rekey-repro] {}:{} as {} — rekey_time_limit={rekey_s}s keepalive={keepalive_s}s run={run_s}s",
        host, port, user
    );

    let mut session = client::connect(config, (&host[..], port), Handler)
        .await
        .expect("connect failed");
    session
        .authenticate_password(&user, &pass)
        .await
        .expect("auth failed");
    eprintln!("[rekey-repro] AUTHED t=0");

    let mut ch = session.channel_open_session().await.expect("channel open");
    ch.request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .expect("pty request");
    ch.request_shell(true).await.expect("shell request");
    eprintln!("[rekey-repro] SHELL OPEN");

    let start = Instant::now();
    let mut last_send = start;
    let mut closed = false;
    loop {
        tokio::select! {
            msg = ch.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let s = String::from_utf8_lossy(&data);
                        if !s.trim().is_empty() && !s.trim().ends_with('$') && !s.contains("echo r") {
                            eprintln!("[rekey-repro] data@t={:.1}s: {}", start.elapsed().as_secs_f64(), s.trim().lines().next().unwrap_or(""));
                        }
                    }
                    Some(other) => eprintln!("[rekey-repro] channel msg@t={:.1}s: {:?}", start.elapsed().as_secs_f64(), other),
                    None => {
                        closed = true;
                        eprintln!("[rekey-repro] CHANNEL CLOSED at t={:.1}s", start.elapsed().as_secs_f64());
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                if start.elapsed().as_secs() >= run_s {
                    break;
                }
                // Keep data flowing so the channel is exercised across rekeys.
                if last_send.elapsed().as_secs() >= 10 {
                    last_send = Instant::now();
                    let _ = ch.data(std::io::Cursor::new("echo r\r".as_bytes())).await;
                }
            }
        }
    }
    if !closed {
        eprintln!(
            "[rekey-repro] STILL ALIVE at t={:.1}s — survived past the rekey mark",
            start.elapsed().as_secs_f64()
        );
    }
}