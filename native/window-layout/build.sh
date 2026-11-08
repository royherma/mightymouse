#!/usr/bin/env bash
# build.sh — compile WindowLayout.swift into a standalone binary.
#
# Usage:
#   cd native/window-layout && bash build.sh
#
# Output: ./window-layout  (a standalone Mach-O executable)
#
# Picked up automatically by native/build-all.sh (it loops any dir holding a
# build.sh) and shipped via electron-builder's extraResources, which copies
# native/** wholesale — no config change needed for a new helper.
#
# Runtime note: unlike the other helpers here, this one needs Accessibility
# permission. It reports `ax-untrusted` rather than failing per-op.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling WindowLayout.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AppKit \
  -framework Foundation \
  WindowLayout.swift \
  -o window-layout

echo "Build succeeded: $(pwd)/window-layout"
echo "  size: $(du -sh window-layout | cut -f1)"
