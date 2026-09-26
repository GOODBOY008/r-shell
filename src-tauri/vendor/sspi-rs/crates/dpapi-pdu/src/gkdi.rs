use alloc::borrow::ToOwned;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use core::{fmt, mem};

use crypto_bigint::BoxedUint;
use dpapi_core::str::{encode_utf16_le, read_c_str_utf16_le, str_utf16_len};
use dpapi_core::{
    DecodeError, DecodeOwned, DecodeResult, Encode, EncodeError, EncodeResult, FixedPartSize, InvalidFieldErr,
    OtherErr, ReadCursor, StaticName, WriteCursor, cast_int, cast_length, compute_padding, decode_uuid, encode_uuid,
    ensure_size, read_padding, write_padding,
};
use thiserror::Error;
use uuid::Uuid;

use crate::Error;

pub const KDF_ALGORITHM_NAME: &str = "SP800_108_CTR_HMAC";

#[derive(Debug, Error)]
pub enum GkdiError {
    #[error("invalid hash algorithm name: {0}")]
    InvalidHashName(String),

    #[error("invalid {name} version: expected {expected} but got {actual}")]
    InvalidVersion {
        name: &'static str,
        expected: u32,
        actual: u32,
    },

    #[error("invalid {name} magic bytes")]
    InvalidMagic {
        name: &'static str,
        expected: &'static [u8],
        actual: Vec<u8>,
    },

    #[error("invalid elliptic curve id")]
    InvalidEllipticCurveId(Vec<u8>),
}

pub type GkdiResult<T> = Result<T, GkdiError>;

impl From<GkdiError> for DecodeError {
    fn from(err: GkdiError) -> Self {
        match &err {
            GkdiError::InvalidHashName(_) => {
                DecodeError::invalid_field("KdfParameters", "hash algorithm", "invalid value")
            }
            GkdiError::InvalidVersion { .. } => DecodeError::invalid_field("", "version", "invalid version"),
            GkdiError::InvalidEllipticCurveId(_) => {
                DecodeError::invalid_field("EcdhKey", "elliptic curve id", "invalid value")
            }
            GkdiError::InvalidMagic { .. } => DecodeError::invalid_field("", "magic", "invalid value"),
        }
        .with_source(err)
    }
}

/// GetKey RPC Request
///
/// This can be used to build the stub data for the GetKey RPC request.
/// The syntax for this function is defined in []`MS-GKDI 3.1.4.1 GetKey (Opnum 0)`](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/4cac87a3-521e-4918-a272-240f8fabed39)
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct GetKey {
    /// The the security descriptor for which the group key is being requested.
    pub target_sd: Vec<u8>,
    /// This parameter represents the root key identifier of the requested key. It can be set to NULL.
    pub root_key_id: Option<Uuid>,
    /// This parameter represents the L0 index of the requested group key.
    /// It MUST be a signed 32-bit integer greater than or equal to -1.
    pub l0_key_id: i32,
    /// This parameter represents the L1 index of the requested group key.
    /// It MUST be a signed 32-bit integer between -1 and 31 (inclusive).
    pub l1_key_id: i32,
    /// This parameter represents the L2 index of the requested group key.
    /// It MUST be a 32-bit integer between -1 and 31 (inclusive).
    pub l2_key_id: i32,
}

impl GetKey {
    pub const OPNUM: u16 = 0;
}

impl StaticName for GetKey {
    const NAME: &'static str = "GetKey";
}

impl Encode for GetKey {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        let target_sd_len = cast_length!("GetKey", "target_sd", self.target_sd.len())?;
        // cbTargetSD
        dst.write_u64(target_sd_len);
        // pbTargetSD - pointer header includes the length + padding
        dst.write_u64(target_sd_len);

        dst.write_slice(&self.target_sd);

        write_padding(compute_padding(8, self.target_sd.len()), dst)?;

        if let Some(root_key_id) = self.root_key_id.as_ref() {
            dst.write_slice(&[0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]);
            encode_uuid(*root_key_id, dst)?;
        } else {
            dst.write_u64(0);
        };

        dst.write_i32(self.l0_key_id);
        dst.write_i32(self.l1_key_id);
        dst.write_i32(self.l2_key_id);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        8 /* cbTargetSD */ + 8 /* pbTartetSD */ + self.target_sd.len() + compute_padding(8, self.target_sd.len())
        + if self.root_key_id.is_some() { 8 + Uuid::FIXED_PART_SIZE } else { 8 }
        + 4 /* l0 */ + 4 /* l1 */ + 4 /* l2 */
    }
}

