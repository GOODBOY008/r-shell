use std::slice::{from_raw_parts, from_raw_parts_mut};

use libc::{c_ulonglong, c_void};
use num_traits::cast::{FromPrimitive, ToPrimitive};
use sspi::{
    BufferType, DataRepresentation, DecryptionFlags, EncryptionFlags, Error, ErrorKind, SecurityBuffer,
    SecurityBufferRef, SecurityBufferType, ServerRequestFlags, Sspi, SspiImpl,
};
#[cfg(windows)]
use symbol_rename_macro::rename_symbol;

use super::credentials_attributes::CredentialsAttributes;
use super::sec_buffer::{
    PSecBuffer, PSecBufferDesc, SecBuffer, copy_to_c_sec_buffer, p_sec_buffers_to_security_buffers,
};
use super::sec_handle::{CredentialsHandle, PCredHandle, PCtxtHandle, p_ctxt_handle_to_sspi_context};
use super::sspi_data_types::{PTimeStamp, SecurityStatus};
use super::utils::transform_credentials_handle;
use crate::sspi::sec_handle::SspiHandle;
use crate::utils::into_raw_ptr;

/// The `FreeCredentialsHandle` function notifies the security system that the credentials are no longer needed.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-freecredentialshandle)
///
/// # Safety
///
/// `ph_credentials` must be a non-null pointer, allocated by the `AcquireCredentialsHandleA/W` function.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_FreeCredentialsHandle"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn FreeCredentialsHandle(ph_credential: PCredHandle) -> SecurityStatus {
    check_null!(ph_credential);

    // SAFETY:
    // - `ph_credentials` is guaranteed to be non-null due to the prior check.
    // - `ph_credentials` points to a valid `credentials handle` allocated by the `AcquireCredentialsHandleA/W` function.
    let cred_handle = unsafe { (*ph_credential).dw_lower as *mut CredentialsHandle };
    check_null!(cred_handle);

    // SAFETY:
    // - `cred_handle` is guaranteed to be non-null due to the prior check.
    // - `ph_credentials` is allocated by the `AcquireCredentialsHandleA/W` function.
    //   It guarantees that the pointer was allocated using `Box::into_raw`.
    let _cred_handle = unsafe { Box::from_raw(cred_handle) };

    0
}

pub type FreeCredentialsHandleFn = unsafe extern "system" fn(PCredHandle) -> SecurityStatus;

