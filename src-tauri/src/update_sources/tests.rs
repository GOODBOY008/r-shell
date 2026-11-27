use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::App;
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const GOOD: &[u8] = b"verified R-Shell update fixture\n";
const NAME: &str = "r-shell_aarch64.app.tar.gz";

#[derive(Clone, Copy)]
enum Manifest {
    Version(&'static str),
    HttpError,
    Malformed,
    MalformedSignature,
    MissingPlatform,
    Stall,
}
#[derive(Clone, Copy)]
enum Package {
    Good,
    Bad,
    Missing,
    Interrupted,
    Stall,
}

struct Server {
    base: Url,
    hits: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start(source: Source, manifest: Manifest, package: Package) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let requests = hits.clone();
        let origin = base.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let url = origin.clone();
                let requests = requests.clone();
                tokio::spawn(async move {
                    let mut io = BufReader::new(stream);
                    let mut first = String::new();
                    io.read_line(&mut first).await.unwrap();
                    let path = first.split_whitespace().nth(1).unwrap().to_string();
                    loop {
                        let mut line = String::new();
                        if io.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    requests.lock().unwrap().push(path.clone());
                    let mut stall = false;
                    let (code, body, length) = if path.ends_with(".json") {
                        match manifest {
                            Manifest::HttpError => (503, vec![], 0),
                            Manifest::Stall => {
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                return;
                            }
                            Manifest::Malformed => (200, b"<html>".to_vec(), 6),
                            mode => {
                                let version = if let Manifest::Version(v) = mode {
                                    v
                                } else {
                                    "2.0.0"
                                };
                                let prefix = if source == Source::Github {
                                    "download"
                                } else {
                                    "releases"
                                };
                                let signature = if matches!(mode, Manifest::MalformedSignature) {
                                    "YWJj"
                                } else {
                                    include_str!("test-package.sig").trim()
                                };
                                let entry = json!({"signature":signature, "url":url.join(&format!("{prefix}/v{version}/{NAME}")).unwrap().as_str()});
                                let target = if matches!(mode, Manifest::MissingPlatform) {
                                    "missing"
                                } else {
                                    "fixture"
                                };
                                let body = serde_json::to_vec(
                                    &json!({"version":version,"platforms":{(target):entry}}),
                                )
                                .unwrap();
                                let len = body.len();
                                (200, body, len)
                            }
                        }
                    } else {
                        match package {
                            Package::Good => (200, GOOD.to_vec(), GOOD.len()),
                            Package::Bad => (200, b"wrong".to_vec(), 5),
                            Package::Missing => (404, vec![], 0),
                            Package::Interrupted => (200, GOOD[..2].to_vec(), GOOD.len()),
                            Package::Stall => {
                                stall = true;
                                (200, GOOD[..2].to_vec(), GOOD.len())
                            }
                        }
                    };
                    let hdr=format!("HTTP/1.1 {code} Test\r\nConnection: close\r\nContent-Length: {length}\r\n\r\n");
                    let target = io.get_mut();
                    if target.write_all(hdr.as_bytes()).await.is_ok() {
                        let _ = target.write_all(&body).await;
                    }
                    if stall {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                });
            }
        });
        Self { base, hits, task }
    }
}
fn application() -> App<MockRuntime> {
    let mut ctx = mock_context(noop_assets());
    ctx.config_mut().plugins.0.insert("updater".into(),json!({
        "pubkey": include_str!("test-public.key").trim(), "dangerousInsecureTransportProtocol":true,"requireSignedVersion":true
    }));
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(ctx)
        .unwrap()
}
fn sources(a: &Server, b: &Server) -> Sources {
    Sources {
        github: a.base.clone(),
        mirror: b.base.clone(),
        check_timeout: Duration::from_millis(900),
        read_idle: Duration::from_millis(450),
    }
}
fn builder(app: &App<MockRuntime>) -> UpdaterBuilder {
    app.updater_builder().target("fixture").no_proxy()
}

