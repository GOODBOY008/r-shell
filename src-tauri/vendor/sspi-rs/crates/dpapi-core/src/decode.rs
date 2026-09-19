use ironrdp_core::{DecodeError, DecodeResult, InvalidFieldErr, ReadCursor, ensure_size};
use uuid::Uuid;

use crate::NeedsContext;

/// Decodes [Uuid] from provided source [ReadCursor].
pub fn decode_uuid(src: &mut ReadCursor<'_>) -> DecodeResult<Uuid> {
    ensure_size!(in: src, size: Uuid::FIXED_PART_SIZE);

    Uuid::from_slice_le(src.read_slice(Uuid::FIXED_PART_SIZE))
        .map_err(|err| DecodeError::invalid_field("", "uuid", "invalid data").with_source(err))
}

/// PDU that can be decoded from a binary input and provided context.
pub trait DecodeWithContextOwned: Sized + NeedsContext {
    /// Decodes PDU from a [`ReadCursor`] with provided context.
    fn decode_with_context_owned(src: &mut ReadCursor<'_>, ctx: Self::Context<'_>) -> DecodeResult<Self>;
}

/// Fixed size of the structure.
pub trait FixedPartSize {
    /// Size of the fixed part of frame.
    const FIXED_PART_SIZE: usize;
}

impl FixedPartSize for Uuid {
    const FIXED_PART_SIZE: usize = 16;
}

/// Finds the precise byte count required to decode the frame from a possibly partial input.
/// Incorrectly reading too few or too many bytes will lead to program malfunctions.
pub trait FindLength: FixedPartSize {
    /// Try to find the length of this frame given the first bytes.
    fn find_frame_length(bytes: &[u8]) -> DecodeResult<Option<usize>>;
}
