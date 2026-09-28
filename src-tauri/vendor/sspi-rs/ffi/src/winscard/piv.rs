use sspi::{Error, ErrorKind, Result};
use winscard::tlv_tags;
use winscard::winscard::{Protocol, ScardConnectData, ScardScope, ShareMode, TransmitOutData, WinScardContext};

use crate::winscard::system_scard::SystemScardContext;

/// Status code at the end of the output buffer of the `SCardTransmitFunction`.
///
/// The status value corresponds to the [winscard::Status::Ok].
const WINSCARD_STATUS_OK: [u8; 2] = [0x90, 0x00];

/// Possible PIV certificate labels and their corresponding PIV tags.
///
/// Certificate labels are used to determine the certificate PIV tag.
/// All values are taken from the NIST SP 800-73pt1-5 specification:
/// 4.3 Object Identifiers. Table 3. Object identifiers of the PIV data objects for interoperable use.
const CERTIFICATE_LABELS: &[(&[u8], [u8; 3])] = &[
    // X.509 Certificate for PIV Authentication 2.16.840.1.101.3.7.2.1.1 '5FC105' M
    (b"X.509 Certificate for PIV Authentication", winscard::PIV_CERT_TAG),
    // X.509 Certificate for Digital Signature 2.16.840.1.101.3.7.2.1.0 '5FC10A' C
    (
        b"X.509 Certificate for Digital Signature",
        winscard::DIGITAL_SIGNATURE_CERT_TAG,
    ),
    // X.509 Certificate for Key Management 2.16.840.1.101.3.7.2.1.2 '5FC10B' C
    (
        b"X.509 Certificate for Key Management",
        winscard::KEY_MANAGEMENT_CERT_TAG,
    ),
    // X.509 Certificate for Card Authentication 2.16.840.1.101.3.7.2.5.0 '5FC101' M
    (
        b"X.509 Certificate for Card Authentication",
        winscard::CARD_AUTH_CERT_TAG,
    ),
];

/// PIV certificate slot ID.
///
/// Read more in the NIST SP 800-73pt1-5 specification: Table 5. PIV Card Application key references.
#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub enum SlotId {
    /// PIV Authentication Key.
    PivAuthentication = 0x9a,
    /// Digital Signature Key.
    DigitalSignature = 0x9c,
    /// Key Management Key.
    KeyManagement = 0x9d,
    /// Card Authentication Key.
    CardAuthentication = 0x9e,
}

impl SlotId {
    /// Returns [u8] representation of the slot.
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }

    /// Determines the slot id based on the slot certificate label.
    pub fn from_certificate_label(certificate_label: &[u8]) -> Result<Self> {
        for (label, slot_id) in CERTIFICATE_SLOT_IDS {
            if *label == certificate_label {
                return Ok(*slot_id);
            }
        }

        Err(Error::new(ErrorKind::NoCredentials, "certificate label not recognized"))
    }
}

/// Possible PIV slot IDs.
///
/// The PIV (Personal Identity Verification) standard specifies 25 slots. Each slot has a name and number.
/// Each slot number is given as a hex value, and all slot numbers can be represented as a single byte.
///
/// More info: https://docs.yubico.com/yesdk/users-manual/application-piv/slots.html.
const CERTIFICATE_SLOT_IDS: &[(&[u8], SlotId)] = &[
    (b"X.509 Certificate for PIV Authentication", SlotId::PivAuthentication),
    (b"X.509 Certificate for Digital Signature", SlotId::DigitalSignature),
    (b"X.509 Certificate for Key Management", SlotId::KeyManagement),
    (b"X.509 Certificate for Card Authentication", SlotId::CardAuthentication),
];

