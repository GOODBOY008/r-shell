//! BSD sockets can fail before the user answers macOS's Local Network alert.
//! Retry only the TCP dial, before any RDP negotiation or authentication.
use super::ConnectProgress;
use crate::desktop_protocol::DesktopConnectProgress;
use std::{future::Future, io, time::Duration};
use tokio::{
    net::TcpStream,
    time::{sleep, timeout_at, Instant},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_INTERVAL: Duration = Duration::from_secs(1);

fn tcp_host(host: &str) -> &str {
    // Saved IPv6 hosts may already include URI-style brackets. Tuple address
    // resolution expects the bare literal, including any IPv6 scope suffix.
    host.strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .filter(|inner| inner.contains(':'))
        .unwrap_or(host)
}

fn may_be_local_network_privacy(error: &io::Error) -> bool {
    // Darwin EHOSTUNREACH. This is also a real routing error, not proof of a
    // denied permission. Do not retry authentication, refusal, or other OSes.
    cfg!(target_os = "macos") && error.raw_os_error() == Some(65)
}

pub(super) async fn connect(
    host: &str,
    port: u16,
    progress: &ConnectProgress,
) -> anyhow::Result<TcpStream> {
    dial_with_retry(
        || TcpStream::connect((tcp_host(host), port)),
        may_be_local_network_privacy,
        progress,
        CONNECT_TIMEOUT,
        RETRY_INTERVAL,
    )
    .await
    .map_err(|error| anyhow::anyhow!("RDP TCP connect to {}:{} failed: {}", host, port, error))
}

async fn dial_with_retry<T, F, Fut>(
    mut dial: F,
    retryable: impl Fn(&io::Error) -> bool,
    progress: &ConnectProgress,
    budget: Duration,
    interval: Duration,
) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<T>>,
{
    let deadline = Instant::now() + budget;
    let mut last_unreachable = None;
    loop {
        match timeout_at(deadline, dial()).await {
            Ok(Ok(stream)) => {
                if last_unreachable.is_some() {
                    progress(DesktopConnectProgress::TcpConnected);
                }
                return Ok(stream);
            }
            Ok(Err(error)) if retryable(&error) => {
                if last_unreachable.is_none() {
                    progress(DesktopConnectProgress::WaitingForNetwork);
                }
                last_unreachable = Some(error);
            }
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => break,
        }
        if timeout_at(deadline, sleep(interval)).await.is_err() {
            break;
        }
    }
    match last_unreachable {
        Some(error) => Err(anyhow::anyhow!("[macos-local-network] {}", error)),
        None => Err(anyhow::anyhow!("TCP connection timed out")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn progress_log() -> (ConnectProgress, Arc<Mutex<Vec<DesktopConnectProgress>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let log = events.clone();
        (
            Arc::new(move |event| log.lock().unwrap().push(event)),
            events,
        )
    }

    #[test]
    fn normalizes_only_bracketed_ipv6_hosts() {
        for (host, expected) in [
            ("[::1]", "::1"),
            ("[2001:db8::1]", "2001:db8::1"),
            ("[fe80::1%3]", "fe80::1%3"),
            ("::1", "::1"),
            ("127.0.0.1", "127.0.0.1"),
            ("rdp.example.test", "rdp.example.test"),
            ("[rdp.example.test]", "[rdp.example.test]"),
            ("[::1", "[::1"),
        ] {
            assert_eq!(tcp_host(host), expected);
        }
    }

    #[tokio::test]
    async fn connects_to_bare_and_bracketed_ipv6_loopback() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0))
            .await
            .expect("bind IPv6 loopback");
        let port = listener.local_addr().unwrap().port();
        let (progress, events) = progress_log();
        for host in ["::1", "[::1]"] {
            let stream = connect(host, port, &progress).await.unwrap();
            let (peer, _) = listener.accept().await.unwrap();
            assert_eq!(stream.peer_addr().unwrap(), listener.local_addr().unwrap());
            drop(peer);
        }
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn resumes_after_permission_is_allowed_without_replaying_authentication() {
        let (progress, events) = progress_log();
        let mut calls = 0;
        let stream = dial_with_retry(
            || {
                calls += 1;
                std::future::ready(if calls < 3 {
                    Err(io::Error::from_raw_os_error(65))
                } else {
                    Ok("stream")
                })
            },
            |_| true,
            &progress,
            CONNECT_TIMEOUT,
            RETRY_INTERVAL,
        )
        .await
        .unwrap();
        assert_eq!(stream, "stream");
        assert_eq!(calls, 3);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                DesktopConnectProgress::WaitingForNetwork,
                DesktopConnectProgress::TcpConnected
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_denial_is_bounded_and_keeps_the_original_error() {
        let (progress, events) = progress_log();
        let started = Instant::now();
        let error = dial_with_retry(
            || std::future::ready(Err::<(), _>(io::Error::from_raw_os_error(65))),
            |_| true,
            &progress,
            CONNECT_TIMEOUT,
            RETRY_INTERVAL,
        )
        .await
        .unwrap_err();
        assert_eq!(started.elapsed(), CONNECT_TIMEOUT);
        assert!(error.to_string().contains("[macos-local-network]"));
        assert!(error.to_string().contains("65"));
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_retry_cannot_extend_the_deadline() {
        let (progress, _) = progress_log();
        let mut calls = 0;
        let started = Instant::now();
        let error = dial_with_retry(
            || {
                calls += 1;
                let first = calls == 1;
                async move {
                    if first {
                        Err(io::Error::from_raw_os_error(65))
                    } else {
                        std::future::pending::<io::Result<()>>().await
                    }
                }
            },
            |_| true,
            &progress,
            CONNECT_TIMEOUT,
            RETRY_INTERVAL,
        )
        .await
        .unwrap_err();
        assert_eq!(started.elapsed(), CONNECT_TIMEOUT);
        assert_eq!(calls, 2);
        assert!(error.to_string().contains("[macos-local-network]"));
    }

    #[tokio::test(start_paused = true)]
    async fn unrelated_errors_fail_immediately_even_after_a_privacy_retry() {
        let (progress, _) = progress_log();
        let mut calls = 0;
        let error = dial_with_retry(
            || {
                calls += 1;
                std::future::ready(Err::<(), _>(if calls == 1 {
                    io::Error::from_raw_os_error(65)
                } else {
                    io::Error::new(io::ErrorKind::ConnectionRefused, "server refused")
                }))
            },
            |error| error.raw_os_error() == Some(65),
            &progress,
            CONNECT_TIMEOUT,
            RETRY_INTERVAL,
        )
        .await
        .unwrap_err();
        assert_eq!(calls, 2);
        assert_eq!(error.to_string(), "server refused");
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_dial_stops_retries() {
        let (progress, _) = progress_log();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let task = tokio::spawn(async move {
            dial_with_retry(
                || {
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    std::future::ready(Err::<(), _>(io::Error::from_raw_os_error(65)))
                },
                |_| true,
                &progress,
                CONNECT_TIMEOUT,
                RETRY_INTERVAL,
            )
            .await
        });
        tokio::task::yield_now().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::advance(CONNECT_TIMEOUT).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn only_darwin_host_unreachable_is_a_candidate() {
        assert_eq!(
            may_be_local_network_privacy(&io::Error::from_raw_os_error(65)),
            cfg!(target_os = "macos")
        );
        for code in [1, 13, 51, 60, 61, 111, 113] {
            assert!(!may_be_local_network_privacy(
                &io::Error::from_raw_os_error(code)
            ));
        }
    }
}
