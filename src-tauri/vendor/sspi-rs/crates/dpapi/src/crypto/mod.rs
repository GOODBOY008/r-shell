mod kout;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, KeySizeUser, Nonce, aes};
use aes_kw::AesKw;
use digest::array::Array;
use dpapi_core::str::{encode_utf16_le, str_utf16_len};
use dpapi_core::{EncodeVec, WriteCursor, decode_owned};
use dpapi_pdu::gkdi::{EcdhKey, EllipticCurve, FfcdhKey, GroupKeyEnvelope, HashAlg};
use elliptic_curve::bigint::{BoxedUint, Odd};
use picky_asn1_x509::enveloped_data::{ContentEncryptionAlgorithmIdentifier, KeyEncryptionAlgorithmIdentifier};
use picky_asn1_x509::{AesParameters, AlgorithmIdentifierParameters, oids};
use picky_krb::crypto::aes::AES256_KEY_SIZE;
use rand::rngs::{StdRng, SysRng};
use rand_core::{Rng as _, SeedableRng as _};
use sspi::modpow;
use thiserror::Error;
use uuid::Uuid;

use crate::{Error, Result};

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid {name} algorithm id: expected {expected} but got {actual}")]
    InvalidAlgorithm {
        name: &'static str,
        expected: String,
        actual: String,
    },

    #[error("invalid AES parameters: {reason}")]
    InvalidAesParams {
        reason: &'static str,
        parameters: AlgorithmIdentifierParameters,
    },

    #[error("invalid elliptic curve point")]
    InvalidEllipticCurvePoint,

    #[error("invalid or unsupported secret algorithm: {0}")]
    InvalidSecretAlg(String),

    #[error("missing elliptic curve point {0} coordinate")]
    MissingPointCoordinate(&'static str),

    #[error(transparent)]
    EllipticCurve(#[from] elliptic_curve::Error),

    #[error(transparent)]
    ConcatKdf(#[from] concat_kdf::Error),

    #[error(transparent)]
    IntConversion(#[from] std::num::TryFromIntError),

    #[error(transparent)]
    AesGcm(#[from] aes_gcm::Error),

    #[error(transparent)]
    AesKw(#[from] aes_kw::Error),

    #[error("{0} is uninitialized")]
    Uninitialized(&'static str),

    #[error("invalid key length: expected {expected} bytes but got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },

    #[error("unsupported KBKDF output key length: {0}")]
    UnsupportedKbkdfOutputKeyLength(usize),

    #[error("key derivation error: {0}")]
    Kbkdf(#[from] kbkdf::Error),

    #[error(transparent)]
    RandError(#[from] rand::rngs::SysError),

    #[error("invalid iv length(expected {expected}, but got {actual})")]
    InvalidIvLength { actual: usize, expected: usize },
}

pub type CryptoResult<T> = std::result::Result<T, CryptoError>;

// "KDS service\0" encoded in UTF16 le.
pub const KDS_SERVICE_LABEL: &[u8] = &[
    75, 0, 68, 0, 83, 0, 32, 0, 115, 0, 101, 0, 114, 0, 118, 0, 105, 0, 99, 0, 101, 0, 0, 0,
];

type KekAes256 = AesKw<aes::Aes256>;

pub fn cek_decrypt(
    algorithm: &KeyEncryptionAlgorithmIdentifier,
    kek: &[u8],
    wrapped_key: &[u8],
) -> CryptoResult<Vec<u8>> {
    if algorithm.oid() != &oids::aes256_wrap() {
        return Err(CryptoError::InvalidAlgorithm {
            name: "aes256-wrap",
            expected: oids::aes256_wrap().into(),
            actual: algorithm.oid().into(),
        });
    }

    let key = Key::<Aes256Gcm>::try_from(kek).map_err(|_| CryptoError::InvalidKeyLength {
        expected: Aes256Gcm::key_size(),
        actual: kek.len(),
    })?;
    let kek = KekAes256::new(&key);

    let mut out_buf = vec![0; key.len()];

    kek.unwrap_key(wrapped_key, &mut out_buf)?;

    Ok(out_buf)
}

pub fn cek_encrypt(algorithm: &KeyEncryptionAlgorithmIdentifier, kek: &[u8], key: &[u8]) -> CryptoResult<Vec<u8>> {
    if algorithm.oid() != &oids::aes256_wrap() {
        return Err(CryptoError::InvalidAlgorithm {
            name: "aes256-wrap",
            expected: oids::aes256_wrap().into(),
            actual: algorithm.oid().into(),
        });
    }
    let kek = Key::<Aes256Gcm>::try_from(kek).map_err(|_| CryptoError::InvalidKeyLength {
        expected: Aes256Gcm::key_size(),
        actual: kek.len(),
    })?;
    let kek = KekAes256::new(&kek);
    let mut out_buf = vec![0; aes_kw::IV_LEN + key.len()];
    kek.wrap_key(key, &mut out_buf)?;
    Ok(out_buf)
}

pub fn cek_generate(algorithm: &KeyEncryptionAlgorithmIdentifier) -> CryptoResult<(Vec<u8>, Vec<u8>)> {
    if algorithm.oid() != &oids::aes256_wrap() {
        return Err(CryptoError::InvalidAlgorithm {
            name: "aes256-wrap",
            expected: oids::aes256_wrap().into(),
            actual: algorithm.oid().into(),
        });
    }

    let mut rng = StdRng::try_from_rng(&mut SysRng)?;

    let mut cek = Key::<Aes256Gcm>::default();
    rng.fill_bytes(&mut cek);

    let mut iv = [0u8; 12];
    rng.fill_bytes(&mut iv);

    Ok((cek.to_vec(), iv.to_vec()))
}

fn extract_iv(parameters: &AlgorithmIdentifierParameters) -> CryptoResult<&[u8]> {
    if let AlgorithmIdentifierParameters::Aes(aes_parameters) = parameters {
        if let AesParameters::InitializationVector(iv) = aes_parameters {
            Ok(iv.0.as_slice())
        } else if let AesParameters::AuthenticatedEncryptionParameters(enc_params) = aes_parameters {
            Ok(enc_params.nonce())
        } else {
            Err(CryptoError::InvalidAesParams {
                reason: "expected AES initialization vector",
                parameters: parameters.clone(),
            })
        }
    } else {
        Err(CryptoError::InvalidAesParams {
            reason: "provided ones are not AES parameters",
            parameters: parameters.clone(),
        })
    }
}

pub fn content_decrypt(
    algorithm: &ContentEncryptionAlgorithmIdentifier,
    cek: &[u8],
    data: &[u8],
) -> CryptoResult<Vec<u8>> {
    if algorithm.oid() != &oids::aes256_gcm() {
        return Err(CryptoError::InvalidAlgorithm {
            name: "aes256-gcm",
            expected: oids::aes256_gcm().into(),
            actual: algorithm.oid().into(),
        });
    }

    let iv = extract_iv(algorithm.parameters())?;
    let iv = Nonce::try_from(iv).map_err(|_| CryptoError::InvalidIvLength {
        actual: iv.len(),
        expected: 12,
    })?;

    let key = Key::<Aes256Gcm>::try_from(cek).map_err(|_| CryptoError::InvalidKeyLength {
        expected: Aes256Gcm::key_size(),
        actual: cek.len(),
    })?;
    let cipher = Aes256Gcm::new(&key);
    Ok(cipher.decrypt(&iv, data)?)
}

pub fn content_encrypt(
    algorithm: &ContentEncryptionAlgorithmIdentifier,
    cek: &[u8],
    plaintext: &[u8],
) -> CryptoResult<Vec<u8>> {
    if algorithm.oid() != &oids::aes256_gcm() {
        return Err(CryptoError::InvalidAlgorithm {
            name: "aes256-gcm",
            expected: oids::aes256_gcm().into(),
            actual: algorithm.oid().into(),
        });
    }

    let iv = extract_iv(algorithm.parameters())?;
    let nonce = Nonce::try_from(iv).map_err(|_| CryptoError::InvalidIvLength {
        actual: iv.len(),
        expected: 12,
    })?;

    let key = Key::<Aes256Gcm>::try_from(cek).map_err(|_| CryptoError::InvalidKeyLength {
        expected: Aes256Gcm::key_size(),
        actual: cek.len(),
    })?;
    let cipher = Aes256Gcm::new(&key);
    Ok(cipher.encrypt(&nonce, plaintext)?)
}

pub fn kdf(algorithm: HashAlg, secret: &[u8], label: &[u8], context: &[u8], length: usize) -> CryptoResult<Vec<u8>> {
    use hmac::Hmac;
    use kbkdf::{Counter, Kbkdf, Params};
    use kout::*;

    macro_rules! derive_key {
        ($prf_ty:ty, { $($l_value:expr => $l_ty:ty,)* }) => {
            $(
                if $l_value == length {
                    return Ok(Counter::<$prf_ty, $l_ty>::default()
                        .derive(Params::builder(secret).with_label(label).with_context(context).use_counter(true).use_l(true).build())?
                        .to_vec());
                }
            )*
        };
    }

    match algorithm {
        HashAlg::Sha1 => {
            derive_key!(Hmac<sha1::Sha1>, { 32 => Kout32, 64 => Kout64, });
        }
        HashAlg::Sha256 => {
            derive_key!(Hmac<sha2::Sha256>, { 32 => Kout32, 64 => Kout64, });
        }
        HashAlg::Sha384 => {
            derive_key!(Hmac<sha2::Sha384>, { 32 => Kout32, 64 => Kout64, });
        }
        HashAlg::Sha512 => {
            derive_key!(Hmac<sha2::Sha512>, { 32 => Kout32, 64 => Kout64, });
        }
    }

    Err(CryptoError::UnsupportedKbkdfOutputKeyLength(length))
}

fn kdf_concat(
    algorithm: HashAlg,
    shared_secret: &[u8],
    algorithm_id: &[u8],
    party_uinfo: &[u8],
    party_vinfo: &[u8],
) -> CryptoResult<Vec<u8>> {
    let mut other_info = algorithm_id.to_vec();
    other_info.extend_from_slice(party_uinfo);
    other_info.extend_from_slice(party_vinfo);

    let mut key = match algorithm {
        HashAlg::Sha1 => vec![0; 20],
        HashAlg::Sha256 => vec![0; 32],
        HashAlg::Sha384 => vec![0; 48],
        HashAlg::Sha512 => vec![0; 64],
    };

    match algorithm {
        HashAlg::Sha1 => concat_kdf::derive_key_into::<sha1::Sha1>(shared_secret, &other_info, &mut key)?,
        HashAlg::Sha256 => concat_kdf::derive_key_into::<sha2::Sha256>(shared_secret, &other_info, &mut key)?,
        HashAlg::Sha384 => concat_kdf::derive_key_into::<sha2::Sha384>(shared_secret, &other_info, &mut key)?,
        HashAlg::Sha512 => concat_kdf::derive_key_into::<sha2::Sha512>(shared_secret, &other_info, &mut key)?,
    }

    Ok(key)
}

fn compute_kdf_context(key_guid: Uuid, l0: i32, l1: i32, l2: i32) -> Vec<u8> {
    let mut buf = vec![0; 28];

    buf[0..16].copy_from_slice(&key_guid.to_bytes_le());
    buf[16..20].copy_from_slice(&l0.to_le_bytes());
    buf[20..24].copy_from_slice(&l1.to_le_bytes());
    buf[24..28].copy_from_slice(&l2.to_le_bytes());

    buf
}

pub fn compute_l1_key(
    target_sd: &[u8],
    root_key_id: Uuid,
    l0: i32,
    root_key: &[u8],
    algorithm: HashAlg,
) -> CryptoResult<Vec<u8>> {
    // Note: 512 is number of bits, we use byte length here
    // Key(SD, RK, L0, -1, -1) = KDF(
    //   HashAlg,
    //   RK.msKds-RootKeyData,
    //   "KDS service",
    //   RKID || L0 || 0xffffffff || 0xffffffff,
    //   512
    // )
    let l0_seed = kdf(
        algorithm,
        root_key,
        KDS_SERVICE_LABEL,
        &compute_kdf_context(root_key_id, l0, -1, -1),
        64,
    )?;

    // Key(SD, RK, L0, 31, -1) = KDF(
    //   HashAlg,
    //   Key(SD, RK, L0, -1, -1),
    //   "KDS service",
    //   RKID || L0 || 31 || 0xffffffff || SD,
    //   512
    // )
    let mut kdf_context = compute_kdf_context(root_key_id, l0, 31, -1);
    kdf_context.extend_from_slice(target_sd);

    kdf(algorithm, &l0_seed, KDS_SERVICE_LABEL, &kdf_context, 64)
}

pub fn compute_l2_key(
    algorithm: HashAlg,
    request_l1: i32,
    request_l2: i32,
    rk: &GroupKeyEnvelope,
) -> CryptoResult<Vec<u8>> {
    let mut l1 = rk.l1;
    let mut l1_key = rk.l1_key.clone();
    let mut l2 = rk.l2;
    let mut l2_key = rk.l2_key.clone();
    let mut reseed_l2 = l2 == 31 || rk.l1 != request_l1;

    //  MS-GKDI 2.2.4 Group key Envelope
    //  If the value in the L2 index field is equal to 31, this contains the
    //  L1 key with group key identifier (L0 index, L1 index, -1). In all
    //  other cases, this field contains the L1 key with group key identifier
    //  (L0 index, L1 index - 1, -1). If this field is present, its length
    //  MUST be equal to 64 bytes.
    if l2 != 31 && l1 != request_l1 {
        l1 -= 1;
    }

    while l1 != request_l1 {
        reseed_l2 = true;
        l1 -= 1;

        l1_key = kdf(
            algorithm,
            &l1_key,
            KDS_SERVICE_LABEL,
            &compute_kdf_context(rk.root_key_identifier, rk.l0, l1, -1),
            64,
        )?;
    }

    if reseed_l2 {
        l2 = 31;
        l2_key = kdf(
            algorithm,
            &l1_key,
            KDS_SERVICE_LABEL,
            &compute_kdf_context(rk.root_key_identifier, rk.l0, l1, l2),
            64,
        )?;
    }

    while l2 != request_l2 {
        l2 -= 1;

        l2_key = kdf(
            algorithm,
            &l2_key,
            KDS_SERVICE_LABEL,
            &compute_kdf_context(rk.root_key_identifier, rk.l0, l1, l2),
            64,
        )?;
    }

    Ok(l2_key)
}

pub fn compute_kek_from_public_key(
    algorithm: HashAlg,
    seed: &[u8],
    secret_algorithm: &str,
    public_key: &[u8],
    private_key_length: usize,
) -> Result<Vec<u8>> {
    let mut encoded_secret_algorithm = vec![0; str_utf16_len(secret_algorithm)];
    encode_utf16_le(
        secret_algorithm,
        &mut WriteCursor::new(encoded_secret_algorithm.as_mut_slice()),
    );

    let private_key = kdf(
        algorithm,
        seed,
        KDS_SERVICE_LABEL,
        &encoded_secret_algorithm,
        private_key_length,
    )?;

    compute_kek(algorithm, secret_algorithm, &private_key, public_key)
}

pub fn compute_kek(
    algorithm: HashAlg,
    secret_algorithm: &str,
    private_key: &[u8],
    public_key: &[u8],
) -> Result<Vec<u8>> {
    let (shared_secret, secret_hash_algorithm) = if secret_algorithm == "DH" {
        let dh_pub_key: FfcdhKey = decode_owned(public_key)?;
        let modulus = Odd::new(dh_pub_key.field_order)
            .into_option()
            .ok_or(Error::ModulusIsNotOdd)?;

        let shared_secret = modpow(
            &dh_pub_key.public_key,
            &BoxedUint::from_be_slice_vartime(private_key),
            modulus,
        );
        let mut shared_secret = shared_secret.to_be_bytes_trimmed_vartime().into_vec();

        while shared_secret.len() < usize::try_from(dh_pub_key.key_length)? {
            shared_secret.insert(0, 0);
        }

        (shared_secret, HashAlg::Sha256)
    } else if secret_algorithm.starts_with("ECDH_P") {
        use elliptic_curve::sec1::FromSec1Point;
        use elliptic_curve::{PublicKey, SecretKey};

        let ecdh_pub_key_info: EcdhKey = decode_owned(public_key)?;

        match ecdh_pub_key_info.curve {
            EllipticCurve::P256 => {
                let x = Array::try_from(ecdh_pub_key_info.x.to_be_bytes())
                    .map_err(|_| CryptoError::InvalidEllipticCurvePoint)?;
                let y = Array::try_from(ecdh_pub_key_info.y.to_be_bytes())
                    .map_err(|_| CryptoError::InvalidEllipticCurvePoint)?;
                let public_key: p256::PublicKey = Option::from(PublicKey::from_sec1_point(
                    &p256::Sec1Point::from_affine_coordinates(&x, &y, false),
                ))
                .ok_or(CryptoError::InvalidEllipticCurvePoint)?;

                let secret_key = SecretKey::from_slice(private_key).map_err(CryptoError::from)?;
                let shared_secret: p256::ecdh::SharedSecret =
                    p256::ecdh::diffie_hellman(secret_key.to_nonzero_scalar(), public_key.as_affine());

                (shared_secret.raw_secret_bytes().as_slice().to_vec(), HashAlg::Sha256)
            }
            EllipticCurve::P384 => {
                let x = Array::try_from(ecdh_pub_key_info.x.to_be_bytes())
                    .map_err(|_| CryptoError::InvalidEllipticCurvePoint)?;
                let y = Array::try_from(ecdh_pub_key_info.y.to_be_bytes())
                    .map_err(|_| CryptoError::InvalidEllipticCurvePoint)?;
                let public_key: p384::PublicKey = Option::from(PublicKey::from_sec1_point(
                    &p384::Sec1Point::from_affine_coordinates(&x, &y, false),
                ))
                .ok_or(CryptoError::InvalidEllipticCurvePoint)?;
                let secret_key = SecretKey::from_slice(private_key).map_err(CryptoError::from)?;
                let shared_secret: p384::ecdh::SharedSecret =
                    p384::ecdh::diffie_hellman(secret_key.to_nonzero_scalar(), public_key.as_affine());

                (shared_secret.raw_secret_bytes().as_slice().to_vec(), HashAlg::Sha384)
            }
            EllipticCurve::P521 => {
                let x = Array::try_from(ecdh_pub_key_info.x.to_be_bytes())
                    .map_err(|_| CryptoError::InvalidEllipticCurvePoint)?;
                let y = Array::try_from(ecdh_pub_key_info.y.to_be_bytes())
                    .map_err(|_| CryptoError::InvalidEllipticCurvePoint)?;
                let public_key: p521::PublicKey = Option::from(PublicKey::from_sec1_point(
                    &p521::Sec1Point::from_affine_coordinates(&x, &y, false),
                ))
                .ok_or(CryptoError::InvalidEllipticCurvePoint)?;
                let secret_key = SecretKey::from_slice(private_key).map_err(CryptoError::from)?;
                let shared_secret: p521::ecdh::SharedSecret =
                    p384::ecdh::diffie_hellman(secret_key.to_nonzero_scalar(), public_key.as_affine());

                (shared_secret.raw_secret_bytes().as_slice().to_vec(), HashAlg::Sha512)
            }
        }
    } else {
        Err(CryptoError::InvalidSecretAlg(secret_algorithm.to_owned()))?
    };

    // "KDS public key\0" encoded in UTF16 le.
    let kek_context = &[
        75, 0, 68, 0, 83, 0, 32, 0, 112, 0, 117, 0, 98, 0, 108, 0, 105, 0, 99, 0, 32, 0, 107, 0, 101, 0, 121, 0, 0, 0,
    ];

    // This part isn't documented but we use the key derivation algorithm
    // SP 800-56A to derive the kek secret input value. On Windows this uses
    // BCryptDeriveKey with the following parameters.
    //   KDF_ALGORITHMID - SHA512
    //   KDF_PARTYUINFO  - KDS public key
    //   KDF_PARTYVINFO  - KDS service
    // Each of these is just appended to the otherinfo value used in
    // cryptography as the UTF-16-LE NULL terminated strings.
    let secret = kdf_concat(
        secret_hash_algorithm,
        &shared_secret,
        // "SHA512\0" encoded in UTF16 le.
        &[83, 0, 72, 0, 65, 0, 53, 0, 49, 0, 50, 0, 0, 0],
        kek_context,
        KDS_SERVICE_LABEL,
    )?;

    Ok(kdf(
        algorithm,
        &secret,
        KDS_SERVICE_LABEL,
        kek_context,
        AES256_KEY_SIZE,
    )?)
}

pub fn compute_public_key(secret_algorithm: &str, private_key: &[u8], peer_public_key: &[u8]) -> Result<Vec<u8>> {
    if secret_algorithm == "DH" {
        let FfcdhKey {
            key_length,
            field_order,
            generator,
            public_key: _,
        } = decode_owned(peer_public_key)?;

        let modulus = Odd::new(field_order.clone())
            .into_option()
            .ok_or(Error::ModulusIsNotOdd)?;
        let my_pub_key = modpow(&generator, &BoxedUint::from_be_slice_vartime(private_key), modulus);

        Ok(FfcdhKey {
            key_length,
            field_order,
            generator,
            public_key: my_pub_key,
        }
        .encode_vec()?)
    } else if secret_algorithm.starts_with("ECDH_P") {
        use elliptic_curve::sec1::ToSec1Point;

        let ecdh_pub_key_info: EcdhKey = decode_owned(peer_public_key)?;

        let (x, y) = match ecdh_pub_key_info.curve {
            EllipticCurve::P256 => {
                let secret_key = p256::SecretKey::from_slice(private_key).map_err(CryptoError::from)?;
                let public_key = secret_key.public_key();
                let point = public_key.to_sec1_point(false);

                (
                    BoxedUint::from_be_slice_vartime(point.x().ok_or(CryptoError::MissingPointCoordinate("x"))?),
                    BoxedUint::from_be_slice_vartime(point.y().ok_or(CryptoError::MissingPointCoordinate("y"))?),
                )
            }
            EllipticCurve::P384 => {
                let secret_key = p384::SecretKey::from_slice(private_key).map_err(CryptoError::from)?;
                let public_key = secret_key.public_key();
                let point = public_key.to_sec1_point(false);

                (
                    BoxedUint::from_be_slice_vartime(point.x().ok_or(CryptoError::MissingPointCoordinate("x"))?),
                    BoxedUint::from_be_slice_vartime(point.y().ok_or(CryptoError::MissingPointCoordinate("y"))?),
                )
            }
            EllipticCurve::P521 => {
                let secret_key = p521::SecretKey::from_slice(private_key).map_err(CryptoError::from)?;
                let public_key = secret_key.public_key();
                let point = public_key.to_sec1_point(false);

                (
                    BoxedUint::from_be_slice_vartime(point.x().ok_or(CryptoError::MissingPointCoordinate("x"))?),
                    BoxedUint::from_be_slice_vartime(point.y().ok_or(CryptoError::MissingPointCoordinate("y"))?),
                )
            }
        };

        Ok(EcdhKey {
            curve: ecdh_pub_key_info.curve,
            key_length: ecdh_pub_key_info.key_length,
            x,
            y,
        }
        .encode_vec()?)
    } else {
        Ok(Err(CryptoError::InvalidSecretAlg(secret_algorithm.to_owned()))?)
    }
}
