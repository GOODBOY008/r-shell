mod crypto;
mod model;
mod provider;

use model::{Choice, Conflict, Records, Snapshot};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

const FILE: &str = "r-shell-sync-v1.enc";
const STATE_AAD: &[u8] = b"r-shell-config-sync-state-v1";

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub enabled: bool,
    pub paused: bool,
    pub url: String,
    pub username: String,
    pub credentials: bool,
    pub remember_passphrase: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    options: Options,
    server_password: String,
    passphrase: Option<String>,
    base: Option<Snapshot>,
    pending: Option<Pending>,
    last_applied_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    id: String,
    snapshot: Snapshot,
}

struct Plan {
    id: String,
    raw: Records,
    local: Records,
    remote: Snapshot,
    etag: Option<String>,
}
struct Runtime {
    stored: Stored,
    passphrase: Option<String>,
    plan: Option<Plan>,
    process_lock: Option<std::fs::File>,
}
#[derive(Default)]
pub struct SyncService {
    inner: Mutex<Option<Runtime>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    options: Options,
    has_server_password: bool,
    unlocked: bool,
    initialized: bool,
    last_applied_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    plan_id: String,
    first_sync: bool,
    snapshot: Snapshot,
    conflicts: Vec<Conflict>,
    changes: Vec<Change>,
}
#[derive(Serialize)]
pub struct Change {
    key: String,
    action: &'static str,
    target: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBatch {
    pub id: String,
    pub snapshot: Snapshot,
}

#[derive(Serialize, Deserialize)]
pub struct ApplyJournal {
    id: String,
    before: BTreeMap<String, Option<String>>,
    after: BTreeMap<String, Option<String>>,
}
#[derive(Serialize)]
pub struct Recovery {
    pub id: String,
    pub image: BTreeMap<String, Option<String>>,
}
const JOURNAL_AAD: &[u8] = b"r-shell-config-sync-apply-v1";
fn journal_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(state_path(app)?.with_file_name("apply.enc"))
}

fn atomic_secret(path: &Path, text: &str, key: &[u8], aad: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("SYNC_LOCAL_STORAGE")?;
    std::fs::create_dir_all(parent).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let sealed = crate::commands::seal_with_key(key, text, aad).map_err(|_| "SYNC_LOCAL_SECRET")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    file.write_all(sealed.as_bytes())
        .map_err(|_| "SYNC_LOCAL_STORAGE")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "SYNC_LOCAL_STORAGE")?;
    file.persist(path).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    Ok(())
}

#[tauri::command]
pub async fn config_sync_stage_apply(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    journal: ApplyJournal,
) -> Result<(), String> {
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    if runtime
        .stored
        .pending
        .as_ref()
        .is_none_or(|p| p.id != journal.id)
    {
        return Err("SYNC_STALE".into());
    }
    let path = journal_path(&app)?;
    if path.exists() {
        return Err("SYNC_RECOVERY_REQUIRED".into());
    }
    let text = serde_json::to_string(&journal).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    if text.len() > 64 * 1024 * 1024 {
        return Err("SYNC_TOO_LARGE".into());
    }
    let key = machine_key(&app)?;
    atomic_secret(&path, &text, &key, JOURNAL_AAD)?;
    atomic_secret(
        &path.with_file_name("backup.enc"),
        &serde_json::to_string(&journal.before).map_err(|_| "SYNC_LOCAL_STORAGE")?,
        &key,
        JOURNAL_AAD,
    )
}

#[tauri::command]
pub async fn config_sync_recovery(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
) -> Result<Option<Recovery>, String> {
    let path = journal_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    let encrypted = std::fs::read_to_string(path).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let text = crate::commands::open_with_key(&machine_key(&app)?, &encrypted, JOURNAL_AAD)
        .map_err(|_| "SYNC_LOCAL_SECRET")?;
    let journal: ApplyJournal = serde_json::from_str(&text).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let committed = runtime.stored.last_applied_id.as_ref() == Some(&journal.id);
    Ok(Some(Recovery {
        id: journal.id,
        image: if committed {
            journal.after
        } else {
            journal.before
        },
    }))
}

