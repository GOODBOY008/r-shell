#!/usr/bin/env bash
# Verify the packaged app, since a linker-signed executable can still sit
# inside an unsigned bundle with an unrelated signing identifier.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash scripts/verify-macos-bundle.sh /path/to/r-shell.app" >&2
  exit 2
fi

app_path="$1"
info_plist="$app_path/Contents/Info.plist"
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")
usage_description=$(/usr/libexec/PlistBuddy -c 'Print :NSLocalNetworkUsageDescription' "$info_plist")
if [[ -z "$bundle_id" || -z "${usage_description//[[:space:]]/}" ]]; then
  echo "Bundle identifier and Local Network usage description must be nonempty." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app_path"
signature_info=$(codesign -dv --verbose=4 "$app_path" 2>&1)
signing_id=$(printf '%s\n' "$signature_info" | sed -n 's/^Identifier=//p')
if [[ "$signing_id" != "$bundle_id" ]]; then
  echo "Signing identifier '$signing_id' does not match bundle identifier '$bundle_id'." >&2
  exit 1
fi

echo "Verified macOS bundle: $app_path ($bundle_id)"
