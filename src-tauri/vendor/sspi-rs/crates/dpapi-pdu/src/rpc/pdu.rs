use alloc::format;
use alloc::vec::Vec;

use dpapi_core::{
    DecodeError, DecodeOwned, DecodeResult, DecodeWithContextOwned, Encode, EncodeResult, FindLength, FixedPartSize,
    InvalidFieldErr, NeedsContext, OtherErr, ReadCursor, StaticName, UnsupportedValueErr, WriteCursor, compute_padding,
    ensure_size, read_padding, write_padding,
};
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use thiserror::Error;

use crate::rpc::{AlterContext, AlterContextResponse, Bind, BindAck, BindNak, Request, Response};

#[derive(Error, Debug)]
pub enum PduError {
    #[error("invalid integer representation value: {0}")]
    InvalidIntRepr(u8),

    #[error("invalid character representation value: {0}")]
    InvalidCharacterRepr(u8),

    #[error("invalid floating point representation value: {0}")]
    InvalidFloatingPointRepr(u8),

    #[error("invalid packet type value: {0}")]
    InvalidPacketType(u8),

    #[error("invalid packet flags value: {0}")]
    InvalidPacketFlags(u8),

    #[error("invalid security provider value: {0}")]
    InvalidSecurityProvider(u8),

    #[error("invalid authentication level value: {0}")]
    InvalidAuthenticationLevel(u8),

    #[error("invalid fault flags value: {0}")]
    InvalidFaultFlags(u8),

    #[error("{0:?} PDU is not supported")]
    PduNotSupported(PacketType),

    #[error("invalid fragment (PDU) length: {0}")]
    InvalidFragLength(u16),

    #[error("RPC failed: {0}")]
    RpcFail(&'static str),
}

impl From<PduError> for DecodeError {
    fn from(err: PduError) -> Self {
        match &err {
            PduError::InvalidIntRepr(_) => DecodeError::invalid_field("PDU Header", "int repr", "invalid value"),
            PduError::InvalidCharacterRepr(_) => {
                DecodeError::invalid_field("PDU Header", "character repr", "invalid value")
            }
            PduError::InvalidFloatingPointRepr(_) => {
                DecodeError::invalid_field("PDU Header", "floating pint repr", "invalid value")
            }
            PduError::InvalidPacketType(_) => DecodeError::invalid_field("PDU Header", "packet type", "invalid value"),
            PduError::InvalidPacketFlags(_) => {
                DecodeError::invalid_field("PDU Header", "packet flags", "invalid value")
            }
            PduError::InvalidSecurityProvider(_) => {
                DecodeError::invalid_field("PDU Security Trailer", "security provider", "invalid value")
            }
            PduError::InvalidAuthenticationLevel(_) => {
                DecodeError::invalid_field("PDU Security Trailer", "authentication level", "invalid value")
            }
            PduError::InvalidFaultFlags(_) => DecodeError::invalid_field("Fault PDU", "fault flags", "invalid value"),
            PduError::PduNotSupported(packet_type) => {
                DecodeError::unsupported_value("", "PDU", format!("{packet_type:?}"))
            }
            PduError::InvalidFragLength(_) => DecodeError::invalid_field("PDU Header", "frag len", "instal value"),
            PduError::RpcFail(_) => DecodeError::other("RPC", "RPC failed"),
        }
        .with_source(err)
    }
}

pub(super) type PduResult<T> = Result<T, PduError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, FromPrimitive)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[repr(u8)]
pub enum IntRepr {
    BigEndian = 0,
    #[default]
    LittleEndian = 1,
}

impl IntRepr {
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, FromPrimitive)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[repr(u8)]
pub enum CharacterRepr {
    #[default]
    Ascii = 0,
    Ebcdic = 1,
}

impl CharacterRepr {
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, FromPrimitive)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[repr(u8)]
pub enum FloatingPointRepr {
    #[default]
    Ieee = 0,
    Vax = 1,
    Cray = 2,
    Ibm = 3,
}

