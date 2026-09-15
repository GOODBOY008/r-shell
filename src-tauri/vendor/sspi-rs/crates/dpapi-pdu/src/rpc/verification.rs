use alloc::vec::Vec;

use bitflags::bitflags;
use dpapi_core::{
    DecodeError, DecodeOwned, DecodeResult, Encode, EncodeResult, FixedPartSize, InvalidFieldErr, ReadCursor,
    StaticName, WriteBuf, WriteCursor, cast_length, encode_buf, encode_seq, ensure_size, size_seq,
};
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use thiserror::Error;

use crate::rpc::{DataRepr, PacketType, SyntaxId};

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("invalid RPC command type: {0}")]
    InvalidCommandType(u16),

    #[error("invalid RPC command flags: {0}")]
    InvalidCommandFlags(u16),

    #[error("invalid RPC bitmask command value length: expected exactly 4 bytes but got {0} bytes")]
    InvalidCommandBitmaskValueLength(usize),

    #[error("invalid packet RPC type value in RPC command: {0}")]
    InvalidPacketType(u8),

    #[error("invalid VerificationTrailer signature")]
    InvalidVerificationTrailerSignature { expected: &'static [u8], actual: Vec<u8> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromPrimitive)]
#[repr(u16)]
pub enum CommandType {
    Bitmask1 = 0x0001,
    Pcontext = 0x0002,
    Header2 = 0x0003,
}

impl CommandType {
    pub fn as_u16(self) -> u16 {
        self as u16
    }
}

bitflags! {
    #[derive(Debug, Copy, Clone, PartialEq, Eq, Default)]
    #[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
    pub struct CommandFlags: u16 {
        const None = 0;
        const SecVtCommandEnd = 0x4000;
        const SecVtMustProcessCommand = 0x8000;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub enum Command {
    Bitmask1(CommandBitmask),
    Pcontext(CommandPContext),
    Header2(CommandHeader2),
}

impl Command {
    pub fn set_flags(&mut self, flags: CommandFlags) {
        match self {
            Command::Bitmask1(command) => command.flags = flags,
            Command::Pcontext(command) => command.flags = flags,
            Command::Header2(command) => command.flags = flags,
        }
    }

    pub fn flags(&self) -> CommandFlags {
        match self {
            Command::Bitmask1(command) => command.flags,
            Command::Pcontext(command) => command.flags,
            Command::Header2(command) => command.flags,
        }
    }

    pub fn command_type(&self) -> CommandType {
        match self {
            Command::Bitmask1(_) => CommandType::Bitmask1,
            Command::Pcontext(_) => CommandType::Pcontext,
            Command::Header2(_) => CommandType::Header2,
        }
    }

    fn value_length(&self) -> usize {
        match self {
            Command::Bitmask1(command) => command.value_length(),
            Command::Pcontext(command) => command.value_length(),
            Command::Header2(command) => command.value_length(),
        }
    }
}

impl StaticName for Command {
    const NAME: &'static str = "Command";
}

impl FixedPartSize for Command {
    const FIXED_PART_SIZE: usize = 2 /* command_type + command_flags */ + 2 /* value length */;
}

impl Encode for Command {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u16(self.command_type().as_u16() | self.flags().bits());

        match self {
            Command::Bitmask1(command) => command.encode_value(dst),
            Command::Pcontext(command) => command.encode_value(dst),
            Command::Header2(command) => command.encode_value(dst),
        }
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        2 /* command_type + command_flags */ + self.value_length()
    }
}

impl DecodeOwned for Command {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let cmd_field = src.read_u16();

        let command_type = cmd_field & 0x3fff;
        let command_flags = cmd_field & 0xc000;

        let command = CommandType::from_u16(command_type).ok_or(
            DecodeError::invalid_field("invalid Command", "command type", "invalid type")
                .with_source(CommandError::InvalidCommandType(command_type)),
        )?;
        let flags = CommandFlags::from_bits(command_flags).ok_or(
            DecodeError::invalid_field("Command", "command flags", "invalid flags")
                .with_source(CommandError::InvalidCommandFlags(command_flags)),
        )?;

        let value_len = usize::from(src.read_u16());

        ensure_size!(in: src, size: value_len);
        let value = src.read_slice(value_len);

        Ok(match command {
            CommandType::Bitmask1 => Self::Bitmask1(CommandBitmask::from_flags_and_value(flags, value)?),
            CommandType::Pcontext => Self::Pcontext(CommandPContext::from_flags_and_value(flags, value)?),
            CommandType::Header2 => Self::Header2(CommandHeader2::from_flags_and_value(flags, value)?),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct CommandBitmask {
    pub bits: u32,
    pub flags: CommandFlags,
}

impl CommandBitmask {
    fn value_length(&self) -> usize {
        4 /* bits */ + 2 /* value length */
    }

    fn from_flags_and_value(flags: CommandFlags, value: &[u8]) -> DecodeResult<Self> {
        if value.len() != 4 {
            Err(
                DecodeError::invalid_field("CommandBitmask", "value", "invalid value length")
                    .with_source(CommandError::InvalidCommandBitmaskValueLength(value.len())),
            )?;
        }

        let bits: [u8; 4] = value.try_into().expect("length is checked above");

        Ok(Self {
            flags,
            bits: u32::from_le_bytes(bits),
        })
    }

    fn encode_value(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.value_length());

        dst.write_u16(4);
        dst.write_slice(self.bits.to_le_bytes().as_slice());

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct CommandPContext {
    pub flags: CommandFlags,
    pub interface_id: SyntaxId,
    pub transfer_syntax: SyntaxId,
}

impl CommandPContext {
    fn value_length(&self) -> usize {
        self.interface_id.size() + self.transfer_syntax.size() + 2 /* value length */
    }

    fn from_flags_and_value(flags: CommandFlags, value: &[u8]) -> DecodeResult<Self> {
        let mut src = ReadCursor::new(value);

        let interface_id = SyntaxId::decode_owned(&mut src)?;
        let transfer_syntax = SyntaxId::decode_owned(&mut src)?;

        if !src.is_empty() {
            Err(
                DecodeError::invalid_field("CommandPContext", "value", "invalid value length")
                    .with_source(CommandError::InvalidCommandBitmaskValueLength(value.len())),
            )?;
        }

        Ok(Self {
            flags,
            interface_id,
            transfer_syntax,
        })
    }

    fn encode_value(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.value_length());

        let mut buf = WriteBuf::new();

        encode_buf(&self.interface_id, &mut buf)?;
        encode_buf(&self.transfer_syntax, &mut buf)?;

        dst.write_u16(cast_length!(
            "CommandPContext",
            "encoded value length",
            buf.filled_len()
        )?);
        dst.write_slice(buf.filled());

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct CommandHeader2 {
    pub flags: CommandFlags,
    pub packet_type: PacketType,
    pub data_rep: DataRepr,
    pub call_id: u32,
    pub context_id: u16,
    pub opnum: u16,
}

impl CommandHeader2 {
    fn value_length(&self) -> usize {
        Self::FIXED_PART_SIZE
    }

    fn from_flags_and_value(flags: CommandFlags, value: &[u8]) -> DecodeResult<Self> {
        let mut src = ReadCursor::new(value);
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE - 2 /* value length is already read */);

        let command_header2 = Self {
            flags,
            packet_type: {
                let packet_type = src.read_u8();
                src.read_u8();
                src.read_u8();
                src.read_u8();

                PacketType::from_u8(packet_type).ok_or(
                    DecodeError::invalid_field("CommandHeader2", "packet type", "invalid value")
                        .with_source(CommandError::InvalidPacketType(packet_type)),
                )?
            },
            data_rep: DataRepr::decode_owned(&mut src)?,
            call_id: src.read_u32(),
            context_id: src.read_u16(),
            opnum: src.read_u16(),
        };

        if !src.is_empty() {
            Err(
                DecodeError::invalid_field("CommandHeader2", "value", "invalid value length")
                    .with_source(CommandError::InvalidCommandBitmaskValueLength(value.len())),
            )?;
        }

        Ok(command_header2)
    }

    fn encode_value(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.value_length());

        let mut buf = WriteBuf::new();

        buf.write_u8(self.packet_type.as_u8());
        // Reserved
        buf.write_slice(&[0, 0, 0]);
        encode_buf(&self.data_rep, &mut buf)?;

        buf.write_u32(self.call_id);
        buf.write_u16(self.context_id);
        buf.write_u16(self.opnum);

        dst.write_u16(cast_length!(
            "CommandHeader2",
            "encoded value length",
            buf.filled_len()
        )?);
        dst.write_slice(buf.filled());

        Ok(())
    }
}

impl FixedPartSize for CommandHeader2 {
    const FIXED_PART_SIZE: usize = 4 /* packet_type + reserved */ + DataRepr::FIXED_PART_SIZE + 4 /* call_id */ + 2 /* context_id */ + 2 /* opnum */ + 2 /* value length */;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationTrailer {
    pub commands: Vec<Command>,
}

// We provide the custom Arbitrary trait implementation to ensure that the last command has `SecVtCommandEnd` flag turned on.
#[cfg(feature = "arbitrary")]
impl arbitrary::Arbitrary<'_> for VerificationTrailer {
    fn arbitrary(u: &mut arbitrary::Unstructured<'_>) -> arbitrary::Result<Self> {
        let mut commands = Vec::new();

        for _ in 0..u.arbitrary_len::<Command>()? {
            let command: Command = u.arbitrary()?;
            let flags = command.flags();

            commands.push(command);

            if flags.contains(CommandFlags::SecVtCommandEnd) {
                break;
            }
        }

        if let Some(command) = commands.last_mut() {
            let mut flags = command.flags();

            if !flags.contains(CommandFlags::SecVtCommandEnd) {
                flags.set(CommandFlags::SecVtCommandEnd, true);

                command.set_flags(flags);
            }
        }

        Ok(Self { commands })
    }
}

impl VerificationTrailer {
    const SIGNATURE: &[u8] = &[138, 227, 19, 113, 2, 244, 54, 113];
}

impl StaticName for VerificationTrailer {
    const NAME: &'static str = "VerificationTrailer";
}

impl FixedPartSize for VerificationTrailer {
    const FIXED_PART_SIZE: usize = Self::SIGNATURE.len();
}

impl Encode for VerificationTrailer {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_slice(Self::SIGNATURE);

        encode_seq(&self.commands, dst)?;

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::SIGNATURE.len() + size_seq(&self.commands)
    }
}

impl DecodeOwned for VerificationTrailer {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let signature = src.read_slice(VerificationTrailer::SIGNATURE.len());

        if signature != VerificationTrailer::SIGNATURE {
            Err(
                DecodeError::invalid_field("VerificationTrailer", "signature", "invalid data").with_source(
                    CommandError::InvalidVerificationTrailerSignature {
                        expected: VerificationTrailer::SIGNATURE,
                        actual: signature.to_vec(),
                    },
                ),
            )?;
        }

        let mut commands = Vec::new();
        while !src.is_empty() {
            let command = Command::decode_owned(src)?;
            let flags = command.flags();

            commands.push(command);

            if flags.contains(CommandFlags::SecVtCommandEnd) {
                break;
            }
        }

        Ok(Self { commands })
    }
}
