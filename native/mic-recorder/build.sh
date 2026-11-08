#!/usr/bin/env bash
# build.sh — compile MicRecorder.swift into a standalone binary.
#
# Requirements:
#   - macOS with Xcode Command Line Tools (swiftc in PATH)
#   - Apple Silicon or Intel; the -target flag below targets arm64-apple-macos12
#     for maximum compatibility with M-series Macs running macOS 12+.
#     Adjust the target triple if you need an Intel or universal binary.
#
# Usage:
#   cd native/mic-recorder && bash build.sh
#
# Output: ./mic-recorder  (a standalone Mach-O executable)
#
# Packaging note: before shipping in the Electron app the binary must be
# code-signed and notarized. See the TODO in src/main/capture/native-mic.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling MicRecorder.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AVFoundation \
  -framework Foundation \
  MicRecorder.swift \
  -o mic-recorder

echo "Build succeeded: $(pwd)/mic-recorder"
echo "  size: $(du -sh mic-recorder | cut -f1)"
