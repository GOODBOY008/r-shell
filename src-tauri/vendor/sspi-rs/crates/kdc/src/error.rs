use picky_asn1::date::GeneralizedTime;
use picky_asn1::restricted_string::IA5String;
use picky_asn1::wrapper::{
    Asn1SequenceOf, ExplicitContextTag0, ExplicitContextTag1, ExplicitContextTag2, ExplicitContextTag4,
    ExplicitContextTag5, ExplicitContextTag6, ExplicitContextTag7, ExplicitContextTag9, ExplicitContextTag10,
    ExplicitContextTag11, ExplicitContextTag12, IntegerAsn1, OctetStringAsn1, Optional,
};
use picky_asn1_der::Asn1DerError;
use picky_krb::constants::error_codes::{
    KDC_ERR_C_PRINCIPAL_UNKNOWN, KDC_ERR_CANNOT_POSTDATE, KDC_ERR_ETYPE_NOSUPP, KDC_ERR_NEVER_VALID,
    KDC_ERR_PREAUTH_FAILED, KDC_ERR_PREAUTH_REQUIRED, KDC_ERR_S_PRINCIPAL_UNKNOWN, KDC_ERR_WRONG_REALM,
    KRB_AP_ERR_BADVERSION, KRB_AP_ERR_MODIFIED, KRB_AP_ERR_MSG_TYPE, KRB_AP_ERR_SKEW, KRB_AP_ERR_TKT_EXPIRED,
    KRB_ERR_GENERIC,
};
use picky_krb::constants::types::{KRB_ERROR_MSG_TYPE, NT_SRV_INST, PA_ENC_TIMESTAMP, PA_ETYPE_INFO2_TYPE};
use picky_krb::crypto::CipherSuite;
use picky_krb::data_types::{
    EtypeInfo2Entry, KerberosStringAsn1, KerberosTime, Microseconds, PaData, PrincipalName, Realm,
};
use picky_krb::messages::{KdcReqBody, KrbError, KrbErrorInner};
use thiserror::Error;
use time::OffsetDateTime;

use crate::config::KerberosServer;
use crate::{KERBEROS_VERSION, TGT_SERVICE_NAME, find_user_credentials};

#[derive(Error, Debug)]
pub(super) enum KdcError {
    #[error("KRB_AP_ERR_BADVERSION: got invalid Kerberos version ({version:?}): expected [{expected}]")]
    BadKrbVersion { version: Vec<u8>, expected: u8 },

    #[error("KRB_AP_ERR_MSG_TYPE: got invalid Kerberos message type ({msg_type:?}): expected [{expected}]")]
    BadMsgType { msg_type: Vec<u8>, expected: u8 },

    #[error("KDC_ERR_WRONG_REALM: wrong realm: {0}")]
    WrongRealm(String),

