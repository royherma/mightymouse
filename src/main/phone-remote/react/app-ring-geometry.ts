import { CONFIG } from '@shared/config'

// The app ring: a quarter-arc centered on the cluster's outer corner, scrubbed
// by finger angle to pick an app from the MRU list. Centering on the corner is
// what makes it a band around the buttons, not a stripe beside them.
//
// Pure geometry, no DOM -- the caller measures, this file only does arithmetic.

/** Where the cluster's corner sits, and how far the arc must clear it. */
export type RingAnchor = {
  /** Pad-local px of the cluster corner the arc is centered on. */
  cx: number
  cy: number
  /** How far the controls extend from that corner, per axis. The arc rides
   *  outside the SHORTER of the two -- see ringBand for why the longer one
   *  cannot bind. */
  clusterX: number
  clusterY: number
  /** How far the arc may sweep from the corner, per axis. NOT a box size: a
   *  landscape pad is one column of a wider card, so a width would credit room
   *  across the mirror pane the arc can never reach. */
  reachX: number
  reachY: number
  /** The pad's own size. Caps the radius at a fraction of it, so the arc stays
   *  a ring in its corner instead of a stripe across the drag area. */
  padW: number
  padH: number
  /** Which edge the cluster hugs. On the anchor, not a second arg: two args
   *  that must agree is how a quadrant bug starts. */
  keysPosition: 'top' | 'bottom'
}

/** Horizontal direction the arc runs from the corner. The corner is the pad's
 *  OUTER one, so the sweep is always inward. */
const ringSignX = (mirrored: boolean): number => (mirrored ? 1 : -1)

/** Vertical direction: away from the edge the cluster hugs. */
const ringSignY = (anchor: RingAnchor): number => (anchor.keysPosition === 'top' ? 1 : -1)

export type RingBand = {
  /** Centerline radius, in px. ONE radius -- the ring is a CIRCLE and that is
   *  settled; never add rx/ry. Unequal legs make two radii the obvious
   *  arithmetic, and it reads as a diagonal stripe (`make why Q="app ring"`). */
  radius: number
  /** Stroke width, in px. */
  band: number
  /** Hit range in px, measured from the corner. */
  rMin: number
  rMax: number
}

/** Where the band sits: a circle in the cluster's corner, capped so it never
 *  crosses the pad. Null only when the pad is too small for a band at all. */
export function ringBand(anchor: RingAnchor): RingBand | null {
  const { clusterX, clusterY, reachX, reachY, padW, padH } = anchor
  const band = CONFIG.PHONE_REMOTE.APP_RING_BAND_PX
  const gap = CONFIG.PHONE_REMOTE.APP_RING_GAP_PX
  const half = band / 2
  // The PAD sets the size, not the cluster -- one settled size whatever happens
  // to be showing. Sizing to the buttons let the context bar resize the ring.
  const want = Math.min(padW, padH) * CONFIG.PHONE_REMOTE.APP_RING_MAX_PAD_FRAC
  // The LONGER leg binds: a circle clearing only the near one cuts through the
  // far one, which is where the buttons are.
  const wrap = Math.max(clusterX, clusterY) + gap + half
  // The pad edge binds last: half the stroke straddles past the centerline.
  const room = Math.min(reachX, reachY) - half
  // Clearing the buttons is the floor, but the edge still wins when both cannot
  // hold -- clipped beats absent, and the far end is over an empty corner.
  const radius = Math.min(Math.max(want, wrap), room)
  // Below a band's width there is nothing to draw that wouldn't read as a glitch.
  if (radius < band) return null
  return { radius, band, rMin: radius - half, rMax: radius + half }
}