#[tauri::command]
pub async fn config_sync_finish_apply(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = journal_path(&app)?;
    if !path.exists() {
        return Ok(());
    }
    let encrypted = std::fs::read_to_string(&path).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let text = crate::commands::open_with_key(&machine_key(&app)?, &encrypted, JOURNAL_AAD)
        .map_err(|_| "SYNC_LOCAL_SECRET")?;
    let journal: ApplyJournal = serde_json::from_str(&text).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    if journal.id != id {
        return Err("SYNC_STALE".into());
    }
    std::fs::remove_file(path).map_err(|_| "SYNC_LOCAL_STORAGE".into())
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("config-sync/state.enc"))
        .map_err(|_| "SYNC_LOCAL_STORAGE".into())
}
fn machine_key(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    crate::commands::master_key(crate::commands::dev_master_key_path(app)?.as_deref())
        .map_err(|_| "SYNC_LOCAL_SECRET".into())
}
fn load<'a>(
    runtime: &'a mut Option<Runtime>,
    app: &tauri::AppHandle,
) -> Result<&'a mut Runtime, String> {
    if runtime.is_none() {
        *runtime = Some(Runtime {
            passphrase: None,
            stored: Stored::default(),
            plan: None,
            process_lock: None,
        });
    }
    let runtime = runtime.as_mut().expect("initialized above");
    if state_path(app)?.exists() {
        ensure_process_lock(runtime, app)?;
    }
    Ok(runtime)
}

fn acquire_process_lock(path: &Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(path.parent().ok_or("SYNC_LOCAL_STORAGE")?)
        .map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "SYNC_LOCAL_STORAGE")?;
    file.try_lock().map_err(|_| "SYNC_BUSY")?;
    Ok(file)
}

fn ensure_process_lock(runtime: &mut Runtime, app: &tauri::AppHandle) -> Result<(), String> {
    if runtime.process_lock.is_some() {
        return Ok(());
    }
    let path = state_path(app)?;
    let lock = acquire_process_lock(&path.with_file_name("process.lock"))?;
    // Read only after acquiring the lock: another app process may have created
    // this state since our disabled initial status query.
    if path.exists() {
        let encrypted = std::fs::read_to_string(&path).map_err(|_| "SYNC_LOCAL_STORAGE")?;
        let text = crate::commands::open_with_key(&machine_key(app)?, &encrypted, STATE_AAD)
            .map_err(|_| "SYNC_LOCAL_SECRET")?;
        let stored: Stored = serde_json::from_str(&text).map_err(|_| "SYNC_LOCAL_STORAGE")?;
        runtime.passphrase = stored.passphrase.clone();
        runtime.stored = stored;
    }
    runtime.process_lock = Some(lock);
    Ok(())
}

fn write_state(path: &Path, stored: &Stored, key: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("SYNC_LOCAL_STORAGE")?;
    std::fs::create_dir_all(parent).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let text = serde_json::to_string(stored).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let encrypted =
        crate::commands::seal_with_key(key, &text, STATE_AAD).map_err(|_| "SYNC_LOCAL_SECRET")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    file.write_all(encrypted.as_bytes())
        .map_err(|_| "SYNC_LOCAL_STORAGE")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "SYNC_LOCAL_STORAGE")?;
    file.persist(path).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    Ok(())
}

fn status(runtime: &Runtime) -> Status {
    Status {
        options: runtime.stored.options.clone(),
        has_server_password: !runtime.stored.server_password.is_empty(),
        unlocked: runtime.passphrase.is_some(),
        initialized: runtime.stored.base.is_some(),
        last_applied_id: runtime.stored.last_applied_id.clone(),
    }
}

