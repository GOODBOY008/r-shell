use dpapi_core::{ReadCursor, WriteBuf};

use crate::generator::AnyStruct;

pub fn round_trip(any: AnyStruct) {
    let mut buf = WriteBuf::new();

    if let Ok(name) = any.encode(&mut buf) {
        let round_tripped_struct =
            AnyStruct::decode(name, &mut ReadCursor::new(buf.filled())).expect("decode should not fail");
        pretty_assertions::assert_eq!(any, round_tripped_struct);
    }
}
