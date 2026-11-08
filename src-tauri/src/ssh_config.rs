//! Read-only OpenSSH import. This module never starts a process or opens a key.
mod diagnostic;
pub use diagnostic::DiagnosticReason as Reason;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_DEPTH: usize = 16;
const MAX_BYTES: usize = 4 * 1024 * 1024;
// Charge parsed nodes, file references and every evaluated directive by their
// owned text/structure size. This bounds repeated Includes across all aliases
// and jump hosts, including amplification of a single large directive.
const MAX_PREVIEW_WORK: usize = 64 * 1024 * 1024;
pub const MAX_JUMPS: usize = 8;

/// Shared by imported targets and jump hosts. Secrets are absent in imports.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshEndpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_agent: Option<String>,
    #[serde(default)]
    pub identities_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_timeout: Option<u64>,
    #[serde(default)]
    pub compression: bool,
    #[serde(default)]
    pub keep_alive: bool,
    #[serde(default = "default_interval")]
    pub keep_alive_interval: u64,
    #[serde(default = "default_count")]
    pub server_alive_count_max: u32,
}
impl std::fmt::Debug for SshEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshEndpoint")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_method", &self.auth_method)
            .finish_non_exhaustive()
    }
}
fn default_interval() -> u64 {
    60
}
fn default_count() -> u32 {
    3
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConfig {
    #[serde(flatten)]
    pub endpoint: SshEndpoint,
    pub jump_hosts: Vec<SshEndpoint>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: &'static str,
    pub file: String,
    pub line: usize,
    pub option: String,
    #[serde(flatten)]
    pub reason: Reason,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    pub alias: String,
    pub config: ImportedConfig,
    pub diagnostics: Vec<Diagnostic>,
    pub importable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub source_path: String,
    pub entries: Vec<ImportedHost>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug)]
struct Directive {
    option: String,
    args: Vec<String>,
    file: Arc<str>,
    line: usize,
    include: Vec<Arc<[Directive]>>,
    error: Option<Reason>,
    deferred_include: bool,
}
impl Directive {
    fn diagnostic(&self, severity: &'static str, reason: Reason) -> Diagnostic {
        Diagnostic {
            severity,
            file: self.file.to_string(),
            line: self.line,
            option: self.option.clone(),
            reason,
        }
    }

    fn work_size(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.file.len()
            + self.option.len()
            + self
                .args
                .iter()
                .map(|arg| std::mem::size_of::<String>() + arg.len())
                .sum::<usize>()
    }
}

struct Parser {
    home: PathBuf,
    cwd: PathBuf,
    username: String,
    bytes: usize,
    stack: Vec<PathBuf>,
    fatal: Vec<Diagnostic>,
    cache: HashMap<PathBuf, Arc<[Directive]>>,
    discovered: BTreeSet<String>,
    remaining_work: usize,
}

/// OpenSSH tokenization, including quotes, escaped spaces and `Key=value`.
fn tokenize(line: &str) -> Result<Vec<String>, Reason> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut separator = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek().copied() {
                Some(next)
                    if next == '\\'
                        || next == '"'
                        || next == '\''
                        || next.is_whitespace()
                        || next == '#' =>
                {
                    word.push(chars.next().unwrap());
                    started = true;
                }
                _ => {
                    word.push(c);
                    started = true;
                }
            }
        } else if Some(c) == quote {
            quote = None;
        } else if quote.is_some() {
            word.push(c);
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            started = true;
        } else if c == '#' && !started {
            break;
        } else if c == '=' && !separator && (words.is_empty() || (words.len() == 1 && !started)) {
            if started {
                words.push(std::mem::take(&mut word));
                started = false;
            }
            separator = true;
        } else if c.is_whitespace() {
            if started {
                words.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            word.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return Err(Reason::UnterminatedQuote);
    }
    if started {
        words.push(word);
    }
    Ok(words)
}

