# Transfer Subsystem Design — Real Cancellation, Unified Queue Service, State-Machine Guards

Status: implemented on `feat/transfer-cancellation-architecture` (branched from
`fix/sftp-transfer-progress-throughput` @ `d84e640`, PR #168).

## Problem

Three independent defects, confirmed on 2026-09-18 after a user reported
"download → cancel kills the SSH session, then a *download timeout* appears on
the already-cancelled item":

1. **Cancellation was frontend-only.** The transfer-queue cancel button only
   dispatched a `CANCEL` reducer action. No backend command existed to stop an
   in-flight transfer; the transfer loops (`file-browser-view.tsx`,
   `integrated-file-browser.tsx`, `directory-transfer-dialog.tsx`,
   `sync-dialog.tsx`) each awaited one-shot `invoke()` calls that could not be
   aborted, so the backend kept reading the remote file to completion.
2. **The reducer had no state guards.** `FAIL` / `COMPLETE` / `PROGRESS`
   unconditionally rewrote the target item, so a late result (the 120 s
   `REQUEST_TIMEOUT_SECS` error, or even a success after a quick cancel)
   "resurrected" a cancelled item as failed or completed.
3. **Connection death surfaced as a 120 s late timeout.** When the SSH session
   was evicted or disconnected while a transfer was parked on a stalled
   request, nothing cancelled the engine — the invoke only resolved when
   russh-sftp's per-request timeout fired.

The root cause of the connection death itself (server-side close vs. rekey at
the 1 GiB boundary, see `Limits` in `ssh/mod.rs`) is **not** addressed here;
this change adds the transfer-side tracing needed to diagnose it.

## Backend Architecture

### Transfer job registry (`ConnectionManager`)

`ConnectionManager` gains a registry of in-flight transfers, keyed by
`(connection_id, transfer_id)`:

```rust
transfer_jobs: Arc<RwLock<HashMap<(String, String), CancellationToken>>>
```

- `register_transfer(connection_id, transfer_id) -> CancellationToken`
- `finish_transfer(connection_id, transfer_id)` — called on *every* outcome of
  the transfer command (success, failure, cancel) via a cleanup-after-inner-fn
  pattern so tokens can never leak.
- `cancel_transfer_by_id(transfer_id) -> bool` — scans for the (globally
  unique) transfer id, cancels and removes the token.
- `cancel_all_connection_transfers(connection_id)` — cancels and removes every
  token for a connection.

### Command protocol

`download_remote_file`, `download_remote_file_confined` and `upload_remote_file`
gain a required `transfer_id: String` parameter (invoke key `transferId`,
camelCase per Tauri convention). The frontend generates the id (the queue
item id) and passes it with the invoke; the command registers a token, runs
the transfer, and always unregisters.

New command `cancel_transfer(transfer_id)` triggers the token. All three
protocol paths (SSH-integrated, standalone SFTP, FTP) share this single
protocol — the token is honoured by the engine and the FTP loops alike.

### Engine tokenization (`sftp_transfer.rs`)

`download_file` / `upload_file` / `download_via_raw` accept a
`CancellationToken`:

- **Download:** the pipeline issues windows of ≤ 64 concurrent reads. The
  window stream await runs inside `tokio::select!` against the token; the
  handshake (`open_raw_transfer_session`, `open`, `fstat`) is also selected.
  On cancellation the in-flight window is dropped, the writer is **flushed**
  (the partial file is kept), the remote handle is closed best-effort under a
  500 ms timeout, and the engine returns `Err("Transfer cancelled")` — no new
  reads are issued and the return happens well under a second.
- **Upload:** `write_all` awaits (the network-bound part) are selected against
  the token. On cancellation the pipeline is abandoned (no flush / shutdown /
  fsync), the handle is closed best-effort, and the same error is returned.
  The remote file may be partial; that mirrors the download-side policy.

Cancellation outcome for the frontend: the invoke resolves with
`success: false, error: "Transfer cancelled"`. The reducer guards (below)
discard this result for an item the user already cancelled, and mark the item
failed if the backend cancelled it for another reason (connection death).

### Connection-death linkage

`close_connection` (the `ssh_disconnect` path), `evict_dead_connection`,
`close_sftp_connection`, `close_ftp_connection` and
`close_detached_session` all begin by calling
`cancel_all_connection_transfers`. A transfer parked on a stalled request
therefore resolves promptly when its connection dies or is closed, instead of
waiting out the 120 s request timeout.

### Lock hygiene (drive-by fixes)

- **FTP map restructure:** `ftp_connections` values become
  `Arc<tokio::sync::Mutex<FtpClient>>`. Previously the transfer commands held
  the *map-level* write lock for the entire download, blocking every other
  FTP connection's operations. Now the map lock is held only to clone the
  `Arc`, and the per-connection mutex serializes access to that connection
  (an FTP control connection is inherently serial anyway).
- **SSH read-guard release:** the SSH fallback branch used to hold the
  `SshClient` read lock across the whole transfer, blocking `disconnect()`
  for its duration. The engine only needs the russh session `Handle`, which
  is `Arc`-cloned out (`transfer_session()` accessor) and the guard dropped
  before the engine runs.

### Tracing

Each transfer command logs start and finish with
`transfer_id`, `connection_id`, protocol, direction, paths, byte counts and
elapsed time; cancellation paths log the triggering side. This is the
instrumentation for the (deferred) connection-death investigation.

## Frontend Architecture

### State-machine guards (`transfer-queue-reducer.ts`)

`PROGRESS`, `COMPLETE` and `FAIL` only apply while the item is
`status === "transferring"`; a late result for a cancelled / failed /
completed item is discarded instead of resurrecting it. `CANCEL` keeps its
current semantics (cancels anything not completed), `RETRY` is unchanged, and
`START` intentionally remains unguarded (the existing reducer test pins that
behaviour; only the service dispatches `START` and it only does so for queued
items).

`TransferItem` gains a `connectionId` field (required by the global queue,
where items from different connections interleave), and enqueue items may
carry a `confined` block for `download_remote_file_confined` (the path-safe
variant used by the dialogs).

### Unified transfer queue service (`src/lib/transfer-queue-service.ts`)

A module-level singleton store owns the **global** transfer queue and is the
*only* place that performs the "take next queued item → invoke → dispatch
result" cycle:

- `enqueue(items)` — add items, kick the pump.
- `submit(item, opts)` — enqueue one item and return
  `{ id, done: Promise<"completed" | "failed" | "cancelled">, cancel() }`;
  used by the dialogs and the editor, which keep their own sequential logic
  (mkdir ordering, deletes, cumulative byte totals) but no longer invoke the
  transfer commands themselves.
- `cancelTransfer(id)` — the CANCEL flow: best-effort
  `invoke('cancel_transfer', { transferId })` (failures ignored — a dead
  connection makes the invoke error, which is expected), then dispatch
  `CANCEL`.
- `onItemSettled(cb)` — subscription used by the browser components to
  refresh panels and raise toasts (filtered by `connectionId`).
- The pump serializes **all** transfers app-wide: one active transfer at a
  time, preserving the `getNextQueuedTransfer` semantics across the previous
  per-component queues. `RETRY` re-arms the pump; UI actions
  (`CLEAR_COMPLETED`, `CLEAR_ALL`, …) go through `dispatchAction`.
- React binding: `useTransferQueue()` (a `useSyncExternalStore` wrapper)
  returns `{ transfers, dispatch }`, drop-in for the removed local
  `useReducer` calls.

### Migrated callers

| Caller | Before | After |
| --- | --- | --- |
| `file-browser-view.tsx` | local `useReducer` + `useEffect` transfer loop | `useTransferQueue()` + settle listener (panel refresh, download toast) |
| `integrated-file-browser.tsx` | local `useReducer` + `useEffect` transfer loop (fifth copy, SSH tabs) | same migration |
| `directory-transfer-dialog.tsx` | direct per-file `invoke`, `cancelRef` flag only stopped the loop *between* files | per-file `submit()`; cancel button also cancels the in-flight item for real; `done` outcome drives the existing error/cancel phases |
| `sync-dialog.tsx` | direct `invoke` for upload/download, `cancelRef` between entries | per-entry `submit()` for transfers (mkdir/delete stay direct — they are not transfers); cancel button cancels the in-flight transfer |
| `file-editor-view.tsx` | direct `download_remote_file` with a noop channel | routed through `submit()` so the download serializes with the queue and is cancellable |

The transfer-queue strip's cancel button now calls `cancelTransfer(id)`
(backend cancel + reducer CANCEL) instead of dispatching only.

### Partial files

A cancelled download keeps the partial file on disk (the engine flushes before
returning). Resume/upload continuation is explicitly out of scope.

## Decision Records

**DR-1 — Progress stays on `invoke` + `Channel`, cancellation rides a separate
command.** Alternatives: (a) move transfers to events/WebSocket streams, (b)
emit progress via Tauri events. The invoke+Channel pipeline from PR #168 works
and streams at 10 Hz without global listeners; cancelling via a second,
idempotent command keeps the request/response model (the frontend does not
need to correlate streamed events with queue items). Channel parameters must
stay required/non-`Option` in Tauri 2 — unchanged here.

**DR-2 — The registry lives in `ConnectionManager`, not a plugin/global.**
The manager already owns connection lifecycle (`Arc<RwLock<HashMap>>`
pattern), so "cancel everything for this connection" hooks directly into the
existing close/evict paths instead of introducing a second authority that
would have to subscribe to connection death.

**DR-3 — `transfer_id` is a required command parameter generated by the
frontend.** The queue item id *is* the transfer id: no server-side id
correlation step, and `cancel_transfer` needs no connection scoping (ids are
globally unique). Existing dialog tests that assert exact invoke payloads are
updated to expect the extra key (`transferId: expect.anything()`); the
invariants they check (command choice, path layout) are unchanged.

**DR-4 — Cancellation surfaces as `success: false` + `"Transfer cancelled"`
error string.** No new response field. The reducer guards make the exact
payload irrelevant for user-visible state; keeping the response shape avoids
a breaking change for any caller that ignores it.

**DR-5 — Cancelled downloads keep the partial file.** Resuming needs offset
bookkeeping on both ends (and upload resume needs server support); deferred.
Deleting the partial file would destroy user data the user may want.

**DR-6 — FTP map values become `Arc<Mutex<FtpClient>>` instead of
take-out-and-reinsert.** Take-out-and-reinsert (the literal "clone-out"
reading) has a lost-close race: a `close_ftp_connection` arriving while the
client is checked out removes nothing, and the transfer re-inserts the client
afterwards — a zombie connection nobody can disconnect. Per-connection
`Arc<Mutex>` achieves the same map-lock relief with correct close semantics,
and matches the `Arc<RwLock<SshClient>>` per-value pattern used for SSH.

**DR-7 — SSH transfers clone the session `Handle` and drop the client read
guard before running.** The engine only needs `&Handle<Client>`; holding the
per-client read guard for minutes blocked `disconnect()`. With DR-2's linkage,
a disconnect now cancels the transfer rather than queueing behind it.

**DR-8 — Deterministic cancel test targets the download engine; upload
cancellation shares the mechanism.** The mock SFTP server gates reads so the
pipeline provably parks mid-window; the test asserts (< 1 s return, no reads
beyond the first window after cancel, byte-exact partial output). The upload
loop uses the same `select!`-on-token pattern; a mock-server upload test
would need a full `SftpSession` write path harness for marginal additional
confidence and is left as follow-up.

**DR-9 — `file-editor-view` routes through the service** (small
download-to-temp for "download & open"). It serializes with everything else
and becomes cancellable; the cost is that it briefly appears in the queue
strip, which is accurate.

**DR-10 — `integrated-file-browser.tsx` is migrated too.** The task listed
four loops, but the SSH-tab browser carries a fifth copy of the identical
loop; leaving it would break the "one active transfer globally" invariant the
service guarantees.

**DR-11 — Dialogs keep their progress UIs; the service owns the invokes.**
The dialogs' value is their aggregate UX (file/dir counts, cumulative bytes,
error logs). Rewriting them as queue views would risk their behaviour and
tests for no functional gain. `submit()` gives them service-driven transfers
(real cancellation, global serialization) while their loops reduce to
sequencing and aggregation. Non-transfer operations (mkdir, delete) stay
direct invokes — they are not part of the transfer subsystem.

