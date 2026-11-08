#!/usr/bin/env bash
# build.sh — compile the Swift sources into a standalone .app bundle.
#
# Mirrors native/*/build.sh (hand-rolled swiftc, no Xcode project checked in),
# extended to produce a proper windowed .app bundle (Contents/MacOS + Info.plist)
# instead of a bare CLI binary, since a stub installer needs a real app bundle
# to launch from Finder/double-click.
#
# Requirements:
#   - macOS with Xcode Command Line Tools (swiftc in PATH)
#   - Apple Silicon; target is arm64-apple-macos12. Adjust for Intel/universal.
#
# Usage:
#   cd installer/MightyMouseInstaller && bash build.sh
#
# Output: ./build/MightyMouseInstaller.app  (UNSIGNED — see installer/README.md)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="MightyMouseInstaller"
BUILD_DIR="$SCRIPT_DIR/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"

rm -rf "$APP_BUNDLE"
mkdir -p "$CONTENTS/MacOS"

echo "Compiling Swift sources..."
swiftc \
  -O \
  -swift-version 5 \
  -strict-concurrency=minimal \
  -target arm64-apple-macos12 \
  -framework SwiftUI \
  -framework AppKit \
  -framework Foundation \
  -framework Combine \
  App.swift MouseGlyphView.swift InstallerModel.swift ContentView.swift \
  -o "$CONTENTS/MacOS/$APP_NAME"

cp Info.plist "$CONTENTS/Info.plist"

# App icon — reuse the main app's icns (repo build/icon.icns) so the stub shows the
# MightyMouse mark in Finder/Downloads instead of the generic blank-page icon.
# Info.plist declares CFBundleIconFile=icon (no extension, macOS convention).
REPO_ICON="$SCRIPT_DIR/../../build/icon.icns"
if [ -f "$REPO_ICON" ]; then
  mkdir -p "$CONTENTS/Resources"
  cp "$REPO_ICON" "$CONTENTS/Resources/icon.icns"
else
  echo "WARN: $REPO_ICON not found — installer will have no icon." >&2
fi

echo "Build succeeded: $APP_BUNDLE"
echo "  binary size: $(du -sh "$CONTENTS/MacOS/$APP_NAME" | cut -f1)"
echo "  bundle size: $(du -sh "$APP_BUNDLE" | cut -f1)"
echo
echo "UNSIGNED — Gatekeeper will block this on another Mac. To run locally:"
echo "  open '$APP_BUNDLE'"
echo "  (or, if Gatekeeper blocks even locally: xattr -dr com.apple.quarantine '$APP_BUNDLE')"
