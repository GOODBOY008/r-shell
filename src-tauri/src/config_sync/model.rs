use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub type Records = BTreeMap<String, Value>;
pub const ROOT: &str = "folders/$root";
pub const MAX_PLAINTEXT: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub version: u32,
    pub vault_id: String,
    pub revision: u64,
    pub records: Records,
    pub tombstones: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub key: String,
    pub local: Option<Value>,
    pub remote: Option<Value>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Local,
    Remote,
}

pub fn random_id() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn secret_key(key: &str) -> bool {
    key.starts_with("credentials/")
}

// Compare authentication destinations, including inherited routing. Cosmetic
// changes do not invalidate a credential, but changing a proxy or hop does.
pub fn binding(records: &Records, owner: &str) -> Value {
    const FIELDS: &[&str] = &[
        "host",
        "port",
        "username",
        "protocol",
        "authMethod",
        "domain",
        "proxyType",
        "proxyHost",
        "proxyPort",
        "proxyUsername",
        "tunnelEnabled",
        "tunnelHost",
        "tunnelPort",
        "tunnelUsername",
        "tunnelAuthMethod",
        "jumpHosts",
        "profileId",
        "ftpsEnabled",
    ];
    fn route(value: &Value) -> Value {
        let mut out = serde_json::Map::new();
        for key in FIELDS {
            if let Some(v) = value.get(*key) {
                out.insert((*key).into(), v.clone());
            }
        }
        Value::Object(out)
    }
    let value = records.get(owner).unwrap_or(&Value::Null);
    let profile = value
        .get("profileId")
        .and_then(Value::as_str)
        .and_then(|id| records.get(&format!("profiles/{id}")))
        .map(route);
    json!({"target": route(value), "profile": profile})
}

pub fn validate(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.version != 1 {
        return Err("SYNC_VERSION".into());
    }
    if snapshot.vault_id.is_empty()
        || snapshot.vault_id.len() > 128
        || snapshot.records.len() > 50_000
        || snapshot.tombstones.len() > 100_000
    {
        return Err("SYNC_INVALID_DATA".into());
    }
    for key in snapshot.records.keys().chain(snapshot.tombstones.iter()) {
        if key.len() > 1024
            || ![
                "folders/",
                "connections/",
                "profiles/",
                "snippets/",
                "settings/",
                "terminal/",
                "editor/",
                "language/",
                "shortcuts/",
                "monitors/",
                "dashboards/",
                "credentials/",
            ]
            .iter()
            .any(|p| key.starts_with(p) && key.len() > p.len())
        {
            return Err("SYNC_INVALID_DATA".into());
        }
    }
    if snapshot
        .records
        .keys()
        .any(|key| snapshot.tombstones.contains(key))
        || snapshot.tombstones.contains(ROOT)
    {
        return Err("SYNC_INVALID_DATA".into());
    }
    validate_references(&snapshot.records)
}

pub fn validate_references(records: &Records) -> Result<(), String> {
    if !records.contains_key(ROOT) {
        return Err("SYNC_REFERENCES".into());
    }
    for (key, value) in records {
        if key.starts_with("folders/") {
            let mut seen = BTreeSet::new();
            let mut current = key.to_string();
            while current != ROOT {
                if !seen.insert(current.clone()) {
                    return Err("SYNC_REFERENCES".into());
                }
                let parent = records
                    .get(&current)
                    .and_then(|v| v.get("parentId"))
                    .and_then(Value::as_str)
                    .ok_or("SYNC_REFERENCES")?;
                current = format!("folders/{parent}");
                if !records.contains_key(&current) {
                    return Err("SYNC_REFERENCES".into());
                }
            }
        }
        if key.starts_with("connections/") {
            for (field, prefix) in [("folderId", "folders/"), ("profileId", "profiles/")] {
                if let Some(id) = value.get(field).and_then(Value::as_str) {
                    if !records.contains_key(&format!("{prefix}{id}")) {
                        return Err("SYNC_REFERENCES".into());
                    }
                }
            }
        }
        if key.starts_with("monitors/")
            && key != "monitors/$global"
            && !records.contains_key(&key.replacen("monitors/", "connections/", 1))
        {
            return Err("SYNC_REFERENCES".into());
        }
        if key.starts_with("dashboards/") {
            let sources = value
                .get("sources")
                .and_then(Value::as_array)
                .ok_or("SYNC_INVALID_DATA")?;
            for source in sources {
                for id in source
                    .get("connectionIds")
                    .and_then(Value::as_array)
                    .ok_or("SYNC_INVALID_DATA")?
                {
                    if !records.contains_key(&format!(
                        "connections/{}",
                        id.as_str().ok_or("SYNC_INVALID_DATA")?
                    )) {
                        return Err("SYNC_REFERENCES".into());
                    }
                }
            }
        }
    }
    // Paths are unique even though IDs, not paths, establish identity.
    let mut paths = BTreeSet::new();
    for key in records.keys().filter(|k| k.starts_with("folders/")) {
        if !paths.insert(folder_path(records, key)?) {
            return Err("SYNC_REFERENCES".into());
        }
    }
    Ok(())
}

