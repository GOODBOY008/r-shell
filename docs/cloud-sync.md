# Cloud configuration synchronization

Open **Settings → Cloud sync** to synchronize configuration between macOS,
Windows and Linux. Choose one storage provider per device and point each
device at the same directory or bucket and object prefix.

1. For **WebDAV**, enter an existing HTTPS directory, username and application
   password. For **S3-compatible storage**, enter the HTTPS service endpoint,
   signing region, existing bucket, optional object prefix and access keys.
   Temporary credentials also require their session token. **Test connection**
   uses a random temporary object at the selected location. It checks that
   conditional creation and updates work and that stale writes are rejected,
   then deletes the probe.
2. Set a separate encryption passphrase for a new space, or enter the existing
   passphrase when joining another device. Use a strong passphrase and keep a
   recovery copy yourself: the storage provider cannot recover it.
3. Choose whether to remember the passphrase locally and whether to include
   saved connection credentials. Credentials are **off by default**. The local
   Security setting that disables password saving also blocks credential sync.
4. Save sync settings, then use **Save settings and sync now** to review the
   first merge. Each conflict offers the local and cloud versions. Folder and
   reference conflicts can require choosing a consistent group of related
   definitions, rather than leaving dangling connections or monitor targets.

Cloud settings have their own explicit Save button. The sync/review action
saves the active storage draft and ordinary settings before opening the preview.
Other open configuration dialogs
defer synchronization. Automatic sync runs only while the application is open:
after local edits settle for 10 seconds, every five minutes, and after returning
to the app or regaining network access. Pausing automatic sync keeps manual sync
available. Changes made while offline remain local until the next successful run.

## S3 setup

Use an HTTPS endpoint with a hostname and optional port. Path addressing puts
the bucket in the request path. Virtual hosted addressing prepends the bucket
to the hostname and requires matching DNS and TLS certificates. A prefix of
`r-shell` stores the vault at `r-shell/r-shell-sync-v1.enc`. An empty prefix
stores it at the bucket root.

| Service | Endpoint and region | Verification |
| --- | --- | --- |
| MinIO | Your service endpoint and configured region, typically `us-east-1`. Use path addressing with a single service hostname. | Two-device integration test using a pinned server build. |
| Amazon S3 general purpose bucket | Regional S3 endpoint, e.g. `https://s3.us-east-1.amazonaws.com` and `us-east-1`. | Opt-in test against your disposable bucket. [Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) |
| Cloudflare R2 | Account S3 endpoint, e.g. `https://<account-id>.r2.cloudflarestorage.com`, region `auto` and path addressing. | Opt-in test against your disposable bucket. [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) |

The access key needs object read/write access to the vault and read/write/delete
access to `.rshell-probe-*` under its prefix. On Amazon S3, reading a missing
object can return `403` without `s3:ListBucket`. If the first sync reports an
access error, check the bucket permissions. Only an explicit `NoSuchKey`
response identifies an empty location. [AWS GetObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)

Each device stores its service credentials encrypted with its own machine key.
To rotate S3 credentials, enter the new access key ID and secret, plus the new
session token if applicable. Entering a new secret with an empty token clears
the previous token. Rotation on the same target preserves the sync baseline.
Existing WebDAV installations retain their settings, passphrase and sync
history on upgrade. Switching providers, buckets or prefixes starts a new
first-merge review after recovering any interrupted local apply.

## Included configuration

- Connections, folders, connection profiles, tags, notes, favorites and ordering.
- Command snippets, application preferences, portable shortcuts, language,
  terminal/editor appearance and background images (existing 5 MiB image limit).
- Monitor definitions, per-connection monitor overrides, dashboard sources,
  widgets, notes and responsive layouts. New or changed commands/targets remain
  disabled or paused on the receiving device until enabled there. Enabled/paused
  execution state and collected history remain local.
- Optionally, saved passwords and passphrases, including jump-host credentials.
  Disabling this option stops credential transfers on this device; it does not
  erase credentials previously uploaded by another device.

