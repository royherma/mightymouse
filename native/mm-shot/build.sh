#!/usr/bin/env bash
# build.sh — compile MmShot.swift into a standalone binary.
#
# Shipping helper: picked up automatically by native/build-all.sh (which globs
# any dir containing a build.sh) and shipped via electron-builder extraResources.
# Run after editing MmShot.swift.
#
# Usage:  cd native/mm-shot && bash build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling MmShot.swift..."
swiftc \
  -O \
  -target arm64-apple-macos14 \
  -framework ScreenCaptureKit \
  -framework CoreGraphics \
  -framework ImageIO \
  -framework UniformTypeIdentifiers \
  -framework Foundation \
  MmShot.swift \
  -o mm-shot

echo "Build succeeded: $(pwd)/mm-shot"
