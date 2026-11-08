#!/usr/bin/env bash
# build.sh — compile Ocr.swift into a standalone binary.
#
# Requirements:
#   - macOS with Xcode Command Line Tools (swiftc in PATH)
#   - Vision framework (ships with macOS 10.15+)
#
# Usage:
#   cd native/ocr && bash build.sh
#
# Output: ./ocr  (a standalone Mach-O executable)
#
# Packaging note: before shipping in the Electron app the binary must be
# code-signed and notarized. See the TODO in src/main/capture/ocr.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling Ocr.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework Vision \
  -framework AppKit \
  -framework Foundation \
  Ocr.swift \
  -o ocr

echo "Build succeeded: $(pwd)/ocr"
echo "  size: $(du -sh ocr | cut -f1)"
