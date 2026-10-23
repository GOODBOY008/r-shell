#!/usr/bin/env bash
# Runs the ignored docker-fixture e2e suite (src-tauri/src/ssh/tests.rs and
# friends) from a clean checkout: builds the fixture images if missing,
# (re)starts the containers on their canonical ports (loopback only), exports
# the endpoint env vars the tests read, and runs cargo with the ignored tests
# enabled.
#
# The cargo process runs with HOME pointed at a throwaway directory: the SSH
# client's strict host-key policy shares ~/.ssh/known_hosts with the user's
# OpenSSH (dirs::home_dir honors $HOME), and every rebuilt fixture container
# presents a fresh host key — without isolation a run both pollutes the real
# file with fixture keys and misreads stale ones as HOST KEY CHANGED. CARGO_
# HOME / RUSTUP_HOME are pinned to the real home so the build cache and
# toolchain are unaffected.
#
# Requires docker and python3 (for the latency-relay test). CI never runs
# this — it is the local/e2e gate behind `pnpm test:e2e`.
set -euo pipefail

ORIG_HOME=$HOME
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DOCKER_DIR="$ROOT/src-tauri/docker"

# Fixture ports as published on the loopback interface. The tests' own
# defaults differ for two of them (bare cargo runs default to 22 / 2222 —
# see tests.rs), so these env overrides are what make the mapping canonical.
PASSWORD_PORT=2225    # rshell-password-sshd   (RSHELL_TEST_SSH_PORT)
EMPTY_PASS_PORT=2223  # rshell-empty-pass-sshd (RSHELL_EMPTY_PASS_PORT)
DEFAULT_KEY_PORT=2224 # rshell-default-key-sshd (RSHELL_DEFAULT_KEY_PORT)
REKEY_PORT=2298       # default-key image + RekeyLimit=32M (RSHELL_REKEY_SERVER_PORT)

build_if_missing() {
  local tag=$1 dir=$2
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    echo "==> building $tag"
    docker build -t "$tag" "$dir"
  fi
}

# Remove a canonical fixture container, then fail loudly if anything else is
# still publishing one of our ports — a stale squatter under a different name
# would otherwise die inside `docker run` with a bare "port already allocated".
restart() {
  local name=$1 port=$2 image=$3
  shift 3 # extra args: command override for the container
  docker rm -f "$name" >/dev/null 2>&1 || true
  local squatter
  squatter=$(docker ps --filter "publish=$port" --format '{{.Names}}')
  if [ -n "$squatter" ]; then
    echo "error: port $port is already published by: $squatter" >&2
    echo "       stop it or change the port mapping at the top of $0" >&2
    exit 1
  fi
  docker run -d --name "$name" -p "127.0.0.1:$port:22" "$image" "$@" >/dev/null
}

build_if_missing rshell-password-sshd:latest    "$DOCKER_DIR/password-sshd"
build_if_missing rshell-empty-pass-sshd:latest  "$DOCKER_DIR/empty-password-sshd"
build_if_missing rshell-default-key-sshd:latest "$DOCKER_DIR/default-key-sshd"

restart rshell-sshd-password     "$PASSWORD_PORT"    rshell-password-sshd:latest
restart rshell-sshd-empty        "$EMPTY_PASS_PORT"  rshell-empty-pass-sshd:latest
restart rshell-sshd-default-key  "$DEFAULT_KEY_PORT" rshell-default-key-sshd:latest
# Server-initiated-rekey variant: same image, tiny RekeyLimit so a 256 MB
# upload crosses several server-initiated KEXINITs (see the test's doc
# comment in src/ssh/tests.rs).
restart rshell-sshd-rekey-test   "$REKEY_PORT" rshell-default-key-sshd:latest \
  /usr/sbin/sshd -D -e -o RekeyLimit=32M -o LogLevel=VERBOSE

# docker exec only proves the container is up, not that sshd has bound :22 —
# probe the published port instead so the first test cannot race sshd startup.
for port in "$PASSWORD_PORT" "$EMPTY_PASS_PORT" "$DEFAULT_KEY_PORT" "$REKEY_PORT"; do
  for _ in $(seq 1 30); do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then break; fi
    sleep 0.5
  done
  if ! nc -z 127.0.0.1 "$port" 2>/dev/null; then
    echo "fixture on port $port never became ready" >&2
    exit 1
  fi
done

# The relay test manages its own bench container (127.0.0.1:12224) and the
# latency relay process (12324); nothing to prepare for it here.

E2E_HOME=$(mktemp -d "${TMPDIR:-/tmp}/rshell-e2e-home.XXXXXX")
export HOME=$E2E_HOME
export CARGO_HOME=${CARGO_HOME:-$ORIG_HOME/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$ORIG_HOME/.rustup}
export RSHELL_TEST_SSH_HOST=127.0.0.1
export RSHELL_TEST_SSH_PORT=$PASSWORD_PORT
# The tunnel target is the in-container port as seen from the jump host.
export RSHELL_TEST_TARGET_PORT=22
export RSHELL_EMPTY_PASS_HOST=127.0.0.1
export RSHELL_EMPTY_PASS_PORT=$EMPTY_PASS_PORT
export RSHELL_DEFAULT_KEY_HOST=127.0.0.1
export RSHELL_DEFAULT_KEY_PORT=$DEFAULT_KEY_PORT
export RSHELL_REKEY_SERVER_PORT=$REKEY_PORT

cd src-tauri
exec cargo test --lib -- --ignored --test-threads=1 docker_ empty_password
