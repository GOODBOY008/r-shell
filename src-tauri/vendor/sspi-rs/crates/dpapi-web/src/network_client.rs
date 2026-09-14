use std::future::Future;
use std::pin::Pin;

use dpapi::sspi::network_client::AsyncNetworkClient;
use dpapi::sspi::{Error, ErrorKind, NetworkProtocol, NetworkRequest, Result};

#[derive(Debug)]
pub(crate) struct WasmNetworkClient;

impl AsyncNetworkClient for WasmNetworkClient {
    fn send<'a>(
        &'a mut self,
        network_request: &'a NetworkRequest,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>>> + 'a>> {
        Box::pin(async move {
            debug!(?network_request.protocol, ?network_request.url);

            match &network_request.protocol {
                NetworkProtocol::Http | NetworkProtocol::Https => {
                    let body = js_sys::Uint8Array::from(&network_request.data[..]);

                    let response = gloo_net::http::Request::post(network_request.url.as_str())
                        .header("keep-alive", "true")
                        .body(body)
                        .map_err(|e| {
                            Error::new(
                                ErrorKind::NoAuthenticatingAuthority,
                                format!("failed to send KDC request: {e}"),
                            )
                        })?
                        .send()
                        .await
                        .map_err(|err| match err {
                            err if err.to_string().to_lowercase().contains("certificate") => Error::new(
                                ErrorKind::CertificateUnknown,
                                format!("Invalid certificate data: {:?}", err),
                            ),
                            _ => Error::new(
                                ErrorKind::NoAuthenticatingAuthority,
                                format!("Unable to send the data to the KDC Proxy: {:?}", err),
                            ),
                        })?;

                    if !response.ok() {
                        return Err(Error::new(
                            ErrorKind::NoAuthenticatingAuthority,
                            format!(
                                "KdcProxy: HTTP status error ({} {})",
                                response.status(),
                                response.status_text(),
                            ),
                        ));
                    }

                    let body = response.binary().await.map_err(|err| {
                        Error::new(
                            ErrorKind::NoAuthenticatingAuthority,
                            format!("Unable to read the response data from the KDC Proxy: {:?}", err),
                        )
                    })?;

                    Ok(body)
                }
                unsupported => Err(Error::new(
                    ErrorKind::ApplicationProtocolMismatch,
                    format!("unsupported protocol: {unsupported:?}"),
                )),
            }
        })
    }
}
