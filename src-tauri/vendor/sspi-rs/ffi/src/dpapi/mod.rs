#[macro_use]
mod macros;
mod api;
mod network_client;
mod session_token;

use std::ffi::{CStr, c_void};
use std::slice::{from_raw_parts, from_raw_parts_mut};

use dpapi::rpc::auth::AuthError;
use dpapi::{CryptProtectSecretArgs, CryptUnprotectSecretArgs, Error};
use dpapi_native_transport::NativeTransport;
use dpapi_transport::ProxyOptions;
use ffi_types::common::{Dword, LpByte, LpCByte, LpCStr, LpCUuid, LpDword};
use tokio::runtime::Builder;
use url::Url;
use uuid::Uuid;

use self::api::{n_crypt_protect_secret, n_crypt_unprotect_secret};

// https://learn.microsoft.com/en-us/windows/win32/api/ncryptprotect/nf-ncryptprotect-ncryptprotectsecret#return-value
const ERROR_SUCCESS: u32 = 0;
const NTE_INVALID_PARAMETER: u32 = 0x80090027;
const NTE_INTERNAL_ERROR: u32 = 0x8009002d;
const NTE_NO_MEMORY: u32 = 0x8009000e;
const HRESULT_ERROR_ACCESS_DENIED: u32 = 0x80070005;

/// Type that represents a function for obtaining the session token.
///
/// We need it because we don't know the destination address in advance.
///
/// Parameters:
/// * `LpCUuid` is the session id.
/// * `LpCStr` is the destination of the proxied connection.
/// * `Lpbyte` is the session token buffer. It must be preallocated.
/// * `LpDword` is the session token buffer length.
type GetSessionTokenFn = unsafe extern "system" fn(LpCUuid, LpCStr, LpByte, LpDword) -> u32;

