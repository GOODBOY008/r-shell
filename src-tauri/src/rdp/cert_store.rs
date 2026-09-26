//! TOFU (trust-on-first-use) pinning of RDP server certificates.
//!
//! RDP servers overwhelmingly present self-signed certificates, so chain
//! verification against public CAs is not usable; but silently accepting any
//! certificate lets a man-in-the-middle intercept CredSSP credentials. The
//! SSH client already solves this exact problem with `known_hosts`; the same
//! contract applies here: the first connection pins the leaf certificate's
//! SHA-256 fingerprint, later connections must present the same certificate,
//! and a changed certificate fails closed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static STORE_PATH: OnceLock<PathBuf> = OnceLock::new();
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Location of the fingerprint store. Wired from the app data dir in
/// `lib.rs`; without it (unit tests, non-Tauri contexts) pinning is skipped
/// with a warning rather than breaking connects.
pub fn set_store_path(path: PathBuf) {
    let _ = STORE_PATH.set(path);
}

fn store_path() -> Option<&'static PathBuf> {
    STORE_PATH.get()
}

/// SHA-256 fingerprint (lowercase hex) of the DER-encoded certificate.
pub(super) fn fingerprint(cert_der: &[u8]) -> anyhow::Result<String> {
    use openssl::hash::{hash, MessageDigest};
    let digest = hash(MessageDigest::sha256(), cert_der)?;
    Ok(digest.iter().map(|b| format!("{:02x}", b)).collect())
}

/// Verify the presented certificate against the pinned fingerprint.
/// First sight pins it; a changed certificate fails closed.
pub(super) fn verify_or_pin(host: &str, port: u16, cert_der: &[u8]) -> anyhow::Result<()> {
    let fp = fingerprint(cert_der)?;
    let Some(path) = store_path() else {
        tracing::warn!(
            "RDP certificate store unavailable — skipping TOFU pinning for {}:{}",
            host,
            port
        );
        return Ok(());
    };
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let key = format!("{}:{}", host, port);
    let mut pins: HashMap<String, String> = std::fs::read(path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();

    match pins.get(&key) {
        Some(pinned) if pinned == &fp => Ok(()),
        Some(pinned) => Err(anyhow::anyhow!(
            "RDP HOST CERTIFICATE CHANGED for {}:{} — pinned {}…, server now presents {}… \
             If this change is expected, remove the entry from {} and reconnect",
            host,
            port,
            &pinned[..16.min(pinned.len())],
            &fp[..16],
            path.display()
        )),
        None => {
            pins.insert(key, fp);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            serde_json::to_writer_pretty(std::fs::File::create(path)?, &pins)?;
            tracing::info!(
                "RDP server certificate for {}:{} pinned (TOFU); future connections verify against it",
                host,
                port
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_sha256_hex() {
        // echo -n "" | shasum -a 256
        let fp = fingerprint(b"").unwrap();
        assert_eq!(
            fp,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
