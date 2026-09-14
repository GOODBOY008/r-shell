use alloc::string::String;
use alloc::vec::Vec;

use dpapi_core::{
    DecodeError, DecodeOwned, DecodeResult, Encode, EncodeResult, FixedPartSize, InvalidFieldErr, ReadCursor,
    StaticName, WriteCursor, cast_length, compute_padding, decode_uuid, encode_seq, encode_uuid, ensure_size,
    read_padding, size_seq, write_padding,
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum BindError {
    #[error("invalid context result code value: {0}")]
    InvalidContextResultCode(u16),
}

impl From<BindError> for DecodeError {
    fn from(err: BindError) -> Self {
        match &err {
            BindError::InvalidContextResultCode(_) => {
                DecodeError::invalid_field("ContextResult", "context result code", "invalid value")
            }
        }
        .with_source(err)
    }
}

pub(super) type BindResult<T> = Result<T, BindError>;

/// [BindTimeFeatureNegotiationBitmask](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rpce/cef529cc-77b5-4794-85dc-91e1467e80f0)
///
/// The bind time feature negotiation bitmask is an array of eight octets, each of which is interpreted as a bitmask.
/// **Bitmask**: Currently, only the two least significant bits in the first element of the array are defined.
///
/// ```C
/// typedef struct {
///    unsigned char Bitmask[8];
/// } BindTimeFeatureNegotiationBitmask;
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum BindTimeFeatureNegotiationBitmask {
    None = 0x0,
    /// Client supports security context multiplexing, as specified in section [3.3.1.5.4](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rpce/c8b3c80f-b2ba-4a78-bf36-dabba4278194).
    SecurityContextMultiplexingSupported = 0x01,
    /// Client supports keeping the connection open after sending the orphaned PDU, as specified in section [3.3.1.5.10](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rpce/44d6f02e-55f3-4814-973e-cf0bc3287c44).
    KeepConnectionOnOrphanSupported = 0x02,
}

impl BindTimeFeatureNegotiationBitmask {
    pub fn as_u64(&self) -> u64 {
        *self as u64
    }
}

/// [RPC_SYNTAX_IDENTIFIER](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rpcl/1831bd1c-738c-45dc-a2af-5d0b835af6f5)
///
/// This structure MUST contain a 0GUID and version information (MS-RPCE section 2.2.2.7). It is
/// identical to the RPC_SYNTAX_IDENTIFIER structure used in the LocToLoc interface in section 3.1.4.
/// This structure is used to represent the following:
/// * Identifier and version of an interface.
/// * Identifier and version of [transfer syntax](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rpcl/55ec267c-87d9-4d97-a9d5-5681f5f283b8#gt_01216ea7-ac8a-4cc8-9d19-b901bc424c09) for an interface.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct SyntaxId {
    pub uuid: Uuid,
    pub version: u16,
    pub version_minor: u16,
}

impl StaticName for SyntaxId {
    const NAME: &'static str = "SyntaxId";
}

impl FixedPartSize for SyntaxId {
    const FIXED_PART_SIZE: usize = 16 /* uuid */ + 2 /* version */ + 2 /* version_minor */;
}

impl Encode for SyntaxId {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        encode_uuid(self.uuid, dst)?;
        dst.write_u16(self.version);
        dst.write_u16(self.version_minor);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
    }
}

impl DecodeOwned for SyntaxId {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            uuid: decode_uuid(src)?,
            version: src.read_u16(),
            version_minor: src.read_u16(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct ContextElement {
    pub context_id: u16,
    pub abstract_syntax: SyntaxId,
    pub transfer_syntaxes: Vec<SyntaxId>,
}

impl StaticName for ContextElement {
    const NAME: &'static str = "ContextElement";
}

impl FixedPartSize for ContextElement {
    const FIXED_PART_SIZE: usize = 2 /* context_id */ + 2 /* transfer_syntaxes length */ + SyntaxId::FIXED_PART_SIZE;
}

impl Encode for ContextElement {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u16(self.context_id);
        dst.write_u16(cast_length!(
            "ContextElement",
            "transfer syntaxes count",
            self.transfer_syntaxes.len()
        )?);

        self.abstract_syntax.encode(dst)?;
        encode_seq(&self.transfer_syntaxes, dst)?;

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + size_seq(&self.transfer_syntaxes)
    }
}

impl DecodeOwned for ContextElement {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<ContextElement> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let context_id = src.read_u16();
        let transfer_syntaxes_count = usize::from(src.read_u16());
        let abstract_syntax = SyntaxId::decode_owned(src)?;

