#!/usr/bin/env bash
# build.sh — rebuild the passkeys N-API addon against Electron's Node ABI.
#
# Picked up automatically by native/build-all.sh. Unlike the Swift helpers here,
# the compiled .node is NOT committed (ABI-specific, like better-sqlite3) — it's
# rebuilt on install by scripts/build-passkeys-addon.mjs, which this delegates to.
#
# Usage:  cd native/passkeys && bash build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/../../scripts/build-passkeys-addon.mjs"