/// Encrypts the secret using the DPAPI.
///
/// This function simulated the `NCryptProtectSecret` function. Encryption requires making RPCs call to the domain.
///
/// Note:
/// - Do not use the IP address for target server hostname.
/// - The `username` can be specified in FQDN (DOMAIN\username) or UPN (username@domain) format.
///
/// # Safety
///
/// Input parameters must meet the following requirements:
///
/// * `secret` must be a non-null, properly-aligned pointer to the secret buffer, valid for reads of `secret_len` bytes.
/// * `sid` must be a non-null pointer to a valid, null-terminated UTF-8 C string representing the SID.
/// * `root_key` must be a valid, properly-aligned pointer to the root key UUID. This parameter is optional and can be NULL.
/// * `server` must be a non-null pointer to a valid, null-terminated UTF-8 C string representing the target server hostname.
/// * `username` must be a non-null pointer to a valid, null-terminated UTF-8 C string representing the username.
/// * `password` must be a non-null pointer to a valid, null-terminated UTF-8 C string representing the user's password.
/// * `computer_name` must be a pointer to a valid, null-terminated UTF-8 C string representing the client's computer name.
///   This parameter can be NULL. If it's NULL, the current computer name will be used.
/// * `proxy_url` must be a valid pointer to a null-terminated UTF-8 C string representing the proxy address.
///   This parameter can be NULL.
/// * `get_session_token_fn` must be safe to call provided parameters are valid.
/// * `blob` must be a non-null, properly-aligned pointer to the output buffer containing DPAPI blob, valid for reads of `blob_len` bytes.
///   The caller is responsible for freeing the memory using the [DpapiFree] function.
/// * `blob_len` must be a non-null, valid pointer to the length of the output `blob` buffer.
///
/// MSDN:
/// * [NCryptProtectSecret function (`ncryptprotect.h`)](https://learn.microsoft.com/en-us/windows/win32/api/ncryptprotect/nf-ncryptprotect-ncryptprotectsecret).
#[instrument(skip_all)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DpapiProtectSecret(
    secret: LpCByte,
    secret_len: Dword,
    sid: LpCStr,
    root_key: LpCUuid,
    server: LpCStr,
    username: LpCStr,
    password: LpCStr,
    computer_name: LpCStr,
    proxy_url: LpCStr,
    get_session_token_fn: Option<GetSessionTokenFn>,
    blob: *mut LpByte,
    blob_len: *mut Dword,
) -> u32 {
    catch_panic! {
        check_null!(secret);
        check_null!(sid);
        check_null!(server);
        check_null!(username);
        check_null!(password);
        check_null!(blob);
        check_null!(blob_len);

        try_execute!(sspi::install_default_crypto_provider_if_necessary().map_err(|_| "failed to initialize default crypto provider"), NTE_INTERNAL_ERROR);

        let secret =
            // SAFETY:
            // - `secret` is non-null and properly-aligned.
            // - The memory region `secret` points to is valid for reads of `secret_len` elements.
            unsafe { from_raw_parts(secret, try_execute!(secret_len.try_into(), NTE_INVALID_PARAMETER)) }.to_owned();
        let sid = try_execute!(
            // SAFETY:
            // - `sid` is guaranteed to be non-null due to the prior check.
            // - The memory region `sid` contains a valid null-terminator at the end of string.
            // - The memory region `sid` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(sid.cast()) }.to_str(),
            NTE_INVALID_PARAMETER
        )
        .to_owned();
        let root_key_id = if !root_key.is_null() {
            // SAFETY: `root_key` is guaranteed to be non-null due to the prior check.
            let id = unsafe { *root_key };
            let root_key = Uuid::from_fields(id.data1, id.data2, id.data3, &id.data4);

            Some(root_key)
        } else {
            None
        };
        let server = try_execute!(
            // SAFETY:
            // - `server` is guaranteed to be non-null due to the prior check.
            // - The memory region `server` contains a valid null-terminator at the end of string.
            // - The memory region `server` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(server.cast()) }.to_str(),
            NTE_INVALID_PARAMETER
        );
        let username = try_execute!(
            // SAFETY:
            // - `username` is guaranteed to be non-null due to the prior check.
            // - The memory region `username` contains a valid null-terminator at the end of string.
            // - The memory region `username` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(username.cast()) }.to_str(),
            NTE_INVALID_PARAMETER
        );
        let password = try_execute!(
            // SAFETY:
            // - `password` is guaranteed to be non-null due to the prior check.
            // - The memory region `password` contains a valid null-terminator at the end of string.
            // - The memory region `password` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(password.cast()) }.to_str(),
            NTE_INVALID_PARAMETER
        )
        .to_owned();
        let client_computer_name = if !computer_name.is_null() {
            Some(
                try_execute!(
                    // SAFETY:
                    // - `computer_name` is guaranteed to be non-null due to the prior check.
                    // - The memory region `computer_name` contains a valid null-terminator at the end of string.
                    // - The memory region `computer_name` points to is valid for reads of bytes up to and including null-terminator.
                    unsafe { CStr::from_ptr(computer_name.cast()) }.to_str(),
                    NTE_INVALID_PARAMETER
                )
                .to_owned(),
            )
        } else {
            None
        };

        let proxy = if let (false, Some(get_session_token_fn)) = (proxy_url.is_null(), get_session_token_fn) {
            info!("Proxy parameters are not empty. Proceeding with tunnelled connection.");

            let proxy_url = try_execute!(
                // SAFETY:
                // - `proxy_url` is guaranteed to be non-null due to the prior check.
                // - The memory region `proxy_url` contains a valid null-terminator at the end of string.
                // - The memory region `proxy_url` points to is valid for reads of bytes up to and including null-terminator.
                unsafe { CStr::from_ptr(proxy_url.cast()) }.to_str(),
                NTE_INVALID_PARAMETER
            );

            Some(ProxyOptions {
                proxy: try_execute!(Url::parse(proxy_url), NTE_INVALID_PARAMETER),
                // SAFETY: The C function pointer is safe to call.
                get_session_token: unsafe {
                    session_token::session_token_fn(get_session_token_fn)
                },
            })
        } else {
            info!("Proxy parameters are empty. Proceeding with direct connection.");

            None
        };
        let mut network_client = network_client::SyncNetworkClient;

        let runtime  = try_execute!(Builder::new_current_thread().enable_all().build(), NTE_INTERNAL_ERROR);
        let blob_data = try_execute!(
            runtime.block_on(n_crypt_protect_secret::<NativeTransport>(
                CryptProtectSecretArgs {
                    data: secret.into(),
                    sid,
                    root_key_id,
                    server,
                    proxy,
                    username,
                    password: password.into(),
                    client_computer_name,
                    network_client: &mut network_client,
                    kerberos_config: None,
                }
            )),
            NTE_INTERNAL_ERROR
        );

        if blob_data.is_empty() {
            error!("Output DPAPI blob is empty");
            return NTE_INTERNAL_ERROR;
        }

        // SAFETY: Memory allocation is safe.
        let blob_buf = unsafe { libc::malloc(blob_data.len()) as *mut u8 };
        if blob_buf.is_null() {
            error!("Failed to allocate memory for the output DPAPI blob: blob buf pointer is NULL");
            return NTE_NO_MEMORY;
        }

        // SAFETY:
        // - `blob_buf` is guaranteed to be non-null due to the prior check.
        // - `blob_buf` points to allocated, properly aligned, not-empty bytes range.
        let buf = unsafe { from_raw_parts_mut(blob_buf, blob_data.len()) };
        buf.copy_from_slice(blob_data.as_ref());

        // SAFETY: `blob` is guaranteed to be non-null due to the prior check.
        unsafe {
            *blob = blob_buf;
        }

        // SAFETY: `blob_len` is guaranteed to be non-null due to the prior check.
        unsafe {
            *blob_len = try_execute!(blob_data.len().try_into(), NTE_INTERNAL_ERROR);
        }

        ERROR_SUCCESS
    }
}