/// SELECT APDU command.
///
/// The SELECT card command sets the currently selected application. More info:
/// * NIST.SP.800-73-4, Part 2, Section 3.1.1.
/// * NIST.SP.800-73-4, Part 2, Section 2.2.
/// 
/// This APDU command select the PIV Card Application.
#[rustfmt::skip]
const APDU_PIV_SELECT_AID: &[u8] = &[
    0x00, // CLA
    0xa4, // INS
    0x04, // P1
    0x00, // P2
    0x09, // Lc: Length of application identifier.
    // Application identifier: AID of the PIV Card Application using the full AID.
    //
    // 2. PIV Card Application Namespaces. 2.2 PIV Card Application AID.
    // The Application IDentifier (AID) of the PIV Card Application shall be:
    0xa0, 0x00, 0x00, 0x03, 0x08, 0x00, 0x00, 0x10, 0x00,
    0x00, // Le
];

/// GET DATA Card Command.
///
/// The GET DATA card command retrieves the data content of the single data object whose tag is given in the data field. More info:
/// * NIST.SP.800-73-4, Part 2, Section 3.1.2.
/// * NIST.SP.800-73-4, Part 2, Section 4.3.
/// 
/// The current APDU requests the CHUID value from the smart card.
#[rustfmt::skip]
const APDU_PIV_GET_CHUID: &[u8] = &[
    0x00, // CLA: '00' or '0C' for secure messaging.
    0xcb, // INS
    0x3f, // P1
    0xff, // P2
    0x05, // Lc: Length of data field.
        // 3.1.2. Table 6. Data Objects in the Data Field of the GET DATA Card Command.
        // '5C' is the only one available data object for the GET DATA Card Command.
        0x5c, 0x03,
        // 4.3 Object Identifiers Table 3. Object identifiers of the PIV data objects for interoperable use.
        // Card Holder Unique Identifier 2.16.840.1.101.3.7.2.48.0 '5FC102' M.
        0x5f, 0xc1, 0x02,
    0x00 // Le
];

/// Constructs the key container name based on the CHUID and certificate PIV tag.
///
/// Provided CHUID must be raw CHUID from smart card. This function will parse it and extract needed GUID from it.
/// Provided certificate tag must be valid PIV certificate tag.
#[instrument(level = "trace", ret)]
fn chuid_to_container_name(chuid: &[u8], tag: [u8; 3]) -> Result<String> {
    // The CHUID has defined structure in the NIST SP 800-73pt1-5 specification. Appendix A. PIV Data Model: Table 10. Card Holder Unique Identifier (CHUID).
    // Data Element (TLV)          | Tag  | Type     | Max. Bytes
    // ----------------------------+------+----------+-----------
    // FASC-N                      | 0x30 | Fixed    | 25
    // GUID                        | 0x34 | Fixed    | 16
    // Expiration Date             | 0x35 | Date     | 8
    // Cardholder UUID (Optional)  | 0x36 | Fixed    | 16
    // Issuer Asymmetric Signature | 0x3E | Variable | 2816
    // Error Detection Code        | 0xFE | LRC      | 0

    // Precalculated minimal CHUID length based on the table above.
    //
    // The precalculated value includes only needed CHUID fields: FASC-N, GUID, and Error Detection Code.
    const MINIMAL_CHUID_LEN: usize =
        1 /* CHUID tag */  + 1 /* CHUID data len */ +
        1 /* FASC-N tag */ + 1 /* FASC-N data length */ + 25 /* FASC-N data */ +
        1 /* GUID tag */   + 1 /* GUID data length */   + 16 /* GUID data */ +
        1 /* Error Detection Code tag */ + 1 /* Error Detection Code length */;

    const BYTES_BEFORE_FASN_N: usize = 1 /* CHUID tag */  + 1 /* CHUID data len */;
    const BYTES_BEFORE_GUID: usize = BYTES_BEFORE_FASN_N + 1 /* FASC-N tag */ + 1 /* FASC-N data length */ + 25 /* FASC-N data */;
    // How many bytes we have to skip before GUID value.
    const BYTES_TO_SKIP: usize = BYTES_BEFORE_GUID + 1 /* GUID tag */ + 1 /* GUID data length */;

    let chuid_len = chuid.len();

    if chuid_len < MINIMAL_CHUID_LEN {
        return Err(Error::new(ErrorKind::NoCredentials, "invalid CHUID: not enough bytes"));
    }

    // Check CHUID tag.
    if chuid[0] != tlv_tags::DATA {
        return Err(Error::new(ErrorKind::NoCredentials, "invalid CHUID: bad CHUID tag"));
    }

    // Check FASC-N tag.
    if chuid[BYTES_BEFORE_FASN_N] != tlv_tags::FASC_N {
        return Err(Error::new(ErrorKind::NoCredentials, "invalid CHUID: bad FASN-N tag"));
    }

    // Check GUID tag.
    if chuid[BYTES_BEFORE_GUID] != tlv_tags::GUID {
        return Err(Error::new(ErrorKind::NoCredentials, "invalid CHUID: bad GUID tag"));
    }

    // Check the Error Detection Code.
    if chuid[chuid_len - 2] != tlv_tags::ERROR_DETECTION_CODE || chuid[chuid_len - 1] != 0 {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            "invalid CHUID: bad error detection code",
        ));
    }

    let guid = &chuid[BYTES_TO_SKIP..BYTES_TO_SKIP + 16 /* GUID length */];

    // Construct the value Windows would use for a PIV key's container name.
    let container_name = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        guid[3],
        guid[2],
        guid[1],
        guid[0],
        guid[5],
        guid[4],
        guid[7],
        guid[6],
        guid[8],
        guid[9],
        guid[10],
        guid[11],
        guid[12],
        tag[0],
        tag[1],
        tag[2]
    );

    Ok(container_name)
}

