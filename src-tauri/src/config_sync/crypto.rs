use super::model::{Snapshot, MAX_PLAINTEXT};
use crate::commands::{backup_key, open_with_key, seal_with_key};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
const AAD: &[u8] = b"r-shell-config-sync-v1";

pub fn encrypt(passphrase: &str, snapshot: &Snapshot) -> Result<String, String> {
    if passphrase.is_empty() {
        return Err("SYNC_LOCKED".into());
    }
    let text = serde_json::to_string(snapshot).map_err(|_| "SYNC_INVALID_DATA")?;
    if text.len() > MAX_PLAINTEXT {
        return Err("SYNC_TOO_LARGE".into());
    }
    use rand::Rng;
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let sealed = seal_with_key(&backup_key(passphrase, &salt)?, &text, AAD)?;
    Ok(format!("s1:{}:{}", BASE64.encode(salt), &sealed[3..]))
}

pub fn decrypt(passphrase: &str, sealed: &str) -> Result<Snapshot, String> {
    if sealed.len() > super::provider::MAX_WIRE {
        return Err("SYNC_TOO_LARGE".into());
    }
    let parts: Vec<_> = sealed.split(':').collect();
    if parts.len() != 4 || parts[0] != "s1" {
        return Err("SYNC_VERSION".into());
    }
    let salt: [u8; 16] = BASE64
        .decode(parts[1])
        .map_err(|_| "SYNC_INVALID_DATA")?
        .try_into()
        .map_err(|_| "SYNC_INVALID_DATA")?;
    let text = open_with_key(
        &backup_key(passphrase, &salt)?,
        &format!("v1:{}:{}", parts[2], parts[3]),
        AAD,
    )
    .map_err(|_| "SYNC_DECRYPT")?;
    if text.len() > MAX_PLAINTEXT {
        return Err("SYNC_TOO_LARGE".into());
    }
    let snapshot: Snapshot = serde_json::from_str(&text).map_err(|_| "SYNC_INVALID_DATA")?;
    super::model::validate(&snapshot)?;
    Ok(snapshot)
}

pub fn transform_secrets(
    value: &mut serde_json::Value,
    key: &[u8],
    opening: bool,
) -> Result<(), String> {
    match value {
        serde_json::Value::Object(map) => {
            for (field, value) in map {
                if field == "jumpHosts" {
                    transform_secrets(value, key, opening)?;
                } else if [
                    "password",
                    "passphrase",
                    "proxyPassword",
                    "vncPassword",
                    "tunnelPassword",
                    "tunnelPassphrase",
                    "sudoPassword",
                ]
                .contains(&field.as_str())
                {
                    let text = value.as_str().ok_or("SYNC_INVALID_DATA")?;
                    if !text.is_empty() {
                        *value = serde_json::Value::String(if opening {
                            open_with_key(key, text, b"").map_err(|_| "SYNC_LOCAL_SECRET")?
                        } else {
                            seal_with_key(key, text, b"").map_err(|_| "SYNC_LOCAL_SECRET")?
                        });
                    }
                } else {
                    return Err("SYNC_INVALID_DATA".into());
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                transform_secrets(item, key, opening)?;
            }
        }
        _ => return Err("SYNC_INVALID_DATA".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn portable_authenticated_snapshot_and_empty_passwords() {
        let mut snapshot = Snapshot {
            version: 1,
            vault_id: "test".into(),
            revision: 1,
            ..Default::default()
        };
        snapshot.records.insert(
            super::super::model::ROOT.into(),
            json!({"name":"All Connections"}),
        );
        snapshot
            .records
            .insert("settings/theme".into(), json!("dark"));
        let sealed = encrypt("sync password", &snapshot).unwrap();
        assert!(!sealed.contains("dark"));
        assert_eq!(decrypt("sync password", &sealed).unwrap(), snapshot);
        assert!(decrypt("wrong", &sealed).is_err());
        let mut damaged = sealed.clone();
        damaged.pop();
        damaged.push('X');
        assert!(decrypt("sync password", &damaged).is_err());
        assert!(decrypt("sync password", &sealed.replacen("s1:", "b1:", 1)).is_err());
        let mut values = json!({"password":"","jumpHosts":[{"password":"secret"}]});
        transform_secrets(&mut values, &[1u8; 32], false).unwrap();
        assert_eq!(values["password"], "");
        assert!(transform_secrets(&mut values.clone(), &[2u8; 32], true).is_err());
        transform_secrets(&mut values, &[1u8; 32], true).unwrap();
        transform_secrets(&mut values, &[2u8; 32], false).unwrap();
        transform_secrets(&mut values, &[2u8; 32], true).unwrap();
        assert_eq!(values["jumpHosts"][0]["password"], "secret");
    }
}
