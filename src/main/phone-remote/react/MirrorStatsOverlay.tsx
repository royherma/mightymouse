/**
 * The bench numbers, painted over the mirrored picture itself.
 *
 * Exists because every other readout is unreadable during the run that matters:
 * the dev log is on the Mac behind you, the phone is in your pocket, and the
 * glasses show only the mirror. "It got choppy toward the end" could not be
 * joined to a number by anyone wearing them.
 *
 * Debug-only, gated on mirrorStatsOverlayEnabled() -- see that module for why
 * this is a build input rather than a constant or a user-facing toggle.
 *
 * Cursorless hosts ONLY, on top of that flag. The phone shows the same mirror
 * and is the device you can just look at, so there the numbers are pure
 * occlusion over the picture being judged -- and a build:phone-remote is also
 * what serves Roy's own phone while iterating, so "debug build" alone is not a
 * narrow enough gate.
 */

import { elapsed, stamp, type BenchSummary } from './mirror-bench'
import { useCursorless } from './cursorless-host'
import { mirrorStatsOverlayEnabled } from './mirror-stats-flag'

/** The rig's own state, as opposed to the picture's. Every field is nullable
 *  because each arrives on its own channel at its own moment -- the Mac's
 *  battery on a host-status push, the link figures on a stats poll, the glasses
 *  row only once DAT has said something. A missing field prints `--` rather
 *  than collapsing the row, so "not reported yet" stays distinguishable from
 *  "reported as zero" (the same distinction incomingEstimateKbps returns -1
 *  for). */
export interface MirrorRigStatus {
  /** The MAC's battery, not the phone's or the glasses'. It is the machine
   *  doing the encoding, so it is the one whose battery ending ends the run. */
  macBatteryPct: number | null
  macCharging: boolean
  rttMs: number
  jitterMs: number
  /** Local ICE candidate type: `host` means the phone and Mac found each other
   *  on the same network, `relay` means everything is going through the tunnel.
   *  A ~10x difference in what the link can carry, and nothing else on the HUD
   *  distinguishes them. */
  route: string
  /** Glasses link state, thermal level and name, straight from DAT. Null until
   *  the SDK reports -- which on a phone with no glasses paired is forever. */
  glassesLink: string | null
  glassesThermal: string | null
  glassesName: string | null
  /** DAT's only battery signal. Not a percentage: the SDK does not expose one
   *  (DeviceState carries thermalLevel alone), so this is the single moment it
   *  says anything about the battery -- as the error ending the session. */
  glassesBatteryCritical: boolean
}

export interface MirrorStatsOverlayProps {
  /** Null until the first poll lands, and while the run is too short to judge
   *  (the bench refuses a verdict under 2s). Rendered as a placeholder rather
   *  than hidden, so "the overlay is on but empty" stays distinguishable from
   *  "the overlay never mounted" -- the same ambiguity that made a whole
   *  haptics round unreadable on device. */
  summary: BenchSummary | null
  /** Encoder-side link estimate, kbps. Separate from the summary because it is
   *  measured on the SENDING side: a picture can be smooth at 200k or stuttering
   *  at 900k, and only the pair says which problem you are looking at. */
  estimateKbps: number | null
  /** Frontmost app on the Mac, which is WHAT is being captured. Screen capture
   *  emits only on change, so the same numbers mean different things depending
   *  on the source -- a video player and a text editor produce opposite freeze
   *  figures while both working correctly. Null before the first context
   *  reading lands. */
  appName: string | null
  /** Handle for THIS mirror session, so a spoken report ("#K7QW was choppy")
   *  joins to the BENCH log lines, which carry the same code. Null before the
   *  first session starts. */
  sessionCode: string | null
  /** The opposite column. Null keeps it unmounted entirely rather than printing
   *  a column of dashes over the picture being judged. */
  rig: MirrorRigStatus | null
}

/** Two short lines rather than one long one: at glasses resolution a single row
 *  runs past the readable width, and the eye reads the headline (is it smooth)
 *  separately from the diagnosis (why not). */
