#![cfg(feature = "scard")]
//! A collection of functions for working with certificates on Linux and macOS.
//! The main purpose of them is to provide an easy way of collecting needed
//! smart card certificate information during scard-based logon.
//!
//! This module is available only on when the `scard` feature
//! is on.

use std::borrow::Cow;
use std::env;
use std::path::Path;

use cryptoki::context::{CInitializeArgs, Pkcs11};
use cryptoki::object::{Attribute, AttributeType, CertificateType, ObjectClass};
use picky_asn1::wrapper::Utf8StringAsn1;
use picky_asn1_x509::{Certificate, ExtendedKeyUsage, ExtensionView, GeneralName, oids};
use sspi::{Error, ErrorKind, Result, Utf16String, Utf16StringExt};
use winscard::MICROSOFT_DEFAULT_CSP;

use crate::winscard::piv::try_get_piv_container_name;

/// Environment variable that specifies a custom CSP name.
///
/// If not set, the default CSP name will be used: [MICROSOFT_DEFAULT_CSP].
const CSP_NAME_VAR: &str = "SSPI_CSP_NAME";

/// System smart card information.
///
/// Contains smart card certificate, reader name, container name, and other fields.
#[derive(Debug)]
pub struct SystemSmartCardInfo {
    /// UTF-16 LE encoded reader name.
    ///
    /// Reader name is the selected slot description.
    pub reader_name: Vec<u8>,
    /// UTF-16 LE encoded smart card CSP name.
    pub csp_name: Vec<u8>,
    /// Certificate.
    pub certificate: Vec<u8>,
    /// UTF-16 LE encoded smart card key container name.
    pub container_name: Option<Vec<u8>>,
    /// UTF-16 LE encoded smart card name.
    pub card_name: Option<Vec<u8>>,
}

/// Collects system-provided smart card information.
///
/// The username must be in FQDN (user@domain) format and UTF-16 LE encoded.
#[instrument(level = "trace", ret)]
pub fn smart_card_info(username: &[u8], pkcs11_module: &Path) -> Result<SystemSmartCardInfo> {
    use cryptoki::context::CInitializeFlags;

    let pkcs11 = Pkcs11::new(pkcs11_module)?;
    pkcs11.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK))?;

    let username = Utf16String::from_bytes_le(username)?.to_string();

    for slot in pkcs11.get_slots_with_token()? {
        let session = pkcs11.open_ro_session(slot)?;

        let slot_info = pkcs11.get_slot_info(slot)?;
        let reader_name = slot_info.slot_description();

        // The first suitable user certificate on smart card.
        let mut certificate = None;

        let query = [
            Attribute::Class(ObjectClass::CERTIFICATE),
            Attribute::CertificateType(CertificateType::X_509),
        ];
        'certificates: for certificate_handle in session.find_objects(&query)? {
            for encoded_certificate in session.get_attributes(certificate_handle, &[AttributeType::Value])? {
                let Attribute::Value(encoded_certificate) = encoded_certificate else {
                    continue;
                };

                if validate_certificate(&encoded_certificate, &username).is_err() {
                    continue;
                }

                certificate = Some((encoded_certificate, certificate_handle));

                break 'certificates;
            }
        }

        let Some((certificate, certificate_handle)) = certificate else {
            continue;
        };

        let mut container_name = None;
        // We found a suitable certificate for smart card logon on the device.
        // Next, we check if the inserted device is a PIV smart card. If so, we will attempt
        // to extract the container name using raw APDU commands.
        for label in session.get_attributes(certificate_handle, &[AttributeType::Label])? {
            let Attribute::Label(label) = label else {
                continue;
            };

            container_name = try_get_piv_container_name(reader_name, &label)
                .as_deref()
                .map(|name| Utf16String::from_str(name).to_bytes_le())
                .ok();

            if container_name.is_some() {
                break;
            }
        }

        let reader_name = Utf16String::from_str(reader_name).to_bytes_le();

        let csp_name = if let Ok(csp) = env::var(CSP_NAME_VAR) {
            Cow::Owned(csp)
        } else {
            Cow::Borrowed(MICROSOFT_DEFAULT_CSP)
        };
        let csp_name = Utf16String::from_str(&csp_name).to_bytes_le();

        let token_info = pkcs11.get_token_info(slot)?;
        let card_name = Some(Utf16String::from_str(token_info.label()).to_bytes_le());

        return Ok(SystemSmartCardInfo {
            reader_name,
            csp_name,
            certificate,
            container_name,
            card_name,
        });
    }

    Err(Error::new(
        ErrorKind::NoCredentials,
        "smart card does not contain suitable credentials",
    ))
}

/// Validates smart card certificate.
///
/// Certificate requirements:
/// * Subject Alternative name must present and be equal to provided username.
/// * Extended Key Usage extension must present and contain Client Authentication (1.3.6.1.5.5.7.3.2) and Smart Card Logon (1.3.6.1.4.1.311.20.2.2) OIDs.
fn validate_certificate(certificate: &[u8], username: &str) -> Result<()> {
    let certificate: Certificate = picky_asn1_der::from_bytes(certificate)?;
    let certificate_username = extract_upn_from_certificate(&certificate)?;

    if !certificate_username.eq_ignore_ascii_case(username) {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            format!(
                "logon username ({username}) and smart card certificate username ({certificate_username}) do not match"
            ),
        ));
    }

    let extended_key_usage = extract_extended_key_usage_from_certificate(&certificate)?;

    if !extended_key_usage.contains(oids::kp_client_auth()) {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            "smart card certificate does not have Client Authentication (1.3.6.1.5.5.7.3.2) key usage",
        ));
    }

    if !extended_key_usage.contains(oids::smart_card_logon()) {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            "smart card certificate does not have Smart Card Logon (1.3.6.1.4.1.311.20.2.2) key usage",
        ));
    }

    Ok(())
}

