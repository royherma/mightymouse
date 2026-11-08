#!/usr/bin/env bash
# build.sh — compile ActivateApp.swift into a standalone binary.
#
# Usage:
#   cd native/activate-app && bash build.sh
#
# Output: ./activate-app  (a standalone Mach-O executable)
#
# Packaging note: before shipping in a packaged release, code-sign +
# notarize this binary and add native/activate-app to electron-builder's
# extraResources, same as notch-info.ts's TODO.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling ActivateApp.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AppKit \
  -framework Foundation \
  ActivateApp.swift \
  -o activate-app

echo "Build succeeded: $(pwd)/activate-app"
echo "  size: $(du -sh activate-app | cut -f1)"
