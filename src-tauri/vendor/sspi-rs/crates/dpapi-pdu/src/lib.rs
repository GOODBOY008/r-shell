#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

mod error;
pub mod gkdi;
pub mod rpc;
pub use error::{Error, Result};
