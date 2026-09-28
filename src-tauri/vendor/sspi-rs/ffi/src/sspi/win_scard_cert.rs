#![cfg(all(feature = "scard", target_os = "windows"))]
//! A collection of functions for working with certificates on Windows.
//! The main purpose of them is to provide an easy way of collecting needed
//! smart card certificate information during scard-based logon.
//!
//! This module is available only on Windows and only when the `scard` feature
//! is on.

use std::slice::from_raw_parts;

use picky_asn1_x509::Certificate;
use sha1::{Digest, Sha1};
use sspi::{Error, ErrorKind, Result};
use windows::Win32::Security::Cryptography::{
    AT_KEYEXCHANGE, CERT_OPEN_STORE_FLAGS, CERT_QUERY_ENCODING_TYPE, CERT_STORE_PROV_SYSTEM_W,
    CERT_SYSTEM_STORE_CURRENT_USER_ID, CERT_SYSTEM_STORE_LOCATION_SHIFT, CRYPT_FIRST, CRYPT_NEXT, CRYPT_SILENT,
    CertCloseStore, CertEnumCertificatesInStore, CertFreeCertificateContext, CertOpenStore, CryptAcquireContextW,
    CryptDestroyKey, CryptGetKeyParam, CryptGetProvParam, CryptGetUserKey, CryptReleaseContext, HCERTSTORE,
    KP_CERTIFICATE, PP_ENUMCONTAINERS, PP_SMARTCARD_READER, PROV_RSA_FULL,
};
use windows::core::PWSTR;

const CSP_NAME: &str = "Microsoft Base Smart Card Crypto Provider";

// https://learn.microsoft.com/en-us/windows/win32/seccrypto/hcryptprov
pub type HCRYPTPROV = usize; // ULONG_PTR
// https://learn.microsoft.com/en-us/windows/win32/seccrypto/hcryptkey
pub type HCRYPTKEY = usize; // ULONG_PTR

/// Finds a certificate in the given certificate store by thumbprint.
///
/// # SAFETY
///
/// * `cert_store` must be a valid cert store handle obtained using the `CertOpenStore` function.
#[instrument(level = "trace", ret)]
unsafe fn find_raw_cert_by_thumbprint(thumbprint: &[u8], cert_store: HCERTSTORE) -> Result<Vec<u8>> {
    // SAFETY: `cert_store` must be valid certificate (upheld by the caller).
    let certificate = unsafe { CertEnumCertificatesInStore(cert_store, None) };

    // SAFETY: `certificate` is either null or convertible to a reference to `CERT_CONTEXT`
    let mut certificate = unsafe { certificate.as_ref() };

    while let Some(curr_certificate) = certificate {
        let cert_der = {
            // SAFETY: `certificate` is a valid certificate handle obtained from the Windows certificate store.
            unsafe { from_raw_parts(curr_certificate.pbCertEncoded, curr_certificate.cbCertEncoded as usize) }
        };
        let mut sha1 = Sha1::new();
        sha1.update(cert_der);
        let cert_thumbprint = sha1.finalize().to_vec();

        if cert_thumbprint == thumbprint {
            // SAFETY: `certificate` is a valid certificate handle obtained from the Windows certificate store.
            let _ = unsafe { CertFreeCertificateContext(Some(curr_certificate)) };

            return Ok(cert_der.to_vec());
        }

        // SAFETY:
        // - `certificate` is a valid certificate handle obtained from the Windows certificate store.
        // - `cert_store` must be valid certificate (upheld by the caller).
        let next_certificate = unsafe { CertEnumCertificatesInStore(cert_store, Some(curr_certificate)) };

        // SAFETY: `certificate` is either null or convertible to a reference to `CERT_CONTEXT`
        certificate = unsafe { next_certificate.as_ref() };
    }

    Err(Error::new(
        ErrorKind::InternalError,
        "the requested device certificate does not present in the certificate store",
    ))
}

