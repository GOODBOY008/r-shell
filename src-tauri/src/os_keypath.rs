use std::path::{Path, PathBuf};

/// Identity files offered, in OpenSSH's order, when no key file is configured.
/// Security-key (`*_sk`) and DSA keys are left out: russh cannot use them.
pub const DEFAULT_KEY_FILES: [&str; 3] = ["id_rsa", "id_ecdsa", "id_ed25519"];

/// Resolves the configured SSH private key path.
///
/// A blank key path resolves to an empty string, meaning "no key file
/// configured": authentication then offers every default key in turn (see
/// `crate::ssh::authenticate_with_key_files`). It is an error only when none
/// of the default keys exists.
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

    if default_key_candidates_with_home(home).is_empty() {
        return Err(format!(
            "No default SSH private key found in {}. Checked {}.",
            home.join(".ssh").display(),
            DEFAULT_KEY_FILES.join(", "),
        ));
    }
    Ok(String::new())
}

/// Default key files that exist in `~/.ssh`, in the order they are offered.
pub fn default_key_candidates() -> Vec<String> {
    dirs::home_dir()
        .map(|home| default_key_candidates_with_home(&home))
        .unwrap_or_default()
}

fn default_key_candidates_with_home(home: &Path) -> Vec<String> {
    DEFAULT_KEY_FILES
        .iter()
        .map(|name| home.join(".ssh").join(name))
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
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
    fn blank_input_means_default_keys() {
        let home = test_home("blank");
        write_key(&home, "id_ed25519");
        // Empty/whitespace/None all mean "offer the default keys".
        for input in [Some(""), Some("   "), None] {
            assert_eq!(
                resolve_private_key_path_with_home(input, &home).unwrap(),
                ""
            );
        }
    }

    #[test]
    fn default_candidates_follow_openssh_order_and_skip_missing_files() {
        let home = test_home("candidates");
        let ed25519 = write_key(&home, "id_ed25519");
        let rsa = write_key(&home, "id_rsa");
        let ecdsa = write_key(&home, "id_ecdsa");
        write_key(&home, "id_dsa"); // not offered
        assert_eq!(
            default_key_candidates_with_home(&home),
            vec![
                rsa.to_string_lossy().into_owned(),
                ecdsa.to_string_lossy().into_owned(),
                ed25519.to_string_lossy().into_owned(),
            ]
        );

        let only_ed25519 = test_home("candidates-ed25519");
        let ed = write_key(&only_ed25519, "id_ed25519");
        assert_eq!(
            default_key_candidates_with_home(&only_ed25519),
            vec![ed.to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn no_default_key_returns_error_listing_candidates() {
        let home = test_home("no-default");
        let err = resolve_private_key_path_with_home(None, &home).unwrap_err();
        assert!(err.contains("No default SSH private key found"), "unexpected error: {err}");
        assert!(
            DEFAULT_KEY_FILES.iter().all(|name| err.contains(name)),
            "error should list every candidate: {err}"
        );
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