/// Returns key container name based on the smart card reader name and certificate PIV tag.
///
/// Provided certificate tag must be valid PIV certificate tag.
/// This function attempts to retrieve the CHUID (Card Holder Unique Identifier) from the smart card using the WinSCard API,
/// extract the GUID from the CHUID, and then construct the key container name.
#[instrument(level = "trace", ret)]
fn extract_piv_container_name(reader: &str, tag: [u8; 3]) -> Result<String> {
    let context = SystemScardContext::establish(ScardScope::User, false)?;
    let ScardConnectData {
        protocol: _,
        handle: mut card,
    } = context.connect(reader, ShareMode::Shared, Some(Protocol::T0 | Protocol::T1))?;

    let TransmitOutData {
        output_apdu: output,
        receive_pci: _,
    } = card.transmit(APDU_PIV_SELECT_AID)?;

    if output.len() < 2 {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            "failed to extract container name: failed to select PIV card application",
        ));
    }

    // Check status word.
    if output[output.len() - 2..] != WINSCARD_STATUS_OK {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            "failed to extract container name: failed to select PIV card application",
        ));
    }

    let TransmitOutData {
        output_apdu: output,
        receive_pci: _,
    } = card.transmit(APDU_PIV_GET_CHUID)?;

    if output.len() < 2 {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            "failed to extract container name: failed to select PIV card application",
        ));
    }

    // Check status word.
    if output[output.len() - 2 /* status word */..] != WINSCARD_STATUS_OK {
        return Err(Error::new(
            ErrorKind::NoCredentials,
            "failed to extract container name: failed to select PIV card application",
        ));
    }

    let chuid = &output[0..output.len() - 2 /* status word */];

    chuid_to_container_name(chuid, tag)
}

/// Tries to construct smart card key container based on a reader name and a certificate label.
///
/// This function works **ONLY** for PIV compatible smart cards. Otherwise, it will fail.
pub fn try_get_piv_container_name(reader: &str, certificate_label: &[u8]) -> Result<String> {
    for (label, tag) in CERTIFICATE_LABELS {
        if *label == certificate_label {
            return extract_piv_container_name(reader, *tag);
        }
    }

    Err(Error::new(ErrorKind::NoCredentials, "certificate label not recognized"))
}

#[cfg(test)]
mod tests {
    use super::chuid_to_container_name;