impl DecodeOwned for GetKey {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: 8 /* target_sd_len */ + 8 /* offset */);

        let target_sd_len = { cast_int!("GetKey", "target_sd len", src.read_u64()) as DecodeResult<_> }?;
        let _offset = src.read_u64();

        ensure_size!(in: src, size: target_sd_len);
        let target_sd = src.read_slice(target_sd_len).to_vec();

        read_padding(compute_padding(8, target_sd_len), src)?;

        ensure_size!(in: src, size: 8);
        let root_key_id = if src.read_u64() != 0 {
            Some(decode_uuid(src)?)
        } else {
            None
        };

        ensure_size!(in: src, size: 4 * 3);
        let l0_key_id = src.read_i32();
        let l1_key_id = src.read_i32();
        let l2_key_id = src.read_i32();

        Ok(Self {
            target_sd,
            root_key_id,
            l0_key_id,
            l1_key_id,
            l2_key_id,
        })
    }
}

/// Supported hash algorithms.
///
/// It contains hash algorithms that are listed in the documentation:
/// https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/9946aeff-a914-45e9-b9e5-6cb5b4059187
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub enum HashAlg {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl fmt::Display for HashAlg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HashAlg::Sha1 => write!(f, "SHA1"),
            HashAlg::Sha256 => write!(f, "SHA256"),
            HashAlg::Sha384 => write!(f, "SHA384"),
            HashAlg::Sha512 => write!(f, "SHA512"),
        }
    }
}

impl TryFrom<&str> for HashAlg {
    type Error = GkdiError;

    fn try_from(data: &str) -> GkdiResult<Self> {
        match data {
            "SHA1" => Ok(HashAlg::Sha1),
            "SHA256" => Ok(HashAlg::Sha256),
            "SHA384" => Ok(HashAlg::Sha384),
            "SHA512" => Ok(HashAlg::Sha512),
            _ => Err(GkdiError::InvalidHashName(data.to_owned())),
        }
    }
}

/// [KDF Parameters](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/9946aeff-a914-45e9-b9e5-6cb5b4059187)
///
/// The following specifies the format and field descriptions for the key derivation function (KDF) parameters structure.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct KdfParameters {
    pub hash_alg: HashAlg,
}

impl KdfParameters {
    // The following magic identifiers are specified in the Microsoft documentation:
    // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/9946aeff-a914-45e9-b9e5-6cb5b4059187
    const MAGIC_IDENTIFIER_1: &[u8] = &[0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00];
    const MAGIC_IDENTIFIER_2: &[u8] = &[0x00, 0x00, 0x00, 0x00];
    const FIXED_PART_SIZE: usize =
        Self::MAGIC_IDENTIFIER_1.len() + 4 /* encoded_hash_alg len */ + Self::MAGIC_IDENTIFIER_2.len();
}

impl StaticName for KdfParameters {
    const NAME: &'static str = "KdfParameters";
}

impl Encode for KdfParameters {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        let hash_alg = self.hash_alg.to_string();

        dst.write_slice(Self::MAGIC_IDENTIFIER_1);
        dst.write_u32(cast_int!("GetKey", "target_sd len", str_utf16_len(&hash_alg))?);
        dst.write_slice(Self::MAGIC_IDENTIFIER_2);
        encode_utf16_le(&hash_alg, dst);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        let encoded_hash_alg_len = str_utf16_len(&self.hash_alg.to_string());

        Self::FIXED_PART_SIZE + encoded_hash_alg_len
    }
}

impl DecodeOwned for KdfParameters {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let magic_identifier_1 = src.read_slice(Self::MAGIC_IDENTIFIER_1.len());

        if magic_identifier_1 != Self::MAGIC_IDENTIFIER_1 {
            Err(GkdiError::InvalidMagic {
                name: "KdfParameters::MAGIC_IDENTIFIER_1",
                expected: Self::MAGIC_IDENTIFIER_1,
                actual: magic_identifier_1.to_vec(),
            })?;
        }

        let hash_name_len = { cast_int!("KdfParameters", "hash name len", src.read_u32()) as DecodeResult<_> }?;

        let magic_identifier_2 = src.read_slice(Self::MAGIC_IDENTIFIER_2.len());

        if magic_identifier_2 != Self::MAGIC_IDENTIFIER_2 {
            Err(GkdiError::InvalidMagic {
                name: "KdfParameters::MAGIC_IDENTIFIER_1",
                expected: Self::MAGIC_IDENTIFIER_2,
                actual: magic_identifier_2.to_vec(),
            })?;
        }

