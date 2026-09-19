//! TLS upgrade backends for RDP.
//!
//! OpenSSL is the primary backend (supports both CBC and AEAD cipher suites,
//! no macOS Secure Transport session resumption issues). native-tls via
//! security-framework is a macOS-only fallback.

use tokio::io::{AsyncRead, AsyncWrite};

// ---------------------------------------------------------------------------
// OpenSSL TLS upgrade — supports both CBC and AEAD cipher suites,
// no macOS Secure Transport session resumption issues.
// This is the PRIMARY TLS backend for RDP connections.
// ---------------------------------------------------------------------------

pub(super) async fn tls_upgrade_openssl<S>(
    stream: S,
    _server_name: &str,
) -> std::io::Result<(tokio_openssl::SslStream<S>, x509_cert::Certificate)>
where
    S: Unpin + AsyncRead + AsyncWrite + Send + 'static,
{
    use openssl::ssl::{SslConnector, SslMethod, SslVerifyMode, SslSessionCacheMode, SslOptions};
    use tokio::io::AsyncWriteExt as _;
    use std::pin::Pin;

    let mut builder = SslConnector::builder(SslMethod::tls_client())
        .map_err(|e| std::io::Error::other(format!("OpenSSL builder error: {}", e)))?;

    // Accept any certificate (self-signed RDP certs)
    builder.set_verify(SslVerifyMode::NONE);

    // Disable session caching to prevent session resumption (CredSSP requirement)
    builder.set_session_cache_mode(SslSessionCacheMode::OFF);
    // Also disable session tickets (another form of session resumption)
    builder.set_options(SslOptions::NO_TICKET);

    // Explicitly allow TLS 1.0+ (server may only support TLS 1.0/1.1)
    builder.set_min_proto_version(Some(openssl::ssl::SslVersion::TLS1))
        .map_err(|e| std::io::Error::other(format!("OpenSSL min proto error: {}", e)))?;

    // Enable all cipher suites including CBC (Windows RDP servers may require CBC)
    // Use security level 0 (@SECLEVEL=0) to allow all protocols and weak ciphers
    // needed for Windows RDP server compatibility
    builder.set_cipher_list("ALL:@SECLEVEL=0")
        .map_err(|e| std::io::Error::other(format!("OpenSSL cipher error: {}", e)))?;

    let connector = builder.build();
    let ssl = openssl::ssl::Ssl::new(connector.context())
        .map_err(|e| std::io::Error::other(format!("OpenSSL SSL error: {}", e)))?;

    let mut tls_stream = tokio_openssl::SslStream::new(ssl, stream)
        .map_err(|e| std::io::Error::other(format!("OpenSSL stream error: {}", e)))?;

    Pin::new(&mut tls_stream).connect().await
        .map_err(|e| std::io::Error::other(format!("OpenSSL handshake error: {}", e)))?;

    tls_stream.flush().await?;

    // Extract the peer certificate
    let tls_cert = {
        use x509_cert::der::Decode as _;

        let peer_cert = tls_stream.ssl()
            .peer_certificate()
            .ok_or_else(|| std::io::Error::other("peer certificate is missing"))?;

        let cert_der = peer_cert.to_der()
            .map_err(|e| std::io::Error::other(format!("cert to_der error: {}", e)))?;

        x509_cert::Certificate::from_der(&cert_der)
            .map_err(std::io::Error::other)?
    };

    tracing::info!("OpenSSL: negotiated cipher = {:?}", tls_stream.ssl().current_cipher().map(|c| c.name()));

    Ok((tls_stream, tls_cert))
}

// ---------------------------------------------------------------------------
// Custom TLS upgrade using security-framework directly with:
// - No certificate verification (self-signed certs)
// - Unique peer_id per connection (prevents macOS session caching)
// - TLS 1.0 minimum (compatibility with older Windows RDP servers)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub(super) async fn tls_upgrade_native<S>(
    stream: S,
    domain: &str,
) -> std::io::Result<(tokio_native_tls::TlsStream<S>, x509_cert::Certificate)>
where
    S: Unpin + AsyncRead + AsyncWrite + Send + 'static,
{
    use tokio::io::AsyncWriteExt as _;

    // Build native-tls connector: accept any cert, no SNI, TLS 1.0+
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .use_sni(false)
        .min_protocol_version(Some(native_tls::Protocol::Tlsv10))
        .build()
        .map_err(|e| std::io::Error::other(format!("native-tls builder error: {}", e)))?;

    let connector = tokio_native_tls::TlsConnector::from(connector);
    let mut tls_stream = connector.connect(domain, stream).await
        .map_err(|e| std::io::Error::other(format!("native-tls handshake error: {}", e)))?;

    tls_stream.flush().await?;

    // Extract the peer certificate
    let tls_cert = {
        use x509_cert::der::Decode as _;

        let native_stream = tls_stream.get_ref();
        let peer_cert = native_stream
            .peer_certificate()
            .map_err(|e| std::io::Error::other(format!("peer cert error: {}", e)))?
            .ok_or_else(|| std::io::Error::other("peer certificate is missing"))?;

        let cert_der = peer_cert.to_der()
            .map_err(|e| std::io::Error::other(format!("cert to_der error: {}", e)))?;

        x509_cert::Certificate::from_der(&cert_der)
            .map_err(std::io::Error::other)?
    };

    Ok((tls_stream, tls_cert))
}
