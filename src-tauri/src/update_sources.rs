//! Check both release catalogs independently; keep the chosen artifact and signature pinned across downloads.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::time::Duration;
use tauri::Url;
use tauri_plugin_updater::{Update, UpdaterBuilder};
use tokio::time::timeout;

const CONNECT: Duration = Duration::from_secs(8);
const READ_IDLE: Duration = Duration::from_secs(30);

fn validate_signature(encoded: &str) -> Result<(), String> {
    let bytes = BASE64.decode(encoded.trim()).map_err(|e| e.to_string())?;
    let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    minisign_verify::Signature::decode(text).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Channel {
    Stable,
    Current,
}
impl Channel {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "stable" => Ok(Self::Stable),
            "current" => Ok(Self::Current),
            _ => Err(format!("Unknown update channel: {value}")),
        }
    }
    fn accepts(self, version: &str) -> bool {
        match self {
            Self::Stable => !version.contains(['-', '+']),
            Self::Current => version.split_once("-current.").is_some_and(|(base, n)| {
                !base.contains('-') && !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())
            }),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Github,
    Cloudflare,
}
impl Source {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Github => "GitHub",
            Self::Cloudflare => "Cloudflare",
        }
    }
    fn other(self) -> Self {
        match self {
            Self::Github => Self::Cloudflare,
            Self::Cloudflare => Self::Github,
        }
    }
}

pub(crate) struct Sources {
    github: Url,
    mirror: Url,
    check_timeout: Duration,
    read_idle: Duration,
}
impl Sources {
    pub(crate) fn official() -> Self {
        Self {
            check_timeout: CONNECT,
            read_idle: READ_IDLE,
            github: Url::parse("https://github.com/GOODBOY008/r-shell/releases/").unwrap(),
            mirror: Url::parse(include_str!("../../website/origin.txt").trim()).unwrap(),
        }
    }
    fn manifest(&self, source: Source, channel: Channel) -> Url {
        match (source, channel) {
            (Source::Github, Channel::Stable) => self.github.join("latest/download/latest.json"),
            (Source::Github, Channel::Current) => self.github.join("download/current/current.json"),
            (Source::Cloudflare, Channel::Stable) => self.mirror.join("updates/latest.json"),
            (Source::Cloudflare, Channel::Current) => self.mirror.join("updates/current.json"),
        }
        .expect("static relative path")
    }
    fn package(&self, source: Source, version: &str, name: &str) -> Url {
        match source {
            Source::Github => self.github.join(&format!("download/v{version}/{name}")),
            Source::Cloudflare => self.mirror.join(&format!("releases/v{version}/{name}")),
        }
        .expect("version and filename are path segments")
    }
    fn select(
        &self,
        update: Update,
        source: Source,
        channel: Channel,
    ) -> Result<SelectedUpdate, String> {
        let name = update
            .download_url
            .path_segments()
            .and_then(|mut p| p.next_back())
            .unwrap_or("");
        if !channel.accepts(&update.version)
            || !name.starts_with("r-shell")
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || self.package(source, &update.version, name) != update.download_url
        {
            return Err("Invalid update channel or versioned asset URL".into());
        }
        validate_signature(&update.signature)?;
        let alternate = self.package(source.other(), &update.version, name);
        Ok(SelectedUpdate {
            update,
            alternate,
            source,
        })
    }

    pub(crate) async fn refresh(
        &self,
        slot: &mut Option<SelectedUpdate>,
        channel: Channel,
        builder: impl FnMut() -> UpdaterBuilder,
        on_switch: impl Fn(Source),
    ) -> Result<(), String> {
        // Keep an already announced update across a transient check failure
        // only while the user stays on the channel that supplied it.
        if slot
            .as_ref()
            .is_some_and(|s| !channel.accepts(&s.update.version))
        {
            *slot = None;
        }
        *slot = self.check(channel, builder, on_switch).await?;
        Ok(())
    }