**DR-12 — `START` stays unguarded.** An existing reducer test pins
"START transitions any matching item (no guard)"; the service is the only
dispatcher of `START` and only for queued items, so a guard adds nothing.

**DR-13 — Scope cut plan (if the full migration overruns).** Priority order:
backend cancellation chain + reducer guards + `file-browser-view` migration;
dialog/editor migration deferred and recorded here. Not needed in the end —
all callers migrated.

## Testing

- **Engine (deterministic, in-process):** `download_cancel_mid_transfer_*` —
  mock SFTP server (`russh_sftp::server::run` over `tokio::io::duplex`,
  spawned — `server::run` is async and silently no-ops otherwise) blocks
  reads at a gate offset; cancel mid-window must return within 1 s, leave a
  byte-exact partial file, and issue no reads past the first window. Existing
  download-engine tests pass an uncancelled token.
- **Registry:** register / finish (no leak) / cancel-by-id /
  cancel-all-for-connection / `close_connection` linkage unit tests.
- **Reducer:** new guard cases (late `FAIL`/`COMPLETE`/`PROGRESS` on
  cancelled & completed items are discarded); existing cases unchanged apart
  from the `connectionId` field.
- **Service:** lifecycle against a mocked `invoke` (enqueue → invoke with
  `transferId` → COMPLETE/FAIL dispatch → next item starts only after the
  previous settles), cancel flow calls `cancel_transfer` then dispatches
  `CANCEL`, `submit().done` resolves with the outcome.
- **Dialogs:** existing suites kept, with `transferId` added to the expected
  invoke payloads.
- **Verification gate (no CI on PRs):** `cargo test --lib` (213 baseline, new
  tests on top), `pnpm test` (825 baseline), `pnpm lint` (0 errors / 243
  warnings baseline), `npx tsc --noEmit`, `rustfmt --edition 2021` on changed
  files, `pnpm i18n:check` (no new user-visible strings expected — cancel
  reuses existing keys and backend error strings stay untranslated).

## Explicit non-goals

- Transfer resume / partial-file continuation.
- Rekey-limit changes in `ssh/mod.rs` (tracing only; the 1 GiB rekey vs.
  server-close question stays open pending the new logs).
- `Cargo.toml` dev-profile block (owner decision pending).
- Parallel transfers (the single-active-transfer invariant is deliberate and
  preserved).