/// Decrypt the DPAPI blob.
///
/// This function simulated the `NCryptUnprotectSecret` function. Decryption requires making RPC calls to the domain.
///
/// Note:
/// - Do not use the IP address for target server hostname.
/// - The `username` can be specified in FQDN (DOMAIN\username) or UPN (username@domain) format.
///
/// # Safety
///
/// Input parameters must meet the following requirements:
///
/// * `blob` must be a non-null, properly-aligned pointer to the DPAPI blob buffer, valid for reads of `blob_len` bytes.
/// * `server` must be a non-null pointer to a valid, null-terminated UTF-8 C string representing the target server hostname.
/// * `username` must be a non-null pointer to a valid, null-terminated UTF-8 C string representing the username.
/// * `password` must be a non-null pointer to a valid, null-terminated UTF-8 C string representing the user's password.
/// * `computer_name` must be a pointer to a valid, null-terminated UTF-8 C string representing the client's computer name.
///   This parameter can be NULL. If it's NULL, the current computer name will be used.
/// * `proxy_url` must be a valid pointer to a null-terminated UTF-8 C string representing the proxy address.
///   This parameter can be NULL.
/// * `get_session_token_fn` must be safe to call provided parameters are valid.
/// * `secret` must be a non-null, properly-aligned pointer to the output buffer containing decrypted secret, valid for reads of `secret_len` bytes.
///   The caller is responsible for freeing the memory using the [DpapiFree] function.
/// * `secret_len` must be a non-null, valid pointer to the length of the output `secret` buffer.
///
/// MSDN:
/// * [NCryptUnprotectSecret function (ncryptprotect.h)](https://learn.microsoft.com/en-us/windows/win32/api/ncryptprotect/nf-ncryptprotect-ncryptunprotectsecret).
///
/// These error codes an be returned, in addition to the MS ones:
/// * 0x80090340 SEC_E_KDC_INVALID_REQUEST: Kerberos authentication failed
/// * 0x80070005: Access to the decryption key was denied
#[instrument(skip_all)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DpapiUnprotectSecret(
    blob: LpCByte,
    blob_len: Dword,
    server: LpCStr,
    username: LpCStr,
    password: LpCStr,
    computer_name: LpCStr,
    proxy_url: LpCStr,
    get_session_token_fn: Option<GetSessionTokenFn>,
    secret: *mut LpByte,
    secret_len: *mut Dword,
) -> u32 {
    catch_panic! {
        check_null!(blob);
        check_null!(server);
        check_null!(username);
        check_null!(password);
        check_null!(secret);
        check_null!(secret_len);

        try_execute!(sspi::install_default_crypto_provider_if_necessary().map_err(|_| "failed to initialize default crypto provider"), NTE_INTERNAL_ERROR);

        // SAFETY:
        // - `blob` is non-null and properly-aligned.
        // - The memory region `blob` points to is valid for reads of `blob_len` elements.
        let blob = unsafe { from_raw_parts(blob, try_execute!(blob_len.try_into(), NTE_INVALID_PARAMETER)) };
        let server = try_execute!(
            // SAFETY:
            // - `server` is guaranteed to be non-null due to the prior check.
            // - The memory region `server` contains a valid null-terminator at the end of string.
            // - The memory region `server` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(server.cast()) }.to_str(),
            NTE_INVALID_PARAMETER
        );
        let username = try_execute!(
            // SAFETY:
            // - `username` is guaranteed to be non-null due to the prior check.
            // - The memory region `username` contains a valid null-terminator at the end of string.
            // - The memory region `username` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(username.cast()) }.to_str(),
            NTE_INVALID_PARAMETER
        );
        let password = try_execute!(
            // SAFETY:
            // - `password` is guaranteed to be non-null due to the prior check.
            // - The memory region `password` contains a valid null-terminator at the end of string.
            // - The memory region `password` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(password.cast()) }.to_str(),
            NTE_INVALID_PARAMETER
        )
        .to_owned();
        let client_computer_name = if !computer_name.is_null() {
            Some(
                try_execute!(
                    // SAFETY:
                    // - `computer_name` is guaranteed to be non-null due to the prior check.
                    // - The memory region `computer_name` contains a valid null-terminator at the end of string.
                    // - The memory region `computer_name` points to is valid for reads of bytes up to and including null-terminator.
                    unsafe { CStr::from_ptr(computer_name.cast()) }.to_str(),
                    NTE_INVALID_PARAMETER
                )
                .to_owned(),
            )
        } else {
            None
        };

        let proxy = if let (false, Some(get_session_token_fn)) = (proxy_url.is_null(), get_session_token_fn) {
            info!("Proxy parameters are not empty. Proceeding  with tunnelled connection.");

            let proxy_url = try_execute!(
                // SAFETY:
                // - `proxy_url` is guaranteed to be non-null due to the prior check.
                // - The memory region `proxy_url` contains a valid null-terminator at the end of string.
                // - The memory region `proxy_url` points to is valid for reads of bytes up to and including null-terminator.
                unsafe { CStr::from_ptr(proxy_url.cast()) }.to_str(),
                NTE_INVALID_PARAMETER
            );

            Some(ProxyOptions {
                proxy: try_execute!(Url::parse(proxy_url), NTE_INVALID_PARAMETER),
                // SAFETY: The C function pointer is safe to call.
                get_session_token: unsafe {
                    session_token::session_token_fn(get_session_token_fn)
                },
            })
        } else {
            info!("Proxy parameters are empty. Proceeding  with direct connection.");

            None
        };
        let mut network_client = network_client::SyncNetworkClient;

        let runtime  = try_execute!(Builder::new_current_thread().enable_all().build(), NTE_INTERNAL_ERROR);
        let secret_data_result = runtime.block_on(n_crypt_unprotect_secret::<NativeTransport>(
                CryptUnprotectSecretArgs {
                    blob,
                    server,
                    proxy,
                    username,
                    password: password.into(),
                    client_computer_name,
                    kerberos_config: None,
                    network_client: &mut network_client
                }));

        let secret_data = match secret_data_result {
            Ok(secret_data) => secret_data,
            Err(Error::Auth(AuthError::Sspi(sspi_error))) => { return sspi_error.error_type as u32 },
            Err(Error::Gkdi(dpapi::gkdi::GkdiError::BadHresult(hresult))) => { return hresult },
            Err(Error::Gkdi(dpapi::gkdi::GkdiError::IsNotAuthorized)) => { return HRESULT_ERROR_ACCESS_DENIED },
            Err(err) => {
                error!(%err, "an error occurred");
                return NTE_INTERNAL_ERROR
            }
        };

        if secret_data.as_ref().is_empty() {
            error!("Decrypted secret is empty.");
            return NTE_INTERNAL_ERROR;
        }

        // SAFETY: Memory allocation is safe.
        let secret_buf = unsafe { libc::malloc(secret_data.as_ref().len()) as *mut u8 };
        if secret_buf.is_null() {
            error!("Failed to allocate memory for the output DPAPI blob: blob buf pointer is NULL.");
            return NTE_NO_MEMORY;
        }

        // SAFETY:
        // - `secret_buf` is guaranteed to be non-null due to the prior check.
        // - `secret_buf` points to allocated, properly aligned, not-empty bytes range.
        let buf = unsafe { from_raw_parts_mut(secret_buf, secret_data.as_ref().len()) };
        buf.copy_from_slice(secret_data.as_ref());

        // SAFETY: `secret` is guaranteed to be non-null due to the prior check.
        unsafe {
            *secret = secret_buf;
        }

        // SAFETY: `secret_len` is guaranteed to be non-null due to the prior check.
        unsafe {
            *secret_len = try_execute!(secret_data.as_ref().len().try_into(), NTE_INTERNAL_ERROR);
        }

        ERROR_SUCCESS
    }
}

