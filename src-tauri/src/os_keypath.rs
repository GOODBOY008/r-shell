use std::path::{Path, PathBuf};

/// Resolves the configured SSH private key path or falls back to the user's default key.
///
/// If no key path is provided, checks for `id_rsa` first, then `id_ed25519`.
pub fn resolve_private_key_path(key_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = key_path.map(str::trim).filter(|path| !path.is_empty()) {
        if !path.starts_with("~/") && !path.starts_with("~\\") {
            return Ok(path.to_string());
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    resolve_private_key_path_with_home(key_path, &home)
}

fn resolve_private_key_path_with_home(key_path: Option<&str>, home: &Path) -> Result<String, String> {
    if let Some(path) = key_path.map(str::trim).filter(|path| !path.is_empty()) {
        return Ok(expand_tilde_with_home(path, home));
    }

    let ssh_dir = home.join(".ssh");

    for filename in ["id_rsa", "id_ed25519"] {
        let candidate = ssh_dir.join(filename);
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }

    Err(format!(
        "No default SSH private key found. Checked {} and {}",
        ssh_dir.join("id_rsa").display(),
        ssh_dir.join("id_ed25519").display(),
    ))
}

// Expand tilde in path — use dirs::home_dir() for cross-platform
// support (HOME is not set on Windows; USERPROFILE is used instead).
pub(crate) fn expand_tilde(key_path: &str) -> String {
    match dirs::home_dir() {
        Some(home) => expand_tilde_with_home(key_path, &home),
        None => key_path.to_string(),
    }
}

/// Expands a leading `~/` (or `~\` on Windows) against an explicit home directory.
fn expand_tilde_with_home(key_path: &str, home: &Path) -> String {
    if key_path.starts_with("~/") || key_path.starts_with("~\\") {
        let home_str = home.to_string_lossy();
        return key_path.replacen('~', &home_str, 1);
    }

    key_path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Fresh temp directory used as a fake `$HOME` (unique per test).
    fn test_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "r-shell-keypath-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_key(home: &Path, filename: &str) -> PathBuf {
        let path = home.join(".ssh").join(filename);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "test key").unwrap();
        path
    }

    #[test]
    fn explicit_path_is_expanded_and_trimmed() {
        let home = test_home("explicit");
        assert_eq!(resolve_private_key_path_with_home(Some("/abs/key"), &home).unwrap(), "/abs/key");
        assert_eq!(
            resolve_private_key_path_with_home(Some("  ~/keys/k1  "), &home).unwrap(),
            // Tilde expansion is textual (replacen), so the input's own
            // separator is kept — on Windows this yields "home + /keys/k1"
            // (mixed separators, which Windows accepts).
            format!("{}/keys/k1", home.to_string_lossy())
        );
        // Missing explicit paths are returned as-is; existence is checked by callers.
        assert_eq!(
            resolve_private_key_path_with_home(Some("/nonexistent/key"), &home).unwrap(),
            "/nonexistent/key"
        );
    }

    #[test]
    fn blank_input_falls_back_to_default_keys() {
        let home = test_home("blank");
        let rsa = write_key(&home, "id_rsa");
        let _ed25519 = write_key(&home, "id_ed25519");
        // Empty/whitespace/None all fall back to id_rsa, which wins over id_ed25519.
        for input in [Some(""), Some("   "), None] {
            assert_eq!(
                resolve_private_key_path_with_home(input, &home).unwrap(),
                rsa.to_string_lossy()
            );
        }
        // id_ed25519 is used when id_rsa is missing.
        let ed25519_only = test_home("blank-ed25519");
        let ed25519 = write_key(&ed25519_only, "id_ed25519");
        assert_eq!(
            resolve_private_key_path_with_home(None, &ed25519_only).unwrap(),
            ed25519.to_string_lossy()
        );
    }

    #[test]
    fn no_default_key_returns_error_listing_candidates() {
        let home = test_home("no-default");
        let err = resolve_private_key_path_with_home(None, &home).unwrap_err();
        assert!(err.contains("No default SSH private key found"), "unexpected error: {err}");
        assert!(err.contains("id_rsa") && err.contains("id_ed25519"), "error should list both candidates: {err}");
    }

    #[test]
    fn expand_tilde_handles_unix_and_windows_prefixes() {
        let home = test_home("expand");
        // Tilde expansion is textual (replacen), so the input's separator is
        // kept: assert the exact textual output, not a PathBuf-joined path
        // (on Windows the latter would normalize '/' to '\\').
        assert_eq!(expand_tilde_with_home("~/foo", &home), format!("{}/foo", home.to_string_lossy()));
        assert_eq!(expand_tilde_with_home("~\\foo", &home), format!("{}\\foo", home.to_string_lossy()));
        // Only a leading "~/" or "~\" is expanded — a bare "~" or a mid-path
        // tilde is left untouched (matches the pre-PR behavior).
        assert_eq!(expand_tilde_with_home("~", &home), "~");
        assert_eq!(expand_tilde_with_home("a/~", &home), "a/~");
        assert_eq!(expand_tilde_with_home("relative/path", &home), "relative/path");
    }
}
