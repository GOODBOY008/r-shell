#!/usr/bin/env bash
# Run the same two-device test as CI against a private, disposable MinIO.
set -euo pipefail

project_root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# MinIO RELEASE.2025-10-15T17-29-55Z. Verify the source before building it.
revision=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
archive_hash=45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841
binary=${RSHELL_TEST_MINIO_BINARY:-}
if [[ -z "$binary" ]]; then
  cache_dir=${RSHELL_TEST_MINIO_CACHE_DIR:-$scratch}
  binary="$cache_dir/minio-$revision"
  if [[ ! -x "$binary" ]]; then
    mkdir -p "$scratch/src" "$cache_dir"
    curl -fsSL --retry 3 "https://codeload.github.com/minio/minio/tar.gz/$revision" -o "$scratch/minio.tgz"
    (cd "$scratch" && printf '%s  minio.tgz\n' "$archive_hash" | shasum -a 256 -c -)
    tar xzf "$scratch/minio.tgz" -C "$scratch/src" --strip-components=1
    (cd "$scratch/src" && go build -mod=readonly -o "$scratch/minio" .)
    mv "$scratch/minio" "$binary"
  fi
fi

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
export RSHELL_TEST_S3_ENDPOINT="http://127.0.0.1:$port"
export RSHELL_TEST_S3_BUCKET=rshell-sync-test RSHELL_TEST_S3_REGION=us-east-1 RSHELL_TEST_S3_ADDRESSING=path
export RSHELL_TEST_S3_PREFIX='ci/配置 +%/sync'
export RSHELL_TEST_S3_ACCESS_KEY_ID=rshell-fixture
RSHELL_TEST_S3_SECRET_ACCESS_KEY=$(openssl rand -hex 24)
export RSHELL_TEST_S3_SECRET_ACCESS_KEY
unset RSHELL_TEST_S3_SESSION_TOKEN
MINIO_ROOT_USER="$RSHELL_TEST_S3_ACCESS_KEY_ID" MINIO_ROOT_PASSWORD="$RSHELL_TEST_S3_SECRET_ACCESS_KEY" MINIO_BROWSER=off \
  "$binary" server "$scratch/data" --address "127.0.0.1:$port" >"$scratch/server.log" 2>&1 &
pid=$!
for _ in {1..60}; do
  if curl -fsS -o /dev/null "$RSHELL_TEST_S3_ENDPOINT/minio/health/ready" 2>/dev/null; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then echo "MinIO failed to start" >&2; exit 1; fi
  sleep 1
done
curl -fsS -o /dev/null "$RSHELL_TEST_S3_ENDPOINT/minio/health/ready"
curl -fsS --aws-sigv4 aws:amz:us-east-1:s3 \
  --user "$RSHELL_TEST_S3_ACCESS_KEY_ID:$RSHELL_TEST_S3_SECRET_ACCESS_KEY" \
  -H 'x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' \
  -X PUT "$RSHELL_TEST_S3_ENDPOINT/$RSHELL_TEST_S3_BUCKET"

cargo test --manifest-path "$project_root/src-tauri/Cargo.toml" --locked --lib \
  config_sync::s3_integration::two_devices_sync_through_real_s3 -- --ignored --exact
