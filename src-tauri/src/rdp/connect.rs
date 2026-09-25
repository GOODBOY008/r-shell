//! RDP connection establishment: TCP → X.224 → TLS → CredSSP/NLA finalize,
//! with automatic CredSSP → TLS-only fallback.

#[cfg(target_os = "macos")]
use super::tls::tls_upgrade_native;
use super::tls::tls_upgrade_openssl;
use super::ErasedStream;
use crate::desktop_protocol::RdpConfig;
use crate::rdp::input::InputCommand;
use anyhow::Result;
use ironrdp::connector::{
    ClientConnector, Config as IronRdpConfig, ConnectionResult, Credentials, DesktopSize,
    ServerName,
};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// Establish an RDP connection with NLA (CredSSP) preferred and automatic
/// fallback to TLS-only if CredSSP fails.
pub(super) async fn rdp_connect_inner(
    config: &RdpConfig,
    input_rx: mpsc::UnboundedReceiver<InputCommand>,
) -> Result<(
    ironrdp_tokio::TokioFramed<ErasedStream>,
    ConnectionResult,
    mpsc::UnboundedReceiver<InputCommand>,
)> {
    match rdp_connect_attempt(config, input_rx, true, true).await {
        Ok(v) => Ok(v),
        // The server answered the NTLM exchange with "bad credentials" —
        // a final verdict on the supplied username/password, not a
        // transport problem. Retrying TLS-only cannot help (every real
        // Windows host enforces NLA and refuses the downgrade), and the
        // fallback's combined error buries the actual cause. Fail fast
        // with the message the user can act on.
        Err((e, _rx)) if is_logon_rejection(&e) => Err(anyhow::anyhow!(
            "RDP logon rejected by {}: the username or password is incorrect — \
             check the credentials and domain before reconnecting (server said: {})",
            config.host,
            e
        )),
        Err((e, rx)) if is_credssp_error(&e) => {
            tracing::warn!("RDP CredSSP/NLA failed ({}), retrying TLS-only", e);
            rdp_connect_attempt(config, rx, false, true)
                .await
                .map_err(|(e2, _rx)| {
                    anyhow::anyhow!("RDP connect failed (NLA: {}, TLS-only: {})", e, e2)
                })
        }
        Err((e, _rx)) => Err(e),
    }
}

/// Did the server explicitly reject the credentials during CredSSP? These
/// NT status codes come back from a working NLA stack (proven against real
/// Windows) and are the user's cue to re-check username/password/domain.
fn is_logon_rejection(e: &anyhow::Error) -> bool {
    let s = format!("{:?}", e);
    // STATUS_LOGON_FAILURE / STATUS_WRONG_PASSWORD / STATUS_NO_SUCH_USER —
    // matched on the debug repr because the sspi error is nested inside the
    // ironrdp error's `kind` field, out of reach of anyhow's downcast.
    s.contains("NStatusCode(0xc000006d)")
        || s.contains("NStatusCode(0xc000006a)")
        || s.contains("NStatusCode(0xc0000064)")
}

/// Heuristic: did the connection fail due to CredSSP/NLA specifically?
/// On such failures we retry with `enable_credssp = false` (TLS-only).
fn is_credssp_error(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_lowercase();
    if s.contains("credssp") || s.contains("nla") || s.contains("access denied") {
        return true;
    }
    // Windows Server 2025+ fails CredSSP with TLS alert 80 ("internal_error")
    // when the pub_key_auth hash mismatches (e.g. full cert DER passed instead
    // of the SubjectPublicKey bits) — treat as CredSSP failure, fall back to
    // TLS-only. See sspi-rs#651.
    if s.contains("alert number 80") {
        return true;
    }
    if s.contains("read frame by hint")
        && (s.contains("internal error") || s.contains("internal_error"))
    {
        return true;
    }
    false
}

/// Connect with a chosen `enable_credssp` mode. On failure, returns the error
/// paired with the `input_rx` so the caller can retry with a different mode.
async fn rdp_connect_attempt(
    config: &RdpConfig,
    input_rx: mpsc::UnboundedReceiver<InputCommand>,
    enable_credssp: bool,
    enable_tls: bool,
) -> Result<
    (
        ironrdp_tokio::TokioFramed<ErasedStream>,
        ConnectionResult,
        mpsc::UnboundedReceiver<InputCommand>,
    ),
    (anyhow::Error, mpsc::UnboundedReceiver<InputCommand>),
> {
    // Run the connection logic; if it fails, pair the error with `input_rx`
    // (which was not consumed by the handshake) so the caller can retry.
    let result: Result<
        (ironrdp_tokio::TokioFramed<ErasedStream>, ConnectionResult),
        anyhow::Error,
    > = rdp_connect_attempt_body(config, enable_credssp, enable_tls).await;

    match result {
        Ok((framed, connection_result)) => Ok((framed, connection_result, input_rx)),
        Err(e) => Err((e, input_rx)),
    }
}

