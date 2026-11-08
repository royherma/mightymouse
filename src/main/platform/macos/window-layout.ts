// window-layout.ts — tile other apps' windows for Phone Remote's layout sheet.
//
// Consumer: src/main/ipc/phone-remote.ts, case 'windowLayout' — the phone
// long-presses Settings, picks a layout, and this arranges the windows.
//
// Owns everything the native binary deliberately does not: which screen, how
// big, whether to leave margins, and what the previous rects were so Restore
// can put them back. native/window-layout is only the AX write head.
//
// Why a native binary at all: Electron surfaces no Accessibility API, and AX
// is the only way to move a window belonging to another app. Notably it does
// so WITHOUT activating that app — a background window tiles in place, nothing
// flashes to the front. The alternative (driving macOS 26's own
// Window ▸ Move & Resize ▸ Arrange menu) means synthesized UI against the
// frontmost app, which is the approach quick-switch.ts abandoned after three
// rounds of timing tuning.

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { screen } from 'electron'
import { devLog } from '../../../shared/env'
import { resolveHelper } from './helpers'
import {
  computeLayout,
  isTwoAppLayout,
  TILED_MARGIN_PX,
  type Rect,
  type WindowLayoutKind
} from '../geometry'

const WINDOW_LAYOUT_BIN = 'window-layout'

// Two AX round-trips per app plus process start. Measured well under 100ms for
// two windows; 2s is headroom for an app that is busy or paging back in.
const WINDOW_LAYOUT_TIMEOUT_MS = 2000

/** One app's rect as it was BEFORE the layout that moved it. */
interface StashedRect {
  bundleId: string
  rect: Rect
}

/**
 * The rects to put back when the sheet's Restore button is tapped.
 *
 * Session-lifetime only, deliberately not persisted: a rect stashed three days
 * ago points at a window the user has since moved, resized, or closed, and
 * silently teleporting it there is worse than having no Restore at all. Empty
 * stash means the sheet hides the button rather than offering a dead control.
 *
 * Holds ONE generation — the state before the most recent layout. Restore is
 * an undo of the last action, not a history.
 */
let restoreStash: StashedRect[] = []

export function hasRestoreStash(): boolean {
  return restoreStash.length > 0
}

/** Test seam: drop the stash between cases. */
export function clearRestoreStash(): void {
  restoreStash = []
}

function resolveBinaryPath(): string {
  return resolveHelper(WINDOW_LAYOUT_BIN)
}

/** One app to act on. A null frame reads the window's rect without moving it. */
interface NativeOp {
  bundleId: string
  frame: Rect | null
}

interface NativeResponse {
  ok: boolean
  applied?: { bundleId: string; before: Rect }[]
  failed?: { bundleId: string; error: string }[]
  error?: string
}

/**
 * Whether the user has macOS's tiled-window margins turned on.
 *
 * Read from com.apple.WindowManager so our split is pixel-identical to one
 * produced by the Window menu — a layout visibly different from the OS's own
 * reads as broken rather than as a separate feature. Absent key means off,
 * which is macOS's own default.
 *
 * Read once per process: it is a preference the user changes approximately
 * never, and a `defaults` spawn on every tap would be the more surprising cost.
 */
let cachedMargin: number | null = null

function tiledMargin(): number {
  if (cachedMargin !== null) return cachedMargin
  try {
    const out = spawnSync(
      'defaults',
      ['read', 'com.apple.WindowManager', 'EnableTiledWindowMargins'],
      { encoding: 'utf8', timeout: 1000 }
    )
    cachedMargin = out.stdout?.trim() === '1' ? TILED_MARGIN_PX : 0
  } catch {
    cachedMargin = 0
  }
  return cachedMargin
}

/**
 * The work area to lay out within, in Accessibility space.
 *
 * AX is top-left origin with y growing DOWN; Electron's screen API is already
 * in that space, so this is a straight read — no flip. (AppKit's NSScreen is
 * bottom-left and WOULD need one; using Electron here avoids that conversion
 * entirely, which is one fewer place to get top/bottom silently backwards.)
 *
 * Anchored on the screen holding the FIRST app's window, never the primary
 * display: tiling must not fling a window onto a different monitor. Falls back
 * to the primary display when the app's position is unknown.
 */
function workArea(anchor: Rect | null): Rect {
  const display =
    anchor === null
      ? screen.getPrimaryDisplay()
      : screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) })
  const { x, y, width, height } = display.workArea
  return { x, y, w: width, h: height }
}

