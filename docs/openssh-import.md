# OpenSSH configuration import

The connection sidebar provides **Import OpenSSH configuration** separately from
R-Shell JSON backup import. Import creates editable R-Shell connections and keeps
private keys as local file references. It does not establish a live link that
automatically changes saved connections when the source file changes.

## Import and reimport

1. Open the sidebar import action. The source defaults to `~/.ssh/config`; a file
   picker and path field allow another source. New connections use the currently
   selected folder unless another destination is chosen.
2. Preview the source, search hosts, and expand rows to inspect authentication,
   the complete jump chain, compatibility diagnostics, and field differences.
   Only new hosts without diagnostics are initially selected.
3. Select hosts and review conflicts. Import writes the resulting connection
   array once and refreshes the sidebar. A target includes its resolved jump
   hosts even when the jump hosts are not selected as separate connections.

A binding consists of the canonical source path and the literal `Host` alias.
Connections sharing an IP address remain distinct. Reimport compares the last
source snapshot, the saved connection, and the new source. Source-only changes
are applied; conflicts retain the local value unless **Use source value** is
selected for that field. Ordered jump chains are compared as one field.

Updates preserve the saved ID, name, folder, notes, favorite state, ordering,
and locally stored credentials. Existing jump credentials are retained for
matching endpoints. A removed source alias never deletes a connection. Duplicating
a saved connection clears its source binding. Cancelling, a parse failure, or
corrupt connection storage leaves saved connections intact. If local connections
change while the preview is open, the dialog refreshes the comparison and asks
the user to select again before committing.

## Configuration semantics

The Rust parser reads regular configuration files and reports filename, line,
option, and reason for diagnostics. Diagnostic codes and interpolation values
are translated into the selected application language, including source-wide
and file-access errors. Preview does not start SSH, execute a shell,
read private keys, or connect to a server. The selected source and its Includes
are evaluated as a user configuration; `/etc/ssh/ssh_config` is not implicitly
merged into it.

| Configuration | Import behavior |
| --- | --- |
| `Host` | Each explicit alias becomes a candidate. Multiple aliases on one line are supported. Wildcards and negations affect matching without generating wildcard connections. |
| Ordinary options | The first applicable value wins. Missing hostname uses the alias, missing user uses the local username, and missing port uses 22. |
| `Include` | Multiple files, lexical glob order, nested includes, and conditional scope are supported. Relative paths are anchored to `~/.ssh`. Host-dependent tokens use values obtained before that Include. Cycles are rejected. |
| `IdentityFile` | Paths accumulate in declaration order. An explicit list replaces automatic default-key discovery. `none` contributes no file and suppresses default-key discovery when used alone. |
| `IdentityAgent` | Uses the default Unix socket or Windows OpenSSH named pipe when unset. Explicit sockets, environment selectors, and `none` are supported. |
| `IdentitiesOnly` | Restricts agent offers to configured/default identities. The agent may still sign for a configured public identity. |
| `ProxyJump` | Supports aliases, explicit users and ports, SSH URIs with percent-encoded usernames, bracketed IPv6, comma-separated chains, and a first hop's own route. Every hop resolves its own user and identity settings. |
| Connection options | Maps `ConnectTimeout`, `Compression`, `ServerAliveInterval`, and `ServerAliveCountMax`. An omitted timeout uses the application setting. |

Paths support `~`, named Unix users, `${VARIABLE}`, and the applicable OpenSSH
tokens. `%C` follows the delimited SHA-1 connection hash in the current OpenSSH
specification. Windows cannot expand `%i` or another account's `~username`; such
entries receive blocking diagnostics instead of a guessed path. A source with
only host-dependent Includes and no discoverable explicit aliases cannot supply
a host inventory.

`Match` prevents importing the source because its complete effect cannot be
determined. Effective `ProxyCommand`, custom host-key verification, unsupported
authentication providers, and other connection semantics that cannot be
preserved block affected hosts. Commands, agent forwarding, port forwarding,
connection multiplexing, and other ignored options produce notices and prevent
automatic selection. Host keys use R-Shell's existing verification setting and
shared OpenSSH `known_hosts` file.