fn local_plain(raw: &Records, key: &[u8], enabled: bool) -> Result<Records, String> {
    if serde_json::to_vec(raw)
        .map_err(|_| "SYNC_INVALID_DATA")?
        .len()
        > model::MAX_PLAINTEXT
    {
        return Err("SYNC_TOO_LARGE".into());
    }
    let mut records = raw.clone();
    records.retain(|k, _| enabled || !model::secret_key(k));
    for (name, value) in records.iter_mut().filter(|(k, _)| model::secret_key(k)) {
        let owner = name
            .strip_prefix("credentials/")
            .ok_or("SYNC_INVALID_DATA")?;
        if !raw.contains_key(owner) {
            return Err("SYNC_REFERENCES".into());
        }
        let values = value.get_mut("values").ok_or("SYNC_INVALID_DATA")?;
        crypto::transform_secrets(values, key, true)?;
        value["binding"] = model::binding(raw, owner);
    }
    let validation = Snapshot {
        version: 1,
        vault_id: "local".into(),
        records: records.clone(),
        ..Default::default()
    };
    model::validate(&validation)?;
    Ok(records)
}

fn for_device(
    snapshot: &Snapshot,
    raw: &Records,
    key: &[u8],
    enabled: bool,
) -> Result<Snapshot, String> {
    let plain = local_plain(raw, key, enabled)?;
    let mut result = snapshot.clone();
    result.records.retain(|name, value| {
        !model::secret_key(name)
            || (enabled
                && value.get("binding") == Some(&model::binding(&snapshot.records, &name[12..])))
    });
    for (name, value) in result
        .records
        .iter_mut()
        .filter(|(k, _)| model::secret_key(k))
    {
        if plain.get(name) == Some(value) {
            *value = raw.get(name).ok_or("SYNC_INVALID_DATA")?.clone();
        } else {
            crypto::transform_secrets(
                value.get_mut("values").ok_or("SYNC_INVALID_DATA")?,
                key,
                false,
            )?;
        }
    }
    Ok(result)
}

fn dav(runtime: &Runtime) -> Result<provider::WebDav, String> {
    provider::WebDav::new(
        &runtime.stored.options.url,
        &runtime.stored.options.username,
        &runtime.stored.server_password,
    )
}

#[tauri::command]
pub async fn config_sync_status(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
) -> Result<Status, String> {
    let mut lock = service.inner.lock().await;
    Ok(status(load(&mut lock, &app)?))
}

#[tauri::command]
pub async fn config_sync_test(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    url: String,
    username: String,
    password: Option<String>,
) -> Result<(), String> {
    let password = if let Some(password) = password {
        password
    } else {
        let mut lock = service.inner.lock().await;
        let runtime = load(&mut lock, &app)?;
        if runtime.stored.options.url != url || runtime.stored.options.username != username {
            return Err("SYNC_AUTH".into());
        }
        runtime.stored.server_password.clone()
    };
    provider::WebDav::new(&url, &username, &password)?
        .probe()
        .await
}

#[tauri::command]
pub async fn config_sync_configure(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    options: Options,
    server_password: Option<String>,
    passphrase: Option<String>,
) -> Result<Status, String> {
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    ensure_process_lock(runtime, &app)?;
    let target_changed = options.url != runtime.stored.options.url
        || options.username != runtime.stored.options.username;
    let password = server_password.unwrap_or_else(|| {
        if target_changed {
            String::new()
        } else {
            runtime.stored.server_password.clone()
        }
    });
    let mut next = runtime.stored.clone();
    if options.enabled {
        let provider = provider::WebDav::new(&options.url, &options.username, &password)?;
        if target_changed
            || !runtime.stored.options.enabled
            || password != runtime.stored.server_password
        {
            provider.probe().await?;
        }
    }
    if target_changed {
        next.base = None;
        next.pending = None;
        next.last_applied_id = None;
    }
    let phrase = passphrase
        .or_else(|| {
            if target_changed {
                None
            } else {
                runtime.passphrase.clone()
            }
        })
        .filter(|s| !s.is_empty());
    next.options = options;
    next.server_password = password;
    next.passphrase = if next.options.remember_passphrase {
        phrase.clone()
    } else {
        None
    };
    write_state(&state_path(&app)?, &next, &machine_key(&app)?)?;
    runtime.stored = next;
    runtime.passphrase = phrase;
    runtime.plan = None;
    let current = status(runtime);
    let _ = app.emit("config-sync-state", &current);
    Ok(current)
}

