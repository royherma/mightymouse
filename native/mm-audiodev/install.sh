#!/usr/bin/env bash
# install.sh — put the signed plugin in the system HAL directory and reload it.
#
# Usage:
#   cd native/mm-audiodev && bash install.sh            # install
#   cd native/mm-audiodev && bash install.sh --uninstall
#
# TWO things about this are unavoidable and worth stating before you run it:
#
#   1. It needs an ADMIN PASSWORD. /Library/Audio/Plug-Ins/HAL is root-owned and
#      there is no per-user HAL directory that coreaudiod scans.
#
#   2. It INTERRUPTS AUDIO IN EVERY RUNNING APP for a second. coreaudiod only
#      rescans the directory at launch, and SIP blocks `launchctl kickstart` on
#      Sonoma 14.4+, so `killall` is the only remaining reload path. Music will
#      pause, calls will drop their device. Nothing needs restarting afterwards.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUNDLE="mm-audiodev.driver"
HAL_DIR="/Library/Audio/Plug-Ins/HAL"
DEST="$HAL_DIR/$BUNDLE"
# Must match MM_RING_DIR in mm_audio_ring.h.
RING_DIR="/Library/Application Support/MightyMouse"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Removing $DEST (admin password required)..."
  sudo rm -rf "$DEST"
  sudo rm -rf "$RING_DIR"
  echo "Reloading coreaudiod — audio will glitch briefly..."
  sudo killall coreaudiod
  echo "Uninstalled."
  exit 0
fi

if [[ ! -d "$BUNDLE" ]]; then
  echo "ERROR: $BUNDLE not found. Run: bash build.sh" >&2
  exit 1
fi

# An unsigned or broken-signature bundle is loaded by nothing and reports no
# error anywhere — catch it here rather than at "why isn't it in the list".
if ! codesign --verify --strict "$BUNDLE" 2>/dev/null; then
  echo "ERROR: $BUNDLE has no valid signature; coreaudiod would silently ignore it." >&2
  echo "       Rebuild with: bash build.sh" >&2
  exit 1
fi

echo "Installing to $DEST (admin password required)..."
sudo mkdir -p "$HAL_DIR"
sudo rm -rf "$DEST"
sudo cp -R "$BUNDLE" "$DEST"
sudo chown -R root:wheel "$DEST"

# The ring's home. /Library/Application Support is root:admin with no group
# write, so the unprivileged writer cannot create this itself -- and coreaudiod
# runs as _coreaudiod, so both need write access to a directory neither owns.
sudo mkdir -p "$RING_DIR"
sudo chmod 0777 "$RING_DIR"

echo "Reloading coreaudiod — audio will glitch briefly..."
sudo killall coreaudiod

# The device should appear within a second of the restart. Reporting this here
# beats sending someone to the Sound pane to guess.
sleep 2
if system_profiler SPAudioDataType 2>/dev/null | grep -q "MightyMouse"; then
  echo "Installed. \"MightyMouse\" is now a selectable microphone."
else
  echo "Installed, but the device did not appear. Check: log show --last 2m --predicate 'process == \"coreaudiod\"'" >&2
  exit 1
fi
