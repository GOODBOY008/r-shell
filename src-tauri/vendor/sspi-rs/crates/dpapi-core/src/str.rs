use alloc::string::String;
use alloc::vec::Vec;

use ironrdp_core::{DecodeError, DecodeResult, InvalidFieldErr, ReadCursor, WriteCursor, ensure_size};

/// Decodes a UTF-16–encoded byte slice into a [String].
///
/// The input `data` slice should has the size multiple of two (`data.len() % 2 == 0`).
/// Otherwise, the function will return an error.
///
/// *Note*: this function does not expect a NULL-char at the end of the byte slice.
pub fn from_utf16_le(data: &[u8]) -> DecodeResult<String> {
    if !data.len().is_multiple_of(2) {
        return Err(DecodeError::invalid_field(
            "",
            "UTF-16 data",
            "byte slice should has the size multiple of two",
        ));
    }

    String::from_utf16(
        &data
            .chunks(2)
            .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
            .collect::<Vec<u16>>(),
    )
    .map_err(|err| DecodeError::invalid_field("", "UTF-16 data", "is not valid UTF-16").with_source(err))
}

/// Encodes str into a UTF-16 encoded byte array.
///
/// *Note*: this function automatically appends a NULL-char.
///
/// # Panics
///
/// Panics when cursor's internal buffer doesn't have enough space.
pub fn encode_utf16_le(data: &str, dst: &mut WriteCursor<'_>) {
    data.encode_utf16()
        .chain(core::iter::once(0))
        .for_each(|v| dst.write_u16(v));
}

/// Calculates the size in bytes of the UTF16 encoded representation of
/// the string slice.
///
/// *Note*: this function automatically counts a NULL-char.
pub fn str_utf16_len(data: &str) -> usize {
    data.encode_utf16().chain(core::iter::once(0)).count() * 2
}

/// Reads UTF-16 C-str from [ReadCursor].
pub fn read_c_str_utf16_le(len: usize, src: &mut ReadCursor<'_>) -> DecodeResult<String> {
    if len < 2 {
        return Err(DecodeError::invalid_field(
            "",
            "C UTF-16 str",
            "expected at least 2 bytes",
        ));
    }

    ensure_size!(ctx: "UTF16-le C str", in: src, size: len);
    let buf = src.read_slice(len - 2 /* UTF16 null terminator */);

    // Read UTF16 null terminator.
    src.read_u16();

    from_utf16_le(buf)
}
