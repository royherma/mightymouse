/**
 * Geometry for the minimap: the little screen-shaped frame that shows which
 * part of the Mac the glasses are looking at, and lets a thumb drag it there.
 *
 * The controller has NO video element -- the glasses are the screen, so the
 * phone is not mirroring locally and cannot measure anything. Every number here
 * therefore comes off the wire (`viewer.screenW/H`, the zoom the ring
 * published) rather than from a DOM measurement, which is also why this file is
 * pure: the App.tsx handler around it is DOM state no test can reach.
 *
 * The view rectangle is expressed as a normalized CENTRE point (0..1 in desktop
 * space), the same space `cursorPos` uses. That is deliberate -- it is what
 * travels over the wire, and it feeds the glasses' existing
 * `coverPanForCursor`, so the phone never owns a second pan rule that could
 * disagree with cursor-follow at the desktop edges.
 */

/** Longest edge of the frame, in CSS px. Small enough to sit in the corner
 *  without covering the pad it floats over, large enough that the view box at
 *  4x zoom (a quarter of each edge) is still a comfortable drag target. */
export const MINIMAP_MAX_EDGE_PX = 88

export interface MinimapFrame {
  width: number
  height: number
}

/**
 * The frame's box for a desktop of `screenW x screenH`, longest edge pinned to
 * MINIMAP_MAX_EDGE_PX so a 16:10 Mac and a 21:9 ultrawide both fit the same
 * corner.
 *
 * Falls back to 16:10 when the Mac hasn't reported bounds yet: the frame is a
 * decoration until the first `viewer` event lands, and a zero-sized or NaN box
 * is worse than a briefly-wrong aspect.
 */
export function minimapFrame(screenW: number, screenH: number): MinimapFrame {
  const w = screenW > 0 ? screenW : 16
  const h = screenH > 0 ? screenH : 10
  const scale = MINIMAP_MAX_EDGE_PX / Math.max(w, h)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

/**
 * The view rectangle's size as a FRACTION of the frame, at `scale` zoom.
 *
 * 1/scale, because zoom is how much the desktop is magnified: at 2x you see
 * half of each edge. Clamped to at most 1 (the whole screen at 1x) and to a
 * floor so the box stays grabbable at maximum zoom -- at 4x on an 88px frame
 * the honest box is 22px, which is under a fingertip.
 */
export function viewBoxFraction(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 1) return 1
  return Math.min(1, Math.max(0.18, 1 / scale))
}

/**
 * Where the view box's TOP-LEFT sits inside the frame, in px, for a view
 * centred on the normalized point `centre`.
 *
 * Clamped so the box never hangs off the frame: a centre of 0 means the view is
 * jammed against the left edge, which puts the box's left at 0 -- not at
 * -half-a-box. This is the same "you cannot pan past the desktop edge" rule the
 * glasses enforce with `coverPanLimits`, expressed in minimap space.
 */
export function viewBoxOffset(
  frame: MinimapFrame,
  fraction: number,
  centre: { x: number; y: number }
): { left: number; top: number; width: number; height: number } {
  const width = frame.width * fraction
  const height = frame.height * fraction
  const left = Math.min(frame.width - width, Math.max(0, centre.x * frame.width - width / 2))
  const top = Math.min(frame.height - height, Math.max(0, centre.y * frame.height - height / 2))
  return { left, top, width, height }
}

/**
 * Turn a touch at (`px`, `py`) inside the frame into the normalized desktop
 * point the view should centre on.
 *
 * The touch is taken as the CENTRE of the view rather than its top-left, so the
 * box lands under the thumb rather than down-right of it. The clamp is
 * expressed in centre space -- at 2x zoom the reachable centres run 0.25..0.75,
 * because centring any closer to an edge would show desktop that isn't there.
 * Returning an unreachable centre would let the minimap ask for a pan the
 * glasses then silently clamp, and the box would spring back under the finger.
 */
/**
 * Should the minimap be on screen?
 *
 * Zoomed in, always: that is when "which part am I seeing" is a real question.
 * Back at 1x it has no answer left to give -- the view IS the screen -- so it
 * leaves. But not on the instant: `lingering` holds it through the dwell after
 * the return to 1x, so the user watches the box grow to fill the frame instead
 * of watching it vanish mid-zoom-out. A 3x→1x change is the moment the widget
 * is most worth seeing, and hiding on the same tick is the one way to miss it.
 *
 * Pure for the same reason as `shouldShowDelayed` -- this repo's vitest runs
 * `environment: 'node'`, so the timer/state hook around it can't be driven in a
 * test but the decision can.
 */
export function minimapVisible(zoomed: boolean, lingering: boolean): boolean {
  return zoomed || lingering
}

export function panPointFromTouch(
  frame: MinimapFrame,
  fraction: number,
  px: number,
  py: number
): { x: number; y: number } {
  const half = fraction / 2
  const lo = Math.min(0.5, half)
  const hi = Math.max(0.5, 1 - half)
  const nx = frame.width > 0 ? px / frame.width : 0.5
  const ny = frame.height > 0 ? py / frame.height : 0.5
  return {
    x: Math.min(hi, Math.max(lo, nx)),
    y: Math.min(hi, Math.max(lo, ny))
  }
}