/// The `AcceptSecurityContext` function lets the server component of a transport application
/// establish a security context between the server and a remote client.
///
/// Note: `ph_context` is null on the first call.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-acceptsecuritycontext)
///
/// # Safety
///
/// - `ph_credential` must be a non-null, valid pointer to a credentials handle, allocated by either [`AcquireCredentialsHandleA`](crate::sspi::sec_handle::AcquireCredentialsHandleA)
///   or [`AcquireCredentialsHandleW`](crate::sspi::sec_handle::AcquireCredentialsHandleW).
/// - `ph_context` must be a valid pointer to a `SecHandle` structure.
///   If this is not the first call to `AcceptSecurityContext`, then the pointer must point to the partially formed context
///   returned in the `phNewContext` parameter by the first call.
/// - `p_input` must be a non-null, properly-aligned pointer to a valid `SecBufferDesc` structure.
/// - `ph_new_context` must be a non-null, properly-aligned pointer to a valid `SecHandle` structure.
/// - `p_output` must be a non-null, properly-aligned pointer to a valid `SecBufferDesc` structure.
///   It must contain enough buffers, and each buffer must have enough space to hold the output tokens.
/// - `pf_context_attr` must be a non-null, properly-aligned pointer to a `u32` value.
#[instrument(skip_all)]
#[allow(clippy::useless_conversion)]
#[cfg_attr(windows, rename_symbol(to = "Rust_AcceptSecurityContext"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn AcceptSecurityContext(
    ph_credential: PCredHandle,
    mut ph_context: PCtxtHandle,
    p_input: PSecBufferDesc,
    f_context_req: u32,
    target_data_rep: u32,
    ph_new_context: PCtxtHandle,
    p_output: PSecBufferDesc,
    pf_context_attr: *mut u32,
    _pts_expiry: PTimeStamp,
) -> SecurityStatus {
    catch_panic! {
        // ph_context must be null on the first call
        check_null!(ph_new_context);
        check_null!(ph_credential);
        check_null!(p_input);
        check_null!(p_output);
        check_null!(pf_context_attr);

        // SAFETY:
        // - `ph_credentials` is guaranteed to be non-null due to the prior check.
        // - `ph_credentials` points to a valid `credentials handle` allocated by an SSPI function.
        let credentials_handle = unsafe { (*ph_credential).dw_lower as *mut CredentialsHandle };

        // SAFETY: `credentials_handle` is either null or a valid pointer to the `CredentialsHandle` allocated by an SSPI function.
        let transformed_credentials_handle = unsafe { transform_credentials_handle(credentials_handle) };

        let (auth_data, security_package_name, attributes) =
            match transformed_credentials_handle {
                Some(data) => data,
                None => return ErrorKind::InvalidHandle.to_u32().unwrap(),
            };

        let mut sspi_context_ptr = try_execute!(
            // SAFETY:
            // - `ph_context` is either null or convertible to a reference.
            // - The values behind `ph_context.dw_lower` and `ph_context.dw_upper` pointers are allocated by an SSPI function.
            unsafe { p_ctxt_handle_to_sspi_context(
                &mut ph_context,
                Some(security_package_name),
                attributes,
            )}
        );

        // SAFETY: `sspi_context_ptr` is a valid, local pointer to the `SspiHandle` allocated by the `p_ctx_handle_to_sspi_context`.
        let sspi_context = unsafe { sspi_context_ptr.as_mut() };

        // SAFETY:
        // - `p_input` is guaranteed to be non-null due to the prior check.
        // - `p_input` points to a valid `SecBufferDesc` structure.
        let p_buffers = unsafe { (*p_input).p_buffers };

        let mut input_tokens = try_execute!(
            if p_buffers.is_null() {
                Err(Error::new(ErrorKind::InvalidParameter, "p_buffers cannot be null"))
            } else {
                // SAFETY:
                // - `p_input` is guaranteed to be non-null due to the prior check.
                // - `p_input` points to a valid `SecBufferDesc` structure.
                let c_buffers = unsafe { (*p_input).c_buffers };

                // SAFETY:
                // - `p_buffers` is guaranteed to be non-null due to the prior check.
                // - The memory region `p_buffers` points to is valid for reads of `c_buffers` element.
                let raw_buffers = unsafe {
                    from_raw_parts(p_buffers, c_buffers as usize)
                };
                // SAFETY:
                // - `raw_buffers` array contains valid `SecBuffer` structures.
                // - Each `SecBuffer` have a valid `pv_buffer` pointer that is valid for reads of `cb_buffer` bytes.
                Ok(unsafe { p_sec_buffers_to_security_buffers(raw_buffers) })
            });

        let mut output_tokens = vec![SecurityBuffer::new(Vec::with_capacity(1024), BufferType::Token)];

        let mut auth_data = Some(auth_data);
        let builder = sspi_context.accept_security_context()
            .with_credentials_handle(&mut auth_data)
            .with_context_requirements(ServerRequestFlags::from_bits(f_context_req.try_into().unwrap()).unwrap())
            .with_target_data_representation(DataRepresentation::from_u32(target_data_rep.try_into().unwrap()).unwrap())
            .with_input(&mut input_tokens)
            .with_output(&mut output_tokens);
        let result_status = try_execute!(sspi_context.accept_security_context_impl(builder)).resolve_with_default_network_client();

        // SAFETY:
        // - `p_output` is guaranteed to be non-null due to the prior check.
        // - `p_output` points to a valid `SecBufferDesc` structure.
        let p_buffers = unsafe { (*p_output).p_buffers };
        try_execute!(
            // SAFETY:
            // - `p_buffers` is a valid pointer to an array of security buffers.
            // - The memory region `p_buffers` points to is valid for writes of `from_buffers.len()` elements.
            // - For each element in the `p_buffers` array, the `pv_buffer` pointer points to a valid memory,
            //   that is valid for writes of `cb_buffer` bytes.
            unsafe { copy_to_c_sec_buffer(p_buffers, &output_tokens, false) }
        );

        // SAFETY: `ph_new_context` is convertible to a reference.
        let ph_new_context = unsafe { ph_new_context.as_mut() }.expect("ph_new_context is non-null");

        ph_new_context.dw_lower = sspi_context_ptr.as_ptr() as c_ulonglong;
        ph_new_context.dw_upper = into_raw_ptr(security_package_name.to_owned()) as c_ulonglong;
        // SAFETY: `pf_context_attr` is guaranteed to be non-null due to the prior check.
        unsafe {
            *pf_context_attr = f_context_req;
        }

        let result = try_execute!(result_status);
        result.status.to_u32().unwrap()
    }
}

