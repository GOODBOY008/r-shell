mod crypto;
mod model;
mod provider;
mod s3;
#[cfg(test)]
mod s3_integration;
mod settings;

use provider::ObjectStore;
use settings::{Options, Target};

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

/// A replacement credential pair. Omitting the pair reuses a stored secret
/// only within its original scope; replacing it also replaces its session token.
#[derive(Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuth {
    secret: String,
    session_token: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(deserialize_with = "settings::read_stored_options")]
    options: Options,
    #[serde(alias = "serverPassword")]
    provider_secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
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
    has_secret: bool,
    has_session_token: bool,
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
        let stored = read_state(&path, &machine_key(app)?)?;
        runtime.passphrase = stored.passphrase.clone();
        runtime.stored = stored;
    }
    runtime.process_lock = Some(lock);
    Ok(())
}

fn read_state(path: &Path, key: &[u8]) -> Result<Stored, String> {
    let encrypted = std::fs::read_to_string(path).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    let text = crate::commands::open_with_key(key, &encrypted, STATE_AAD)
        .map_err(|_| "SYNC_LOCAL_SECRET")?;
    serde_json::from_str(&text).map_err(|_| "SYNC_LOCAL_STORAGE".into())
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
        has_secret: !runtime.stored.provider_secret.is_empty(),
        has_session_token: runtime.stored.session_token.is_some(),
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
                && value.get("binding").is_some_and(|binding| {
                    model::binding_matches(&snapshot.records, &name[12..], binding)
                }))
    });
    for (name, value) in result
        .records
        .iter_mut()
        .filter(|(k, _)| model::secret_key(k))
    {
        // This runs before the cloud write. The webview can validate public
        // choices, but only Rust sees the resolved opaque credential blocks.
        let values = value
            .get("values")
            .and_then(serde_json::Value::as_object)
            .ok_or("SYNC_INVALID_DATA")?;
        if let Some(hops) = values.get("jumpHosts") {
            let hops = hops.as_array().ok_or("SYNC_INVALID_DATA")?;
            let owner = snapshot.records.get(&name[12..]).ok_or("SYNC_REFERENCES")?;
            let hop_count = owner
                .get("jumpHosts")
                .map(|hops| hops.as_array().map(Vec::len).ok_or("SYNC_INVALID_DATA"))
                .transpose()?
                .unwrap_or(0);
            if hops.len() != hop_count {
                return Err("SYNC_INVALID_DATA".into());
            }
            for hop in hops {
                let fields = hop.as_object().ok_or("SYNC_INVALID_DATA")?;
                if fields.iter().any(|(name, value)| {
                    !["password", "passphrase"].contains(&name.as_str()) || !value.is_string()
                }) {
                    return Err("SYNC_INVALID_DATA".into());
                }
            }
        }
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

impl Stored {
    fn auth_for(&self, target: &Target, replacement: Option<ProviderAuth>) -> ProviderAuth {
        replacement.unwrap_or_else(|| {
            if self.options.target.same_credential_scope(target) {
                ProviderAuth {
                    secret: self.provider_secret.clone(),
                    session_token: self.session_token.clone(),
                }
            } else {
                ProviderAuth::default()
            }
        })
    }

    fn provider(&self) -> Result<Box<dyn ObjectStore>, String> {
        provider_for(
            &self.options.target,
            &self.provider_secret,
            self.session_token.as_deref(),
        )
    }
}

fn provider_for(
    target: &Target,
    secret: &str,
    token: Option<&str>,
) -> Result<Box<dyn ObjectStore>, String> {
    match target {
        Target::WebDav { url, username } => {
            Ok(Box::new(provider::WebDav::new(url, username, secret)?))
        }
        Target::S3(target) => Ok(Box::new(s3::S3::new(target, secret, token)?)),
    }
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
    target: Target,
    auth: Option<ProviderAuth>,
) -> Result<(), String> {
    let auth = {
        let mut lock = service.inner.lock().await;
        load(&mut lock, &app)?.stored.auth_for(&target, auth)
    };
    provider_for(&target, &auth.secret, auth.session_token.as_deref())?
        .probe()
        .await
}

#[tauri::command]
pub async fn config_sync_configure(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    options: Options,
    auth: Option<ProviderAuth>,
    passphrase: Option<String>,
) -> Result<Status, String> {
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    ensure_process_lock(runtime, &app)?;
    configure(
        runtime,
        &state_path(&app)?,
        &machine_key(&app)?,
        options,
        auth,
        passphrase,
    )
    .await?;
    let current = status(runtime);
    let _ = app.emit("config-sync-state", &current);
    Ok(current)
}

async fn configure(
    runtime: &mut Runtime,
    path: &Path,
    key: &[u8],
    options: Options,
    replacement: Option<ProviderAuth>,
    passphrase: Option<String>,
) -> Result<(), String> {
    // The webview applies any outstanding journal before this command. Keep
    // its acknowledgment intact until then, including for direct IPC callers.
    if path
        .with_file_name("apply.enc")
        .try_exists()
        .map_err(|_| "SYNC_LOCAL_STORAGE")?
    {
        return Err("SYNC_RECOVERY_REQUIRED".into());
    }
    let target_changed = !options.target.same_vault(&runtime.stored.options.target);
    let auth = runtime.stored.auth_for(&options.target, replacement);
    let credentials_changed = auth.secret != runtime.stored.provider_secret
        || auth.session_token != runtime.stored.session_token
        || !options
            .target
            .same_credential_scope(&runtime.stored.options.target);
    let linked = runtime.stored.base.is_some() || runtime.stored.pending.is_some();
    if options.enabled || (target_changed && linked) {
        let provider = provider_for(&options.target, &auth.secret, auth.session_token.as_deref())?;
        if target_changed || credentials_changed || !runtime.stored.options.enabled {
            provider.probe().await?;
        }
    }
    let mut next = runtime.stored.clone();
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
    next.provider_secret = auth.secret;
    next.session_token = auth.session_token;
    next.passphrase = if next.options.remember_passphrase {
        phrase.clone()
    } else {
        None
    };
    write_state(path, &next, key)?;
    runtime.stored = next;
    runtime.passphrase = phrase;
    runtime.plan = None;
    Ok(())
}

/// Storage settings as they travel in a config export. The sync passphrase,
/// the baseline and the sync history are left out: they stay on this device.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedStorage {
    target: Target,
    secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
}

