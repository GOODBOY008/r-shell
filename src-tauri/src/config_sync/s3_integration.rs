//! Opt-in test shared by the pinned MinIO fixture and disposable cloud buckets.
use super::*;
use futures::FutureExt;
use serde_json::json;
use settings::{Addressing, S3Target};
use std::{env, panic::AssertUnwindSafe};

fn runtime(stored: Stored) -> Runtime {
    Runtime {
        passphrase: stored.passphrase.clone(),
        stored,
        plan: None,
        process_lock: None,
    }
}

fn root() -> Records {
    Records::from([(model::ROOT.into(), json!({"name":"All Connections"}))])
}

fn seed(key: &[u8]) -> Records {
    let mut records = root();
    for id in ["keep", "remove"] {
        records.insert(
            format!("connections/{id}"),
            json!({
                "name":id,"host":format!("{id}.example.test"),"username":"fixture","port":22,
                "protocol":"SSH","folderId":"$root"
            }),
        );
    }
    let password = crate::commands::seal_with_key(key, "portable-password", b"").unwrap();
    records.insert(
        "credentials/connections/keep".into(),
        json!({"values":{"password":password}}),
    );
    records.insert("settings/theme".into(), json!("system"));
    records
}

// The backend has successfully written the ciphertext, but its caller never
// receives the response. All reads and writes here go to the real service.
struct LostWriteReply<'a>(&'a dyn ObjectStore);
#[async_trait::async_trait]
impl ObjectStore for LostWriteReply<'_> {
    async fn read(&self, name: &str) -> Result<Option<provider::RemoteFile>, String> {
        self.0.read(name).await
    }
    async fn write(&self, name: &str, body: String, etag: Option<&str>) -> Result<(), String> {
        self.0.write(name, body, etag).await?;
        Err("SYNC_WRITE_UNCERTAIN".into())
    }
    async fn delete(&self, name: &str) -> Result<(), String> {
        self.0.delete(name).await
    }
}

struct Device {
    runtime: Runtime,
    path: PathBuf,
    key: [u8; 32],
    records: Records,
}

impl Device {
    async fn join(
        path: PathBuf,
        key: [u8; 32],
        records: Records,
        options: &Options,
        auth: &ProviderAuth,
    ) -> Result<Self, String> {
        let mut runtime = runtime(Stored::default());
        configure(
            &mut runtime,
            &path,
            &key,
            options.clone(),
            Some(auth.clone()),
            Some(PHRASE.into()),
        )
        .await?;
        Ok(Self {
            runtime,
            path,
            key,
            records,
        })
    }

    async fn preview(&mut self, store: &dyn ObjectStore) -> Result<Preview, String> {
        prepare(&mut self.runtime, store, &self.key, self.records.clone()).await
    }

    async fn apply(
        &mut self,
        store: &dyn ObjectStore,
        preview: &Preview,
        choices: &BTreeMap<String, Choice>,
    ) -> Result<(), String> {
        let previous = self.runtime.stored.base.clone();
        let batch = commit(
            &mut self.runtime,
            store,
            &self.path,
            &self.key,
            &preview.plan_id,
            self.records.clone(),
            choices,
        )
        .await?;
        assert_eq!(read_state(&self.path, &self.key)?.base, previous);
        self.records = batch.snapshot.records;
        acknowledge(&mut self.runtime, &self.path, &self.key, batch.id)
    }
}

const PHRASE: &str = "fixture vault passphrase";

