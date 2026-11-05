//! Read-only OpenSSH import. This module never starts a process or opens a key.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 16;
const MAX_BYTES: usize = 4 * 1024 * 1024;
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
    pub message: String,
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
    file: String,
    line: usize,
    include: Vec<Vec<Directive>>,
    error: Option<String>,
    deferred_include: bool,
}
impl Directive {
    fn diagnostic(&self, severity: &'static str, message: impl Into<String>) -> Diagnostic {
        Diagnostic {
            severity,
            file: self.file.clone(),
            line: self.line,
            option: self.option.clone(),
            message: message.into(),
        }
    }
}

struct Parser {
    home: PathBuf,
    cwd: PathBuf,
    username: String,
    bytes: usize,
    stack: Vec<PathBuf>,
    fatal: Vec<Diagnostic>,
    cache: HashMap<PathBuf, Vec<Directive>>,
    discovered: BTreeSet<String>,
}

/// OpenSSH tokenization, including quotes, escaped spaces and `Key=value`.
fn tokenize(line: &str) -> Result<Vec<String>, String> {
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
        } else if c == '#' {
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
        return Err("Unterminated quoted value".into());
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

pub(crate) fn expand_env(value: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut rest = value;
    while let Some(pos) = rest.find("${") {
        result.push_str(&rest[..pos]);
        let tail = &rest[pos + 2..];
        let end = tail.find('}').ok_or("Unterminated environment variable")?;
        let name = &tail[..end];
        result.push_str(
            &std::env::var(name).map_err(|_| format!("Environment variable {name} is not set"))?,
        );
        rest = &tail[end + 1..];
    }
    result.push_str(rest);
    Ok(result)
}

#[cfg(unix)]
fn user_home(name: &str) -> Result<PathBuf, String> {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(name).map_err(|_| "Invalid local username")?;
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
        return Err("Cannot resolve the named user's home directory".into());
    }
    let home = unsafe { CStr::from_ptr((*found).pw_dir) };
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes())))
}

#[cfg(windows)]
fn user_home(_name: &str) -> Result<PathBuf, String> {
    Err("Named-user home expansion requires a local account profile on this platform".into())
}

fn local_hostname() -> Result<String, String> {
    #[cfg(unix)]
    {
        let mut bytes = [0u8; 256];
        // gethostname only reads the local machine name; no DNS lookup.
        if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return Err("Cannot determine the local hostname".into());
        }
        let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
        Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").map_err(|_| "Cannot determine the local hostname".into())
    }
}

fn local_user_id() -> Result<String, String> {
    #[cfg(unix)]
    {
        Ok(unsafe { libc::getuid() }.to_string())
    }
    #[cfg(windows)]
    {
        Err("The %i token is not supported on Windows".into())
    }
}