#[tokio::test]
async fn primary_success_and_valid_no_update_avoid_mirror() {
    let app = application();
    for (version, expected) in [("2.0.0", true), ("0.1.0", false), ("0.0.1", false)] {
        let a = Server::start(Source::Github, Manifest::Version(version), Package::Good).await;
        let b = Server::start(Source::Cloudflare, Manifest::HttpError, Package::Missing).await;
        let selected = sources(&a, &b)
            .check(
                Channel::Stable,
                || builder(&app),
                |_| panic!("unexpected switch"),
            )
            .await
            .unwrap();
        assert_eq!(selected.is_some(), expected);
        if let Some(s) = selected {
            assert_eq!(
                s.download(|_, _| {}, |_| panic!("unexpected switch"))
                    .await
                    .unwrap(),
                GOOD
            );
        }
        assert!(b.hits.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn checks_fall_back_on_status_timeout_html_missing_target_and_wrong_channel() {
    let app = application();
    for mode in [
        Manifest::Stall,
        Manifest::HttpError,
        Manifest::Malformed,
        Manifest::MalformedSignature,
        Manifest::MissingPlatform,
        Manifest::Version("3.0.0-current.1"),
    ] {
        let a = Server::start(Source::Github, mode, Package::Missing).await;
        let b = Server::start(
            Source::Cloudflare,
            Manifest::Version("2.0.0"),
            Package::Good,
        )
        .await;
        let s = sources(&a, &b)
            .check(
                Channel::Stable,
                || builder(&app),
                |source| assert!(source == Source::Cloudflare),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            s.download(|_, _| {}, |_| panic!("unexpected switch"))
                .await
                .unwrap(),
            GOOD
        );
        assert_eq!(b.hits.lock().unwrap().len(), 2);
    }
}
#[tokio::test]
async fn failed_download_uses_original_name_version_and_signature() {
    let app = application();
    for body in [
        Package::Missing,
        Package::Bad,
        Package::Interrupted,
        Package::Stall,
    ] {
        let a = Server::start(Source::Github, Manifest::Version("2.0.0"), body).await;
        let b = Server::start(
            Source::Cloudflare,
            Manifest::Version("8.0.0"),
            Package::Good,
        )
        .await;
        let s = sources(&a, &b)
            .check(
                Channel::Stable,
                || builder(&app),
                |_| panic!("unexpected switch"),
            )
            .await
            .unwrap()
            .unwrap();
        let switches = std::cell::Cell::new(0);
        assert_eq!(
            s.download(|_, _| {}, |_| switches.set(switches.get() + 1))
                .await
                .unwrap(),
            GOOD
        );
        assert_eq!(switches.get(), 1);
        assert_eq!(
            &*b.hits.lock().unwrap(),
            &[format!("/releases/v2.0.0/{NAME}")]
        );
    }
}
#[tokio::test]
async fn both_sources_fail_closed_and_mirror_can_switch_back_to_github() {
    let app = application();
    let a = Server::start(Source::Github, Manifest::HttpError, Package::Good).await;
    let b = Server::start(Source::Cloudflare, Manifest::Version("2.0.0"), Package::Bad).await;
    let s = sources(&a, &b)
        .check(Channel::Stable, || builder(&app), |_| {})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        s.download(|_, _| {}, |src| assert!(src == Source::Github))
            .await
            .unwrap(),
        GOOD
    );
    let a = Server::start(Source::Github, Manifest::Version("2.0.0"), Package::Bad).await;
    let s = sources(&a, &b)
        .check(Channel::Stable, || builder(&app), |_| {})
        .await
        .unwrap()
        .unwrap();
    let err = s.download(|_, _| {}, |_| {}).await.unwrap_err();
    assert!(err.contains("GitHub") && err.contains("Cloudflare"));
    let b = Server::start(Source::Cloudflare, Manifest::HttpError, Package::Missing).await;
    assert!(sources(&a, &b)
        .check(Channel::Current, || builder(&app), |_| {})
        .await
        .is_err());
}

#[tokio::test]
async fn installation_is_called_once_and_local_failure_never_retries_transport() {
    let app = application();
    for initial in [Package::Good, Package::Bad] {
        let primary = Server::start(Source::Github, Manifest::Version("2.0.0"), initial).await;
        let backup = Server::start(
            Source::Cloudflare,
            Manifest::Version("9.0.0"),
            Package::Good,
        )
        .await;
        let selected = sources(&primary, &backup)
            .check(Channel::Stable, || builder(&app), |_| {})
            .await
            .unwrap()
            .unwrap();
        let mut installs = 0;
        let outcome = selected
            .apply(
                |_, _| {},
                |_| {},
                |update, bytes| {
                    assert_eq!(update.version, "2.0.0");
                    assert_eq!(bytes, GOOD);
                    installs += 1;
                    Err("installer refused".into())
                },
            )
            .await;
        assert_eq!(outcome, Err("installer refused".into()));
        assert_eq!(installs, 1);
        assert_eq!(
            backup.hits.lock().unwrap().len(),
            if matches!(initial, Package::Good) {
                0
            } else {
                1
            }
        );
    }
}
#[tokio::test]
async fn manifest_deadline_is_independent_of_download_idle_limit() {
    let app = application();
    let a = Server::start(Source::Github, Manifest::Stall, Package::Missing).await;
    let b = Server::start(
        Source::Cloudflare,
        Manifest::Version("2.0.0"),
        Package::Good,
    )
    .await;
    let mut sources = sources(&a, &b);
    sources.check_timeout = Duration::from_millis(250);
    sources.read_idle = Duration::from_secs(30);
    let selected = sources
        .check(Channel::Stable, || builder(&app), |_| {})
        .await
        .unwrap()
        .unwrap();
    assert!(selected.source == Source::Cloudflare);
}

#[tokio::test]
async fn failed_refresh_preserves_only_the_announced_channel() {
    let app = application();
    let primary = Server::start(Source::Github, Manifest::Version("2.0.0"), Package::Good).await;
    let failed = Server::start(Source::Cloudflare, Manifest::HttpError, Package::Missing).await;
    let mut slot = None;
    sources(&primary, &failed)
        .refresh(&mut slot, Channel::Stable, || builder(&app), |_| {})
        .await
        .unwrap();
    for channel in [Channel::Stable, Channel::Current] {
        assert!(sources(&failed, &failed)
            .refresh(&mut slot, channel, || builder(&app), |_| {})
            .await
            .is_err());
        if channel == Channel::Stable {
            let bytes = slot
                .as_ref()
                .unwrap()
                .download(|_, _| {}, |_| {})
                .await
                .unwrap();
            assert_eq!(bytes, GOOD);
        } else {
            assert!(slot.is_none());
        }
    }
}
