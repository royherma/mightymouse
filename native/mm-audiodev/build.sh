#!/usr/bin/env bash
# build.sh — compile the Core Audio Server Plug-In into a signed .driver bundle.
#
# Unlike every other helper in native/, this is clang + C rather than swiftc:
# coreaudiod loads the plugin through a C function-pointer vtable and runs its
# IO callbacks on a realtime thread, where the Swift runtime is not allowed.
#
# Usage:
#   cd native/mm-audiodev && bash build.sh
#
# Output: ./mm-audiodev.driver  (a loadable, signed HAL plugin bundle)
#
# Signing is REQUIRED, not a packaging step: coreaudiod refuses to load an
# unsigned plugin, so an unsigned build fails at install with no visible error.
# Notarization is separate and only matters for distribution, not local loading.
#
# Install is deliberately NOT done here — it needs admin rights and bounces
# coreaudiod. See install.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUNDLE="mm-audiodev.driver"
SIGN_ID="${MM_SIGN_ID:-Developer ID Application: Techguyver Labs, LLC (BZJ35GS989)}"

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS"
cp Info.plist "$BUNDLE/Contents/Info.plist"

echo "Compiling mm_audiodev.c + mm_properties.c..."
clang \
  -O2 \
  -target arm64-apple-macos12 \
  -bundle \
  -framework CoreFoundation \
  -framework CoreAudio \
  mm_audiodev.c \
  mm_properties.c \
  -o "$BUNDLE/Contents/MacOS/mm-audiodev"

echo "Compiling mm_ring_writer.c..."
clang -O2 -target arm64-apple-macos12 mm_ring_writer.c -o mm-ring-writer

echo "Compiling mm_default_input.c..."
clang -O2 -target arm64-apple-macos12 \
  -framework CoreFoundation \
  -framework CoreAudio \
  mm_default_input.c -o mm-default-input

if security find-identity -v -p codesigning | grep -qF "$SIGN_ID"; then
  echo "Signing with: $SIGN_ID"
  codesign --force --sign "$SIGN_ID" --timestamp --options runtime "$BUNDLE"
  codesign --verify --strict --verbose=2 "$BUNDLE"
  codesign --force --sign "$SIGN_ID" --timestamp --options runtime mm-ring-writer
  codesign --force --sign "$SIGN_ID" --timestamp --options runtime mm-default-input
else
  echo "ERROR: signing identity not found: $SIGN_ID" >&2
  echo "       coreaudiod will refuse to load an unsigned plugin." >&2
  exit 1
fi

echo "Build succeeded: $(pwd)/$BUNDLE"
echo "  Next: bash install.sh  (needs admin, bounces coreaudiod)"
