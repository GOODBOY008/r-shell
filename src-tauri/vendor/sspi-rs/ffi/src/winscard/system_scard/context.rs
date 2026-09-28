use std::borrow::Cow;
#[cfg(not(target_os = "windows"))]
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fmt;
use std::ptr::{self, null, null_mut};
#[cfg(target_os = "windows")]
use std::slice::from_raw_parts;

#[cfg(target_os = "windows")]
use ffi_types::winscard::functions::SCardApiFunctionTable;
#[cfg(target_os = "windows")]
use ffi_types::winscard::{ScardContext, ScardHandle};
use uuid::Uuid;
use winscard::winscard::{
    DeviceTypeId, Icon, Protocol, ProviderId, ReaderState, ScardConnectData, ScardScope, ShareMode, WinScardContext,
};
use winscard::{Error, ErrorKind, WinScardResult};

use super::{SystemScard, parse_multi_string_owned};
#[cfg(not(target_os = "windows"))]
use crate::winscard::pcsc_lite::functions::PcscLiteApiFunctionTable;
#[cfg(not(target_os = "windows"))]
use crate::winscard::pcsc_lite::{ScardContext, ScardHandle, initialize_pcsc_lite_api};

/// Default name of the system provided smart card.
///
/// pcsc-lite and PC/SC framework don't have method for querying scard name, so we use predefined value. It doesn't affect the auth process.
#[cfg(not(target_os = "windows"))]
const DEFAULT_CARD_NAME: &str = "Sspi-rs system provided scard";

pub struct SystemScardContext {
    h_context: ScardContext,

    #[cfg(target_os = "windows")]
    api: SCardApiFunctionTable,
    #[cfg(not(target_os = "windows"))]
    api: PcscLiteApiFunctionTable,

    // pcsc-lite API does not have function for the cache reading/writing. So, we emulate the smart card cache by ourselves.
    #[cfg(not(target_os = "windows"))]
    cache: BTreeMap<String, Vec<u8>>,
}

impl fmt::Debug for SystemScardContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SystemScardContext")
            .field("h_context", &self.h_context)
            .finish()
    }
}

impl SystemScardContext {
    #[instrument(ret)]
    pub fn establish(scope: ScardScope, _with_cache: bool) -> WinScardResult<Self> {
        let mut h_context = 0;

        #[cfg(target_os = "windows")]
        let api = super::init_scard_api_table()?;
        #[cfg(not(target_os = "windows"))]
        let api = initialize_pcsc_lite_api()?;

        try_execute!(
            // SAFETY:
            // - `scope.into()` is a valid `u32` value corresponding to the scope of the resource manager context.
            // - `pvReserved1` is null.
            // - `pvReserved2` is null.
            // - `&mut h_context` is a properly-aligned, writable pointer to a local variable.
            unsafe { (api.SCardEstablishContext)(scope.into(), null_mut(), null_mut(), &mut h_context) },
            "SCardEstablishContext failed"
        )?;

        if h_context == 0 {
            return Err(Error::new(
                ErrorKind::InternalError,
                "can not establish context: SCardEstablishContext did not set the context handle",
            ));
        }

        // We mutate `scard_context` below on non-Windows systems to initialize the scard cache.
        #[allow(unused_mut)]
        let mut scard_context = Self {
            h_context,
            api,
            #[cfg(not(target_os = "windows"))]
            cache: Default::default(),
        };

        #[cfg(not(target_os = "windows"))]
        if _with_cache {
            let scard_logon_params = if let (Ok(certificate), Ok(container_name)) =
                (winscard::env::auth_cert_from_env(), winscard::env::container_name())
            {
                use crate::winscard::piv::SlotId;

                let certificate_der = certificate.to_der()?;

                ScardLogonParams {
                    container_name,
                    certificate,
                    certificate_der,
                    slot: SlotId::PivAuthentication,
                }
            } else {
                use std::path::Path;

                use crate::sspi::sec_winnt_auth_identity::PKCS11_MODULE_PATH_ENV;

                info!(
                    "Smart card certificate and container name environment variables were not set properly. Trying to determine them using the PKCS11 module..."
                );

                let pkcs11_module_path = winscard::env!(PKCS11_MODULE_PATH_ENV)?;
                try_extract_container_name_and_certificate(Path::new(&pkcs11_module_path))?
            };

            scard_context.cache = init_scard_cache(&scard_logon_params)?;
        }

        Ok(scard_context)
    }
}

#[cfg(not(target_os = "windows"))]
struct ScardLogonParams {
    container_name: String,
    certificate: picky::x509::Cert,
    certificate_der: Vec<u8>,
    slot: crate::winscard::piv::SlotId,
}