async fn rdp_connect_attempt_body(
    config: &RdpConfig,
    enable_credssp: bool,
    enable_tls: bool,
) -> Result<
    (ironrdp_tokio::TokioFramed<ErasedStream>, ConnectionResult),
    anyhow::Error,
> {
    let dest = format!("{}:{}", config.host, config.port);
    tracing::info!("RDP connecting to {} (credssp={}, tls={})", dest, enable_credssp, enable_tls);

    // ── 1. TCP connect ──────────────────────────────────────────────────
    tracing::info!("RDP: attempting TCP connect to {}", dest);
    let stream = tokio::time::timeout(Duration::from_secs(30), TcpStream::connect(&dest))
        .await
        .map_err(|_| anyhow::anyhow!("RDP TCP connection timeout after 30s to {}", dest))?
        .map_err(|e| anyhow::anyhow!("RDP TCP connect to {} failed: {}", dest, e))?;
    tracing::info!("RDP: TCP connected to {}", dest);

    let client_addr = stream
        .local_addr()
        .unwrap_or_else(|_| "0.0.0.0:0".parse::<SocketAddr>().unwrap());

    // ── 2. Build ironrdp connector config ────────────────────────────────
    let mut framed = ironrdp_tokio::TokioFramed::new(stream);
    let mut connector = new_connector(config, client_addr, enable_credssp, enable_tls);

    // ── 3. connect_begin (X.224 negotiation) ────────────────────────────
    tracing::info!("RDP: starting X.224 negotiation");
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(|e| anyhow::anyhow!("RDP negotiation failed: {}", e))?;
    tracing::info!("RDP: X.224 negotiation complete, upgrading to TLS");

    // ── 4. TLS upgrade ──────────────────────────────────────────────────
    // Strategy: OpenSSL first, falls back to native-tls if OpenSSL fails.
    let (initial_stream, leftover_bytes) = framed.into_inner();

    tracing::info!("RDP: trying OpenSSL TLS (host={})", config.host);
    let (tls_stream, tls_cert, final_leftover, mut final_connector, final_should_upgrade): (ErasedStream, x509_cert::Certificate, _, ClientConnector, _) =
        match tls_upgrade_openssl(initial_stream, &config.host).await {
        Ok((stream, cert)) => {
            tracing::info!("RDP: TLS upgrade succeeded (OpenSSL, host={})", config.host);
            (Box::new(stream) as ErasedStream, cert, leftover_bytes, connector, should_upgrade)
        }
        Err(e) => {
            tracing::warn!("RDP OpenSSL TLS failed: {:?}, falling back to native-tls", e);
            // Reconnect TCP and redo X.224 negotiation
            tracing::info!("RDP: reconnecting TCP for native-tls fallback");
            let new_stream = tokio::time::timeout(Duration::from_secs(30), TcpStream::connect(&dest))
                .await
                .map_err(|_| anyhow::anyhow!("RDP TCP reconnect timeout"))?
                .map_err(|e| anyhow::anyhow!("RDP TCP reconnect failed: {}", e))?;

            let mut new_framed = ironrdp_tokio::TokioFramed::new(new_stream);
            let mut new_connector = new_connector(config, client_addr, enable_credssp, enable_tls);
            let new_should_upgrade = ironrdp_tokio::connect_begin(&mut new_framed, &mut new_connector)
                .await
                .map_err(|e| anyhow::anyhow!("RDP re-negotiation failed: {}", e))?;

            #[cfg(target_os = "macos")]
            {
                let (stream2, leftover2) = new_framed.into_inner();
                let native_sni = "rdp.local".to_string();
                tracing::info!("RDP: trying native-tls (host={}, sni={})", config.host, native_sni);
                match tls_upgrade_native(stream2, &native_sni).await {
                    Ok((stream, cert)) => {
                        tracing::info!("RDP: TLS upgrade succeeded (native-tls, sni={})", native_sni);
                        let _ = leftover_bytes;
                        (Box::new(stream) as ErasedStream, cert, leftover2, new_connector, new_should_upgrade)
                    }
                    Err(e2) => {
                        tracing::error!("RDP native-tls also failed: {:?}", e2);
                        return Err(anyhow::anyhow!("RDP TLS upgrade failed (OpenSSL: {}, native-tls: {})", e, e2));
                    }
                }
            }

            #[cfg(not(target_os = "macos"))]
            {
                return Err(anyhow::anyhow!("RDP TLS upgrade failed: {}", e));
            }
        }
    };

    // ── 4b. TOFU certificate pinning ────────────────────────────────────
    // The TLS layer accepts self-signed certificates (the RDP norm), but
    // the leaf certificate is pinned on first sight and any later change
    // fails closed — a MITM presenting its own certificate cannot intercept
    // CredSSP credentials. Runs before any credential is sent.
    {
        use x509_cert::der::Encode as _;
        let cert_der = tls_cert
            .to_der()
            .map_err(|e| anyhow::anyhow!("RDP cert encode failed: {}", e))?;
        super::cert_store::verify_or_pin(&config.host, config.port, &cert_der)?;
    }

    let upgraded = ironrdp_tokio::mark_as_upgraded(final_should_upgrade, &mut final_connector);

    let mut upgraded_framed =
        ironrdp_tokio::TokioFramed::new_with_leftover(tls_stream, final_leftover);

    // ── 5. connect_finalize (TLS-only or CredSSP/NLA) ─────────────────
    tracing::info!("RDP: finalizing connection (credssp={})", enable_credssp);

    // CredSSP's pub_key_auth hashes the server certificate's SubjectPublicKey
    // BIT STRING bits, NOT the full certificate DER. Windows Server 2025
    // enforces this strictly and tears down CredSSP with TLS alert 80
    // (internal_error) otherwise — see sspi-rs#651. Same extraction as
    // ironrdp-tls's extract_tls_server_public_key.
    let server_public_key: Vec<u8> = tls_cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| anyhow::anyhow!("TLS cert public key is not byte-aligned"))?
        .to_vec();

    // Use SPNEGO/Negotiate (Kerberos fallback to NTLM) instead of raw NTLM.
    // Some Windows servers reject raw NTLM CredSSP but accept Negotiate.
    let kerberos_config = if enable_credssp {
        Some(
            ironrdp::connector::credssp::KerberosConfig::new(None, config.host.clone())
                .map_err(|e| anyhow::anyhow!("KerberosConfig error: {}", e))?,
        )
    } else {
        None
    };

    let server_name: ServerName = (&dest).into();
    let connection_result = match ironrdp_tokio::connect_finalize(
        upgraded,
        final_connector,
        &mut upgraded_framed,
        &mut ironrdp_tokio::reqwest::ReqwestNetworkClient::new(),
        server_name,
        server_public_key,
        kerberos_config,
    )
    .await
    {
        Ok(result) => {
            tracing::info!("RDP: connection finalized successfully");
            result
        }
        Err(e) => {
            tracing::error!("RDP connection finalization failed: {:?}", e);
            return Err(anyhow::anyhow!("RDP connection finalization failed: {:?}", e));
        }
    };

    // Log leftover buffer state after connect_finalize
    {
        let (_, buf) = upgraded_framed.get_inner();
        if !buf.is_empty() {
            tracing::warn!("RDP: unexpected leftover after connect_finalize: {} bytes", buf.len());
        }
    }

    Ok((upgraded_framed, connection_result))
}

