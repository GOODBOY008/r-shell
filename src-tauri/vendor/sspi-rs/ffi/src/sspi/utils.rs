use sspi::{CredentialsBuffers, Result};

use super::credentials_attributes::CredentialsAttributes;
use super::sec_handle::CredentialsHandle;

/// Transforms a passed pointer to the credentials handle into a triplet of [CredentialsBuffers],
/// security package name, and [CredentialsAttributes].
///
/// # Safety
///
/// The caller have to ensure that either the pointer is null or the pointer is [convertible to a reference](https://doc.rust-lang.org/std/ptr/index.html#pointer-to-reference-conversion).
pub unsafe fn transform_credentials_handle<'a>(
    credentials_handle: *mut CredentialsHandle,
) -> Option<(CredentialsBuffers, &'a str, &'a CredentialsAttributes)> {
    // SAFETY: `credentials_handle` is either null or it is convertible to a reference.
    unsafe { credentials_handle.as_mut() }.map(|cred_handle| {
        (
            cred_handle.credentials.clone(),
            cred_handle.security_package_name.as_str(),
            &cred_handle.attributes,
        )
    })
}

pub fn hostname() -> Result<String> {
    // We run tests with Miri. Miri is the Rust's mid-level intermediate representation interpreter.
    // It is unable to execute system calls. Thus, Miri cannot execute `whoami::hostname()`.
    // So, we decided to keep hardcoded hostname.
    #[cfg(miri)]
    {
        Ok("test-vm".into())
    }
    #[cfg(not(miri))]
    {
        use sspi::{Error, ErrorKind};

        whoami::hostname().map_err(|err| {
            Error::new(
                ErrorKind::InternalError,
                format!("can not query the system hostname: {err:?}"),
            )
        })
    }
}
