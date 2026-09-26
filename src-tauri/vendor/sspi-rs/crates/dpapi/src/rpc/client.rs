use dpapi_core::{EncodeVec, FixedPartSize, compute_padding, decode_owned};
use dpapi_pdu::rpc::{
    AlterContext, Bind, BindAck, BindTimeFeatureNegotiationBitmask, ContextElement, ContextResultCode, DataRepr,
    PacketFlags, PacketType, Pdu, PduData, PduHeader, Request, SecurityTrailer, SyntaxId, VerificationTrailer,
};
use dpapi_transport::{ConnectOptions, Stream, Transport};
use thiserror::Error;
use uuid::{Uuid, uuid};

use crate::Result;
use crate::rpc::AuthProvider;

pub const NDR64: SyntaxId = SyntaxId {
    uuid: uuid!("71710533-beba-4937-8319-b5dbef9ccc36"),
    version: 1,
    version_minor: 0,
};
pub const NDR: SyntaxId = SyntaxId {
    uuid: uuid!("8a885d04-1ceb-11c9-9fe8-08002b104860"),
    version: 2,
    version_minor: 0,
};
pub const CALL_ID: u32 = 1;

pub fn bind_time_feature_negotiation(flags: BindTimeFeatureNegotiationBitmask) -> SyntaxId {
    SyntaxId {
        uuid: Uuid::from_fields(0x6cb71c2c, 0x9812, 0x4540, &flags.as_u64().to_be_bytes()),
        version: 1,
        version_minor: 0,
    }
}

#[derive(Debug, Error)]
pub enum RpcClientError {
    #[error("invalid encryption offset: {0}")]
    InvalidEncryptionOffset(&'static str),
}

/// Represents structural offsets in RPC PDU.
///
/// This structure is used to split the encoded RPC PDU into separate parts before encryption or decryption.
#[derive(Debug, Copy, Clone)]
struct EncryptionOffsets {
    /// RPC PDU header length.
    pub pdu_header_len: usize,
    /// Indicated how many bytes precede RPC PDU security trailer.
    pub security_trailer_offset: usize,
}

impl EncryptionOffsets {
    /// RPC PDU header length + RPC Request header data length.
    const REQUEST_PDU_HEADER_LEN: usize = 24;
}

/// General RPC client.
///
/// All RPC communication is done using this RPC client. It can connect to RPC server,
/// authenticate, and send RPC requests.
pub struct RpcClient<'a, T: Transport> {
    stream: T::Stream,
    sign_header: bool,
    auth: AuthProvider<'a>,
}

impl<'a, T: Transport> RpcClient<'a, T> {
    /// Connects to the RPC server.
    ///
    /// Returns a new RPC client that is ready to send/receive data.
    pub async fn connect(connection_options: &ConnectOptions, auth: AuthProvider<'a>) -> Result<Self> {
        let stream = T::connect(connection_options).await?;

        Ok(Self {
            stream,
            sign_header: false,
            auth,
        })
    }

    fn create_pdu_header(packet_type: PacketType, packet_flags: PacketFlags, auth_len: u16, call_id: u32) -> PduHeader {
        PduHeader {
            version: 5,
            version_minor: 0,
            packet_type,
            packet_flags: packet_flags | PacketFlags::PfcLastFrag | PacketFlags::PfcFirstFrag,
            data_rep: DataRepr::default(),
            // We will set `frag_len` later after building the PDU.
            frag_len: 0,
            auth_len,
            call_id,
        }
    }

    fn create_bind_pdu(contexts: Vec<ContextElement>, security_trailer: Option<SecurityTrailer>) -> Result<Pdu> {
        let (auth_len, packet_flags) = if let Some(security_trailer) = security_trailer.as_ref() {
            (security_trailer.auth_value.len(), PacketFlags::PfcSupportHeaderSign)
        } else {
            (0, PacketFlags::None)
        };

        Ok(Pdu {
            header: Self::create_pdu_header(PacketType::Bind, packet_flags, auth_len.try_into()?, CALL_ID),
            data: PduData::Bind(Bind {
                max_xmit_frag: 5840,
                max_recv_frag: 5840,
                assoc_group: 0,
                contexts,
            }),
            security_trailer,
        })
    }

    fn create_alter_context_pdu(&self, contexts: Vec<ContextElement>, sec_trailer: SecurityTrailer) -> Result<Pdu> {
        let packet_flags = if self.sign_header {
            PacketFlags::PfcSupportHeaderSign
        } else {
            PacketFlags::None
        };

        Ok(Pdu {
            header: Self::create_pdu_header(
                PacketType::AlterContext,
                packet_flags,
                sec_trailer.auth_value.len().try_into()?,
                CALL_ID,
            ),
            data: PduData::AlterContext(AlterContext(Bind {
                max_xmit_frag: 5840,
                max_recv_frag: 5840,
                assoc_group: 0,
                contexts,
            })),
            security_trailer: Some(sec_trailer),
        })
    }

