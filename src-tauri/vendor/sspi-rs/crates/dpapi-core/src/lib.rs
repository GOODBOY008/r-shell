#![doc = include_str!("../README.md")]
#![cfg_attr(not(feature = "std"), no_std)]
#![warn(clippy::std_instead_of_alloc)]
#![warn(clippy::std_instead_of_core)]
#![warn(missing_docs)]

#[cfg(feature = "alloc")]
extern crate alloc;

mod decode;
mod encode;
mod marker;
mod padding;
/// Helper functions for working with C and UTF-16c strings.
#[cfg(feature = "alloc")]
pub mod str;

pub use decode::{DecodeWithContextOwned, FindLength, FixedPartSize, decode_uuid};
#[cfg(feature = "alloc")]
pub use encode::EncodeVec;
pub use encode::{encode_seq, encode_uuid, size_seq};
pub use ironrdp_core::{
    DecodeError, DecodeOwned, DecodeResult, Encode, EncodeError, EncodeResult, InvalidFieldErr, OtherErr, ReadCursor,
    UnsupportedValueErr, WriteBuf, WriteCursor, cast_int, cast_length, decode_owned, encode_buf, ensure_size,
};
pub use marker::{NeedsContext, StaticName};
pub use padding::{compute_padding, read_padding, write_padding};
