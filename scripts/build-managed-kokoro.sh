#!/usr/bin/env bash
# Build + sign + notarize the Kokoro TTS payload we ship as a managed download.
#
# WHY A BUNDLED VENV (and not a frozen binary):
# Kokoro runs through mlx-audio, a Python package that loads MLX Metal kernels and
# an espeak-ng dylib via ctypes. PyInstaller/Nuitka both mangle that ctypes+data-dir
# layout, and MLX's lazy kernel loading defeats static analysis. A relocatable venv
# is the boring, verifiable option — it is the SAME files that already work, just
# with a portable interpreter underneath.
#
# THE INTERPRETER IS THE WHOLE PROBLEM. A `uv tool install` venv symlinks
# bin/python at /opt/homebrew/opt/python@3.12 — copy that venv to a user's Mac and
# it dies instantly on a missing interpreter. python-build-standalone (what
# `uv python install` fetches) is self-contained, links only /System + /usr/lib via
# @rpath, and survives being copied anywhere. Verified with the otool assert below.
#
# ESPEAK HAS A FIXED DATA-PATH BUFFER. espeak-ng truncates a long data path and then
# falls back to the path baked in at ITS build time — a CI machine's
# /Users/runner/work/... — and aborts the process with no Python traceback. It looks
# exactly like a corrupt payload. Install path length is therefore load-bearing:
# ~/MightyMouse/models/kokoro keeps the data dir near 113 chars, which works. The
# assert below fails the build if the test path is long enough to mask this.
#
# TORCH IS 500MB OF DEAD WEIGHT. Kokoro is pure MLX and imports zero torch. torch
# arrives only via misaki[en] → spacy → spacy_curated_transformers, which is the
# transformer G2P used when trf=True. Kokoro calls trf=False, so pruning
# spacy_curated_transformers is what makes torch prunable: 1.0G → 549M.
#
# SPACY'S MODEL MUST BE PRE-INSTALLED. misaki/en.py calls spacy.cli.download() at
# runtime on first use, which writes into site-packages over the network. In a
# signed, read-only, possibly-offline payload that is a hard failure. We install the
# pinned en_core_web_sm wheel at build time so nothing downloads at runtime.
#
# Requires .scratch-local/apple-signing.env (APPLE_ID / APPLE_TEAM_ID /
# APPLE_APP_SPECIFIC_PASSWORD) and the Techguyver Labs Developer ID in the keychain.
set -euo pipefail

PY_VERSION="${PY_VERSION:-3.12}"
MLX_AUDIO_VERSION="${MLX_AUDIO_VERSION:-}"          # empty = latest
SPACY_MODEL_WHEEL="https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
IDENTITY="Developer ID Application: Techguyver Labs, LLC (BZJ35GS989)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$REPO_ROOT/.scratch-local/kokoro-build}"
VENV="$WORK/kokoro"

# espeak-ng truncates a long data path; a test dir far longer than the real install
# path (~/MightyMouse/models/kokoro) would hide that failure until a user hit it.
MAX_TEST_PATH=140
if [ "${#VENV}" -gt "$MAX_TEST_PATH" ]; then
  echo "FATAL: build path is ${#VENV} chars (max $MAX_TEST_PATH)." >&2
  echo "       espeak-ng silently falls back to its build-time data path when the" >&2
  echo "       path is long, so a pass here would not predict a user's machine." >&2
  exit 1
fi

command -v uv >/dev/null 2>&1 || { echo "FATAL: uv not installed (brew install uv)" >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "FATAL: MLX is Apple-Silicon only; build on arm64" >&2; exit 1; }

rm -rf "$WORK" && mkdir -p "$WORK"

