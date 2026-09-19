use alloc::vec::Vec;
use alloc::{format, vec};

use dpapi_core::{
    DecodeError, DecodeOwned, DecodeResult, DecodeWithContextOwned, Encode, EncodeResult, FixedPartSize,
    InvalidFieldErr, NeedsContext, ReadCursor, StaticName, UnsupportedValueErr, WriteBuf, WriteCursor, cast_int,
    cast_length, compute_padding, decode_uuid, encode_buf, encode_uuid, ensure_size, read_padding, size_seq,
    write_padding,
};
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use thiserror::Error;
use uuid::{Uuid, uuid};

use crate::rpc::SyntaxId;

#[derive(Debug, Error)]
pub enum EpmError {
    #[error("invalid floor protocol: {0}")]
    InvalidFloorProtocol(u8),

    #[error("invalid floor value: {0}")]
    InvalidFloorValue(&'static str),

    #[error("unsupported floor protocol: {0:?}")]
    UnsupportedFloor(FloorProtocol),
}

impl From<EpmError> for DecodeError {
    fn from(err: EpmError) -> Self {
        match &err {
            EpmError::InvalidFloorProtocol(_) => DecodeError::invalid_field("Floor", "floor protocol", "invalid value"),
            EpmError::InvalidFloorValue(_) => DecodeError::invalid_field("Floor", "floor value", "invalid value"),
            EpmError::UnsupportedFloor(floor_protocol) => {
                DecodeError::unsupported_value("Floor", "floor", format!("{floor_protocol:?}"))
            }
        }
        .with_source(err)
    }
}

pub const EPM: SyntaxId = SyntaxId {
    uuid: uuid!("e1af8308-5d1f-11c9-91a4-08002b14a0fa"),
    version: 3,
    version_minor: 0,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromPrimitive)]
#[repr(u8)]
pub enum FloorProtocol {
    Osi = 0x00,
    DnaSessionControl = 0x02,
    DnaSessionControlV3 = 0x03,
    DnaNspTransport = 0x04,
    Tp4 = 0x05,
    Clns = 0x06,
    Tcp = 0x07,
    Udp = 0x08,
    Ip = 0x09,
    RpcConnectionless = 0x0a,
    RpcConnectionOriented = 0x0b,
    UuidId = 0x0d,
    NamedPipes = 0x10,
    NetBios = 0x11,
    NetBeui = 0x12,
    NetWareSpx = 0x13,
    NetWareIpx = 0x14,
    AppleTalkStream = 0x16,
    AppleTalkDataram = 0x17,
    AppleTalk = 0x18,
    NetBios2 = 0x19,
    VinesSpp = 0x1a,
    VinesIpc = 0x1b,
    StreetTalk = 0x1c,
    UnixDomainSocket = 0x20,
    Null = 0x21,
    NetBios3 = 0x22,
}

impl FloorProtocol {
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

pub struct BaseFloor {
    pub protocol: FloorProtocol,
    pub lhs: Vec<u8>,
    pub rhs: Vec<u8>,
}

impl FixedPartSize for BaseFloor {
    const FIXED_PART_SIZE: usize = 2 /* lhs + protocol byte length */ + 1 /* protocol byte */;
}

impl BaseFloor {
    pub fn new(protocol: FloorProtocol, lhs: Vec<u8>, rhs: Vec<u8>) -> Self {
        Self { protocol, lhs, rhs }
    }
}

impl Encode for BaseFloor {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u16(cast_length!(
            "Floor",
            "lhs + protocol byte len",
            self.lhs.len() + 1 /* protocol byte */
        )?);
        dst.write_u8(self.protocol.as_u8());
        dst.write_slice(&self.lhs);

        dst.write_u16(cast_length!("Floor", "rhs len", self.rhs.len())?);
        dst.write_slice(&self.rhs);

        Ok(())
    }