        // The smallest possible hash algorithm name is "SHA1\0", 10 bytes long in UTF-16 encoding.
        if hash_name_len < 10 {
            Err(Error::InvalidLength {
                name: "KdfParameters hash id",
                expected: 10,
                actual: hash_name_len,
            })?;
        }

        Ok(Self {
            hash_alg: read_c_str_utf16_le(hash_name_len, src)?.as_str().try_into()?,
        })
    }
}

/// [FFC DH Parameters](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/e15ae269-ee21-446a-a480-de3ea243db5f)
///
/// This structure specifies field parameters for use in deriving finite field cryptography (FFC) Diffie-Hellman (DH)
/// ([SP800-56A](https://csrc.nist.gov/pubs/sp/800/56/a/r1/final) section 5.7.1) keys,
/// as specified in section [3.1.4.1.2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/5d373568-dd68-499b-bd06-a3ce16ca7117).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfcdhParameters {
    /// A 32-bit unsigned integer. This field MUST be the length, in bytes, of the public key.
    /// This field is encoded using little-endian format.
    pub key_length: u32,
    /// This is the large prime field order, and is a domain parameter for the FFC DH algorithm ([SP800-56A] section 5.7.1).
    /// It MUST be encoded in big-endian format. The length of this field, in bytes,
    /// MUST be equal to the value of the Key length field.
    pub field_order: BoxedUint,
    /// The generator of the subgroup, a domain parameter for the FFC DH algorithm ([SP800-56A] section 5.7.1).
    /// It MUST be encoded in big-endian format. The length of this field, in bytes,
    /// MUST be equal to the value of the Key length field.
    pub generator: BoxedUint,
}

impl FfcdhParameters {
    // The following magic value is defined in the Microsoft documentation:
    // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/e15ae269-ee21-446a-a480-de3ea243db5f
    const MAGIC: &[u8] = &[0x44, 0x48, 0x50, 0x4d];
    const FIXED_PART_SIZE: usize = 4 /* structure length */ + Self::MAGIC.len() + 4 /* key length */;
}

fn pad_key_buffer(key_length: usize, buf: &mut Vec<u8>) -> EncodeResult<()> {
    if buf.len() > key_length {
        return Err(EncodeError::other("key", "key is bigger then specified key length"));
    }

    let mut key = vec![0; key_length];

    let start = key_length - buf.len();
    key[start..].copy_from_slice(buf);

    mem::swap(&mut key, buf);

    Ok(())
}

#[cfg(feature = "arbitrary")]
impl arbitrary::Arbitrary<'_> for FfcdhParameters {
    fn arbitrary(u: &mut arbitrary::Unstructured<'_>) -> arbitrary::Result<Self> {
        let field_order = BoxedUint::from_be_slice_vartime(u.arbitrary()?);
        let generator = BoxedUint::from_be_slice_vartime(u.arbitrary()?);

        let bits = field_order.bits().max(generator.bits());

        Ok(Self {
            key_length: bits.div_ceil(8),
            field_order,
            generator,
        })
    }
}

impl StaticName for FfcdhParameters {
    const NAME: &'static str = "FfcdhParameters";
}

impl Encode for FfcdhParameters {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        // Calculate total structure length and write it.
        //
        // Length (4 bytes):  A 32-bit unsigned integer. This field MUST be the length, in bytes, of the entire structure. This field is encoded using little-endian format:
        // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/e15ae269-ee21-446a-a480-de3ea243db5f
        dst.write_u32(12 + self.key_length * 2);

        dst.write_slice(Self::MAGIC);
        dst.write_u32(self.key_length);

        if self.key_length < self.field_order.bits().div_ceil(8u32)
            || self.key_length < self.generator.bits().div_ceil(8u32)
        {
            return Err(EncodeError::invalid_field("FfcdhParameters", "key_length", "too small"));
        }

        let key_len: usize = cast_int!("FfcdhParameters", "key len", self.key_length)?;

        let mut field_order = self.field_order.to_be_bytes_trimmed_vartime().into_vec();
        pad_key_buffer(key_len, &mut field_order)?;
        dst.write_slice(&field_order);

        let mut generator = self.generator.to_be_bytes_trimmed_vartime().into_vec();
        pad_key_buffer(key_len, &mut generator)?;
        dst.write_slice(&generator);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + usize::try_from(self.key_length).unwrap() * 2
    }
}

impl DecodeOwned for FfcdhParameters {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let _total_len = src.read_u32();

        let magic = src.read_slice(Self::MAGIC.len());

        if magic != Self::MAGIC {
            Err(GkdiError::InvalidMagic {
                name: "FfcdhParameters",
                expected: Self::MAGIC,
                actual: magic.to_vec(),
            })?;
        }