Preview is bounded to 4 MiB of distinct configuration files, 16 nested files,
4,096 explicit aliases, and eight jump hosts. Included syntax trees are shared;
alias discovery visits each file once. A separate 64 MiB work budget charges
file references and parsed/evaluated directives by their structure and text size
across all aliases and routes. Exceeding that budget aborts the entire preview
with a localized source-location error; it never imports partial results.
Unsupported or invalid values are
diagnosed rather than silently converted. The reference semantics are documented
in the [OpenSSH configuration manual](https://man.openbsd.org/ssh_config).

## Authentication and connection lifecycle

`authMethod: 'auto'`, `identityFiles`, `identityAgent`, `identitiesOnly`, and
ordered `jumpHosts` are shared by saved connections, the editor, and SSH/SFTP
request builders. Existing single-key and `tunnel*` fields are adapted when the
new structures are absent; startup does not rewrite connection models in bulk.

Terminals, commands, standalone SFTP, remote editing, and additional parallel
transfer sessions use the same transport and authentication routines. Each
`direct-tcpip` link retains its upstream session. Each hop authenticates and
checks its own host key. A changed-key confirmation applies only to the named
endpoint and is cleared after the attempt.

Authentication deduplicates public identities, tries the appropriate agent
signer, and falls back to permitted local keys if the agent is unavailable or
refuses signing. Agent and file identities use the same RSA algorithm fallback,
including legacy `ssh-rsa` servers. Encrypted OpenSSH and PEM keys return a structured
`auth_required` result identifying the attempt, endpoint, key path, and reason.
The UI offers unlock, skip, and cancel. Wrong passphrases can be retried; skipping
applies only to the requested endpoint and identity.

Unlock replies remain in the current attempt/session and its associated
transfers. They never enter saved connections, source snapshots, or JSON
exports. Cancelling or superseding an attempt closes its dialog and prevents
late replies from restarting it. The native pending slot remains reserved until
cleanup finishes, including completion of native cancellation before the same
connection ID is reused. Waiting for a busy connection map does not block
cancellation or registration of other attempts. Restore budgets include target
dialing and authentication plus each hop's dialing, authentication, and tunnel
channel setup. Hop timeouts inherit from the next hop or target, including the
application setting when no target override exists. The overall startup deadline
includes all eager routes and the PTY-ready pacing between
them; preparation has a separate bounded deadline. Automatic restore and
reconnect leave a host requiring a decision pending; the explicit Connect
action opens the unlock dialog.

User-entered saved passwords and passphrases, including jump credentials, use
the existing encrypted credential store. JSON exports strip nested secrets as
well as top-level secrets.

## Validation

```sh
pnpm test
pnpm build
pnpm lint
pnpm i18n:check
cargo test --manifest-path src-tauri/Cargo.toml --lib

# Actual backend on the host, disposable OpenSSH servers, isolated local agent
bash scripts/test-ssh-import.sh

# Actual Linux backend and native Linux agent inside Docker
# Builds the frontend first if dist/ is absent: pnpm build
bash scripts/test-ssh-import.sh --linux
```

The integration script creates fixture keys and three isolated OpenSSH servers
with different users and keys. It verifies direct, single-hop, and two-hop
connections; terminal input and commands; SFTP; remote editing; parallel upload
and download; per-hop host-key refusal; encrypted keys and skipped identities;
agent identity restrictions, unavailable agents, refused signatures, and legacy
RSA algorithm fallback with private-key and public-key-only identities. Tests
use temporary known-hosts files, not personal credentials or host-key records.
Containers, networks, and fixture keys are removed on exit. The Linux runner
keeps reusable Cargo cache volumes named `rshell-import-linux-target` and
`rshell-import-linux-cargo`.

Parser tests include controlled comparisons with `ssh -G` when OpenSSH is
installed. Frontend tests cover merge conflicts, idempotence, metadata and
credential preservation, corrupt storage, edit/copy behavior, cancellation,
unattended challenges, delayed native cancellation, and concurrent attempt
isolation. Diagnostic rendering is tested in English, Simplified Chinese, and
Polish; all locales have matching keys. Browser interaction checks
use mocked Tauri IPC; they do not replace native platform acceptance.

Before release, verify the packaged Windows application with the Windows
OpenSSH Agent service: configured public-only identities, `IdentitiesOnly`,
unavailable service and file fallback, encrypted-key cancellation, and concurrent
connections. A Unix-socket test or cross-compilation does not establish named-pipe
runtime behavior. Live file-backed connection groups remain a separate feature.