// ---------------------------------------------------------------------------
// Connector configuration helpers
// ---------------------------------------------------------------------------

fn build_ironrdp_config(cfg: &RdpConfig, enable_credssp: bool, enable_tls: bool) -> IronRdpConfig {
    use ironrdp::pdu::gcc::KeyboardType;
    use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
    use ironrdp::pdu::rdp::client_info::PerformanceFlags;

    IronRdpConfig {
        desktop_size: DesktopSize {
            width: cfg.width,
            height: cfg.height,
        },
        desktop_scale_factor: 100,
        enable_tls,
        enable_credssp,
        credentials: Credentials::UsernamePassword {
            username: cfg.username.clone(),
            password: cfg.password.clone(),
        },
        domain: cfg.domain.clone(),
        client_build: 0,
        client_name: "r-shell".to_string(),
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        platform: MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: Default::default(),
        compression_type: None,
        enable_server_pointer: true,
        pointer_software_rendering: false,
        multitransport_flags: None,
    }
}

/// Build a `ClientConnector` with the Display Control dynamic virtual channel
/// registered, enabling server-side display resize via `encode_resize`.
fn new_connector(config: &RdpConfig, client_addr: SocketAddr, enable_credssp: bool, enable_tls: bool) -> ClientConnector {
    use ironrdp::dvc::DrdynvcClient;
    use ironrdp::displaycontrol::client::DisplayControlClient;

    ClientConnector::new(build_ironrdp_config(config, enable_credssp, enable_tls), client_addr).with_static_channel(
        DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new()))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unit test: CredSSP error heuristic recognizes TLS alert 80.
    #[test]
    fn credssp_heuristic_detects_alert_80() {
        let e = anyhow::anyhow!("tlsv1 alert internal error (SSL alert number 80)");
        assert!(is_credssp_error(&e));

        let e2 = anyhow::anyhow!("read frame by hint: internal_error");
        assert!(is_credssp_error(&e2));

        let e3 = anyhow::anyhow!("CredSSP negotiation failed");
        assert!(is_credssp_error(&e3));

        let e4 = anyhow::anyhow!("TCP connection timeout");
        assert!(!is_credssp_error(&e4));
    }
}
