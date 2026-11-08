/**
 * The 0-1 progress number's shared vocabulary: three bands, and the one
 * function that maps a number to one.
 *
 * In `shared/` rather than `agent-relay/store.ts` because FOUR bundles band the
 * same number -- Electron main, the renderer, the phone's React bundle and the
 * tests -- and a renderer that imported the main-process store would pull node
 * builtins into a browser bundle.
 */

// Three named bands, not a continuous gradient: a smear reads as one colour at
// a glance, where "amber" is a state someone can say out loud. Green is NOT
// reserved for 1.0 -- 0.9 should feel nearly-there, and `state: 'done'` is the
// field that says finished. Data, not CSS: the renderer and the phone have
// separate token systems (THEME_TOKENS vs theme.css :root), so each surface maps
// these names to its own colours rather than sharing one var across two bundles.
export const RELAY_PROGRESS_BANDS = [
  { min: 0, band: 'early' },
  { min: 0.34, band: 'underway' },
  { min: 0.67, band: 'near' }
] as const

export type RelayProgressBand = (typeof RELAY_PROGRESS_BANDS)[number]['band']

/** The one place a number becomes a colour. Returns null for anything unusable
 *  -- out of range, NaN, absent -- so every surface DROPS the indicator on a bad
 *  value instead of drawing a clamped one. A bar showing 100% because someone
 *  sent 1.4 is worse than no bar at all. */
export function relayProgressBand(value: number | undefined | null): RelayProgressBand | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null
  let band: RelayProgressBand = 'early'
  for (const step of RELAY_PROGRESS_BANDS) if (value >= step.min) band = step.band
  return band
}

/** What a surface prints next to the ring where there is room for text. Rounded,
 *  never truncated: 0.999 is "100%" to a person and "99%" is pedantry. */
export function relayProgressPct(value: number): number {
  return Math.round(value * 100)
}
