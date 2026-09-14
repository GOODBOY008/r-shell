use std::ffi::CString;
use std::io::{Error, ErrorKind};
use std::str;

use dpapi_transport::GetSessionTokenFn;
use ffi_types::Uuid as CUuid;
use url::Url;
use uuid::Uuid;

use super::GetSessionTokenFn as CGetSessionTokenFn;

/// This function wraps a C-function into a Rust closure which we can pass into the Rust API.
///
/// # Safety
///
/// The C function pointer must be safe to call provided parameters are valid.
pub(super) unsafe fn session_token_fn(get_session_token: CGetSessionTokenFn) -> Box<GetSessionTokenFn> {
    Box::new(move |session_id: Uuid, destination: Url| {
        Box::pin(async move {
            let (data1, data2, data3, data4) = session_id.as_fields();

            let session_id = CUuid {
                data1,
                data2,
                data3,
                data4: *data4,
            };

            let destination = CString::new(destination.as_str())
                .map_err(|err| Error::new(ErrorKind::InvalidData, format!("invalid destination url: {err:?}")))?;
            let mut token_len = 2048;
            let mut token_buf = vec![0; 2048];

            // SAFETY:
            // As per safety preconditions, the C function pointer is safe to be called with valid parameters.
            //
            // * session_id is an object on stack.
            // * destination is created (and validated) using `CString`.
            // * token_buf is a non-empty Vec.
            // * token_len is a local variable.
            let status = unsafe {
                get_session_token(
                    &session_id,
                    destination.as_ptr().cast(),
                    token_buf.as_mut_ptr(),
                    &mut token_len,
                )
            };

            if status != 0 {
                return Err(Error::other(format!(
                    "failed to get the session token. error code {status:#x?}"
                )));
            }

            str::from_utf8(&token_buf[..usize::try_from(token_len).unwrap()])
                .map(|token| token.to_owned())
                .map_err(|err| {
                    Error::new(
                        ErrorKind::InvalidData,
                        format!("session token must be UTF-8 valid data but it is not: {err:?}"),
                    )
                })
        })
    })
}
