use std::fmt::Write;

/// Run a single-line POSIX script with arguments independent of the login shell.
/// Fish and tcsh handle backslashes differently inside quotes, and tcsh expands
/// exclamation marks even in single quotes. Transport those bytes as octal
/// escapes and decode them only inside sh.
pub(crate) fn sh_with_args(script: &str, args: &[&str]) -> String {
    debug_assert!(!script.contains(['\'', '\n', '!']));
    // Keep trailing newlines in paths despite command substitution stripping
    // them. Shift out each encoded argument and append its decoded value.
    let mut command = format!(
        r#"sh -c 'for arg; do arg=$(printf "%b." "$arg"); shift; set -- "$@" "${{arg%.}}"; done; {script}' sh"#
    );
    for arg in args {
        command.push_str(" '");
        for byte in arg.bytes() {
            match byte {
                b'\'' | b'\\' | b'!' | 0..=31 | 127..=255 => {
                    let _ = write!(command, "\\0{byte:03o}");
                }
                _ => command.push(char::from(byte)),
            }
        }
        command.push('\'');
    }
    command
}