fn folder_path(records: &Records, key: &str) -> Result<Vec<String>, String> {
    let mut current = key.to_owned();
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return Err("SYNC_REFERENCES".into());
        }
        let value = records.get(&current).ok_or("SYNC_REFERENCES")?;
        result.push(
            value
                .get("name")
                .and_then(Value::as_str)
                .ok_or("SYNC_INVALID_DATA")?
                .to_owned(),
        );
        if current == ROOT {
            break;
        }
        current = format!(
            "folders/{}",
            value
                .get("parentId")
                .and_then(Value::as_str)
                .ok_or("SYNC_REFERENCES")?
        );
    }
    result.reverse();
    Ok(result)
}

/// First join only: unify folders by complete path, never connections by name.
pub fn align_folders(local: &mut Records, remote: &Records) -> Result<(), String> {
    let paths: BTreeMap<_, _> = remote
        .keys()
        .filter(|k| k.starts_with("folders/"))
        .map(|k| Ok((folder_path(remote, k)?, k[8..].to_owned())))
        .collect::<Result<_, String>>()?;
    let mapping: BTreeMap<_, _> = local
        .keys()
        .filter(|k| k.starts_with("folders/"))
        .filter_map(|k| {
            folder_path(local, k)
                .ok()
                .and_then(|p| paths.get(&p).map(|id| (k[8..].to_owned(), id.clone())))
        })
        .collect();
    let mut aligned = Records::new();
    for (key, mut value) in std::mem::take(local) {
        for field in ["parentId", "folderId"] {
            if let Some(id) = value
                .get(field)
                .and_then(Value::as_str)
                .and_then(|id| mapping.get(id))
                .cloned()
            {
                value[field] = Value::String(id);
            }
        }
        let key = if let Some(id) = key.strip_prefix("folders/").and_then(|id| mapping.get(id)) {
            format!("folders/{id}")
        } else {
            key
        };
        aligned.insert(key, value);
    }
    *local = aligned;
    Ok(())
}

