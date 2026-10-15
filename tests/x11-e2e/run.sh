#!/usr/bin/env bash
# X11 forwarding E2E harness.
#
# Builds + starts the Dockerized sshd (X11Forwarding yes), waits for it to
# become healthy, runs ONLY the X11 e2e tests, and always tears the container
# down. Picks a free local port so concurrent fixture runs never collide
# (ports 2223/2224 belong to other local fixtures).
#
# Usage:
#   tests/x11-e2e/run.sh
#
# Env:
#   X11_E2E_PORT / RSHELL_TEST_X11_SSH_PORT — pin a specific port instead of
#   auto-picking a free one.
set -euo pipefail

# Cargo/homebrew are not always on PATH in CI or non-interactive shells.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# --- free port selection -----------------------------------------------------
if [ -z "${X11_E2E_PORT:-}" ]; then
  X11_E2E_PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
fi
export X11_E2E_PORT
export RSHELL_TEST_X11_SSH_HOST="${RSHELL_TEST_X11_SSH_HOST:-127.0.0.1}"
export RSHELL_TEST_X11_SSH_PORT="$X11_E2E_PORT"
echo "[x11-e2e] sshd port: $X11_E2E_PORT"

cleanup() {
  (cd "$ROOT/tests/x11-e2e" && docker compose down --volumes --remove-orphans >/dev/null 2>&1) || true
}
trap cleanup EXIT

# --- build + start -----------------------------------------------------------
cd "$ROOT/tests/x11-e2e"
BUILD_LOG="$(mktemp)"
if ! docker compose up -d --build >"$BUILD_LOG" 2>&1; then
  echo "[x11-e2e] docker compose up FAILED — last 80 lines of build log:"
  tail -80 "$BUILD_LOG"
  exit 1
fi

# --- wait for sshd readiness -------------------------------------------------
status="starting"
for _ in $(seq 1 45); do
  status="$(docker inspect --format='{{.State.Health.Status}}' r-shell-sshd-x11 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 2
done
if [ "$status" != "healthy" ]; then
  echo "[x11-e2e] container never became healthy (status=$status) — last 40 log lines:"
  docker logs r-shell-sshd-x11 2>&1 | tail -40
  exit 1
fi
echo "[x11-e2e] sshd healthy"

# --- run the three X11 e2e cases (plus the reconnect regression) -------------
cd "$ROOT/src-tauri"
exec cargo test --features x11-e2e -- --ignored --nocapture x11_e2e
