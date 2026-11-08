/**
 * Is the debug stats overlay painted over the mirrored picture?
 *
 * A BUILD input, not a constant anyone edits: it used to be a literal in
 * CONFIG.PHONE_REMOTE that a measuring run flipped to `true` and someone had to
 * remember to flip back. The guard test could only catch that by failing the
 * whole suite for whoever was still measuring, so the two needs -- "measure on
 * device" and "never ship it on" -- were in direct conflict. Now they are not:
 *
 *   npm run build:phone-remote           # ON. Iterating here always wants it.
 *   npm run build                        # OFF, via build:phone-remote:release
 *
 * ON by default because a bare build:phone-remote is always someone working in
 * this directory. Releases opt OUT explicitly and every packaged target funnels
 * through `npm run build`, so a shipped bundle cannot pick the overlay up by
 * omission -- mirror-stats-overlay.test.ts locks all three links of that chain.
 *
 * IS_DEV cannot answer this. Dev and packaged BOTH serve a `vite build` output
 * to a phone Safari tab that has no `process`, so IS_DEV is false in the bundle
 * either way and the overlay would never turn on even while measuring.
 *
 * The typeof guard is for vitest, which imports this module directly and does
 * not run vite's `define` -- an unguarded read throws ReferenceError at import
 * and takes down every test in the file. It also means the flag reads false
 * under test regardless of what a real build does, which is why the release
 * guard asserts on the build chain's source rather than calling this.
 */
export function mirrorStatsOverlayEnabled(): boolean {
  return typeof __MIRROR_STATS_OVERLAY__ !== 'undefined' && __MIRROR_STATS_OVERLAY__
}