/** The zoom track: a band on the same centre as the app ring, scrubbing the
 *  picture on a connected pair of glasses. Null when the pad has no room.
 *
 *  **Independent of the app ring, on purpose.** `APP_RING_DEFAULT` is false, so
 *  tying zoom to the switcher would hide it from everyone who never turned the
 *  switcher on -- and zoom answers a question the switcher does not. It takes
 *  the app band only to sit OUTSIDE it when there is one; passed null it owns
 *  the corner alone at the same radius the app ring would have taken, so the
 *  pad looks deliberate either way rather than like a ring with a missing half.
 *
 *  Nothing here shrinks the app ring to make room. `ringBand` already caps its
 *  radius at the pad edge, so room reclaimed by shrinking the inner band is
 *  room the outer one is already past -- the shrink buys a track that is itself
 *  clipped. Absent beats clipped, the same call `ringBand` makes at its floor. */
export function ringZoomBand(anchor: RingAnchor, app: RingBand | null): RingBand | null {
  const band = CONFIG.PHONE_REMOTE.RING_ZOOM_BAND_PX
  const half = band / 2
  // Outside the app ring when it is up; in its place when it is not.
  const radius = app
    ? app.rMax + CONFIG.PHONE_REMOTE.RING_ZOOM_GAP_PX + half
    : soloZoomRadius(anchor, band)
  // The pad edge binds exactly as it does for the app ring: half the stroke
  // straddles past the centerline, so the outer edge is what must fit.
  if (radius + half > Math.min(anchor.reachX, anchor.reachY)) return null
  if (radius < band) return null
  return { radius, band, rMin: radius - half, rMax: radius + half }
}

/** Radius for a zoom track with no app ring under it. Mirrors `ringBand`'s own
 *  arithmetic -- the pad sets the size, the cluster sets the floor -- so the
 *  track lands where the eye already expects a ring in this corner. */
/** Where the zoom track sits when the app ring is NOT painted.
 *
 *  Deliberately the app ring's own radius plus the gap -- the SAME place it
 *  takes when the ring is up, rather than sliding inward to fill the empty
 *  corner. The switcher is off for most users and can be toggled mid-session,
 *  so a radius that depended on it would move this control under the thumb
 *  (Roy, on device). `ringBand` is the one definition of that radius; this
 *  reads it rather than restating the arithmetic, which is how the two drifted
 *  apart the first time. */
function soloZoomRadius(anchor: RingAnchor, band: number): number {
  const half = band / 2
  const app = ringBand(anchor)
  const room = Math.min(anchor.reachX, anchor.reachY) - half
  if (!app) {
    const want = Math.min(anchor.padW, anchor.padH) * CONFIG.PHONE_REMOTE.APP_RING_MAX_PAD_FRAC
    const wrap =
      Math.max(anchor.clusterX, anchor.clusterY) + CONFIG.PHONE_REMOTE.APP_RING_GAP_PX + half
    return Math.min(Math.max(want, wrap), room)
  }
  return Math.min(app.rMax + CONFIG.PHONE_REMOTE.RING_ZOOM_GAP_PX + half, room)
}

/** How much of the zoom track each end gives up, as a fraction of the quarter.
 *  In ARC PX at the band's own radius: what must clear the pad edge is the
 *  knob, which is a fixed size. Capped at a third so a tiny band insets to a
 *  stub rather than inverting. The app ring deliberately does NOT do this --
 *  its ends are slots, caught by `ringHitBox`'s overhang; this end is a value,
 *  so the fix is to move the value inward. */
export function ringZoomEndInsetT(band: RingBand): number {
  const arcPx = band.radius * (Math.PI / 2)
  if (arcPx <= 0) return 0
  return Math.min(1 / 3, CONFIG.PHONE_REMOTE.RING_ZOOM_END_INSET_PX / arcPx)
}

/** Track position for a zoom `t`, inset from both arc ends. The ONE place the
 *  inset is applied -- paint and hit-test both route through it, so what the
 *  eye sees and what the thumb means cannot disagree. */
export function ringZoomTrackT(t: number, band: RingBand): number {
  const inset = ringZoomEndInsetT(band)
  return inset + clamp01(t) * (1 - inset * 2)
}

/** Inverse of `ringZoomTrackT`: an arc position back to a zoom `t`. A thumb in
 *  either inset end clamps to that extreme, which is what makes the gap read as
 *  the end of the range rather than as a dead strip. */
