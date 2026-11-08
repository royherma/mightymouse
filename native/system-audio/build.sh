#!/usr/bin/env bash
# build.sh — compile SystemAudio.swift into a standalone binary.
#
# Requirements:
#   - macOS 13+ with Xcode Command Line Tools (swiftc in PATH)
#   - The -target below is arm64-apple-macos13: ScreenCaptureKit's audio
#     capture (SCStreamConfiguration.capturesAudio) requires macOS 13, which
#     is a HIGHER floor than the other helpers here (macos12). Don't lower it.
#
# Usage:
#   cd native/system-audio && bash build.sh
#   (or: bash native/build-all.sh — this dir is picked up by its loop)
#
# Output: ./system-audio  (a standalone Mach-O executable)
#
# Packaging note: before shipping in a packaged release the binary must be
# code-signed and notarized along with the other native helpers — an unsigned
# binary gets SIGKILLed by macOS. See native/build-all.sh's header.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling SystemAudio.swift..."
swiftc \
  -O \
  -target arm64-apple-macos13 \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework Foundation \
  SystemAudio.swift \
  -o system-audio

echo "Build succeeded: $(pwd)/system-audio"
echo "  size: $(du -sh system-audio | cut -f1)"