echo "==> Fetching a relocatable standalone CPython $PY_VERSION"
# Kept inside $WORK so the build never depends on the host's python inventory.
export UV_PYTHON_INSTALL_DIR="$WORK/pythons"
uv python install "$PY_VERSION"
STANDALONE_PY="$(uv python find "$PY_VERSION")"
case "$STANDALONE_PY" in
  /opt/homebrew/*|/usr/local/*|/Library/*)
    echo "FATAL: resolved a system python ($STANDALONE_PY), not a standalone one" >&2
    exit 1 ;;
esac

echo "==> Creating the venv"
uv venv --python "$STANDALONE_PY" --relocatable --python-preference only-managed "$VENV"

echo "==> Installing mlx-audio + misaki[en]"
export VIRTUAL_ENV="$VENV"
uv pip install ${MLX_AUDIO_VERSION:+"mlx-audio==$MLX_AUDIO_VERSION"} ${MLX_AUDIO_VERSION:-mlx-audio}
uv pip install "misaki[en]"
echo "==> Pre-installing the spacy model (so nothing downloads at runtime)"
uv pip install "$SPACY_MODEL_WHEEL"
unset VIRTUAL_ENV

echo "==> Bundling the interpreter INTO the payload"
# A venv always symlinks bin/python. Copy the real interpreter in and repoint the
# link at it relatively, so the payload has no reference outside its own directory.
PY_HOME="$(cd "$(dirname "$STANDALONE_PY")/.." && pwd)"
rm -rf "$VENV/python-runtime"
cp -R "$PY_HOME" "$VENV/python-runtime"
PY_BIN_NAME="$(basename "$STANDALONE_PY")"
rm -f "$VENV/bin/python" "$VENV/bin/python3" "$VENV/bin/python$PY_VERSION"
ln -s "../python-runtime/bin/$PY_BIN_NAME" "$VENV/bin/python"
ln -s python "$VENV/bin/python3"
ln -s python "$VENV/bin/python$PY_VERSION"
# home= must point inside the payload too, or site.py resolves the build machine's path.
cat > "$VENV/pyvenv.cfg" <<EOF
home = $VENV/python-runtime/bin
include-system-site-packages = false
version = $PY_VERSION
relocatable = true
EOF

echo "==> Pruning dead weight"
SITE="$VENV/lib/python$PY_VERSION/site-packages"
# The transformer G2P (trf=True). Kokoro uses trf=False, and this is torch's only importer.
rm -rf "$SITE"/spacy_curated_transformers "$SITE"/spacy_curated_transformers-*.dist-info
rm -rf "$SITE"/torch "$SITE"/torch-*.dist-info "$SITE"/torchgen "$SITE"/functorch "$SITE"/nvidia
# Other mlx-audio model families + its speech-to-text/speech-to-speech halves.
rm -rf "$SITE"/mlx_audio/stt "$SITE"/mlx_audio/sts "$SITE"/mlx_audio/tts/tests
find "$SITE/mlx_audio/tts/models" -maxdepth 1 -mindepth 1 -type d \
  ! -name kokoro ! -name base -exec rm -rf {} + 2>/dev/null || true
find "$VENV" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$VENV" -name '*.pyc' -delete 2>/dev/null || true

echo "==> Verifying the interpreter is self-contained"
if otool -L "$VENV/python-runtime/bin/$PY_BIN_NAME" | tail -n +2 \
   | grep -vE '/System/Library|/usr/lib|@rpath|@loader_path|@executable_path'; then
  echo "FATAL: interpreter links a non-system library (above)" >&2; exit 1
fi
if find "$VENV" -type l -lname '/opt/homebrew/*' -o -type l -lname '/usr/local/*' | grep -q .; then
  echo "FATAL: payload contains a symlink into Homebrew — dies on a clean Mac" >&2
  find "$VENV" -type l -lname '/opt/homebrew/*' -o -type l -lname '/usr/local/*' >&2
  exit 1
fi

echo "==> Verifying no Mach-O links outside the payload"
# This is the ffmpeg lesson: a Homebrew-linked object passes codesign AND
# notarization, then dyld-crashes on every machine that lacks Homebrew.
# otool -L's first line is the file's OWN install name (scipy ships /DLC/...,
# protobuf ships bazel-out/...), so compare against otool -D and skip it —
# otherwise the assert cries wolf on 4 harmless files.
VIOLATIONS=0
while IFS= read -r f; do
  file "$f" 2>/dev/null | grep -q 'Mach-O' || continue
  own_id="$(otool -D "$f" 2>/dev/null | tail -n +2 | head -1)"
  deps="$(otool -L "$f" 2>/dev/null | tail -n +2 \
          | sed 's/ (compatibility.*//; s/^[[:space:]]*//' \
          | grep -vE '^/System/Library|^/usr/lib|^@rpath|^@loader_path|^@executable_path' \
          | grep -Fxv "${own_id:-__none__}" | grep -Fxv "$f" || true)"
  if [ -n "$deps" ]; then
    echo "  BAD: ${f#$VENV/}"; echo "$deps" | sed 's/^/       /'
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done < <(find "$VENV" \( -name '*.so' -o -name '*.dylib' \) 2>/dev/null)
[ "$VIOLATIONS" -eq 0 ] || { echo "FATAL: $VIOLATIONS object(s) link outside the payload" >&2; exit 1; }