#[tauri::command]
pub async fn config_sync_prepare(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    records: Records,
) -> Result<Preview, String> {
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    if !runtime.stored.options.enabled {
        return Err("SYNC_DISABLED".into());
    }
    let phrase = runtime.passphrase.clone().ok_or("SYNC_LOCKED")?;
    let key = machine_key(&app)?;
    let mut local = local_plain(&records, &key, runtime.stored.options.credentials)?;
    let file = dav(runtime)?.read(FILE).await?;
    let (remote, etag) = if let Some(file) = file {
        let remote = tokio::task::spawn_blocking(move || crypto::decrypt(&phrase, &file.body))
            .await
            .map_err(|_| "SYNC_DECRYPT")??;
        (remote, Some(file.etag))
    } else {
        if runtime.stored.base.is_some() || runtime.stored.pending.is_some() {
            return Err("SYNC_REMOTE_MISSING".into());
        }
        let mut remote = Snapshot {
            version: 1,
            vault_id: model::random_id(),
            revision: 0,
            ..Default::default()
        };
        remote.records.insert(
            model::ROOT.into(),
            serde_json::json!({"name":"All Connections"}),
        );
        (remote, None)
    };
    if let Some(base) = &runtime.stored.base {
        if remote.vault_id != base.vault_id
            || remote.revision < base.revision
            || (remote.revision == base.revision && remote != *base)
        {
            return Err("SYNC_REMOTE_CHANGED".into());
        }
    } else {
        model::align_folders(&mut local, &remote.records)?;
    }
    if !runtime.stored.options.credentials {
        // Absence while opted out is not a deletion. Preserve the base for the
        // merge, including secrets another device adds for the first time.
        if let Some(base) = &runtime.stored.base {
            local.extend(
                base.records
                    .iter()
                    .filter(|(k, _)| model::secret_key(k))
                    .map(|(k, v)| (k.clone(), v.clone())),
            );
        }
    }
    let (candidate, conflicts) = model::merge(
        runtime.stored.base.as_ref(),
        &local,
        &remote,
        &BTreeMap::new(),
    );
    let mut changes = Vec::new();
    for (target, existing) in [("local", &local), ("remote", &remote.records)] {
        let keys: std::collections::BTreeSet<_> = existing
            .keys()
            .chain(candidate.records.keys())
            .cloned()
            .collect();
        changes.extend(
            keys.into_iter()
                .filter(|k| existing.get(k) != candidate.records.get(k))
                .map(|key| {
                    let action = if !candidate.records.contains_key(&key) {
                        "delete"
                    } else if !existing.contains_key(&key) {
                        "add"
                    } else {
                        "update"
                    };
                    Change {
                        key,
                        action,
                        target,
                    }
                }),
        );
    }
    let id = model::random_id();
    let preview = Preview {
        plan_id: id.clone(),
        first_sync: runtime.stored.base.is_none(),
        snapshot: for_device(
            &candidate,
            &records,
            &key,
            runtime.stored.options.credentials,
        )?,
        conflicts,
        changes,
    };
    runtime.plan = Some(Plan {
        id,
        raw: records,
        local,
        remote,
        etag,
    });
    Ok(preview)
}

#[tauri::command]
pub async fn config_sync_commit(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    plan_id: String,
    records: Records,
    choices: BTreeMap<String, Choice>,
) -> Result<ApplyBatch, String> {
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    let plan = runtime
        .plan
        .as_ref()
        .filter(|p| p.id == plan_id)
        .ok_or("SYNC_STALE")?;
    if records != plan.raw {
        return Err("SYNC_STALE".into());
    }
    let (mut candidate, conflicts) = model::merge(
        runtime.stored.base.as_ref(),
        &plan.local,
        &plan.remote,
        &choices,
    );
    if !conflicts.is_empty() {
        return Err("SYNC_CONFLICT".into());
    }
    model::validate(&candidate)?;
    let key = machine_key(&app)?;
    // Prepare every local secret before publishing; no partial credential restore.
    let mut local = for_device(
        &candidate,
        &records,
        &key,
        runtime.stored.options.credentials,
    )?;
    let provider = dav(runtime)?;
    // Revalidate even a download-only plan: choices cannot target an obsolete revision.
    let current = provider.read(FILE).await?;
    if current.as_ref().map(|f| f.etag.as_str()) != plan.etag.as_deref() {
        return Err("SYNC_STALE".into());
    }
    if candidate.records != plan.remote.records
        || candidate.tombstones != plan.remote.tombstones
        || plan.etag.is_none()
    {
        candidate.revision = plan
            .remote
            .revision
            .checked_add(1)
            .ok_or("SYNC_INVALID_DATA")?;
        let phrase = runtime.passphrase.clone().ok_or("SYNC_LOCKED")?;
        let copy = candidate.clone();
        let encrypted = tokio::task::spawn_blocking(move || crypto::encrypt(&phrase, &copy))
            .await
            .map_err(|_| "SYNC_LOCAL_SECRET")??;
        provider
            .write(FILE, encrypted, plan.etag.as_deref())
            .await?;
    }
    local.revision = candidate.revision;
    let id = model::random_id();
    let mut next = runtime.stored.clone();
    next.pending = Some(Pending {
        id: id.clone(),
        snapshot: candidate,
    });
    write_state(&state_path(&app)?, &next, &key)?;
    runtime.stored = next;
    runtime.plan = None;
    Ok(ApplyBatch {
        id,
        snapshot: local,
    })
}