pub type AcceptSecurityContextFn = unsafe extern "system" fn(
    PCredHandle,
    PCtxtHandle,
    PSecBufferDesc,
    u32,
    u32,
    PCtxtHandle,
    PSecBufferDesc,
    *mut u32,
    PTimeStamp,
) -> SecurityStatus;

/// The `CompleteAuthToken` function completes an authentication token.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-completeauthtoken)
///
/// # Safety
///
/// - `ph_context` must be a valid pointer to a `SecHandle` structure.
///   If `dw_lower` and `dw_upper` fields are non-zero, then they must point to a memory that was allocated
///   by the `InitializeSecurityContext` function or the `AcceptSecurityContext` function.
/// - `p_token` must be a non-null, properly-aligned pointer to a valid `SecBufferDesc` structure.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_CompleteAuthToken"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn CompleteAuthToken(
    mut ph_context: PCtxtHandle,
    p_token: PSecBufferDesc,
) -> SecurityStatus {
    catch_panic! {
        check_null!(ph_context);
        check_null!(p_token);

        // SAFETY:
        // - `p_token` is guaranteed to be non-null due to the prior check.
        // - `p_token` points to a valid `SecBufferDesc` structure.
        let p_buffers = unsafe { (*p_token).p_buffers };
        check_null!(p_buffers);

        let mut sspi_context_ptr = try_execute!(
            // SAFETY:
            // - `ph_context` is either null or convertible to a reference.
            // - The values behind `ph_context.dw_lower` and `ph_context.dw_upper` pointers are allocated by an SSPI function.
            unsafe { p_ctxt_handle_to_sspi_context(
                &mut ph_context,
                None,
                &CredentialsAttributes::default()
            )}
        );

        // SAFETY: `sspi_context_ptr` is a valid, local pointer to the `SspiHandle` allocated by the `p_ctx_handle_to_sspi_context`.
        let sspi_context = unsafe { sspi_context_ptr.as_mut() };

        // SAFETY:
        // - `p_token` is guaranteed to be non-null due to the prior check.
        // - `p_token` points to a valid `SecBufferDesc` structure.
        let c_buffers = unsafe { (*p_token).c_buffers } as usize;

        // SAFETY:
        // - `p_buffers` is guaranteed to be non-null due to the prior check.
        // - The memory region `p_buffers` points to is valid for reads of `c_buffers` elements.
        let raw_buffers = unsafe { from_raw_parts(p_buffers, c_buffers) };

        // SAFETY:
        // - `raw_buffers` array contains valid `SecBuffer` structures.
        // - Each `SecBuffer` have a valid `pv_buffer` pointer that is valid for reads of `cb_buffer` bytes.
        let mut buffers = unsafe { p_sec_buffers_to_security_buffers(raw_buffers) };

        sspi_context.complete_auth_token(&mut buffers).map_or_else(
            |err| err.error_type.to_u32().unwrap(),
            |result| result.to_u32().unwrap(),
        )
    }
}

pub type CompleteAuthTokenFn = unsafe extern "system" fn(PCtxtHandle, PSecBufferDesc) -> SecurityStatus;

/// The `DeleteSecurityContext` function deletes the local data structures associated with the specified
/// `security context` initiated by a previous call to the `InitializeSecurityContext` function or the
/// `AcceptSecurityContext` function.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-deletesecuritycontext)
///
/// # Safety
///
/// - `ph_context` must be a valid pointer to a `SecHandle` structure.
///   If `dw_lower` and `dw_upper` fields are non-zero, then they must point to a memory that was allocated
///   by the `InitializeSecurityContext` function or the `AcceptSecurityContext` function.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_DeleteSecurityContext"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DeleteSecurityContext(mut ph_context: PCtxtHandle) -> SecurityStatus {
    catch_panic!(
        check_null!(ph_context);

        let sspi_context_ptr = try_execute!(
            // SAFETY:
            // - `ph_context` is convertible to a reference.
            // - The values behind `ph_context.dw_lower` and `ph_context.dw_upper` pointers are allocated by an SSPI function.
            unsafe { p_ctxt_handle_to_sspi_context(
                &mut ph_context,
                None,
                &CredentialsAttributes::default()
            )}
        );

        // SAFETY: `sspi_context_ptr` is a valid, local pointer to the `SspiHandle` allocated by the `p_ctx_handle_to_sspi_context`.
        let _context: Box<SspiHandle> = unsafe {
            Box::from_raw(sspi_context_ptr.as_ptr())
        };

        // SAFETY:
        // - `ph_context` is guaranteed to be non-null due to the prior check.
        // - `ph_context` points to a valid `SecHandle` structure.
        let dw_upper = unsafe { (*ph_context).dw_upper };
        if dw_upper != 0 {
            // SAFETY:
            // - `dw_upper` is guaranteed to be non-null due to the prior check.
            // - The value behind `dw_upper` pointer is allocated by an SSPI function.
            let _name: Box<String> = unsafe { Box::from_raw(dw_upper as *mut String) };
        }

        0
    )
}

