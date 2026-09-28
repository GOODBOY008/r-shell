use std::future::Future;
use std::pin::Pin;

use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use sspi::network_client::{AsyncNetworkClient, NetworkClient};
use sspi::{Error, ErrorKind, NetworkRequest, Result};

#[derive(Debug)]
pub(super) struct SyncNetworkClient;

impl AsyncNetworkClient for SyncNetworkClient {
    fn send<'a>(&'a mut self, request: &'a NetworkRequest) -> Pin<Box<dyn Future<Output = Result<Vec<u8>>> + 'a>> {
        let request = request.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ReqwestNetworkClient.send(&request))
                .await
                .map_err(|err| Error::new(ErrorKind::InternalError, err))?
        })
    }
}
