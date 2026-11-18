use reqwest::{header, Client, StatusCode, Url};
use std::time::Duration;

pub const MAX_WIRE: usize = 24 * 1024 * 1024;
#[derive(Debug)]
pub struct RemoteFile {
    pub body: String,
    pub etag: String,
}

pub(super) fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "SYNC_NETWORK".into())
}

pub(super) async fn read_file(mut response: reqwest::Response) -> Result<RemoteFile, String> {
    let etag = response
        .headers()
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .ok_or("SYNC_CONDITIONAL_UNSUPPORTED")?;
    if etag.starts_with("W/") {
        return Err("SYNC_WEAK_ETAG".into());
    }
    let opaque = etag
        .strip_prefix('"')
        .and_then(|tag| tag.strip_suffix('"'))
        .ok_or("SYNC_CONDITIONAL_UNSUPPORTED")?;
    if etag.len() > 1024
        || !opaque
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b'"')
    {
        return Err("SYNC_CONDITIONAL_UNSUPPORTED".into());
    }
    let etag = etag.to_owned();
    if response
        .content_length()
        .is_some_and(|n| n > MAX_WIRE as u64)
    {
        return Err("SYNC_TOO_LARGE".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "SYNC_NETWORK")? {
        if body.len() + chunk.len() > MAX_WIRE {
            return Err("SYNC_TOO_LARGE".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(RemoteFile {
        body: String::from_utf8(body).map_err(|_| "SYNC_INVALID_DATA")?,
        etag,
    })
}

#[async_trait::async_trait]
pub(super) trait ObjectStore: Send + Sync {
    async fn read(&self, name: &str) -> Result<Option<RemoteFile>, String>;
    async fn write(&self, name: &str, body: String, etag: Option<&str>) -> Result<(), String>;
    async fn delete(&self, name: &str) -> Result<(), String>;

    async fn probe(&self) -> Result<(), String> {
        let name = format!(".rshell-probe-{}", super::model::random_id());
        self.write(&name, "one".into(), None).await?;
        let result = async {
            let first = self
                .read(&name)
                .await?
                .ok_or("SYNC_CONDITIONAL_UNSUPPORTED")?;
            if first.body != "one" {
                return Err("SYNC_CONDITIONAL_UNSUPPORTED".into());
            }
            self.write(&name, "two".into(), Some(&first.etag)).await?;
            let latest = self
                .read(&name)
                .await?
                .ok_or("SYNC_CONDITIONAL_UNSUPPORTED")?;
            if latest.body != "two" || latest.etag == first.etag {
                return Err("SYNC_CONDITIONAL_UNSUPPORTED".into());
            }
            // A previously valid ETag also works with servers that validate token syntax.
            for condition in [Some(first.etag.as_str()), None] {
                match self.write(&name, "wrong".into(), condition).await {
                    Err(code) if code == "SYNC_STALE" => (),
                    Err(code) => return Err(code),
                    Ok(()) => return Err("SYNC_CONDITIONAL_UNSUPPORTED".into()),
                }
            }
            let after = self
                .read(&name)
                .await?
                .ok_or("SYNC_CONDITIONAL_UNSUPPORTED")?;
            if after.etag != latest.etag || after.body != latest.body {
                return Err("SYNC_CONDITIONAL_UNSUPPORTED".into());
            }
            Ok(())
        }
        .await;
        // Delete only the randomly named probe we created, including on failure.
        self.delete(&name).await?;
        result
    }
}

pub struct WebDav {
    client: Client,
    directory: Url,
    username: String,
    password: String,
}

impl WebDav {
    pub fn new(url: &str, username: &str, password: &str) -> Result<Self, String> {
        let mut directory = Url::parse(url).map_err(|_| "SYNC_URL")?;
        let test_http =
            cfg!(test) && directory.scheme() == "http" && directory.host_str() == Some("127.0.0.1");
        if (directory.scheme() != "https" && !test_http)
            || directory.host_str().is_none()
            || !directory.username().is_empty()
            || directory.password().is_some()
            || directory.query().is_some()
            || directory.fragment().is_some()
        {
            return Err("SYNC_URL".into());
        }
        if !directory.path().ends_with('/') {
            directory.set_path(&format!("{}/", directory.path()));
        }
        let client = http_client()?;
        Ok(Self {
            client,
            directory,
            username: username.into(),
            password: password.into(),
        })
    }

    fn request(
        &self,
        method: reqwest::Method,
        name: &str,
    ) -> Result<reqwest::RequestBuilder, String> {
        let url = self.directory.join(name).map_err(|_| "SYNC_URL")?;
        Ok(self
            .client
            .request(method, url)
            .basic_auth(&self.username, Some(&self.password))
            .header(header::ACCEPT_ENCODING, "identity")
            .header(header::CACHE_CONTROL, "no-cache"))
    }

    async fn read_once(&self, name: &str) -> Result<Option<RemoteFile>, String> {
        let response = self
            .request(reqwest::Method::GET, name)?
            .send()
            .await
            .map_err(|_| "SYNC_NETWORK")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        check(&response)?;
        read_file(response).await.map(Some)
    }
}

#[async_trait::async_trait]
impl ObjectStore for WebDav {
    async fn read(&self, name: &str) -> Result<Option<RemoteFile>, String> {
        // Apache briefly marks newly written files weak. Wait for an actual
        // strong validator; stripping W/ would make If-Match unsafe.
        for attempt in 0..3 {
            match self.read_once(name).await {
                Err(error) if error == "SYNC_WEAK_ETAG" && attempt < 2 => {
                    tokio::time::sleep(Duration::from_millis(1100)).await;
                }
                Err(error) if error == "SYNC_WEAK_ETAG" => {
                    return Err("SYNC_CONDITIONAL_UNSUPPORTED".into())
                }
                result => return result,
            }
        }
        Err("SYNC_CONDITIONAL_UNSUPPORTED".into())
    }

    async fn write(&self, name: &str, body: String, etag: Option<&str>) -> Result<(), String> {
        if body.len() > MAX_WIRE {
            return Err("SYNC_TOO_LARGE".into());
        }
        let request = self
            .request(reqwest::Method::PUT, name)?
            .header(header::CONTENT_TYPE, "application/octet-stream");
        let request = if let Some(etag) = etag {
            request.header(header::IF_MATCH, etag)
        } else {
            request.header(header::IF_NONE_MATCH, "*")
        };
        check(
            &request
                .body(body)
                .send()
                .await
                .map_err(|_| "SYNC_NETWORK")?,
        )
    }

    async fn delete(&self, name: &str) -> Result<(), String> {
        let response = self
            .request(reqwest::Method::DELETE, name)?
            .send()
            .await
            .map_err(|_| "SYNC_NETWORK")?;
        check(&response)
    }
}

fn check(response: &reqwest::Response) -> Result<(), String> {
    match response.status() {
        status if status.is_success() => Ok(()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err("SYNC_AUTH".into()),
        StatusCode::PRECONDITION_FAILED => Err("SYNC_STALE".into()),
        StatusCode::TOO_MANY_REQUESTS => {
            let seconds = response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(300)
                .clamp(1, 86400);
            Err(format!("SYNC_RATE_LIMIT:{seconds}"))
        }
        StatusCode::NOT_FOUND | StatusCode::CONFLICT => Err("SYNC_DIRECTORY".into()),
        _ => Err("SYNC_NETWORK".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn rejects_unsafe_urls() {
        for url in [
            "http://example.org/dav",
            "https://user:secret@example.org/",
            "file:///tmp/x",
            "https://example.org/?token=x",
            "https://example.org/#x",
        ] {
            assert!(WebDav::new(url, "a", "b").is_err(), "{url}");
        }
    }

    async fn fixture(ignore_conditions: bool) -> (WebDav, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dav = WebDav::new(
            &format!("http://{}/dav/", listener.local_addr().unwrap()),
            "user",
            "pass",
        )
        .unwrap();
        let task = tokio::spawn(async move {
            let mut stored: Option<String> = None;
            let mut revision = 0;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = Vec::new();
                let (header_end, length) = loop {
                    let mut chunk = [0u8; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        let text = String::from_utf8_lossy(&buffer[..end]).to_lowercase();
                        let len = text
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .and_then(|l| l.parse::<usize>().ok())
                            .unwrap_or(0);
                        if buffer.len() >= end + 4 + len {
                            break (end + 4, len);
                        }
                    }
                };
                let headers = String::from_utf8_lossy(&buffer[..header_end]).to_lowercase();
                let mut status = "200 OK";
                let mut body = String::new();
                if headers.starts_with("put ") {
                    let mismatch = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("if-match: "))
                        .is_some_and(|s| s != format!("\"{revision}\""));
                    let exists = headers.contains("if-none-match: *") && stored.is_some();
                    if !ignore_conditions && (mismatch || exists) {
                        status = "412 Precondition Failed";
                    } else {
                        stored = Some(
                            String::from_utf8(buffer[header_end..header_end + length].to_vec())
                                .unwrap(),
                        );
                        revision += 1;
                        status = "201 Created";
                    }
                } else if headers.starts_with("get ") {
                    if let Some(s) = &stored {
                        body = s.clone();
                    } else {
                        status = "404 Not Found";
                    }
                } else if headers.starts_with("delete ") {
                    stored = None;
                    status = "204 No Content";
                }
                let response=format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: \"{revision}\"\r\nConnection: close\r\n\r\n{body}",body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (dav, task)
    }

    #[tokio::test]
    async fn real_http_probe_accepts_cas_and_rejects_ignored_conditions() {
        let (dav, task) = fixture(false).await;
        dav.probe().await.unwrap();
        task.abort();
        let (dav, task) = fixture(true).await;
        assert_eq!(
            dav.probe().await.unwrap_err(),
            "SYNC_CONDITIONAL_UNSUPPORTED"
        );
        task.abort();
    }

    #[tokio::test]
    #[ignore = "requires an isolated WebDAV directory in RSHELL_TEST_WEBDAV_URL"]
    async fn real_webdav_server_encrypted_roundtrip_and_concurrent_writes() {
        let url = std::env::var("RSHELL_TEST_WEBDAV_URL").expect("isolated WebDAV directory URL");
        let dav = WebDav::new(
            &url,
            &std::env::var("RSHELL_TEST_WEBDAV_USER").unwrap_or_default(),
            &std::env::var("RSHELL_TEST_WEBDAV_PASSWORD").unwrap_or_default(),
        )
        .unwrap();
        dav.probe().await.unwrap();
        let name = format!(".rshell-integration-{}", super::super::model::random_id());
        let mut snapshot = super::super::model::Snapshot {
            version: 1,
            vault_id: "integration".into(),
            revision: 1,
            ..Default::default()
        };
        snapshot.records.insert(
            super::super::model::ROOT.into(),
            serde_json::json!({"name":"All Connections"}),
        );
        let sealed = super::super::crypto::encrypt("test-only-passphrase", &snapshot).unwrap();
        dav.write(&name, sealed, None).await.unwrap();
        let first = dav.read(&name).await.unwrap().unwrap();
        assert_eq!(
            super::super::crypto::decrypt("test-only-passphrase", &first.body).unwrap(),
            snapshot
        );
        snapshot.revision = 2;
        let changed = super::super::crypto::encrypt("test-only-passphrase", &snapshot).unwrap();
        dav.write(&name, changed.clone(), Some(&first.etag))
            .await
            .unwrap();
        assert_eq!(
            dav.write(&name, changed, Some(&first.etag)).await,
            Err("SYNC_STALE".into())
        );
        let current = dav.read(&name).await.unwrap().unwrap();
        assert_eq!(
            super::super::crypto::decrypt("test-only-passphrase", &current.body)
                .unwrap()
                .revision,
            2
        );
        check(
            &dav.request(reqwest::Method::DELETE, &name)
                .unwrap()
                .send()
                .await
                .unwrap(),
        )
        .unwrap();
    }
}
