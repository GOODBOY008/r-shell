use dpapi_core::{EncodeVec, decode_owned};
use dpapi_pdu::gkdi::{GetKey, GroupKeyEnvelope};
use dpapi_pdu::rpc::{
    BindAck, BindTimeFeatureNegotiationBitmask, Command, CommandFlags, CommandPContext, ContextElement,
    ContextResultCode, EPM, EntryHandle, EptMap, EptMapResult, Floor, Response, SecurityTrailer, VerificationTrailer,
    build_tcpip_tower,
};
use dpapi_transport::{ConnectOptions, ProxyOptions, Transport};
use picky_asn1_x509::enveloped_data::{ContentEncryptionAlgorithmIdentifier, KeyEncryptionAlgorithmIdentifier};
use picky_asn1_x509::{AesMode, AesParameters};
use sspi::credssp::SspiContext;
use sspi::negotiate::ProtocolConfig;
use sspi::network_client::AsyncNetworkClient;
use sspi::ntlm::NtlmConfig;
use sspi::{AuthIdentity, Credentials, KerberosConfig, Negotiate, NegotiateConfig, Secret, Username};
use thiserror::Error;
use uuid::Uuid;

use crate::blob::{DpapiBlob, SidProtectionDescriptor};
use crate::crypto::{cek_decrypt, cek_encrypt, cek_generate, content_decrypt, content_encrypt};
use crate::gkdi::{ISD_KEY, get_kek, new_kek, unpack_response};
use crate::rpc::auth::AuthError;
use crate::rpc::{AuthProvider, NDR, NDR64, RpcClient, bind_time_feature_negotiation};
use crate::{Error, Result};

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("BindAcknowledge doesn't contain desired context element")]
    MissingDesiredContext,

    #[error("TCP floor is missing in EptMap response")]
    MissingTcpFloor,

    #[error("bad EptMap response status: {0}")]
    BadEptMapStatus(u32),

    #[error("failed to set rustls crypto provider")]
    CryptoProvider,
}

fn get_epm_contexts() -> Vec<ContextElement> {
    vec![ContextElement {
        context_id: 0,
        abstract_syntax: EPM,
        transfer_syntaxes: vec![NDR64],
    }]
}

fn get_isd_key_key_contexts() -> Vec<ContextElement> {
    vec![
        ContextElement {
            context_id: 0,
            abstract_syntax: ISD_KEY,
            transfer_syntaxes: vec![NDR64],
        },
        ContextElement {
            context_id: 1,
            abstract_syntax: ISD_KEY,
            transfer_syntaxes: vec![bind_time_feature_negotiation(BindTimeFeatureNegotiationBitmask::None)],
        },
    ]
}

fn get_ept_map_isd_key() -> EptMap {
    EptMap {
        obj: None,
        tower: build_tcpip_tower(ISD_KEY, NDR, 135, 0),
        entry_handle: EntryHandle(None),
        max_towers: 4,
    }
}

fn get_verification_trailer() -> VerificationTrailer {
    VerificationTrailer {
        commands: vec![Command::Pcontext(CommandPContext {
            flags: CommandFlags::SecVtCommandEnd,
            interface_id: ISD_KEY,
            transfer_syntax: NDR64,
        })],
    }
}

#[instrument(level = "trace", ret)]
fn process_bind_result(requested_contexts: &[ContextElement], bind_ack: BindAck, desired_context: u16) -> Result<()> {
    bind_ack
        .results
        .iter()
        .enumerate()
        .filter_map(|(index, result)| {
            if result.result == ContextResultCode::Acceptance {
                requested_contexts.get(index).map(|ctx| ctx.context_id)
            } else {
                None
            }
        })
        .find(|context_id| *context_id == desired_context)
        .ok_or(ClientError::MissingDesiredContext)?;

    Ok(())
}