#[cfg(not(target_os = "windows"))]
#[instrument(err)]
fn try_extract_container_name_and_certificate(pkcs11_module: &std::path::Path) -> Result<ScardLogonParams, Error> {
    use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
    use cryptoki::object::{Attribute, AttributeType, CertificateType, ObjectClass};
    use picky::x509::Cert;

    use crate::winscard::piv::{SlotId, try_get_piv_container_name};

    macro_rules! try_execute {
        ($x:expr, $msg:literal) => {{
            match $x {
                Ok(val) => val,
                Err(err) => {
                    error!(?err, $msg);
                    return Err(Error::new(ErrorKind::InternalError, format!("{}: {}", $msg, err)));
                }
            }
        }};
    }

    let pkcs11 = try_execute!(Pkcs11::new(pkcs11_module), "failed to open PKCS11 module");
    try_execute!(
        pkcs11.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK)),
        "failed to initialize PKCS11 module"
    );

    for slot in try_execute!(pkcs11.get_slots_with_token(), "failed to list slots") {
        let session = try_execute!(pkcs11.open_ro_session(slot), "failed to open a read only session");

        let slot_info = try_execute!(pkcs11.get_slot_info(slot), "failed to get slot info");
        let reader_name = slot_info.slot_description();

        // The first suitable user certificate on smart card.
        let mut certificate = None;

        let query = [
            Attribute::Class(ObjectClass::CERTIFICATE),
            Attribute::CertificateType(CertificateType::X_509),
        ];
        'certificates: for certificate_handle in
            try_execute!(session.find_objects(&query), "failed to query smart card certificates")
        {
            for encoded_certificate in try_execute!(
                session.get_attributes(certificate_handle, &[AttributeType::Value]),
                "failed to retrieve the smart card certificate value"
            ) {
                let Attribute::Value(encoded_certificate) = encoded_certificate else {
                    continue;
                };

                if validate_certificate(&encoded_certificate).is_err() {
                    continue;
                }

                certificate = Some((encoded_certificate, certificate_handle));

                break 'certificates;
            }
        }

        let Some((certificate_der, certificate_handle)) = certificate else {
            continue;
        };

        let mut container_name = None;
        let mut slot = None;
        // We found a suitable certificate for smart card logon on the device.
        // Next, we check if the inserted device is a PIV smart card. If so, we will attempt
        // to extract the container name using raw APDU commands.
        for label in try_execute!(
            session.get_attributes(certificate_handle, &[AttributeType::Label]),
            "failed to query certificate label"
        ) {
            let Attribute::Label(label) = label else {
                continue;
            };

            container_name = Some(try_execute!(
                try_get_piv_container_name(reader_name, &label),
                "failed to construct a container name"
            ));
            slot = Some(try_execute!(
                SlotId::from_certificate_label(&label),
                "failed to determine a slot id"
            ));

            if container_name.is_some() {
                break;
            }
        }

        let Some(container_name) = container_name else {
            continue;
        };

        let Some(slot) = slot else {
            continue;
        };

        let certificate = try_execute!(
            Cert::from_der(&certificate_der),
            "failed to parse smart card certificate"
        );

        return Ok(ScardLogonParams {
            container_name,
            certificate,
            certificate_der,
            slot,
        });
    }

    Err(Error::new(
        ErrorKind::InternalError,
        "smart card does not contain suitable credentials",
    ))
}

