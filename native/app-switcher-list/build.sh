#!/usr/bin/env bash
# build.sh — compile AppSwitcherList.swift into a standalone binary.
#
# Requirements:
#   - macOS with Xcode Command Line Tools (swiftc in PATH)
#   - Apple Silicon; target is arm64-apple-macos12.
#     Adjust the target triple for Intel or a universal binary.
#
# Usage:
#   cd native/app-switcher-list && bash build.sh
#
# Output: ./app-switcher-list  (a standalone Mach-O executable)
#
# Packaging note: before shipping in the app the binary must be
# code-signed and notarized. See the TODO in src/main/macos/notch-info.ts
# (same packaging path applies here).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling AppSwitcherList.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  AppSwitcherList.swift \
  -o app-switcher-list

echo "Build succeeded: $(pwd)/app-switcher-list"
echo "  size: $(du -sh app-switcher-list | cut -f1)"