async fn exercise(
    options: Options,
    auth: ProviderAuth,
    store: &dyn ObjectStore,
    race: &str,
) -> Result<(), String> {
    let dir = tempfile::tempdir().unwrap();
    let mut desktop = Device::join(
        dir.path().join("desktop/state.enc"),
        [1; 32],
        seed(&[1; 32]),
        &options,
        &auth,
    )
    .await?;
    let mut laptop = Device::join(
        dir.path().join("laptop/state.enc"),
        [2; 32],
        root(),
        &options,
        &auth,
    )
    .await?;

    // Race after the read: exactly one conditional create and one update win.
    let (one, two) = tokio::join!(
        store.write(race, "one".into(), None),
        store.write(race, "two".into(), None)
    );
    assert!(matches!((&one, &two), (Ok(()), Err(e)) | (Err(e), Ok(())) if e == "SYNC_STALE"));
    let old = store.read(race).await?.unwrap();
    let (one, two) = tokio::join!(
        store.write(race, "three".into(), Some(&old.etag)),
        store.write(race, "four".into(), Some(&old.etag))
    );
    assert!(matches!((&one, &two), (Ok(()), Err(e)) | (Err(e), Ok(())) if e == "SYNC_STALE"));

    let first = desktop.preview(store).await?;
    let stale = laptop.preview(store).await?;
    assert!(first.first_sync && stale.first_sync);
    let no_conflicts = BTreeMap::new();
    desktop.apply(store, &first, &no_conflicts).await?;
    assert_eq!(
        laptop
            .apply(store, &stale, &no_conflicts)
            .await
            .unwrap_err(),
        "SYNC_STALE"
    );
    let join = laptop.preview(store).await?;
    assert!(join.first_sync && join.conflicts.is_empty());
    laptop.apply(store, &join, &no_conflicts).await?;
    let secret = laptop.records["credentials/connections/keep"]["values"]["password"]
        .as_str()
        .unwrap();
    assert_eq!(
        crate::commands::open_with_key(&laptop.key, secret, b"").unwrap(),
        "portable-password"
    );
    assert!(crate::commands::open_with_key(&desktop.key, secret, b"").is_err());

    desktop
        .records
        .insert("settings/theme".into(), json!("dark"));
    desktop.records.insert(
        "snippets/list".into(),
        json!({"name":"List","command":"ls","tags":[]}),
    );
    laptop.records.remove("connections/remove");
    laptop
        .records
        .insert("settings/theme".into(), json!("light"));
    let offline = laptop.preview(store).await?;
    let online = desktop.preview(store).await?;
    desktop.apply(store, &online, &no_conflicts).await?;
    assert_eq!(
        laptop
            .apply(store, &offline, &no_conflicts)
            .await
            .unwrap_err(),
        "SYNC_STALE"
    );
    let review = laptop.preview(store).await?;
    assert_eq!(review.conflicts.len(), 1);
    assert_eq!(review.conflicts[0].key, "settings/theme");
    laptop
        .apply(
            store,
            &review,
            &BTreeMap::from([("settings/theme".into(), Choice::Local)]),
        )
        .await?;
    assert_eq!(laptop.records["settings/theme"], "light");
    assert!(laptop.records.contains_key("snippets/list"));
    assert!(laptop
        .runtime
        .stored
        .base
        .as_ref()
        .unwrap()
        .tombstones
        .contains("connections/remove"));

    let pull = desktop.preview(store).await?;
    assert!(pull.conflicts.is_empty());
    desktop.apply(store, &pull, &no_conflicts).await?;
    assert!(!desktop.records.contains_key("connections/remove"));
    let before = desktop.runtime.stored.base.clone().unwrap();

    // Replace a retired identity on this same bucket, then validate a failed
    // switch to a different bucket while the proposed settings are disabled.
    let Target::S3(saved_target) = &mut desktop.runtime.stored.options.target else {
        unreachable!()
    };
    saved_target.access_key_id = "retired-identity".into();
    desktop.runtime.stored.provider_secret = "retired-secret".into();
    configure(
        &mut desktop.runtime,
        &desktop.path,
        &desktop.key,
        options.clone(),
        Some(auth),
        None,
    )
    .await?;
    assert_eq!(desktop.runtime.stored.base.as_ref(), Some(&before));
    let mut invalid = options;
    invalid.enabled = false;
    let Target::S3(new_target) = &mut invalid.target else {
        unreachable!()
    };
    new_target.bucket = "INVALID BUCKET".into();
    assert_eq!(
        configure(
            &mut desktop.runtime,
            &desktop.path,
            &desktop.key,
            invalid,
            None,
            None
        )
        .await
        .unwrap_err(),
        "SYNC_S3_BUCKET_NAME"
    );

    desktop
        .records
        .insert("settings/showConnectionHost".into(), json!(true));
    let update = desktop.preview(store).await?;
    assert_eq!(
        desktop
            .apply(&LostWriteReply(store), &update, &no_conflicts)
            .await
            .unwrap_err(),
        "SYNC_WRITE_UNCERTAIN"
    );
    desktop.runtime = runtime(read_state(&desktop.path, &desktop.key)?);
    assert_eq!(desktop.runtime.stored.base.as_ref(), Some(&before));
    let remote = store.read(FILE).await?.unwrap();
    let published = crypto::decrypt(PHRASE, &remote.body)?;
    assert_eq!(published.revision, before.revision + 1);
    assert!(
        !remote.body.contains("portable-password") && !remote.body.contains("keep.example.test")
    );
    let retry = desktop.preview(store).await?;
    assert!(retry.conflicts.is_empty());
    desktop.apply(store, &retry, &no_conflicts).await?;
    assert_eq!(desktop.runtime.stored.base.as_ref(), Some(&published));
    assert_eq!(store.read(FILE).await?.unwrap().etag, remote.etag);

    store.delete(FILE).await?;
    assert_eq!(
        desktop.preview(store).await.err().as_deref(),
        Some("SYNC_REMOTE_MISSING")
    );
    let mut next = desktop.runtime.stored.options.clone();
    let Target::S3(next_target) = &mut next.target else {
        unreachable!()
    };
    next_target.prefix.push_str("/other-vault");
    configure(
        &mut desktop.runtime,
        &desktop.path,
        &desktop.key,
        next.clone(),
        None,
        None,
    )
    .await?;
    assert!(
        desktop.runtime.stored.base.is_none() && desktop.runtime.stored.last_applied_id.is_none()
    );
    assert!(desktop.runtime.passphrase.is_none());
    configure(
        &mut desktop.runtime,
        &desktop.path,
        &desktop.key,
        next,
        None,
        Some("other phrase".into()),
    )
    .await?;
    let new_provider = desktop.runtime.stored.provider()?;
    assert!(desktop.preview(new_provider.as_ref()).await?.first_sync);
    assert!(new_provider.read(FILE).await?.is_none()); // Only the probe has written to the new prefix.
    Ok(())
}

