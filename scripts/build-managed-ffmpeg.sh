#!/usr/bin/env bash
# Build + sign + notarize the LGPL ffmpeg we ship as a managed download.
#
# WHY THIS EXISTS (do not swap in a prebuilt binary):
# Every convenient prebuilt macOS ffmpeg is legally unusable for us —
#   evermeet.cx        → --enable-gpl   (x264, x265, xvid)
#   ffmpeg-static      → --enable-gpl AND --enable-nonfree (undistributable by anyone)
#   osxexperts.net     → --enable-gpl
# MightyMouse is proprietary, so shipping a GPL ffmpeg alongside it is a license
# violation. We build LGPL from source instead. That is cheap here because the
# record path needs almost nothing: recorder.ts uses `-f avfoundation` input and
# `-c:v h264_videotoolbox` (Apple's HARDWARE encoder), and listen-recorder.ts
# writes plain PCM wav. No libx264, no lame, no GPL anything. Result: ~20MB
# (~9.7MB gzipped) vs ~70MB for a general-purpose build.
#
# --disable-autodetect IS LOAD-BEARING. Without it, configure picks up whatever
# Homebrew has installed on the BUILD machine and links it dynamically — the
# first build here linked /opt/homebrew/opt/libxcb (for xcbgrab, an X11 screen
# grabber that is useless on macOS). It ran fine on this box and would have
# dyld-crashed on every clean Mac, AFTER passing codesign and notarization.
# Verify with the otool check below: system frameworks only, never /opt/homebrew.
#
# BOTH ARCHES SHIP. Intel Macs are still a meaningful share of installed base, and
# an arm64-only download hard-fails on them with no fallback. Build x86_64 from an
# Apple Silicon host with:  TARGET_ARCH=x86_64 ./scripts/build-managed-ffmpeg.sh
# That needs `nasm` (brew install nasm) - x86 asm requires an external assembler,
# arm64 does not. nasm is BUILD-time only; it is not linked in, so it does not
# reintroduce the Homebrew-dylib problem (the otool assert below still proves that).
# The x86_64 result is testable on Apple Silicon via Rosetta.
#
# Requires .scratch-local/apple-signing.env (APPLE_ID / APPLE_TEAM_ID /
# APPLE_APP_SPECIFIC_PASSWORD) and the Techguyver Labs Developer ID in the keychain.
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
IDENTITY="Developer ID Application: Techguyver Labs, LLC (BZJ35GS989)"
HOST_ARCH="$(uname -m)"
ARCH="${TARGET_ARCH:-$HOST_ARCH}"
WORK="${1:-./ffmpeg-build}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x86_64" ]; then
  echo "FATAL: TARGET_ARCH must be arm64 or x86_64 (got '$ARCH')" >&2; exit 1
fi
if [ "$ARCH" = "x86_64" ] && ! command -v nasm >/dev/null 2>&1; then
  echo "FATAL: x86_64 build needs nasm. Run: brew install nasm" >&2; exit 1
fi

mkdir -p "$WORK" && cd "$WORK"

if [ ! -d "ffmpeg-$FFMPEG_VERSION" ]; then
  echo "==> Fetching ffmpeg $FFMPEG_VERSION source"
  curl -fL --progress-bar -o "ffmpeg-src.tar.xz" \
    "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
  tar xf "ffmpeg-src.tar.xz"
fi

# Separate build dir per arch so the two never share object files.
BUILDDIR="build-$ARCH"
rm -rf "$BUILDDIR" && cp -R "ffmpeg-$FFMPEG_VERSION" "$BUILDDIR"
cd "$BUILDDIR"

echo "==> Configuring (LGPL, no autodetect) for $ARCH"
CONFIGURE_ARCH_FLAGS=()
if [ "$ARCH" = "x86_64" ] && [ "$HOST_ARCH" = "arm64" ]; then
  CONFIGURE_ARCH_FLAGS=(
    --arch=x86_64 --cpu=x86-64
    --enable-cross-compile --target-os=darwin
    --cc="clang -arch x86_64"
    --extra-cflags="-arch x86_64" --extra-ldflags="-arch x86_64"
  )
