use crate::commands::{dev_master_key_path, master_key, open_with_key, seal_with_key};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Serialize, Deserialize)]
struct StoredPassphrase {
    key_path: String,
    sealed: String,
}

#[derive(Serialize)]
pub struct SavedKeyPassphrase {
    digest: String,
    key_path: Option<String>,
}

#[derive(Clone)]
pub(crate) struct PassphraseStore {
    directory: PathBuf,
    master_key: Arc<dyn Fn() -> Result<Vec<u8>, String> + Send + Sync>,
}

fn is_key_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl PassphraseStore {
    pub(crate) fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let dev_key_path = dev_master_key_path(app)?;
        let subdir = if dev_key_path.is_some() {
            "ssh-key-passphrases-dev-v1"
        } else {
            "ssh-key-passphrases-v1"
        };
        Ok(Self {
            directory: directory.join(subdir),
            master_key: Arc::new(move || master_key(dev_key_path.as_deref())),
        })
    }

    fn path(&self, digest: &str) -> Result<PathBuf, String> {
        if !is_key_digest(digest) {
            return Err("Invalid SSH key digest".into());
        }
        Ok(self.directory.join(format!("{digest}.json")))
    }

    fn read(&self, digest: &str) -> Result<Option<StoredPassphrase>, String> {
        match fs::read(self.path(digest)?) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| e.to_string()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn load(&self, digest: &str) -> Result<Option<String>, String> {
        let Some(record) = self.read(digest)? else {
            return Ok(None);
        };
        // Bind the ciphertext to these exact key bytes and separate it from
        // credentials sealed for connection profiles (which use empty AAD).
        open_with_key(&(self.master_key)()?, &record.sealed, digest.as_bytes()).map(Some)
    }

    fn save(&self, digest: &str, key_path: String, passphrase: &str) -> Result<(), String> {
        let path = self.path(digest)?;
        let sealed = seal_with_key(&(self.master_key)()?, passphrase, digest.as_bytes())?;
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|e| e.to_string())?;
        serde_json::to_writer(file.as_file_mut(), &StoredPassphrase { key_path, sealed })
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.error.to_string())?;
        Ok(())
    }

    pub(crate) fn list(&self) -> Result<Vec<SavedKeyPassphrase>, String> {
        let files = match fs::read_dir(&self.directory) {
            Ok(files) => files,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.to_string()),
        };
        let mut saved = Vec::new();
        for file in files {
            let file = file.map_err(|e| e.to_string())?;
            let name = file.file_name();
            let Some(digest) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if is_key_digest(digest) {
                let key_path = match self.read(digest) {
                    Ok(Some(record)) => Some(record.key_path),
                    Ok(None) => continue, // Concurrent forget.
                    Err(_) => None,       // A corrupt record can still be forgotten.
                };
                saved.push(SavedKeyPassphrase {
                    digest: digest.into(),
                    key_path,
                });
            }
        }
        saved.sort_by(|a, b| a.key_path.cmp(&b.key_path).then(a.digest.cmp(&b.digest)));
        Ok(saved)
    }

    pub(crate) fn forget(&self, digest: &str) -> Result<(), String> {
        match fs::remove_file(self.path(digest)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

struct PendingPassphrase {
    key_path: String,
    passphrase: String,
}

#[derive(Clone)]
pub(crate) struct PassphraseAttempt {
    store: Result<PassphraseStore, String>,
    pending: Arc<Mutex<Option<HashMap<String, PendingPassphrase>>>>,
}

impl PassphraseAttempt {
    fn new(store: Result<PassphraseStore, String>) -> Self {
        Self {
            store,
            pending: Arc::new(Mutex::new(Some(HashMap::new()))),
        }
    }

    pub(crate) fn for_app(app: &tauri::AppHandle) -> Self {
        Self::new(PassphraseStore::for_app(app))
    }

    pub(super) fn load(&self, digest: &str) -> Option<String> {
        if let Some(entry) = self
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|entries| entries.get(digest))
        {
            return Some(entry.passphrase.clone());
        }
        match self.store.as_ref().ok()?.load(digest) {
            Ok(passphrase) => passphrase,
            Err(e) => {
                tracing::warn!("Could not load saved SSH key passphrase: {e}");
                None
            }
        }
    }

    pub(super) fn stage(&self, digest: &str, key_path: &str, passphrase: &str) {
        if let Some(entries) = self.pending.lock().unwrap().as_mut() {
            entries.insert(
                digest.into(),
                PendingPassphrase {
                    key_path: key_path.into(),
                    passphrase: passphrase.into(),
                },
            );
        }
    }

    /// Commit only on success. Closing the batch also prevents an attached
    /// transfer session from saving the same unlock reply again later.
    pub(crate) async fn save(self) -> bool {
        let entries = self.pending.lock().unwrap().take().unwrap_or_default();
        if entries.is_empty() {
            return true;
        }
        tokio::task::spawn_blocking(move || {
            let mut saved = true;
            for (digest, entry) in entries {
                let result = self
                    .store
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|store| store.save(&digest, entry.key_path, &entry.passphrase));
                if let Err(e) = result {
                    tracing::warn!("Could not save SSH key passphrase: {e}");
                    saved = false;
                }
            }
            saved
        })
        .await
        .unwrap_or(false)
    }

    #[cfg(test)]
    pub(super) fn for_test(directory: PathBuf) -> Self {
        Self::new(Ok(PassphraseStore {
            directory,
            master_key: Arc::new(|| Ok(vec![42; 32])),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn commits_only_on_success_and_never_resaves_a_forgotten_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let digest = "a".repeat(64);
        let other_digest = "b".repeat(64);
        let new_attempt = || PassphraseAttempt::for_test(dir.path().into());
        let cancelled = new_attempt();
        cancelled.stage(&digest, "/keys/first", "temporary");
        assert_eq!(cancelled.load(&digest).as_deref(), Some("temporary"));
        assert!(new_attempt().load(&digest).is_none());
        drop(cancelled);

        let connected = new_attempt();
        connected.stage(&digest, "/keys/first", "valid passphrase");
        assert!(connected.clone().save().await);

        let reopened = new_attempt();
        let store = reopened.store.as_ref().unwrap();
        assert_eq!(reopened.load(&digest).as_deref(), Some("valid passphrase"));
        let saved = store.list().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].key_path.as_deref(), Some("/keys/first"));
        let path = store.path(&digest).unwrap();
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("valid passphrase"));
        assert!(store.forget("../outside").is_err());
        fs::copy(&path, store.path(&other_digest).unwrap()).unwrap();
        assert!(
            store.load(&other_digest).is_err(),
            "ciphertext is bound to the key digest"
        );
        store.forget(&digest).unwrap();
        store.forget(&digest).unwrap();

        connected.stage(&digest, "/keys/first", "valid passphrase");
        assert!(connected.save().await);
        assert!(new_attempt().load(&digest).is_none());
    }
}
