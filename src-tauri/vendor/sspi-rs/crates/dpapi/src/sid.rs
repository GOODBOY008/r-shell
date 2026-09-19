use std::sync::LazyLock;

use regex::Regex;
use thiserror::Error;

use crate::{Error, Result};

#[derive(Debug, Error)]
pub enum SidError {
    #[error("invalid sid value: {0}")]
    InvalidSid(String),
}

static SID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^S-(\d)-(\d+)(?:-\d+){1,15}$").expect("valid SID regex"));

pub(crate) fn sid_to_bytes(sid: &str) -> Result<Vec<u8>> {
    if !SID_PATTERN.is_match(sid) {
        Err(SidError::InvalidSid(sid.to_owned()))?;
    }

    let parts = sid.split('-').collect::<Vec<_>>();

    if parts.len() < 3 {
        Err(SidError::InvalidSid(sid.to_owned()))?;
    }

    let revision = parts[1].parse::<u8>().map_err(|error| Error::ParseInt {
        description: "cannot parse SID part",
        value: parts[1].to_owned(),
        error,
    })?;
    let authority = parts[2].parse::<u64>().map_err(|error| Error::ParseInt {
        description: "cannot parse SID part",
        value: parts[2].to_owned(),
        error,
    })?;

    let mut data = Vec::new();
    data.extend_from_slice(&authority.to_be_bytes());
    data[0] = revision;
    data[1] = u8::try_from(parts.len() - 3)?;

    for part in parts.iter().skip(3) {
        let sub_auth = part.parse::<u32>().map_err(|error| Error::ParseInt {
            description: "cannot parse SID part",
            value: part.to_string(),
            error,
        })?;
        data.extend_from_slice(&sub_auth.to_le_bytes());
    }

    Ok(data)
}

pub(crate) fn ace_to_bytes(sid: &str, access_mask: u32) -> Result<Vec<u8>> {
    let sid = sid_to_bytes(sid)?;

    let mut data = Vec::new();

    // AceType, AceFlags - ACCESS_ALLOWED_ACE_TYPE.
    data.extend_from_slice(&[0, 0]);
    data.extend_from_slice(&u16::try_from(8 + sid.len())?.to_le_bytes());
    data.extend_from_slice(&access_mask.to_le_bytes());
    data.extend_from_slice(&sid);

    Ok(data)
}

pub(crate) fn acl_to_bytes(aces: &[Vec<u8>]) -> Result<Vec<u8>> {
    let ace_data_len = aces.iter().map(|a| a.len()).sum::<usize>();

    let mut data = Vec::new();

    // AclRevision, Sbz1 - ACL_REVISION.
    data.extend_from_slice(&[0x02, 0x00]);
    data.extend_from_slice(&u16::try_from(8 + ace_data_len)?.to_le_bytes());
    data.extend_from_slice(&u16::try_from(aces.len())?.to_le_bytes());
    // Sbz1.
    data.extend_from_slice(&[0x00, 0x00]);
    for ace in aces {
        data.extend_from_slice(ace);
    }

    Ok(data)
}

pub(crate) fn sd_to_bytes(
    owner: &str,
    group: &str,
    sacl: Option<&[Vec<u8>]>,
    dacl: Option<&[Vec<u8>]>,
) -> Result<Vec<u8>> {
    // Self-Relative.
    let mut control: u16 = 0b10000000 << 8;

    // While MS-DTYP state there is no required order for the dynamic data, it
    // is important that the raw bytes are exactly what Microsoft uses on the
    // server side when it computes the seed key values. Luckily the footnote
    // give the correct order the MS-GKDI expects: Sacl, Dacl, Owner, Group
    // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/11e1608c-6169-4fbc-9c33-373fc9b224f4#Appendix_A_72
    let mut dynamic_data = Vec::new();

    // Length of the SD header bytes
    let mut current_offset: u32 = 20;

    let mut sacl_offset = 0;
    if let Some(sacl) = sacl {
        let sacl_bytes = acl_to_bytes(sacl)?;
        sacl_offset = current_offset;
        current_offset += u32::try_from(sacl_bytes.len())?;

        // SACL Present.
        control |= 0b00010000;
        dynamic_data.extend_from_slice(&sacl_bytes);
    }

    let mut dacl_offset = 0;
    if let Some(dacl) = dacl {
        let dacl_bytes = acl_to_bytes(dacl)?;
        dacl_offset = current_offset;
        current_offset += u32::try_from(dacl_bytes.len())?;

        // DACL Present.
        control |= 0b00000100;
        dynamic_data.extend_from_slice(&dacl_bytes);
    }

    let owner_bytes = sid_to_bytes(owner)?;
    let owner_offset = current_offset;
    current_offset += u32::try_from(owner_bytes.len())?;
    dynamic_data.extend_from_slice(&owner_bytes);

    let group_bytes = sid_to_bytes(group)?;
    let group_offset = current_offset;
    dynamic_data.extend_from_slice(&group_bytes);

    // Revision and Sbz1.
    let mut data = [0x01, 0x00].to_vec();

    data.extend_from_slice(&control.to_le_bytes());
    data.extend_from_slice(&owner_offset.to_le_bytes());
    data.extend_from_slice(&group_offset.to_le_bytes());
    data.extend_from_slice(&sacl_offset.to_le_bytes());
    data.extend_from_slice(&dacl_offset.to_le_bytes());
    data.extend_from_slice(&dynamic_data);

    Ok(data)
}