        let key_length = src.read_u32();
        let key_len = { cast_int!("FfcdhParameters", "key len", key_length) as DecodeResult<_> }?;
        ensure_size!(in: src, size: key_len * 2);

        let field_order = BoxedUint::from_be_slice_vartime(src.read_slice(key_len));
        let generator = BoxedUint::from_be_slice_vartime(src.read_slice(key_len));

        Ok(Self {
            key_length,
            field_order,
            generator,
        })
    }
}

/// [FFC DH Key](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/f8770f01-036d-4bf6-a4cf-1bd0e3913404)
///
/// The following specifies the format and field descriptions for the FFC DH Key structure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfcdhKey {
    /// A 32-bit unsigned integer. The value in this field MUST be equal to the length, in bytes,
    /// of the Public key field. This parameter is encoded using little-endian format.
    pub key_length: u32,
    /// This is the large prime field order, and is a domain parameter for the FFC DH algorithm ([SP800-56A](https://csrc.nist.gov/pubs/sp/800/56/a/r1/final) section 5.7.1).
    /// It MUST be encoded in big-endian format. The length of this field, in bytes,
    /// MUST be equal to the value in the Key length field.
    pub field_order: BoxedUint,
    /// The generator of the subgroup, a domain parameter for the FFC DH algorithm ([SP800-56A](https://csrc.nist.gov/pubs/sp/800/56/a/r1/final) section 5.7.1).
    /// It MUST be encoded in big-endian format. The length of this field, in bytes,
    /// MUST be equal to the value in the Key length field.
    pub generator: BoxedUint,
    /// The public key for the FFC DH algorithm ([SP800-56A](https://csrc.nist.gov/pubs/sp/800/56/a/r1/final) section 5.7.1).
    /// It MUST be encoded in big-endian format. The length of this field, in bytes,
    /// MUST be equal to the value of the Key length field.
    pub public_key: BoxedUint,
}

impl FfcdhKey {
    // The following magic value is defined in the Microsoft documentation:
    // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/f8770f01-036d-4bf6-a4cf-1bd0e3913404
    const MAGIC: &[u8] = &[0x44, 0x48, 0x50, 0x42];
    const FIXED_PART_SIZE: usize = Self::MAGIC.len() + 4 /* key length */;
}

#[cfg(feature = "arbitrary")]
impl arbitrary::Arbitrary<'_> for FfcdhKey {
    fn arbitrary(u: &mut arbitrary::Unstructured<'_>) -> arbitrary::Result<Self> {
        let field_order = BoxedUint::from_be_slice_vartime(u.arbitrary()?);
        let generator = BoxedUint::from_be_slice_vartime(u.arbitrary()?);
        let public_key = BoxedUint::from_be_slice_vartime(u.arbitrary()?);

        let bits = field_order.bits().max(generator.bits().max(public_key.bits()));

        Ok(Self {
            key_length: bits.div_ceil(8),
            field_order,
            generator,
            public_key,
        })
    }
}

impl StaticName for FfcdhKey {
    const NAME: &'static str = "FfcdhKey";
}

impl Encode for FfcdhKey {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_slice(Self::MAGIC);

        dst.write_u32(self.key_length);

        if self.key_length < self.field_order.bits().div_ceil(8)
            || self.key_length < self.generator.bits().div_ceil(8)
            || self.key_length < self.public_key.bits().div_ceil(8)
        {
            return Err(EncodeError::invalid_field("FfcdhKey", "key_length", "too small"));
        }

        let key_len: usize = cast_int!("FfcdhKey", "key len", self.key_length)?;

        let mut field_order = self.field_order.to_be_bytes_trimmed_vartime().into_vec();
        pad_key_buffer(key_len, &mut field_order)?;
        dst.write_slice(&field_order);

        let mut generator = self.generator.to_be_bytes_trimmed_vartime().into_vec();
        pad_key_buffer(key_len, &mut generator)?;
        dst.write_slice(&generator);

        let mut public_key = self.public_key.to_be_bytes_trimmed_vartime().into_vec();
        pad_key_buffer(key_len, &mut public_key)?;
        dst.write_slice(&public_key);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + usize::try_from(self.key_length).unwrap() * 3
    }
}

impl DecodeOwned for FfcdhKey {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let magic = src.read_slice(Self::MAGIC.len());

        if magic != FfcdhKey::MAGIC {
            Err(GkdiError::InvalidMagic {
                name: "FfcdhKey",
                expected: Self::MAGIC,
                actual: magic.to_vec(),
            })?;
        }

        let key_length = src.read_u32();
        let key_len = { cast_int!("FfcdhKey", "key len", key_length) as DecodeResult<_> }?;

