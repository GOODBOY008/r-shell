#![doc = include_str!("../README.md")]
#![warn(clippy::large_futures)]

#[macro_use]
extern crate tracing;

pub mod blob;
mod client;
pub mod crypto;
pub mod error;
pub mod gkdi;
pub mod rpc;
pub(crate) mod sid;

pub use client::{CryptProtectSecretArgs, CryptUnprotectSecretArgs, n_crypt_protect_secret, n_crypt_unprotect_secret};
pub use error::{Error, Result};
pub use sspi;