/// Frees the memory allocated by [DpapiProtectSecret] and [DpapiUnprotectSecret] functions.
///
/// # Safety
///
/// The `data` parameter must be a non-null, valid pointer to the memory allocated by the [DpapiProtectSecret] or
/// [DpapiUnprotectSecret] functions.
#[instrument(skip_all)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DpapiFree(buf: LpCByte) -> u32 {
    catch_panic! {
        check_null!(buf);

        // SAFETY: `buf` is allocated by the `DpapiProtectSecret` or `DpapiUnprotectSecret` functions.
        unsafe {
            libc::free(buf.cast::<c_void>().cast_mut());
        }

        ERROR_SUCCESS
    }
}

#[cfg(test)]
#[expect(
    clippy::undocumented_unsafe_blocks,
    reason = "undocumented unsafe is acceptable in tests"
)]
mod tests {
    //! This tests simulate `DpapiProtectSecret`, `DpapiUnprotectSecret`, and `DpapiFree` function calls.
    //! It's better to run them using Miri: https://github.com/rust-lang/miri.
    //! cargo +nightly miri test
    //!
    //! Note: this tests aim to check only the FFI functions implementation.
    //! Checking the correctness of DPAPI functions is not a goal of these tests.

    use std::ptr::{null, null_mut};

