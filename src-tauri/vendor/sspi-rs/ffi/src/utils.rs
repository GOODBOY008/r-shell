use std::slice::from_raw_parts;

use libc::c_char;

pub(crate) fn into_raw_ptr<T>(value: T) -> *mut T {
    Box::into_raw(Box::new(value))
}

/// Converts raw credentials string into [Vec] of bytes.
///
/// Credentials are often represented as strings. For example, username, domain, password.
/// It is OK for Windows SSPI to accept `null` or empty credential strings. The `AcquireCredentialsHandle`
/// function will return successful status code is we pass the `null` username value. Thus, this function
/// will return an empty [Vec] in such a case. It is done on purpose to follow the Windows SSPI behavior.
///
/// # Safety
///
/// * the `raw_buffer` pointer can be null.
/// * if `raw_buffer` is not null, then it must be valid for reads for `len` many bytes, and it must be properly aligned.
/// * The total size `len` of the slice must be no larger than `isize::MAX`, and adding that size to `raw_buffer`
///   must not "wrap around" the address space.
pub(crate) unsafe fn credentials_str_into_bytes(raw_buffer: *const c_char, len: usize) -> Vec<u8> {
    if !raw_buffer.is_null() {
        // SAFETY:
        // - `raw_buffer` is guaranteed to be non-null due to the prior check.
        // - `raw_buffer` is valid for reads for `len` many bytes.
        // - `len` does not exceed `isize::MAX`.
        unsafe { from_raw_parts(raw_buffer as *const u8, len) }.to_vec()
    } else {
        Vec::new()
    }
}
