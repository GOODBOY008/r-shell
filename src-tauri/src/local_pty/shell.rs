use anyhow::{ensure, Context, Result};
use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};

pub(super) fn command(override_path: Option<&Path>) -> Result<(CommandBuilder, String)> {
    let (mut command, path) = match override_path {
        Some(path) => {
            ensure!(path.is_absolute(), "The local shell path must be absolute");
            ensure!(
                is_executable(path),
                "Local shell is not an executable file: {}",
                path.display()
            );
            (CommandBuilder::new(path), path.to_owned())
        }
        None => default_shell()?,
    };
    #[cfg(unix)]
    command.env("SHELL", &path);
    let home = dirs::home_dir().context("Could not determine the home directory")?;
    ensure!(
        home.is_dir(),
        "The home directory does not exist: {}",
        home.display()
    );
    command.cwd(home);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "R-Shell");
    #[cfg(target_os = "linux")]
    clean_appimage_environment(&mut command);
    let name = path
        .file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned();
    Ok((command, name))
}

#[cfg(unix)]
fn default_shell() -> Result<(CommandBuilder, PathBuf)> {
    // Uses the login argv[0] convention (works for zsh, bash, fish, and sh).
    // portable-pty resolves SHELL, then the account shell, then /bin/sh.
    let command = CommandBuilder::new_default_prog();
    let path = PathBuf::from(command.get_shell());
    Ok((command, path))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn default_shell() -> Result<(CommandBuilder, PathBuf)> {
    use std::env;
    let path_dirs = env::var_os("PATH")
        .map(|path| {
            env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let system32 = env::var_os("SystemRoot").map(|p| PathBuf::from(p).join("System32"));
    let program_files = env::var_os("ProgramFiles").map(PathBuf::from);
    let search = |known: Option<PathBuf>, name: &str| {
        known
            .into_iter()
            .chain(path_dirs.iter().map(|dir| dir.join(name)))
            .find(|path| path.is_absolute() && is_executable(path))
    };
    let path = search(
        program_files.map(|dir| dir.join(r"PowerShell\7\pwsh.exe")),
        "pwsh.exe",
    )
    .or_else(|| {
        search(
            system32
                .as_ref()
                .map(|dir| dir.join(r"WindowsPowerShell\v1.0\powershell.exe")),
            "powershell.exe",
        )
    })
    .or_else(|| search(system32.map(|dir| dir.join("cmd.exe")), "cmd.exe"))
    .context("Could not locate PowerShell or Command Prompt")?;
    Ok((CommandBuilder::new(&path), path))
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("com"))
}

#[cfg(target_os = "linux")]
fn clean_appimage_environment(command: &mut CommandBuilder) {
    use std::env;
    if command.get_env("APPIMAGE").is_none() {
        return;
    }
    let Some(root) = command
        .get_env("APPDIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.parent().is_some())
    else {
        return;
    };
    // AppRun prepends search paths; retain the user's original entries, including
    // paths outside the mount that happen to share its textual prefix.
    for key in [
        "PATH",
        "LD_LIBRARY_PATH",
        "XDG_DATA_DIRS",
        "GSETTINGS_SCHEMA_DIR",
        "GTK_PATH",
        "GI_TYPELIB_PATH",
        "QT_PLUGIN_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERLLIB",
    ] {
        if let Some(value) = command.get_env(key) {
            let mut paths: Vec<_> = env::split_paths(value).collect();
            if !paths.iter().any(|path| path.starts_with(&root)) {
                continue;
            }
            paths.retain(|path| !path.starts_with(&root));
            // AppRun adds a trailing ':' when the original variable was unset.
            if paths.iter().all(|path| path.as_os_str().is_empty()) {
                command.env_remove(key);
            } else if let Ok(value) = env::join_paths(paths) {
                command.env(key, value);
            }
        }
    }
    // GTK's AppRun hook sets these to individual files/directories. A colon is
    // legal in a host filename, so do not split or rewrite a user-owned value.
    for key in [
        "GDK_PIXBUF_MODULE_FILE",
        "GIO_MODULE_DIR",
        "GTK_DATA_PREFIX",
        "GTK_EXE_PREFIX",
        "GTK_IM_MODULE_FILE",
    ] {
        if command
            .get_env(key)
            .is_some_and(|value| Path::new(value).starts_with(&root))
        {
            command.env_remove(key);
        }
    }
    command.env_remove("APPDIR");
    command.env_remove("APPIMAGE");
}

#[cfg(all(test, target_os = "linux"))]
#[test]
fn appimage_child_paths_keep_user_entries_outside_the_bundle() {
    let mut command = CommandBuilder::new("/bin/sh");
    command.env("APPDIR", "/tmp/.mount_rshell");
    command.env("APPIMAGE", "/opt/r-shell.AppImage");
    command.env(
        "PATH",
        "/tmp/.mount_rshell/usr/bin:/home/user/my bin:/usr/bin",
    );
    command.env("LD_LIBRARY_PATH", "/tmp/.mount_rshell/usr/lib:");
    command.env(
        "PYTHONPATH",
        "/tmp/.mount_rshell/usr/python:/opt/user/python",
    );
    command.env(
        "PERLLIB",
        "/tmp/.mount_rshell/usr/perl:/tmp/.mount_rshell-other/perl",
    );
    let generated = [
        "PYTHONHOME",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GSETTINGS_SCHEMA_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GIO_MODULE_DIR",
        "GTK_DATA_PREFIX",
        "GTK_EXE_PREFIX",
        "GTK_IM_MODULE_FILE",
    ];
    for key in generated {
        command.env(key, "/tmp/.mount_rshell//usr/lib/modules");
    }
    clean_appimage_environment(&mut command);
    assert_eq!(
        command.get_env("PATH").unwrap(),
        "/home/user/my bin:/usr/bin"
    );
    assert_eq!(command.get_env("PYTHONPATH").unwrap(), "/opt/user/python");
    assert_eq!(
        command.get_env("PERLLIB").unwrap(),
        "/tmp/.mount_rshell-other/perl"
    );
    for key in generated
        .into_iter()
        .chain(["LD_LIBRARY_PATH", "APPDIR", "APPIMAGE"])
    {
        assert!(
            command.get_env(key).is_none(),
            "bundle path survived in {key}"
        );
    }

    command.env("APPDIR", "/tmp/.mount_rshell");
    command.env("APPIMAGE", "/opt/r-shell.AppImage");
    command.env("GDK_PIXBUF_MODULE_FILE", "/opt/my:theme/loaders.cache");
    clean_appimage_environment(&mut command);
    assert_eq!(
        command.get_env("GDK_PIXBUF_MODULE_FILE").unwrap(),
        "/opt/my:theme/loaders.cache"
    );
}
