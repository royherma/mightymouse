#!/usr/bin/env bash
# build.sh — compile NotchInfo.swift into a standalone binary.
#
# Requirements:
#   - macOS with Xcode Command Line Tools (swiftc in PATH)
#   - Apple Silicon; target is arm64-apple-macos12.
#     Adjust the target triple for Intel or a universal binary.
#
# Usage:
#   cd native/notch-info && bash build.sh
#
# Output: ./notch-info  (a standalone Mach-O executable)
#
# Packaging note: before shipping in the app the binary must be
# code-signed and notarized. See the TODO in src/main/macos/notch-info.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling NotchInfo.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AppKit \
  -framework Foundation \
  NotchInfo.swift \
  -o notch-info

echo "Build succeeded: $(pwd)/notch-info"
echo "  size: $(du -sh notch-info | cut -f1)"