#[tokio::test]
#[ignore = "requires a disposable S3 bucket; use scripts/test-s3-minio.sh"]
async fn two_devices_sync_through_real_s3() {
    let prefix = env::var("RSHELL_TEST_S3_PREFIX").unwrap_or_else(|_| "r-shell-tests".into());
    let target = Target::S3(S3Target {
        endpoint: env::var("RSHELL_TEST_S3_ENDPOINT").expect("S3 endpoint"),
        region: env::var("RSHELL_TEST_S3_REGION").expect("signing region"),
        bucket: env::var("RSHELL_TEST_S3_BUCKET").expect("disposable bucket"),
        prefix: format!("{}/{}", prefix.trim_matches('/'), model::random_id()),
        access_key_id: env::var("RSHELL_TEST_S3_ACCESS_KEY_ID").expect("test access key ID"),
        addressing: match env::var("RSHELL_TEST_S3_ADDRESSING").as_deref() {
            Ok("virtualHosted") => Addressing::VirtualHosted,
            Err(_) | Ok("path") => Addressing::Path,
            _ => panic!("addressing must be path or virtualHosted"),
        },
    });
    let auth = ProviderAuth {
        secret: env::var("RSHELL_TEST_S3_SECRET_ACCESS_KEY").expect("test secret key"),
        session_token: env::var("RSHELL_TEST_S3_SESSION_TOKEN").ok(),
    };
    let store = provider_for(&target, &auth.secret, auth.session_token.as_deref()).unwrap();
    let options = Options {
        target,
        enabled: true,
        credentials: true,
        remember_passphrase: true,
        paused: false,
    };
    let race = ".rshell-probe-race";
    let result = AssertUnwindSafe(exercise(options, auth, store.as_ref(), race))
        .catch_unwind()
        .await;
    let cleanup_vault = store.delete(FILE).await;
    let cleanup_race = store.delete(race).await;
    result
        .unwrap_or_else(|err| std::panic::resume_unwind(err))
        .unwrap();
    cleanup_vault.unwrap();
    cleanup_race.unwrap();
}