/// The exported block did not open: wrong passphrase or damaged data.
const EXPORT_UNREADABLE: &str = "SYNC_EXPORT_UNREADABLE";
/// Sets the storage block apart from the credentials block of the same
/// export, which is sealed under the same passphrase without a context.
const EXPORT_AAD: &[u8] = b"r-shell-config-sync-storage-export-v1";

impl Stored {
    /// None when no storage was ever saved on this device.
    fn exported_storage(&self) -> Option<ExportedStorage> {
        if self.options.target.is_blank() && self.provider_secret.is_empty() {
            return None;
        }
        Some(ExportedStorage {
            target: self.options.target.clone(),
            secret: self.provider_secret.clone(),
            session_token: self.session_token.clone(),
        })
    }
}

/// The storage target and its service credentials for a config export, sealed
/// under the export passphrase here so they never reach the webview in the
/// clear. `None` when no storage is configured.
#[tauri::command]
pub async fn config_sync_export_storage(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    passphrase: String,
) -> Result<Option<String>, String> {
    let exported = {
        let mut lock = service.inner.lock().await;
        load(&mut lock, &app)?.stored.exported_storage()
    };
    let Some(exported) = exported else {
        return Ok(None);
    };
    let text = serde_json::to_string(&exported).map_err(|_| "SYNC_LOCAL_STORAGE")?;
    // Argon2id is deliberately slow, so the work stays off the async runtime.
    tokio::task::spawn_blocking(move || {
        crate::commands::seal_for_backup(&passphrase, &text, EXPORT_AAD)
    })
    .await
    .map_err(|_| "SYNC_LOCAL_SECRET")?
    .map(Some)
    .map_err(|_| "SYNC_LOCAL_SECRET".into())
}