#[instrument(level = "trace", ret)]
fn process_ept_map_result(response: &Response) -> Result<u16> {
    let map_response: EptMapResult = decode_owned(response.stub_data.as_slice())?;

    if map_response.status != 0 {
        Err(ClientError::BadEptMapStatus(map_response.status))?;
    }

    for tower in map_response.towers {
        for floor in tower {
            if let Floor::Tcp(tcp_floor) = floor {
                return Ok(tcp_floor.port);
            }
        }
    }

    Err(Error::from(ClientError::MissingTcpFloor))
}

#[instrument(level = "trace", ret)]
fn process_get_key_result(response: &Response, security_trailer: Option<SecurityTrailer>) -> Result<GroupKeyEnvelope> {
    let pad_length = response.stub_data.len()
        - security_trailer
            .as_ref()
            .map(|sec_trailer| usize::from(sec_trailer.pad_length))
            .unwrap_or_default();
    trace!(pad_length);

    let data = &response.stub_data[..pad_length];

    unpack_response(data)
}

#[instrument(ret, level = "debug")]
fn decrypt_blob(blob: &DpapiBlob, key: &GroupKeyEnvelope) -> Result<Vec<u8>> {
    let kek = get_kek(key, &blob.key_identifier)?;

    // With the kek we can unwrap the encrypted cek in the LAPS payload.
    let cek = cek_decrypt(&blob.enc_cek_algorithm_id, &kek, &blob.enc_cek)?;

    // With the cek we can decrypt the encrypted content in the LAPS payload.
    Ok(content_decrypt(
        &blob.enc_content_algorithm_id,
        &cek,
        &blob.enc_content,
    )?)
}

#[instrument(ret, level = "debug")]
fn encrypt_blob(
    data: &[u8],
    key: &GroupKeyEnvelope,
    protection_descriptor: SidProtectionDescriptor,
) -> Result<Vec<u8>> {
    let enc_cek_algorithm_id = KeyEncryptionAlgorithmIdentifier::new_aes256_empty(AesMode::Wrap);
    let (cek, iv) = cek_generate(&enc_cek_algorithm_id)?;

    let enc_content_algorithm_id =
        ContentEncryptionAlgorithmIdentifier::new_aes256(AesMode::Gcm, AesParameters::InitializationVector(iv.into()));

    let enc_content = content_encrypt(&enc_content_algorithm_id, &cek, data)?;

    let (kek, key_identifier) = new_kek(key)?;
    let enc_cek = cek_encrypt(&enc_cek_algorithm_id, &kek, &cek)?;

    let mut buf = Vec::new();

    DpapiBlob {
        key_identifier,
        protection_descriptor,
        enc_cek,
        enc_cek_algorithm_id,
        enc_content,
        enc_content_algorithm_id,
    }
    .encode(true, &mut buf)?;

    Ok(buf)
}

struct GetKeyArgs<'server, 'a> {
    server: &'server str,
    proxy: Option<ProxyOptions>,
    target_sd: Vec<u8>,
    root_key_id: Option<Uuid>,
    l0: i32,
    l1: i32,
    l2: i32,
    username: Username,
    password: Secret<String>,
    negotiate_config: NegotiateConfig,
    network_client: &'a mut dyn AsyncNetworkClient,
}