        let transfer_syntaxes = (0..transfer_syntaxes_count)
            .map(|_| SyntaxId::decode_owned(src))
            .collect::<DecodeResult<Vec<_>>>()?;

        Ok(Self {
            context_id,
            abstract_syntax,
            transfer_syntaxes,
        })
    }
}

/// [`p_cont_def_result_t` Enumerator](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rpce/8df5c4d4-364d-468c-81fe-ec94c1b40917)
///
/// These extensions specify a new member, `negotiate_ack`, which is added to the `p_cont_def_result_t` enumeration
/// (specified in C706 section 12.6), with the numeric value of `3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
#[repr(u16)]
pub enum ContextResultCode {
    Acceptance = 0,
    UserRejection = 1,
    ProviderRejection = 2,
    NegotiateAck = 3, // MS-RPCE extension
}

impl ContextResultCode {
    pub fn as_u16(&self) -> u16 {
        *self as u16
    }
}

impl TryFrom<u16> for ContextResultCode {
    type Error = BindError;

    fn try_from(v: u16) -> BindResult<Self> {
        match v {
            0 => Ok(Self::Acceptance),
            1 => Ok(Self::UserRejection),
            2 => Ok(Self::ProviderRejection),
            3 => Ok(Self::NegotiateAck),
            v => Err(BindError::InvalidContextResultCode(v)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct ContextResult {
    pub result: ContextResultCode,
    pub reason: u16,
    pub syntax: Uuid,
    pub syntax_version: u32,
}

impl StaticName for ContextResult {
    const NAME: &'static str = "ContextResult";
}

impl FixedPartSize for ContextResult {
    const FIXED_PART_SIZE: usize = 2 /* result */ + 2 /* reason */ + 16 /* syntax */ + 4 /* syntax_version */;
}

impl Encode for ContextResult {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u16(self.result.as_u16());
        dst.write_u16(self.reason);
        encode_uuid(self.syntax, dst)?;
        dst.write_u32(self.syntax_version);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
    }
}

impl DecodeOwned for ContextResult {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            result: src.read_u16().try_into()?,
            reason: src.read_u16(),
            syntax: decode_uuid(src)?,
            syntax_version: src.read_u32(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct Bind {
    pub max_xmit_frag: u16,
    pub max_recv_frag: u16,
    pub assoc_group: u32,
    pub contexts: Vec<ContextElement>,
}

impl StaticName for Bind {
    const NAME: &'static str = "Bind";
}

impl FixedPartSize for Bind {
    const FIXED_PART_SIZE: usize = 2 /* max_xmit_frag */ + 2 /* max_recv_frag */ + 4 /* assoc_group */ + 4 /* contexts length */;
}

impl Encode for Bind {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u16(self.max_xmit_frag);
        dst.write_u16(self.max_recv_frag);
        dst.write_u32(self.assoc_group);
        dst.write_u32(cast_length!("Bind", "contexts count", self.contexts.len())?);
        encode_seq(&self.contexts, dst)?;

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + size_seq(&self.contexts)
    }
}

impl DecodeOwned for Bind {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let max_xmit_frag = src.read_u16();
        let max_recv_frag = src.read_u16();
        let assoc_group = src.read_u32();

        let contexts_count = src.read_u32();
        let contexts = (0..contexts_count)
            .map(|_| ContextElement::decode_owned(src))
            .collect::<DecodeResult<Vec<_>>>()?;

        Ok(Self {
            max_xmit_frag,
            max_recv_frag,
            assoc_group,
            contexts,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct BindAck {
    pub max_xmit_frag: u16,
    pub max_recv_frag: u16,
    pub assoc_group: u32,
    pub sec_addr: String,
    pub results: Vec<ContextResult>,
}

impl StaticName for BindAck {
    const NAME: &'static str = "BindAck";
}

impl FixedPartSize for BindAck {
    const FIXED_PART_SIZE: usize = 2 /* max_xmit_frag */ + 2 /* max_recv_frag */ + 4 /* assoc_group */ + 2 /* sec_addr lenght in bytes */;
}

impl Encode for BindAck {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u16(self.max_xmit_frag);
        dst.write_u16(self.max_recv_frag);
        dst.write_u32(self.assoc_group);

        let sec_addr_len = if !self.sec_addr.is_empty() {
            let sec_addr_len = self.sec_addr.len() + 1 /* null-byte */;
            dst.write_u16(cast_length!("BindAck", "security address len", sec_addr_len)?);

            dst.write_slice(self.sec_addr.as_bytes());
            dst.write_u8(0);

            sec_addr_len
        } else {
            dst.write_u16(0);

            0
        } + 2 /* length in bytes */;

        write_padding(compute_padding(4, sec_addr_len), dst)?;

        dst.write_u32(cast_length!("BindAck", "results count", self.results.len())?);
        encode_seq(&self.results, dst)?;

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        let sec_addr_len = if !self.sec_addr.is_empty() { self.sec_addr.len() + 1 } else { 0 } + 2 /* sec_addr lenght in bytes */;

        2 /* max_xmit_frag */ + 2 /* max_recv_frag */ + 4 /* assoc_group */ + sec_addr_len + compute_padding(4, sec_addr_len) + 4 /* results length */ + size_seq(&self.results)
    }
}

impl DecodeOwned for BindAck {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            max_xmit_frag: src.read_u16(),
            max_recv_frag: src.read_u16(),
            assoc_group: src.read_u32(),
            sec_addr: {
                let sec_addr_len = usize::from(src.read_u16());
                let sec_addr = if sec_addr_len > 0 {
                    ensure_size!(in: src, size: sec_addr_len);

                    let buf = src.read_slice(sec_addr_len - 1 /* null byte */).to_vec();
                    // Read null-terminator byte.
                    src.read_u8();

                    String::from_utf8(buf).map_err(|err| {
                        DecodeError::invalid_field("BindAck", "security address", "broken UTF-8").with_source(err)
                    })?
                } else {
                    String::new()
                };

                read_padding(compute_padding(4, sec_addr_len + 2), src)?;

                sec_addr
            },
            results: {
                ensure_size!(in: src, size: 4);
                let results_count = src.read_u32();

                (0..results_count)
                    .map(|_| ContextResult::decode_owned(src))
                    .collect::<DecodeResult<Vec<_>>>()?
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct Version(u8, u8);

impl StaticName for Version {
    const NAME: &'static str = "Version";
}

impl FixedPartSize for Version {
    const FIXED_PART_SIZE: usize = 2;
}

impl Encode for Version {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u8(self.0);
        dst.write_u8(self.1);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
    }
}

impl DecodeOwned for Version {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Version(src.read_u8(), src.read_u8()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct BindNak {
    pub reason: u16,
    pub versions: Vec<Version>,
}

impl StaticName for BindNak {
    const NAME: &'static str = "BindNak";
}

impl FixedPartSize for BindNak {
    const FIXED_PART_SIZE: usize = 2 /* reason */ + 1 /* versions len */;
}

impl Encode for BindNak {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u16(self.reason);

        dst.write_u8(cast_length!("BindNak", "versions count", self.versions.len())?);
        encode_seq(&self.versions, dst)?;

        let versions_buf_len = 1 /* len */ + size_seq(&self.versions);
        write_padding(compute_padding(4, versions_buf_len), dst)?;

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        let versions_size = size_seq(&self.versions);

        Self::FIXED_PART_SIZE + versions_size + compute_padding(4, versions_size + 1 /* versions len */)
    }
}

impl DecodeOwned for BindNak {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            reason: src.read_u16(),
            versions: {
                let versions_count = usize::from(src.read_u8());
                let versions = (0..versions_count)
                    .map(|_| Version::decode_owned(src))
                    .collect::<DecodeResult<Vec<_>>>()?;

                let versions_buf_len = 1 /* len */ + size_seq(&versions);
                read_padding(compute_padding(4, versions_buf_len), src)?;

                versions
            },
        })
    }
}

// `AlterContext` has the same layout as `Bind`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct AlterContext(pub Bind);

impl StaticName for AlterContext {
    const NAME: &'static str = "AlterContext";
}

impl FixedPartSize for AlterContext {
    const FIXED_PART_SIZE: usize = Bind::FIXED_PART_SIZE;
}

impl Encode for AlterContext {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        self.0.encode(dst)
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        self.0.size()
    }
}

impl DecodeOwned for AlterContext {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        Ok(Self(Bind::decode_owned(src)?))
    }
}

// `AlterContextResponse` has the same layout as `BindAck`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct AlterContextResponse(pub BindAck);

impl StaticName for AlterContextResponse {
    const NAME: &'static str = "AlterContextResponse";
}

impl FixedPartSize for AlterContextResponse {
    const FIXED_PART_SIZE: usize = BindAck::FIXED_PART_SIZE;
}

impl Encode for AlterContextResponse {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        self.0.encode(dst)
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        self.0.size()
    }
}

impl DecodeOwned for AlterContextResponse {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        Ok(Self(BindAck::decode_owned(src)?))
    }
}