/// Opens a user certificate store.
fn open_user_cert_store() -> Result<HCERTSTORE> {
    // "My\0" encoded as a wide string.
    // More info: https://docs.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certopenstore#remarks
    let my: [u16; 3] = [77, 121, 0];
    // SAFETY:
    // * constant parameters are taken from the `windows_sys` crate. Thus, they are valid;
    // * `dwEncodingType` and `hCryptProv` are allowed to be zero by documentation;
    // * `my` is as valid wide C string.
    unsafe {
        // https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certopenstore
        CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W,
            // This parameter is only applicable when the CERT_STORE_PROV_MSG, CERT_STORE_PROV_PKCS7, or
            // CERT_STORE_PROV_FILENAME provider type is specified in the lpszStoreProvider parameter.
            // For all other provider types, this parameter is unused and should be set to zero.
            CERT_QUERY_ENCODING_TYPE(0),
            // This parameter is not used and should be set to NULL.
            None,
            CERT_OPEN_STORE_FLAGS(CERT_SYSTEM_STORE_CURRENT_USER_ID << CERT_SYSTEM_STORE_LOCATION_SHIFT),
            Some(my.as_ptr().cast()),
        )
    }
    .map_err(|err| Error::new(ErrorKind::NoCredentials, format!("failed to open cert store: {err:?}")))
}

/// Extract raw (encoded) certificate from the certificate store by thumbprint.
#[instrument(level = "trace", ret)]
fn extract_raw_certificate_by_thumbprint(thumbprint: &[u8]) -> Result<Vec<u8>> {
    let cert_store = open_user_cert_store()?;
    // SAFETY: `open_user_cert_store` returns valid store handle.
    let cert = unsafe { find_raw_cert_by_thumbprint(thumbprint, cert_store) }.inspect_err(|_err| {
        // SAFETY: `open_user_cert_store` returns valid store handle that needs to be closed.
        if let Err(err) = unsafe { CertCloseStore(Some(cert_store), 0) } {
            warn!(?err, "could not close the certificate store");
        }
    })?;

    // SAFETY: `open_user_cert_store` returns valid store handle that needs to be closed.
    if let Err(err) = unsafe { CertCloseStore(Some(cert_store), 0) } {
        error!(?err, "could not close the certificate store");
    }

    Ok(cert)
}

/// Extracts the certificate from the Windows certificate store by its thumbprint.
#[instrument(level = "trace", ret)]
pub fn extract_certificate_by_thumbprint(thumbprint: &[u8]) -> Result<(Vec<u8>, Certificate)> {
    let raw_cert = extract_raw_certificate_by_thumbprint(thumbprint)?;

    Ok((raw_cert.to_vec(), picky_asn1_der::from_bytes(&raw_cert)?))
}

#[instrument(level = "trace", ret)]
fn acquire_key_container_context(key_container_name: &str) -> Result<HCRYPTPROV> {
    let mut container_name = key_container_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut csp_name = CSP_NAME.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut crypt_context_handle = HCRYPTPROV::default();

    // SAFETY:
    // - `crypt_context_handle`, `container_name`, and `csp_name` are local defined variables.
    // - Both `container_name` and `csp_name` are NULL terminated.
    if let Err(err) = unsafe {
        CryptAcquireContextW(
            &mut crypt_context_handle,
            PWSTR(container_name.as_mut_ptr()),
            PWSTR(csp_name.as_mut_ptr()),
            PROV_RSA_FULL,
            CRYPT_SILENT,
        )
    } {
        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed acquire crypt context handle: {err:?}"),
        ));
    }

    Ok(crypt_context_handle)
}

