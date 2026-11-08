#!/usr/bin/env bash
# build.sh — compile MmInput.swift into a standalone binary.
#
# Requirements:
#   - macOS with Xcode Command Line Tools (swiftc in PATH)
#   - Apple Silicon; target is arm64-apple-macos12.
#     Adjust the target triple for Intel or a universal binary.
#
# Usage:
#   cd native/mm-input && bash build.sh
#
# Output: ./mm-input  (a standalone Mach-O executable)
#
# Packaging note: before shipping in the app the binary must be code-signed and
# notarized, AND the app must hold Accessibility permission for the posted events
# to land. See src/main/macos/input.ts and permissions.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling MmInput.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework CoreGraphics \
  -framework Foundation \
  -framework Carbon \
  MmInput.swift \
  -o mm-input

echo "Build succeeded: $(pwd)/mm-input"
echo "  size: $(du -sh mm-input | cut -f1)"