async fn get_key<T: Transport>(
    GetKeyArgs {
        server,
        proxy,
        target_sd,
        root_key_id,
        l0,
        l1,
        l2,
        username,
        password,
        negotiate_config,
        network_client,
    }: GetKeyArgs<'_, '_>,
) -> Result<GroupKeyEnvelope> {
    let mut connection_options = ConnectOptions::new(server, proxy)?;

    let mut rpc = RpcClient::<T>::connect(
        &connection_options,
        AuthProvider::new(
            SspiContext::Negotiate(Negotiate::new_client(negotiate_config.clone()).map_err(AuthError::from)?),
            Credentials::AuthIdentity(AuthIdentity {
                username: username.clone(),
                password: password.clone(),
            }),
            server,
            network_client,
        )?,
    )
    .await?;

    debug!("RPC connection has been established");

    let epm_contexts = get_epm_contexts();
    let context_id = epm_contexts[0].context_id;
    let bind_ack = rpc.bind(&epm_contexts).await?;

    debug!("RPC bind/bind_ack finished successfully");

    process_bind_result(&epm_contexts, bind_ack, context_id)?;

    let ept_map = get_ept_map_isd_key();
    let response = rpc.request(0, EptMap::OPNUM, ept_map.encode_vec()?).await?;

    let isd_key_port = process_ept_map_result(&response.try_into_response()?)?;

    debug!(isd_key_port);

    connection_options.set_destination_port(isd_key_port);

    let mut rpc = RpcClient::<T>::connect(
        &connection_options,
        AuthProvider::new(
            SspiContext::Negotiate(Negotiate::new_client(negotiate_config).map_err(AuthError::from)?),
            Credentials::AuthIdentity(AuthIdentity { username, password }),
            server,
            network_client,
        )?,
    )
    .await?;

    debug!("RPC connection has been established");

    let isd_key_contexts = get_isd_key_key_contexts();
    let context_id = isd_key_contexts[0].context_id;
    let bind_ack = rpc.bind_authenticate(&isd_key_contexts).await?;

    debug!("RPC bind/bind_ack finished successfully");

    process_bind_result(&isd_key_contexts, bind_ack, context_id)?;

    let get_key = GetKey {
        target_sd,
        root_key_id,
        l0_key_id: l0,
        l1_key_id: l1,
        l2_key_id: l2,
    };

    let response_pdu = rpc
        .authenticated_request(
            context_id,
            GetKey::OPNUM,
            get_key.encode_vec()?,
            Some(get_verification_trailer()),
        )
        .await?;
    let security_trailer = response_pdu.security_trailer.clone();

    debug!("RPC GetKey Request finished successfully");

    process_get_key_result(&response_pdu.try_into_response()?, security_trailer)
}

fn try_get_negotiate_config(
    client_computer_name: Option<String>,
    kerberos_config: Option<KerberosConfig>,
) -> Result<NegotiateConfig> {
    let client_computer_name = if let Some(kerberos_config) = kerberos_config.as_ref() {
        kerberos_config.client_computer_name.clone()
    } else if let Some(name) = client_computer_name {
        name
    } else {
        whoami::hostname().map_err(|e| Error::Io(std::io::Error::other(e)))?
    };

    let protocol_config: Box<dyn ProtocolConfig> = if let Some(kerberos_config) = kerberos_config {
        Box::new(kerberos_config)
    } else {
        Box::new(NtlmConfig {
            client_computer_name: Some(client_computer_name.clone()),
        })
    };

    Ok(NegotiateConfig::from_protocol_config(
        protocol_config,
        client_computer_name,
    ))
}

/// Arguments for `n_crypt_unprotect_secret` function.
pub struct CryptUnprotectSecretArgs<'server, 'blob, 'username, 'a> {
    /// Secret to encrypt.
    pub blob: &'blob [u8],
    /// Target server hostname.
    pub server: &'server str,
    /// Websocket proxy address.
    pub proxy: Option<ProxyOptions>,
    /// Username to encrypt the DPAPI blob.
    pub username: &'username str,
    /// User's password.
    pub password: Secret<String>,
    /// Client's computer name.
    pub client_computer_name: Option<String>,
    /// Network client for communicating with the KDC.
    pub network_client: &'a mut dyn AsyncNetworkClient,
    /// Optional Kerberos config.
    pub kerberos_config: Option<KerberosConfig>,
}

