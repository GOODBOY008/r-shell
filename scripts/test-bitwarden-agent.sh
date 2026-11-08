#!/usr/bin/env bash
# Interactive test against the official Bitwarden desktop application's agent.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
scenario="${1:-ssh}"
case "$scenario" in
  ssh|auto|sftp|reject|cancel) ;;
  *) echo "Usage: $0 [ssh|auto|sftp|reject|cancel]" >&2; exit 2 ;;
esac
: "${RSHELL_BITWARDEN_AGENT_SOCKET:?Set the disposable Bitwarden desktop agent socket}"
if [ ! -S "$RSHELL_BITWARDEN_AGENT_SOCKET" ]; then
  echo "Bitwarden agent socket is not listening: $RSHELL_BITWARDEN_AGENT_SOCKET" >&2
  exit 1
fi
RSHELL_BITWARDEN_SCENARIO="$scenario" cargo test --locked \
  --manifest-path "$project_root/src-tauri/Cargo.toml" --lib \
  bitwarden_desktop_live_agent -- --ignored --nocapture --test-threads=1
