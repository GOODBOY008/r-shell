/// Resolves the configured SSH private key path or falls back to the user's default key.
///
/// If no key path is provided, checks for `id_rsa` first, then `id_ed25519`.
pub fn resolve_private_key_path(key_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = key_path.map(str::trim).filter(|path| !path.is_empty()) {
        return Ok(expand_tilde(path));
    }

    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
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
    if key_path.starts_with("~/") || key_path.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            return key_path.replacen('~', &home_str, 1);
        }
    }

    key_path.to_string()
}