export function ringZoomTrackTInverse(trackT: number, band: RingBand): number {
  const inset = ringZoomEndInsetT(band)
  const span = 1 - inset * 2
  if (span <= 0) return 0
  return clamp01((trackT - inset) / span)
}

/** Normalized track position (0..1) for a zoom scale, and back.
 *
 *  LINEAR, matching `ZoomBar`'s `pct` exactly. A log map spends the arc more
 *  evenly across the perceived change and was the first instinct here, but the
 *  bar is the shipped, tuned control and two zoom surfaces that disagree about
 *  where 2x sits are two derivations of one decision -- the bug this directory
 *  has already had three times. If the mapping ever changes it changes in both,
 *  or in one shared helper.
 *
 *  Clamped, so a thumb dragged past either arc end pins to the extreme rather
 *  than computing an out-of-range scale. */
export function ringZoomT(scale: number): number {
  const { MIRROR_ZOOM_MIN: min, MIRROR_ZOOM_MAX: max } = CONFIG.PHONE_REMOTE
  if (max <= min) return 0
  return clamp01((scale - min) / (max - min))
}

export function ringZoomScale(t: number): number {
  const { MIRROR_ZOOM_MIN: min, MIRROR_ZOOM_MAX: max } = CONFIG.PHONE_REMOTE
  return min + clamp01(t) * (max - min)
}

/** A touch, in pad-local px. */
export type RingPoint = { x: number; y: number }

/** The band's hit area: a card-local box over the arc's quarter, clipped to the
 *  annulus and grown by the grab slack so it matches `onRing` exactly. Clipped
 *  because it sits ABOVE the pad -- a plain square would eat a quarter-disc of
 *  trackpad (`make why Q="ring hit layer"`). */
export function ringHitBox(
  anchor: RingAnchor,
  band: RingBand,
  mirrored: boolean,
  slack: number = CONFIG.PHONE_REMOTE.APP_RING_GRAB_SLACK_PX
): { left: number; top: number; width: number; height: number; clipPath: string } {
  const outer = band.rMax + slack
  const inner = Math.max(0, band.rMin - slack)
  // Past the anchor on BOTH legs, because `ringPolar` clamps a touch beyond an
  // arc end back onto it (`Math.max(0, …)`) and `onRing` then accepts it. A box
  // that stopped at the anchor left the outer ~32px of slot 0 -- the stroke
  // plus its slack, below cy -- with no layer above it, so the pad conceded by
  // radius to a touch nothing else received. That is the dead-slot bug; the
  // overhang is what makes the two agree on the same region.
  const over = band.band / 2 + slack
  // The arc spans corner-to-corner of this square: one leg along each axis,
  // both running from the anchor in the sweep's direction, plus the overhang.
  const left = mirrored ? anchor.cx - over : anchor.cx - outer
  const top = anchor.keysPosition === 'top' ? anchor.cy - over : anchor.cy - outer
  // The anchor's position INSIDE the box -- the arc's centre is always one of
  // its four corners, picked by the same two axes as everything else here.
  const ax = mirrored ? over : outer
  const ay = anchor.keysPosition === 'top' ? over : outer
  // evenodd, so the inner disc punches a hole: a filled quarter-disc would
  // cover the cluster corner the radius exists to clear.
  const clipPath =
    `path(evenodd, "M ${round(ax - outer)} ${round(ay)} a ${round(outer)} ${round(outer)} 0 1 0 ${round(outer * 2)} 0 ` +
    `a ${round(outer)} ${round(outer)} 0 1 0 ${round(-outer * 2)} 0 Z ` +
    `M ${round(ax - inner)} ${round(ay)} a ${round(inner)} ${round(inner)} 0 1 0 ${round(inner * 2)} 0 ` +
    `a ${round(inner)} ${round(inner)} 0 1 0 ${round(-inner * 2)} 0 Z")`
  return { left, top, width: outer + over, height: outer + over, clipPath }
}

/** A touch relative to the arc's center: `dist` in px from the corner, `t`
 *  normalized to the quarter. Takes the band it never reads, so this and the
 *  onRing test that always follows cannot be given different bands. */