    async fn check(
        &self,
        channel: Channel,
        mut builder: impl FnMut() -> UpdaterBuilder,
        on_switch: impl Fn(Source),
    ) -> Result<Option<SelectedUpdate>, String> {
        let mut errors = Vec::new();
        for source in [Source::Github, Source::Cloudflare] {
            if source == Source::Cloudflare {
                on_switch(source);
            }
            let idle = self.read_idle;
            let attempt = async {
                // Inspect channel, target and immutable URL even when the advertised
                // version is old. Only a valid manifest may suppress fallback.
                let updater = builder()
                    .version_comparator(|_, _| true)
                    .endpoints(vec![self.manifest(source, channel)])
                    .map_err(|e| e.to_string())?
                    .configure_client(move |client| {
                        client.connect_timeout(CONNECT).read_timeout(idle)
                    })
                    .build()
                    .map_err(|e| e.to_string())?;
                let result = updater.check().await.map_err(|e| e.to_string())?;
                let Some(update) = result else {
                    return Ok(None);
                }; // HTTP 204
                let newer = semver::Version::parse(&update.version).map_err(|e| e.to_string())?
                    > semver::Version::parse(&update.current_version).map_err(|e| e.to_string())?;
                let candidate = self.select(update, source, channel)?;
                Ok::<_, String>(newer.then_some(candidate))
            };
            match timeout(self.check_timeout, attempt).await {
                Ok(Ok(result)) => return Ok(result),
                Ok(Err(e)) => errors.push(format!("{}: {e}", source.label())),
                Err(_) => errors.push(format!("{}: check timed out", source.label())),
            }
        }
        Err(errors.join(" | "))
    }
}

pub(crate) struct SelectedUpdate {
    pub(crate) update: Update,
    alternate: Url,
    pub(crate) source: Source,
}
impl SelectedUpdate {
    /// The installer is a one-shot operation. A local installation error never
    /// turns into another download/install attempt.
    pub(crate) async fn apply(
        &self,
        progress: impl FnMut(u64, Option<u64>),
        switched: impl Fn(Source),
        install: impl FnOnce(&Update, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let bytes = self.download(progress, switched).await?;
        install(&self.update, &bytes)
    }

    pub(crate) async fn download(
        &self,
        mut progress: impl FnMut(u64, Option<u64>),
        on_switch: impl Fn(Source),
    ) -> Result<Vec<u8>, String> {
        let mut candidate = self.update.clone();
        let mut errors = Vec::new();
        for source in [self.source, self.source.other()] {
            if source != self.source {
                // Change transport only. Tauri verifies both attempts with the original
                // public key, version and platform signature before returning any bytes.
                candidate.download_url = self.alternate.clone();
                on_switch(source);
            }
            let mut received = 0;
            match candidate
                .download(
                    |count, total| {
                        received += count as u64;
                        progress(received, total)
                    },
                    || {},
                )
                .await
            {
                Ok(bytes) => return Ok(bytes),
                Err(e) => errors.push(format!("{}: {e}", source.label())),
            }
        }
        Err(errors.join(" | "))
    }
}

#[cfg(all(test, unix))]
mod tests;

#[cfg(test)]
mod manifest_tests {
    use super::*;

    #[test]
    fn parses_the_minisign_envelope_before_pinning_an_artifact() {
        let signature = include_str!("update_sources/test-package.sig");
        assert!(validate_signature(signature).is_ok());
        for invalid in ["", "invalid!", "YWJj", &BASE64.encode([0xff])] {
            assert!(validate_signature(invalid).is_err());
        }
    }

    #[test]
    fn channels_have_distinct_pointers_and_immutable_download_urls() {
        let sources = Sources::official();
        for (channel, version, alias) in [
            (Channel::Stable, "3.4.1", "latest"),
            (Channel::Current, "3.0.0-current.1", "current"),
        ] {
            assert!(channel.accepts(version));
            assert_ne!(
                Channel::Stable.accepts(version),
                Channel::Current.accepts(version)
            );
            assert_eq!(
                sources.manifest(Source::Cloudflare, channel).path(),
                format!("/updates/{alias}.json")
            );
            for source in [Source::Github, Source::Cloudflare] {
                let url = sources.package(source, version, "r-shell_x64-setup.exe");
                assert!(url
                    .path()
                    .ends_with(&format!("/v{version}/r-shell_x64-setup.exe")));
            }
        }
    }
}