fn wildcard(pattern: &str, value: &str) -> bool {
    // Linear-space glob matcher: OpenSSH Host patterns use only * and ?.
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let v: Vec<char> = value.to_lowercase().chars().collect();
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < v.len() {
        if i < p.len() && (p[i] == '?' || p[i] == v[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == '*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(s) = star {
            retry += 1;
            j = retry;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == '*' {
        i += 1;
    }
    i == p.len()
}

fn host_matches(patterns: &[String], alias: &str) -> bool {
    let mut positive = false;
    for p in patterns {
        if let Some(negative) = p.strip_prefix('!') {
            if wildcard(negative, alias) {
                return false;
            }
        } else if wildcard(p, alias) {
            positive = true;
        }
    }
    positive
}

pub(crate) fn expand_env(value: &str) -> Result<String, Reason> {
    let mut result = String::new();
    let mut rest = value;
    while let Some(pos) = rest.find("${") {
        result.push_str(&rest[..pos]);
        let tail = &rest[pos + 2..];
        let end = tail
            .find('}')
            .ok_or(Reason::UnterminatedEnvironmentVariable)?;
        let name = &tail[..end];
        result.push_str(
            &std::env::var(name)
                .map_err(|_| Reason::MissingEnvironmentVariable { name: name.into() })?,
        );
        rest = &tail[end + 1..];
    }
    result.push_str(rest);
    Ok(result)
}

#[cfg(unix)]
fn user_home(name: &str) -> Result<PathBuf, Reason> {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(name).map_err(|_| Reason::InvalidLocalUsername)?;
    let mut buffer = vec![0u8; 128 * 1024];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut found = std::ptr::null_mut();
    // The reentrant API writes pointers into our buffer, which stays alive
    // until the returned home directory has been copied into an owned path.
    let status = unsafe {
        libc::getpwnam_r(
            name.as_ptr(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() {
        return Err(Reason::UnknownUserHome);
    }
    let home = unsafe { CStr::from_ptr((*found).pw_dir) };
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes())))
}

#[cfg(windows)]
fn user_home(_name: &str) -> Result<PathBuf, Reason> {
    Err(Reason::NamedUserHomeUnsupported)
}

fn local_hostname() -> Result<String, Reason> {
    #[cfg(unix)]
    {
        let mut bytes = [0u8; 256];
        // gethostname only reads the local machine name; no DNS lookup.
        if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return Err(Reason::LocalHostnameUnavailable);
        }
        let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
        Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").map_err(|_| Reason::LocalHostnameUnavailable)
    }
}

fn local_user_id() -> Result<String, Reason> {
    #[cfg(unix)]
    {
        Ok(unsafe { libc::getuid() }.to_string())
    }
    #[cfg(windows)]
    {
        Err(Reason::UserIdUnsupported)
    }
}

impl Parser {
    fn charge_work(&mut self, size: usize, path: &str, line: usize) -> Result<(), Reason> {
        self.remaining_work =
            self.remaining_work
                .checked_sub(size)
                .ok_or_else(|| Reason::PreviewWorkLimit {
                    path: path.into(),
                    line,
                })?;
        Ok(())
    }

    fn path(&self, raw: &str, relative: &Path) -> Result<PathBuf, Reason> {
        let value = expand_env(raw)?;
        let path = if value == "~" {
            self.home.clone()
        } else if let Some(rest) = value
            .strip_prefix("~/")
            .or_else(|| value.strip_prefix("~\\"))
        {
            self.home.join(rest)
        } else if let Some(rest) = value.strip_prefix('~') {
            let (name, suffix) = rest.split_once('/').unwrap_or((rest, ""));
            let home = if name == self.username {
                self.home.clone()
            } else {
                user_home(name)?
            };
            home.join(suffix)
        } else {
            PathBuf::from(value)
        };
        Ok(if path.is_absolute() {
            path
        } else {
            relative.join(path)
        })
    }

    fn read(&mut self, path: &Path) -> Result<Arc<[Directive]>, Reason> {
        let path = path
            .canonicalize()
            .map_err(|e| Reason::file_access(path, e))?;
        self.charge_work(
            std::mem::size_of::<Directive>() + path.as_os_str().len(),
            &path.to_string_lossy(),
            0,
        )?;
        if self.stack.contains(&path) {
            return Err(Reason::IncludeCycle {
                path: path.to_string_lossy().into_owned(),
            });
        }
        if let Some(nodes) = self.cache.get(&path) {
            return Ok(nodes.clone());
        }
        if self.stack.len() >= MAX_DEPTH {
            return Err(Reason::IncludeDepth { limit: MAX_DEPTH });
        }
        let metadata = std::fs::metadata(&path).map_err(|e| Reason::file_access(&path, e))?;
        if !metadata.is_file() {
            return Err(Reason::NotRegularFile);
        }
        let size = metadata.len();
        if size > MAX_BYTES as u64 || self.bytes.saturating_add(size as usize) > MAX_BYTES {
            return Err(Reason::SourceTooLarge {
                limit: MAX_BYTES / (1024 * 1024),
            });
        }
        let mut text = String::new();
        std::fs::File::open(&path)
            .map_err(|e| Reason::file_access(&path, e))?
            .take((MAX_BYTES - self.bytes + 1) as u64)
            .read_to_string(&mut text)
            .map_err(|e| Reason::file_access(&path, e))?;
        if self.bytes + text.len() > MAX_BYTES {
            return Err(Reason::SourceTooLarge {
                limit: MAX_BYTES / (1024 * 1024),
            });
        }
        self.bytes += text.len();
        self.stack.push(path.clone());
        let result = self.parse_file(&path, &text);
        self.stack.pop();
        let nodes = result?;
        aliases(&nodes, &mut self.discovered)?;
        self.cache.insert(path, nodes.clone());
        Ok(nodes)
    }

    fn parse_file(&mut self, path: &Path, text: &str) -> Result<Arc<[Directive]>, Reason> {
        let mut nodes = Vec::new();
        let file: Arc<str> = path.to_string_lossy().into_owned().into();
        for (line, text) in text.lines().enumerate() {
            let tokens = tokenize(text.trim_start_matches('\u{feff}'));
            if matches!(&tokens, Ok(t) if t.is_empty()) {
                continue;
            }
            let (words, error) = match tokens {
                Ok(t) => (t, None),
                Err(e) => (vec!["syntax".into()], Some(e)),
            };
            let mut node = Directive {
                option: words[0].to_ascii_lowercase(),
                args: words[1..].to_vec(),
                file: file.clone(),
                line: line + 1,
                include: Vec::new(),
                error,
                deferred_include: false,
            };
            self.charge_work(node.work_size(), &node.file, node.line)?;
            if node.option == "match" {
                self.fatal
                    .push(node.diagnostic("error", Reason::MatchUnsupported));
            }
            if node.option == "include" {
                if node.args.is_empty() {
                    node.error = Some(Reason::IncludePathRequired);
                }
                // Host-dependent paths are expanded during evaluation, using
                // only values obtained before this Include directive.
                node.deferred_include = node.args.iter().any(|arg| {
                    let mut chars = arg.chars();
                    while let Some(c) = chars.next() {
                        if c == '%' && !matches!(chars.next(), Some('%' | 'd' | 'u')) {
                            return true;
                        }
                    }
                    false
                });
                if !node.deferred_include {
                    for arg in node.args.clone() {
                        let context = self.token_endpoint(&HashMap::new(), "", None, None);
                        match self.include_paths(&arg, "", &context, "") {
                            Ok(paths) => {
                                for included in paths {
                                    match self.read(&included) {
                                        Ok(child) => node.include.push(child),
                                        Err(
                                            e @ (Reason::PreviewWorkLimit { .. }
                                            | Reason::TooManyAliases { .. }),
                                        ) => return Err(e),
                                        Err(e) => node.error = Some(e),
                                    }
                                }
                            }
                            Err(e @ Reason::PreviewWorkLimit { .. }) => return Err(e),
                            Err(e) => node.error = Some(e),
                        }
                    }
                }
            }
            if node.option == "syntax" || (node.option == "host" && node.args.is_empty()) {
                self.fatal.push(node.diagnostic(
                    "error",
                    node.error.clone().unwrap_or(Reason::HostPatternRequired),
                ));
            }
            nodes.push(node);
        }
        Ok(nodes.into())
    }

    fn tokens(&self, raw: &str, alias: &str, endpoint: &SshEndpoint) -> Result<String, Reason> {
        self.tokens_with_jump(raw, alias, endpoint, "")
    }

    fn tokens_with_jump(
        &self,
        raw: &str,
        alias: &str,
        endpoint: &SshEndpoint,
        jump: &str,
    ) -> Result<String, Reason> {
        let mut result = String::new();
        let mut chars = raw.chars();
        while let Some(c) = chars.next() {
            if c != '%' {
                result.push(c);
                continue;
            }
            result.push_str(&match chars.next() {
                Some('%') => "%".into(),
                Some('h') => endpoint.host.clone(),
                Some('n') => alias.into(),
                Some('p') => endpoint.port.to_string(),
                Some('r') => endpoint.username.clone(),
                Some('d') => self.home.to_string_lossy().into(),
                Some('u') => self.username.clone(),
                Some('i') => local_user_id()?,
                Some('k') => alias.into(),
                Some('l') => local_hostname()?,
                Some('L') => local_hostname()?
                    .split('.')
                    .next()
                    .unwrap_or_default()
                    .into(),
                Some('j') => jump.into(),
                Some('C') => {
                    let parts = [
                        local_hostname()?,
                        endpoint.host.clone(),
                        endpoint.port.to_string(),
                        endpoint.username.clone(),
                        jump.to_string(),
                    ];
                    let bytes: Vec<u8> = parts
                        .iter()
                        .flat_map(|p| p.bytes().chain(std::iter::once(0)))
                        .collect();
                    openssl::sha::sha1(&bytes)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect()
                }
                other => {
                    return Err(Reason::UnsupportedToken {
                        token: format!("%{}", other.map(|c| c.to_string()).unwrap_or_default()),
                    })
                }
            });
        }
        Ok(result)
    }

    fn include_paths(
        &mut self,
        raw: &str,
        alias: &str,
        endpoint: &SshEndpoint,
        jump: &str,
    ) -> Result<Vec<PathBuf>, Reason> {
        let expanded = self.tokens_with_jump(raw, alias, endpoint, jump)?;
        let path = self.path(&expanded, &self.home.join(".ssh"))?;
        let matches =
            glob::glob(&path.to_string_lossy()).map_err(|e| Reason::InvalidIncludePattern {
                detail: e.to_string(),
            })?;
        let mut paths = Vec::new();
        for path in matches {
            let path = path.map_err(|e| Reason::IncludePatternRead {
                detail: e.to_string(),
            })?;
            self.charge_work(
                std::mem::size_of::<PathBuf>() + path.as_os_str().len(),
                &path.to_string_lossy(),
                0,
            )?;
            paths.push(path);
        }
        paths.sort();
        Ok(paths)
    }

    fn token_endpoint(
        &self,
        values: &HashMap<String, Directive>,
        alias: &str,
        user: Option<&str>,
        port: Option<u16>,
    ) -> SshEndpoint {
        let value = |key: &str| values.get(key).and_then(|n| n.args.first()).cloned();
        let mut endpoint = SshEndpoint {
            host: alias.into(),
            port: port
                .or_else(|| value("port").and_then(|p| p.parse().ok()))
                .unwrap_or(22),
            username: user
                .map(String::from)
                .or_else(|| value("user"))
                .unwrap_or_else(|| self.username.clone()),
            auth_method: "auto".into(),
            private_key_path: None,
            password: None,
            passphrase: None,
            identity_files: None,
            identity_agent: None,
            identities_only: false,
            connect_timeout: None,
            compression: false,
            keep_alive: false,
            keep_alive_interval: 60,
            server_alive_count_max: 3,
        };
        if let Some(host) = value("hostname") {
            if let Ok(expanded) = self.tokens(&host, alias, &endpoint) {
                endpoint.host = expanded;
            }
        }
        endpoint
    }

    fn resolve(
        &mut self,
        nodes: &[Directive],
        alias: &str,
        user: Option<&str>,
        port: Option<u16>,
    ) -> Result<(SshEndpoint, Option<Directive>, Vec<Diagnostic>, bool), Reason> {
        let mut values = HashMap::<String, Directive>::new();
        let mut identities = Vec::new();
        let mut diagnostics = Vec::new();
        let mut explicit = false;
        let mut includes = nodes
            .first()
            .map(|n| vec![PathBuf::from(n.file.as_ref())])
            .unwrap_or_default();
        evaluate(
            self,
            nodes,
            alias,
            true,
            &mut values,
            &mut identities,
            &mut diagnostics,
            &mut explicit,
            user,
            port,
            &mut includes,
        )?;
        let value = |key: &str| values.get(key).and_then(|n| n.args.first()).cloned();
        let mut endpoint = SshEndpoint {
            host: value("hostname").unwrap_or_else(|| alias.into()),
            port: 22,
            username: user
                .map(String::from)
                .or_else(|| value("user"))
                .unwrap_or_else(|| self.username.clone()),
            auth_method: "auto".into(),
            private_key_path: None,
            password: None,
            passphrase: None,
            identity_files: None,
            identity_agent: value("identityagent"),
            identities_only: false,
            connect_timeout: None,
            compression: false,
            keep_alive: false,
            keep_alive_interval: 60,
            server_alive_count_max: 3,
        };
        if let Some(n) = values.get("hostname") {
            let mut base = endpoint.clone();
            base.host = alias.into();
            match self.tokens(&endpoint.host, alias, &base) {
                Ok(h) => endpoint.host = h,
                Err(e) => diagnostics.push(n.diagnostic("error", e)),
            }
        }
        for (key, target) in [
            ("compression", &mut endpoint.compression),
            ("identitiesonly", &mut endpoint.identities_only),
        ] {
            if let Some(n) = values.get(key) {
                let value = n.args.first().map(|value| value.to_ascii_lowercase());
                match value.as_deref() {
                    Some("yes") => *target = true,
                    Some("no") => *target = false,
                    Some("true") if key == "identitiesonly" => *target = true,
                    Some("false") if key == "identitiesonly" => *target = false,
                    _ => diagnostics.push(n.diagnostic("error", Reason::ExpectedBoolean)),
                }
            }
        }
        for key in [
            "port",
            "connecttimeout",
            "serveraliveinterval",
            "serveralivecountmax",
        ] {
            if let Some(n) = values.get(key) {
                let parsed = n.args.first().and_then(|v| {
                    if key == "port" || key == "serveralivecountmax" {
                        v.parse::<u64>().ok()
                    } else {
                        parse_seconds(v)
                    }
                });
                let valid = match (key, parsed) {
                    ("port", Some(v)) if v > 0 && v <= u16::MAX as u64 => {
                        endpoint.port = v as u16;
                        true
                    }
                    ("connecttimeout", Some(v)) if v > 0 => {
                        endpoint.connect_timeout = Some(v);
                        true
                    }
                    ("serveraliveinterval", Some(v)) => {
                        endpoint.keep_alive = v > 0;
                        endpoint.keep_alive_interval = v;
                        true
                    }
                    ("serveralivecountmax", Some(v)) if v <= u32::MAX as u64 => {
                        endpoint.server_alive_count_max = v as u32;
                        true
                    }
                    _ => false,
                };
                if !valid {
                    diagnostics.push(n.diagnostic("error", Reason::InvalidNumber));
                }
            }
        }
        if let Some(p) = port {
            endpoint.port = p;
        }
        let jump_spec = value("proxyjump")
            .filter(|v| v != "none")
            .unwrap_or_default();
        if !identities.is_empty() {
            let mut files = Vec::new();
            let mut seen_files = HashSet::new();
            for n in identities {
                let raw = n.args.first().map(String::as_str).unwrap_or("");
                if raw == "none" {
                    continue;
                }
                match self
                    .tokens_with_jump(raw, alias, &endpoint, &jump_spec)
                    .and_then(|p| self.path(&p, &self.cwd))
                {
                    Ok(p) => {
                        let p = p.to_string_lossy().into_owned();
                        if seen_files.insert(p.clone()) {
                            files.push(p);
                        }
                    }
                    Err(e) => diagnostics.push(n.diagnostic("error", e)),
                }
            }
            endpoint.identity_files = Some(files);
        }
        if let Some(n) = values.get("identityagent") {
            let raw = endpoint.identity_agent.as_deref().unwrap_or("");
            // Environment-selected agents must be resolved at connection time:
            // their socket can change between launches of the application.
            if raw != "none" && raw != "SSH_AUTH_SOCK" {
                match self
                    .tokens_with_jump(raw, alias, &endpoint, &jump_spec)
                    .and_then(|p| {
                        if p.starts_with('$') {
                            Ok(p)
                        } else {
                            self.path(&p, &self.cwd)
                                .map(|p| p.to_string_lossy().into_owned())
                        }
                    }) {
                    Ok(p) => endpoint.identity_agent = Some(p),
                    Err(e) => diagnostics.push(n.diagnostic("error", e)),
                }
            }
        }
        Ok((
            endpoint,
            values.get("proxyjump").cloned(),
            diagnostics,
            explicit,
        ))
    }

    fn route(
        &mut self,
        nodes: &[Directive],
        jump: &Directive,
        target: &SshEndpoint,
        alias: &str,
        stack: &mut Vec<String>,
    ) -> Result<(Vec<SshEndpoint>, Vec<Diagnostic>), Reason> {
        let raw = jump.args.first().map(String::as_str).unwrap_or("");
        if raw == "none" {
            return Ok((vec![], vec![]));
        }
        let mut hops = Vec::new();
        let mut diagnostics = Vec::new();
        for (index, spec) in raw.split(',').enumerate() {
            // URI usernames use percent-encoding, not SSH percent tokens.
            // Keep them intact until parse_jump decodes them, exactly once;
            // in particular %40 is '@', not an unsupported %4 token.
            let expanded = match spec.strip_prefix("ssh://").and_then(|s| s.rsplit_once('@')) {
                Some((user, host)) => format!("ssh://{user}@{}", self.tokens(host, alias, target)?),
                None => self.tokens(spec, alias, target)?,
            };
            let (name, user, port) = parse_jump(&expanded)?;
            if stack.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                return Err(Reason::JumpCycle { host: name });
            }
            stack.push(name.clone());
            if stack.len() > MAX_JUMPS + 1 {
                return Err(Reason::TooManyJumps { limit: MAX_JUMPS });
            }
            let (endpoint, via, mut notes, _) =
                self.resolve(nodes, &name, user.as_deref(), port)?;
            diagnostics.append(&mut notes);
            // Explicit predecessors in a comma-separated chain override the
            // later hop's own ProxyJump (the OpenSSH -J command-line rule).
            if index == 0 {
                if let Some(via) = via {
                    let (mut prefix, mut notes) =
                        self.route(nodes, &via, &endpoint, &name, stack)?;
                    hops.append(&mut prefix);
                    diagnostics.append(&mut notes);
                }
            }
            stack.pop();
            if endpoint.host.eq_ignore_ascii_case(&target.host)
                && endpoint.port == target.port
                && endpoint.username == target.username
            {
                return Err(Reason::JumpTargetsSelf);
            }
            if hops.iter().any(|h: &SshEndpoint| {
                h.host.eq_ignore_ascii_case(&endpoint.host)
                    && h.port == endpoint.port
                    && h.username == endpoint.username
            }) {
                return Err(Reason::JumpRepeated);
            }
            hops.push(endpoint);
            if hops.len() > MAX_JUMPS {
                return Err(Reason::TooManyJumps { limit: MAX_JUMPS });
            }
        }
        Ok((hops, diagnostics))
    }
}

fn parse_seconds(value: &str) -> Option<u64> {
    let mut total = 0u64;
    let mut digits = String::new();
    for c in value.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let multiplier = match c {
            's' | 'S' => 1,
            'm' | 'M' => 60,
            'h' | 'H' => 3600,
            'd' | 'D' => 86400,
            'w' | 'W' => 604800,
            _ => return None,
        };
        total = total.checked_add(digits.parse::<u64>().ok()?.checked_mul(multiplier)?)?;
        digits.clear();
    }
    if !digits.is_empty() {
        total = total.checked_add(digits.parse::<u64>().ok()?)?;
    }
    if value.is_empty() {
        None
    } else {
        Some(total)
    }
}