pub type DeleteSecurityContextFn = unsafe extern "system" fn(PCtxtHandle) -> SecurityStatus;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_ApplyControlToken"))]
#[unsafe(no_mangle)]
pub extern "system" fn ApplyControlToken(_ph_context: PCtxtHandle, _p_input: PSecBufferDesc) -> SecurityStatus {
    ErrorKind::UnsupportedFunction.to_u32().unwrap()
}

pub type ApplyControlTokenFn = extern "system" fn(PCtxtHandle, PSecBufferDesc) -> SecurityStatus;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_ImpersonateSecurityContext"))]
#[unsafe(no_mangle)]
pub extern "system" fn ImpersonateSecurityContext(_ph_context: PCtxtHandle) -> SecurityStatus {
    ErrorKind::UnsupportedFunction.to_u32().unwrap()
}

pub type ImpersonateSecurityContextFn = extern "system" fn(PCtxtHandle) -> SecurityStatus;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_RevertSecurityContext"))]
#[unsafe(no_mangle)]
pub extern "system" fn RevertSecurityContext(_ph_context: PCtxtHandle) -> SecurityStatus {
    ErrorKind::UnsupportedFunction.to_u32().unwrap()
}

pub type RevertSecurityContextFn = extern "system" fn(PCtxtHandle) -> SecurityStatus;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_MakeSignature"))]
#[unsafe(no_mangle)]
pub extern "system" fn MakeSignature(
    _ph_context: PCtxtHandle,
    _f_qop: u32,
    _p_message: PSecBufferDesc,
    _message_seq_no: u32,
) -> SecurityStatus {
    ErrorKind::UnsupportedFunction.to_u32().unwrap()
}

pub type MakeSignatureFn = extern "system" fn(PCtxtHandle, u32, PSecBufferDesc, u32) -> SecurityStatus;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_VerifySignature"))]
#[unsafe(no_mangle)]
pub extern "system" fn VerifySignature(
    _ph_context: PCtxtHandle,
    _message: PSecBufferDesc,
    _message_seq_no: u32,
    _pf_qop: *mut u32,
) -> SecurityStatus {
    ErrorKind::UnsupportedFunction.to_u32().unwrap()
}

pub type VerifySignatureFn = extern "system" fn(PCtxtHandle, PSecBufferDesc, u32, *mut u32) -> SecurityStatus;

/// The `FreeContextBuffer` function enables callers of `security package` functions to free memory buffers
/// allocated by the security package.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-freecontextbuffer)
///
/// # Safety
///
/// The `pv_context_buffer` must point to a memory allocated by an SSPI function.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_FreeContextBuffer"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn FreeContextBuffer(pv_context_buffer: *mut c_void) -> SecurityStatus {
    // NOTE: see https://github.com/Devolutions/sspi-rs/pull/141 for rationale behind libc usage.
    // SAFETY:
    // - Memory deallocation is safe.
    // - The value behind `pv_context_buffer` is allocated by an SSPI function.
    unsafe {
        libc::free(pv_context_buffer);
    }

    0
}

pub type FreeContextBufferFn = unsafe extern "system" fn(*mut c_void) -> SecurityStatus;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_ExportSecurityContext"))]
#[unsafe(no_mangle)]
pub extern "system" fn ExportSecurityContext(
    _ph_context: PCtxtHandle,
    _f_flags: u32,
    _p_packed_context: PSecBuffer,
    _p_token: *mut *mut c_void,
) -> SecurityStatus {
    ErrorKind::UnsupportedFunction.to_u32().unwrap()
}

pub type ExportSecurityContextFn = extern "system" fn(PCtxtHandle, u32, PSecBuffer, *mut *mut c_void) -> SecurityStatus;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_QuerySecurityContextToken"))]
#[unsafe(no_mangle)]
pub extern "system" fn QuerySecurityContextToken(_ph_context: PCtxtHandle, _token: *mut *mut c_void) -> SecurityStatus {
    ErrorKind::UnsupportedFunction.to_u32().unwrap()
}

