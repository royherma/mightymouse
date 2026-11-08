#!/usr/bin/env bash
# build.sh — compile MmAx.swift into a standalone binary.
#
# Usage:
#   cd native/mm-ax && bash build.sh
#
# Output: ./mm-ax  (a standalone Mach-O executable)
#
# Needs Accessibility permission at RUN time (it reads another app's AX tree
# and posts AXPress to it). Unlike activate-app, which uses a plain AppKit
# call, every API here is gated -- without the grant the walk returns an empty
# tree and every press reports not-found.
#
# Packaging note: code-sign + notarize before shipping, same as the others.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling MmAx.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AppKit \
  -framework ApplicationServices \
  -framework Foundation \
  MmAx.swift \
  -o mm-ax

echo "Build succeeded: $(pwd)/mm-ax"
echo "  size: $(du -sh mm-ax | cut -f1)"
