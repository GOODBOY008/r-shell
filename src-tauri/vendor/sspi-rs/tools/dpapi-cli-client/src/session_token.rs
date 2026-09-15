use std::env;
use std::future::Future;
use std::io::{Error, Result};
use std::pin::Pin;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

#[derive(Serialize)]
struct ForwardRequest<'dst> {
    pub validity_duration: Option<u64>,
    pub dst_hst: &'dst str,
    pub jet_ap: Option<&'static str>,
    pub jet_aid: Option<Uuid>,
    pub jet_rec: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

/// Obtains the session token from the [tokengen server](https://github.com/Devolutions/devolutions-gateway/tree/master/tools/tokengen).
///
/// Parameters:
/// * `session_id` - connection session id.
/// * `destination` - target RPC server address.
pub fn get_session_token(session_id: Uuid, destination: Url) -> Pin<Box<dyn Future<Output = Result<String>>>> {
    let connection_url = Url::parse(&env::var("DG_CONNECTION_URL").unwrap()).unwrap();

    Box::pin(async move {
        let TokenResponse { token } = Client::new()
            .post(connection_url)
            .json(&ForwardRequest {
                validity_duration: Some(60 * 60),
                dst_hst: destination.as_str(),
                jet_ap: Some("unknown"),
                jet_aid: Some(session_id),
                jet_rec: false,
            })
            .send()
            .await
            .map_err(Error::other)?
            .error_for_status()
            .map_err(Error::other)?
            .json()
            .await
            .map_err(Error::other)?;

        Ok(token)
    })
}
