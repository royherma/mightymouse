/**
 * The 0-1 progress ring, and its number, drawn wherever a session or card
 * reports how far along it is.
 *
 * Shared because five surfaces render it across two bundles -- the phone's
 * `SessionList` and `RelayCard`, the Electron panel's `CodePanel`, and the swipe
 * deck both hosts mount. A per-surface copy of an SVG arc is exactly how two
 * lists end up disagreeing about what 43% looks like.
 *
 * A ring in its OWN slot, never around the avatar. The user rejected the overlay on
 * sight: agent faces are not all circles, so a ring around one
 * reads as a rendering mistake rather than a measurement. The ring sits beside
 * the number instead, which also makes it legible at 13px -- the overlay had to
 * be avatar-sized and could never carry text.
 *
 * A ring and its number on every surface, with no linear-bar variant anywhere.
 * The detail sheet had one and the user cut it: a full-width bar spends
 * a whole row of a phone sheet on the number the compact meter already carries.
 *
 * Hosts pass their own class names, same contract as `relay-interview-nav.tsx`:
 * the phone is camelCase and the Mac is hyphenated, so any single convention
 * would have made one of them wrong.
 */

import type { JSX } from 'react'
import { relayProgressBand, relayProgressPct } from './relay-progress'

export interface ProgressRingClasses {
  /** The <svg> itself -- positioned by the host over its avatar. */
  ring: string
  /** The full-circle track under the arc. */
  track: string
  /** The arc. The host bands its colour off `data-band`. */
  arc: string
}

export const PHONE_RING_CLASSES: ProgressRingClasses = {
  ring: 'progressRing',
  track: 'progressRingTrack',
  arc: 'progressRingArc'
}

export const MAC_RING_CLASSES: ProgressRingClasses = {
  ring: 'progress-ring',
  track: 'progress-ring-track',
  arc: 'progress-ring-arc'
}

/** Ring thickness. 2px is the smallest stroke that still reads as an arc at the
 *  13px the compact slot uses; 1px disappears against the track. */
const STROKE = 2

/** The compact ring's diameter. Sized to a line of text, not to an avatar -- it
 *  sits beside the percentage, so it has to match the number's cap height. */
export const PROGRESS_DOT_SIZE = 13

export function ProgressRing({
  value,
  size,
  classes,
  stroke = STROKE,
  indeterminate = false
}: {
  value: number
  size: number
  classes: ProgressRingClasses
  stroke?: number
  indeterminate?: boolean
}): JSX.Element | null {
  if (indeterminate) {
    const r = (size - stroke) / 2
    const circumference = 2 * Math.PI * r
    const arc = circumference / 4
    return (
      <svg
        className={classes.ring}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        data-spin=""
        aria-hidden="true"
      >
        <circle
          className={classes.track}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className={classes.arc}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference - arc}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    )
  }

  const band = relayProgressBand(value)
  // Out of range renders NOTHING rather than clamping to a full or empty ring:
  // a bad number drawn as 100% is a lie someone plans their day around.
  if (!band) return null

  // Inset by half the stroke so the arc's outer edge lands on the box, not
  // half-outside it -- SVG strokes straddle the path.
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  return (
    <svg
      className={classes.ring}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle
        className={classes.track}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
      />
      <circle
        className={classes.arc}
        data-band={band}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - value)}
        // Starts at 12 o'clock. An SVG arc starts at 3 o'clock by default, which
        // reads as an already-running ring rather than one filling from empty.
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

export interface ProgressMeterClasses extends ProgressRingClasses {
  /** The wrapper holding the ring and its number on one line. The host bands
   *  its text colour off `data-band`, so the number matches the arc. */
  meter: string
}

export const PHONE_METER_CLASSES: ProgressMeterClasses = {
  ...PHONE_RING_CLASSES,
  meter: 'codeProgressMeter'
}

export const MAC_METER_CLASSES: ProgressMeterClasses = {
  ...MAC_RING_CLASSES,
  meter: 'code-progress-meter'
}

/**
 * The ring AND its percentage, which is the pairing every compact surface wants.
 *
 * Exists because four call sites across two bundles were about to hand-roll the
 * same `<span><ProgressRing/>52%</span>`, and the fourth would have got the gap
 * or the aria label subtly different. The number is what makes the ring
 * checkable against an agent's "3 of 7" in the body; the ring is what makes it
 * readable at a glance. Neither is worth shipping alone at this size.
 */
export function ProgressMeter({
  value,
  classes,
  size = PROGRESS_DOT_SIZE
}: {
  value: number
  classes: ProgressMeterClasses
  size?: number
}): JSX.Element | null {
  const band = relayProgressBand(value)
  // Same posture as the ring and the bar: out of range draws nothing at all.
  if (!band) return null
  const pct = relayProgressPct(value)
  return (
    <span className={classes.meter} data-band={band} title={`${pct}% of the way through`}>
      <ProgressRing value={value} size={size} classes={classes} />
      {pct}%
    </span>
  )
}