impl Parser {
    fn path(&self, raw: &str, relative: &Path) -> Result<PathBuf, String> {
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

    fn read(&mut self, path: &Path) -> Result<Vec<Directive>, String> {
        let path = path
            .canonicalize()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if self.stack.contains(&path) {
            return Err(format!("Include cycle at {}", path.display()));
        }
        if let Some(nodes) = self.cache.get(&path) {
            return Ok(nodes.clone());
        }
        if self.stack.len() >= MAX_DEPTH {
            return Err("Include nesting exceeds 16 files".into());
        }
        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("SSH configuration must be a regular file".into());
        }
        let size = metadata.len();
        if size > MAX_BYTES as u64 || self.bytes.saturating_add(size as usize) > MAX_BYTES {
            return Err("SSH configuration exceeds 4 MiB".into());
        }
        let mut text = String::new();
        std::fs::File::open(&path)
            .map_err(|e| e.to_string())?
            .take((MAX_BYTES - self.bytes + 1) as u64)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        if self.bytes + text.len() > MAX_BYTES {
            return Err("SSH configuration exceeds 4 MiB".into());
        }
        self.bytes += text.len();
        self.stack.push(path.clone());
        let mut nodes = Vec::new();
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
                file: path.to_string_lossy().into(),
                line: line + 1,
                include: Vec::new(),
                error,
                deferred_include: false,
            };
            if node.option == "match" {
                self.fatal.push(node.diagnostic(
                    "error",
                    "Match blocks cannot be converted reliably; this source cannot be imported",
                ));
            }
            if node.option == "include" {
                if node.args.is_empty() {
                    node.error = Some("Include requires a path".into());
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
                                        Err(e) => node.error = Some(e),
                                    }
                                }
                            }
                            Err(e) => node.error = Some(e),
                        }
                    }
                }
            }
            if node.option == "syntax" || (node.option == "host" && node.args.is_empty()) {
                self.fatal.push(
                    node.diagnostic(
                        "error",
                        node.error
                            .clone()
                            .unwrap_or("Host requires a pattern".into()),
                    ),
                );
            }
            nodes.push(node);
        }
        self.stack.pop();
        self.cache.insert(path, nodes.clone());
        Ok(nodes)
    }

    fn tokens(&self, raw: &str, alias: &str, endpoint: &SshEndpoint) -> Result<String, String> {
        self.tokens_with_jump(raw, alias, endpoint, "")
    }

    fn tokens_with_jump(
        &self,
        raw: &str,
        alias: &str,
        endpoint: &SshEndpoint,
        jump: &str,
    ) -> Result<String, String> {
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
                other => return Err(format!("Unsupported SSH path token: %{other:?}")),
            });
        }
        Ok(result)
    }

    fn include_paths(
        &self,
        raw: &str,
        alias: &str,
        endpoint: &SshEndpoint,
        jump: &str,
    ) -> Result<Vec<PathBuf>, String> {
        let expanded = self.tokens_with_jump(raw, alias, endpoint, jump)?;
        let path = self.path(&expanded, &self.home.join(".ssh"))?;
        let mut paths = glob::glob(&path.to_string_lossy())
            .map_err(|e| e.to_string())?
            .map(|p| p.map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
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
    ) -> (SshEndpoint, Option<Directive>, Vec<Diagnostic>, bool) {
        let mut values = HashMap::<String, Directive>::new();
        let mut identities = Vec::new();
        let mut diagnostics = Vec::new();
        let mut explicit = false;
        let mut includes = nodes
            .first()
            .map(|n| vec![PathBuf::from(&n.file)])
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
        );
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
                match n.args.first().map(String::as_str) {
                    Some("yes") => *target = true,
                    Some("no") => *target = false,
                    _ => diagnostics.push(n.diagnostic("error", "Expected yes or no")),
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
                    diagnostics.push(n.diagnostic("error", "Invalid numeric value"));
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
                        if !files.contains(&p) {
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
        (
            endpoint,
            values.get("proxyjump").cloned(),
            diagnostics,
            explicit,
        )
    }

    fn route(
        &mut self,
        nodes: &[Directive],
        jump: &Directive,
        target: &SshEndpoint,
        alias: &str,
        stack: &mut Vec<String>,
    ) -> Result<(Vec<SshEndpoint>, Vec<Diagnostic>), String> {
        let raw = self.tokens(
            jump.args.first().map(String::as_str).unwrap_or(""),
            alias,
            target,
        )?;
        if raw == "none" {
            return Ok((vec![], vec![]));
        }
        let mut hops = Vec::new();
        let mut diagnostics = Vec::new();
        for (index, spec) in raw.split(',').enumerate() {
            let (name, user, port) = parse_jump(spec)?;
            if stack.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                return Err(format!("ProxyJump cycle involving {name}"));
            }
            stack.push(name.clone());
            if stack.len() > MAX_JUMPS + 1 {
                return Err("ProxyJump exceeds 8 hops".into());
            }
            let (endpoint, via, mut notes, _) = self.resolve(nodes, &name, user.as_deref(), port);
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
                return Err("ProxyJump points back to the target".into());
            }
            if hops.iter().any(|h: &SshEndpoint| {
                h.host.eq_ignore_ascii_case(&endpoint.host)
                    && h.port == endpoint.port
                    && h.username == endpoint.username
            }) {
                return Err("ProxyJump repeats a hop".into());
            }
            hops.push(endpoint);
            if hops.len() > MAX_JUMPS {
                return Err("ProxyJump exceeds 8 hops".into());
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

fn parse_jump(spec: &str) -> Result<(String, Option<String>, Option<u16>), String> {
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
        let (h, suffix) = rest.split_once(']').ok_or("Invalid bracketed jump host")?;
        (
            h,
            if suffix.is_empty() {
                None
            } else {
                Some(suffix.strip_prefix(':').ok_or("Invalid jump port")?)
            },
        )
    } else if let Some((h, p)) = host.rsplit_once(':') {
        if h.contains(':') {
            return Err("IPv6 jump addresses must be bracketed".into());
        }
        (h, Some(p))
    } else {
        (host, None)
    };
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err("Invalid ProxyJump host".into());
    }
    let port = port
        .map(|p| {
            p.parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or("Invalid ProxyJump port".to_string())
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

fn decode_uri_user(value: &str) -> Result<String, String> {
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
            .ok_or("Invalid ProxyJump URI escape")?;
        let lo = chars
            .next()
            .and_then(|c| (c as char).to_digit(16))
            .ok_or("Invalid ProxyJump URI escape")?;
        let c = (hi * 16 + lo) as u8;
        if c == 0 {
            return Err("Invalid ProxyJump username".into());
        }
        bytes.push(c);
    }
    String::from_utf8(bytes).map_err(|_| "Invalid UTF-8 in ProxyJump username".into())
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
) {
    let mut active = inherited;
    for n in nodes {
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
            diagnostics.push(n.diagnostic("error", error));
            continue;
        }
        if n.option == "include" {
            let mut children = n.include.clone();
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
                                    ),
                                    Err(error) => diagnostics.push(n.diagnostic("error", error)),
                                }
                            }
                        }
                        Err(error) => diagnostics.push(n.diagnostic("error", error)),
                    }
                }
            } else {
                for included in children.drain(..) {
                    evaluate_include(
                        parser,
                        &included,
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
                    );
                }
            }
            continue;
        }
        if n.args.is_empty() {
            diagnostics.push(n.diagnostic("error", "Missing option value"));
            continue;
        }
        match n.option.as_str() {
            "identityfile" => {
                if n.args.len() != 1 || n.args[0].is_empty() {
                    diagnostics.push(n.diagnostic("error", "IdentityFile expects one path"));
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
                    diagnostics.push(n.diagnostic("error", "Expected one option value"));
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
            | "bindinterface" => diagnostics.push(n.diagnostic(
                "error",
                "This connection or authentication option cannot be converted",
            )),
            "match" => {}
            _ => diagnostics.push(n.diagnostic("warning", "This option is not imported")),
        }
    }
    // Diagnose the effective transport, not a shadowed ProxyCommand.
    if let Some(n) = values.get("proxycommand") {
        if n.args.first().is_some_and(|s| s != "none")
            && !diagnostics.iter().any(|d| d.option == "proxycommand")
        {
            diagnostics.push(n.diagnostic("error", "ProxyCommand is not supported"));
        }
    }
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
) {
    let Some(first) = nodes.first() else {
        return;
    };
    let path = PathBuf::from(&first.file);
    if stack.contains(&path) || stack.len() >= MAX_DEPTH {
        diagnostics.push(source.diagnostic("error", "Include cycle or nesting exceeds 16 files"));
        return;
    }
    aliases(nodes, &mut parser.discovered);
    stack.push(path);
    evaluate(
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
}

fn aliases(nodes: &[Directive], result: &mut BTreeSet<String>) {
    for n in nodes {
        if n.option == "host" {
            for a in &n.args {
                if !a.starts_with('!') && !a.contains(['*', '?']) {
                    result.insert(a.clone());
                }
            }
        }
        for included in &n.include {
            aliases(included, result);
        }
    }
}

pub fn preview(path: Option<String>) -> Result<ImportPreview, String> {
    let home = dirs::home_dir().ok_or("Cannot determine the user's home directory")?;
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .map_err(|_| "Cannot determine the local username")?;
    preview_with_home(path, home, username)
}

fn preview_with_home(
    path: Option<String>,
    home: PathBuf,
    username: String,
) -> Result<ImportPreview, String> {
    let mut parser = Parser {
        home,
        cwd: std::env::current_dir().map_err(|e| e.to_string())?,
        username,
        bytes: 0,
        stack: vec![],
        fatal: vec![],
        cache: HashMap::new(),
        discovered: BTreeSet::new(),
    };
    let path = parser.path(path.as_deref().unwrap_or("~/.ssh/config"), &parser.cwd)?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let nodes = parser.read(&canonical)?;
    let mut names = BTreeSet::new();
    aliases(&nodes, &mut names);
    let mut entries = Vec::new();
    let mut processed = BTreeSet::new();
    while let Some(alias) = names.pop_first() {
        if !processed.insert(alias.clone()) {
            continue;
        }
        if processed.len() > 4096 {
            return Err("SSH configuration exceeds 4096 aliases".into());
        }
        let (endpoint, jump, mut diagnostics, explicit) =
            parser.resolve(&nodes, &alias, None, None);
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
        let (home, p) = fixture("Host prod other\n HostName 192.0.2.4\n User deploy\n Port 2222\n IdentityFile ~/.ssh/deploy\nHost *\n User nobody\n Compression yes\n ServerAliveInterval 30\n");
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
        let c = &p
            .entries
            .iter()
            .find(|h| h.alias == "prod")
            .unwrap()
            .config
            .endpoint;
        for expected in [
            format!("hostname {}", c.host),
            format!("user {}", c.username),
            format!("port {}", c.port),
            format!("serveraliveinterval {}", c.keep_alive_interval),
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
        assert!(prod.identity_files.as_ref().unwrap()[0].ends_with("/first"));
        // Compare actual OpenSSH using absolute includes (ssh -G uses the real
        // user's home; the importer fixture deliberately uses a temporary one).
        let source = home.path().join(".ssh/config");
        let text = std::fs::read_to_string(&source).unwrap().replace(
            "parts/*.conf",
            &format!("{}/.ssh/parts/*.conf", home.path().display()),
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
            assert!(text.contains("user included\n"));
            assert!(text.contains("port 2200\n"));
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
        assert!(prod.config.endpoint.identity_files.as_ref().unwrap()[0].ends_with("/prod-key"));
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
}