    use super::*;

    #[test]
    fn test_dpapi_protect_secret() {
        let secret = b"secret-to-encrypt";
        let secret_len = secret.len() as u32;
        let sid = "S-1-5-21-1485435871-894665558-560847465-1104\0";
        let server = "win-956cqossjtf.tbt.com\0";
        let username = "t2@tbt.com\0";
        let password = "qqqQQQ111!!!\0";
        let mut blob: LpByte = null_mut();
        let mut blob_len = 0;

        let result = unsafe {
            DpapiProtectSecret(
                secret.as_ptr(),
                secret_len,
                sid.as_ptr(),
                null(),
                server.as_ptr(),
                username.as_ptr(),
                password.as_ptr(),
                null(),
                null(),
                None,
                &mut blob,
                &mut blob_len,
            )
        };

        assert_eq!(result, ERROR_SUCCESS);
        assert!(!blob.is_null());
        assert!(blob_len > 0);

        let mut decrypted_secret: LpByte = null_mut();
        let mut secret_len = 0;

        let result = unsafe {
            DpapiUnprotectSecret(
                blob,
                blob_len,
                server.as_ptr(),
                username.as_ptr(),
                password.as_ptr(),
                null(),
                null(),
                None,
                &mut decrypted_secret,
                &mut secret_len,
            )
        };

        assert_eq!(result, ERROR_SUCCESS);
        assert!(!decrypted_secret.is_null());
        assert!(secret_len > 0);

        unsafe { DpapiFree(blob) };
        unsafe { DpapiFree(decrypted_secret) };
    }

    #[test]
    fn test_dpapi_protect_secret_proxied() {
        let secret = b"secret-to-encrypt";
        let secret_len = secret.len() as u32;
        let sid = "S-1-5-21-1485435871-894665558-560847465-1104\0";
        let server = "win-956cqossjtf.tbt.com\0";
        let username = "t2@tbt.com\0";
        let password = "qqqQQQ111!!!\0";
        let proxy_url = "ws://dg.tbt.com:7171/\0";
        let mut blob: LpByte = null_mut();
        let mut blob_len = 0;

        let result = unsafe {
            DpapiProtectSecret(
                secret.as_ptr(),
                secret_len,
                sid.as_ptr(),
                null(),
                server.as_ptr(),
                username.as_ptr(),
                password.as_ptr(),
                null(),
                proxy_url.as_ptr(),
                Some(api::get_session_token),
                &mut blob,
                &mut blob_len,
            )
        };

        assert_eq!(result, ERROR_SUCCESS);
        assert!(!blob.is_null());
        assert!(blob_len > 0);

        let mut decrypted_secret: LpByte = null_mut();
        let mut secret_len = 0;

        let result = unsafe {
            DpapiUnprotectSecret(
                blob,
                blob_len,
                server.as_ptr(),
                username.as_ptr(),
                password.as_ptr(),
                null(),
                proxy_url.as_ptr(),
                Some(api::get_session_token),
                &mut decrypted_secret,
                &mut secret_len,
            )
        };

        assert_eq!(result, ERROR_SUCCESS);
        assert!(!decrypted_secret.is_null());
        assert!(secret_len > 0);

        unsafe { DpapiFree(blob) };
        unsafe { DpapiFree(decrypted_secret) };
    }
}