pub type QuerySecurityContextTokenFn = extern "system" fn(PCtxtHandle, *mut *mut c_void) -> SecurityStatus;

/// The `EncryptMessage` function encrypts a message to provide privacy.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-encryptmessage)
///
/// # Safety
///
/// - `ph_context` must be a valid pointer to a `SecHandle` structure.
///   If `dw_lower` and `dw_upper` fields are non-zero, then they must point to a memory that was allocated by an SSPI function.
/// - `p_message` must be a non-null, properly-aligned pointer to a valid `SecBufferDesc` structure.
#[allow(clippy::useless_conversion)]
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_EncryptMessage"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn EncryptMessage(
    mut ph_context: PCtxtHandle,
    f_qop: u32,
    p_message: PSecBufferDesc,
    _message_seq_no: u32,
) -> SecurityStatus {
    catch_panic! {
        check_null!(ph_context);
        check_null!(p_message);

        // SAFETY:
        // - `p_message` is guaranteed to be non-null due to the prior check.
        // - `p_message` points to a valid `SecBufferDesc` structure.
        let p_buffers = unsafe { (*p_message).p_buffers };
        check_null!(p_buffers);

        let mut sspi_context_ptr = try_execute!(
            // SAFETY:
            // - `ph_context` is convertible to a reference.
            // - The values behind `ph_context.dw_lower` and `ph_context.dw_upper` pointers are allocated by an SSPI function.
            unsafe { p_ctxt_handle_to_sspi_context(
                &mut ph_context,
                None,
                &CredentialsAttributes::default()
            )}
        );

        // SAFETY: `sspi_context_ptr` is a valid, local pointer to the `SspiHandle` allocated by the `p_ctx_handle_to_sspi_context`.
        let sspi_context = unsafe { sspi_context_ptr.as_mut() };

        // SAFETY:
        // - `p_message` is guaranteed to be non-null due to the prior check.
        // - `p_message` points to a valid `SecBufferDesc` structure.
        let len = unsafe { (*p_message).c_buffers as usize };

        // SAFETY:
        // - `p_buffers` is guaranteed to be non-null due to the prior check.
        // - The memory region `p_buffers` points to is valid for reads of `len` elements.
        let raw_buffers = unsafe {
            from_raw_parts(p_buffers, len)
        };

        let mut message = try_execute!(
            // SAFETY:
            // - `raw_buffers` array contains valid `SecBuffer` structures.
            // - Each `SecBuffer` have a valid `pv_buffer` pointer that is valid for reads of `cb_buffer` bytes.
            unsafe { p_sec_buffers_to_decrypt_buffers(raw_buffers) }
        );

        let result_status = sspi_context.encrypt_message(
            EncryptionFlags::from_bits(f_qop.try_into().unwrap()).unwrap(),
            &mut message,
        );

        try_execute!(
            // SAFETY:
            // - `p_buffers` is a valid pointer to an array of security buffers.
            // - The memory region `p_buffers` points to is valid for writes of `from_buffers.len()` elements.
            // - For each element in the `p_buffers` array, the `pv_buffer` pointer points to a valid memory,
            //   that is valid for writes of `cb_buffer` bytes.
            // - There is enough space in the buffers, since we are writing encrypted data back to the same buffers it was read.
            unsafe { copy_decrypted_buffers(p_buffers, message) }
        );

        let result = try_execute!(result_status);
        result.to_u32().unwrap()
    }
}

pub type EncryptMessageFn = unsafe extern "system" fn(PCtxtHandle, u32, PSecBufferDesc, u32) -> SecurityStatus;