    #[instrument(level = "trace", ret, skip(self))]
    fn create_authenticated_request(
        &mut self,
        context_id: u16,
        opnum: u16,
        mut stub_data: Vec<u8>,
        verification_trailer: Option<VerificationTrailer>,
    ) -> Result<(Pdu, EncryptionOffsets)> {
        if let Some(verification_trailer) = verification_trailer.as_ref() {
            stub_data.extend_from_slice(&vec![0; compute_padding(4, stub_data.len())]);

            let encoded_verification_trailer = verification_trailer.encode_vec()?;
            stub_data.extend_from_slice(&encoded_verification_trailer);
        }

        // The security trailer must be aligned to the next 16 byte boundary after the stub data.
        // This padding is included as part of the stub data to be encrypted.
        let padding_len = compute_padding(16, stub_data.len());
        stub_data.extend_from_slice(&vec![0; padding_len]);
        let security_trailer = self.auth.empty_trailer(padding_len.try_into()?)?;

        let encrypt_offsets = EncryptionOffsets {
            pdu_header_len: EncryptionOffsets::REQUEST_PDU_HEADER_LEN,
            security_trailer_offset: EncryptionOffsets::REQUEST_PDU_HEADER_LEN + stub_data.len(),
        };

        Ok((
            Pdu {
                header: Self::create_pdu_header(
                    PacketType::Request,
                    PacketFlags::None,
                    security_trailer.auth_value.len().try_into()?,
                    CALL_ID,
                ),
                data: PduData::Request(Request {
                    alloc_hint: stub_data.len().try_into()?,
                    context_id,
                    opnum,
                    obj: None,
                    stub_data,
                }),
                security_trailer: Some(security_trailer),
            },
            encrypt_offsets,
        ))
    }

    #[instrument(level = "trace", ret, skip(self))]
    fn create_request(&self, context_id: u16, opnum: u16, stub_data: Vec<u8>) -> Result<Pdu> {
        Ok(Pdu {
            header: Self::create_pdu_header(PacketType::Request, PacketFlags::None, 0, CALL_ID),
            data: PduData::Request(Request {
                alloc_hint: stub_data.len().try_into()?,
                context_id,
                opnum,
                obj: None,
                stub_data,
            }),
            security_trailer: None,
        })
    }

    #[instrument(level = "trace", ret, skip(self))]
    fn encrypt_pdu(&mut self, pdu_encoded: &mut [u8], encrypt_offsets: EncryptionOffsets) -> Result<()> {
        let EncryptionOffsets {
            pdu_header_len,
            security_trailer_offset,
        } = encrypt_offsets;

        if pdu_encoded.len() < security_trailer_offset + SecurityTrailer::FIXED_PART_SIZE {
            Err(RpcClientError::InvalidEncryptionOffset(
                "security trailer offset is too big or PDU is corrupted",
            ))?;
        }

        let (header, data) = pdu_encoded.split_at_mut(pdu_header_len);
        let (body, data) = data.split_at_mut(security_trailer_offset - pdu_header_len);
        let (sec_trailer_header, sec_trailer_auth_value) = data.split_at_mut(SecurityTrailer::FIXED_PART_SIZE);

        if self.sign_header {
            self.auth
                .wrap_with_header_sign(header, body, sec_trailer_header, sec_trailer_auth_value)?;
        } else {
            self.auth.wrap(body, sec_trailer_auth_value)?;
        }

        Ok(())
    }