/// Returns a reader name of the opened context handle.
///
/// # SAFETY
///
/// - `crypt_context_handle` must be valid context obtained using the `CryptAcquireContextW` function.
#[instrument(level = "trace", ret)]
unsafe fn get_reader_name(crypt_context_handle: HCRYPTPROV) -> Result<String> {
    let mut reader_buf_len = 0;
    // SAFETY:
    // - `crypt_context_handle` is valid context handle (upheld by the caller).
    // - `reader_buff_len` is a local variable.
    if let Err(err) = unsafe {
        CryptGetProvParam(
            crypt_context_handle,
            PP_SMARTCARD_READER.0,
            None,
            &mut reader_buf_len,
            0,
        )
    } {
        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed to get reader name length: {err:?}"),
        ));
    }

    let mut reader_buf = vec![0; reader_buf_len as usize];
    // SAFETY:
    // - `crypt_context_handle` is valid context handle (upheld by the caller).
    // - `reader_buff_len` is a local variable.
    // - `reader_buf` is a locally allocated buffer sufficient length (length was obtained using the `CryptGetProvParam` call above).
    if let Err(err) = unsafe {
        CryptGetProvParam(
            crypt_context_handle,
            PP_SMARTCARD_READER.0,
            Some(reader_buf.as_mut_ptr()),
            &mut reader_buf_len,
            0,
        )
    } {
        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed to get reader name: {err:?}"),
        ));
    }

    // Remove NULL byte.
    reader_buf.pop();

    String::from_utf8(reader_buf)
        .map_err(|_| Error::new(ErrorKind::InternalError, "reader name is not valid UTF-8 text"))
}

/// Returns a certificate of the opened context handle.
///
/// # SAFETY
///
/// - `crypt_context_handle` must be valid context obtained using the `CryptAcquireContextW` function.
#[instrument(level = "trace", ret)]
unsafe fn get_key_container_certificate(crypt_context_handle: HCRYPTPROV) -> Result<Certificate> {
    let mut key = HCRYPTKEY::default();

    // SAFETY:
    // - `crypt_context_handle` must be valid context handle (upheld by the caller).
    if let Err(err) = unsafe { CryptGetUserKey(crypt_context_handle, AT_KEYEXCHANGE.0, &mut key) } {
        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed to acquire key handle: {err:?}"),
        ));
    }

    let mut cert_data_len = 0;
    // SAFETY: `key` is a valid key handle obtained via successful `CryptGetUserKey` call above.
    if let Err(err) = unsafe { CryptGetKeyParam(key, KP_CERTIFICATE, None, &mut cert_data_len, 0) } {
        // SAFETY: `key` is a valid key handle obtained via successful `CryptGetUserKey` call above.
        if let Err(err) = unsafe { CryptDestroyKey(key) } {
            warn!(?err, "Failed to destroy key handle");
        }

        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed to get certificate data len: {err:?}"),
        ));
    }

    let mut cert_data = vec![0; cert_data_len as usize];
    if let Err(err) =
        // SAFETY:
        // - `key` is a valid key handle obtained via successful `CryptGetUserKey` call above.
        // - `cert_data` is a locally allocated buffer sufficient length (length was obtained using the `CryptGetKeyParam` call above).
        unsafe { CryptGetKeyParam(key, KP_CERTIFICATE, Some(cert_data.as_mut_ptr()), &mut cert_data_len, 0) }
    {
        // SAFETY: `key` is a valid key handle obtained via successful `CryptGetUserKey` call above.
        if let Err(err) = unsafe { CryptDestroyKey(key) } {
            warn!(?err, "Failed to destroy key handle");
        }

        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed to get certificate data: {err:?}"),
        ));
    }

    // SAFETY: `key` is a valid key handle obtained via successful `CryptGetUserKey` call above.
    if let Err(err) = unsafe { CryptDestroyKey(key) } {
        warn!(?err, "Failed to destroy key handle");
    }

    Ok(picky_asn1_der::from_bytes(&cert_data)?)
}

/// Smart card information.
#[derive(Debug)]
pub struct SmartCardInfo {
    /// Key container name of the selected certificate.
    pub key_container_name: String,
    /// Smart card reader name.
    pub reader_name: String,
    /// CSP name.
    pub csp_name: String,
    /// Parsed smart card certificate.
    pub certificate: Certificate,
}

