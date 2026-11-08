#!/usr/bin/env bash
# build.sh — compile MmVdisplay.swift into a standalone binary.
#
# Requirements:
#   - macOS with Xcode Command Line Tools (swiftc in PATH)
#   - Apple Silicon; target is arm64-apple-macos12.
#
# Usage:
#   cd native/mm-vdisplay && bash build.sh
#
# Output: ./mm-vdisplay  (a standalone Mach-O executable)
#
# Note: this helper calls the PRIVATE CGVirtualDisplay API entirely through the
# ObjC runtime (NSClassFromString), so nothing private is linked at build time --
# it compiles against plain CoreGraphics and degrades to a "FAIL" line at runtime
# if Apple ever removes the class. That is deliberate; see the header comment in
# MmVdisplay.swift.
#
# Packaging note: before shipping, the binary must be code-signed + notarized
# with the other native helpers (electron-builder ships native/** via
# extraResources). No special entitlement is required for the virtual display.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Compiling MmVdisplay.swift..."
swiftc \
  -O \
  -target arm64-apple-macos12 \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  MmVdisplay.swift \
  -o mm-vdisplay

echo "Build succeeded: $(pwd)/mm-vdisplay"
echo "  size: $(du -sh mm-vdisplay | cut -f1)"
