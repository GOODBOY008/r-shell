#!/usr/bin/env bash
# Disposable OpenSSH fixtures. No user keys, agents or known_hosts are touched.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/rshell-ssh-import.XXXXXX")"
fixture_name="rshell-import-$$"
cleanup() {
  docker rm -f "$fixture_name-one" "$fixture_name-two" "$fixture_name-target" "$fixture_name-runner" >/dev/null 2>&1 || true
  docker network rm "$fixture_name" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
if [ "${1:-}" = --linux ]; then
  docker build -q -t rshell-ssh-import-runner -f "$project_root/src-tauri/docker/ssh-import/Dockerfile.runner" "$project_root/src-tauri/docker/ssh-import"
fi
for identity in jumpone jumptwo target; do
  ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/$identity"
done
ssh-keygen -q -t ed25519 -N 'fixture-passphrase' -f "$fixture_dir/target-locked"
ssh-keygen -q -t rsa -b 2048 -N '' -f "$fixture_dir/legacyrsa"
docker build -q -t rshell-ssh-import-test "$project_root/src-tauri/docker/ssh-import"
docker network create "$fixture_name" >/dev/null
for endpoint in one two target; do
  docker run -d --name "$fixture_name-$endpoint" --network "$fixture_name" --network-alias "$endpoint" -p 127.0.0.1::22 -v "$fixture_dir:/keys:ro" rshell-ssh-import-test >/dev/null
done
export RSHELL_IMPORT_KEYS="$fixture_dir"
export RSHELL_UPLOAD_STREAMS=2 RSHELL_DOWNLOAD_STREAMS=2
export RSHELL_IMPORT_ONE_PORT="$(docker port "$fixture_name-one" 22/tcp | awk -F: '{print $NF}')"
export RSHELL_IMPORT_TWO_PORT="$(docker port "$fixture_name-two" 22/tcp | awk -F: '{print $NF}')"
export RSHELL_IMPORT_TARGET_PORT="$(docker port "$fixture_name-target" 22/tcp | awk -F: '{print $NF}')"
for endpoint in one two target; do
  for attempt in {1..50}; do
    if docker logs "$fixture_name-$endpoint" 2>&1 | grep -q 'Server listening'; then break; fi
    sleep 0.1
  done
done
if [ "${1:-}" = --linux ]; then
  # Compile and run the actual application backend and a native Linux agent.
  # Separate Cargo volumes keep Linux artifacts out of the host target tree.
  docker run --rm --name "$fixture_name-runner" --network "$fixture_name" \
    -v "$project_root:/source:ro" -v "$fixture_dir:/keys:ro" \
    -v rshell-import-linux-target:/target -v rshell-import-linux-cargo:/usr/local/cargo/registry \
    -e CARGO_TARGET_DIR=/target -e CARGO_BUILD_JOBS=4 \
    -e RSHELL_IMPORT_KEYS=/keys -e RSHELL_IMPORT_ONE_HOST=one -e RSHELL_IMPORT_TARGET_HOST=target \
    -e RSHELL_IMPORT_ONE_PORT=22 -e RSHELL_IMPORT_TWO_PORT=22 -e RSHELL_IMPORT_TARGET_PORT=22 \
    -e RSHELL_UPLOAD_STREAMS=2 -e RSHELL_DOWNLOAD_STREAMS=2 \
    rshell-ssh-import-runner bash -c \
    'tar -C /source --exclude=target -cf - src-tauri package.json dist | tar -C /work -xf -
     cd /work/src-tauri
     cargo test --lib ssh_import_e2e -- --ignored --test-threads=1'
else
  cd "$project_root/src-tauri"
  cargo test --lib ssh_import_e2e -- --ignored --test-threads=1
fi
