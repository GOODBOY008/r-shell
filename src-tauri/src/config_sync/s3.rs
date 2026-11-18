use super::provider::{http_client, read_file, ObjectStore, RemoteFile, MAX_WIRE};
use super::settings::{Addressing, S3Target};
use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{
        sign, PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest,
        SigningSettings, UriPathNormalizationMode,
    },
    sign::v4,
};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{header, Client, Method, Request, Response, StatusCode, Url};
use serde::Deserialize;
use std::{net::IpAddr, time::SystemTime};

const S3_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
const MAX_ERROR_BODY: usize = 64 * 1024;

pub(super) struct S3 {
    client: Client,
    bucket_url: Url,
    prefix: String,
    region: String,
    credentials: Credentials,
}

impl S3 {
    pub(super) fn new(
        target: &S3Target,
        secret: &str,
        token: Option<&str>,
    ) -> Result<Self, String> {
        let mut url = Url::parse(&target.endpoint).map_err(|_| "SYNC_S3_ENDPOINT")?;
        let test_http = cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
        if (url.scheme() != "https" && !test_http)
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("SYNC_S3_ENDPOINT".into());
        }
        let bucket = &target.bucket;
        if !(3..=63).contains(&bucket.len())
            || bucket.parse::<IpAddr>().is_ok()
            || !bucket.split('.').all(|label| {
                !label.is_empty()
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        {
            return Err("SYNC_S3_BUCKET_NAME".into());
        }
        if target.region.is_empty()
            || target.region.len() > 64
            || !target
                .region
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("SYNC_S3_REGION".into());
        }
        if target.access_key_id.is_empty()
            || secret.is_empty()
            || !target
                .access_key_id
                .bytes()
                .all(|b| b.is_ascii_graphic() && b != b'/' && b != b',')
            || token.is_some_and(|s| header::HeaderValue::from_str(s).is_err())
        {
            return Err("SYNC_S3_CREDENTIALS".into());
        }
        let prefix = target.prefix.trim_matches('/');
        if prefix.chars().any(char::is_control)
            || prefix.split('/').any(|s| matches!(s, "." | ".."))
        {
            return Err("SYNC_S3_PREFIX".into());
        }
        match target.addressing {
            Addressing::Path => url.set_path(bucket),
            Addressing::VirtualHosted => {
                let domain = url.domain().ok_or("SYNC_S3_ENDPOINT")?;
                url.set_host(Some(&format!("{bucket}.{domain}")))
                    .map_err(|_| "SYNC_S3_ENDPOINT")?;
            }
        }
        Ok(Self {
            client: http_client()?,
            bucket_url: url,
            prefix: prefix.to_owned(),
            region: target.region.clone(),
            credentials: Credentials::new(
                &target.access_key_id,
                secret,
                token.map(str::to_owned),
                None,
                "R-Shell",
            ),
        })
    }