        ensure_size!(in: src, size: key_len * 3);

        Ok(Self {
            key_length,
            field_order: BoxedUint::from_be_slice_vartime(src.read_slice(key_len)),
            generator: BoxedUint::from_be_slice_vartime(src.read_slice(key_len)),
            public_key: BoxedUint::from_be_slice_vartime(src.read_slice(key_len)),
        })
    }
}

/// Supported elliptic curves.
///
/// It contains elliptic curves that are listed in the documentation:
/// https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/24876a37-9a92-4187-9052-222bb6f85d4a
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub enum EllipticCurve {
    P256,
    P384,
    P521,
}

impl From<EllipticCurve> for &[u8] {
    fn from(curve: EllipticCurve) -> Self {
        match curve {
            EllipticCurve::P256 => b"ECK1",
            EllipticCurve::P384 => b"ECK3",
            EllipticCurve::P521 => b"ECK5",
        }
    }
}

impl TryFrom<&[u8]> for EllipticCurve {
    type Error = GkdiError;

    fn try_from(value: &[u8]) -> GkdiResult<Self> {
        match value {
            b"ECK1" => Ok(EllipticCurve::P256),
            b"ECK3" => Ok(EllipticCurve::P384),
            b"ECK5" => Ok(EllipticCurve::P521),
            _ => Err(GkdiError::InvalidEllipticCurveId(value.to_vec())),
        }
    }
}

/// [ECDH Key](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/24876a37-9a92-4187-9052-222bb6f85d4a)
///
/// The following specifies the format and field descriptions for the Elliptic Curve Diffie-Hellman (ECDH) Key structure [RFC5114](https://www.rfc-editor.org/info/rfc5114).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EcdhKey {
    /// Represents the ECDH field parameters.
    pub curve: EllipticCurve,
    /// A 32-bit unsigned integer. This field MUST be the length, in bytes, of the public key.
    /// This field is encoded using little-endian format.
    pub key_length: u32,
    /// The x coordinate of the point P that represents the ECDH [RFC5114](https://www.rfc-editor.org/info/rfc5114) public key.
    /// It MUST be encoded in big-endian format. The length of this field, in bytes,
    /// MUST be equal to the value in the Key length field.
    pub x: BoxedUint,
    /// The y coordinate of the point P that represents the ECDH public key.
    /// It MUST be encoded in big-endian format. The length of this field, in bytes,
    /// MUST be equal to the value in the Key length field.
    pub y: BoxedUint,
}

impl EcdhKey {
    const FIXED_PART_SIZE: usize = 4 /* encoded_curve len */ + 4 /* key_length */;
}

#[cfg(feature = "arbitrary")]
impl arbitrary::Arbitrary<'_> for EcdhKey {
    fn arbitrary(u: &mut arbitrary::Unstructured<'_>) -> arbitrary::Result<Self> {
        let x = BoxedUint::from_be_slice_vartime(u.arbitrary()?);
        let y = BoxedUint::from_be_slice_vartime(u.arbitrary()?);

        let bits = x.bits().max(y.bits());

        Ok(Self {
            curve: u.arbitrary()?,
            key_length: bits.div_ceil(8),
            x,
            y,
        })
    }
}

impl StaticName for EcdhKey {
    const NAME: &'static str = "EcdhKey";
}

impl Encode for EcdhKey {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_slice(self.curve.into());

        dst.write_u32(self.key_length);

        if self.key_length < self.x.bits().div_ceil(8) || self.key_length < self.y.bits().div_ceil(8) {
            return Err(EncodeError::invalid_field("EcdhKey", "key_length", "too small"));
        }

        let key_len: usize = cast_int!("EcdhKey", "key len", self.key_length)?;

        let mut x = self.x.to_be_bytes_trimmed_vartime().into_vec();
        pad_key_buffer(key_len, &mut x)?;
        dst.write_slice(&x);

        let mut y = self.y.to_be_bytes_trimmed_vartime().into_vec();
        pad_key_buffer(key_len, &mut y)?;
        dst.write_slice(&y);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE + 2 * usize::try_from(self.key_length).unwrap()
    }
}

impl DecodeOwned for EcdhKey {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let curve_id = src.read_slice(4);
        let curve = EllipticCurve::try_from(curve_id)?;

        let key_length = src.read_u32();
        let key_len = { cast_int!("EcdgKey", "key len", key_length) as DecodeResult<_> }?;

        ensure_size!(in: src, size: key_len * 2);

        Ok(Self {
            curve,
            key_length,
            x: BoxedUint::from_be_slice_vartime(src.read_slice(key_len)),
            y: BoxedUint::from_be_slice_vartime(src.read_slice(key_len)),
        })
    }
}

