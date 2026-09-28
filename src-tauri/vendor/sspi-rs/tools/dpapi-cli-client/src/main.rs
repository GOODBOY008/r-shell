#![doc = include_str!("../README.md")]
#![warn(missing_docs)]
#![warn(clippy::large_futures)]

mod cli;
mod logging;
mod network_client;
mod session_token;

use std::fs;
use std::io::{Error, ErrorKind, Read, Result, Write, stdin, stdout};

use dpapi::{CryptProtectSecretArgs, CryptUnprotectSecretArgs};
use dpapi_native_transport::NativeTransport;
use dpapi_transport::ProxyOptions;
use url::Url;

use crate::cli::{Decrypt, Dpapi, DpapiCmd, Encrypt};

async fn run(data: Dpapi) -> Result<()> {
    logging::init_logging();

    sspi::install_default_crypto_provider_if_necessary()
        .map_err(|_| Error::other("failed to initialize default crypto provider"))?;

    let Dpapi {
        server,
        proxy_address,
        username,
        password,
        computer_name,
        subcommand,
    } = data;

    let proxy = proxy_address
        .as_ref()
        .map(|proxy| {
            Result::Ok(ProxyOptions {
                proxy: Url::parse(proxy).map_err(|err| {
                    Error::new(
                        ErrorKind::InvalidData,
                        format!("invalid proxy URL ({:?}): {:?}", proxy, err),
                    )
                })?,
                get_session_token: Box::new(session_token::get_session_token),
            })
        })
        .transpose()?;
    let mut network_client = network_client::SyncNetworkClient;

    match subcommand {
        DpapiCmd::Encrypt(Encrypt { sid, secret }) => {
            let secret = if let Some(secret) = secret {
                secret.into_bytes()
            } else {
                stdin().bytes().collect::<Result<Vec<_>>>()?
            };

            let blob = Box::pin(dpapi::n_crypt_protect_secret::<NativeTransport>(
                CryptProtectSecretArgs {
                    data: secret.into(),
                    sid,
                    root_key_id: None,
                    server: &server,
                    proxy,
                    username: &username,
                    password: password.into(),
                    client_computer_name: computer_name,
                    network_client: &mut network_client,
                    kerberos_config: None,
                },
            ))
            .await
            .unwrap();

            stdout().write_all(&blob)?;
        }
        DpapiCmd::Decrypt(Decrypt { file }) => {
            let blob = if let Some(file) = file {
                fs::read(file)?
            } else {
                stdin().bytes().collect::<Result<Vec<_>>>()?
            };

            let secret = Box::pin(dpapi::n_crypt_unprotect_secret::<NativeTransport>(
                CryptUnprotectSecretArgs {
                    blob: &blob,
                    server: &server,
                    proxy,
                    username: &username,
                    password: password.into(),
                    client_computer_name: computer_name,
                    network_client: &mut network_client,
                    kerberos_config: None,
                },
            ))
            .await
            .unwrap();

            stdout().write_all(secret.as_ref())?;
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match Dpapi::from_env() {
        Ok(flags) => run(flags).await,
        Err(err) => err.exit(),
    }
}