export function ringPolar(
  p: RingPoint,
  anchor: RingAnchor,
  _band: RingBand,
  mirrored: boolean
): { dist: number; t: number } {
  // Sweeps INWARD from the pad's outer corner: a right-handed cluster runs
  // toward -x. Mirroring flips that leg only.
  const dx = ringSignX(mirrored) * (p.x - anchor.cx)
  const dy = ringSignY(anchor) * (p.y - anchor.cy)
  const dist = Math.hypot(dx, dy)
  const t = Math.atan2(Math.max(0, dy), Math.max(0, dx)) / (Math.PI / 2)
  return { dist, t: clamp01(t) }
}

/** Px from the corner -- the clamped angle implies the quarter, so a touch past
 *  either end lands on the nearest slot instead of falling through.
 *
 *  `slack` widens the annulus past the painted stroke. It defaults to the grab
 *  slack rather than 0: the painted band is what the eye aims at, not what the
 *  thumb lands on, and a bare stroke-width test dropped near-misses straight
 *  through to the trackpad as cursor moves. Pass 0 for a strictly-inside test. */
export function onRing(
  dist: number,
  band: RingBand,
  slack: number = CONFIG.PHONE_REMOTE.APP_RING_GRAB_SLACK_PX
): boolean {
  return dist >= band.rMin - slack && dist <= band.rMax + slack
}

/** One slot per app, capped so a slot never gets narrower than a fingertip.
 *  Past the cap the caller windows the list. */
export function ringSlotCount(appCount: number): number {
  return Math.max(1, Math.min(appCount, CONFIG.PHONE_REMOTE.APP_RING_MAX_SLOTS))
}

/** Which slot a position lands on. Returns a SLOT, never a bundle id -- the
 *  caller resolves the app against the list it already renders. */
export function ringSlotAt(t: number, slots: number): number {
  if (slots <= 1) return 0
  return Math.min(slots - 1, Math.floor(clamp01(t) * slots))
}

/** Center angle of a slot, for painting its tick/glow on the arc. */
export function ringSlotCenter(slot: number, slots: number): number {
  if (slots <= 1) return 0.5
  return (slot + 0.5) / slots
}

/** The stub below slot 0 that hold-to-dismiss owns. Derived from the slot
 *  count, never flat: at a fixed 0.12 it reached PAST slot 0's centre from five
 *  apps up, so holding the first icon put the ring away instead of opening it.
 *  A quarter-slot ends the zone well below that centre at any count, leaving
 *  the icon a full half-slot of its own on the side the finger arrives from. */
export function ringDismissZoneT(slots: number): number {
  const quarterSlot = 0.25 / Math.max(1, slots)
  return Math.min(CONFIG.PHONE_REMOTE.APP_RING_DISMISS_ZONE_MAX_T, quarterSlot)
}

/** 1 at a slot's center, 0 at APP_RING_FALLOFF_PX along the arc. In ARC PX,
 *  since the same angle is a different movement on a small pad than a large. */
export function ringNearness(
  thumbT: number | null,
  slotT: number,
  band: RingBand,
  // Required, not defaulted: a default of 1 makes the falloff span the entire
  // arc, so a caller that forgot it would light the whole band instead of
  // failing.
  slots: number
): number {
  if (thumbT === null) return 0
  const arcPx = Math.abs(clamp01(thumbT) - slotT) * band.radius * (Math.PI / 2)
  // "Wider than one slot" is the actual requirement -- a fixed px falloff only
  // met it at the arc length it was tuned against, and silently stopped once
  // the ellipse made the arc longer. Derived, so it holds at any size.
  const falloff = Math.max(
    CONFIG.PHONE_REMOTE.APP_RING_FALLOFF_PX,
    (band.radius * (Math.PI / 2)) / Math.max(1, slots) * 1.35
  )
  if (arcPx >= falloff) return 0
  // Cosine ease rather than linear: a linear ramp has a corner at the edge of
  // the falloff that reads as the icon "catching" as the finger passes.
  return (Math.cos((arcPx / falloff) * Math.PI) + 1) / 2
}