fn parse_jump(spec: &str) -> Result<(String, Option<String>, Option<u16>), Reason> {
    let uri = spec.starts_with("ssh://");
    let spec = spec.strip_prefix("ssh://").unwrap_or(spec);
    let spec = if uri {
        spec.strip_suffix('/').unwrap_or(spec)
    } else {
        spec
    };
    let (user, host) = match spec.rsplit_once('@') {
        Some((u, h)) if !u.is_empty() => (Some(u.to_string()), h),
        _ => (None, spec),
    };
    let (host, port) = if let Some(rest) = host.strip_prefix('[') {
        let (h, suffix) = rest.split_once(']').ok_or(Reason::InvalidJumpBrackets)?;
        (
            h,
            if suffix.is_empty() {
                None
            } else {
                Some(suffix.strip_prefix(':').ok_or(Reason::InvalidJumpPort)?)
            },
        )
    } else if let Some((h, p)) = host.rsplit_once(':') {
        if h.contains(':') {
            return Err(Reason::UnbracketedIpv6);
        }
        (h, Some(p))
    } else {
        (host, None)
    };
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err(Reason::InvalidJumpHost);
    }
    let port = port
        .map(|p| {
            p.parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or(Reason::InvalidJumpPort)
        })
        .transpose()?;
    let user = user
        .map(|user| {
            if uri {
                decode_uri_user(&user)
            } else {
                Ok(user)
            }
        })
        .transpose()?;
    Ok((host.to_string(), user, port))
}