    #[test]
    fn container_name_formatting() {
        // Valid CHUID from the testing YubiKey device.
        let chuid = &[
            83, 59, 48, 25, 212, 231, 57, 218, 115, 156, 237, 57, 206, 115, 157, 131, 104, 88, 33, 8, 66, 16, 132, 33,
            200, 66, 16, 195, 235, 52, 16, 88, 198, 138, 29, 101, 224, 160, 146, 133, 175, 9, 11, 7, 11, 93, 121, 53,
            8, 50, 48, 51, 48, 48, 49, 48, 49, 62, 0, 254, 0,
        ];

        let container_name = chuid_to_container_name(chuid, winscard::PIV_CERT_TAG).unwrap();

        assert_eq!(container_name, "1d8ac658-e065-92a0-85af-090b075fc105");
    }

    #[test]
    fn invalid_chuid() {
        let cert_tag = winscard::PIV_CERT_TAG;

        // Too short.
        let invalid_chuid = &[
            83, 59, 48, 25, 212, 231, 57, 218, 115, 156, 237, 57, 206, 115, 157, 131, 104, 88, 33, 8, 66, 16, 132, 33,
            200, 66, 16, 195, 235, 52, 16, 88, 198, 138, 29, 101, 224, 160, 146, 133, 175, 9, 11, 7, 11, 93, 121, 53,
        ];
        assert!(chuid_to_container_name(invalid_chuid, cert_tag).is_err());

        // Invalid CHUID tag.
        let invalid_chuid = &[
            81, 59, 48, 25, 212, 231, 57, 218, 115, 156, 237, 57, 206, 115, 157, 131, 104, 88, 33, 8, 66, 16, 132, 33,
            200, 66, 16, 195, 235, 52, 16, 88, 198, 138, 29, 101, 224, 160, 146, 133, 175, 9, 11, 7, 11, 93, 121, 53,
            8, 50, 48, 51, 48, 48, 49, 48, 49, 62, 0, 254, 0,
        ];
        assert!(chuid_to_container_name(invalid_chuid, cert_tag).is_err());

        // Invalid FASC-N tag.
        let invalid_chuid = &[
            81, 59, 42, 25, 212, 231, 57, 218, 115, 156, 237, 57, 206, 115, 157, 131, 104, 88, 33, 8, 66, 16, 132, 33,
            200, 66, 16, 195, 235, 52, 16, 88, 198, 138, 29, 101, 224, 160, 146, 133, 175, 9, 11, 7, 11, 93, 121, 53,
            8, 50, 48, 51, 48, 48, 49, 48, 49, 62, 0, 254, 0,
        ];
        assert!(chuid_to_container_name(invalid_chuid, cert_tag).is_err());

        // Invalid GUID tag.
        let invalid_chuid = &[
            81, 59, 42, 25, 212, 231, 57, 218, 115, 156, 237, 57, 206, 115, 157, 131, 104, 88, 33, 8, 66, 16, 132, 33,
            200, 66, 16, 195, 235, 51, 16, 88, 198, 138, 29, 101, 224, 160, 146, 133, 175, 9, 11, 7, 11, 93, 121, 53,
            8, 50, 48, 51, 48, 48, 49, 48, 49, 62, 0, 254, 0,
        ];
        assert!(chuid_to_container_name(invalid_chuid, cert_tag).is_err());

        // Invalid error detection code.
        let invalid_chuid = &[
            81, 59, 42, 25, 212, 231, 57, 218, 115, 156, 237, 57, 206, 115, 157, 131, 104, 88, 33, 8, 66, 16, 132, 33,
            200, 66, 16, 195, 235, 51, 16, 88, 198, 138, 29, 101, 224, 160, 146, 133, 175, 9, 11, 7, 11, 93, 121, 53,
            8, 50, 48, 51, 48, 48, 49, 48, 49, 62, 0, 250, 1,
        ];
        assert!(chuid_to_container_name(invalid_chuid, cert_tag).is_err());
    }
}
