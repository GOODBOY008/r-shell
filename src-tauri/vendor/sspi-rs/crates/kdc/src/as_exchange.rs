use std::time::Duration;

use argon2::password_hash::rand_core::{OsRng, RngCore as _};
use picky_asn1::restricted_string::IA5String;
use picky_asn1::wrapper::{
    Asn1SequenceOf, ExplicitContextTag0, ExplicitContextTag1, ExplicitContextTag2, ExplicitContextTag3,
    ExplicitContextTag4, ExplicitContextTag5, ExplicitContextTag6, IntegerAsn1, OctetStringAsn1, Optional,
};
use picky_krb::constants::etypes::{AES128_CTS_HMAC_SHA1_96, AES256_CTS_HMAC_SHA1_96};
use picky_krb::constants::key_usages::AS_REP_ENC;
use picky_krb::constants::types::{
    AS_REP_MSG_TYPE, AS_REQ_MSG_TYPE, ENC_AS_REP_PART_TYPE, PA_ENC_TIMESTAMP, PA_ENC_TIMESTAMP_KEY_USAGE,
    PA_ETYPE_INFO2_TYPE,
};
use picky_krb::crypto::CipherSuite;
use picky_krb::data_types::{EncryptedData, EtypeInfo2Entry, KerberosStringAsn1, PaData, PaEncTsEnc};
use picky_krb::messages::{AsRep, AsReq, KdcRep, KdcReq, KdcReqBody};
use time::OffsetDateTime;
use zeroize::Zeroizing;

use crate::config::{DomainUser, KerberosServer};
use crate::error::KdcError;
use crate::ticket::{MakeTicketParams, RepEncPartParams, make_rep_enc_part, make_ticket};
use crate::{
    KERBEROS_VERSION, TGT_SERVICE_NAME, find_user_credentials, validate_request_from_and_till, validate_request_sname,
};

/// Validates AS-REQ PA-DATAs.
///
/// The current implementation accepts only [PA_ENC_TIMESTAMP] pa-data (i.e. password-based logon).
/// [PA_PK_AS_REQ] pa-data (i.e. scard-based logon) is not supported.
fn validate_pa_data_timestamp(
    domain_user: &DomainUser,
    max_time_skew: u64,
    pa_datas: &[PaData],
) -> Result<Zeroizing<Vec<u8>>, KdcError> {
    let pa_data = pa_datas
        .iter()
        .find_map(|pa_data| {
            if pa_data.padata_type.0.0 == PA_ENC_TIMESTAMP {
                Some(pa_data.padata_data.0.0.as_slice())
            } else {
                None
            }
        })
        .ok_or(KdcError::PreAuthRequired(
            "PA_ENC_TIMESTAMP is not present in AS_REQ padata",
        ))?;

    let encrypted_timestamp: EncryptedData =
        picky_asn1_der::from_bytes(pa_data).map_err(|_| KdcError::PreAuthFailed("unable to decode pa-data value"))?;

    let cipher = CipherSuite::try_from(encrypted_timestamp.etype.0.0.as_slice())
        .map_err(|_| KdcError::PreAuthFailed("invalid etype in PA_ENC_TIMESTAMP"))?
        .cipher();
    let key = Zeroizing::new(
        cipher
            .generate_key_from_password(domain_user.password.as_bytes(), domain_user.salt.as_bytes())
            .map_err(|_| KdcError::InternalError("failed to generate user's key"))?,
    );

    let timestamp_data = cipher
        .decrypt(
            key.as_ref(),
            PA_ENC_TIMESTAMP_KEY_USAGE,
            &encrypted_timestamp.cipher.0.0,
        )
        .map_err(|_| KdcError::Modified("PA_ENC_TIMESTAMP"))?;
    let timestamp: PaEncTsEnc = picky_asn1_der::from_bytes(&timestamp_data)
        .map_err(|_| KdcError::PreAuthFailed("unable to decode PaEncTsEnc value"))?;

    let client_timestamp = OffsetDateTime::try_from(timestamp.patimestamp.0.0)
        .map_err(|_| KdcError::PreAuthFailed("unable to decode PaEncTsEnc timestamp value"))?;
    let current = OffsetDateTime::now_utc();

    if client_timestamp > current || current - client_timestamp > Duration::from_secs(max_time_skew) {
        return Err(KdcError::ClockSkew("invalid pa-data: clock skew too great"));
    }

    Ok(key)
}