    fn object_url(&self, name: &str) -> Result<Url, String> {
        let key = if self.prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{name}", self.prefix)
        };
        if key.len() > 1024 {
            return Err("SYNC_S3_PREFIX".into());
        }
        let encoded = key
            .split('/')
            .map(|segment| utf8_percent_encode(segment, S3_SEGMENT).to_string())
            .collect::<Vec<_>>()
            .join("/");
        let mut url = self.bucket_url.clone();
        url.set_path(&format!("{}/{encoded}", url.path().trim_end_matches('/')));
        Ok(url)
    }

    fn signed_request(
        &self,
        method: Method,
        name: &str,
        payload: Option<String>,
        etag: Option<&str>,
        now: SystemTime,
    ) -> Result<Request, String> {
        let mut builder = self.client.request(method.clone(), self.object_url(name)?);
        if let Some(payload) = payload {
            if payload.len() > MAX_WIRE {
                return Err("SYNC_TOO_LARGE".into());
            }
            builder = match etag {
                Some(etag) => builder.header(header::IF_MATCH, etag),
                None => builder.header(header::IF_NONE_MATCH, "*"),
            }
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(payload);
        }
        let mut request = builder.build().map_err(|_| "SYNC_INVALID_DATA")?;
        let mut settings = SigningSettings::default();
        // S3 signs the already-encoded key, including any literal double slashes.
        settings.percent_encoding_mode = PercentEncodingMode::Single;
        settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;
        settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
        let identity = self.credentials.clone().into();
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name("s3")
            .time(now)
            .settings(settings)
            .build()
            .map_err(|_| "SYNC_S3_CREDENTIALS")?
            .into();
        let headers = request
            .headers()
            .iter()
            .map(|(k, v)| {
                v.to_str()
                    .map(|s| (k.as_str(), s))
                    .map_err(|_| "SYNC_INVALID_DATA")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let body = request
            .body()
            .and_then(|b| b.as_bytes())
            .unwrap_or_default();
        let signable = SignableRequest::new(
            method.as_str(),
            request.url().as_str(),
            headers.into_iter(),
            SignableBody::Bytes(body),
        )
        .map_err(|_| "SYNC_S3_ENDPOINT")?;
        let (instructions, _) = sign(signable, &params)
            .map_err(|_| "SYNC_S3_CREDENTIALS")?
            .into_parts();
        for signed in instructions.into_parts().0 {
            let mut value =
                header::HeaderValue::from_str(signed.value()).map_err(|_| "SYNC_S3_CREDENTIALS")?;
            value.set_sensitive(signed.sensitive());
            request.headers_mut().insert(signed.name(), value);
        }
        Ok(request)
    }

    async fn send(
        &self,
        method: Method,
        name: &str,
        body: Option<String>,
        etag: Option<&str>,
    ) -> Result<Option<Response>, String> {
        let request = self.signed_request(method.clone(), name, body, etag, SystemTime::now())?;
        let transport_error = if method == Method::PUT {
            "SYNC_WRITE_UNCERTAIN"
        } else {
            "SYNC_NETWORK"
        };
        let mut response = self
            .client
            .execute(request)
            .await
            .map_err(|_| transport_error)?;
        let status = response.status();
        if status.is_success() {
            return Ok(Some(response));
        }
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(300)
            .clamp(1, 86400);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| transport_error)? {
            if bytes.len() + chunk.len() > MAX_ERROR_BODY {
                return Err("SYNC_S3_RESPONSE".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        #[derive(Deserialize)]
        struct ServiceError {
            #[serde(rename = "Code")]
            code: String,
        }
        let error = quick_xml::de::from_reader::<_, ServiceError>(bytes.as_slice()).ok();
        let code = error.as_ref().map(|err| err.code.as_str()).unwrap_or("");
        match (status, code) {
            (StatusCode::NOT_FOUND, "NoSuchKey") if method == Method::GET => Ok(None),
            (StatusCode::NOT_FOUND, "NoSuchBucket") => Err("SYNC_S3_BUCKET_MISSING".into()),
            (StatusCode::NOT_FOUND, "NoSuchKey") if method == Method::PUT && etag.is_some() => {
                Err("SYNC_STALE".into())
            }
            (StatusCode::PRECONDITION_FAILED, _)
            | (StatusCode::CONFLICT, "ConditionalRequestConflict" | "OperationAborted") => {
                Err("SYNC_STALE".into())
            }
            (StatusCode::TOO_MANY_REQUESTS, _) | (_, "SlowDown") => {
                Err(format!("SYNC_RATE_LIMIT:{retry_after}"))
            }
            (_, "AuthorizationHeaderMalformed" | "PermanentRedirect" | "IncorrectEndpoint") => {
                Err("SYNC_S3_REGION".into())
            }
            (StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED, _)
            | (_, "ExpiredToken" | "InvalidToken") => Err("SYNC_S3_ACCESS".into()),
            (StatusCode::NOT_IMPLEMENTED, _) => Err("SYNC_CONDITIONAL_UNSUPPORTED".into()),
            (StatusCode::REQUEST_TIMEOUT, _) | (_, "RequestTimeout") => Err(transport_error.into()),
            (s, _) if s.is_server_error() => Err(transport_error.into()),
            _ => Err("SYNC_S3_RESPONSE".into()),
        }
    }
}

#[async_trait::async_trait]
impl ObjectStore for S3 {
    async fn read(&self, name: &str) -> Result<Option<RemoteFile>, String> {
        let Some(response) = self.send(Method::GET, name, None, None).await? else {
            return Ok(None);
        };
        read_file(response).await.map(Some).map_err(|error| {
            if error == "SYNC_WEAK_ETAG" {
                "SYNC_CONDITIONAL_UNSUPPORTED".into()
            } else {
                error
            }
        })
    }

    async fn write(&self, name: &str, body: String, etag: Option<&str>) -> Result<(), String> {
        self.send(Method::PUT, name, Some(body), etag)
            .await
            .map(|_| ())
    }

    async fn delete(&self, name: &str) -> Result<(), String> {
        self.send(Method::DELETE, name, None, None)
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn target() -> S3Target {
        S3Target {
            endpoint: "https://s3.example:9443".into(),
            bucket: "rshell-test".into(),
            region: "us-east-1".into(),
            access_key_id: "test-id".into(),
            prefix: "team/配置 +%#?/one//two".into(),
            addressing: Addressing::Path,
        }
    }

    #[test]
    fn signs_exact_key_conditions_and_session_token_in_both_addressing_modes() {
        for addressing in [Addressing::Path, Addressing::VirtualHosted] {
            let cfg = S3Target {
                addressing,
                ..target()
            };
            let store = S3::new(&cfg, "secret", Some("temporary-token")).unwrap();
            let req = store
                .signed_request(
                    Method::PUT,
                    "config.enc",
                    Some("abc".into()),
                    Some("\"old\""),
                    SystemTime::UNIX_EPOCH,
                )
                .unwrap();
            let base = if addressing == Addressing::Path {
                "https://s3.example:9443/rshell-test"
            } else {
                "https://rshell-test.s3.example:9443"
            };
            assert_eq!(
                req.url().as_str(),
                format!("{base}/team/%E9%85%8D%E7%BD%AE%20%2B%25%23%3F/one//two/config.enc")
            );
            assert_eq!(req.headers()[header::IF_MATCH], "\"old\"");
            assert_eq!(req.headers()["x-amz-security-token"], "temporary-token");
            assert_eq!(
                req.headers()["x-amz-content-sha256"],
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            );
            let authorization = req.headers()[header::AUTHORIZATION].to_str().unwrap();
            assert!(authorization.contains("test-id/19700101/us-east-1/s3/aws4_request"));
            assert!(
                authorization.contains("if-match")
                    && authorization.contains("x-amz-security-token")
            );
        }
    }

    #[test]
    fn rejects_invalid_origins_buckets_and_ambiguous_key_segments() {
        for endpoint in [
            "http://s3.example",
            "https://a:b@s3.example",
            "https://s3.example?token=x",
            "https://s3.example/#fragment",
            "https://s3.example/bucket",
        ] {
            assert!(S3::new(
                &S3Target {
                    endpoint: endpoint.into(),
                    ..target()
                },
                "s",
                None
            )
            .is_err());
        }
        for bucket in ["ab", "UPPER", "a..b", "one/two", "127.0.0.1", "-prefix"] {
            assert!(S3::new(
                &S3Target {
                    bucket: bucket.into(),
                    ..target()
                },
                "s",
                None
            )
            .is_err());
        }
        for prefix in ["one/../two", "./vault", "one\ntwo"] {
            assert!(S3::new(
                &S3Target {
                    prefix: prefix.into(),
                    ..target()
                },
                "s",
                None
            )
            .is_err());
        }
        assert!(S3::new(&target(), "", Some("token")).is_err());
    }

    async fn responder(status: &str, code: &str) -> S3 {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", socket.local_addr().unwrap());
        let body = format!("<Error><Code>{code}</Code><Message>redacted</Message></Error>");
        let bytes = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nRetry-After: 45\r\nConnection: close\r\n\r\n{body}", body.len());
        let drop_reply = status == "disconnect";
        tokio::spawn(async move {
            let (mut client, _) = socket.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            client.read(&mut buf).await.unwrap();
            if !drop_reply {
                client.write_all(bytes.as_bytes()).await.unwrap();
            }
        });
        S3::new(
            &S3Target {
                endpoint,
                ..target()
            },
            "secret",
            None,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn only_explicit_no_such_key_is_a_missing_snapshot() {
        assert!(responder("404 Not Found", "NoSuchKey")
            .await
            .read("vault")
            .await
            .unwrap()
            .is_none());
        for (status, code, expected) in [
            ("404 Not Found", "NoSuchBucket", "SYNC_S3_BUCKET_MISSING"),
            ("404 Not Found", "", "SYNC_S3_RESPONSE"),
            ("403 Forbidden", "AccessDenied", "SYNC_S3_ACCESS"),
            ("503 Unavailable", "SlowDown", "SYNC_RATE_LIMIT:45"),
        ] {
            assert_eq!(
                responder(status, code)
                    .await
                    .read("vault")
                    .await
                    .unwrap_err(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn distinguishes_stale_locked_and_ambiguous_writes() {
        for (status, code, expected) in [
            (
                "412 Precondition Failed",
                "PreconditionFailed",
                "SYNC_STALE",
            ),
            ("409 Conflict", "ConditionalRequestConflict", "SYNC_STALE"),
            (
                "409 Conflict",
                "ObjectLockedByBucketPolicy",
                "SYNC_S3_RESPONSE",
            ),
            ("404 Not Found", "NoSuchKey", "SYNC_STALE"),
            ("disconnect", "", "SYNC_WRITE_UNCERTAIN"),
        ] {
            assert_eq!(
                responder(status, code)
                    .await
                    .write("vault", "data".into(), Some("\"old\""))
                    .await
                    .unwrap_err(),
                expected
            );
        }
    }
}
