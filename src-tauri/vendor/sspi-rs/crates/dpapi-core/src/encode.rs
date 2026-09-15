use ironrdp_core::{Encode, EncodeResult, WriteCursor, ensure_size};
use uuid::Uuid;

use crate::FixedPartSize;

/// Encodes [Uuid] in-place using the provided [WriteCursor].
pub fn encode_uuid(uuid: Uuid, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
    ensure_size!(in: dst, size: Uuid::FIXED_PART_SIZE);

    dst.write_slice(&uuid.to_bytes_le());

    Ok(())
}

/// Encodes sequence of elements in-place using the provided [WriteCursor].
pub fn encode_seq<T: Encode>(data: &[T], dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
    for item in data.iter() {
        item.encode(dst)?;
    }

    Ok(())
}

/// Computes the size in bytes for the sequence of elements.
pub fn size_seq<T: Encode>(data: &[T]) -> usize {
    data.iter().map(|item| item.size()).sum()
}

#[cfg(feature = "alloc")]
mod encode_vec {
    use alloc::vec::Vec;

    use ironrdp_core::{Encode, EncodeResult, WriteBuf, encode_buf};

    /// Extension trait which allows to encode PDU into [Vec].
    pub trait EncodeVec {
        /// Encodes this PDU into a [Vec] allocating a memory on fly.
        fn encode_vec(&self) -> EncodeResult<Vec<u8>>;
    }

    impl<T: Encode> EncodeVec for T {
        fn encode_vec(&self) -> EncodeResult<Vec<u8>> {
            let mut buf = WriteBuf::new();
            encode_buf(self, &mut buf)?;

            Ok(buf.into_inner())
        }
    }
}

#[cfg(feature = "alloc")]
pub use encode_vec::*;