/// Decrypt the DPAPI blob.
///
/// This function simulated the `NCryptUnprotectSecret` function. Decryption requires making RPC calls to the domain.
/// The username can be specified in FQDN (DOMAIN\username) or UPN (username@domain) format.
/// _Note_: `server` value should be target domain server hostname. Do not use IP address here.
///
/// MSDN:
/// * [NCryptUnprotectSecret function (ncryptprotect.h)](https://learn.microsoft.com/en-us/windows/win32/api/ncryptprotect/nf-ncryptprotect-ncryptunprotectsecret).
pub async fn n_crypt_unprotect_secret<T: Transport>(
    CryptUnprotectSecretArgs {
        blob,
        server,
        proxy,
        username,
        password,
        client_computer_name,
        kerberos_config,
        network_client,
    }: CryptUnprotectSecretArgs<'_, '_, '_, '_>,
) -> Result<Secret<Vec<u8>>> {
    let dpapi_blob = DpapiBlob::decode(blob)?;
    let target_sd = dpapi_blob.protection_descriptor.get_target_sd()?;
    let username = Username::parse(username)
        .map_err(sspi::Error::from)
        .map_err(AuthError::from)?;

    let root_key = Box::pin(get_key::<T>(GetKeyArgs {
        server,
        proxy,
        target_sd,
        root_key_id: Some(dpapi_blob.key_identifier.root_key_identifier),
        l0: dpapi_blob.key_identifier.l0,
        l1: dpapi_blob.key_identifier.l1,
        l2: dpapi_blob.key_identifier.l2,
        username,
        password,
        negotiate_config: try_get_negotiate_config(client_computer_name, kerberos_config)?,
        network_client,
    }))
    .await?;

    debug!("Successfully requested root key");

    Ok(decrypt_blob(&dpapi_blob, &root_key)?.into())
}

/// Arguments for `n_crypt_protect_secret` function.
pub struct CryptProtectSecretArgs<'server, 'username, 'a> {
    /// Secret to encrypt.
    pub data: Secret<Vec<u8>>,
    /// User's SID.
    pub sid: String,
    /// Root key id.
    pub root_key_id: Option<Uuid>,
    /// Target server hostname.
    pub server: &'server str,
    /// Websocket proxy address.
    pub proxy: Option<ProxyOptions>,
    /// Username to encrypt the DPAPI blob.
    pub username: &'username str,
    /// User's password.
    pub password: Secret<String>,
    /// Client's computer name.
    pub client_computer_name: Option<String>,
    /// Network client for communicating with the KDC.
    pub network_client: &'a mut dyn AsyncNetworkClient,
    /// Optional Kerberos config.
    pub kerberos_config: Option<KerberosConfig>,
}

/// Encrypts data to a specified protection descriptor.
///
/// This function simulated the `NCryptProtectSecret` function. Encryption requires making RPCs call to the domain.
/// The username can be specified in FQDN (DOMAIN\username) or UPN (username@domain) format.
/// _Note_: `server` value should be target domain server hostname. Do not use IP address here.
///
/// MSDN:
/// * [NCryptProtectSecret function (`ncryptprotect.h`)](https://learn.microsoft.com/en-us/windows/win32/api/ncryptprotect/nf-ncryptprotect-ncryptprotectsecret).
pub async fn n_crypt_protect_secret<T: Transport>(
    CryptProtectSecretArgs {
        data,
        sid,
        root_key_id,
        server,
        proxy,
        username,
        password,
        client_computer_name,
        network_client,
        kerberos_config,
    }: CryptProtectSecretArgs<'_, '_, '_>,
) -> Result<Vec<u8>> {
    let l0 = -1;
    let l1 = -1;
    let l2 = -1;

    let descriptor = SidProtectionDescriptor { sid };
    let target_sd = descriptor.get_target_sd()?;
    let username = Username::parse(username)
        .map_err(sspi::Error::from)
        .map_err(AuthError::from)?;

    let root_key = Box::pin(get_key::<T>(GetKeyArgs {
        server,
        proxy,
        target_sd,
        root_key_id,
        l0,
        l1,
        l2,
        username,
        password,
        negotiate_config: try_get_negotiate_config(client_computer_name, kerberos_config)?,
        network_client,
    }))
    .await?;

    debug!("Successfully requested root key");

    encrypt_blob(data.as_ref(), &root_key, descriptor)
}