    fn name(&self) -> &'static str {
        "BaseFloor"
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + self.lhs.len() + 2 /* rhs len */ + self.rhs.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct TcpFloor {
    pub port: u16,
}

impl Encode for TcpFloor {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        BaseFloor::new(FloorProtocol::Tcp, Vec::new(), self.port.to_be_bytes().to_vec()).encode(dst)
    }

    fn name(&self) -> &'static str {
        "TcpFloor"
    }

    fn size(&self) -> usize {
        BaseFloor::new(FloorProtocol::Tcp, Vec::new(), self.port.to_be_bytes().to_vec()).size()
    }
}

impl NeedsContext for TcpFloor {
    type Context<'ctx> = usize;
}

impl DecodeWithContextOwned for TcpFloor {
    fn decode_with_context_owned(src: &mut ReadCursor<'_>, ctx: Self::Context<'_>) -> DecodeResult<Self> {
        if ctx != 0 {
            return Err(DecodeError::invalid_field(
                "TcpFloor",
                "lhs len",
                "lhs len is greater then 0",
            ));
        }

        ensure_size!(in: src, size: 2 /* rhs len */);
        let rhs_len = usize::from(src.read_u16());

        ensure_size!(in: src, size: rhs_len);
        let rhs = src.read_slice(rhs_len).to_vec();

        if rhs.len() != 2 {
            Err(EpmError::InvalidFloorValue(
                "invalid TcpFloor rhs value length: expected exactly 2 bytes",
            ))?;
        }

        Ok(Self {
            port: u16::from_be_bytes(rhs.try_into().unwrap()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct IpFloor {
    pub addr: u32,
}

impl NeedsContext for IpFloor {
    type Context<'ctx> = usize;
}

impl Encode for IpFloor {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        BaseFloor::new(FloorProtocol::Ip, Vec::new(), self.addr.to_be_bytes().to_vec()).encode(dst)
    }

    fn name(&self) -> &'static str {
        "IpFloor"
    }

    fn size(&self) -> usize {
        BaseFloor::new(FloorProtocol::Ip, Vec::new(), self.addr.to_be_bytes().to_vec()).size()
    }
}

impl DecodeWithContextOwned for IpFloor {
    fn decode_with_context_owned(src: &mut ReadCursor<'_>, ctx: Self::Context<'_>) -> DecodeResult<Self> {
        if ctx != 0 {
            return Err(DecodeError::invalid_field(
                "IpFloor",
                "lhs len",
                "lhs len is greater then 0",
            ));
        }

        ensure_size!(in: src, size: 2 /* rhs len */);
        let rhs_len = usize::from(src.read_u16());

        ensure_size!(in: src, size: rhs_len);
        let rhs = src.read_slice(rhs_len).to_vec();

        if rhs.len() != 4 {
            Err(EpmError::InvalidFloorValue(
                "invalid IpFloor rhs value length: expected exactly 4 bytes",
            ))?;
        }

        Ok(Self {
            addr: u32::from_be_bytes(rhs.try_into().unwrap()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct RpcConnectionOrientedFloor {
    pub version_minor: u16,
}

impl NeedsContext for RpcConnectionOrientedFloor {
    type Context<'ctx> = usize;
}

impl Encode for RpcConnectionOrientedFloor {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        BaseFloor::new(
            FloorProtocol::RpcConnectionOriented,
            Vec::new(),
            self.version_minor.to_le_bytes().to_vec(),
        )
        .encode(dst)
    }

    fn name(&self) -> &'static str {
        "RpcConnectionOrientedFloor"
    }

    fn size(&self) -> usize {
        BaseFloor::new(
            FloorProtocol::RpcConnectionOriented,
            Vec::new(),
            self.version_minor.to_le_bytes().to_vec(),
        )
        .size()
    }
}

impl DecodeWithContextOwned for RpcConnectionOrientedFloor {
    fn decode_with_context_owned(src: &mut ReadCursor<'_>, ctx: Self::Context<'_>) -> DecodeResult<Self> {
        if ctx != 0 {
            return Err(DecodeError::invalid_field(
                "RpcConnectionOrientedFloor",
                "lhs len",
                "lhs len is greater then 0",
            ));
        }

        ensure_size!(in: src, size: 2 /* rhs len */);
        let rhs_len = usize::from(src.read_u16());

        if rhs_len != 2 {
            Err(EpmError::InvalidFloorValue(
                "invalid RpcConnectionOrientedFloor rhs value length: expected exactly 2 bytes",
            ))?;
        }

        ensure_size!(in: src, size: rhs_len);
        let rhs = src.read_slice(rhs_len).to_vec();

        Ok(Self {
            version_minor: u16::from_le_bytes(rhs.try_into().unwrap()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct UuidFloor {
    pub uuid: Uuid,
    pub version: u16,
    pub version_minor: u16,
}

impl NeedsContext for UuidFloor {
    type Context<'ctx> = usize;
}

impl Encode for UuidFloor {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        let mut lhs = self.uuid.to_bytes_le().to_vec();
        lhs.extend_from_slice(&self.version.to_le_bytes());

        BaseFloor::new(FloorProtocol::UuidId, lhs, self.version_minor.to_le_bytes().to_vec()).encode(dst)
    }

    fn name(&self) -> &'static str {
        "UuidFloor"
    }

    fn size(&self) -> usize {
        let mut lhs = self.uuid.to_bytes_le().to_vec();
        lhs.extend_from_slice(&self.version.to_le_bytes());

        BaseFloor::new(FloorProtocol::UuidId, lhs, self.version_minor.to_le_bytes().to_vec()).size()
    }
}

impl DecodeWithContextOwned for UuidFloor {
    fn decode_with_context_owned(src: &mut ReadCursor<'_>, ctx: Self::Context<'_>) -> DecodeResult<Self> {
        if ctx != Uuid::FIXED_PART_SIZE + 2
        /* versioh */
        {
            Err(EpmError::InvalidFloorValue(
                "invalid UuidFloor lhs value length: expected exactly 18 bytes",
            ))?;
        }

        ensure_size!(in: src, size: ctx);

        let lhs = src.read_slice(ctx);

        ensure_size!(in: src, size: 2);
        let rhs_len = usize::from(src.read_u16());

        if rhs_len != 2
        /* version minor */
        {
            Err(EpmError::InvalidFloorValue(
                "invalid UuidFloor rhs value length: expected exactly 2 bytes",
            ))?;
        }

        ensure_size!(in: src, size: rhs_len);
        let rhs = src.read_slice(rhs_len).to_vec();

        Ok(Self {
            uuid: decode_uuid(&mut ReadCursor::new(&lhs[0..Uuid::FIXED_PART_SIZE]))?,
            version: u16::from_le_bytes(lhs[Uuid::FIXED_PART_SIZE..].try_into().unwrap()),
            version_minor: u16::from_le_bytes(rhs.try_into().unwrap()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub enum Floor {
    Tcp(TcpFloor),
    Ip(IpFloor),
    RpcConnectionOriented(RpcConnectionOrientedFloor),
    Uuid(UuidFloor),
}

impl StaticName for Floor {
    const NAME: &'static str = "Floor";
}

impl FixedPartSize for Floor {
    const FIXED_PART_SIZE: usize = 2 /* lhs + protocol byte length */ + 1 /* protocol byte */;
}

impl Encode for Floor {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        match self {
            Floor::Tcp(tcp_floor) => tcp_floor.encode(dst),
            Floor::Ip(ip_floor) => ip_floor.encode(dst),
            Floor::RpcConnectionOriented(rpc_connection_oriented_floor) => rpc_connection_oriented_floor.encode(dst),
            Floor::Uuid(uuid_floor) => uuid_floor.encode(dst),
        }
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        match self {
            Floor::Tcp(tcp_floor) => tcp_floor.size(),
            Floor::Ip(ip_floor) => ip_floor.size(),
            Floor::RpcConnectionOriented(rpc_connection_oriented_floor) => rpc_connection_oriented_floor.size(),
            Floor::Uuid(uuid_floor) => uuid_floor.size(),
        }
    }
}

impl DecodeOwned for Floor {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let lhs_len = usize::from(src.read_u16().checked_sub(1).ok_or(DecodeError::invalid_field(
            "Floor",
            "lhs length",
            "lhs length is less then 1",
        ))?);

        let protocol_value = src.read_u8();
        let protocol = FloorProtocol::from_u8(protocol_value).ok_or(EpmError::InvalidFloorProtocol(protocol_value))?;

        Ok(match protocol {
            FloorProtocol::Tcp => Floor::Tcp(TcpFloor::decode_with_context_owned(src, lhs_len)?),
            FloorProtocol::Ip => Floor::Ip(IpFloor::decode_with_context_owned(src, lhs_len)?),
            FloorProtocol::RpcConnectionOriented => {
                Floor::RpcConnectionOriented(RpcConnectionOrientedFloor::decode_with_context_owned(src, lhs_len)?)
            }
            FloorProtocol::UuidId => Floor::Uuid(UuidFloor::decode_with_context_owned(src, lhs_len)?),
            protocol => Err(EpmError::UnsupportedFloor(protocol))?,
        })
    }
}

pub type Tower = Vec<Floor>;

pub fn build_tcpip_tower(service: SyntaxId, data_rep: SyntaxId, port: u16, addr: u32) -> Tower {
    vec![
        Floor::Uuid(UuidFloor {
            uuid: service.uuid,
            version: service.version,
            version_minor: service.version_minor,
        }),
        Floor::Uuid(UuidFloor {
            uuid: data_rep.uuid,
            version: data_rep.version,
            version_minor: data_rep.version_minor,
        }),
        Floor::RpcConnectionOriented(RpcConnectionOrientedFloor { version_minor: 0 }),
        Floor::Tcp(TcpFloor { port }),
        Floor::Ip(IpFloor { addr }),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct EntryHandle(pub Option<(u32, Uuid)>);

impl StaticName for EntryHandle {
    const NAME: &'static str = "EntryHandle";
}

impl EntryHandle {
    const EMPTY_ENTRY_HANDLE: &[u8; 20] = &[0; 20];
}

impl FixedPartSize for EntryHandle {
    const FIXED_PART_SIZE: usize = Self::EMPTY_ENTRY_HANDLE.len();
}

impl Encode for EntryHandle {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        if let Some(entry_handle) = self.0.as_ref() {
            dst.write_u32(entry_handle.0);
            encode_uuid(entry_handle.1, dst)?;
        } else {
            dst.write_slice(Self::EMPTY_ENTRY_HANDLE);
        }

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
    }
}

impl DecodeOwned for EntryHandle {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let entry_handle_buf = src.read_slice(Self::FIXED_PART_SIZE);

        Ok(if entry_handle_buf != Self::EMPTY_ENTRY_HANDLE {
            Self(Some((
                u32::from_le_bytes(entry_handle_buf[0..4].try_into().unwrap()),
                decode_uuid(&mut ReadCursor::new(&entry_handle_buf[4..]))?,
            )))
        } else {
            Self(None)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct EptMap {
    pub obj: Option<Uuid>,
    pub tower: Tower,
    pub entry_handle: EntryHandle,
    pub max_towers: u32,
}

impl EptMap {
    pub const OPNUM: u16 = 3;
    const TOWER_REFERENT_ID_1: &[u8] = &[0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const TOWER_REFERENT_ID_2: &[u8] = &[0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
}

impl StaticName for EptMap {
    const NAME: &'static str = "EptMap";
}

impl FixedPartSize for EptMap {
    const FIXED_PART_SIZE: usize = 8 /* obj with a referent id of 1 */ + Uuid::FIXED_PART_SIZE + 8 /* Tower referent id 2 */ + 8 /* encoded tower len */ + 4 /* encoded tower length */ + 2 /* floor length */;
}

impl Encode for EptMap {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        // obj with a referent id of 1
        dst.write_slice(Self::TOWER_REFERENT_ID_1);

        if let Some(uuid) = self.obj {
            encode_uuid(uuid, dst)?;
        } else {
            dst.write_slice(&[0; 16]);
        }

        // Tower referent id 2
        dst.write_slice(Self::TOWER_REFERENT_ID_2);

        let mut encoded_tower = WriteBuf::new();
        encoded_tower.write_u16(cast_length!("EptMap", "towers count", self.tower.len())?);

        for floor in &self.tower {
            encode_buf(floor, &mut encoded_tower)?;
        }

        dst.write_u64(cast_length!("EptMap", "encoded tower", encoded_tower.filled_len())?);
        dst.write_u32(cast_length!("EptMap", "encoded tower", encoded_tower.filled_len())?);

        dst.write_slice(encoded_tower.filled());

        write_padding(compute_padding(8, encoded_tower.filled_len() + 4), dst)?;

        self.entry_handle.encode(dst)?;
        dst.write_u32(self.max_towers);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        let encoded_tower_length = size_seq(&self.tower);
        let padding_len = compute_padding(
            8,
            encoded_tower_length + 2 /* tower amount */ + 4, /* encoded tower length */
        );

        Self::FIXED_PART_SIZE + encoded_tower_length + padding_len + self.entry_handle.size() + 4
        /* max_towers */
    }
}

impl DecodeOwned for EptMap {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        // obj with a referent id of 1
        src.read_u64();

        let obj = src.read_slice(Uuid::FIXED_PART_SIZE);

        let obj = if obj != [0; Uuid::FIXED_PART_SIZE] {
            Some(decode_uuid(&mut ReadCursor::new(obj))?)
        } else {
            None
        };

        // Tower referent id 2
        src.read_u64();

        let tower_length = { cast_length!("EptMap", "tower length", src.read_u64()) as DecodeResult<_> }?;
        if tower_length < 2
        /* floor length */
        {
            return Err(DecodeError::invalid_field(
                "EptMap",
                "tower length",
                "tower length is too small",
            ));
        }
        // encoded tower length
        src.read_u32();

        let tower_start = src.pos();

        let floor_length = usize::from(src.read_u16());

        let tower = (0..floor_length)
            .map(|_| Floor::decode_owned(src))
            .collect::<DecodeResult<Vec<Floor>>>()?;

        // invalid tower_length can lead to invalid padding and corrupted entry_handle and other fields.
        if src.pos() - tower_start != tower_length {
            return Err(DecodeError::invalid_field("EptMap", "tower length", "invalid value"));
        }

        let pad = compute_padding(8, {
            cast_length!(
                "RptMap",
                "towers count",
                tower_length + 4 /* encoded tower length */
            ) as DecodeResult<_>
        }?);
        read_padding(pad, src)?;

        let entry_handle = EntryHandle::decode_owned(src)?;
        ensure_size!(in: src, size: 4);
        let max_towers = src.read_u32();

        Ok(Self {
            obj,
            tower,
            entry_handle,
            max_towers,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct EptMapResult {
    pub entry_handle: EntryHandle,
    pub towers: Vec<Tower>,
    pub status: u32,
}

impl StaticName for EptMapResult {
    const NAME: &'static str = "EptMapResult";
}

impl FixedPartSize for EptMapResult {
    const FIXED_PART_SIZE: usize = EntryHandle::FIXED_PART_SIZE + 4 /* towers len */ + 8 /* towers len */ + 8 /* tower pointer offset */ + 8 /* towers len */;
}

impl Encode for EptMapResult {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        self.entry_handle.encode(dst)?;

        dst.write_u32(cast_length!("EptMapResult", "towers count", self.towers.len())?);
        // max_tower_count
        dst.write_u64(cast_length!("EptMapResult", "max tower count", self.towers.len())?);

        // Tower pointer offset
        dst.write_u64(0);

        dst.write_u64(cast_length!("EptMapResult", "towers count", self.towers.len())?);

        for idx in 0..self.towers.len() {
            dst.write_u64(cast_length!("EptMapResult", "tower index", idx + 3)?);
        }

        for tower in &self.towers {
            let mut encoded_tower = WriteBuf::new();

            encoded_tower.write_u16(cast_length!("EptMapResult", "tower len", tower.len())?);

            for floor in tower {
                encode_buf(floor, &mut encoded_tower)?;
            }

            dst.write_u64(cast_length!(
                "EptMapResult",
                "encoded tower len",
                encoded_tower.filled_len()
            )?);
            dst.write_u32(cast_length!(
                "EptMapResult",
                "encoded tower len",
                encoded_tower.filled_len()
            )?);
            dst.write_slice(encoded_tower.filled());

            write_padding(compute_padding(4, encoded_tower.filled_len()), dst)?;
        }

        dst.write_u32(self.status);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + self.towers.len() * 8 + self.towers.iter().map(|tower| {
            let encoded_tower_length = 2 /* tower len */ + size_seq(tower) + 8 /* encoded tower len */ + 4 /* encoded tower len */;
            let padding_len = compute_padding(4, encoded_tower_length);

            encoded_tower_length + padding_len
        }).sum::<usize>() + 4 /* status */
    }
}

impl DecodeOwned for EptMapResult {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let entry_handle = EntryHandle::decode_owned(src)?;

        // num towers
        src.read_u32();
        // max tower count
        src.read_u64();
        // tower offset
        src.read_u64();

        let tower_count: usize = { cast_int!("EprMapResult", "tower count", src.read_u64()) as DecodeResult<_> }?;
        ensure_size!(in: src, size: tower_count.checked_mul(8).ok_or(DecodeError::invalid_field(
                "EptMapResult",
                "tower count",
                "tower count is too big",
            ))?
        );
        // Ignore referent ids
        for _ in 0..tower_count {
            src.read_u64();
        }

        let towers = (0..tower_count)
            .map(|_| {
                ensure_size!(in: src, size: 8 /* tower length */ + 4 + 2 /* floor length */);

                let tower_length = { cast_length!("EptMap", "tower length", src.read_u64()) as DecodeResult<_> }?;
                if tower_length < 2
                /* floor length */
                {
                    return Err(DecodeError::invalid_field(
                        "EptMap",
                        "tower length",
                        "tower length is too small",
                    ));
                }

                // encoded tower length
                src.read_u32();

                let tower_start = src.pos();
                let floor_length = src.read_u16();
                let tower = (0..floor_length)
                    .map(|_| Floor::decode_owned(src))
                    .collect::<DecodeResult<Vec<Floor>>>()?;

                // Invalid tower_length can lead to invalid padding and corrupted fields.
                if src.pos() - tower_start != tower_length {
                    return Err(DecodeError::invalid_field("EptMap", "tower length", "invalid value"));
                }

                read_padding(
                    compute_padding(4, {
                        cast_length!(
                            "EptMapResult",
                            "tower length",
                            tower_length.checked_add(4).ok_or(DecodeError::invalid_field(
                                "EptMapResult",
                                "tower length",
                                "tower length is too big",
                            ))?
                        ) as DecodeResult<_>
                    }?),
                    src,
                )?;

                Ok(tower)
            })
            .collect::<DecodeResult<Vec<Tower>>>()?;

        ensure_size!(in: src, size: 4);
        let status = src.read_u32();

        Ok(Self {
            entry_handle,
            towers,
            status,
        })
    }
}