/// Extracts Extended Key Usage from the smart card certificate.
pub fn extract_extended_key_usage_from_certificate(certificate: &Certificate) -> Result<ExtendedKeyUsage> {
    let extended_key_usage_ext = &certificate
        .tbs_certificate
        .extensions
        .0
        .0
        .iter()
        .find(|extension| extension.extn_id().0 == oids::extended_key_usage())
        .ok_or_else(|| {
            Error::new(
                ErrorKind::IncompleteCredentials,
                "Extended Key Usage extension is not present",
            )
        })?
        .extn_value();

    let ExtensionView::ExtendedKeyUsage(extended_key_usage) = extended_key_usage_ext else {
        return Err(Error::new(
            ErrorKind::InternalError,
            "ExtensionView must be ExtendedKeyUsage",
        ));
    };

    Ok((*extended_key_usage).clone())
}

/// Extracts the user principal name from the smart card certificate by searching in the Subject Alternative Name.
#[instrument(level = "trace", ret)]
pub fn extract_upn_from_certificate(certificate: &Certificate) -> Result<String> {
    let subject_alt_name_ext = &certificate
        .tbs_certificate
        .extensions
        .0
        .0
        .iter()
        .find(|extension| extension.extn_id().0 == oids::subject_alternative_name())
        .ok_or_else(|| {
            Error::new(
                ErrorKind::IncompleteCredentials,
                "Subject Alternative Name certificate extension is not present",
            )
        })?
        .extn_value();

    let ExtensionView::SubjectAltName(alternate_name) = subject_alt_name_ext else {
        return Err(Error::new(
            ErrorKind::InternalError,
            "ExtensionView must be SubjectAltName",
        ));
    };

    let GeneralName::OtherName(other_name) = alternate_name.0.first().expect("there is always at least one element")
    else {
        return Err(Error::new(
            ErrorKind::IncompleteCredentials,
            "Subject Alternate Name has unsupported value type",
        ));
    };

    if other_name.type_id.0 != oids::user_principal_name() {
        return Err(Error::new(
            ErrorKind::IncompleteCredentials,
            "Subject Alternate Name must be UPN",
        ));
    }

    let data: Utf8StringAsn1 = picky_asn1_der::from_bytes(&other_name.value.0.0)?;
    Ok(data.to_string())
}

#[cfg(test)]
mod tests {
    use picky::x509::Cert;
    use picky_asn1_x509::Certificate;

    use super::{extract_upn_from_certificate, validate_certificate};

    #[test]
    fn upn_extraction() {
        let certificate: Certificate = Cert::from_pem_str(include_str!("../../../test_assets/pw11.cer"))
            .unwrap()
            .into();

        assert_eq!("pw11@example.com", extract_upn_from_certificate(&certificate).unwrap());
    }

    #[test]
    fn valid_scard_certificate() {
        let certificate = Cert::from_pem_str(include_str!("../../../test_assets/pw11.cer"))
            .unwrap()
            .to_der()
            .unwrap();
        // The following certificate has "pW11@ExAmPlE.cOm" UPN.
        let cert_uppercase_upn = Cert::from_pem_str(include_str!("../../../test_assets/pw11_upper_case_upn.cer"))
            .unwrap()
            .to_der()
            .unwrap();

        validate_certificate(&certificate, "pw11@example.com").expect("certificate is valid");
        validate_certificate(&cert_uppercase_upn, "pw11@example.com").expect("certificate is valid");
    }

    #[test]
    fn invalid_scard_certificate() {
        let cert_without_upn = Cert::from_pem_str(include_str!("../../../test_assets/pw11_without_upn.cer"))
            .unwrap()
            .to_der()
            .unwrap();
        let cert_without_ext_key_usage =
            Cert::from_pem_str(include_str!("../../../test_assets/pw11_without_ext_key_usage.cer"))
                .unwrap()
                .to_der()
                .unwrap();
        let cert_without_scard_logon =
            Cert::from_pem_str(include_str!("../../../test_assets/pw11_without_scard_logon.cer"))
                .unwrap()
                .to_der()
                .unwrap();
        let cert_without_client_auth =
            Cert::from_pem_str(include_str!("../../../test_assets/pw11_without_client_auth.cer"))
                .unwrap()
                .to_der()
                .unwrap();

        assert!(validate_certificate(&cert_without_upn, "pw11@example.com").is_err());
        assert!(validate_certificate(&cert_without_ext_key_usage, "pw11@example.com").is_err());
        assert!(validate_certificate(&cert_without_scard_logon, "pw11@example.com").is_err());
        assert!(validate_certificate(&cert_without_client_auth, "pw11@example.com").is_err());
    }
}