    fn process_bind_ack(ack: &BindAck, contexts: &[ContextElement]) -> Vec<ContextElement> {
        contexts
            .iter()
            .enumerate()
            .filter_map(|(index, context)| {
                if let Some(result) = ack.results.get(index) {
                    if result.result == ContextResultCode::Acceptance {
                        Some(context.clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect()
    }

    #[instrument(level = "trace", ret, skip(self))]
    fn decrypt_response(
        &mut self,
        response: &mut [u8],
        pdu_header: &PduHeader,
        encrypt_offsets: EncryptionOffsets,
    ) -> Result<()> {
        let EncryptionOffsets {
            pdu_header_len,
            security_trailer_offset: _,
        } = encrypt_offsets;

        let security_trailer_offset =
            usize::from(pdu_header.frag_len) - usize::from(pdu_header.auth_len) - SecurityTrailer::FIXED_PART_SIZE;

        if response.len() < security_trailer_offset + SecurityTrailer::FIXED_PART_SIZE {
            Err(RpcClientError::InvalidEncryptionOffset(
                "security trailer offset is too big or PDU is corrupted",
            ))?;
        }

        let (header, data) = response.split_at_mut(pdu_header_len);
        let (body, data) = data.split_at_mut(security_trailer_offset - pdu_header_len);
        let (sec_trailer_header, sec_trailer_data) = data.split_at_mut(SecurityTrailer::FIXED_PART_SIZE);

        if self.sign_header {
            self.auth
                .unwrap_with_header_sign(header, body, sec_trailer_header, sec_trailer_data)?;
        } else {
            self.auth.unwrap(body, sec_trailer_data)?;
        }

        Ok(())
    }

    #[instrument(level = "trace", ret, skip(self))]
    async fn send_pdu(&mut self, pdu: Pdu, encrypt_offsets: Option<EncryptionOffsets>) -> Result<Pdu> {
        let mut pdu_encoded = pdu.encode_vec()?;
        let frag_len = u16::try_from(pdu_encoded.len())?;
        // Set `frag_len` in the PDU header.
        pdu_encoded[8..10].copy_from_slice(&frag_len.to_le_bytes());

        if let Some(encrypt_offsets) = encrypt_offsets {
            self.encrypt_pdu(&mut pdu_encoded, encrypt_offsets)?;
        }

        self.stream.write_all(&pdu_encoded).await?;

        // Read PDU header
        let mut pdu_buf = self.stream.read_vec(PduHeader::FIXED_PART_SIZE).await?;
        let pdu_header: PduHeader = decode_owned(pdu_buf.as_slice())?;

        pdu_buf.resize(usize::from(pdu_header.frag_len), 0);
        self.stream
            .read_exact(&mut pdu_buf[PduHeader::FIXED_PART_SIZE..])
            .await?;

        if let (true, Some(encrypt_offsets)) = (pdu_header.auth_len > 0, encrypt_offsets) {
            self.decrypt_response(&mut pdu_buf, &pdu_header, encrypt_offsets)?;
        }

        let mut pdu: Pdu = decode_owned(pdu_buf.as_slice())?;
        pdu.data = pdu.data.into_error()?;

        Ok(pdu)
    }

    /// Sends the authenticated RPC request.
    #[instrument(level = "trace", ret, skip(self))]
    pub async fn authenticated_request(
        &mut self,
        context_id: u16,
        opnum: u16,
        stub_data: Vec<u8>,
        verification_trailer: Option<VerificationTrailer>,
    ) -> Result<Pdu> {
        let (pdu, encrypt_offsets) =
            self.create_authenticated_request(context_id, opnum, stub_data, verification_trailer)?;

        self.send_pdu(pdu, Some(encrypt_offsets)).await
    }

    /// Sends the RPC request.
    #[instrument(level = "trace", ret, skip(self))]
    pub async fn request(&mut self, context_id: u16, opnum: u16, stub_data: Vec<u8>) -> Result<Pdu> {
        let pdu = self.create_request(context_id, opnum, stub_data)?;

        self.send_pdu(pdu, None).await
    }

    /// Performs the RPC bind/bind_ack exchange.
    #[instrument(level = "trace", ret, skip(self))]
    pub async fn bind(&mut self, contexts: &[ContextElement]) -> Result<BindAck> {
        let bind = Self::create_bind_pdu(contexts.to_vec(), None)?;
        let pdu_resp = self.send_pdu(bind, None).await?;

        let Pdu {
            header: _,
            data,
            security_trailer: _,
        } = pdu_resp;

        Ok(data.bind_ack()?)
    }

    /// Performs the RPC bind/bind_ack exchange.
    ///
    /// The bind/bind_ack exchange continues until authentication is finished.
    #[instrument(level = "trace", ret, skip(self))]
    pub async fn bind_authenticate(&mut self, contexts: &[ContextElement]) -> Result<BindAck> {
        let security_trailer = self.auth.initialize_security_context(Vec::new()).await?;

        let bind = Self::create_bind_pdu(contexts.to_vec(), Some(security_trailer))?;

        self.sign_header = true;

        let pdu_resp = self.send_pdu(bind, None).await?;

        let Pdu {
            header: _,
            data,
            security_trailer,
        } = pdu_resp;
        let bind_ack = data.bind_ack()?;

        let final_contexts = Self::process_bind_ack(&bind_ack, contexts);
        let mut in_token = security_trailer.map(|security_trailer| security_trailer.auth_value);

        while !self.auth.is_finished() {
            let security_trailer = self
                .auth
                .initialize_security_context(in_token.unwrap_or_default())
                .await?;

            let alter_context = self.create_alter_context_pdu(final_contexts.clone(), security_trailer)?;
            let alter_context_resp = self.send_pdu(alter_context, None).await?;

            in_token = alter_context_resp
                .security_trailer
                .map(|security_trailer| security_trailer.auth_value);
        }

        Ok(bind_ack)
    }
}
