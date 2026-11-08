#!/usr/bin/env bash
# build.sh — compile FrontmostWatch.swift into a standalone binary.
#
# Usage:
#   cd native/frontmost-watch && bash build.sh
#
# Output: ./frontmost-watch  (a standalone Mach-O executable)
#
# Packaging note: before shipping in a packaged release, code-sign + notarize
# this binary and add native/frontmost-watch to electron-builder's
# extraResources, same as activate-app.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling FrontmostWatch.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AppKit \
  -framework Foundation \
  FrontmostWatch.swift \
  -o frontmost-watch

echo "Build succeeded: $(pwd)/frontmost-watch"
echo "  size: $(du -sh frontmost-watch | cut -f1)"