/// Gathers the smart card information like reader name, key container name,
/// and so on using the provided certificate serial number.
///
/// It iterates over existing key containers and tries to find a suitable reader name and key container.
/// The similar approach is implemented in the FreeRDP for the smart card information gathering:
/// https://github.com/FreeRDP/FreeRDP/blob/56324906a2d5b2538675e2f10b9f1ffe4a27de79/libfreerdp/core/smartcardlogon.c#L616
#[instrument(level = "trace", ret)]
pub fn finalize_smart_card_info(cert_serial_number: &[u8]) -> Result<SmartCardInfo> {
    let mut crypt_context_handle = HCRYPTPROV::default();

    // Empty container name.
    let mut container_name = vec![0];
    let mut csp_name = CSP_NAME.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();

    // SAFETY:
    // - `crypt_context_handle`, `container_name`, and `csp_name` are local defined variables.
    // - Both `container_name` and `csp_name` are NULL terminated.
    if let Err(err) = unsafe {
        CryptAcquireContextW(
            &mut crypt_context_handle,
            PWSTR(container_name.as_mut_ptr()),
            PWSTR(csp_name.as_mut_ptr()),
            PROV_RSA_FULL,
            CRYPT_SILENT,
        )
    } {
        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed acquire crypt context handle: {err:?}"),
        ));
    }

    let mut key_container_name_len = 0;
    let mut is_first = true;
    loop {
        // SAFETY:
        // - `crypt_context_handle` is obtained from the successful `CryptAcquireContextW` function call.
        // - `key_container_name_len` is a local variable.
        if let Err(_err) = unsafe {
            CryptGetProvParam(
                crypt_context_handle,
                PP_ENUMCONTAINERS,
                None,
                &mut key_container_name_len,
                if is_first { CRYPT_FIRST } else { CRYPT_NEXT },
            )
        } {
            break;
        }

        let mut key_container_name = vec![0; key_container_name_len as usize];

        // SAFETY:
        // - `crypt_context_handle` is obtained from the successful `CryptAcquireContextW` function call.
        // - `key_container_name` is a locally allocated buffer sufficient length (length was obtained using the `CryptGetProvParam` call above).
        // - `key_container_name_len` is a local variable.
        if let Err(_err) = unsafe {
            CryptGetProvParam(
                crypt_context_handle,
                PP_ENUMCONTAINERS,
                Some(key_container_name.as_mut_ptr()),
                &mut key_container_name_len,
                if is_first { CRYPT_FIRST } else { CRYPT_NEXT },
            )
        } {
            break;
        }
        let mut key_container_name = String::from_utf8(key_container_name).unwrap();
        // remove null char
        key_container_name.pop();

        let context = if let Ok(context) = acquire_key_container_context(&key_container_name) {
            context
        } else {
            continue;
        };

        // SAFETY: `context` is obtained from the successful `acquire_key_container_context` function call.
        if let Ok(certificate) = unsafe { get_key_container_certificate(context) }
            && certificate.tbs_certificate.serial_number.0 == cert_serial_number
        {
            // SAFETY: `crypt_context_handle` is obtained from the successful `CryptAcquireContextW` function call.
            let reader_name = unsafe { get_reader_name(crypt_context_handle) };

            // SAFETY:
            // - The `crypt_context_handle` was obtained using successful `CryptAcquireContextW` function call.
            // - `dwFlags` parameter is reserved for future use and must be zero.
            if let Err(err) = unsafe { CryptReleaseContext(crypt_context_handle, 0) } {
                return Err(Error::new(
                    ErrorKind::InternalError,
                    format!("failed to release the crypto context: {err:?}"),
                ));
            }

            let reader_name = match reader_name {
                Ok(reader_name) => reader_name,
                Err(err) => {
                    error!(?err);
                    continue;
                }
            };

            return Ok(SmartCardInfo {
                key_container_name,
                reader_name,
                certificate,
                csp_name: CSP_NAME.to_owned(),
            });
        }

        is_first = false;
    }

    // SAFETY:
    // - The `crypt_context_handle` was obtained using successful `CryptAcquireContextW` function call.
    // - `dwFlags` parameter is reserved for future use and must be zero.
    if let Err(err) = unsafe { CryptReleaseContext(crypt_context_handle, 0) } {
        return Err(Error::new(
            ErrorKind::InternalError,
            format!("failed to release the crypto context: {err:?}"),
        ));
    }

    Err(Error::new(ErrorKind::InternalError, "Cannot get smart card info"))
}
