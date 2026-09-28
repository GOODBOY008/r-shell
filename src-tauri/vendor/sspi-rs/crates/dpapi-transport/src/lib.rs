#![doc = include_str!("../README.md")]
#![warn(missing_docs)]

mod connect_options;

use std::future::Future;
use std::io::Result;

pub use connect_options::{
    ConnectOptions, DEFAULT_RPC_PORT, Error as ConnectOptionsError, GetSessionTokenFn, ProxyOptions,
};

/// Represents a transport for communicating with the target server.
pub trait Transport {
    /// A type that represents communication stream.
    type Stream: Stream;

    /// Connects to the target server.
    fn connect(connect_options: &ConnectOptions) -> impl Future<Output = Result<Self::Stream>>;
}

/// Stream for reading and writing bytes.
pub trait Stream {
    /// Reads an exact number of bytes from the stream and returns buffer as `Vec`.
    fn read_vec(&mut self, length: usize) -> impl Future<Output = Result<Vec<u8>>>;

    /// Read a data from the stream until it fully fills the buffer.
    fn read_exact(&mut self, buf: &mut [u8]) -> impl Future<Output = Result<()>>;

    /// Writes an entire buffer and flushes the stream.
    fn write_all(&mut self, buf: &[u8]) -> impl Future<Output = Result<()>>;
}
