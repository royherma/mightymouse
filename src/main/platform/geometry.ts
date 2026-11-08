// window-layout-geometry.ts — pure frame math for Phone Remote's window layouts.
//
// Split out from window-layout.ts so it can be tested without Electron, AX
// permission, or a spawn: every function here is (screen, kind) -> rects.
//
// COORDINATE SPACE: everything here is Accessibility space — origin top-left,
// y growing DOWNWARD. That is what AXUIElementSetAttributeValue expects. It is
// NOT AppKit's bottom-left space, and it is not Electron's. The caller converts
// once, at the NSScreen read, and nothing downstream re-derives it. Getting
// this backwards flips top/bottom layouts silently on a single-screen Mac and
// only looks wrong once someone tries Top vs Bottom.

import type { WindowLayoutKind } from '../../shared/phone-remote-protocol'

export type { WindowLayoutKind }

/** A window rect in Accessibility space (top-left origin, y grows down). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Every kind, so a value off the wire can be checked before it reaches AX. */
const ALL_KINDS: ReadonlySet<string> = new Set<WindowLayoutKind>([
  'left',
  'right',
  'top',
  'bottom',
  'full',
  'leftRight',
  'topBottom',
  'quarters',
  'restore'
])

export function isWindowLayoutKind(value: unknown): value is WindowLayoutKind {
  return typeof value === 'string' && ALL_KINDS.has(value)
}

/** Layouts that arrange TWO apps and therefore need a second bundle id. */
const TWO_APP_KINDS: ReadonlySet<WindowLayoutKind> = new Set<WindowLayoutKind>([
  'leftRight',
  'topBottom',
  'quarters'
])

export function isTwoAppLayout(kind: WindowLayoutKind): boolean {
  return TWO_APP_KINDS.has(kind)
}

/**
 * Gap between tiled windows, and between a window and the screen edge.
 *
 * macOS's own tiling reads `EnableTiledWindowMargins` from
 * com.apple.WindowManager and insets by ~8pt when it is on. We match whatever
 * the user has set so a split from the phone is pixel-identical to one from the
 * Window menu — a layout that is visibly different from the OS's own is the
 * kind of detail that reads as broken rather than as a separate feature.
 */
export const TILED_MARGIN_PX = 8

/**
 * Tolerance when comparing a requested rect against what actually landed.
 *
 * Apps clamp to their own minimum and increment sizing: asked for a height of
 * 1006, Finder took 1005 (measured 2026-08-16). An exact comparison therefore
 * reports false failures, and — worse — invites a "corrective" resize that the
 * app clamps again, forever. Verify within tolerance; never re-issue.
 */
export const FRAME_TOLERANCE_PX = 2

/**
 * Split `total` into two parts at the midpoint, accounting for the margin
 * BETWEEN them.
 *
 * Returned as a pair because an odd remainder has to land somewhere: the first
 * part takes the extra pixel. Splitting 1728 with an 8px margin gives 860/860,
 * and 1729 gives 861/860 — never 860.5, which AX would round unpredictably per
 * app and leave a hairline of desktop showing between two "adjacent" windows.
 */
function halve(total: number, margin: number): [number, number] {
  const usable = total - margin
  const first = Math.ceil(usable / 2)
  return [first, usable - first]
}

/**
 * Compute the frames for a layout.
 *
 * `visible` is the screen's visible frame already converted to AX space (menu
 * bar and Dock excluded). `margin` is 0 when the user has tiled-window margins
 * off, TILED_MARGIN_PX when on.
 *
 * Returns one rect per app slot, in slot order. A single-app layout returns one
 * rect even when two apps were offered — `left` acts on slot 1 and leaves slot
 * 2 where it is, which is what the sheet's UI promises.
 *
 * `restore` returns an empty array: it is not computed geometry, it replays the
 * rects stashed before the last layout. Handled by the caller, listed in the
 * union so the exhaustiveness check covers it.
 */
export function computeLayout(
  kind: WindowLayoutKind,
  visible: Rect,
  margin: number
): Rect[] {
  // Inset the whole work area first, so an edge margin applies to every layout
  // without each branch repeating it.
  const x = visible.x + margin
  const y = visible.y + margin
  const w = visible.w - margin * 2
  const h = visible.h - margin * 2

  const [leftW, rightW] = halve(w, margin)
  const [topH, bottomH] = halve(h, margin)
  const rightX = x + leftW + margin
  const bottomY = y + topH + margin

  switch (kind) {
    case 'full':
      return [{ x, y, w, h }]
    case 'left':
      return [{ x, y, w: leftW, h }]
    case 'right':
      return [{ x: rightX, y, w: rightW, h }]
    case 'top':
      return [{ x, y, w, h: topH }]
    case 'bottom':
      return [{ x, y: bottomY, w, h: bottomH }]
    case 'leftRight':
      return [
        { x, y, w: leftW, h },
        { x: rightX, y, w: rightW, h }
      ]
    case 'topBottom':
      return [
        { x, y, w, h: topH },
        { x, y: bottomY, w, h: bottomH }
      ]
    // Two apps across the TOP two quadrants, not four quadrants: the sheet only
    // ever holds two apps, so the bottom row would be empty desktop. This is
    // "each app gets a quarter-height strip up top" — the shape you want when
    // you are also looking at something else full-width below.
    case 'quarters':
      return [
        { x, y, w: leftW, h: topH },
        { x: rightX, y, w: rightW, h: topH }
      ]
    case 'restore':
      return []
    default: {
      // Exhaustiveness: adding a kind without a branch fails the build here
      // rather than silently returning nothing at runtime.
      const never: never = kind
      throw new Error(`unhandled window layout: ${String(never)}`)
    }
  }
}

/** Whether an applied rect matches what was requested, within tolerance. */
export function framesMatch(requested: Rect, actual: Rect): boolean {
  return (
    Math.abs(requested.x - actual.x) <= FRAME_TOLERANCE_PX &&
    Math.abs(requested.y - actual.y) <= FRAME_TOLERANCE_PX &&
    Math.abs(requested.w - actual.w) <= FRAME_TOLERANCE_PX &&
    Math.abs(requested.h - actual.h) <= FRAME_TOLERANCE_PX
  )
}