/// Restore storage settings from a config export. Returns whether this device
/// took them; see `restore_storage`.
#[tauri::command]
pub async fn config_sync_import_storage(
    app: tauri::AppHandle,
    service: tauri::State<'_, SyncService>,
    passphrase: String,
    sealed: String,
) -> Result<bool, String> {
    let text = tokio::task::spawn_blocking(move || {
        crate::commands::open_from_backup(&passphrase, &sealed, EXPORT_AAD)
    })
    .await
    .map_err(|_| EXPORT_UNREADABLE)?
    .map_err(|_| EXPORT_UNREADABLE)?;
    let exported: ExportedStorage = serde_json::from_str(&text).map_err(|_| EXPORT_UNREADABLE)?;
    let mut lock = service.inner.lock().await;
    let runtime = load(&mut lock, &app)?;
    ensure_process_lock(runtime, &app)?;
    let restored =
        restore_storage(runtime, &state_path(&app)?, &machine_key(&app)?, exported).await?;
    if restored {
        let _ = app.emit("config-sync-state", status(runtime));
    }
    Ok(restored)
}

/// An imported file must not redirect, reset or replace a sync setup that
/// exists here, so only a device without any storage settings takes them. They
/// stay off and carry no passphrase: the user still has to enable sync.
async fn restore_storage(
    runtime: &mut Runtime,
    path: &Path,
    key: &[u8],
    exported: ExportedStorage,
) -> Result<bool, String> {
    let stored = &runtime.stored;
    if stored.options.enabled
        || stored.base.is_some()
        || stored.pending.is_some()
        || stored.exported_storage().is_some()
    {
        return Ok(false);
    }
    let options = Options {
        enabled: false,
        paused: false,
        target: exported.target,
        ..stored.options.clone()
    };
    let auth = ProviderAuth {
        secret: exported.secret,
        session_token: exported.session_token,
    };
    configure(runtime, path, key, options, Some(auth), None).await?;
    Ok(true)
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
    let provider = runtime.stored.provider()?;
    prepare(runtime, provider.as_ref(), &machine_key(&app)?, records).await
}

async fn prepare(
    runtime: &mut Runtime,
    provider: &dyn ObjectStore,
    key: &[u8],
    records: Records,
) -> Result<Preview, String> {
    let phrase = runtime.passphrase.clone().ok_or("SYNC_LOCKED")?;
    runtime.plan = None;
    let mut local = local_plain(&records, key, runtime.stored.options.credentials)?;
    let file = provider.read(FILE).await?;
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
            key,
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
    let provider = runtime.stored.provider()?;
    commit(
        runtime,
        provider.as_ref(),
        &state_path(&app)?,
        &machine_key(&app)?,
        &plan_id,
        records,
        &choices,
    )
    .await
}

async fn commit(
    runtime: &mut Runtime,
    provider: &dyn ObjectStore,
    path: &Path,
    key: &[u8],
    plan_id: &str,
    records: Records,
    choices: &BTreeMap<String, Choice>,
) -> Result<ApplyBatch, String> {
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
        choices,
    );
    if !conflicts.is_empty() {
        return Err("SYNC_CONFLICT".into());
    }
    model::validate(&candidate)?;
    // Prepare every local secret before publishing; no partial credential restore.
    let mut local = for_device(
        &candidate,
        &records,
        key,
        runtime.stored.options.credentials,
    )?;
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
    write_state(path, &next, key)?;
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
    acknowledge(runtime, &state_path(&app)?, &machine_key(&app)?, id)?;
    let _ = app.emit("config-sync-state", status(runtime));
    Ok(())
}