/// Validates smart card certificate.
///
/// Certificate requirements:
/// * Extended Key Usage extension must present and contain Client Authentication (1.3.6.1.5.5.7.3.2) and Smart Card Logon (1.3.6.1.4.1.311.20.2.2) OIDs.
#[cfg(not(target_os = "windows"))]
fn validate_certificate(certificate: &[u8]) -> Result<(), Error> {
    use picky_asn1_x509::{Certificate, oids};

    use crate::sspi::scard_cert::extract_extended_key_usage_from_certificate;

    let certificate: Certificate = picky_asn1_der::from_bytes(certificate)?;

    let extended_key_usage = extract_extended_key_usage_from_certificate(&certificate).map_err(|err| {
        Error::new(
            ErrorKind::InternalError,
            format!("failed to extract smart card certificate extended key usage: {err}"),
        )
    })?;

    if !extended_key_usage.contains(oids::kp_client_auth()) {
        return Err(Error::new(
            ErrorKind::InternalError,
            "smart card certificate does not have Client Authentication (1.3.6.1.5.5.7.3.2) key usage",
        ));
    }

    if !extended_key_usage.contains(oids::smart_card_logon()) {
        return Err(Error::new(
            ErrorKind::InternalError,
            "smart card certificate does not have Smart Card Logon (1.3.6.1.4.1.311.20.2.2) key usage",
        ));
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn init_scard_cache(scard_logon_params: &ScardLogonParams) -> WinScardResult<BTreeMap<String, Vec<u8>>> {
    let ScardLogonParams {
        container_name,
        certificate,
        certificate_der,
        slot,
    } = scard_logon_params;

    use picky_asn1_x509::{PublicKey, SubjectPublicKeyInfo};

    // https://github.com/selfrender/Windows-Server-2003/blob/5c6fe3db626b63a384230a1aa6b92ac416b0765f/ds/security/csps/wfsccsp/inc/basecsp.h#L86-L93
    const MAX_CONTAINER_NAME_LEN: usize = 40;

    let mut cache = BTreeMap::new();

    // Freshness values are not supported, so we set all values to zero.
    const PIN_FRESHNESS: [u8; 2] = [0x00, 0x00];
    const CONTAINER_FRESHNESS: [u8; 2] = [0x00, 0x00];
    const FILE_FRESHNESS: [u8; 2] = [0x00, 0x00];

    // The following header is formed based on the extracted information during the debugging and troubleshooting.
    // Do not change it unless you know what you are doing. A broken cache will break the entire authentication.
    const CACHE_ITEM_HEADER: [u8; 6] = {
        let mut header = [0; 6];

        header[0] = 1;
        header[1] = PIN_FRESHNESS[1];
        header[2] = CONTAINER_FRESHNESS[0] + 1;
        header[3] = CONTAINER_FRESHNESS[1];
        header[4] = FILE_FRESHNESS[0] + 1;
        header[5] = FILE_FRESHNESS[1];

        header
    };

    cache.insert("Cached_CardProperty_Read Only Mode_0".into(), {
        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        // actual data len
        value.extend_from_slice(&4_u32.to_le_bytes());
        // true
        value.extend_from_slice(&1_u32.to_le_bytes());

        value
    });
    cache.insert("Cached_CardProperty_Cache Mode_0".into(), {
        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        // actual data len
        value.extend_from_slice(&4_u32.to_le_bytes());
        // true
        value.extend_from_slice(&1_u32.to_le_bytes());

        value
    });
    cache.insert("Cached_CardProperty_Supports Windows x.509 Enrollment_0".into(), {
        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        // actual data len
        value.extend_from_slice(&4_u32.to_le_bytes());
        // false
        value.extend_from_slice(&0_u32.to_le_bytes());

        value
    });
    cache.insert("Cached_GeneralFile/mscp/cmapfile".into(), {
        use std::mem::size_of;

        use ffi_types::WChar;

        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        // actual data len: size_of<CONTAINER_MAP_RECORD>()
        // https://github.com/selfrender/Windows-Server-2003/blob/5c6fe3db626b63a384230a1aa6b92ac416b0765f/ds/security/csps/wfsccsp/inc/basecsp.h#L104-L110
        value.extend_from_slice(&86_u32.to_le_bytes());
        // CONTAINER_MAP_RECORD:
        let mut wsz_guid = container_name
            .encode_utf16()
            .chain(core::iter::once(0))
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>();
        // `wszGuid` has type `WCHAR [MAX_CONTAINER_NAME_LEN]`,
        // so we need to resize the data if it contains less then `size_of() * MAX_CONTAINER_NAME_LEN` bytes.
        let container_name_bytes_len = size_of::<WChar>() * MAX_CONTAINER_NAME_LEN;
        debug_assert_eq!(container_name_bytes_len, 80);

        wsz_guid.resize(container_name_bytes_len, 0);
        debug!(?wsz_guid);

        value.extend_from_slice(&wsz_guid); // wszGuid
        value.extend_from_slice(&[3, 0]); // bFlags
        value.extend_from_slice(&[0, 0]); // wSigKeySizeBits
        value.extend_from_slice(&[0, 8]); // wKeyExchangeKeySizeBits

        value
    });
    cache.insert("Cached_ContainerProperty_PIN Identifier_0".into(), {
        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        // actual data len
        value.extend_from_slice(&4_u32.to_le_bytes());
        // PIN identifier
        value.extend_from_slice(&1_u32.to_le_bytes());

        value
    });
    cache.insert("Cached_ContainerInfo_00".into(), {
        // Note. We can hardcode lengths values in this cache item because we support only 2048 RSA keys.
        // RSA 4096 is not defined in the specification so we don't support it.
        // https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-73-4.pdf#page=34
        // 5.3 Cryptographic Mechanism Identifiers
        // '07' - RSA 2048

        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        // actual data len (precalculated)
        value.extend_from_slice(&292_u32.to_le_bytes());

        value.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x14, 0x01, 0x00, 0x00]); // container info header

        // https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/ns-wincrypt-publickeystruc
        // PUBLICKEYSTRUC
        value.push(0x06); // bType = PUBLICKEYBLOB
        value.push(0x02); // bVersion = 0x2
        value.extend_from_slice(&[0x00, 0x00]); // reserved
        value.extend_from_slice(&[0x00, 0xa4, 0x00, 0x00]); // aiKeyAlg = CALG_RSA_KEYX

        // https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/ns-wincrypt-rsapubkey
        // RSAPUBKEY
        value.extend_from_slice(b"RSA1"); // magic = RSA1
        value.extend_from_slice(&2048_u32.to_le_bytes()); // bitlen = 2048

        let public_key = certificate.public_key();
        let public_key: &SubjectPublicKeyInfo = public_key.as_ref();
        let (modulus, public_exponent) = match &public_key.subject_public_key {
            PublicKey::Rsa(rsa) => (
                {
                    let mut modulus = rsa.0.modulus.to_vec();
                    modulus.reverse();
                    modulus.resize(256, 0);
                    modulus
                },
                {
                    let mut pub_exp = rsa.0.public_exponent.to_vec();
                    pub_exp.reverse();
                    pub_exp.resize(4, 0);
                    pub_exp
                },
            ),
            _ => {
                return Err(Error::new(
                    ErrorKind::UnsupportedFeature,
                    "only RSA 2048 keys are supported",
                ));
            }
        };

        value.extend_from_slice(&public_exponent); // pubexp
        value.extend_from_slice(&modulus); // public key

        value
    });
    cache.insert("Cached_GeneralFile/mscp/kxc00".into(), {
        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);

        value.extend_from_slice(&(u16::try_from(certificate_der.len())?.to_le_bytes())); // uncompressed certificate data len
        value.extend_from_slice(&[0x00, 0x00]); // flags that specify that the certificate is not compressed
        value.extend_from_slice(certificate_der);

        value
    });
    cache.insert("Cached_CardProperty_Capabilities_0".into(), {
        let mut value = CACHE_ITEM_HEADER.to_vec();
        // unkown flags
        value.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        // actual data len
        value.extend_from_slice(&12_u32.to_le_bytes());
        // Here should be the CARD_CAPABILITIES struct but the actual extracted data is different.
        // So, we just insert the extracted data from a real smart card.
        // Card capabilities:
        value.extend_from_slice(&[1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);

        value
    });

    //= YubiKey-related cache items =//

    /// The KeySpec property identifies how a key that is generated or retrieved using the Microsoft CryptoAPI (CAPI)
    /// from a Microsoft legacy Cryptographic Storage Provider (CSP) can be used.
    ///
    /// We need the [KeySpec] value to build scard cache items correctly.
    #[repr(u8)]
    enum KeySpec {
        /// RSA key that can be used for signing and decryption.
        AtKeyExchange = 1,
        /// RSA signature only key.
        AtSignature = 2,
    }

    cache.insert("ykmd_cardcf".to_owned(), CACHE_ITEM_HEADER.to_vec());

    cache.insert("ykmd_lastupdate".to_owned(), {
        use std::time::{SystemTime, UNIX_EPOCH};

        let now = SystemTime::now();
        let epoch_seconds = now.duration_since(UNIX_EPOCH).unwrap().as_secs();

        epoch_seconds.to_le_bytes().to_vec()
    });

    cache.insert("ykmd_cmap".to_owned(), {
        use ffi_types::WChar;
        use sha2::Digest;

        use crate::winscard::piv::SlotId;

        // This cache item represents the `ykpiv_container` object:
        //
        // https://github.com/Yubico/yubico-piv-tool/blob/6444d40d73f4d4c029c9739938edf57ede23e6f1/lib/ykpiv.h#L268-L277
        // ```C
        //   typedef struct _ykpiv_container {
        //     wchar_t name[40];
        //     uint8_t slot;
        //     uint8_t key_spec;
        //     uint16_t key_size_bits;
        //     uint8_t flags;
        //     uint8_t pin_id;
        //     uint8_t associated_echd_container;
        //     uint8_t cert_fingerprint[20];
        //   } ykpiv_container;
        // ```

        let mut container_name_encoded = container_name
            .encode_utf16()
            .chain(core::iter::once(0))
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>();
        let container_name_bytes_len = size_of::<WChar>() * MAX_CONTAINER_NAME_LEN;
        debug_assert_eq!(container_name_bytes_len, 80);

        container_name_encoded.resize(container_name_bytes_len, 0);
        debug!(?container_name_encoded);

        let mut value = container_name_encoded;
        value.push(slot.as_u8()); // Slot.

        // The KeySpec value is not encoded inside certificate. We determine it by looking at the certificate slot id.
        let key_spec = match slot {
            SlotId::PivAuthentication => KeySpec::AtKeyExchange,
            SlotId::DigitalSignature => KeySpec::AtSignature,
            SlotId::KeyManagement => KeySpec::AtKeyExchange,
            SlotId::CardAuthentication => KeySpec::AtKeyExchange,
        };
        value.push(key_spec as u8);

        value.extend_from_slice(&[0x00, 0x08]); // KeySize.
        value.push(0x03); // Flags.
        value.push(0x01); // PIN id.
        value.push(0xff); // Associated ECHD container (none).

        // Discovered experimentally:
        // The `cert_fingerprint` field contains the first 20 bytes of SHA256 cert hash (instead of SHA1 cert hash).
        let cert_fingerprint = sha2::Sha256::digest(certificate_der);
        value.extend_from_slice(&cert_fingerprint.as_slice()[0..20]);

        // The value length must be the correct size. The YubiKey Smart Card Minidriver checks it.
        // The `0x6b` was extracted from the `ykmd.dll` and is also equal to the `ykpiv_container` size.
        debug_assert_eq!(value.len(), 0x6b);

        value
    });

    Ok(cache)
}

