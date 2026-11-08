/**
 * Zoom level ↔ percent math.
 *
 * Electron's zoom LEVEL is logarithmic: factor = 1.2^level. Level 0 is 100%,
 * each +1 multiplies the rendered size by 1.2, each -1 divides by it. That's
 * unreadable in a UI, so the indicator shows a PERCENT — this module is the one
 * place that converts, shared by the renderer (display) and any caller that
 * needs to reason about the two.
 *
 * Kept out of the components layer so the math is unit-testable on its own.
 */

// The base Electron/Chromium uses for the level→factor curve. Not a knob — it's
// fixed by the platform; changing it would just make our percent lie.
const ZOOM_BASE = 1.2

/** Electron zoom level → display percent (level 0 → 100). Rounded to a whole %. */
export function zoomLevelToPercent(level: number): number {
  return Math.round(ZOOM_BASE ** level * 100)
}

/** Display percent → the Electron zoom level that renders it. Inverse of the above. */
export function zoomPercentToLevel(percent: number): number {
  return Math.log(percent / 100) / Math.log(ZOOM_BASE)
}
