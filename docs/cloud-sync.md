# Cloud configuration synchronization

Open **Settings → Cloud sync** to synchronize configuration between macOS,
Windows and Linux through a WebDAV directory you control.

1. Supply an existing HTTPS directory, username and WebDAV application password.
   **Test connection** creates and deletes a randomly named temporary object and
   verifies that the server really rejects stale conditional writes.
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
saves the ordinary Settings draft before closing it, so an older settings form
cannot later overwrite incoming preferences. Other open configuration dialogs
defer synchronization. Automatic sync runs only while the application is open:
after local edits settle for 10 seconds, every five minutes, and after returning
to the app or regaining network access. Pausing automatic sync keeps manual sync
available. Changes made while offline remain local until the next successful run.

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
under its own existing R-Shell machine key. Neither that key nor the WebDAV
credentials are synchronized.

Stable record IDs, a last-applied baseline, and deletion tombstones support
three-way merges without depending on device clocks. Tombstones are retained in
v1. Creating the cloud file uses `If-None-Match: *`; subsequent writes use a
strong ETag and `If-Match`. HTTP 412 causes a refresh instead of an overwrite.
Servers without working conditional writes are rejected. Some servers briefly
return weak ETags immediately after a write; the client retries briefly and still
requires a real strong validator, never converts a weak one. See the
[HTTP conditional request specification](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)
and [Apache's validator implementation](https://github.com/apache/httpd/blob/2.4.x/modules/http/http_etag.c).

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
