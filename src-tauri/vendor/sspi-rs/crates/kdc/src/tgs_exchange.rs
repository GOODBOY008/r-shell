use std::time::Duration;

use argon2::password_hash::rand_core::{OsRng, RngCore as _};
use picky_asn1::wrapper::{
    Asn1SequenceOf, ExplicitContextTag0, ExplicitContextTag1, ExplicitContextTag2, ExplicitContextTag3,
    ExplicitContextTag4, ExplicitContextTag5, ExplicitContextTag6, IntegerAsn1, OctetStringAsn1, Optional,
};
use picky_krb::constants::etypes::{AES128_CTS_HMAC_SHA1_96, AES256_CTS_HMAC_SHA1_96};
use picky_krb::constants::key_usages::{
    TGS_REP_ENC_SESSION_KEY, TGS_REP_ENC_SUB_KEY, TGS_REQ_PA_DATA_AP_REQ_AUTHENTICATOR, TICKET_REP,
};
use picky_krb::constants::types::{ENC_TGS_REP_PART_TYPE, PA_TGS_REQ_TYPE, TGS_REP_MSG_TYPE, TGS_REQ_MSG_TYPE};
use picky_krb::crypto::CipherSuite;
use picky_krb::data_types::{
    Authenticator, EncTicketPart, EncTicketPartInner, EncryptedData, PaData, PrincipalName, TicketInner,
};
use picky_krb::messages::{ApReq, ApReqInner, KdcRep, KdcReq, KdcReqBody, TgsRep, TgsReq};
use time::OffsetDateTime;

use crate::config::KerberosServer;
use crate::error::KdcError;
use crate::ticket::{MakeTicketParams, RepEncPartParams, make_rep_enc_part, make_ticket};
use crate::{KERBEROS_VERSION, TGT_SERVICE_NAME, validate_request_from_and_till, validate_request_sname};

/// Kerberos service name for the Terminal Server.
const TERMSRV: &str = "TERMSRV";

/// Resulting data after the TGS pre-authentication.
struct TgsPreAuth {
    /// Extracted key from the PA-DATA.
    ///
    /// This key is used for `TgsRep::enc_part` encryption.
    session_key: Vec<u8>,
    /// Client's name.
    ///
    /// Client's name is encoded in the encrypted part of the PA-DATA ticket (TGT ticket).
    cname: PrincipalName,
    /// Encryption key usage.
    ///
    /// The key usage depends on whether the PA-DATA ApReq Authenticator sub-key was specified or not.
    tgs_rep_key_usage: i32,
}

