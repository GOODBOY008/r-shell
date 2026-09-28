use alloc::vec::Vec;

use dpapi_core::{
    DecodeOwned, DecodeResult, DecodeWithContextOwned, Encode, EncodeResult, FixedPartSize, NeedsContext, ReadCursor,
    StaticName, WriteCursor, decode_uuid, encode_uuid, ensure_size,
};
use uuid::Uuid;

use crate::rpc::PacketFlags;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct Request {
    pub alloc_hint: u32,
    pub context_id: u16,
    pub opnum: u16,
    pub obj: Option<Uuid>,
    pub stub_data: Vec<u8>,
}

impl StaticName for Request {
    const NAME: &'static str = "Request";
}

impl FixedPartSize for Request {
    const FIXED_PART_SIZE: usize = 4 /* alloc_hint */ + 2 /* context_id */ + 2 /* opnum */;
}

impl Encode for Request {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u32(self.alloc_hint);
        dst.write_u16(self.context_id);
        dst.write_u16(self.opnum);

        if let Some(obj) = self.obj.as_ref() {
            encode_uuid(*obj, dst)?;
        }

        dst.write_slice(&self.stub_data);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
            + self.obj.as_ref().map(|_| Uuid::FIXED_PART_SIZE).unwrap_or_default()
            + self.stub_data.len()
    }
}

impl NeedsContext for Request {
    type Context<'ctx> = PacketFlags;
}

impl DecodeWithContextOwned for Request {
    fn decode_with_context_owned(src: &mut ReadCursor<'_>, flags: Self::Context<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            alloc_hint: src.read_u32(),
            context_id: src.read_u16(),
            opnum: src.read_u16(),
            obj: if flags.contains(PacketFlags::PfcObjectUuid) {
                Some(decode_uuid(src)?)
            } else {
                None
            },
            stub_data: src.read_remaining().to_vec(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct Response {
    pub alloc_hint: u32,
    pub context_id: u16,
    pub cancel_count: u8,
    pub stub_data: Vec<u8>,
}

impl StaticName for Response {
    const NAME: &'static str = "Response";
}

impl FixedPartSize for Response {
    const FIXED_PART_SIZE: usize = 4 /* alloc_hint */ + 2 /* context_id */ + 1 /* cancel_count */ + 1 /* reserved */;
}

impl Encode for Response {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u32(self.alloc_hint);
        dst.write_u16(self.context_id);
        dst.write_u8(self.cancel_count);
        // Reserved.
        dst.write_u8(0);

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

impl DecodeOwned for Response {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        Ok(Self {
            alloc_hint: src.read_u32(),
            context_id: src.read_u16(),
            cancel_count: {
                let cancel_count = src.read_u8();

                // Reserved
                src.read_u8();

                cancel_count
            },
            stub_data: src.read_remaining().to_vec(),
        })
    }
}