impl FloatingPointRepr {
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromPrimitive)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[repr(u8)]
pub enum PacketType {
    Request = 0,
    Ping = 1,
    Response = 2,
    Fault = 3,
    Working = 4,
    Nocall = 5,
    Reject = 6,
    Ack = 7,
    ClCancel = 8,
    Fack = 9,
    CancelAck = 10,
    Bind = 11,
    BindAck = 12,
    BindNak = 13,
    AlterContext = 14,
    AlterContextResponse = 15,
    Shutdown = 17,
    CoCancel = 18,
    Orphaned = 19,
}

impl PacketType {
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

bitflags::bitflags! {
    #[derive(Debug, Copy, Clone, PartialEq, Eq, Default)]
    #[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
    pub struct PacketFlags: u8 {
        const None = 0x00;
        const PfcFirstFrag = 0x01;
        const PfcLastFrag = 0x02;
        // PfcPendingCancel = 0x04,
        const PfcSupportHeaderSign = 0x04; // MS-RPCE extension used in Bind/AlterContext
        const PfcReserved1 = 0x08;
        const PfcConcMpx = 0x10;
        const PfcDidNotExecute = 0x20;
        const PfcMaybe = 0x40;
        const PfcObjectUuid = 0x80;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct DataRepr {
    pub byte_order: IntRepr,
    pub character: CharacterRepr,
    pub floating_point: FloatingPointRepr,
}

impl StaticName for DataRepr {
    const NAME: &'static str = "DataRepr";
}

impl FixedPartSize for DataRepr {
    const FIXED_PART_SIZE: usize = 1 /* first octet */ + 1 /* floating point */ + 2 /* padding */;
}

impl Encode for DataRepr {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        let first_octet = ((self.byte_order.as_u8()) << 4) | self.character.as_u8();
        dst.write_u8(first_octet);
        dst.write_u8(self.floating_point.as_u8());

        write_padding(compute_padding(4, 2), dst)?;

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
    }
}

impl DecodeOwned for DataRepr {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let first_octet = src.read_u8();

        let integer_representation = (first_octet & 0b11110000) >> 4;
        let character_representation = first_octet & 0b00001111;
        let floating_representation = src.read_u8();

        let data_representation = Self {
            byte_order: IntRepr::from_u8(integer_representation)
                .ok_or(PduError::InvalidIntRepr(integer_representation))?,
            character: CharacterRepr::from_u8(character_representation)
                .ok_or(PduError::InvalidCharacterRepr(character_representation))?,
            floating_point: FloatingPointRepr::from_u8(floating_representation)
                .ok_or(PduError::InvalidFloatingPointRepr(floating_representation))?,
        };

        read_padding(compute_padding(4, 2), src)?;

        Ok(data_representation)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct PduHeader {
    pub version: u8,
    pub version_minor: u8,
    pub packet_type: PacketType,
    pub packet_flags: PacketFlags,
    pub data_rep: DataRepr,
    pub frag_len: u16,
    pub auth_len: u16,
    pub call_id: u32,
}

impl StaticName for PduHeader {
    const NAME: &'static str = "PduHeader";
}

impl FixedPartSize for PduHeader {
    const FIXED_PART_SIZE: usize = 16;
}

impl Encode for PduHeader {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u8(self.version);
        dst.write_u8(self.version_minor);
        dst.write_u8(self.packet_type.as_u8());
        dst.write_u8(self.packet_flags.bits());
        self.data_rep.encode(dst)?;
        dst.write_u16(self.frag_len);
        dst.write_u16(self.auth_len);
        dst.write_u32(self.call_id);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
    }
}

impl DecodeOwned for PduHeader {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            version: src.read_u8(),
            version_minor: src.read_u8(),
            packet_type: {
                let packet_type = src.read_u8();
                PacketType::from_u8(packet_type).ok_or(PduError::InvalidPacketType(packet_type))?
            },
            packet_flags: {
                let packet_flags = src.read_u8();
                PacketFlags::from_bits(packet_flags).ok_or(PduError::InvalidPacketFlags(packet_flags))?
            },
            data_rep: DataRepr::decode_owned(src)?,
            frag_len: src.read_u16(),
            auth_len: src.read_u16(),
            call_id: src.read_u32(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromPrimitive)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[repr(u8)]
pub enum SecurityProvider {
    None = 0x00,
    GssNegotiate = 0x09,
    Winnt = 0x0a,
    GssSchannel = 0x0e,
    GssKerberos = 0x10,
    Netlogon = 0x44,
    Default = 0xff,
}

impl SecurityProvider {
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromPrimitive)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[repr(u8)]
pub enum AuthenticationLevel {
    Default = 0x00,
    None = 0x01,
    Connect = 0x02,
    Call = 0x03,
    Pkt = 0x04,
    PktIntegrity = 0x05,
    PktPrivacy = 0x06,
}

impl AuthenticationLevel {
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct SecurityTrailer {
    pub security_type: SecurityProvider,
    pub level: AuthenticationLevel,
    pub pad_length: u8,
    pub context_id: u32,
    pub auth_value: Vec<u8>,
}

impl StaticName for SecurityTrailer {
    const NAME: &'static str = "SecurityTrailer";
}

impl FixedPartSize for SecurityTrailer {
    // `SecurityTrailer` size but without `auth_value`.
    const FIXED_PART_SIZE: usize = 8;
}

impl Encode for SecurityTrailer {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u8(self.security_type.as_u8());
        dst.write_u8(self.level.as_u8());
        dst.write_u8(self.pad_length);
        dst.write_u8(0); // Auth-Rsrvd
        dst.write_u32(self.context_id);
        dst.write_slice(&self.auth_value);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + self.auth_value.len()
    }
}

impl DecodeOwned for SecurityTrailer {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let security_provider = src.read_u8();
        let authentication_level = src.read_u8();

        Ok(Self {
            security_type: SecurityProvider::from_u8(security_provider)
                .ok_or(PduError::InvalidSecurityProvider(security_provider))?,
            level: AuthenticationLevel::from_u8(authentication_level)
                .ok_or(PduError::InvalidAuthenticationLevel(authentication_level))?,
            pad_length: src.read_u8(),
            context_id: {
                // Skip Auth-Rsrvd.
                src.read_u8();

                src.read_u32()
            },
            auth_value: src.read_remaining().to_vec(),
        })
    }
}

bitflags::bitflags! {
    #[derive(Debug, Copy, Clone, PartialEq, Eq, Default)]
    #[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
    pub struct FaultFlags: u8 {
        const None = 0x00;
        const ExtendedErrorPresent = 0x01;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct Fault {
    pub alloc_hint: u32,
    pub context_id: u16,
    pub cancel_count: u8,
    // Extension of MS-RPCE.
    pub flags: FaultFlags,
    pub status: u32,
    pub stub_data: Vec<u8>,
}

impl StaticName for Fault {
    const NAME: &'static str = "Fault PDU";
}

impl FixedPartSize for Fault {
    const FIXED_PART_SIZE: usize = 4 /* alloc_hint */ + 2 /* context_id */ + 1 /* cancel_count */ + 1 /* flags */ + 4 /* status */ + 4 /* padding */;
}

impl Encode for Fault {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u32(self.alloc_hint);
        dst.write_u16(self.context_id);
        dst.write_u8(self.cancel_count);
        dst.write_u8(self.flags.bits());
        dst.write_u32(self.status);
        // alignment padding
        dst.write_u32(0);
        dst.write_slice(&self.stub_data);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + self.stub_data.len()
    }
}

impl DecodeOwned for Fault {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            alloc_hint: src.read_u32(),
            context_id: src.read_u16(),
            cancel_count: src.read_u8(),
            flags: {
                let fault_flags = src.read_u8();
                FaultFlags::from_bits(fault_flags).ok_or(PduError::InvalidFaultFlags(fault_flags))?
            },
            status: src.read_u32(),
            stub_data: {
                read_padding(
                    compute_padding(
                        8,
                        4 /* alloc_hint */ + 2 /* context_id */ + 1 /* cancel_count */ + 1 /* flags */ + 4, /* status */
                    ),
                    src,
                )?;

                src.read_remaining().to_vec()
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub enum PduData {
    Bind(Bind),
    BindAck(BindAck),
    BindNak(BindNak),
    AlterContext(AlterContext),
    AlterContextResponse(AlterContextResponse),
    Request(Request),
    Response(Response),
    Fault(Fault),
}

impl PduData {
    /// Returns [BindAck] extracted from the inner data.
    ///
    /// Returns an error if the inner data is not `BindAck` or `AlterContextResponse`.
    pub fn bind_ack(self) -> PduResult<BindAck> {
        match self {
            PduData::BindAck(bind_ack) => Ok(bind_ack),
            PduData::AlterContextResponse(alter_context) => Ok(alter_context.0),
            _ => Err(PduError::RpcFail("BindAcknowledge PDU is expected")),
        }
    }

    /// Checks if the [PduData] contains any error PDU inside. Returns an error if so.
    pub fn into_error(self) -> PduResult<Self> {
        if let PduData::Fault(_) = self {
            Err(PduError::RpcFail("got unexpected Fault PDU"))
        } else if let PduData::BindNak(_) = self {
            Err(PduError::RpcFail("got unexpected BindAcknowledge PDU"))
        } else {
            Ok(self)
        }
    }
}

impl StaticName for PduData {
    const NAME: &'static str = "PduData";
}

impl NeedsContext for PduData {
    type Context<'ctx> = &'ctx PduHeader;
}

impl DecodeWithContextOwned for PduData {
    fn decode_with_context_owned(src: &mut ReadCursor<'_>, pdu_header: Self::Context<'_>) -> DecodeResult<Self> {
        let security_trailer_len = if pdu_header.auth_len > 0 {
            SecurityTrailer::FIXED_PART_SIZE
        } else {
            0
        } + usize::from(pdu_header.auth_len);

        let data_len = usize::from(pdu_header.frag_len)
            .checked_sub(security_trailer_len + PduHeader::FIXED_PART_SIZE)
            .ok_or(
                DecodeError::invalid_field("PDU", "frag len", "frag len is too small")
                    .with_source(PduError::InvalidFragLength(pdu_header.frag_len)),
            )?;

        ensure_size!(in: src, size: data_len);
        let mut buf = ReadCursor::new(src.read_slice(data_len));

        let pdu_data = match pdu_header.packet_type {
            PacketType::Bind => PduData::Bind(Bind::decode_owned(&mut buf)?),
            PacketType::BindAck => PduData::BindAck(BindAck::decode_owned(&mut buf)?),
            PacketType::BindNak => PduData::BindNak(BindNak::decode_owned(&mut buf)?),
            PacketType::AlterContext => PduData::AlterContext(AlterContext::decode_owned(&mut buf)?),
            PacketType::AlterContextResponse => {
                PduData::AlterContextResponse(AlterContextResponse::decode_owned(&mut buf)?)
            }
            PacketType::Request => {
                PduData::Request(Request::decode_with_context_owned(&mut buf, pdu_header.packet_flags)?)
            }
            PacketType::Response => PduData::Response(Response::decode_owned(&mut buf)?),
            PacketType::Fault => PduData::Fault(Fault::decode_owned(&mut buf)?),
            packet_type => return Err(PduError::PduNotSupported(packet_type).into()),
        };

        Ok(pdu_data)
    }
}

impl Encode for PduData {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        match self {
            PduData::Bind(bind) => bind.encode(dst),
            PduData::BindAck(bind_ack) => bind_ack.encode(dst),
            PduData::BindNak(bind_nak) => bind_nak.encode(dst),
            PduData::AlterContext(alter_context) => alter_context.encode(dst),
            PduData::AlterContextResponse(alter_context_response) => alter_context_response.encode(dst),
            PduData::Request(request) => request.encode(dst),
            PduData::Response(response) => response.encode(dst),
            PduData::Fault(fault) => fault.encode(dst),
        }
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        match self {
            PduData::Bind(bind) => bind.size(),
            PduData::BindAck(bind_ack) => bind_ack.size(),
            PduData::BindNak(bind_nak) => bind_nak.size(),
            PduData::AlterContext(alter_context) => alter_context.size(),
            PduData::AlterContextResponse(alter_context_response) => alter_context_response.size(),
            PduData::Request(request) => request.size(),
            PduData::Response(response) => response.size(),
            PduData::Fault(fault) => fault.size(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pdu {
    pub header: PduHeader,
    pub data: PduData,
    pub security_trailer: Option<SecurityTrailer>,
}

impl Pdu {
    /// Tries to extract PDU Response from the inner data.
    ///
    /// Return an error if the PDU is any type then `Response`.
    pub fn try_into_response(self) -> PduResult<Response> {
        if let PduData::Response(response) = self.data {
            Ok(response)
        } else {
            Err(PduError::RpcFail("got unexpected PDU: expected Response PDU"))
        }
    }
}

#[cfg(feature = "arbitrary")]
impl arbitrary::Arbitrary<'_> for Pdu {
    fn arbitrary(u: &mut arbitrary::Unstructured<'_>) -> arbitrary::Result<Self> {
        let mut header = PduHeader::arbitrary(u)?;

        let data = match header.packet_type {
            PacketType::Bind => PduData::Bind(Bind::arbitrary(u)?),
            PacketType::BindAck => PduData::BindAck(BindAck::arbitrary(u)?),
            PacketType::BindNak => PduData::BindNak(BindNak::arbitrary(u)?),
            PacketType::AlterContext => PduData::AlterContext(AlterContext::arbitrary(u)?),
            PacketType::AlterContextResponse => PduData::AlterContextResponse(AlterContextResponse::arbitrary(u)?),
            PacketType::Request => {
                let mut request = Request::arbitrary(u)?;

                if header.packet_flags.contains(PacketFlags::PfcObjectUuid) {
                    if request.obj.is_none() {
                        request.obj = Some(u.arbitrary()?);
                    }
                } else if request.obj.is_some() {
                    request.obj = None;
                }

                PduData::Request(request)
            }
            PacketType::Response => PduData::Response(Response::arbitrary(u)?),
            PacketType::Fault => PduData::Fault(Fault::arbitrary(u)?),
            _ => return Err(arbitrary::Error::IncorrectFormat),
        };

        let encoded_len = data.size();

        let security_trailer = SecurityTrailer::arbitrary(u)?;

        let security_trailer = if security_trailer.auth_value.is_empty() {
            header.frag_len = u16::try_from(encoded_len + PduHeader::FIXED_PART_SIZE)
                .map_err(|_| arbitrary::Error::IncorrectFormat)?;
            header.auth_len = 0;

            None
        } else {
            header.auth_len = security_trailer
                .auth_value
                .len()
                .try_into()
                .map_err(|_| arbitrary::Error::IncorrectFormat)?;

            header.frag_len = u16::try_from(
                encoded_len
                    + usize::from(header.auth_len)
                    + PduHeader::FIXED_PART_SIZE
                    + SecurityTrailer::FIXED_PART_SIZE,
            )
            .map_err(|_| arbitrary::Error::IncorrectFormat)?;

            Some(security_trailer)
        };

        Ok(Self {
            header,
            data,
            security_trailer,
        })
    }
}

impl StaticName for Pdu {
    const NAME: &'static str = "PDU";
}

impl Encode for Pdu {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        self.header.encode(dst)?;
        self.data.encode(dst)?;

        if let Some(security_trailer) = self.security_trailer.as_ref() {
            security_trailer.encode(dst)?;
        }

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        self.header.size()
            + self.data.size()
            + self
                .security_trailer
                .as_ref()
                .map(|security_trailer| security_trailer.size())
                .unwrap_or_default()
    }
}

impl DecodeOwned for Pdu {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        let header = PduHeader::decode_owned(src)?;
        let data = PduData::decode_with_context_owned(src, &header)?;
        let security_trailer = if header.auth_len > 0 {
            Some(SecurityTrailer::decode_owned(src)?)
        } else {
            None
        };

        Ok(Self {
            header,
            data,
            security_trailer,
        })
    }
}

impl FixedPartSize for Pdu {
    const FIXED_PART_SIZE: usize = PduHeader::FIXED_PART_SIZE;
}

impl FindLength for Pdu {
    fn find_frame_length(bytes: &[u8]) -> DecodeResult<Option<usize>> {
        if bytes.len() < Self::FIXED_PART_SIZE {
            return Ok(None);
        }

        let pdu_header = PduHeader::decode_owned(&mut ReadCursor::new(&bytes[0..Self::FIXED_PART_SIZE]))?;

        Ok(Some(usize::from(pdu_header.frag_len)))
    }
}
