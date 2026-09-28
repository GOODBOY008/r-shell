use dpapi_core::{DecodeError, EncodeError};
use dpapi_transport::ConnectOptionsError;
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid URL `{url}`: {description}")]
    InvalidUrl { url: Url, description: &'static str },

    #[error("{0}")]
    DecodeError(DecodeError),

    #[error("{0}")]
    EncodeError(EncodeError),

    #[error(transparent)]
    PduError(#[from] dpapi_pdu::rpc::PduError),

    #[error(transparent)]
    DpapiCore(#[from] dpapi_pdu::Error),

    #[error(transparent)]
    Gkdi(#[from] crate::gkdi::GkdiError),

    #[error(transparent)]
    Blob(#[from] crate::blob::BlobError),

    #[error(transparent)]
    Sid(#[from] crate::sid::SidError),

    #[error(transparent)]
    Crypto(#[from] crate::crypto::CryptoError),

    #[error(transparent)]
    RpcClient(#[from] crate::rpc::client::RpcClientError),

    #[error(transparent)]
    Auth(#[from] crate::rpc::auth::AuthError),

    #[error(transparent)]
    Client(#[from] crate::client::ClientError),

    #[error("IO error")]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    ConnectionUrlParse(#[from] ConnectOptionsError),

    #[error("UUID error: {0}")]
    Uuid(#[from] uuid::Error),

    #[error(transparent)]
    IntConversion(#[from] std::num::TryFromIntError),

    #[error("provided buf contains invalid UTF-8 data")]
    Utf8(#[from] std::string::FromUtf8Error),

    #[error("{description}: {value}: {error}")]
    ParseInt {
        description: &'static str,
        value: String,
        error: std::num::ParseIntError,
    },

    #[error(transparent)]
    Asn1(#[from] picky_asn1_der::Asn1DerError),

    #[error(transparent)]
    CharSet(#[from] picky_asn1::restricted_string::CharSetError),

    #[error(transparent)]
    RandError(#[from] getrandom::Error),

    #[error("modulus is not odd")]
    ModulusIsNotOdd,
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<DecodeError> for Error {
    fn from(err: DecodeError) -> Self {
        Self::DecodeError(err)
    }
}

impl From<EncodeError> for Error {
    fn from(err: EncodeError) -> Self {
        Self::EncodeError(err)
    }
}
