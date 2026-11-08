// virtual-display.ts — spawn/lifecycle wrapper for the native virtual-display
// helper (native/mm-vdisplay/MmVdisplay.swift).
//
// Why native: phone-remote's "extended display" mode needs a display that ISN'T
// the real monitor, so the phone can show something different from the Mac
// (prds/active/2026-07-25-1784959720-phone-remote-extended-display.md). macOS has
// no public API for that, so the helper uses the private CGVirtualDisplay; see
// its header for why that's the only path and how it fails safe.
//
// Protocol (mirrors system-audio.ts's shape):
//   stdout — exactly ONE line: "READY <id> <x> <y> <w> <h>" or "FAIL <reason>".
//   stderr — diagnostics only.
//   stdin  — held open; closing it (or SIGTERM) tears the display down.
//
// Why the bounds come back over the wire instead of being computed here: macOS
// chooses where to place the display and hiDPI halves the logical size — a run
// asking for 1170x640 came back at x=-1170 (placed LEFT of the real screen).
// Anything that assumes the requested size, or an origin of 0,0, mis-maps every
// cursor warp. Callers must use getVirtualDisplay()'s bounds verbatim.
//
// EXACTLY ONE virtual display, ever: FB17797423 is an unfixed Apple bug where
// SCStream locks onto the last-connected virtual display regardless of the
// displayID requested, which would silently capture the wrong screen.

import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../shared/env'
import { helpers } from '../platform'

const VDISPLAY_BIN = 'mm-vdisplay'
const VDISPLAY_DIR = 'native/mm-vdisplay'

/** How long to wait for the helper's READY line before giving up. The helper
 *  has its own 5s attach timeout, so this only needs to outlast that. */
const READY_TIMEOUT_MS = 8000

/** Geometry of a live virtual display, in the SAME global coordinate space as
 *  Electron's `screen` module — so a caller can normalize a point against it
 *  exactly as it would against `screen.getPrimaryDisplay().bounds`. */
export interface VirtualDisplayInfo {
  /** CGDirectDisplayID. Matches `screen.getAllDisplays()[n].id` and
   *  desktopCapturer's `display_id` (as a string), which is how the mirror
   *  pipeline selects this display to capture. */
  id: number
  bounds: { x: number; y: number; width: number; height: number }
}

interface ActiveDisplay {
  proc: ChildProcess
  info: VirtualDisplayInfo
}

let active: ActiveDisplay | null = null

/** Resolve the binary path. Dev: repo root. Prod: app resources (shipped via
 *  electron-builder extraResources, same as the other native helpers). */
function resolveBinaryPath(): string {
  // null only where the OS ships no helper; '' then fails the existsSync guard like a missing binary.
  return helpers.resolve(VDISPLAY_BIN) ?? ''
}

/** True when the native helper is present. An existsSync, no spawn — cheap
 *  enough to call from an IPC handler to decide whether to OFFER extended mode.
 *  Deliberately does not prove the private API still works on this macOS: that
 *  costs a spawn, and startVirtualDisplay's FAIL path reports it precisely. */
export function isVirtualDisplayAvailable(): boolean {
  return existsSync(resolveBinaryPath())
}

/** Geometry of the live virtual display, or null when extended mode is off. */
export function getVirtualDisplay(): VirtualDisplayInfo | null {
  return active?.info ?? null
}

/** Parse "READY <id> <x> <y> <w> <h>". Returns null on anything unexpected so a
 *  malformed line can't become a display with NaN bounds — that would send
 *  every cursor warp to an undefined coordinate. */
function parseReady(line: string): VirtualDisplayInfo | null {
  const parts = line.trim().split(/\s+/)
  if (parts[0] !== 'READY' || parts.length !== 6) return null
  const [id, x, y, width, height] = parts.slice(1).map(Number)
  if (![id, x, y, width, height].every(Number.isFinite)) return null
  if (id <= 0 || width <= 0 || height <= 0) return null
  return { id, bounds: { x, y, width, height } }
}

/**
 * Create the virtual display. Resolves with the bounds macOS actually assigned
 * once it is attached and capturable; rejects if the binary is missing, the
 * private API is gone, or it never attaches.
 *
 * `width`/`height` are a REQUEST in pixels. The resolved bounds may differ —
 * use those.
 *
 * NOT the viewer's viewport, despite what this said until 2026-08-11: the only
 * caller (extendDisplaySize in ipc/phone-remote.ts) passes the MAC's primary
 * display size, and mirrorStart carries no viewport fields to pass instead. So
 * a client whose aspect differs from the Mac's still letterboxes. That claim
 * sent a session off to build a square 600x600 desktop for the glasses.
 */
export function startVirtualDisplay(width: number, height: number): Promise<VirtualDisplayInfo> {
  return new Promise((resolve, reject) => {
    if (active) {
      // Only one display, ever (FB17797423). A second request while one is live
      // is the phone re-sending mirrorStart, so hand back what exists instead of
      // failing a toggle the user can't act on.
      devLog.warn('[vdisplay] already active — returning existing display')
      resolve(active.info)
      return
    }

    const bin = resolveBinaryPath()
    if (!existsSync(bin)) {
      reject(
        new Error(`vdisplay: binary not found at ${bin}. Run: cd ${VDISPLAY_DIR} && bash build.sh`)
      )
      return
    }

    // stdin stays piped and OPEN: the helper treats EOF as "tear down", which is
    // what removes the display if Electron is force-quit rather than stranding a
    // phantom monitor holding the user's windows.
    const proc = spawn(bin, [
      '--width',
      String(Math.round(width)),
      '--height',
      String(Math.round(height))
    ])

    let settled = false
    const finish = (err: Error | null, info?: VirtualDisplayInfo): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        proc.kill('SIGTERM')
        reject(err)
      } else if (info) {
        active = { proc, info }
        resolve(info)
      }
    }

    const timer = setTimeout(
      () => finish(new Error('vdisplay: timed out waiting for READY')),
      READY_TIMEOUT_MS
    )

    proc.on('error', (err) => finish(new Error(`vdisplay: spawn error: ${err.message}`)))

    // One short line, so line-buffering is safe here (unlike system-audio.ts,
    // where READY shares a chunk with binary PCM).
    let stdoutBuffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      const newline = stdoutBuffer.indexOf('\n')
      if (newline === -1) return
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)

      const info = parseReady(line)
      if (info) {
        devLog.log(
          `[vdisplay] READY id=${info.id} bounds=${info.bounds.x},${info.bounds.y} ` +
            `${info.bounds.width}x${info.bounds.height}`
        )
        finish(null, info)
        return
      }
      // "FAIL <reason>" — most likely a macOS update removed the private API.
      finish(new Error(`vdisplay: ${line.trim() || 'unparseable output'}`))
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      devLog.warn('[vdisplay] stderr:', chunk.toString().trim())
    })

    proc.once('close', (code) => {
      const wasActive = active?.proc === proc
      if (wasActive) active = null
      // Before READY: the reject path. After READY the helper died on its own —
      // display sleep, a WindowServer restart, or the OS revoking the display.
      // The display is GONE either way, so state must not claim otherwise.
      finish(new Error(`vdisplay: exited (code ${code}) before READY`))
      if (wasActive) devLog.warn(`[vdisplay] helper exited unexpectedly (code ${code})`)
    })
  })
}

/** Remove the virtual display. SIGTERM so the helper detaches it cleanly and
 *  windows migrate back to the real screen instead of vanishing with it. */
export function stopVirtualDisplay(): void {
  if (!active) return
  const { proc } = active
  active = null
  proc.kill('SIGTERM')
}