/** Run the native binary. Returns null if it could not be run at all. */
function runNative(ops: NativeOp[]): NativeResponse | null {
  const bin = resolveBinaryPath()
  if (!existsSync(bin)) {
    devLog.warn(
      `[window-layout] binary not found at ${bin}. ` +
        `Run: cd native/window-layout && bash build.sh`
    )
    return null
  }
  try {
    const out = spawnSync(bin, [JSON.stringify({ ops })], {
      encoding: 'utf8',
      timeout: WINDOW_LAYOUT_TIMEOUT_MS
    })
    const line = out.stdout?.trim()
    if (!line) {
      devLog.warn('[window-layout] no output from binary')
      return null
    }
    return JSON.parse(line) as NativeResponse
  } catch (err) {
    devLog.warn('[window-layout] spawn failed', err)
    return null
  }
}

/**
 * Where an app's window is right now, or null if it has none.
 *
 * A null-frame op, so this reads without moving. Costs one extra spawn per
 * layout, which buys the display the window is actually on — Electron's screen
 * API has no per-window data, so without this a two-monitor setup would tile
 * every app onto the primary display.
 */
function currentRect(bundleId: string): Rect | null {
  const res = runNative([{ bundleId, frame: null }])
  return res?.applied?.[0]?.before ?? null
}

export interface WindowLayoutResult {
  ok: boolean
  /** Bundle ids that actually moved. */
  applied: string[]
  /** Bundle ids that did not, with the reason. */
  failed: { bundleId: string; error: string }[]
  /** Set when nothing could run at all (binary missing, AX untrusted). */
  error?: string
}

/**
 * Arrange one or two apps' windows.
 *
 * `bundleIds` is in slot order. A single-app layout uses slot 1 and leaves any
 * second app where it is — `left` on [Chrome, cmux] tiles Chrome and does not
 * touch cmux, which is what the sheet's UI promises.
 *
 * Never throws: a failed layout must not take down the phone-remote session.
 */
export function applyWindowLayout(
  kind: WindowLayoutKind,
  bundleIds: string[]
): WindowLayoutResult {
  if (kind === 'restore') return restoreWindows()

  if (bundleIds.length === 0) {
    return { ok: false, applied: [], failed: [], error: 'no-apps' }
  }
  if (isTwoAppLayout(kind) && bundleIds.length < 2) {
    return { ok: false, applied: [], failed: [], error: 'needs-two-apps' }
  }

  const area = workArea(currentRect(bundleIds[0]))
  const frames = computeLayout(kind, area, tiledMargin())

  // A single-app layout yields one frame even when two apps were offered, so
  // zip against the SHORTER of the two -- never index frames by bundleIds.
  const ops: NativeOp[] = frames.map((frame, i) => ({ bundleId: bundleIds[i], frame }))

  const res = runNative(ops)
  if (res === null) {
    return { ok: false, applied: [], failed: [], error: 'binary-failed' }
  }
  if (res.ok === false && res.applied?.length === 0) {
    return { ok: false, applied: [], failed: res.failed ?? [], error: res.error }
  }

  // Stash BEFORE-rects only for what actually moved, and only replace the
  // previous stash when something did -- a failed layout must not wipe a
  // usable Restore.
  const applied = res.applied ?? []
  if (applied.length > 0) {
    restoreStash = applied.map((a) => ({ bundleId: a.bundleId, rect: a.before }))
  }

  return {
    ok: applied.length > 0,
    applied: applied.map((a) => a.bundleId),
    failed: res.failed ?? []
  }
}

/** Put the last-moved windows back where they were. */
function restoreWindows(): WindowLayoutResult {
  if (restoreStash.length === 0) {
    return { ok: false, applied: [], failed: [], error: 'nothing-to-restore' }
  }
  const ops: NativeOp[] = restoreStash.map((s) => ({ bundleId: s.bundleId, frame: s.rect }))
  const res = runNative(ops)
  if (res === null) {
    return { ok: false, applied: [], failed: [], error: 'binary-failed' }
  }

  // Restore is one-shot: consumed whether or not every window came back, so a
  // second tap cannot re-apply a now-stale rect.
  restoreStash = []

  const applied = res.applied ?? []
  return {
    ok: applied.length > 0,
    applied: applied.map((a) => a.bundleId),
    failed: res.failed ?? []
  }
}