export function MirrorStatsOverlay({
  summary,
  estimateKbps,
  appName,
  sessionCode,
  rig
}: MirrorStatsOverlayProps): React.JSX.Element | null {
  // Before the gate: a hook cannot sit after an early return, and the verdict
  // is live (see cursorless-host -- the glasses size their frame after load, so
  // reading it once at import latched the wrong answer).
  const cursorless = useCursorless()
  if (!mirrorStatsOverlayEnabled() || !cursorless) return null

  const kbps = estimateKbps === null ? '--' : `${estimateKbps}k`
  // Active seconds, not elapsed: screen capture emits nothing while the screen
  // is static, so a freeze figure divided by wall time flatters a run spent
  // reading. Printed alongside so two readings can be checked for
  // comparability before being compared at all.
  const body = summary
    ? [
        `${summary.avgFps.toFixed(1)}fps ${summary.resolution}`,
        `frz ${summary.freezeCount}/${summary.freezeSeconds.toFixed(1)}s ` +
          `lost ${summary.lostPct.toFixed(1)}% stall ${summary.droppedFrames} ${kbps} ` +
          `act ${Math.round(summary.activeRatio * 100)}%`
      ]
    : ['warming up', `${kbps}`]

  // Session length beside the wall clock. The clock says WHEN a reading was
  // taken; only this says how deep into the run it was, which is the axis
  // "it degrades toward the end" is actually reported on. It counts from the
  // first stats poll -- the mirror session, not the page load.
  const since = summary ? elapsed(summary.elapsedS) : '0:00'

  // App name leads: it is the one field that says what the other numbers are
  // measuring. Truncated because a long window title would push the fps figure
  // off the readable width, and only the app is needed to tell runs apart.
  const app = appName ? appName.slice(0, 14) : '--'

  return (
    <>
      <div className="mirrorStatsOverlay" aria-hidden="true">
        <div>
          {/* Leads the line and carries its own class: it is the one field read
              ALOUD rather than compared, so it has to survive a glance at
              glasses resolution where the rest only has to be legible on a
              re-read. */}
          <span className="mirrorStatsCode">#{sessionCode ?? '----'}</span> {app} {stamp()} +
          {since}
        </div>
        <div>{body[0]}</div>
        <div>{body[1]}</div>
      </div>
      {rig ? <RigColumn rig={rig} /> : null}
    </>
  )
}

/** `--` for anything the source has not reported. The sentinel is -1 rather
 *  than 0 throughout the stats helpers, because 0ms rtt and 0kbps are both
 *  plausible-looking readings that mean the opposite of what they say. */
function num(value: number, unit: string): string {
  return value < 0 ? '--' : `${value}${unit}`
}

/** The rig column: battery, link, route, glasses. One concern per row, in the
 *  order a run actually fails -- the Mac dying, the link degrading, the route
 *  being the tunnel, the glasses overheating. Each row is prefixed with a
 *  three-letter tag so a line is self-labelling at glasses resolution, where
 *  there is no room for a legend and no way to ask what a bare number was. */
function RigColumn({ rig }: { rig: MirrorRigStatus }): React.JSX.Element {
  const bat = rig.macBatteryPct === null ? '--' : `${rig.macBatteryPct}%`
  const glasses = rig.glassesLink
    ? `gls ${rig.glassesLink} ${rig.glassesThermal ?? '--'}` +
      (rig.glassesName ? ` ${rig.glassesName.slice(0, 10)}` : '')
    : null

  return (
    <div className="mirrorStatsOverlay mirrorStatsOverlayRight" aria-hidden="true">
      <div>
        bat {bat}
        {rig.macCharging ? ' +' : ''}
      </div>
      <div>
        net {num(rig.rttMs, 'ms')} {num(rig.jitterMs, 'ms')}
      </div>
      <div>via {rig.route}</div>
      {glasses ? (
        // Warn colour covers thermal AND battery on one row: both mean the same
        // thing to the wearer -- the glasses are about to end the run -- and a
        // separate colour per cause would be two things to learn for one action.
        <div className={rig.glassesBatteryCritical ? 'mirrorStatsWarn' : undefined}>
          {glasses}
          {rig.glassesBatteryCritical ? ' bat crit' : ''}
        </div>
      ) : null}
    </div>
  )
}
