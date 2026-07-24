# X11 Forwarding E2E Test Harness

A Dockerized SSH server for end-to-end testing of R-Shell's SSH X11 forwarding
feature. Runs locally via Docker (OrbStack, Docker Desktop, etc.).

## What it tests

The two `#[ignore]`d Rust integration tests in
`src-tauri/src/ssh/tests.rs` (module `x11_e2e_tests`) exercise the real X11
forwarding path against a live sshd:

| Test | What it proves |
|------|----------------|
| `x11_forwarding_sets_remote_display` | With X11 enabled, `create_pty_session` succeeds (sshd accepted `request_x11`) **and** sshd set the remote `$DISPLAY` to a forwarded value (`*:10.0`). |
| `x11_disabled_leaves_display_empty` | With X11 disabled, `$DISPLAY` is empty — the negative control that makes the positive test meaningful. |

These cover the core handshake: SSH connect → `request_x11` accepted →
sshd assigns `DISPLAY`. They do **not** require a graphical X server or XQuartz
on the host — they validate the protocol-level forwarding establishment.

## Prerequisites

- Docker (OrbStack / Docker Desktop / colima) running locally.

## Run

```bash
# 1. Start the X11-enabled sshd (builds the image, binds 127.0.0.1:2222 -> 22)
docker compose -f tests/x11-e2e/docker-compose.yml up -d --build

# 2. Wait until healthy
docker inspect --format='{{.State.Health.Status}}' r-shell-sshd-x11
# -> healthy

# 3. Run the E2E tests (feature flag enables them; --ignored runs #[ignore]d tests)
cd src-tauri
cargo test --features x11-e2e -- --ignored --nocapture x11_e2e

# 4. Tear down when done
docker compose -f tests/x11-e2e/docker-compose.yml down
```

## Credentials & config

The container's sshd is configured (see `Dockerfile`):

- User `testuser` / password `testpass` (matches `ssh/tests.rs`).
- `X11Forwarding yes`, `X11DisplayOffset 10`, `X11UseLocalhost no`.
- `xauth` and `x11-apps` installed (required server-side for X11 auth setup).
- Password authentication enabled.
- Host keys generated on image build; the client auto-accepts them in tests
  (`check_server_key` returns `Ok(true)` — test-only).

Bound to `127.0.0.1:2222` so the server is reachable from the host test runner
but not exposed to the network.

## Why `#[ignore]` + a feature flag

The tests need a live SSH server, which CI doesn't provide. The `x11-e2e` Cargo
feature gates compilation so a default `cargo test` never even builds them, and
`#[ignore]` ensures they only run on explicit request. This matches the existing
convention for the other live-server tests in `ssh/tests.rs`.
