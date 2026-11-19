use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub enabled: bool,
    pub paused: bool,
    pub target: Target,
    pub credentials: bool,
    pub remember_passphrase: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            enabled: false,
            paused: false,
            target: Target::default(),
            credentials: false,
            remember_passphrase: true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Target {
    WebDav { url: String, username: String },
    S3(S3Target),
}

impl Default for Target {
    fn default() -> Self {
        Self::WebDav {
            url: String::new(),
            username: String::new(),
        }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Addressing {
    Path,
    VirtualHosted,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct S3Target {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub addressing: Addressing,
    pub access_key_id: String,
}

impl Target {
    /// No storage location was entered yet.
    pub fn is_blank(&self) -> bool {
        match self {
            Self::WebDav { url, .. } => url.is_empty(),
            Self::S3(target) => target.endpoint.is_empty(),
        }
    }

    // WebDAV servers can give each user their own directory at the same URL.
    // An S3 key rotation, however, can still address the very same object.
    pub fn same_vault(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::WebDav {
                    url: a,
                    username: u,
                },
                Self::WebDav {
                    url: b,
                    username: v,
                },
            ) => a == b && u == v,
            (Self::S3(a), Self::S3(b)) => {
                a.endpoint.trim_end_matches('/') == b.endpoint.trim_end_matches('/')
                    && a.region == b.region
                    && a.bucket == b.bucket
                    && a.prefix.trim_matches('/') == b.prefix.trim_matches('/')
                    && a.addressing == b.addressing
            }
            _ => false,
        }
    }

    pub fn same_credential_scope(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::S3(a), Self::S3(b)) => {
                a.endpoint.trim_end_matches('/') == b.endpoint.trim_end_matches('/')
                    && a.access_key_id == b.access_key_id
                    && a.addressing == b.addressing
                    && (a.addressing == Addressing::Path || a.bucket == b.bucket)
            }
            _ => self.same_vault(other),
        }
    }
}

// The legacy representation is accepted only when reading encrypted disk state.
// IPC always uses a tagged target. An unknown provider must not become WebDAV.
pub fn read_stored_options<'de, D: Deserializer<'de>>(d: D) -> Result<Options, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Legacy {
        enabled: bool,
        paused: bool,
        url: String,
        username: String,
        credentials: bool,
        remember_passphrase: bool,
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Format {
        Current(Options),
        Legacy(Legacy),
    }
    Ok(match Format::deserialize(d)? {
        Format::Current(options) => options,
        Format::Legacy(old) => Options {
            enabled: old.enabled,
            paused: old.paused,
            target: Target::WebDav {
                url: old.url,
                username: old.username,
            },
            credentials: old.credentials,
            remember_passphrase: old.remember_passphrase,
        },
    })
}