#[tauri::command]
pub async fn config_sync_ack(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    id: String,
) -> Result<(), String> {
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    if runtime.stored.last_applied_id.as_ref() == Some(&id) {
        return Ok(());
    }
    let pending = runtime
        .stored
        .pending
        .as_ref()
        .filter(|p| p.id == id)
        .ok_or("SYNC_STALE")?;
    let mut next = runtime.stored.clone();
    next.base = Some(pending.snapshot.clone());
    next.pending = None;
    next.last_applied_id = Some(id);
    write_state(&state_path(&app)?, &next, &machine_key(&app)?)?;
    runtime.stored = next;
    let _ = app.emit("config-sync-state", status(runtime));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn separate_process_handles_cannot_share_sync_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("process.lock");
        let first = acquire_process_lock(&path).unwrap();
        assert!(acquire_process_lock(&path).is_err());
        drop(first);
        assert!(acquire_process_lock(&path).is_ok());
    }

    #[test]
    fn state_contains_no_plaintext_and_acknowledgment_is_separate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.enc");
        let stored = Stored {
            server_password: "webdav-secret".into(),
            passphrase: Some("vault-secret".into()),
            ..Default::default()
        };
        write_state(&path, &stored, &[3u8; 32]).unwrap();
        let disk = std::fs::read_to_string(path).unwrap();
        assert!(!disk.contains("secret"));
        assert!(crate::commands::open_with_key(&[4u8; 32], &disk, STATE_AAD).is_err());
        let decoded = crate::commands::open_with_key(&[3u8; 32], &disk, STATE_AAD).unwrap();
        assert!(serde_json::from_str::<Stored>(&decoded)
            .unwrap()
            .base
            .is_none());
    }
    #[test]
    fn opt_out_preserves_local_secret_and_bound_secret_cannot_move_hosts() {
        let mut records = Records::from([
            (model::ROOT.into(), json!({"name":"All Connections"})),
            (
                "connections/a".into(),
                json!({"host":"one","folderId":"$root"}),
            ),
        ]);
        let sealed = crate::commands::seal_with_key(&[1u8; 32], "password", b"").unwrap();
        records.insert(
            "credentials/connections/a".into(),
            json!({"values":{"password":sealed}}),
        );
        let plain = local_plain(&records, &[1u8; 32], true).unwrap();
        let mut snapshot = Snapshot {
            version: 1,
            vault_id: "v".into(),
            revision: 1,
            records: plain,
            ..Default::default()
        };
        assert_eq!(
            for_device(&snapshot, &records, &[1u8; 32], true)
                .unwrap()
                .records["credentials/connections/a"],
            records["credentials/connections/a"]
        );
        assert!(!for_device(&snapshot, &records, &[1u8; 32], false)
            .unwrap()
            .records
            .contains_key("credentials/connections/a"));
        snapshot.records.get_mut("connections/a").unwrap()["host"] = json!("two");
        assert!(!for_device(&snapshot, &records, &[1u8; 32], true)
            .unwrap()
            .records
            .contains_key("credentials/connections/a"));
    }
}