/** Icon size at a given nearness, interpolating the config's rest..peak range. */
export function ringIconSize(nearness: number): number {
  const { APP_RING_ICON_PX, APP_RING_ICON_PEAK_PX } = CONFIG.PHONE_REMOTE
  return APP_RING_ICON_PX + (APP_RING_ICON_PEAK_PX - APP_RING_ICON_PX) * clamp01(nearness)
}

/** Icon opacity at a given nearness. Same interpolation, separate range. */
export function ringIconOpacity(nearness: number): number {
  const { APP_RING_ICON_REST_OPACITY, APP_RING_ICON_PEAK_OPACITY } = CONFIG.PHONE_REMOTE
  return (
    APP_RING_ICON_REST_OPACITY +
    (APP_RING_ICON_PEAK_OPACITY - APP_RING_ICON_REST_OPACITY) * clamp01(nearness)
  )
}

/** SVG path for the band's centerline. One arc command -- the thickness is a
 *  stroke, so the glow rides stroke-width and the shape stays one element. */
export function ringArcPath(anchor: RingAnchor, band: RingBand, mirrored: boolean): string {
  const sx = ringSignX(mirrored)
  const sy = ringSignY(anchor)
  const r = band.radius
  const x0 = anchor.cx + sx * r
  const y0 = anchor.cy
  const x1 = anchor.cx
  const y1 = anchor.cy + sy * r
  // sweep flag follows the handedness x keys-position parity so the arc always
  // bulges away from the corner rather than cutting through the cluster.
  const sweep = sx * sy > 0 ? 1 : 0
  return `M ${round(x0)} ${round(y0)} A ${round(r)} ${round(r)} 0 0 ${sweep} ${round(x1)} ${round(y1)}`
}

/** A SUB-arc of the centerline, `t0..t1`. `ringArcPath` is this with the whole
 *  quarter; the zoom fill needs a partial one, stroked at the band width rather
 *  than a filled sector like `ringZonePath`. Under a quarter turn always, so
 *  the large-arc flag is 0 the same way it is there. */
export function ringSubArcPath(
  t0: number,
  t1: number,
  anchor: RingAnchor,
  band: RingBand,
  mirrored: boolean
): string {
  const a = ringPointAt(t0, anchor, band, mirrored)
  const b = ringPointAt(t1, anchor, band, mirrored)
  const sweep = ringSignX(mirrored) * ringSignY(anchor) > 0 ? 1 : 0
  const r = band.radius
  return `M ${round(a.x)} ${round(a.y)} A ${round(r)} ${round(r)} 0 0 ${sweep} ${round(b.x)} ${round(b.y)}`
}

/** Point on the band's centerline at normalized position `t`. Inverts
 *  ringPolar exactly: the same angle, back out at the same radius. */
export function ringPointAt(
  t: number,
  anchor: RingAnchor,
  band: RingBand,
  mirrored: boolean
): RingPoint {
  const a = clamp01(t) * (Math.PI / 2)
  return {
    x: anchor.cx + ringSignX(mirrored) * band.radius * Math.cos(a),
    y: anchor.cy + ringSignY(anchor) * band.radius * Math.sin(a)
  }
}

/** Where the picked app's magnified preview sits: the touch's own angle, pushed
 *  further from the corner. Outward, since inside the arc is the cluster the
 *  radius exists to clear. Clamped so an arc end can't push it off the pad. */