fn decode_uri_user(value: &str) -> Result<String, Reason> {
    let mut bytes = Vec::new();
    let mut chars = value.bytes();
    while let Some(c) = chars.next() {
        if c != b'%' {
            bytes.push(c);
            continue;
        }
        let hi = chars
            .next()
            .and_then(|c| (c as char).to_digit(16))
            .ok_or(Reason::InvalidJumpEscape)?;
        let lo = chars
            .next()
            .and_then(|c| (c as char).to_digit(16))
            .ok_or(Reason::InvalidJumpEscape)?;
        let c = (hi * 16 + lo) as u8;
        if c == 0 {
            return Err(Reason::InvalidJumpUsername);
        }
        bytes.push(c);
    }
    String::from_utf8(bytes).map_err(|_| Reason::InvalidJumpUsername)
}

#[allow(clippy::too_many_arguments)]
fn evaluate(
    parser: &mut Parser,
    nodes: &[Directive],
    alias: &str,
    inherited: bool,
    values: &mut HashMap<String, Directive>,
    identities: &mut Vec<Directive>,
    diagnostics: &mut Vec<Diagnostic>,
    explicit: &mut bool,
    user: Option<&str>,
    port: Option<u16>,
    include_stack: &mut Vec<PathBuf>,
) -> Result<(), Reason> {
    let mut active = inherited;
    for n in nodes {
        parser.charge_work(n.work_size(), &n.file, n.line)?;
        if n.option == "host" {
            active = inherited && host_matches(&n.args, alias);
            if active && n.args.iter().any(|a| a.eq_ignore_ascii_case(alias)) {
                *explicit = true;
            }
            continue;
        }
        if !active {
            continue;
        }
        if let Some(error) = &n.error {
            diagnostics.push(n.diagnostic("error", error.clone()));
            continue;
        }
        if n.option == "include" {
            if n.deferred_include {
                // Expand each pathname in order; earlier included files may
                // provide defaults used by a later pathname on the same line.
                for arg in &n.args {
                    let endpoint = parser.token_endpoint(values, alias, user, port);
                    let jump = values
                        .get("proxyjump")
                        .and_then(|n| n.args.first())
                        .filter(|v| *v != "none")
                        .cloned()
                        .unwrap_or_default();
                    match parser.include_paths(arg, alias, &endpoint, &jump) {
                        Ok(paths) => {
                            for path in paths {
                                match parser.read(&path) {
                                    Ok(child) => evaluate_include(
                                        parser,
                                        &child,
                                        n,
                                        alias,
                                        active,
                                        values,
                                        identities,
                                        diagnostics,
                                        explicit,
                                        user,
                                        port,
                                        include_stack,
                                    )?,
                                    Err(
                                        error @ (Reason::PreviewWorkLimit { .. }
                                        | Reason::TooManyAliases { .. }),
                                    ) => return Err(error),
                                    Err(error) => diagnostics.push(n.diagnostic("error", error)),
                                }
                            }
                        }
                        Err(error @ Reason::PreviewWorkLimit { .. }) => return Err(error),
                        Err(error) => diagnostics.push(n.diagnostic("error", error)),
                    }
                }
            } else {
                for included in &n.include {
                    evaluate_include(
                        parser,
                        included,
                        n,
                        alias,
                        active,
                        values,
                        identities,
                        diagnostics,
                        explicit,
                        user,
                        port,
                        include_stack,
                    )?;
                }
            }
            continue;
        }
        if n.args.is_empty() {
            diagnostics.push(n.diagnostic("error", Reason::MissingValue));
            continue;
        }
        match n.option.as_str() {
            "identityfile" => {
                if n.args.len() != 1 || n.args[0].is_empty() {
                    diagnostics.push(n.diagnostic("error", Reason::IdentityPathRequired));
                } else {
                    identities.push(n.clone());
                }
            }
            "hostname"
            | "user"
            | "port"
            | "identityagent"
            | "identitiesonly"
            | "compression"
            | "connecttimeout"
            | "serveraliveinterval"
            | "serveralivecountmax" => {
                if n.args.len() != 1 {
                    diagnostics.push(n.diagnostic("error", Reason::ExpectedSingleValue));
                } else {
                    values.entry(n.option.clone()).or_insert_with(|| n.clone());
                }
            }
            "proxyjump" | "proxycommand" => {
                if !values.contains_key("proxyjump") && !values.contains_key("proxycommand") {
                    values.insert(n.option.clone(), n.clone());
                }
            }
            "refuseconnection"
            | "nohostauthenticationforlocalhost"
            | "updatehostkeys"
            | "canonicaldomains"
            | "canonicalizefallbacklocal"
            | "canonicalizepermittedcnames"
            | "canonicalizemaxdots"
            | "hostkeyalias"
            | "userknownhostsfile"
            | "globalknownhostsfile"
            | "knownhostscommand"
            | "stricthostkeychecking"
            | "verifyhostkeydns"
            | "checkhostip"
            | "revokedhostkeys"
            | "certificatefile"
            | "pkcs11provider"
            | "securitykeyprovider"
            | "canonicalizehostname"
            | "pubkeyauthentication"
            | "preferredauthentications"
            | "hostkeyalgorithms"
            | "kexalgorithms"
            | "ciphers"
            | "macs"
            | "bindaddress"
            | "bindinterface" => diagnostics.push(n.diagnostic("error", Reason::UnsupportedOption)),
            "match" => {}
            _ => diagnostics.push(n.diagnostic("warning", Reason::IgnoredOption)),
        }
    }
    // Diagnose the effective transport, not a shadowed ProxyCommand.
    if let Some(n) = values.get("proxycommand") {
        if n.args.first().is_some_and(|s| s != "none")
            && !diagnostics.iter().any(|d| d.option == "proxycommand")
        {
            diagnostics.push(n.diagnostic("error", Reason::ProxyCommandUnsupported));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn evaluate_include(
    parser: &mut Parser,
    nodes: &[Directive],
    source: &Directive,
    alias: &str,
    active: bool,
    values: &mut HashMap<String, Directive>,
    identities: &mut Vec<Directive>,
    diagnostics: &mut Vec<Diagnostic>,
    explicit: &mut bool,
    user: Option<&str>,
    port: Option<u16>,
    stack: &mut Vec<PathBuf>,
) -> Result<(), Reason> {
    let Some(first) = nodes.first() else {
        return Ok(());
    };
    let path = PathBuf::from(first.file.as_ref());
    if stack.contains(&path) {
        diagnostics.push(source.diagnostic(
            "error",
            Reason::IncludeCycle {
                path: first.file.to_string(),
            },
        ));
        return Ok(());
    }
    if stack.len() >= MAX_DEPTH {
        diagnostics.push(source.diagnostic("error", Reason::IncludeDepth { limit: MAX_DEPTH }));
        return Ok(());
    }
    stack.push(path);
    let result = evaluate(
        parser,
        nodes,
        alias,
        active,
        values,
        identities,
        diagnostics,
        explicit,
        user,
        port,
        stack,
    );
    stack.pop();
    result
}

// Each file's aliases are discovered once when it enters the syntax cache.
// Walking the expanded Include tree here would repeat exponential work even
// when all of its syntax nodes are shared.
fn aliases(nodes: &[Directive], result: &mut BTreeSet<String>) -> Result<(), Reason> {
    for n in nodes {
        if n.option == "host" {
            for a in &n.args {
                if !a.starts_with('!') && !a.contains(['*', '?']) {
                    result.insert(a.clone());
                    if result.len() > 4096 {
                        return Err(Reason::TooManyAliases { limit: 4096 });
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn preview(path: Option<String>) -> Result<ImportPreview, Reason> {
    let home = dirs::home_dir().ok_or(Reason::HomeUnavailable)?;
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .map_err(|_| Reason::UsernameUnavailable)?;
    preview_with_home(path, home, username)
}

fn preview_with_home(
    path: Option<String>,
    home: PathBuf,
    username: String,
) -> Result<ImportPreview, Reason> {
    let mut parser = Parser {
        home,
        cwd: std::env::current_dir().map_err(|e| Reason::CurrentDirectoryUnavailable {
            detail: e.to_string(),
        })?,
        username,
        bytes: 0,
        stack: vec![],
        fatal: vec![],
        cache: HashMap::new(),
        discovered: BTreeSet::new(),
        remaining_work: MAX_PREVIEW_WORK,
    };
    let path = parser.path(path.as_deref().unwrap_or("~/.ssh/config"), &parser.cwd)?;
    let canonical = path
        .canonicalize()
        .map_err(|e| Reason::file_access(&path, e))?;
    let nodes = parser.read(&canonical)?;
    let mut names = std::mem::take(&mut parser.discovered);
    let mut entries = Vec::new();
    let mut processed = BTreeSet::new();
    while let Some(alias) = names.pop_first() {
        if !processed.insert(alias.clone()) {
            continue;
        }
        if processed.len() > 4096 {
            return Err(Reason::TooManyAliases { limit: 4096 });
        }
        let (endpoint, jump, mut diagnostics, explicit) =
            parser.resolve(&nodes, &alias, None, None)?;
        names.append(&mut parser.discovered);
        if !explicit {
            continue;
        }
        let mut jump_hosts = Vec::new();
        if let Some(jump) = jump {
            match parser.route(&nodes, &jump, &endpoint, &alias, &mut vec![alias.clone()]) {
                Ok((route, mut notes)) => {
                    jump_hosts = route;
                    diagnostics.append(&mut notes);
                }
                Err(e @ (Reason::PreviewWorkLimit { .. } | Reason::TooManyAliases { .. })) => {
                    return Err(e)
                }
                Err(e) => diagnostics.push(jump.diagnostic("error", e)),
            }
        }
        names.append(&mut parser.discovered);
        let importable =
            parser.fatal.is_empty() && !diagnostics.iter().any(|d| d.severity == "error");
        entries.push(ImportedHost {
            alias,
            config: ImportedConfig {
                endpoint,
                jump_hosts,
            },
            diagnostics,
            importable,
        });
    }
    if !parser.fatal.is_empty() {
        for entry in &mut entries {
            entry.importable = false;
        }
    }
    entries.sort_by(|a, b| a.alias.cmp(&b.alias));
    Ok(ImportPreview {
        source_path: canonical.to_string_lossy().into(),
        entries,
        diagnostics: parser.fatal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(text: &str) -> (tempfile::TempDir, ImportPreview) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".ssh")).unwrap();
        std::fs::write(dir.path().join(".ssh/config"), text).unwrap();
        let result = preview_with_home(None, dir.path().into(), "local-user".into()).unwrap();
        (dir, result)
    }
    #[test]
    fn first_match_aliases_negation_and_identity_accumulation() {
        let (home, p) = fixture("User first\r\nHost prod dev\r\n User later\n IdentityFile \"~/.ssh/key one\"\nHost * !dev\n Port 2222\n IdentityFile ~/.ssh/shared\nHost *\n Port 22\n");
        assert_eq!(p.entries.len(), 2);
        let dev = &p.entries[0].config.endpoint;
        let prod = &p.entries[1].config.endpoint;
        assert_eq!(prod.username, "first");
        assert_eq!(prod.port, 2222);
        assert_eq!(dev.port, 22);
        assert_eq!(prod.identity_files.as_ref().unwrap().len(), 2);
        assert_eq!(
            dev.identity_files.as_ref().unwrap()[0],
            home.path().join(".ssh/key one").to_str().unwrap()
        );
    }

    #[test]
    fn boolean_defaults_accept_openssh_case_and_identity_synonyms() {
        for (compression, identities, expected) in [
            ("YES", "Yes", true),
            ("No", "nO", false),
            ("yes", "TrUe", true),
            ("no", "FaLsE", false),
        ] {
            let (home, p) = fixture(&format!(
                "Host first second\nHost *\nCompression {compression}\nIdentitiesOnly {identities}\n"
            ));
            assert_eq!(p.entries.len(), 2);
            for entry in &p.entries {
                assert!(entry.importable, "{:?}", entry.diagnostics);
                assert_eq!(entry.config.endpoint.compression, expected);
                assert_eq!(entry.config.endpoint.identities_only, expected);
            }
            if let Ok(output) = std::process::Command::new("ssh")
                .args(["-G", "-F"])
                .arg(home.path().join(".ssh/config"))
                .arg("first")
                .output()
            {
                assert!(output.status.success());
                let text = String::from_utf8(output.stdout).unwrap();
                let value = if expected { "yes" } else { "no" };
                for option in ["compression", "identitiesonly"] {
                    assert!(text.lines().any(|line| line == format!("{option} {value}")));
                }
            }
        }

        let (_, p) = fixture("Host explicit\nCompression No\nIdentitiesOnly FALSE\nHost implicit\nHost *\nCompression YES\nIdentitiesOnly Yes\n");
        assert!(p.entries.iter().all(|entry| entry.importable));
        assert!(!p.entries[0].config.endpoint.compression);
        assert!(!p.entries[0].config.endpoint.identities_only);
        assert!(p.entries[1].config.endpoint.compression);
        assert!(p.entries[1].config.endpoint.identities_only);

        for invalid in ["Compression ON", "Compression True", "IdentitiesOnly 1"] {
            let (_, p) = fixture(&format!("Host invalid\n{invalid}\n"));
            assert!(!p.entries[0].importable);
        }
    }
    #[test]
    fn includes_are_ordered_scoped_and_cycles_are_reported() {
        let (home, _) =
            fixture("Host prod\n Include a.conf b.conf\nHost dev\nHost *\nUser fallback\n");
        std::fs::write(
            home.path().join(".ssh/a.conf"),
            "User first\nIdentityFile ~/key-a\n",
        )
        .unwrap();
        std::fs::write(
            home.path().join(".ssh/b.conf"),
            "User second\nIdentityFile ~/key-b\n",
        )
        .unwrap();
        let p = preview_with_home(None, home.path().into(), "local".into()).unwrap();
        assert_eq!(p.entries[0].config.endpoint.username, "fallback");
        assert_eq!(p.entries[1].config.endpoint.username, "first");
        assert_eq!(
            p.entries[1]
                .config
                .endpoint
                .identity_files
                .as_ref()
                .unwrap()
                .len(),
            2
        );
        std::fs::write(home.path().join(".ssh/a.conf"), "Include config\n").unwrap();
        let p = preview_with_home(None, home.path().into(), "local".into()).unwrap();
        assert!(
            !p.entries
                .iter()
                .find(|h| h.alias == "prod")
                .unwrap()
                .importable
        );
    }

    #[test]
    fn repeated_includes_share_cached_syntax_and_alias_discovery() {
        let (home, _) = fixture("Host target\nInclude child child\n");
        std::fs::write(home.path().join(".ssh/child"), "Host other\nUser deploy\n").unwrap();
        let mut parser = Parser {
            home: home.path().into(),
            cwd: home.path().into(),
            username: "local".into(),
            bytes: 0,
            stack: vec![],
            fatal: vec![],
            cache: HashMap::new(),
            discovered: BTreeSet::new(),
            remaining_work: MAX_PREVIEW_WORK,
        };
        let nodes = parser.read(&home.path().join(".ssh/config")).unwrap();
        assert!(Arc::ptr_eq(&nodes[1].include[0], &nodes[1].include[1]));
        let cached = parser.read(&home.path().join(".ssh/child")).unwrap();
        assert!(Arc::ptr_eq(&cached, &nodes[1].include[0]));
        assert_eq!(parser.cache.len(), 2);
        assert_eq!(
            parser.discovered,
            BTreeSet::from(["other".into(), "target".into()])
        );
    }

    #[test]
    fn expanded_static_and_deferred_includes_have_a_shared_work_limit() {
        for deferred in [false, true] {
            let (home, _) = fixture("Host target\n");
            for level in 0..MAX_DEPTH {
                let path = if level == 0 {
                    home.path().join(".ssh/config")
                } else {
                    home.path().join(format!(".ssh/target-{level}"))
                };
                let text = if level + 1 == MAX_DEPTH {
                    // Still a tiny source, but an expanded traversal would
                    // visit over 16 million directives without a work limit.
                    "User deploy\n".repeat(500)
                } else {
                    let next = format!("{}-{}", if deferred { "%n" } else { "target" }, level + 1);
                    format!(
                        "{}Include {next} {next}\n",
                        if level == 0 { "Host target\n" } else { "" }
                    )
                };
                std::fs::write(path, text).unwrap();
            }
            let error = preview_with_home(None, home.path().into(), "local".into()).unwrap_err();
            assert!(matches!(error, Reason::PreviewWorkLimit { .. }), "{error}");
        }
    }

    #[test]
    fn work_limit_counts_large_repeated_values_and_reports_the_source() {
        let (home, _) = fixture("Host target\nInclude child child\n");
        std::fs::write(
            home.path().join(".ssh/child"),
            format!("IdentityFile {}\n", "a".repeat(1024 * 1024)),
        )
        .unwrap();
        let mut parser = Parser {
            home: home.path().into(),
            cwd: home.path().into(),
            username: "local".into(),
            bytes: 0,
            stack: vec![],
            fatal: vec![],
            cache: HashMap::new(),
            discovered: BTreeSet::new(),
            remaining_work: MAX_PREVIEW_WORK,
        };
        let nodes = parser.read(&home.path().join(".ssh/config")).unwrap();
        // The first copy fits, the second must fail before it is cloned.
        parser.remaining_work = 2 * 1024 * 1024;
        let error = parser.resolve(&nodes, "target", None, None).unwrap_err();
        match error {
            Reason::PreviewWorkLimit { path, line } => {
                assert_eq!(
                    Path::new(&path),
                    home.path().join(".ssh/child").canonicalize().unwrap()
                );
                assert_eq!(line, 1);
            }
            other => panic!("unexpected diagnostic: {other}"),
        }
    }
    #[test]
    fn jump_hosts_are_self_contained_and_have_independent_identities() {
        let (_, p) = fixture("Host target\n HostName 10.0.0.2\n User app\n ProxyJump one,other@two:2222\nHost one\n HostName bastion\n User admin\n IdentityFile ~/first\nHost two\n HostName gateway\n IdentityFile none\n IdentitiesOnly yes\n IdentityAgent none\n");
        let target = p.entries.iter().find(|h| h.alias == "target").unwrap();
        assert!(target.importable);
        assert_eq!(target.config.jump_hosts.len(), 2);
        assert_eq!(target.config.jump_hosts[0].username, "admin");
        assert_eq!(target.config.jump_hosts[1].username, "other");
        assert_eq!(target.config.jump_hosts[1].port, 2222);
        assert_eq!(target.config.jump_hosts[1].identity_files, Some(vec![]));
    }

    #[test]
    fn jump_uri_usernames_keep_percent_escapes_until_uri_decoding() {
        let (_, p) = fixture("Host target\nUser deploy\nProxyJump ssh://user%40realm@bastion:2200,ssh://caf%C3%A9%2C%2525@[::1]:2201,%r@gateway:%p\nHost bastion\nUser fallback\n");
        let target = p.entries.iter().find(|h| h.alias == "target").unwrap();
        assert!(target.importable, "{:?}", target.diagnostics);
        let hops = &target.config.jump_hosts;
        assert_eq!(hops.len(), 3);
        assert_eq!(hops[0].username, "user@realm");
        assert_eq!(hops[0].host, "bastion");
        assert_eq!(hops[0].port, 2200);
        assert_eq!(hops[1].username, "café,%25");
        assert_eq!(hops[1].host, "::1");
        assert_eq!(hops[1].port, 2201);
        assert_eq!(hops[2].username, "deploy");
        assert_eq!(hops[2].port, 22);

        for user in ["bad%4", "bad%GG", "bad%00", "bad%FF"] {
            let (_, p) = fixture(&format!("Host target\nProxyJump ssh://{user}@bastion\n"));
            assert!(!p.entries[0].importable, "{user}");
        }
    }

    #[test]
    fn comments_start_at_token_boundaries_and_keep_hashes_in_values() {
        assert!(tokenize("  # comment").unwrap().is_empty());
        for line in [
            "User admin#prod # comment",
            "User = admin#prod\t# comment",
            "User \"admin#prod\" # comment",
        ] {
            assert_eq!(tokenize(line).unwrap(), vec!["User", "admin#prod"]);
        }
        let (home, p) = fixture("Host prod\nUser admin#prod # comment\nIdentityFile ~/key#prod # comment\nIdentityAgent ~/agent#prod\n");
        let host = &p.entries[0];
        assert!(host.importable);
        assert_eq!(host.config.endpoint.username, "admin#prod");
        assert_eq!(
            host.config.endpoint.identity_files,
            Some(vec![home
                .path()
                .join("key#prod")
                .to_string_lossy()
                .into_owned()])
        );
        assert_eq!(
            host.config.endpoint.identity_agent.as_deref(),
            home.path().join("agent#prod").to_str()
        );
    }
    #[test]
    fn unsafe_routes_and_match_never_silently_become_direct_connections() {
        let (_, p) =
            fixture("Host bad\nProxyCommand command\nHost good\nHost loop\nProxyJump loop\n");
        assert!(!p.entries[0].importable);
        assert!(p.entries[1].importable);
        assert!(!p.entries[2].importable);
        let (_, p) = fixture("Host good\nMatch exec \"touch /tmp/never\"\nUser other\n");
        assert!(!p.entries[0].importable);
        assert!(!p.diagnostics.is_empty());
    }
    #[test]
    fn lexer_ipv6_tokens_and_defaults() {
        assert_eq!(
            tokenize("IdentityFile=\"~/a b\" # comment").unwrap(),
            vec!["IdentityFile", "~/a b"]
        );
        assert_eq!(
            parse_jump("ssh://user@[::1]:2222").unwrap(),
            ("::1".into(), Some("user".into()), Some(2222))
        );
        let (_, p) = fixture("Host server\nHostName %h.example.com\nIdentityFile ~/.ssh/%r-%h-%p\nConnectTimeout 1m30s\n");
        let c = &p.entries[0].config.endpoint;
        assert_eq!(c.host, "server.example.com");
        assert_eq!(c.connect_timeout, Some(90));
        assert!(c.identity_files.as_ref().unwrap()[0].ends_with("local-user-server.example.com-22"));
    }
    #[test]
    fn supported_fixture_matches_openssh() {
        let (home, p) = fixture("Host prod other\n HostName 192.0.2.4\n User deploy#prod # comment\n Port 2222\n IdentityFile ~/.ssh/deploy#prod # comment\n ProxyJump ssh://user%40realm@bastion:2200\nHost *\n User nobody\n Compression yes\n ServerAliveInterval 30\n");
        let output = match std::process::Command::new("ssh")
            .args(["-G", "-F"])
            .arg(home.path().join(".ssh/config"))
            .arg("prod")
            .output()
        {
            Ok(o) => o,
            Err(_) => return,
        };
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        let host = p.entries.iter().find(|h| h.alias == "prod").unwrap();
        let c = &host.config.endpoint;
        let hop = &host.config.jump_hosts[0];
        for expected in [
            format!("hostname {}", c.host),
            format!("user {}", c.username),
            format!("port {}", c.port),
            format!("serveraliveinterval {}", c.keep_alive_interval),
            "identityfile ~/.ssh/deploy#prod".into(),
            format!("proxyjump {}@{}:{}", hop.username, hop.host, hop.port),
        ] {
            assert!(text.lines().any(|line| line == expected));
        }
    }

    #[test]
    fn includes_restore_scope_between_files_and_keep_glob_order() {
        let (home, _) =
            fixture("Host prod\n Include parts/*.conf\n Port 2200\nHost dev\n User dev\n");
        std::fs::create_dir(home.path().join(".ssh/parts")).unwrap();
        std::fs::write(
            home.path().join(".ssh/parts/10.conf"),
            "Host other\n User ignored\n",
        )
        .unwrap();
        std::fs::write(
            home.path().join(".ssh/parts/20.conf"),
            "User included\nIdentityFile ~/first\n",
        )
        .unwrap();
        std::fs::write(
            home.path().join(".ssh/parts/30.conf"),
            "User later\nIdentityFile ~/second\n",
        )
        .unwrap();
        let p = preview_with_home(None, home.path().into(), "local".into()).unwrap();
        assert_eq!(p.entries.len(), 2); // the conditional alias "other" is unreachable
        let prod = &p
            .entries
            .iter()
            .find(|h| h.alias == "prod")
            .unwrap()
            .config
            .endpoint;
        assert_eq!(prod.username, "included");
        assert_eq!(prod.port, 2200);
        assert_eq!(
            Path::new(&prod.identity_files.as_ref().unwrap()[0]),
            home.path().join("first")
        );
        // Compare actual OpenSSH using absolute includes (ssh -G uses the real
        // user's home; the importer fixture deliberately uses a temporary one).
        let source = home.path().join(".ssh/config");
        let text = std::fs::read_to_string(&source).unwrap().replace(
            "parts/*.conf",
            &format!(
                "{}/.ssh/parts/*.conf",
                home.path().to_string_lossy().replace('\\', "/")
            ),
        );
        std::fs::write(&source, text).unwrap();
        if let Ok(output) = std::process::Command::new("ssh")
            .args(["-G", "-F"])
            .arg(source)
            .arg("prod")
            .output()
        {
            assert!(output.status.success());
            let text = String::from_utf8(output.stdout).unwrap();
            assert!(text.lines().any(|line| line == "user included"));
            assert!(text.lines().any(|line| line == "port 2200"));
        }
    }

    #[test]
    fn whitespace_equals_none_and_unconvertible_rules() {
        assert_eq!(
            tokenize("IdentityFile = \"/a = b\" # comment").unwrap(),
            vec!["IdentityFile", "/a = b"]
        );
        assert_eq!(tokenize("Port==22").unwrap(), vec!["Port", "=22"]);
        let (_, p) = fixture("Host good\nIdentityFile none\nIdentityAgent none\nHost bad\nPort 1m\nHost verification\nUserKnownHostsFile /other\nHost warning\nLocalCommand echo ignored\n");
        assert!(
            !p.entries
                .iter()
                .find(|e| e.alias == "bad")
                .unwrap()
                .importable
        );
        assert!(
            !p.entries
                .iter()
                .find(|e| e.alias == "verification")
                .unwrap()
                .importable
        );
        let good = p.entries.iter().find(|e| e.alias == "good").unwrap();
        assert_eq!(good.config.endpoint.identity_files, Some(vec![]));
        let warning = p.entries.iter().find(|e| e.alias == "warning").unwrap();
        assert!(warning.importable);
        assert_eq!(warning.diagnostics[0].option, "localcommand");
        assert!(warning.diagnostics[0].line > 0);
    }

    #[test]
    fn nested_routes_cycles_and_explicit_predecessors() {
        let (_, p) = fixture("Host target\nProxyJump second\nHost second\nProxyJump first\nUser second-user\nHost first\nUser first-user\nHost explicit\nProxyJump first,second\nHost loop\nProxyJump loop\n");
        for name in ["target", "explicit"] {
            let host = p.entries.iter().find(|e| e.alias == name).unwrap();
            assert!(host.importable);
            assert_eq!(host.config.jump_hosts.len(), 2);
            assert_eq!(host.config.jump_hosts[0].username, "first-user");
            assert_eq!(host.config.jump_hosts[1].username, "second-user");
        }
        assert!(
            !p.entries
                .iter()
                .find(|e| e.alias == "loop")
                .unwrap()
                .importable
        );
    }

    #[test]
    fn include_tokens_use_values_at_the_directive_and_detect_dynamic_cycles() {
        let (home, _) = fixture("Host prod\nHostName service\nUser deploy\nPort 2200\nInclude %h-%r-%p.conf\nHost literal\nInclude percent-%%.conf\nHost cycle\nInclude %n-cycle.conf\n");
        std::fs::write(
            home.path().join(".ssh/service-deploy-2200.conf"),
            "IdentityFile ~/prod-key\nPort 9999\n",
        )
        .unwrap();
        std::fs::write(home.path().join(".ssh/percent-%.conf"), "User percent\n").unwrap();
        std::fs::write(
            home.path().join(".ssh/cycle-cycle.conf"),
            "Include config\n",
        )
        .unwrap();
        let preview = preview_with_home(None, home.path().into(), "local".into()).unwrap();
        let prod = preview.entries.iter().find(|e| e.alias == "prod").unwrap();
        assert!(prod.importable, "{:?}", prod.diagnostics);
        assert_eq!(prod.config.endpoint.port, 2200);
        assert_eq!(
            Path::new(&prod.config.endpoint.identity_files.as_ref().unwrap()[0]),
            home.path().join("prod-key")
        );
        let literal = preview
            .entries
            .iter()
            .find(|e| e.alias == "literal")
            .unwrap();
        assert!(literal.importable);
        assert_eq!(literal.config.endpoint.username, "percent");
        assert!(
            !preview
                .entries
                .iter()
                .find(|e| e.alias == "cycle")
                .unwrap()
                .importable
        );
    }

    #[test]
    fn include_arguments_can_depend_on_preceding_included_values() {
        let (home, _) = fixture("Host prod\nInclude first.conf %r.conf\n");
        std::fs::write(home.path().join(".ssh/first.conf"), "User deploy\n").unwrap();
        std::fs::write(home.path().join(".ssh/deploy.conf"), "Port 2201\n").unwrap();
        let preview = preview_with_home(None, home.path().into(), "local".into()).unwrap();
        assert!(preview.entries[0].importable);
        assert_eq!(preview.entries[0].config.endpoint.port, 2201);
    }

    #[test]
    fn preview_diagnostics_serialize_codes_parameters_and_source_positions() {
        let (_, preview) = fixture("Host bad\nIdentityFile %Q\nHost warning\nLocalCommand echo ignored\nHost loop\nProxyJump loop\n");
        let json = serde_json::to_value(&preview).unwrap();
        let bad = &json["entries"][0]["diagnostics"][0];
        assert_eq!(bad["code"], "unsupportedToken");
        assert_eq!(bad["params"]["token"], "%Q");
        assert_eq!(bad["file"], json["sourcePath"]);
        assert_eq!(bad["line"], 2);
        assert_eq!(bad["option"], "identityfile");
        assert!(bad.get("message").is_none());
        let cycle = &json["entries"][1]["diagnostics"][0];
        assert_eq!(cycle["code"], "jumpCycle");
        assert_eq!(cycle["params"]["host"], "loop");
        let warning = &json["entries"][2]["diagnostics"][0];
        assert_eq!(warning["code"], "ignoredOption");
        assert_eq!(warning["severity"], "warning");

        let (_, preview) = fixture("Host all\nMatch exec ignored\n");
        let json = serde_json::to_value(preview).unwrap();
        assert_eq!(json["diagnostics"][0]["code"], "matchUnsupported");
        assert_eq!(json["diagnostics"][0]["line"], 2);
    }

    #[test]
    fn unreadable_source_returns_a_structured_error() {
        let home = tempfile::tempdir().unwrap();
        let error = preview_with_home(None, home.path().into(), "local".into()).unwrap_err();
        let json = serde_json::to_value(error).unwrap();
        assert_eq!(json["code"], "fileAccess");
        assert_eq!(
            Path::new(json["params"]["path"].as_str().unwrap()),
            home.path().join(".ssh/config")
        );
        assert!(!json["params"]["detail"].as_str().unwrap().is_empty());
    }
}
