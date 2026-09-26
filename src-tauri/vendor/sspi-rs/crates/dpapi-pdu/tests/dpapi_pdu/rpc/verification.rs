use dpapi_pdu::rpc::{
    CharacterRepr, Command, CommandBitmask, CommandFlags, CommandHeader2, CommandPContext, DataRepr, FloatingPointRepr,
    IntRepr, PacketType, SyntaxId, VerificationTrailer,
};
use uuid::uuid;

test_encoding_decoding! {
    verification_trailer_pcontext_end,
    VerificationTrailer,
    VerificationTrailer {
        commands: vec![
            Command::Pcontext(CommandPContext {
                flags: CommandFlags::SecVtCommandEnd,
                interface_id: SyntaxId {
                    uuid: uuid!("b9785960-524f-11df-8b6d-83dcded72085"),
                    version: 1,
                    version_minor: 0,
                },
                transfer_syntax: SyntaxId {
                    uuid: uuid!("71710533-beba-4937-8319-b5dbef9ccc36"),
                    version: 1,
                    version_minor: 0,
                },
            }),
        ],
    },
    [138, 227, 19, 113, 2, 244, 54, 113, 2, 64, 40, 0, 96, 89, 120, 185, 79, 82, 223, 17, 139, 109, 131, 220, 222, 215, 32, 133, 1, 0, 0, 0, 51, 5, 113, 113, 186, 190, 55, 73, 131, 25, 181, 219, 239, 156, 204, 54, 1, 0, 0, 0]
}

test_encoding_decoding! {
    command_bitmask,
    Command,
    Command::Bitmask1(CommandBitmask {
        bits: 1,
        flags: CommandFlags::None,
    }),
    [1, 0, 4, 0, 1, 0, 0, 0]
}

test_encoding_decoding! {
    command_pcontext,
    Command,
    Command::Pcontext(CommandPContext {
        flags: CommandFlags::SecVtCommandEnd,
        interface_id: SyntaxId {
            uuid: uuid!("b9785960-524f-11df-8b6d-83dcded72085"),
            version: 1,
            version_minor: 0,
        },
        transfer_syntax: SyntaxId {
            uuid: uuid!("71710533-beba-4937-8319-b5dbef9ccc36"),
            version: 1,
            version_minor: 0,
        },
    }),
    [2, 64, 40, 0, 96, 89, 120, 185, 79, 82, 223, 17, 139, 109, 131, 220, 222, 215, 32, 133, 1, 0, 0, 0, 51, 5, 113, 113, 186, 190, 55, 73, 131, 25, 181, 219, 239, 156, 204, 54, 1, 0, 0, 0]
}

test_encoding_decoding! {
    command_header2,
    Command,
    Command::Header2(CommandHeader2 {
        flags: CommandFlags::SecVtMustProcessCommand,
        packet_type: PacketType::Request,
        data_rep: DataRepr {
            byte_order: IntRepr::LittleEndian,
            character: CharacterRepr::Ascii,
            floating_point: FloatingPointRepr::Ieee,
        },
        call_id: 1,
        context_id: 2,
        opnum: 3,
    }),
    [3, 128, 16, 0, 0, 0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 2, 0, 3, 0]
}