/// Key Identifier
///
/// This contains the key identifier info that can be used by MS-GKDI GetKey to retrieve the group key seed values.
/// This structure is not defined publicly by Microsoft but it closely matches the [GroupKeyEnvelope] structure.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct KeyIdentifier {
    /// The version of the structure.
    pub version: u32,
    /// Flags describing the values inside the structure.
    pub flags: u32,

    /// The L0 index of the key.
    pub l0: i32,
    /// The L1 index of the key.
    pub l1: i32,
    /// The L2 index of the key.
    pub l2: i32,
    /// A GUID that identifies a root key.
    pub root_key_identifier: Uuid,

    /// Key info.
    pub key_info: Vec<u8>,
    /// The domain name of the server in DNS format.
    pub domain_name: String,
    /// The forest name of the server in DNS format.
    pub forest_name: String,
}

impl KeyIdentifier {
    pub const DEFAULT_VERSION: u32 = 1;
    // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/192c061c-e740-4aa0-ab1d-6954fb3e58f7
    const MAGIC: [u8; 4] = [0x4b, 0x44, 0x53, 0x4b];
    const FIXED_PART_SIZE: usize = 4 /* version */ + Self::MAGIC.len() + 4 /* flags */ + 4 /* l0 */ + 4 /* l1 */ + 4 /* l2 */
        + Uuid::FIXED_PART_SIZE /* root_key_identifier */ + 4 /* key_info len */ + 4 /* domain_name len */
        + 4 /* forest_name len */;

    pub fn is_public_key(&self) -> bool {
        self.flags & 1 != 0
    }
}

impl StaticName for KeyIdentifier {
    const NAME: &'static str = "KeyIdentifier";
}

impl Encode for KeyIdentifier {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u32(self.version);
        dst.write_slice(&Self::MAGIC);
        dst.write_u32(self.flags);

        dst.write_i32(self.l0);
        dst.write_i32(self.l1);
        dst.write_i32(self.l2);

        encode_uuid(self.root_key_identifier, dst)?;

        dst.write_u32(cast_length!("KeyIdentifier", "key len", self.key_info.len())?);
        dst.write_u32(cast_length!(
            "KeyIdentifier",
            "domain name len",
            str_utf16_len(&self.domain_name)
        )?);
        dst.write_u32(cast_length!(
            "KeyIdentifier",
            "forest name len",
            str_utf16_len(&self.forest_name)
        )?);

        dst.write_slice(&self.key_info);
        encode_utf16_le(&self.domain_name, dst);
        encode_utf16_le(&self.forest_name, dst);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        Self::FIXED_PART_SIZE
            + self.key_info.len()
            + str_utf16_len(&self.domain_name)
            + str_utf16_len(&self.forest_name)
    }
}

impl DecodeOwned for KeyIdentifier {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let version = src.read_u32();

        let magic = src.read_slice(Self::MAGIC.len());

        if magic != Self::MAGIC {
            Err(GkdiError::InvalidMagic {
                name: "KeyIdentifier",
                expected: Self::MAGIC.as_slice(),
                actual: magic.to_vec(),
            })?;
        }

        let flags = src.read_u32();

        let l0 = src.read_i32();
        let l1 = src.read_i32();
        let l2 = src.read_i32();
        let root_key_identifier = decode_uuid(src)?;

        let key_info_len = { cast_int!("KeyIdentifier", "key info len", src.read_u32()) as DecodeResult<_> }?;

        let domain_len = { cast_int!("KeyIdentifier", "domain name len", src.read_u32()) as DecodeResult<_> }?;
        if domain_len < 2 {
            Err(Error::InvalidLength {
                name: "KeyIdentifier domain name",
                expected: 2,
                actual: domain_len,
            })?;
        }

        let forest_len = { cast_int!("KeyIdentifier", "forest name len", src.read_u32()) as DecodeResult<_> }?;
        if forest_len < 2 {
            Err(Error::InvalidLength {
                name: "KeyIdentifier forest name",
                expected: 2,
                actual: forest_len,
            })?;
        }

        ensure_size!(in: src, size: key_info_len);
        let key_info = src.read_slice(key_info_len).to_vec();

        Ok(Self {
            version,
            flags,
            l0,
            l1,
            l2,
            root_key_identifier,
            key_info,
            domain_name: read_c_str_utf16_le(domain_len, src)?,
            forest_name: read_c_str_utf16_le(forest_len, src)?,
        })
    }
}

