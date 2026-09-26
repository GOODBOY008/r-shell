use alloc::string::String;

use dpapi_core::{DecodeError, InvalidFieldErr};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("{0}")]
    FromUtf16(String),

    #[error("invalid {name} length: expected at least {expected} bytes but got {actual}")]
    InvalidLength {
        name: &'static str,
        expected: usize,
        actual: usize,
    },
}

impl From<Error> for DecodeError {
    fn from(err: Error) -> Self {
        match &err {
            Error::FromUtf16(_) => DecodeError::invalid_field("", "UTF-16 string", "invalid value"),
            Error::InvalidLength { .. } => DecodeError::invalid_field("", "length", "invalid value"),
        }
        .with_source(err)
    }
}

impl From<alloc::string::FromUtf16Error> for Error {
    fn from(err: alloc::string::FromUtf16Error) -> Self {
        use alloc::string::ToString;

        Self::FromUtf16(err.to_string())
    }
}

pub type Result<T> = core::result::Result<T, Error>;