else
  CONFIGURE_ARCH_FLAGS=( --arch="$ARCH" --cc=clang )
fi

./configure \
  --prefix="$PWD/out" \
  --disable-gpl --disable-nonfree --disable-version3 \
  --disable-doc --disable-ffplay --disable-network \
  --disable-debug --disable-autodetect \
  --enable-videotoolbox --enable-audiotoolbox \
  --enable-avfoundation --enable-coreimage \
  --enable-static --disable-shared \
  "${CONFIGURE_ARCH_FLAGS[@]}"

# Fail loudly rather than silently shipping a GPL binary.
./configure --help >/dev/null 2>&1 || true
if ! grep -q "License: LGPL" ffbuild/config.log 2>/dev/null && \
   ! ./ffmpeg -hide_banner -version 2>/dev/null | grep -q "disable-gpl"; then
  echo "WARNING: could not confirm LGPL from config.log; verifying after build" >&2
fi

echo "==> Building"
make -j"$(sysctl -n hw.ncpu)"

echo "==> Verifying license + encoders"
./ffmpeg -hide_banner -version | grep -q -- "--disable-gpl" \
  || { echo "FATAL: build is not LGPL"; exit 1; }
./ffmpeg -hide_banner -encoders 2>/dev/null | grep -qE 'libx264|libx265|libxvid' \
  && { echo "FATAL: GPL encoder present"; exit 1; }
./ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox \
  || { echo "FATAL: h264_videotoolbox missing"; exit 1; }
./ffmpeg -hide_banner -devices 2>/dev/null | grep -q avfoundation \
  || { echo "FATAL: avfoundation indev missing"; exit 1; }

echo "==> Verifying arch"
file ffmpeg | grep -q "$ARCH" || { echo "FATAL: built wrong arch"; exit 1; }

echo "==> Verifying no non-system dylib deps"
if otool -L ffmpeg | tail -n +2 | grep -vE '/System/Library|/usr/lib'; then
  echo "FATAL: links a non-system dylib (see above) — would crash on a clean Mac" >&2
  exit 1
fi

OUT="../ffmpeg-lgpl-$ARCH"
cp ffmpeg "$OUT"

echo "==> Codesigning (hardened runtime + timestamp)"
codesign --force --sign "$IDENTITY" --options runtime --timestamp "$OUT"
codesign -vv --strict "$OUT"

echo "==> Notarizing"
set -a; . "$REPO_ROOT/.scratch-local/apple-signing.env"; set +a
ditto -c -k --keepParent "$OUT" "$OUT.zip"
xcrun notarytool submit "$OUT.zip" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait --timeout 20m

# NOTE: bare Mach-O binaries cannot be stapled (`stapler` returns error 73) —
# there is no bundle to hold the ticket. Gatekeeper validates the notarization
# online instead, which is why `spctl` below reports "Notarized Developer ID"
# even with a quarantine xattr set. This is expected, not a failure.

# On Apple Silicon a cross-built x86_64 binary still runs here under Rosetta, so
# this same test is valid for both arches.
echo "==> Gatekeeper check under quarantine"
cp "$OUT" "$OUT-qtest"
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$OUT-qtest"
spctl -a -vvv -t install "$OUT-qtest"
"$OUT-qtest" -hide_banner -loglevel error \
  -f lavfi -i testsrc=size=1280x720:rate=30 -t 1 \
  -c:v h264_videotoolbox -b:v 3M -pix_fmt yuv420p -y "$OUT-qtest.mp4"
echo "    encoded OK while quarantined"
rm -f "$OUT-qtest" "$OUT-qtest.mp4"

echo
echo "==> DONE: $OUT"
echo "    sha256: $(shasum -a 256 "$OUT" | awk '{print $1}')"
echo "    bytes:  $(stat -f%z "$OUT")"