/// [Group Key Envelope](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/192c061c-e740-4aa0-ab1d-6954fb3e58f7)
///
/// The following specifies the format and field descriptions for the Group Key Envelope structure.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "arbitrary", derive(arbitrary::Arbitrary))]
pub struct GroupKeyEnvelope {
    /// A 32-bit unsigned integer. Bit 31 (LSB) MUST be set to 1 when this structure is being used to
    /// transport a public key, otherwise set to 0. Bit 30 MUST be set to 1 when the key being transported
    /// by this structure might be used for encryption and decryption, otherwise it should only be used for decryption.
    /// This field is encoded using little-endian format.
    pub flags: u32,
    /// This field MUST be the L0 index of the key being enveloped. This field is encoded using little-endian format.
    pub l0: i32,
    /// This field MUST be the L1 index of the key being enveloped, and therefore MUST be a number between 0 and 31, inclusive.
    /// This field is encoded using little-endian format.
    pub l1: i32,
    /// This field MUST be the L2 index of the key being enveloped, and therefore MUST be a number between 0 and 31, inclusive.
    /// This field is encoded using little-endian format.
    pub l2: i32,
    /// A GUID containing the root key identifier of the key being enveloped.
    pub root_key_identifier: Uuid,
    /// This field MUST be the ADM element KDF algorithm name associated with the ADM element root key,
    /// whose identifier is in the Root key identifier field.
    pub kdf_alg: String,
    /// This field MUST contain the KDF parameters associated with the ADM element root key,
    /// whose identifier is in the Root key identifier field.
    pub kdf_parameters: Vec<u8>,
    /// This field MUST be the ADM element Secret agreement algorithm name associated with the ADM element root key,
    /// whose identifier is in the Root key identifier field.
    pub secret_algorithm: String,
    /// This field MUST contain the ADM element Secret agreement algorithm associated with the ADM element root key,
    /// whose identifier is in the Root key identifier field.
    pub secret_parameters: Vec<u8>,
    /// A 32-bit unsigned integer. This field MUST be the private key length associated with the root key,
    /// whose identifier is in the Root key identifier field. This field is encoded using little-endian format.
    pub private_key_length: u32,
    /// A 32-bit unsigned integer. This field MUST be the public key length associated with the root key,
    /// whose identifier is in the Root key identifier field. This field is encoded using little-endian format.
    pub public_key_length: u32,
    /// This field MUST be the domain name of the server in DNS format.
    pub domain_name: String,
    /// This field MUST be the forest name of the server in DNS format.
    pub forest_name: String,
    /// An L1 seed key ADM element in binary form.
    pub l1_key: Vec<u8>,
    /// The L2 seed key ADM element or the group public key ADM element with group key identifier in binary form.
    pub l2_key: Vec<u8>,
}

impl GroupKeyEnvelope {
    // The following magic value is defined in the Microsoft documentation:
    // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/192c061c-e740-4aa0-ab1d-6954fb3e58f7
    const MAGIC: &[u8] = &[0x4B, 0x44, 0x53, 0x4B];
    const VERSION: u32 = 1;
    const FIXED_PART_SIZE: usize = 4 /* version */ + Self::MAGIC.len() + 4 /* flags */ + 4 /* l0 */ + 4 /* l1 */ + 4 /* l2 */
        + Uuid::FIXED_PART_SIZE /* root_key_identifier */
        + 4 /* encoded_kdf_alg */
        + 4 /* kdf_parameters */
        + 4 /* encoded_secret_alg */
        + 4 /* secret_parameters */
        + 4 /* private_key_length */
        + 4 /* public_key_length */
        + 4 /* l1_key */
        + 4 /* l2_key */
        + 4 /* encoded_domain_name */
        + 4 /* encoded_forest_name */;

    pub fn is_public_key(&self) -> bool {
        self.flags & 1 != 0
    }
}

impl StaticName for GroupKeyEnvelope {
    const NAME: &'static str = "GroupKeyEnvelope";
}

impl Encode for GroupKeyEnvelope {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        ensure_size!(in: dst, size: self.size());

        dst.write_u32(Self::VERSION);

        dst.write_slice(Self::MAGIC);
        dst.write_u32(self.flags);
        dst.write_i32(self.l0);
        dst.write_i32(self.l1);
        dst.write_i32(self.l2);
        encode_uuid(self.root_key_identifier, dst)?;

        let encoded_kdf_alg_len = str_utf16_len(&self.kdf_alg);
        let encoded_secret_alg_len = str_utf16_len(&self.secret_algorithm);
        let encoded_domain_name_len = str_utf16_len(&self.domain_name);
        let encoded_forest_name_len = str_utf16_len(&self.forest_name);