fn acknowledge(runtime: &mut Runtime, path: &Path, key: &[u8], id: String) -> Result<(), String> {
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
    write_state(path, &next, key)?;
    runtime.stored = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn upgrading_an_encrypted_webdav_state_preserves_pending_and_acknowledged_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.enc");
        let key = [7; 32];
        let base = json!({"version":1,"vaultId":"old","revision":7,"records":{model::ROOT:{"name":"All Connections"}},"tombstones":[]});
        let legacy = json!({
            "options":{"enabled":true,"paused":true,"url":"https://dav.example/team/","username":"owner",
                       "credentials":true,"rememberPassphrase":true},
            "serverPassword":"dav-password","passphrase":"original phrase","base":base,
            "pending":{"id":"next","snapshot":base},"lastAppliedId":"applied"
        });
        let sealed = crate::commands::seal_with_key(&key, &legacy.to_string(), STATE_AAD).unwrap();
        std::fs::write(&path, &sealed).unwrap();
        let stored = read_state(&path, &key).unwrap();
        assert!(
            matches!(&stored.options.target, Target::WebDav {url, username} if url=="https://dav.example/team/" && username=="owner")
        );
        let options = stored.options.clone();
        let mut rt = Runtime {
            passphrase: stored.passphrase.clone(),
            stored,
            plan: None,
            process_lock: None,
        };
        // A journal must be recovered against the old ID before any config write.
        let journal = path.with_file_name("apply.enc");
        std::fs::write(&journal, b"pending").unwrap();
        assert_eq!(
            configure(&mut rt, &path, &key, options.clone(), None, None)
                .await
                .unwrap_err(),
            "SYNC_RECOVERY_REQUIRED"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), sealed);
        std::fs::remove_file(journal).unwrap();
        configure(&mut rt, &path, &key, options, None, None)
            .await
            .unwrap();
        let loaded = read_state(&path, &key).unwrap();
        assert!(loaded.options.enabled && loaded.options.paused && loaded.options.credentials);
        assert_eq!(loaded.provider_secret, "dav-password");
        assert_eq!(loaded.passphrase.as_deref(), Some("original phrase"));
        assert_eq!(loaded.last_applied_id.as_deref(), Some("applied"));
        assert_eq!(serde_json::to_value(loaded.base).unwrap(), base);
        assert_eq!(loaded.pending.unwrap().id, "next");
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("dav-password"));
        let mut unsupported = legacy;
        unsupported["options"]["target"] = json!({"kind":"unknown"});
        assert!(serde_json::from_value::<Stored>(unsupported).is_err());
    }

    #[tokio::test]
    async fn exported_storage_carries_no_passphrase_and_restores_only_a_device_without_storage() {
        use settings::{Addressing, S3Target};
        let dir = tempfile::tempdir().unwrap();
        let key = [5; 32];
        let runtime = |stored: Stored| Runtime {
            passphrase: None,
            stored,
            plan: None,
            process_lock: None,
        };
        let target = Target::WebDav {
            url: "https://dav.example/team/".into(),
            username: "owner".into(),
        };
        let source = Stored {
            options: Options {
                enabled: true,
                credentials: true,
                target: target.clone(),
                ..Default::default()
            },
            provider_secret: "dav-password".into(),
            passphrase: Some("vault phrase".into()),
            base: Some(Snapshot::default()),
            ..Default::default()
        };
        assert!(Stored::default().exported_storage().is_none());
        let text = serde_json::to_string(&source.exported_storage().unwrap()).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            json!({"target":{"kind":"webdav","url":"https://dav.example/team/","username":"owner"},
                   "secret":"dav-password"})
        );
        // Temporary S3 credentials travel too; a field from a later version is ignored.
        let s3: ExportedStorage = serde_json::from_value(json!({
            "target":{"kind":"s3","endpoint":"https://objects.example","region":"test","bucket":"one",
                      "prefix":"config","addressing":"path","accessKeyId":"key-id"},
            "secret":"s3-secret","sessionToken":"token","later":"field"
        }))
        .unwrap();
        assert!(matches!(
            &s3.target,
            Target::S3(S3Target { bucket, addressing: Addressing::Path, .. }) if bucket == "one"
        ));
        assert_eq!(s3.session_token.as_deref(), Some("token"));

        // The block opens only as a storage block, not as the credentials block.
        let sealed = crate::commands::seal_for_backup("export phrase", &text, EXPORT_AAD).unwrap();
        assert_eq!(
            crate::commands::open_from_backup("export phrase", &sealed, EXPORT_AAD).unwrap(),
            text
        );
        assert!(crate::commands::open_from_backup("export phrase", &sealed, b"").is_err());

        let path = dir.path().join("fresh/state.enc");
        let mut fresh = runtime(Stored::default());
        let exported = serde_json::from_str(&text).unwrap();
        assert!(restore_storage(&mut fresh, &path, &key, exported)
            .await
            .unwrap());
        let loaded = read_state(&path, &key).unwrap();
        assert!(loaded.options.target == target);
        assert!(!loaded.options.enabled && !loaded.options.credentials);
        assert_eq!(loaded.provider_secret, "dav-password");
        assert!(loaded.passphrase.is_none() && loaded.base.is_none());
        assert!(fresh.passphrase.is_none());

        // Every kind of existing setup keeps its own storage: in use, linked
        // before, mid-apply, or only saved.
        let existing = [
            (
                "enabled",
                Stored {
                    options: Options {
                        enabled: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ),
            (
                "linked",
                Stored {
                    base: Some(Snapshot::default()),
                    ..Default::default()
                },
            ),
            (
                "pending",
                Stored {
                    pending: Some(Pending {
                        id: "next".into(),
                        snapshot: Snapshot::default(),
                    }),
                    ..Default::default()
                },
            ),
            (
                "saved",
                Stored {
                    options: Options {
                        target: target.clone(),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ),
            (
                "secret",
                Stored {
                    provider_secret: "kept".into(),
                    ..Default::default()
                },
            ),
        ];
        for (name, stored) in existing {
            let path = dir.path().join(name).join("state.enc");
            let mut device = runtime(stored);
            let other = ExportedStorage {
                target: Target::WebDav {
                    url: "https://elsewhere.example/".into(),
                    username: "intruder".into(),
                },
                secret: "other".into(),
                session_token: None,
            };
            assert!(
                !restore_storage(&mut device, &path, &key, other)
                    .await
                    .unwrap(),
                "{name}"
            );
            assert!(!path.exists(), "{name}");
        }
    }

    #[test]
    fn rotating_keys_preserves_vault_identity_and_never_sends_secrets_to_another_endpoint() {
        use settings::{Addressing, S3Target};
        let s3 = S3Target {
            endpoint: "https://objects.example".into(),
            region: "test".into(),
            bucket: "one".into(),
            prefix: "config".into(),
            addressing: Addressing::Path,
            access_key_id: "original".into(),
        };
        let target = Target::S3(s3.clone());
        let stored = Stored {
            options: Options {
                target: target.clone(),
                ..Default::default()
            },
            provider_secret: "local-secret".into(),
            session_token: Some("token".into()),
            ..Default::default()
        };
        let rotated = Target::S3(S3Target {
            access_key_id: "rotated".into(),
            ..s3.clone()
        });
        assert!(target.same_vault(&rotated));
        for different_identity in [
            rotated,
            Target::S3(S3Target {
                endpoint: "https://other.example".into(),
                ..s3.clone()
            }),
            Target::default(),
        ] {
            let auth = stored.auth_for(&different_identity, None);
            assert!(auth.secret.is_empty() && auth.session_token.is_none());
        }
        let prefix = Target::S3(S3Target {
            prefix: "other".into(),
            ..s3.clone()
        });
        assert!(!target.same_vault(&prefix));
        assert_eq!(
            stored.auth_for(&prefix, None).session_token.as_deref(),
            Some("token")
        );
        let other_bucket = Target::S3(S3Target {
            bucket: "two".into(),
            ..s3.clone()
        });
        assert!(!target.same_vault(&other_bucket));
        let replacement = ProviderAuth {
            secret: "new local secret".into(),
            session_token: None,
        };
        assert!(stored
            .auth_for(&target, Some(replacement))
            .session_token
            .is_none());
        let rt = Runtime {
            stored,
            passphrase: None,
            plan: None,
            process_lock: None,
        };
        let status = serde_json::to_value(status(&rt)).unwrap();
        assert_eq!(status["hasSessionToken"], true);
        assert_eq!(status["options"]["target"]["kind"], "s3");
        assert!(!status.to_string().contains("local-secret"));
        assert!(status.get("sessionToken").is_none());
    }
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
            provider_secret: "webdav-secret".into(),
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

    fn hop_credentials_fixture() -> (Records, Snapshot) {
        let sealed = crate::commands::seal_with_key(&[1u8; 32], "password", b"").unwrap();
        let raw = Records::from([
            (model::ROOT.into(), json!({"name":"All Connections"})),
            (
                "connections/a".into(),
                json!({"host":"target","folderId":"$root","jumpHosts":[
                    {"host":"jump","port":22,"username":"user","authMethod":"password","keepAliveInterval":30}
                ]}),
            ),
            (
                "credentials/connections/a".into(),
                json!({"values":{"password":sealed,"jumpHosts":[{"password":sealed}]}}),
            ),
        ]);
        let snapshot = Snapshot {
            version: 1,
            vault_id: "v".into(),
            revision: 1,
            records: local_plain(&raw, &[1u8; 32], true).unwrap(),
            ..Default::default()
        };
        (raw, snapshot)
    }

    #[test]
    fn legacy_hop_binding_retains_secrets_after_tuning_but_not_retargeting() {
        let (_, mut snapshot) = hop_credentials_fixture();
        let destination = Records::from([(model::ROOT.into(), json!({"name":"All Connections"}))]);
        // Older vaults included every public hop option in the binding.
        snapshot
            .records
            .get_mut("credentials/connections/a")
            .unwrap()["binding"]["target"]["jumpHosts"] =
            snapshot.records["connections/a"]["jumpHosts"].clone();
        snapshot.records.get_mut("connections/a").unwrap()["jumpHosts"][0]["keepAliveInterval"] =
            json!(90);
        let restored = for_device(&snapshot, &destination, &[2u8; 32], true).unwrap();
        let values = &restored.records["credentials/connections/a"]["values"];
        for secret in [&values["password"], &values["jumpHosts"][0]["password"]] {
            assert_eq!(
                crate::commands::open_with_key(&[2u8; 32], secret.as_str().unwrap(), b"").unwrap(),
                "password"
            );
        }
        snapshot.records.get_mut("connections/a").unwrap()["jumpHosts"][0]["host"] =
            json!("unrelated-host");
        assert!(!for_device(&snapshot, &destination, &[2u8; 32], true)
            .unwrap()
            .records
            .contains_key("credentials/connections/a"));
    }

    #[test]
    fn resolved_credential_shapes_are_rejected_before_publication() {
        let (raw, snapshot) = hop_credentials_fixture();
        for values in [
            json!({"jumpHosts":[{},{}]}),
            json!({"jumpHosts":[{"proxyPassword":"invalid-hop-field"}]}),
            json!({"jumpHosts":[[{"password":"nested"}]]}),
            json!({"jumpHosts":"not-an-array"}),
            json!([]),
        ] {
            let mut malformed = snapshot.clone();
            malformed
                .records
                .get_mut("credentials/connections/a")
                .unwrap()["values"] = values;
            assert_eq!(
                for_device(&malformed, &raw, &[1u8; 32], true).unwrap_err(),
                "SYNC_INVALID_DATA"
            );
        }
    }

    #[test]
    fn local_connection_and_credential_choices_restore_the_same_hop_chain() {
        let (mut raw, base) = hop_credentials_fixture();
        raw.get_mut("connections/a").unwrap()["jumpHosts"][0]["host"] = json!("local-hop");
        let local = local_plain(&raw, &[1u8; 32], true).unwrap();
        let mut remote = base.clone();
        remote.records.get_mut("connections/a").unwrap()["jumpHosts"] = json!([
            {"host":"remote-one","port":22,"username":"user","authMethod":"password"},
            {"host":"remote-two","port":22,"username":"user","authMethod":"password"}
        ]);
        remote.records.get_mut("credentials/connections/a").unwrap()["values"]["jumpHosts"] = json!([
            {"password":"remote-one"}, {"password":"remote-two"}
        ]);
        remote.records.get_mut("credentials/connections/a").unwrap()["binding"] =
            model::binding(&remote.records, "connections/a");
        let choices = BTreeMap::from([
            ("connections/a".into(), Choice::Local),
            ("credentials/connections/a".into(), Choice::Local),
        ]);
        let (merged, conflicts) = model::merge(Some(&base), &local, &remote, &choices);
        assert!(conflicts.is_empty());
        let restored = for_device(&merged, &raw, &[1u8; 32], true).unwrap();
        assert_eq!(
            restored.records["connections/a"]["jumpHosts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            restored.records["credentials/connections/a"],
            raw["credentials/connections/a"]
        );
    }
}
