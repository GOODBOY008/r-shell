use serde::Serialize;

/// Stable IPC codes with separate interpolation values. Display is only for
/// native errors; the import preview translates these codes in the frontend.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(tag = "code", content = "params", rename_all = "camelCase")]
pub enum DiagnosticReason {
    #[error("Cannot determine the user's home directory")]
    HomeUnavailable,
    #[error("Cannot determine the local username")]
    UsernameUnavailable,
    #[error("Could not preview the configuration: {detail}")]
    PreviewFailed { detail: String },
    #[error("Unterminated quoted value")]
    UnterminatedQuote,
    #[error("Unterminated environment variable")]
    UnterminatedEnvironmentVariable,
    #[error("Environment variable {name} is not set")]
    MissingEnvironmentVariable { name: String },
    #[error("Invalid local username")]
    #[cfg(unix)]
    InvalidLocalUsername,
    #[error("Cannot resolve the named user's home directory")]
    #[cfg(unix)]
    UnknownUserHome,
    #[error("Named-user home expansion is not supported on this platform")]
    #[cfg(windows)]
    NamedUserHomeUnsupported,
    #[error("Cannot determine the local hostname")]
    LocalHostnameUnavailable,
    #[error("The %i token is not supported on Windows")]
    #[cfg(windows)]
    UserIdUnsupported,
    #[error("Cannot read configuration file {path}: {detail}")]
    FileAccess { path: String, detail: String },
    #[error("Include cycle at {path}")]
    IncludeCycle { path: String },
    #[error("Include nesting exceeds {limit} files")]
    IncludeDepth { limit: usize },
    #[error("SSH configuration must be a regular file")]
    NotRegularFile,
    #[error("SSH configuration exceeds {limit} MiB")]
    SourceTooLarge { limit: usize },
    #[error("Match blocks cannot be converted reliably; this source cannot be imported")]
    MatchUnsupported,
    #[error("Include requires a path")]
    IncludePathRequired,
    #[error("Host requires a pattern")]
    HostPatternRequired,
    #[error("Unsupported SSH path token: {token}")]
    UnsupportedToken { token: String },
    #[error("Invalid Include pattern: {detail}")]
    InvalidIncludePattern { detail: String },
    #[error("Cannot read Include matches: {detail}")]
    IncludePatternRead { detail: String },
    #[error("Expected yes or no")]
    ExpectedBoolean,
    #[error("Invalid numeric value")]
    InvalidNumber,
    #[error("ProxyJump cycle involving {host}")]
    JumpCycle { host: String },
    #[error("ProxyJump exceeds {limit} hops")]
    TooManyJumps { limit: usize },
    #[error("ProxyJump points back to the target")]
    JumpTargetsSelf,
    #[error("ProxyJump repeats a hop")]
    JumpRepeated,
    #[error("Invalid bracketed jump host")]
    InvalidJumpBrackets,
    #[error("Invalid ProxyJump port")]
    InvalidJumpPort,
    #[error("IPv6 jump addresses must be bracketed")]
    UnbracketedIpv6,
    #[error("Invalid ProxyJump host")]
    InvalidJumpHost,
    #[error("Invalid ProxyJump URI escape")]
    InvalidJumpEscape,
    #[error("Invalid ProxyJump username")]
    InvalidJumpUsername,
    #[error("Missing option value")]
    MissingValue,
    #[error("IdentityFile expects one path")]
    IdentityPathRequired,
    #[error("Expected one option value")]
    ExpectedSingleValue,
    #[error("This connection or authentication option cannot be converted")]
    UnsupportedOption,
    #[error("This option is not imported")]
    IgnoredOption,
    #[error("ProxyCommand is not supported")]
    ProxyCommandUnsupported,
    #[error("SSH configuration exceeds {limit} aliases")]
    TooManyAliases { limit: usize },
    #[error("Cannot determine the current directory: {detail}")]
    CurrentDirectoryUnavailable { detail: String },
}

impl DiagnosticReason {
    pub(super) fn file_access(path: &std::path::Path, error: std::io::Error) -> Self {
        Self::FileAccess {
            path: path.to_string_lossy().into_owned(),
            detail: error.to_string(),
        }
    }
}
