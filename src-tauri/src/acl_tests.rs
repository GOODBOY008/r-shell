//! Consistency checks between the registered commands and the ACL
//! configuration.
//!
//! Tauri 2 only enforces capabilities for application commands when the build
//! declares an app manifest. The manifest, the `invoke_handler!` block and the
//! capabilities therefore have to agree — a command that is registered but
//! missing from the main window's capability silently stops working, and a
//! permission that does not exist fails the build. These tests catch both
//! cases before they reach a release.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Commands registered in the `invoke_handler!` block of `src/lib.rs`.
///
/// Only `commands::<name>,` entries count — `commands::SomeType::default()`
/// is a type reference, not a command.
fn registered_commands() -> BTreeSet<String> {
    let lib =
        fs::read_to_string(manifest_dir().join("src/lib.rs")).expect("src/lib.rs must be readable");
    let mut commands = BTreeSet::new();
    let mut rest = lib.as_str();
    while let Some(idx) = rest.find("commands::") {
        rest = &rest[idx + "commands::".len()..];
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        let after = rest[name.len()..].trim_start();
        if !name.is_empty() && after.starts_with(',') {
            commands.insert(name);
        }
    }
    commands
}

/// Permission identifiers declared in a capability file.
fn capability_permissions(file: &str) -> BTreeSet<String> {
    let json = fs::read_to_string(manifest_dir().join("capabilities").join(file))
        .expect("capability file must be readable");
    let mut permissions = BTreeSet::new();
    let mut rest = json.as_str();
    while let Some(idx) = rest.find('"') {
        rest = &rest[idx + 1..];
        if let Some(end) = rest.find('"') {
            let value = &rest[..end];
            if value.starts_with("allow-") || value.starts_with("deny-") {
                permissions.insert(value.to_string());
            }
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    permissions
}

fn permission_for(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

/// Commands declared in the app manifest of `build.rs`.
///
/// The manifest lists the commands as one string per line, so the list is
/// parsed instead of searched for substrings — a mention of a command in a
/// comment must not count as a declaration.
fn manifest_commands() -> BTreeSet<String> {
    let build_rs =
        fs::read_to_string(manifest_dir().join("build.rs")).expect("build.rs must be readable");
    let mut commands = BTreeSet::new();
    for line in build_rs.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('"') else {
            continue;
        };
        let Some(end) = rest.find('"') else {
            continue;
        };
        let name = &rest[..end];
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            commands.insert(name.to_string());
        }
    }
    commands
}

/// The commands the file-viewer popup actually invokes.
///
/// A new `invoke(...)` in one of its components has to be listed here as
/// well, otherwise the popup breaks at runtime with "command not allowed".
const FILE_VIEWER_REQUIRED: &[&str] = &[
    "cancel_app_quit",
    "cancel_transfer",
    "create_file",
    "download_remote_file",
    "editor_dirty_changed",
    "get_home_directory",
    "get_session_health",
    "open_in_os",
    "read_file_content",
    "read_remote_file_base64",
];

#[test]
fn app_manifest_lists_every_registered_command() {
    let manifest = manifest_commands();
    for command in registered_commands() {
        assert!(
            manifest.contains(&command),
            "build.rs does not declare the command `{command}`; the app ACL manifest would not cover it"
        );
    }
}

#[test]
fn app_manifest_declares_no_unknown_command() {
    let registered = registered_commands();
    for command in manifest_commands() {
        assert!(
            registered.contains(&command),
            "build.rs declares the command `{command}`, which is not registered in src/lib.rs"
        );
    }
}

#[test]
fn file_viewer_grants_every_command_its_popup_needs() {
    let permissions = capability_permissions("file-viewer.json");
    for command in FILE_VIEWER_REQUIRED {
        let permission = permission_for(command);
        assert!(
            permissions.contains(&permission),
            "capabilities/file-viewer.json does not allow `{permission}`; the file-viewer popup would fail with 'command not allowed'"
        );
    }
}

#[test]
fn main_window_allows_every_app_command() {
    let permissions = capability_permissions("default.json");
    for command in registered_commands() {
        let permission = permission_for(&command);
        assert!(
            permissions.contains(&permission),
            "capabilities/default.json does not allow `{permission}`; the command `{command}` would be rejected at runtime"
        );
    }
}

#[test]
fn file_viewer_permissions_are_a_subset_of_the_main_window() {
    let main_window = capability_permissions("default.json");
    for permission in capability_permissions("file-viewer.json") {
        assert!(
            main_window.contains(&permission),
            "capabilities/file-viewer.json grants `{permission}`, which the main window does not have"
        );
    }
}

#[test]
fn file_viewer_does_not_grant_connection_or_credential_commands() {
    let permissions = capability_permissions("file-viewer.json");
    for forbidden in [
        "allow-ssh-connect",
        "allow-credential-open",
        "allow-get-websocket-endpoint",
        "allow-desktop-connect",
        "allow-delete-local-item",
    ] {
        assert!(
            !permissions.contains(forbidden),
            "the file-viewer popup must not be able to call `{forbidden}`"
        );
    }
}
