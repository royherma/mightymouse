#!/usr/bin/env bash
# build-all.sh — compile every native Swift helper in one shot.
#
# Each helper has its own build.sh (swiftc → standalone arm64 binary). This loops
# them so a fresh checkout / after-edit rebuild is one command instead of cd-ing
# into each dir. The compiled binaries are committed and shipped via electron-
# builder's extraResources (native/**), so run this after editing any *.swift.
#
# Usage:  bash native/build-all.sh
#
# Packaging note: binaries must be code-signed + notarized before shipping, AND
# the app must hold Accessibility permission for mm-input's posted events to land.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for dir in "$SCRIPT_DIR"/*/; do
  if [[ -f "$dir/build.sh" ]]; then
    echo "── Building $(basename "$dir") ──"
    bash "$dir/build.sh"
    echo
  fi
done

echo "All native helpers built."