echo "==> Verifying it synthesizes (clean env, offline model cache)"
PROBE="$WORK/probe"
rm -f "$PROBE"_*.wav
# env -u VIRTUAL_ENV: a leaked VIRTUAL_ENV makes spacy/uv resolve the BUILD venv,
# which hides a payload that cannot stand alone.
env -u VIRTUAL_ENV -u PYTHONPATH -u PYTHONHOME "$VENV/bin/python" \
  -m mlx_audio.tts.generate --model prince-canuma/Kokoro-82M \
  --text "The bundled voice payload works." --voice af_heart \
  --file_prefix "$PROBE" --audio_format wav >/dev/null 2>&1 || true
[ -s "${PROBE}_000.wav" ] || { echo "FATAL: payload did not produce audio" >&2; exit 1; }
echo "    synthesized $(stat -f%z "${PROBE}_000.wav") bytes"
# Guard the runtime-download path explicitly: spacy must never phone home.
env -u VIRTUAL_ENV "$VENV/bin/python" -c "import en_core_web_sm" 2>/dev/null \
  || { echo "FATAL: en_core_web_sm missing — misaki would download it at runtime" >&2; exit 1; }

echo "==> Codesigning $(find "$VENV" \( -name '*.so' -o -name '*.dylib' \) | wc -l | tr -d ' ') Mach-O objects + the interpreter"
# Every Mach-O in the payload needs its own signature under the hardened runtime;
# signing only the interpreter leaves the .so files unsigned and Gatekeeper refuses them.
while IFS= read -r f; do
  codesign --force --sign "$IDENTITY" --options runtime --timestamp "$f" >/dev/null 2>&1
done < <(find "$VENV" \( -name '*.so' -o -name '*.dylib' \) 2>/dev/null)
find "$VENV" -type f -perm +111 ! -name '*.so' ! -name '*.dylib' 2>/dev/null | while IFS= read -r f; do
  file "$f" 2>/dev/null | grep -q 'Mach-O' || continue
  codesign --force --sign "$IDENTITY" --options runtime --timestamp "$f" >/dev/null 2>&1
done
codesign -vv --strict "$VENV/python-runtime/bin/$PY_BIN_NAME"

echo "==> Packaging"
ARCHIVE="$WORK/kokoro-payload-arm64.tar.gz"
tar -czf "$ARCHIVE" -C "$(dirname "$VENV")" "$(basename "$VENV")"

echo "==> Notarizing"
set -a; . "$REPO_ROOT/.scratch-local/apple-signing.env"; set +a
ZIP="$WORK/kokoro-notarize.zip"
ditto -c -k --keepParent "$VENV" "$ZIP"
xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait --timeout 30m

echo "==> Gatekeeper check under quarantine"
# Loose Mach-O files cannot be stapled (no bundle to hold the ticket), so Gatekeeper
# validates online — the same situation as the ffmpeg payload.
QT="$WORK/qtest"
rm -rf "$QT" && cp -R "$VENV" "$QT"
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" \
  "$QT/python-runtime/bin/$PY_BIN_NAME"
spctl -a -vvv -t install "$QT/python-runtime/bin/$PY_BIN_NAME" 2>&1 | sed 's/^/    /' || true
rm -f "$QT/probe"_*.wav
env -u VIRTUAL_ENV "$QT/bin/python" -m mlx_audio.tts.generate \
  --model prince-canuma/Kokoro-82M --text "Quarantined payload check." \
  --voice af_heart --file_prefix "$QT/probe" --audio_format wav >/dev/null 2>&1 || true
[ -s "$QT/probe_000.wav" ] || { echo "FATAL: quarantined payload did not synthesize" >&2; exit 1; }
echo "    synthesized while quarantined"
rm -rf "$QT"

echo
echo "==> DONE: $ARCHIVE"
echo "    unpacked: $(du -sh "$VENV" | cut -f1)"
echo "    archive:  $(du -h "$ARCHIVE" | cut -f1) ($(stat -f%z "$ARCHIVE") bytes)"
echo "    sha256:   $(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
echo
echo "    Put those three values in CONFIG.KOKORO_DOWNLOAD (src/shared/config.ts)."