/// The `DecryptMessage` function decrypts a message.
///
/// Note: `pf_qop` can be null if this library is used as a CredSsp security package.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-decryptmessage)
///
/// # Safety
///
/// - `ph_context` must be a valid pointer to a `SecHandle` structure.
///   If `dw_lower` and `dw_upper` fields are non-zero, then they must point to a memory that was allocated by an SSPI function.
/// - `p_message` must be a non-null, properly-aligned pointer to a valid `SecBufferDesc` structure.
/// - `pf_qop` must be a valid, properly-aligned pointer to a `u32` value.
#[allow(clippy::useless_conversion)]
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_DecryptMessage"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DecryptMessage(
    mut ph_context: PCtxtHandle,
    p_message: PSecBufferDesc,
    _message_seq_no: u32,
    pf_qop: *mut u32,
) -> SecurityStatus {
    catch_panic! {
        check_null!(ph_context);
        check_null!(p_message);

        // SAFETY:
        // - `p_message` is guaranteed to be non-null due to the prior check.
        // - `p_message` points to a valid `SecBufferDesc` structure.
        let p_buffers = unsafe { (*p_message).p_buffers };
        check_null!(p_buffers);

        let mut sspi_context_ptr = try_execute!(
            // SAFETY:
            // - `ph_context` is convertible to a reference.
            // - The values behind `ph_context.dw_lower` and `ph_context.dw_upper` pointers are allocated by an SSPI function.
            unsafe { p_ctxt_handle_to_sspi_context(
                &mut ph_context,
                None,
                &CredentialsAttributes::default()
            )}
        );

        // SAFETY: `sspi_context_ptr` is a valid, local pointer to the `SspiHandle` allocated by the `p_ctx_handle_to_sspi_context`.
        let sspi_context = unsafe { sspi_context_ptr.as_mut() };

        // SAFETY:
        // - `p_message` is guaranteed to be non-null due to the prior check.
        // - `p_message` points to a valid `SecBufferDesc` structure.
        let len = unsafe { (*p_message).c_buffers as usize };

        // SAFETY:
        // - `p_buffers` is guaranteed to be non-null due to the prior check.
        // - The memory region `p_buffers` points to is valid for reads of `len` elements.
        let raw_buffers = unsafe { from_raw_parts(p_buffers, len) };

        let mut message = try_execute!(
            // SAFETY:
            // - `raw_buffers` array contains valid `SecBuffer` structures.
            // - Each `SecBuffer` have a valid `pv_buffer` pointer that is valid for reads of `cb_buffer` bytes.
            unsafe { p_sec_buffers_to_decrypt_buffers(raw_buffers) }
        );

        let (decryption_flags, result_status) =
            match sspi_context.decrypt_message(&mut message) {
                Ok(flags) => (flags, Ok(())),
                Err(error) => (DecryptionFlags::empty(), Err(error)),
            };

        try_execute!(
            // SAFETY:
            // - `p_buffers` is a valid pointer to an array of security buffers.
            // - The memory region `p_buffers` points to is valid for writes of `from_buffers.len()` elements.
            // - For each element in the `p_buffers` array, the `pv_buffer` pointer points to a valid memory,
            //   that is valid for writes of `cb_buffer` bytes.
            // - There is enough space in the buffers, since we are writing decrypted data back to the same buffers it was read.
            unsafe { copy_decrypted_buffers(p_buffers, message) }
        );

        // `pf_qop` can be null if this library is used as a CredSsp security package
        if !pf_qop.is_null() {
            let flags = try_execute!(decryption_flags.bits().try_into(), ErrorKind::InternalError);
            // SAFETY: `pf_qop` is guaranteed to be non-null due to the prior check.
            unsafe { *pf_qop = flags };
        }

        try_execute!(result_status);

        0
    }
}

pub type DecryptMessageFn = unsafe extern "system" fn(PCtxtHandle, PSecBufferDesc, u32, *mut u32) -> SecurityStatus;

/// Creates a vector of [SecurityBufferRef]s from the input C buffers.
///
/// # Safety
///
/// After this function call, no one should touch [raw_buffers]. Otherwise, we can get UB.
/// It's because this function creates exclusive (mutable) Rust references to the input buffers.
///
/// `raw_buffers` must be an array of valid `SecBuffer` structures.
#[allow(clippy::useless_conversion)]
unsafe fn p_sec_buffers_to_decrypt_buffers(raw_buffers: &[SecBuffer]) -> sspi::Result<Vec<SecurityBufferRef<'_>>> {
    let mut buffers = Vec::with_capacity(raw_buffers.len());

    for raw_buffer in raw_buffers {
        let buf =
            SecurityBufferRef::with_owned_security_buffer_type(SecurityBufferType::try_from(raw_buffer.buffer_type)?)?;

        buffers.push(if BufferType::Missing == buf.buffer_type() {
            // https://learn.microsoft.com/en-us/windows/win32/api/sspi/ns-sspi-secbuffer
            // SECBUFFER_MISSING: ...The pvBuffer member is ignored in this type.
            SecurityBufferRef::missing_buf(raw_buffer.cb_buffer.try_into()?)
        } else {
            let data = if raw_buffer.pv_buffer.is_null() || raw_buffer.cb_buffer == 0 {
                &mut []
            } else {
                // SAFETY:
                // - `raw_buffer.pv_buffer` is guaranteed to be non-null due to the prior check.
                // - The memory region `raw_buffer.pv_buffer` points to is valid for reads of `raw_buffer.cb_buffer` bytes.
                unsafe { from_raw_parts_mut(raw_buffer.pv_buffer as *mut u8, raw_buffer.cb_buffer.try_into()?) }
            };
            buf.with_data(data)?
        })
    }

    Ok(buffers)
}