        dst.write_u32(cast_length!("GroupKeyEnvelope", "", encoded_kdf_alg_len)?);
        dst.write_u32(cast_length!("GroupKeyEnvelope", "", self.kdf_parameters.len())?);
        dst.write_u32(cast_length!("GroupKeyEnvelope", "", encoded_secret_alg_len)?);
        dst.write_u32(cast_length!("GroupKeyEnvelope", "", self.secret_parameters.len())?);
        dst.write_u32(self.private_key_length);
        dst.write_u32(self.public_key_length);
        dst.write_u32(cast_length!("GroupKeyEnvelope", "", self.l1_key.len())?);
        dst.write_u32(cast_length!("GroupKeyEnvelope", "", self.l2_key.len())?);
        dst.write_u32(cast_length!("GroupKeyEnvelope", "", encoded_domain_name_len)?);
        dst.write_u32(cast_length!("GroupKeyEnvelope", "", encoded_forest_name_len)?);

        encode_utf16_le(&self.kdf_alg, dst);
        dst.write_slice(&self.kdf_parameters);
        encode_utf16_le(&self.secret_algorithm, dst);
        dst.write_slice(&self.secret_parameters);
        encode_utf16_le(&self.domain_name, dst);
        encode_utf16_le(&self.forest_name, dst);
        dst.write_slice(&self.l1_key);
        dst.write_slice(&self.l2_key);

        Ok(())
    }

    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn size(&self) -> usize {
        let encoded_kdf_alg_len = str_utf16_len(&self.kdf_alg);
        let encoded_secret_alg_len = str_utf16_len(&self.secret_algorithm);
        let encoded_domain_name_len = str_utf16_len(&self.domain_name);
        let encoded_forest_name_len = str_utf16_len(&self.forest_name);

        Self::FIXED_PART_SIZE
            + encoded_kdf_alg_len
            + self.kdf_parameters.len()
            + encoded_secret_alg_len
            + self.secret_parameters.len()
            + encoded_domain_name_len
            + encoded_forest_name_len
            + self.l1_key.len()
            + self.l2_key.len()
    }
}

impl DecodeOwned for GroupKeyEnvelope {
    fn decode_owned(src: &mut ReadCursor<'_>) -> DecodeResult<Self> {
        ensure_size!(in: src, size: Self::FIXED_PART_SIZE);

        let version = src.read_u32();

        if version != Self::VERSION {
            Err(GkdiError::InvalidVersion {
                name: "GroupKeyEnvelope",
                expected: Self::VERSION,
                actual: version,
            })?;
        }

        let magic = src.read_slice(Self::MAGIC.len());

        if magic != Self::MAGIC {
            Err(GkdiError::InvalidMagic {
                name: "GroupKeyEnvelope",
                expected: Self::MAGIC,
                actual: magic.to_vec(),
            })?;
        }

        let flags = src.read_u32();
        let l0 = src.read_i32();
        let l1 = src.read_i32();
        let l2 = src.read_i32();
        let root_key_identifier = decode_uuid(src)?;

        let kdf_alg_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;
        let kdf_parameters_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;
        let secret_alg_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;
        let secret_parameters_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;
        let private_key_length = src.read_u32();
        let public_key_length = src.read_u32();
        let l1_key_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;
        let l2_key_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;
        let domain_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;
        let forest_len = { cast_int!("GroupKeyEnvelope", "", src.read_u32()) as DecodeResult<_> }?;

        let kdf_alg = read_c_str_utf16_le(kdf_alg_len, src)?;

        ensure_size!(in: src, size: kdf_parameters_len);
        let kdf_parameters = src.read_slice(kdf_parameters_len).to_vec();

        let secret_algorithm = read_c_str_utf16_le(secret_alg_len, src)?;

        ensure_size!(in: src, size: secret_parameters_len);
        let secret_parameters = src.read_slice(secret_parameters_len).to_vec();

        let domain_name = read_c_str_utf16_le(domain_len, src)?;
        let forest_name = read_c_str_utf16_le(forest_len, src)?;

        ensure_size!(in: src, size: l1_key_len);
        let l1_key = src.read_slice(l1_key_len).to_vec();

        ensure_size!(in: src, size: l2_key_len);
        let l2_key = src.read_slice(l2_key_len).to_vec();

        Ok(Self {
            flags,
            l0,
            l1,
            l2,
            root_key_identifier,
            kdf_alg,
            kdf_parameters,
            secret_algorithm,
            secret_parameters,
            private_key_length,
            public_key_length,
            domain_name,
            forest_name,
            l1_key,
            l2_key,
        })
    }
}