fn related(key: &str) -> bool {
    [
        "folders/",
        "connections/",
        "profiles/",
        "monitors/",
        "dashboards/",
        "credentials/",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

pub fn merge(
    base: Option<&Snapshot>,
    local: &Records,
    remote: &Snapshot,
    choices: &BTreeMap<String, Choice>,
) -> (Snapshot, Vec<Conflict>) {
    let empty = Records::new();
    let base_records = base.map(|b| &b.records).unwrap_or(&empty);
    let keys: BTreeSet<_> = base_records
        .keys()
        .chain(local.keys())
        .chain(remote.records.keys())
        .chain(remote.tombstones.iter())
        .cloned()
        .collect();
    let mut result = remote.clone();
    let mut conflicts = Vec::new();
    result.records.clear();
    for key in keys {
        let b = base_records.get(&key);
        let l = local.get(&key);
        let r = remote.records.get(&key);
        let choice = if let Some(c) = choices.get(&key) {
            Some(if *c == Choice::Local { l } else { r })
        } else if l == r {
            Some(l)
        } else if base.is_some() && l == b {
            Some(r)
        } else if base.is_some() && r == b && !(b.is_none() && remote.tombstones.contains(&key)) {
            Some(l)
        } else if base.is_none() && l.is_none() {
            Some(r)
        } else if base.is_none() && r.is_none() && !remote.tombstones.contains(&key) {
            Some(l)
        } else {
            choices
                .get(&key)
                .map(|c| if *c == Choice::Local { l } else { r })
        };
        let value = match choice {
            Some(value) => value,
            None => {
                // Secrets never leave Rust in conflict previews.
                let preview = |v: Option<&Value>| {
                    if secret_key(&key) {
                        v.map(|_| json!({"saved": true}))
                    } else {
                        v.cloned()
                    }
                };
                conflicts.push(Conflict {
                    key: key.clone(),
                    local: preview(l),
                    remote: preview(r),
                });
                r
            }
        };
        if let Some(value) = value {
            result.records.insert(key.clone(), value.clone());
            result.tombstones.remove(&key);
        } else if b.is_some() || remote.tombstones.contains(&key) {
            result.tombstones.insert(key);
        }
    }
    // Deleting a connection also retires its secret; never create an orphan.
    let orphaned: Vec<_> = result
        .records
        .keys()
        .filter_map(|key| {
            key.strip_prefix("credentials/")
                .filter(|owner| !result.records.contains_key(*owner))
                .map(|_| key.clone())
        })
        .collect();
    for key in orphaned {
        result.records.remove(&key);
        result.tombstones.insert(key);
    }
    if validate_references(&result.records).is_err() {
        if let Some(side) = choices.get("@relationships") {
            let selected = if *side == Choice::Local {
                local
            } else {
                &remote.records
            };
            let affected: BTreeSet<_> = result
                .records
                .keys()
                .chain(selected.keys())
                .chain(result.tombstones.iter())
                .filter(|k| related(k))
                .cloned()
                .collect();
            for key in affected {
                if let Some(v) = selected.get(&key) {
                    result.records.insert(key.clone(), v.clone());
                    result.tombstones.remove(&key);
                } else {
                    result.records.remove(&key);
                    result.tombstones.insert(key);
                }
            }
        } else {
            let preview = |records: &Records| {
                Value::Object(
                    records
                        .iter()
                        .filter(|(k, _)| related(k) && !secret_key(k))
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                )
            };
            conflicts.push(Conflict {
                key: "@relationships".into(),
                local: Some(preview(local)),
                remote: Some(preview(&remote.records)),
            });
        }
    }
    (result, conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> Snapshot {
        Snapshot {
            version: 1,
            vault_id: "test".into(),
            revision: 1,
            records: BTreeMap::from([
                (ROOT.into(), json!({"name":"All Connections"})),
                (
                    "connections/a".into(),
                    json!({"name":"A","host":"a","folderId":"$root"}),
                ),
            ]),
            ..Default::default()
        }
    }
    #[test]
    fn independent_edits_converge_and_replay_is_idempotent() {
        let base = fixture();
        let mut l = base.records.clone();
        let mut r = base.clone();
        l.insert("settings/theme".into(), json!("dark"));
        r.records.get_mut("connections/a").unwrap()["name"] = json!("Renamed");
        let (merged, conflicts) = merge(Some(&base), &l, &r, &BTreeMap::new());
        assert!(conflicts.is_empty());
        assert_eq!(merged.records["settings/theme"], "dark");
        assert_eq!(merged.records["connections/a"]["name"], "Renamed");
        assert_eq!(
            merge(Some(&merged), &merged.records, &merged, &BTreeMap::new()).0,
            merged
        );
    }
    #[test]
    fn deletion_propagates_but_offline_edit_needs_choice() {
        let base = fixture();
        let mut remote = base.clone();
        remote.records.remove("connections/a");
        remote.tombstones.insert("connections/a".into());
        let (merged, c) = merge(Some(&base), &base.records, &remote, &BTreeMap::new());
        assert!(c.is_empty());
        assert!(!merged.records.contains_key("connections/a"));
        let mut local = base.records.clone();
        local.get_mut("connections/a").unwrap()["host"] = json!("other");
        assert_eq!(
            merge(Some(&base), &local, &remote, &BTreeMap::new())
                .1
                .len(),
            1
        );
        assert_eq!(merge(None, &local, &remote, &BTreeMap::new()).1.len(), 1);
    }
    #[test]
    fn rename_and_new_child_keep_stable_parent() {
        let mut base = fixture();
        base.records.insert(
            "folders/f".into(),
            json!({"name":"Work","parentId":"$root"}),
        );
        let mut remote = base.clone();
        remote.records.get_mut("folders/f").unwrap()["name"] = json!("Office");
        let mut local = base.records.clone();
        local.insert("connections/b".into(), json!({"name":"B","folderId":"f"}));
        let (merged, c) = merge(Some(&base), &local, &remote, &BTreeMap::new());
        assert!(c.is_empty());
        validate(&merged).unwrap();
        assert_eq!(merged.records["connections/b"]["folderId"], "f");
    }
    #[test]
    fn dangling_parent_has_explicit_group_resolution() {
        let mut base = fixture();
        base.records.insert(
            "folders/f".into(),
            json!({"name":"Work","parentId":"$root"}),
        );
        let mut remote = base.clone();
        remote.records.remove("folders/f");
        remote.tombstones.insert("folders/f".into());
        let mut local = base.records.clone();
        local.insert("connections/b".into(), json!({"folderId":"f"}));
        assert!(merge(Some(&base), &local, &remote, &BTreeMap::new())
            .1
            .iter()
            .any(|c| c.key == "@relationships"));
        let (merged, c) = merge(
            Some(&base),
            &local,
            &remote,
            &BTreeMap::from([("@relationships".into(), Choice::Local)]),
        );
        assert!(c.is_empty());
        validate(&merged).unwrap();
    }
    #[test]
    fn routing_binding_ignores_cosmetics_but_includes_proxy() {
        let mut records = fixture().records;
        let before = binding(&records, "connections/a");
        records.get_mut("connections/a").unwrap()["name"] = json!("Rename");
        assert_eq!(before, binding(&records, "connections/a"));
        records.get_mut("connections/a").unwrap()["proxyHost"] = json!("another");
        assert_ne!(before, binding(&records, "connections/a"));
    }
}