Private keys and their paths, SSH Agent paths, SSH config provenance, host trust,
OS autostart, update settings, security switches, active sessions and runtime
statistics stay local. Explicit key-file requirements travel without the paths;
select a local key in the connection editor before using that connection on a new
device. `Mod` shortcuts retain their platform meaning (Command on macOS,
Control on Windows/Linux). Reserved or conflicting bindings require review.

## Storage and recovery

The remote `r-shell-sync-v1.enc` file contains a versioned full snapshot encrypted
and authenticated using Argon2id (64 MiB, three passes, one lane) and AES-256-GCM
with fresh salt/nonce and a sync-specific authentication context. Host addresses,
commands and notes are encrypted too. Every device re-seals downloaded secrets
under its own existing R-Shell machine key. Storage credentials stay on the
device alongside the machine-key-encrypted sync state.

Stable record IDs, a last-applied baseline, and deletion tombstones support
three-way merges without depending on device clocks. Tombstones are retained in
v1. Creating the cloud file uses `If-None-Match: *`; subsequent writes use a
strong ETag and `If-Match`. HTTP 412 causes a refresh instead of an overwrite.
Servers without working conditional writes are rejected. Some servers briefly
return weak ETags immediately after a write; the client retries briefly and still
requires a real strong validator, never converts a weak one. See the
[HTTP conditional request specification](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)
and [Apache's validator implementation](https://github.com/apache/httpd/blob/2.4.x/modules/http/http_etag.c).

S3 requests use AWS Signature Version 4. A conflicting conditional write
invalidates the preview. If the upload response is lost, the next sync reads
the remote revision again before applying changes or advancing local history.

The application-data directory's `config-sync/` contains machine-key-encrypted
state, the latest pre-apply backup, and an interrupted-apply journal when needed.
A process lock prevents two running copies from overwriting this state. The
sync baseline advances only after the complete local write set has been applied.
Before rendering the app, interrupted transactions roll back if unacknowledged,
or finish applying an acknowledged update. Recovery never needs the cloud
connection or the sync passphrase, but does need the local machine key.

An unreadable local store, unsupported schema, wrong passphrase, missing
previously linked cloud file or unexpected rollback stops synchronization. It
does not replace local data with defaults or silently recreate the remote file.
The existing manual import/export feature continues to work independently.

## Verification

```sh
pnpm exec vitest run src/lib/__tests__/config-sync-storage.test.ts src/lib/__tests__/config-sync-controller.test.ts
cd src-tauri
cargo test --lib config_sync
cargo test --lib acl_tests
```

To exercise a real WebDAV service, point the opt-in integration test at a
**disposable directory**. It creates and removes uniquely named test objects:

```sh
RSHELL_TEST_WEBDAV_URL=https://example.test/dav/disposable/ \
RSHELL_TEST_WEBDAV_USER=test-user \
RSHELL_TEST_WEBDAV_PASSWORD=test-application-password \
cargo test --lib config_sync::provider::tests::real_webdav_server -- --ignored
```

Only test builds allow plain HTTP to `127.0.0.1` for an isolated local fixture;
production requires HTTPS and verifies certificates. Backend commands are
restricted to the main-window capability, never file-viewer popups.

Run `bash scripts/test-s3-minio.sh` from the repository root for the same
MinIO test as Linux CI. It builds a checksum-pinned MinIO release with Go,
starts it on loopback, creates a temporary bucket and cleans up on exit.
Set `RSHELL_TEST_MINIO_BINARY` to use an existing copy of the pinned binary.

To run the same test on **AWS S3 or Cloudflare R2**, configure
`RSHELL_TEST_S3_ENDPOINT`, `RSHELL_TEST_S3_REGION`, `RSHELL_TEST_S3_BUCKET`,
`RSHELL_TEST_S3_ACCESS_KEY_ID` and `RSHELL_TEST_S3_SECRET_ACCESS_KEY` in the
environment. Optional variables are `RSHELL_TEST_S3_PREFIX`,
`RSHELL_TEST_S3_SESSION_TOKEN` and `RSHELL_TEST_S3_ADDRESSING` (`path` or
`virtualHosted`). Use a dedicated test bucket with delete permission for the
test prefix. Each run creates its own randomly named subdirectory.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib \
  config_sync::s3_integration::two_devices_sync_through_real_s3 -- --ignored --exact
```
