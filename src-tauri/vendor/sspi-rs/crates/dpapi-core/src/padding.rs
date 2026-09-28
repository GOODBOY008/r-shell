use ironrdp_core::{DecodeResult, EncodeResult, ReadCursor, WriteCursor, ensure_size};

/// Write padding bytes into [WriteCursor].
pub fn write_padding(mut padding_len: usize, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
    ensure_size!(ctx: "Padding", in: dst, size: padding_len);

    loop {
        match padding_len {
            0 => break,
            1 => {
                dst.write_u8(0);
                padding_len -= 1;
            }
            2..=3 => {
                dst.write_u16(0);
                padding_len -= 2;
            }
            4..=7 => {
                dst.write_u32(0);
                padding_len -= 4;
            }
            _ => {
                dst.write_u64(0);
                padding_len -= 8;
            }
        }
    }

    Ok(())
}

/// Reads padding bytes from the provided [ReadCursor].
pub fn read_padding(padding_len: usize, src: &mut ReadCursor<'_>) -> DecodeResult<()> {
    ensure_size!(ctx: "Padding", in: src, size: padding_len);

    src.advance(padding_len);

    Ok(())
}

/// Computes a padding length for the given alignment and data length.
pub fn compute_padding(alignment: usize, len: usize) -> usize {
    (alignment - (len % alignment)) % alignment
}