    #[error("ASN1 DER encoding failed: {0:?}")]
    Asn1Encode(#[from] Asn1DerError),

    #[error("encryption failed: {0:?}")]
    EncryptionFailed(#[from] picky_krb::crypto::KerberosCryptoError),

    #[error("KDC_ERR_C_PRINCIPAL_UNKNOWN: {0}")]
    ClientPrincipalUnknown(String),

    #[error("invalid cname type: {0:?}")]
    InvalidCnameType(Vec<u8>),

    #[error("invalid sname type: {0:?}")]
    InvalidSnameType(Vec<u8>),

    #[error("invalid sname: {0}")]
    InvalidSname(String),

    #[error("KDC_ERR_ETYPE_NOSUPP: only AES256_CTS_HMAC_SHA1_96 and AES128_CTS_HMAC_SHA1_96 etypes are supported")]
    NoSuitableEtype,

    #[error("KDC_ERR_PREAUTH_FAILED: {0}")]
    PreAuthFailed(&'static str),

    #[error("KDC_ERR_PREAUTH_REQUIRED: {0}")]
    PreAuthRequired(&'static str),

    #[error("KRB_ERR_GENERIC: internal error: {0}")]
    InternalError(&'static str),

    #[error("KRB_AP_ERR_SKEW: {0}")]
    ClockSkew(&'static str),

    #[error("KRB_AP_ERR_MODIFIED: {0} decryption failed")]
    Modified(&'static str),

    #[error("KDC_ERR_CANNOT_POSTDATE: {0}")]
    CannotPostdate(&'static str),

    #[error("KDC_ERR_NEVER_VALID: {0}")]
    NeverValid(String),

    #[error("KRB_AP_ERR_TKT_EXPIRED: {0}")]
    TicketExpired(&'static str),
}

impl KdcError {
    pub(super) fn invalid_raw_krb_message_error(kdc_realm: String) -> KrbError {
        let realm =
            Realm::from(IA5String::from_string(kdc_realm).expect("configured realm should be valid Kerberos string"));

        let current_date = OffsetDateTime::now_utc();
        // https://www.rfc-editor.org/rfc/rfc4120#section-5.2.4
        // Microseconds    ::= INTEGER (0..999999)
        let microseconds = current_date.microsecond().min(999_999);

        KrbError::from(KrbErrorInner {
            pvno: ExplicitContextTag0::from(IntegerAsn1(vec![KERBEROS_VERSION])),
            msg_type: ExplicitContextTag1::from(IntegerAsn1::from(vec![KRB_ERROR_MSG_TYPE])),
            ctime: Optional::from(None),
            cusec: Optional::from(None),
            stime: ExplicitContextTag4::from(KerberosTime::from(GeneralizedTime::from(current_date))),
            susec: ExplicitContextTag5::from(Microseconds::from(microseconds.to_be_bytes().to_vec())),
            error_code: ExplicitContextTag6::from(KRB_ERR_GENERIC),
            crealm: Optional::from(None),
            cname: Optional::from(None),
            realm: ExplicitContextTag9::from(realm.clone()),
            sname: ExplicitContextTag10::from(PrincipalName {
                name_type: ExplicitContextTag0::from(IntegerAsn1::from(vec![NT_SRV_INST])),
                name_string: ExplicitContextTag1::from(Asn1SequenceOf::from(vec![
                    KerberosStringAsn1::from(
                        IA5String::from_string(TGT_SERVICE_NAME.to_owned())
                            .expect("TGT_SERVICE_NAME is valid KerberosString"),
                    ),
                    realm,
                ])),
            }),
            e_text: Optional::from(Some(ExplicitContextTag11::from(KerberosStringAsn1::from(
                IA5String::from_string("input message is not valid AS_REQ nor TGS_REQ".to_owned())
                    .expect("valid Kerberos string"),
            )))),
            e_data: Optional::from(None),
        })
    }

    pub(super) fn into_krb_error(self, kdc_body: &KdcReqBody, kdc_config: &KerberosServer) -> KrbError {
        let realm = kdc_body.realm.0.to_string();
        let cname = kdc_body.cname.0.as_ref().map(|cname| cname.0.clone());
        let salt = cname.and_then(|cname| {
            find_user_credentials(&cname, &realm, kdc_config)
                .map(|user| &user.salt)
                .ok()
        });
        let realm =
            Realm::from(IA5String::from_string(realm).expect("configured realm should be valid Kerberos string"));

        let sname = kdc_body
            .sname
            .0
            .as_ref()
            .map(|sname| sname.0.clone())
            .unwrap_or_else(|| PrincipalName {
                name_type: ExplicitContextTag0::from(IntegerAsn1::from(vec![NT_SRV_INST])),
                name_string: ExplicitContextTag1::from(Asn1SequenceOf::from(vec![
                    KerberosStringAsn1::from(
                        IA5String::from_string(TGT_SERVICE_NAME.to_owned())
                            .expect("TGT_SERVICE_NAME is valid KerberosString"),
                    ),
                    realm.clone(),
                ])),
            });

        let current_date = OffsetDateTime::now_utc();
        // https://www.rfc-editor.org/rfc/rfc4120#section-5.2.4
        // Microseconds    ::= INTEGER (0..999999)
        let microseconds = current_date.microsecond().min(999_999);

        let error_code = match self {
            KdcError::ClientPrincipalUnknown(_) => KDC_ERR_C_PRINCIPAL_UNKNOWN,
            KdcError::InvalidCnameType(_) => KDC_ERR_C_PRINCIPAL_UNKNOWN,
            KdcError::InvalidSnameType(_) => KDC_ERR_S_PRINCIPAL_UNKNOWN,
            KdcError::InvalidSname(_) => KDC_ERR_S_PRINCIPAL_UNKNOWN,
            KdcError::NoSuitableEtype => KDC_ERR_ETYPE_NOSUPP,
            KdcError::PreAuthFailed(_) => KDC_ERR_PREAUTH_FAILED,
            KdcError::PreAuthRequired(_) => KDC_ERR_PREAUTH_REQUIRED,
            KdcError::InternalError(_) => KRB_ERR_GENERIC,
            KdcError::ClockSkew(_) => KRB_AP_ERR_SKEW,
            KdcError::Modified(_) => KRB_AP_ERR_MODIFIED,
            KdcError::Asn1Encode(_) => KRB_ERR_GENERIC,
            KdcError::EncryptionFailed(_) => KRB_ERR_GENERIC,
            KdcError::BadKrbVersion { .. } => KRB_AP_ERR_BADVERSION,
            KdcError::BadMsgType { .. } => KRB_AP_ERR_MSG_TYPE,
            KdcError::WrongRealm(_) => KDC_ERR_WRONG_REALM,
            KdcError::CannotPostdate(_) => KDC_ERR_CANNOT_POSTDATE,
            KdcError::NeverValid(_) => KDC_ERR_NEVER_VALID,
            KdcError::TicketExpired(_) => KRB_AP_ERR_TKT_EXPIRED,
        };

        let salt = if let Some(salt) = salt {
            vec![
                PaData {
                    padata_type: ExplicitContextTag1::from(IntegerAsn1::from(PA_ETYPE_INFO2_TYPE.to_vec())),
                    padata_data: ExplicitContextTag2::from(OctetStringAsn1::from(
                        picky_asn1_der::to_vec(&Asn1SequenceOf::from(vec![EtypeInfo2Entry {
                            etype: ExplicitContextTag0::from(IntegerAsn1::from(vec![u8::from(
                                CipherSuite::Aes256CtsHmacSha196,
                            )])),
                            salt: Optional::from(Some(ExplicitContextTag1::from(KerberosStringAsn1::from(
                                IA5String::from_string(salt.to_owned()).expect("salt to be valid KerberosString"),
                            )))),
                            s2kparams: Optional::from(None),
                        }]))
                        .unwrap_or_else(|_| Vec::new()),
                    )),
                },
                PaData {
                    padata_type: ExplicitContextTag1::from(IntegerAsn1::from(PA_ENC_TIMESTAMP.to_vec())),
                    padata_data: ExplicitContextTag2::from(OctetStringAsn1::from(Vec::new())),
                },
            ]
        } else {
            Vec::new()
        };
        let e_data = picky_asn1_der::to_vec(&Asn1SequenceOf::from(salt)).unwrap_or_else(|_| Vec::new());

        KrbError::from(KrbErrorInner {
            pvno: ExplicitContextTag0::from(IntegerAsn1(vec![KERBEROS_VERSION])),
            msg_type: ExplicitContextTag1::from(IntegerAsn1::from(vec![KRB_ERROR_MSG_TYPE])),
            ctime: Optional::from(None),
            cusec: Optional::from(None),
            stime: ExplicitContextTag4::from(KerberosTime::from(GeneralizedTime::from(current_date))),
            susec: ExplicitContextTag5::from(Microseconds::from(microseconds.to_be_bytes().to_vec())),
            error_code: ExplicitContextTag6::from(error_code),
            crealm: Optional::from(Some(ExplicitContextTag7::from(realm.clone()))),
            cname: Optional::from(None),
            realm: ExplicitContextTag9::from(realm),
            sname: ExplicitContextTag10::from(sname),
            e_text: Optional::from(Some(ExplicitContextTag11::from(KerberosStringAsn1::from(
                IA5String::from_string(self.to_string()).expect("error message to be valid KerberosString"),
            )))),
            e_data: Optional::from(Some(ExplicitContextTag12::from(OctetStringAsn1::from(e_data)))),
        })
    }
}