/// Copies Rust-security-buffers into C-security-buffers.
///
/// # Safety
///
/// This function accepts owned [from_buffers] to avoid UB and other errors. Rust-buffers should
/// not be used after the data is copied into C-buffers.
///
/// `to_buffers` must be a non-null pointer valid for reads of `from_buffers.len()` elements.
unsafe fn copy_decrypted_buffers(to_buffers: PSecBuffer, from_buffers: Vec<SecurityBufferRef<'_>>) -> sspi::Result<()> {
    // SAFETY:
    // - `to_buffers` is non-null due to the function's safety requirement.
    // - The memory region `to_buffers` points to is valid for reads of `from_buffers.len()` elements.
    let to_buffers = unsafe { from_raw_parts_mut(to_buffers, from_buffers.len()) };

    for (to_buffer, mut from_buffer) in to_buffers.iter_mut().zip(from_buffers.into_iter()) {
        // The `SECBUFFER_STREAM` buffer is only used for the data passing during the decryption
        // when the caller doesn't know the exact `SECBUFFER_TOKEN` and `SECBUFFER_DATA` lengths.
        // After the decryption, the pointer and length of the SECBUFFER_STREAM are unchanged.
        // So, we don't need to copy any data and we skip it.
        //
        // The `SECBUFFER_STREAM` usage example: https://learn.microsoft.com/en-us/windows/win32/secauthn/sspi-kerberos-interoperability-with-gssapi
        if from_buffer.buffer_type() == BufferType::Stream {
            continue;
        }

        let from_buffer_len = from_buffer.buf_len();

        to_buffer.buffer_type = from_buffer.owned_security_buffer_type().into();
        to_buffer.cb_buffer = from_buffer_len.try_into()?;

        if from_buffer.buffer_type() != BufferType::Missing {
            // We don't need to copy the actual content of the buffer because [from_buffer] is created
            // from the C-input-buffer and all decryption is performed in-place.
            to_buffer.pv_buffer = from_buffer.take_data().as_mut_ptr().cast();
        }
    }

    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::undocumented_unsafe_blocks,
    reason = "undocumented unsafe is acceptable in tests"
)]
mod tests {
    use std::ptr::null_mut;
    use std::slice::from_raw_parts;

    use libc::c_ulonglong;
    use sspi::credssp::SspiContext;
    use sspi::{EncryptionFlags, Kerberos, SecurityBufferRef, Sspi};

    use crate::sspi::sec_buffer::{SecBuffer, SecBufferDesc};
    use crate::sspi::sec_handle::{SecHandle, SspiHandle};
    use crate::utils::into_raw_ptr;

    fn kerberos_sec_handle(kerberos: Kerberos) -> SecHandle {
        SecHandle {
            dw_lower: {
                let sspi_context = SspiHandle::new(SspiContext::Kerberos(kerberos));
                into_raw_ptr(sspi_context) as c_ulonglong
            },
            dw_upper: into_raw_ptr(sspi::kerberos::PACKAGE_INFO.name.to_string()) as c_ulonglong,
        }
    }

