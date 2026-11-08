#!/usr/bin/env bash
# Location has to be its own .app: macOS never shows the location prompt to a CLI child of Electron.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
APP=MightyMouseLocation.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -target arm64-apple-macos12 -framework AppKit -framework CoreLocation Location.swift -o "$APP/Contents/MacOS/MightyMouseLocation"
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | grep '(BZJ35GS989)' | head -1 | sed -E 's/.*"(.*)"$/\1/')"
codesign --force --sign "${IDENTITY:--}" "$APP"
echo "Build succeeded: $(pwd)/$APP"