/// Performs AS exchange according to the RFC 4120.
///
/// RFC: [The Authentication Service Exchange](https://www.rfc-editor.org/rfc/rfc4120#section-3.1).
pub(super) fn handle_as_req(as_req: &AsReq, kdc_config: &KerberosServer) -> Result<AsRep, KdcError> {
    let KdcReq {
        pvno,
        msg_type,
        padata,
        req_body,
    } = &as_req.0;

    if pvno.0.0 != [KERBEROS_VERSION] {
        return Err(KdcError::BadKrbVersion {
            version: pvno.0.0.clone(),
            expected: KERBEROS_VERSION,
        });
    }

    if msg_type.0.0 != [AS_REQ_MSG_TYPE] {
        return Err(KdcError::BadMsgType {
            msg_type: msg_type.0.0.clone(),
            expected: AS_REQ_MSG_TYPE,
        });
    }

    let KdcReqBody {
        kdc_options,
        cname,
        realm: realm_asn1,
        sname,
        from,
        till,
        rtime: _,
        nonce,
        etype,
        addresses,
        enc_authorization_data: _,
        additional_tickets: _,
    } = &req_body.0;

    let sname = sname
        .0
        .clone()
        .ok_or(KdcError::InvalidSname(
            "sname is not present in KDC request sname".to_owned(),
        ))?
        .0;
    // The AS_REQ service name must meet the following requirements:
    // * The first string in sname must be equal to TGT_SERVICE_NAME.
    // * The second string in sname must be equal to KDC realm.
    validate_request_sname(&sname, &[TGT_SERVICE_NAME, &kdc_config.realm])?;

    let realm = realm_asn1.0.0.as_utf8();
    if !realm.eq_ignore_ascii_case(&kdc_config.realm) {
        return Err(KdcError::WrongRealm(realm.to_owned()));
    }

    let cname = &cname
        .0
        .as_ref()
        .ok_or(KdcError::ClientPrincipalUnknown(
            "the incoming KDC request does not contain client principal name".to_owned(),
        ))?
        .0;
    let domain_user = find_user_credentials(cname, realm, kdc_config)?;

    let pa_datas = &padata
        .0
        .as_ref()
        .ok_or(KdcError::PreAuthRequired("pa-data is missing in incoming AS_REQ"))?
        .0
        .0;

    let user_key = validate_pa_data_timestamp(domain_user, kdc_config.max_time_skew, pa_datas)?;
    let as_req_nonce = nonce.0.0.clone();
    let etype_raw = etype
        .0
        .0
        .iter()
        .find(|etype| {
            // We support only AES256_CTS_HMAC_SHA1_96 and AES128_CTS_HMAC_SHA1_96. According to the RFC (https://datatracker.ietf.org/doc/html/rfc4120#section-3.1.3):
            // > The KDC will not issue tickets with a weak session key encryption type.
            if let Some(etype) = etype.0.first().copied().map(usize::from) {
                etype == AES256_CTS_HMAC_SHA1_96 || etype == AES128_CTS_HMAC_SHA1_96
            } else {
                false
            }
        })
        .ok_or(KdcError::NoSuitableEtype)?
        .0
        .as_slice();
    let etype = CipherSuite::try_from(etype_raw).map_err(|_| KdcError::NoSuitableEtype)?;
    let cipher = etype.cipher();
    let realm = realm_asn1.0.clone();
    let (auth_time, end_time) = validate_request_from_and_till(from.0.as_deref(), &till.0, kdc_config.max_time_skew)?;

    let mut rng = OsRng;
    let mut session_key = vec![0; cipher.key_size()];
    rng.fill_bytes(&mut session_key);

    let as_rep_enc_data = make_rep_enc_part::<ENC_AS_REP_PART_TYPE>(
        RepEncPartParams {
            etype: etype.clone(),
            session_key: session_key.clone(),
            nonce: as_req_nonce,
            kdc_options: kdc_options.0.clone(),
            auth_time,
            end_time,
            realm: realm.clone(),
            sname: sname.clone(),
            addresses: addresses.0.clone().map(|addresses| addresses.0),
        },
        user_key.as_ref(),
        AS_REP_ENC,
    )?;

    Ok(AsRep::from(KdcRep {
        pvno: ExplicitContextTag0::from(IntegerAsn1::from(vec![KERBEROS_VERSION])),
        msg_type: ExplicitContextTag1::from(IntegerAsn1::from(vec![AS_REP_MSG_TYPE])),
        padata: Optional::from(Some(ExplicitContextTag2::from(Asn1SequenceOf::from(vec![PaData {
            padata_type: ExplicitContextTag1::from(IntegerAsn1::from(PA_ETYPE_INFO2_TYPE.to_vec())),
            padata_data: ExplicitContextTag2::from(OctetStringAsn1::from(picky_asn1_der::to_vec(
                &Asn1SequenceOf::from(vec![EtypeInfo2Entry {
                    etype: ExplicitContextTag0::from(IntegerAsn1::from(etype_raw.to_vec())),
                    salt: Optional::from(Some(ExplicitContextTag1::from(KerberosStringAsn1::from(
                        IA5String::from_string(domain_user.salt.clone()).expect("salt to be a valid KerberosString"),
                    )))),
                    s2kparams: Optional::from(None),
                }]),
            )?)),
        }])))),
        crealm: ExplicitContextTag3::from(realm.clone()),
        cname: ExplicitContextTag4::from(cname.clone()),
        ticket: ExplicitContextTag5::from(make_ticket(MakeTicketParams {
            realm,
            session_key,
            ticket_encryption_key: &kdc_config.krbtgt_key,
            kdc_options: kdc_options.0.clone(),
            sname,
            cname: cname.clone(),
            etype,
            auth_time,
            end_time,
        })?),
        enc_part: ExplicitContextTag6::from(EncryptedData {
            etype: ExplicitContextTag0::from(IntegerAsn1::from(etype_raw.to_vec())),
            kvno: Optional::from(None),
            cipher: ExplicitContextTag2::from(OctetStringAsn1::from(as_rep_enc_data)),
        }),
    }))
}