    #[test]
    fn kerberos_stream_buffer_decryption() {
        // This test simulates decryption when the `SECBUFFER_STREAM` buffer is used.
        // The expected behavior is the same as for the original Windows SSPI.
        //
        // MSDN code example: https://learn.microsoft.com/en-us/windows/win32/secauthn/sspi-kerberos-interoperability-with-gssapi
        let plain_message = b"some plain message";

        let kerberos_client = sspi::kerberos::test_data::fake_client();
        let mut kerberos_server = sspi::kerberos::test_data::fake_server();

        let mut token = [0; 1024];
        let mut data = plain_message.to_vec();
        let mut message = vec![
            SecurityBufferRef::token_buf(token.as_mut_slice()),
            SecurityBufferRef::data_buf(data.as_mut_slice()),
        ];

        kerberos_server
            .encrypt_message(EncryptionFlags::empty(), &mut message)
            .unwrap();

        let mut kerberos_client_context = kerberos_sec_handle(kerberos_client);

        let mut stream_buffer_data = message[0].data().to_vec();
        stream_buffer_data.extend_from_slice(message[1].data());
        let stream_buffer_data_len = stream_buffer_data.len().try_into().unwrap();
        let mut buffers = [
            SecBuffer {
                cb_buffer: stream_buffer_data_len,
                buffer_type: 10,
                pv_buffer: stream_buffer_data.as_mut_ptr().cast(),
            },
            SecBuffer {
                cb_buffer: 0,
                buffer_type: 1,
                pv_buffer: null_mut(),
            },
        ];
        let mut message = SecBufferDesc {
            ul_version: 0,
            c_buffers: 2,
            p_buffers: buffers.as_mut_ptr(),
        };

        let status = unsafe { super::DecryptMessage(&mut kerberos_client_context, &mut message, 0, null_mut()) };
        assert_eq!(status, 0);

        let status = unsafe { super::DeleteSecurityContext(&mut kerberos_client_context) };
        assert_eq!(status, 0);

        // Check SECBUFFER_STREAM
        assert_eq!(buffers[0].buffer_type, 10);
        assert_eq!(buffers[0].cb_buffer, stream_buffer_data_len);

        // Check SECBUFFER_DATA
        assert_eq!(buffers[1].buffer_type, 1);
        assert_eq!(buffers[1].cb_buffer, u32::try_from(plain_message.len()).unwrap());
        // Check that the decrypted data is the same as the initial message
        assert_eq!(
            unsafe {
                from_raw_parts(
                    buffers[1].pv_buffer as *const u8,
                    buffers[1].cb_buffer.try_into().unwrap(),
                )
            },
            plain_message
        );
    }

    /// This test simulates initialize security context function call. It's better to run it using Miri
    /// https://github.com/rust-lang/miri
    /// cargo +nightly miri test
    #[test]
    fn kerberos_encryption_decryption() {
        let plain_message = b"some plain message";

        let kerberos_client = sspi::kerberos::test_data::fake_client();
        let kerberos_server = sspi::kerberos::test_data::fake_server();

        let mut kerberos_server_context = kerberos_sec_handle(kerberos_server);

        let mut token = [0_u8; 1024];
        let mut data = plain_message.to_vec();
        let mut buffers = [
            SecBuffer {
                cb_buffer: token.len().try_into().unwrap(),
                buffer_type: 2, // Token
                pv_buffer: token.as_mut_ptr().cast(),
            },
            SecBuffer {
                cb_buffer: data.len().try_into().unwrap(),
                buffer_type: 1, // Data
                pv_buffer: data.as_mut_ptr().cast(),
            },
        ];
        let mut message = SecBufferDesc {
            ul_version: 0,
            c_buffers: 2,
            p_buffers: buffers.as_mut_ptr(),
        };

        let status = unsafe { super::EncryptMessage(&mut kerberos_server_context, 0, &mut message, 0) };
        assert_eq!(status, 0);

        let status = unsafe { super::DeleteSecurityContext(&mut kerberos_server_context) };
        assert_eq!(status, 0);

        let mut kerberos_client_context = kerberos_sec_handle(kerberos_client);

        let mut token =
            unsafe { from_raw_parts(buffers[0].pv_buffer as *const u8, buffers[0].cb_buffer as usize) }.to_vec();
        let mut data =
            unsafe { from_raw_parts(buffers[1].pv_buffer as *const u8, buffers[1].cb_buffer as usize) }.to_vec();
        let mut buffers = [
            SecBuffer {
                cb_buffer: token.len().try_into().unwrap(),
                buffer_type: 2, // Token
                pv_buffer: token.as_mut_ptr().cast(),
            },
            SecBuffer {
                cb_buffer: data.len().try_into().unwrap(),
                buffer_type: 1, // Data
                pv_buffer: data.as_mut_ptr().cast(),
            },
        ];
        let mut message = SecBufferDesc {
            ul_version: 0,
            c_buffers: 2,
            p_buffers: buffers.as_mut_ptr(),
        };

        let status = unsafe { super::DecryptMessage(&mut kerberos_client_context, &mut message, 0, null_mut()) };
        assert_eq!(status, 0);

        let status = unsafe { super::DeleteSecurityContext(&mut kerberos_client_context) };
        assert_eq!(status, 0);

        // Check that the decrypted data is the same as the initial message
        assert_eq!(
            unsafe { from_raw_parts(buffers[1].pv_buffer as *const u8, buffers[1].cb_buffer as usize,) },
            plain_message
        );
    }
}
