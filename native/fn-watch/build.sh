#!/usr/bin/env bash
# build.sh — compile FnWatch.swift into a standalone binary.
#
# Usage:
#   cd native/fn-watch && bash build.sh
#
# Output: ./fn-watch  (a standalone Mach-O executable)
#
# Packaging note: before shipping in a packaged release, code-sign + notarize
# this binary and add native/fn-watch to electron-builder's
# extraResources, same as activate-app.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling FnWatch.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework Cocoa \
  FnWatch.swift \
  -o fn-watch

echo "Build succeeded: $(pwd)/fn-watch"
echo "  size: $(du -sh fn-watch | cut -f1)"