export function ringPopoutAt(
  t: number,
  anchor: RingAnchor,
  band: RingBand,
  mirrored: boolean,
  size: number
): RingPoint {
  const a = clamp01(t) * (Math.PI / 2)
  const sx = ringSignX(mirrored)
  const sy = ringSignY(anchor)
  const r = band.rMax + CONFIG.PHONE_REMOTE.APP_RING_POPOUT_GAP_PX + size / 2
  // Half the preview plus a hair, so a clamped one still sits fully on the pad
  // rather than half off its edge.
  const pad = size / 2 + 4
  const x = anchor.cx + sx * r * Math.cos(a)
  const y = anchor.cy + sy * r * Math.sin(a)
  // Only the two edges the arc sweeps TOWARD -- the ones `reach` measures. The
  // corner side is free: the anchor carries no distance to the pad edge behind
  // it, so a bound there is invented, and it bent both arc ends off the bearing.
  const dx = clamp(sx * (x - anchor.cx), -Infinity, anchor.reachX - pad)
  const dy = clamp(sy * (y - anchor.cy), -Infinity, anchor.reachY - pad)
  return { x: anchor.cx + sx * dx, y: anchor.cy + sy * dy }
}

/** The name pill beside the preview, clamped so a preview pushed into a corner
 *  doesn't hang its label off the pad. SVG gives <text> no measurable box before
 *  paint, hence the glyph-count estimate: it must CONTAIN the text, not hug it. */
export function ringLabelBox(
  pop: RingPoint,
  anchor: RingAnchor,
  mirrored: boolean,
  popSize: number,
  chars: number
): { cx: number; cy: number; width: number; height: number } {
  const L = CONFIG.PHONE_REMOTE
  const width =
    chars * L.APP_RING_LABEL_FONT_PX * L.APP_RING_LABEL_GLYPH_RATIO + L.APP_RING_LABEL_PAD_X * 2
  const height = L.APP_RING_LABEL_HEIGHT_PX
  // Away from the cluster, so the name never lands on the buttons the radius
  // exists to clear.
  const cy = pop.y + ringSignY(anchor) * (popSize / 2 + L.APP_RING_LABEL_GAP_PX + height / 2)
  // BOTH side edges, unlike ringPopoutAt: a pill is far wider than it is tall,
  // so the edge it overflows is whichever it sits near, not the one it sweeps
  // toward. Behind the anchor the pad ends at the corner the anchor is on.
  const far = anchor.cx + ringSignX(mirrored) * anchor.reachX
  const left = Math.min(anchor.cx, far)
  const right = Math.max(anchor.cx, far)
  const half = width / 2
  // Centre a pill too wide to fit: clamping hangs the far end off further.
  const cx = width >= right - left ? (left + right) / 2 : clamp(pop.x, left + half, right - half)
  return { cx, cy, width, height }
}

/** An annular sector spanning `t0..t1`, at the band's full grab width. Debug
 *  paint only: it traces exactly what `onRing` + the t-range accept, so a zone
 *  that looks wrong on glass IS wrong. Sharing `ringPointAt` with the live
 *  render is the point -- a hand-drawn overlay could agree with nothing. */
export function ringZonePath(
  t0: number,
  t1: number,
  anchor: RingAnchor,
  band: RingBand,
  mirrored: boolean
): string {
  const slack = CONFIG.PHONE_REMOTE.APP_RING_GRAB_SLACK_PX
  const rOut = band.rMax + slack
  const rIn = Math.max(0, band.rMin - slack)
  const at = (t: number, r: number): RingPoint =>
    ringPointAt(t, anchor, { ...band, radius: r }, mirrored)
  const a = at(t0, rOut)
  const b = at(t1, rOut)
  const c = at(t1, rIn)
  const d = at(t0, rIn)
  // Sweep flags mirror ringArcPath's parity so the wedge bulges the same way
  // the arc does; a fixed flag inverted it on left-handed decks.
  const sweep = ringSignX(mirrored) * ringSignY(anchor) > 0 ? 1 : 0
  return (
    `M ${round(a.x)} ${round(a.y)} A ${round(rOut)} ${round(rOut)} 0 0 ${sweep} ${round(b.x)} ${round(b.y)} ` +
    `L ${round(c.x)} ${round(c.y)} A ${round(rIn)} ${round(rIn)} 0 0 ${1 - sweep} ${round(d.x)} ${round(d.y)} Z`
  )
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
// Tolerates lo > hi (a pad narrower than the preview) by preferring lo, so a
// tiny pad parks the preview inside the edge rather than flipping it outside.
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const round = (v: number): number => Math.round(v * 10) / 10