impl Drop for SystemScardContext {
    fn drop(&mut self) {
        if let Err(err) = try_execute!(
            // SAFETY: `h_context` is set by a previous call to `SCardEstablishContext`.
            unsafe { (self.api.SCardReleaseContext)(self.h_context) },
            "SCardReleaseContext failed"
        ) {
            error!(?err, "Can not release the scard context");
        }
    }
}

impl WinScardContext for SystemScardContext {
    #[instrument]
    fn connect(
        &self,
        reader_name: &str,
        share_mode: ShareMode,
        protocol: Option<Protocol>,
    ) -> WinScardResult<ScardConnectData> {
        let c_string = CString::new(reader_name)?;

        let mut scard: ScardHandle = 0;
        let mut active_protocol = 0;

        #[cfg(not(target_os = "windows"))]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `c_string` is a valid, null-terminated C String due to the `CString` type.
                // - `share_mode.into()` is a valid `u32` value corresponding to a share mode flag.
                // - `protocol.unwrap_or_default.bits()` is a valid `u32` value corresponding to a
                //   bitmask of acceptable protocols.
                // - `&mut scard` is a properly-aligned, writable pointer to a local variable.
                // - `&mut active_protocol` is a properly-aligned, writable pointer to a local variable.
                unsafe {
                    (self.api.SCardConnect)(
                        self.h_context,
                        c_string.as_ptr().cast(),
                        share_mode.into(),
                        protocol.unwrap_or_default().bits().into(),
                        &mut scard,
                        &mut active_protocol,
                    )
                },
                "SCardConnect failed"
            )?;
        }
        #[cfg(target_os = "windows")]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `c_string` is a valid, null-terminated C String due to the `CString` type.
                // - `share_mode.into()` is a valid `u32` value corresponding to a share mode flag.
                // - `protocol.unwrap_or_default.bits()` is a valid `u32` value corresponding to a
                //   bitmask of acceptable protocols.
                // - `&mut scard` is a properly-aligned, writable pointer to a local variable.
                // - `&mut active_protocol` is a properly-aligned, writable pointer to a local variable.
                unsafe {
                    (self.api.SCardConnectA)(
                        self.h_context,
                        c_string.as_ptr().cast(),
                        share_mode.into(),
                        protocol.unwrap_or_default().bits(),
                        &mut scard,
                        &mut active_protocol,
                    )
                },
                "SCardConnectA failed"
            )?;
        }

        // `DWORD` is aliased to `c_ulong` for Linux targets. In turn, `c_ulong` is aliased to `u64` on some targets.
        // Thus, depending on the compilation target, *sometimes* we need to convert `u64` to `u32`.
        #[allow(clippy::useless_conversion)]
        let active_protocol = active_protocol.try_into()?;
        let protocol = Protocol::from_bits(active_protocol).unwrap_or_default();
        let handle = Box::new(SystemScard::new(scard, protocol, self.h_context)?);

        Ok(ScardConnectData { handle, protocol })
    }

    fn list_readers(&self) -> WinScardResult<Vec<Cow<'_, str>>> {
        let mut readers_buf_len = 0;

        #[cfg(not(target_os = "windows"))]
        {
            // https://pcsclite.apdu.fr/api/group__API.html#ga93b07815789b3cf2629d439ecf20f0d9
            //
            // If the application sends mszGroups and mszReaders as NULL then this function will return the size of the buffer needed to allocate in pcchReaders.
            // `mszGroups`: List of groups to list readers (not used).
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `mszGroups` can be null.
                // - `mszReaders` can be null.
                // - `&mut readers_buf_len` is a properly-aligned, writable pointer to a local variable.
                unsafe { (self.api.SCardListReaders)(self.h_context, null(), null_mut(), &mut readers_buf_len) },
                "SCardListReaders failed"
            )?;
        }
        #[cfg(target_os = "windows")]
        {
            // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardlistreadersa
            //
            //  If this value is NULL, SCardListReaders ignores the buffer length supplied in pcchReaders,
            //  writes the length of the buffer that would have been returned if this parameter
            //  had not been NULL to pcchReaders, and returns a success code.
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `mszGroups` can be null.
                // - `mszReaders` can be null.
                // - `&mut readers_buf_len` is a properly-aligned, writable pointer to a local variable.
                unsafe { (self.api.SCardListReadersA)(self.h_context, null(), null_mut(), &mut readers_buf_len) },
                "SCardListReadersA failed"
            )?;
        }

        let mut readers = vec![0; readers_buf_len.try_into()?];

        #[cfg(not(target_os = "windows"))]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `mszGroups` can be null.
                // - `readers.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `readers_buf_len`.
                // - `&mut readers_buf_len` is a properly-aligned, writable pointer to a local variable.
                //   The length is correct because it was set by a previous call to `SCardListReadersA`.
                unsafe {
                    (self.api.SCardListReaders)(self.h_context, null(), readers.as_mut_ptr(), &mut readers_buf_len)
                },
                "SCardListReaders failed"
            )?;
        }
        #[cfg(target_os = "windows")]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `mszGroups` can be null.
                // - `readers.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `readers_buf_len`.
                // - `&mut readers_buf_len` is a properly-aligned, writable pointer to a local variable.
                //   The length is correct because it was set by a previous call to `SCardListReadersA`.
                unsafe {
                    (self.api.SCardListReadersA)(self.h_context, null(), readers.as_mut_ptr(), &mut readers_buf_len)
                },
                "SCardListReadersA failed"
            )?;
        }

        parse_multi_string_owned(&readers)
    }

    fn device_type_id(&self, _reader_name: &str) -> WinScardResult<DeviceTypeId> {
        #[cfg(not(target_os = "windows"))]
        {
            Ok(DeviceTypeId::Usb)
        }
        #[cfg(target_os = "windows")]
        {
            use num_traits::FromPrimitive;

            let mut device_type_id = 0;

            let c_reader_name = CString::new(_reader_name)?;

            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `c_reader_name` is a valid, null-terminated C String due to the `CString` type.
                // - `device_type_id` is a properly-aligned, writable pointer to a local variable.
                unsafe {
                    (self.api.SCardGetDeviceTypeIdA)(self.h_context, c_reader_name.as_ptr().cast(), &mut device_type_id)
                },
                "SCardGetDeviceTypeIdA failed"
            )?;

            DeviceTypeId::from_u32(device_type_id).ok_or_else(|| {
                Error::new(
                    ErrorKind::InternalError,
                    format!("WinSCard has returned invalid device type id: {device_type_id}"),
                )
            })
        }
    }

    fn reader_icon(&self, _reader_name: &str) -> WinScardResult<Icon<'_>> {
        #[cfg(not(target_os = "windows"))]
        {
            use winscard::SmartCardInfo;

            Ok(Icon::from(SmartCardInfo::reader_icon()))
        }
        #[cfg(target_os = "windows")]
        {
            let c_reader_name = CString::new(_reader_name)?;

            let mut icon_buf_len = 0;

            // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetreadericona
            //
            // If this value is NULL, the function ignores the buffer length supplied in the pcbIcon parameter,
            // writes the length of the buffer that would have been returned to pcbIcon if this parameter
            // had not been NULL, and returns a success code.
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `c_reader_name` is a valid, null-terminated C String due to the `CString` type.
                // - `pvIcon` can be null.
                // - `&mut icon_buf_len` is a properly-aligned, writable pointer to a local variable.
                unsafe {
                    (self.api.SCardGetReaderIconA)(
                        self.h_context,
                        c_reader_name.as_ptr().cast(),
                        null_mut(),
                        &mut icon_buf_len,
                    )
                },
                "SCardGetReaderIconA failed"
            )?;

            let mut icon_buf = vec![0; icon_buf_len.try_into()?];

            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `c_reader_name` is a valid, null-terminated C String due to the `CString` type.
                // - `icon_buf.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `icon_buf_len`.
                // - `&mut icon_buf_len` is a properly-aligned, writable pointer to a local variable.
                //   The length is correct because it was set by a previous call to `SCardGetReaderIconA`.
                unsafe {
                    (self.api.SCardGetReaderIconA)(
                        self.h_context,
                        c_reader_name.as_ptr().cast(),
                        icon_buf.as_mut_ptr(),
                        &mut icon_buf_len,
                    )
                },
                "SCardGetReaderIconA failed"
            )?;

            Ok(icon_buf.into())
        }
    }

    fn is_valid(&self) -> bool {
        try_execute!(
            // SAFETY: `h_context` is set by a previous call to `SCardEstablishContext`.
            unsafe { (self.api.SCardIsValidContext)(self.h_context) },
            "SCardIsValidContext failed"
        )
        .is_ok()
    }

    #[instrument(ret)]
    fn read_cache(&self, _card_id: Uuid, _freshness_counter: u32, key: &str) -> WinScardResult<Cow<'_, [u8]>> {
        #[cfg(not(target_os = "windows"))]
        {
            self.cache
                .get(key)
                .map(|item| Cow::Borrowed(item.as_slice()))
                .ok_or_else(|| Error::new(ErrorKind::CacheItemNotFound, format!("Cache item '{key}' not found")))
        }
        #[cfg(target_os = "windows")]
        {
            use std::ptr;

            use super::uuid_to_c_guid;
            use crate::winscard::buf_alloc::SCARD_AUTOALLOCATE;

            let mut data_len = SCARD_AUTOALLOCATE;

            let c_cache_key = CString::new(key)?;
            let mut card_id = uuid_to_c_guid(_card_id);

            let mut data: *mut u8 = null_mut();

            // It's not specified in the `SCardReadCacheA` function documentation, but after some
            // `msclmd.dll` reversing, we found out that this function supports the `SCARD_AUTOALLOCATE`.
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `&mut card_id` is a properly-aligned, readable pointer to a local variable.
                // - `c_cache_key` is a valid, null-terminated C String due to the `CString` type.
                // - `&mut data` is a properly-aligned, writable pointer to a local pointer.
                // - `&mut data_len` is a properly-aligned, writable pointer to a local variable.
                unsafe {
                    (self.api.SCardReadCacheA)(
                        self.h_context,
                        &mut card_id,
                        _freshness_counter,
                        c_cache_key.into_raw().cast(),
                        ptr::from_mut(&mut data).cast(),
                        &mut data_len,
                    )
                },
                "SCardReadCacheA failed"
            )?;

            let data_len: usize = if let Ok(len) = data_len.try_into() {
                len
            } else {
                try_execute!(
                    // SAFETY:
                    // - `h_context` is set by a previous call to `SCardEstablishContext`.
                    // - `data` is a valid pointer that was allocated by a previous call to `SCardReadCacheA`.
                    unsafe { (self.api.SCardFreeMemory)(self.h_context, data.cast()) },
                    "SCardFreeMemory failed"
                )?;

                return Err(Error::new(ErrorKind::InternalError, "u32 to usize conversion error"));
            };

            let mut cache_item = vec![0; data_len];
            cache_item.copy_from_slice(
                // SAFETY: `data` pointer is a local pointer that was initialized by `SCardReadCacheA` function.
                unsafe { from_raw_parts(data, data_len) },
            );

            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `data` is a valid pointer that was allocated by a previous call to `SCardReadCacheA`.
                unsafe { (self.api.SCardFreeMemory)(self.h_context, data.cast()) },
                "SCardFreeMemory failed"
            )?;

            Ok(Cow::Owned(cache_item))
        }
    }

    fn write_cache(
        &mut self,
        _card_id: Uuid,
        _freshness_counter: u32,
        key: String,
        value: Vec<u8>,
    ) -> WinScardResult<()> {
        #[cfg(not(target_os = "windows"))]
        {
            self.cache.insert(key, value);

            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            use super::uuid_to_c_guid;

            let c_cache_key = CString::new(key.as_str())?;
            let mut card_id = uuid_to_c_guid(_card_id);

            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `&mut card_id` is a properly-aligned, readable pointer to a local variable.
                // - `c_cache_key` is a valid, null-terminated C String due to the `CString` type.
                // - `&mut value` is a properly-aligned, readable pointer to a local `Vec`.
                // - `value.len()` is a valid length of the `value` buffer.
                unsafe {
                    (self.api.SCardWriteCacheA)(
                        self.h_context,
                        &mut card_id,
                        _freshness_counter,
                        c_cache_key.into_raw().cast(),
                        value.as_ptr(),
                        value.len().try_into()?,
                    )
                },
                "SCardWriteCacheA failed"
            )
        }
    }

    fn list_reader_groups(&self) -> WinScardResult<Vec<Cow<'_, str>>> {
        let mut reader_groups_buf_len = 0;

        #[cfg(not(target_os = "windows"))]
        {
            // https://pcsclite.apdu.fr/api/group__API.html#ga9d970d086d5218e080d0079d63f9d496
            //
            // If the application sends mszGroups as NULL then this function will return the size of the buffer needed to allocate in pcchGroups.
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `mszGroups` can be null.
                // - `&mut reader_groups_buf_len` is a properly-aligned, writable pointer to a local variable.
                unsafe { (self.api.SCardListReaderGroups)(self.h_context, null_mut(), &mut reader_groups_buf_len) },
                "SCardListReaderGroups failed"
            )?;
        }
        #[cfg(target_os = "windows")]
        {
            // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardlistreadergroupsw
            //
            // If this value is NULL, SCardListReaderGroups ignores the buffer length supplied in pcchGroups,
            // writes the length of the buffer that would have been returned if this parameter had not been
            // NULL to pcchGroups, and returns a success code.
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `mszGroups` can be null.
                // - `&mut reader_groups_buf_len` is a properly-aligned, writable pointer to a local variable.
                unsafe { (self.api.SCardListReaderGroupsA)(self.h_context, null_mut(), &mut reader_groups_buf_len) },
                "SCardListReaderGroupsA failed"
            )?;
        }

        let mut reader_groups = vec![0; reader_groups_buf_len.try_into()?];

        #[cfg(not(target_os = "windows"))]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `reader_groups.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `reader_groups_buf_len`.
                // - `&mut reader_groups_buf_len` is a properly-aligned, writable pointer to a local variable.
                //   The length is correct because it was set by a previous call to `SCardListReaderGroupsA`.
                unsafe {
                    (self.api.SCardListReaderGroups)(
                        self.h_context,
                        reader_groups.as_mut_ptr(),
                        &mut reader_groups_buf_len,
                    )
                },
                "SCardListReaderGroups failed"
            )?;
        }
        #[cfg(target_os = "windows")]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `reader_groups.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `reader_groups_buf_len`.
                // - `&mut reader_groups_buf_len` is a properly-aligned, writable pointer to a local variable.
                //   The length is correct because it was set by a previous call to `SCardListReaderGroupsA`.
                unsafe {
                    (self.api.SCardListReaderGroupsA)(
                        self.h_context,
                        reader_groups.as_mut_ptr(),
                        &mut reader_groups_buf_len,
                    )
                },
                "SCardListReaderGroupsA failed"
            )?;
        }

        parse_multi_string_owned(&reader_groups)
    }

    fn cancel(&mut self) -> WinScardResult<()> {
        // SAFETY: `h_context` is set by a previous call to `SCardEstablishContext`.
        try_execute!(unsafe { (self.api.SCardCancel)(self.h_context) }, "SCardCancel failed")
    }

    #[instrument(ret)]
    fn get_status_change(&mut self, timeout: u32, reader_states: &mut [ReaderState<'_>]) -> WinScardResult<()> {
        use std::ffi::NulError;

        #[cfg(target_os = "windows")]
        use ffi_types::winscard::ScardReaderStateA as ScardReaderState;
        use winscard::winscard::CurrentState;

        #[cfg(not(target_os = "windows"))]
        use crate::winscard::pcsc_lite::ScardReaderState;

        let mut states = Vec::with_capacity(reader_states.len());
        let c_readers = reader_states
            .iter()
            .map(|reader_state| CString::new(reader_state.reader_name.as_ref()))
            .collect::<Result<Vec<CString>, NulError>>()?;

        for (reader_state, c_reader) in reader_states.iter_mut().zip(c_readers.iter()) {
            states.push(ScardReaderState {
                sz_reader: c_reader.as_ptr().cast(),
                pv_user_data: ptr::with_exposed_provenance_mut(reader_state.user_data),
                dw_current_state: reader_state.current_state.bits(),
                dw_event_state: reader_state.event_state.bits(),
                cb_atr: reader_state.atr_len.try_into()?,
                rgb_atr: reader_state.atr,
            });
        }

        #[cfg(not(target_os = "windows"))]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `states.as_mut_ptr()` is a properly-aligned, both readable and writable pointer
                //   to a locally allocated `Vec` that contains `ScardReaderStateA` structures.
                // - `states.len()` is a valid length of a `states` array.
                unsafe {
                    (self.api.SCardGetStatusChange)(
                        self.h_context,
                        #[allow(clippy::useless_conversion)]
                        timeout.into(),
                        states.as_mut_ptr(),
                        states.len().try_into()?,
                    )
                },
                "SCardGetStatusChange failed"
            )?;
        }
        #[cfg(target_os = "windows")]
        {
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `states.as_mut_ptr()` is a properly-aligned, both readable and writable pointer
                //   to a locally allocated `Vec` that contains `ScardReaderStateA` structures.
                // - `states.len()` is a valid length of a `states` array.
                unsafe {
                    (self.api.SCardGetStatusChangeA)(
                        self.h_context,
                        timeout,
                        states.as_mut_ptr(),
                        states.len().try_into()?,
                    )
                },
                "SCardGetStatusChangeA failed"
            )?;
        }

        // We do not need to change all fields. Only event state and atr values can be changed.
        for (state, reader_state) in states.iter().zip(reader_states.iter_mut()) {
            reader_state.event_state = CurrentState::from_bits(state.dw_event_state)
                .ok_or_else(|| Error::new(ErrorKind::InternalError, "invalid dwEventState"))?;
            reader_state.atr_len = state.cb_atr.try_into()?;
            reader_state.atr = state.rgb_atr;
        }

        Ok(())
    }

    fn list_cards(
        &self,
        _atr: Option<&[u8]>,
        _required_interfaces: Option<&[Uuid]>,
    ) -> WinScardResult<Vec<Cow<'_, str>>> {
        #[cfg(not(target_os = "windows"))]
        {
            Ok(vec![Cow::Borrowed(DEFAULT_CARD_NAME)])
        }
        #[cfg(target_os = "windows")]
        {
            use crate::winscard::system_scard::uuid_to_c_guid;

            let mut cards_buf_len = 0;
            let atr = _atr.map(|a| a.as_ptr()).unwrap_or(null());
            let uuids = _required_interfaces
                .into_iter()
                .flatten()
                .cloned()
                .map(uuid_to_c_guid)
                .collect::<Vec<ffi_types::Uuid>>();
            let uuids_len = uuids.len().try_into()?;
            let c_uuids = if uuids.is_empty() { null() } else { uuids.as_ptr() };

            // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardlistcardsw
            //
            // mszCards: If this value is NULL, SCardListCards ignores the buffer length supplied in
            // pcchCards, returning the length of the buffer that would have been returned if this
            // parameter had not been NULL to pcchCards and a success code.
            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `atr` TODO: Clarify the safety requirement.
                // - `c_uuids` can be null. If it's non-null, it's a properly-aligned, readable pointer to a locally allocated `Vec`.
                // - `uuids_len` is a valid length for `c_uuids` array.
                // - `mszCards` can be null.
                // - `&mut cards_buf_len` is a properly-aligned, both readable and writable pointer to a local variable.
                unsafe {
                    (self.api.SCardListCardsA)(self.h_context, atr, c_uuids, uuids_len, null_mut(), &mut cards_buf_len)
                },
                "SCardListCardsA failed"
            )?;

            let mut cards = vec![0; cards_buf_len.try_into()?];

            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `atr` TODO: Clarify the safety requirement.
                // - `c_uuids` can be null. If it's non-null, it's a properly-aligned, readable pointer to a locally allocated `Vec`.
                // - `uuids_len` is a valid length for `c_uuids` array.
                // - `cards.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `cards_buf_len`.
                // - `&mut cards_buf_len` is a properly-aligned, both readable and writable pointer to a local variable.
                //   The length is correct because it was set by a previous call to `SCardListCardsA`.
                unsafe {
                    (self.api.SCardListCardsA)(
                        self.h_context,
                        atr,
                        c_uuids,
                        uuids_len,
                        cards.as_mut_ptr(),
                        &mut cards_buf_len,
                    )
                },
                "SCardListCardsA failed"
            )?;

            parse_multi_string_owned(&cards)
        }
    }

    fn get_card_type_provider_name(&self, _card_name: &str, provider_id: ProviderId) -> WinScardResult<Cow<'_, str>> {
        #[cfg(not(target_os = "windows"))]
        {
            Ok(match provider_id {
                ProviderId::Primary => {
                    return Err(Error::new(
                        ErrorKind::UnsupportedFeature,
                        "ProviderId::Primary is not supported for emulated smart card",
                    ));
                }
                ProviderId::Csp => winscard::MICROSOFT_DEFAULT_CSP.into(),
                ProviderId::Ksp => winscard::MICROSOFT_DEFAULT_KSP.into(),
                ProviderId::CardModule => winscard::MICROSOFT_SCARD_DRIVER_LOCATION.into(),
            })
        }
        #[cfg(target_os = "windows")]
        {
            use crate::winscard::buf_alloc::SCARD_AUTOALLOCATE;

            let mut data_len = SCARD_AUTOALLOCATE;
            let mut data: *mut u8 = null_mut();

            let c_card_name = CString::new(_card_name)?;

            try_execute!(
                // SAFETY:
                // - `h_context` is set by a previous call to `SCardEstablishContext`.
                // - `c_card_name` is a valid, null-terminated C String due to the `CString` type.
                // - `&mut data` is a properly-aligned, writable pointer to a local pointer. It can
                //   be null because it receives the provider name upon successful completion of this function.
                unsafe {
                    (self.api.SCardGetCardTypeProviderNameA)(
                        self.h_context,
                        c_card_name.as_ptr().cast(),
                        provider_id.into(),
                        ((&mut data) as *mut *mut u8).cast(),
                        &mut data_len,
                    )
                },
                "SCardGetCardTypeProviderNameA failed"
            )?;

            let data_len: usize = if let Ok(len) = data_len.try_into() {
                len
            } else {
                try_execute!(
                    // SAFETY:
                    // - `h_context` is set by a previous call to `SCardEstablishContext`.
                    // - `data` is a valid pointer that was allocated by a previous call to `SCardGetCardTypeProviderNameA`.
                    unsafe { (self.api.SCardFreeMemory)(self.h_context, data.cast()) },
                    "SCardFreeMemory failed"
                )?;

                return Err(Error::new(ErrorKind::InternalError, "u32 to usize conversion error"));
            };

            let name = if let Ok(name) = String::from_utf8(
                // SAFETY: `data` pointer is a local pointer that was initialized by `SCardGetCardTypeProviderNameA` function.
                unsafe { from_raw_parts(data, data_len) }.to_vec(),
            ) {
                name
            } else {
                try_execute!(
                    // SAFETY:
                    // - `h_context` is set by a previous call to `SCardEstablishContext`.
                    // - `data` is a valid pointer that was allocated by a previous call to `SCardGetCardTypeProviderNameA`.
                    unsafe { (self.api.SCardFreeMemory)(self.h_context, data.cast()) },
                    "SCardFreeMemory failed"
                )?;

                return Err(Error::new(ErrorKind::InternalError, "u32 to usize conversion error"));
            };

            Ok(Cow::Owned(name))
        }
    }
}