/// Performs TGS pre-authentication: validates incoming PA-DATAs and extracts needed parameters.
fn tgs_preauth(
    realm: &str,
    pa_datas: &Asn1SequenceOf<PaData>,
    krbtgt_key: &[u8],
    max_time_skew: u64,
) -> Result<TgsPreAuth, KdcError> {
    let ap_req: ApReq = picky_asn1_der::from_bytes(
        &pa_datas
            .0
            .iter()
            .find(|pa_data| pa_data.padata_type.0.0 == PA_TGS_REQ_TYPE)
            .ok_or(KdcError::PreAuthRequired("missing PA_TGS_REQ pa-data"))?
            .padata_data
            .0
            .0,
    )
    .map_err(|_| KdcError::PreAuthFailed("failed to decode PA_TGS_REQ AP_REQ"))?;

    let ApReqInner {
        pvno: _,
        msg_type: _,
        ap_options: _,
        ticket,
        authenticator,
    } = ap_req.0;
    let TicketInner {
        sname: ticket_sname,
        enc_part: ticket_enc_data,
        ..
    } = ticket.0.0;

    // * The first string in sname must be equal to TGT_SERVICE_NAME.
    // * The second string in sname must be equal to KDC realm.
    validate_request_sname(&ticket_sname.0, &[TGT_SERVICE_NAME, realm])?;

    let cipher = CipherSuite::try_from(ticket_enc_data.etype.0.0.as_slice())
        .map_err(|_| KdcError::NoSuitableEtype)?
        .cipher();

    let ticket_enc_part: EncTicketPart = picky_asn1_der::from_bytes(
        &cipher
            .decrypt(krbtgt_key, TICKET_REP, &ticket_enc_data.cipher.0.0)
            .map_err(|_| KdcError::Modified("TGS_REQ TGT ticket"))?,
    )
    .map_err(|_| KdcError::PreAuthFailed("failed to decode TGS_REQ TGT enc part"))?;

    let EncTicketPartInner {
        key, cname, endtime, ..
    } = ticket_enc_part.0;

    let end_time = OffsetDateTime::try_from(endtime.0.0)
        .map_err(|err| KdcError::NeverValid(format!("KdcReq::till time is not valid: {err}")))?;
    let now = OffsetDateTime::now_utc();
    // RFC 4120 Receipt of KRB_AP_REQ Message (https://www.rfc-editor.org/rfc/rfc4120#section-3.2.3):
    // > if the current time is later than end time by more than the allowable clock skew,
    // > the KRB_AP_ERR_TKT_EXPIRED error is returned.
    if now + Duration::from_secs(max_time_skew) > end_time {
        return Err(KdcError::TicketExpired("TGT ticket has expired"));
    }

    let session_key = key.0.key_value.0.0;

    let authenticator_enc_data = authenticator.0;
    let cipher = CipherSuite::try_from(authenticator_enc_data.etype.0.0.as_slice())
        .map_err(|_| KdcError::NoSuitableEtype)?
        .cipher();

    let authenticator: Authenticator = picky_asn1_der::from_bytes(
        &cipher
            .decrypt(
                &session_key,
                TGS_REQ_PA_DATA_AP_REQ_AUTHENTICATOR,
                &authenticator_enc_data.cipher.0.0,
            )
            .map_err(|_| KdcError::Modified("TGS_REQ TGT ticket"))?,
    )
    .map_err(|_| KdcError::PreAuthFailed("failed to decode TGS_REQ PA-DATA Authenticator"))?;

    let (session_key, tgs_rep_key_usage) = if let Some(key) = authenticator.0.subkey.0 {
        (key.0.key_value.0.0, TGS_REP_ENC_SUB_KEY)
    } else {
        (session_key, TGS_REP_ENC_SESSION_KEY)
    };

    Ok(TgsPreAuth {
        session_key,
        cname: cname.0,
        tgs_rep_key_usage,
    })
}

/// Performs TGS exchange according to the RFC 4120.
///
/// RFC: [The Ticket-Granting Service (TGS) Exchange](https://www.rfc-editor.org/rfc/rfc4120#section-3.3).
pub(super) fn handle_tgs_req(
    tgs_req: &TgsReq,
    kdc_config: &KerberosServer,
    hostname: &str,
) -> Result<TgsRep, KdcError> {
    let KdcReq {
        pvno,
        msg_type,
        padata,
        req_body,
    } = &tgs_req.0;

    if pvno.0.0 != [KERBEROS_VERSION] {
        return Err(KdcError::BadKrbVersion {
            version: pvno.0.0.clone(),
            expected: KERBEROS_VERSION,
        });
    }

    if msg_type.0.0 != [TGS_REQ_MSG_TYPE] {
        return Err(KdcError::BadMsgType {
            msg_type: msg_type.0.0.clone(),
            expected: TGS_REQ_MSG_TYPE,
        });
    }

    let KdcReqBody {
        kdc_options,
        cname: _,
        realm: realm_asn1,
        sname,
        from,
        till,
        rtime: _,
        nonce,
        etype,
        addresses,
        enc_authorization_data: _,
        additional_tickets,
    } = &req_body.0;

    let realm = realm_asn1.0.0.as_utf8();
    if !realm.eq_ignore_ascii_case(&kdc_config.realm) {
        return Err(KdcError::WrongRealm(realm.to_owned()));
    }

    let sname = &sname
        .0
        .as_ref()
        .ok_or(KdcError::InvalidSname("sname is missing in TGS_REQ".to_owned()))?
        .0;
    // The TGS_REQ service name must meet the following requirements:
    // * The first string in sname must be equal to [TERMSRV].
    // * The second string in sname must be equal to Devolutions Gateway hostname.
    validate_request_sname(sname, &[TERMSRV, hostname])?;

    let pa_datas = &padata
        .0
        .as_ref()
        .ok_or_else(|| KdcError::PreAuthRequired("TGS_REQ PA-DATA is missing"))?
        .0;
    let TgsPreAuth {
        session_key: initial_key,
        cname,
        tgs_rep_key_usage,
    } = tgs_preauth(
        &kdc_config.realm,
        pa_datas,
        &kdc_config.krbtgt_key,
        kdc_config.max_time_skew,
    )?;

    // [RFC 4120: KRB_KDC_REQ Definition](https://www.rfc-editor.org/rfc/rfc4120#section-5.4.1):
    // > KDCOptions      ::= KerberosFlags
    // > ...
    // >         -- enc-tkt-in-skey(28),
    let ticket_enc_key = if let (true, Some(tgt_ticket)) = (kdc_options.0.0.is_set(28), additional_tickets.0.as_ref()) {
        let TicketInner { sname, enc_part, .. } = &tgt_ticket
            .0
            .0
            .first()
            .expect("array of additional tickets must not be empty")
            .0;

        validate_request_sname(&sname.0, &[TGT_SERVICE_NAME, realm])?;

        let EncryptedData {
            etype,
            cipher: ticket_enc_data,
            kvno: _,
        } = &enc_part.0;

        let cipher = CipherSuite::try_from(etype.0.0.as_slice())
            .map_err(|_| KdcError::NoSuitableEtype)?
            .cipher();

        let ticket_enc_part: EncTicketPart = picky_asn1_der::from_bytes(
            &cipher
                .decrypt(&kdc_config.krbtgt_key, TICKET_REP, &ticket_enc_data.0.0)
                .map_err(|_| KdcError::Modified("TGS_REQ Additional Ticket"))?,
        )
        .map_err(|_| KdcError::PreAuthFailed("unable to decode pa-data value"))?;

        ticket_enc_part.0.key.0.key_value.0.0
    } else {
        kdc_config
            .ticket_decryption_key
            .clone()
            .ok_or(KdcError::InternalError("TGS ticket encryption key is not specified"))?
    };

    let tgs_req_nonce = nonce.0.0.clone();
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

    let tgs_rep_enc_part = make_rep_enc_part::<ENC_TGS_REP_PART_TYPE>(
        RepEncPartParams {
            etype: etype.clone(),
            session_key: session_key.clone(),
            nonce: tgs_req_nonce,
            kdc_options: kdc_options.0.clone(),
            auth_time,
            end_time,
            realm: realm.clone(),
            sname: sname.clone(),
            addresses: addresses.0.clone().map(|addresses| addresses.0),
        },
        &initial_key,
        tgs_rep_key_usage,
    )?;

    Ok(TgsRep::from(KdcRep {
        pvno: ExplicitContextTag0::from(IntegerAsn1::from(vec![KERBEROS_VERSION])),
        msg_type: ExplicitContextTag1::from(IntegerAsn1::from(vec![TGS_REP_MSG_TYPE])),
        padata: Optional::from(None),
        crealm: ExplicitContextTag3::from(realm.clone()),
        cname: ExplicitContextTag4::from(cname.clone()),
        ticket: ExplicitContextTag5::from(make_ticket(MakeTicketParams {
            realm,
            session_key,
            ticket_encryption_key: &ticket_enc_key,
            kdc_options: kdc_options.0.clone(),
            sname: sname.clone(),
            cname,
            etype: etype.clone(),
            auth_time,
            end_time,
        })?),
        enc_part: ExplicitContextTag6::from(EncryptedData {
            etype: ExplicitContextTag0::from(IntegerAsn1::from(vec![u8::from(etype)])),
            kvno: Optional::from(None),
            cipher: ExplicitContextTag2::from(OctetStringAsn1::from(tgs_rep_enc_part)),
        }),
    }))
}
