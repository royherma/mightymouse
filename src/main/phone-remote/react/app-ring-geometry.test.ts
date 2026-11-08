/**
 * The ring's geometry, locked where it would silently drift: the quadrant
 * mapping (an off-by-a-quadrant reads as "the ring picks the wrong app"),
 * handedness mirroring (only reproducible on the other hand), and the slot
 * floor at t === 1 (which would index one past the list).
 */
import { describe, expect, it } from 'vitest'
import {
  onRing,
  ringArcPath,
  ringBand,
  ringDismissZoneT,
  ringHitBox,
  ringIconOpacity,
  ringIconSize,
  ringNearness,
  ringLabelBox,
  ringPointAt,
  ringPopoutAt,
  ringPolar,
  ringSlotAt,
  ringSlotCenter,
  ringSlotCount,
  type RingAnchor
} from './app-ring-geometry'
import { CONFIG } from '@shared/config'

const BAND = CONFIG.PHONE_REMOTE.APP_RING_BAND_PX
const GAP = CONFIG.PHONE_REMOTE.APP_RING_GAP_PX
const FRAC = CONFIG.PHONE_REMOTE.APP_RING_MAX_PAD_FRAC

// A right-handed pad with the cluster in the bottom-right corner, so the arc
// runs inward (-x) and upward (-y) from it. The cluster box is deliberately NOT
// square -- a rectangle is what the real hook measures.
const anchor: RingAnchor = {
  cx: 360,
  cy: 400,
  clusterX: 120,
  clusterY: 80,
  reachX: 360,
  reachY: 400,
  // Roomy enough that the pad cap stays out of the way, so these cases exercise
  // the wrap itself. The cap has its own tests below.
  padW: 700,
  padH: 700,
  keysPosition: 'bottom'
}

describe('ringBand', () => {
  it('is a circle -- one radius, not a radius per axis', () => {
    // The ellipse was tried so each end could land on its own edge. Stretching
    // to two unequal legs is what turned the arc into a diagonal stripe across
    // the pad (on-device 2026-07-31), so it went back to a circle.
    const band = ringBand(anchor)!
    expect(band.radius).toBe(700 * FRAC)
    expect(band.rMax - band.rMin).toBe(BAND)
  })

  it('clears the LONGER cluster leg, not the shorter one', () => {
    // Clearing only the near leg put the icons straight on top of Esc, Tab and
    // the mic (Roy on-device 2026-07-31): a circle that clears the short leg
    // cuts through the long one, which is where the buttons are.
    const wide = ringBand({ ...anchor, clusterX: 340, clusterY: 40, reachX: 500, reachY: 500 })!
    expect(wide.radius).toBe(340 + GAP + BAND / 2)
  })

  it('grows with a taller cluster, whatever made it taller', () => {
    // Pure arithmetic on the measured legs. NOTE the context bar is no longer
    // one of them: `controlsRect` deliberately excludes it, because the bar now
    // parks above the ARC rather than the arc clearing the bar. Sizing to both
    // did not fit -- ~259px wanted on a 393pt portrait pad offering ~227 -- so
    // the pad-edge cap won and the icons sat behind the tab chips.
    const taller = ringBand({ ...anchor, clusterY: 320, reachX: 500, reachY: 500 })!
    expect(taller.radius).toBeGreaterThan(ringBand(anchor)!.radius)
    expect(taller.radius).toBe(320 + GAP + BAND / 2)
  })

  it('scales with the pad SHORTER side, so one radius fits both axes', () => {
    expect(ringBand({ ...anchor, padW: 400, padH: 520 })!.radius).toBe(400 * FRAC)
    expect(ringBand({ ...anchor, padW: 520, padH: 400 })!.radius).toBe(400 * FRAC)
  })

  it('still clears the buttons when the pad fraction would cut through them', () => {
    // The fraction is the target, not a ceiling on safety: a cluster taller
    // than it still pushes the arc out, or the band crosses the buttons.
    const tall = ringBand({ ...anchor, clusterX: 320, clusterY: 320, reachX: 500, reachY: 500 })!
    expect(tall.radius).toBe(320 + GAP + BAND / 2)
    expect(tall.radius).toBeGreaterThan(700 * FRAC)
  })

  it('yields to the pad edge rather than dropping the ring entirely', () => {
    // A landscape deck wants r=290 to clear its cluster and has 277 of room.
    // Honoring the wrap outright would mean no ring at all, so the edge wins and
    // the sweep's far end rides over the cluster's outer corner, which holds no
    // buttons.
    const tight = ringBand({ ...anchor, clusterX: 300, clusterY: 300, reachX: 200, reachY: 200 })!
    expect(tight.radius).toBe(200 - BAND / 2)
  })

  it('leaves at least half the stroke between the centerline and each edge', () => {
    // The stroke straddles the centerline, so the painted band's outer edge must
    // land at or inside the pad edge rather than half a stroke past it (clipped).
    const band = ringBand(anchor)!
    expect(band.rMax).toBeLessThanOrEqual(anchor.reachX)
    expect(band.rMax).toBeLessThanOrEqual(anchor.reachY)
  })

  it('returns null only when the pad has no room for a band at all', () => {
    expect(ringBand({ ...anchor, reachX: 20, reachY: 400 })).toBeNull()
    expect(ringBand({ ...anchor, clusterX: 340, clusterY: 340 })).not.toBeNull()
  })

  it('does not credit the arc with room past the corner it sweeps from', () => {
    // reachX/reachY run from the corner INTO the pad. A landscape pad is one
    // column of a wider card, so a card-width reach passed a band that ran off
    // the pad and over the mirror pane -- the shipped landscape bug. The
    // tighter leg has to bind, whichever it is.
    const padColumn = ringBand({ ...anchor, reachX: 170, reachY: 400 })!
    expect(padColumn.rMax).toBeLessThanOrEqual(170)
  })

  it('shrinks rather than overflowing when a leg is tight', () => {
    // A squashed leg used to reject the band outright. Shrinking keeps a
    // usable ring, and the rMax assertion is what stops it spilling off-pad.
    const tight = ringBand({ ...anchor, reachX: 90, reachY: 400 })!
    expect(tight.rMax).toBeLessThanOrEqual(90)
    expect(tight.radius).toBeLessThan(ringBand(anchor)!.radius)
  })
})

describe('ringPolar', () => {
  const band = ringBand(anchor)!

  it('reads 0 along the bottom edge and 1 straight up the side', () => {
    const alongEdge = ringPolar({ x: 360 - band.radius, y: 400 }, anchor, band, false)
    expect(alongEdge.t).toBeCloseTo(0, 5)
    const upTheSide = ringPolar({ x: 360, y: 400 - band.radius }, anchor, band, false)
    expect(upTheSide.t).toBeCloseTo(1, 5)
  })

  it('reads the centerline radius at every angle', () => {
    // A circle, so one radius holds all the way around -- this is what the
    // ellipse's normalized units existed to fake.
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = ringPointAt(t, anchor, band, false)
      expect(ringPolar(p, anchor, band, false).dist).toBeCloseTo(band.radius, 5)
    }
  })

  it('reads the midpoint halfway along the arc', () => {
    const mid = ringPointAt(0.5, anchor, band, false)
    expect(ringPolar(mid, anchor, band, false).t).toBeCloseTo(0.5, 5)
  })

  it('mirrors horizontally for the other hand, leaving t unchanged', () => {
    // Same physical distance from the corner, opposite side. A left-handed
    // deck must yield the SAME normalized position -- otherwise the ring
    // scrubs backwards on one hand, which only shows up on device.
    const right = ringPolar({ x: 360 - 100, y: 340 }, anchor, band, false)
    const left = ringPolar({ x: 360 + 100, y: 340 }, anchor, band, true)
    expect(left.t).toBeCloseTo(right.t, 6)
    expect(left.dist).toBeCloseTo(right.dist, 6)
  })

  it('clamps a touch past either end of the quarter', () => {
    // Below the corner (dy < 0) and behind it (dx < 0) both clamp in range.
    expect(ringPolar({ x: 360 - 100, y: 480 }, anchor, band, false).t).toBe(0)
    expect(ringPolar({ x: 360 + 50, y: 300 }, anchor, band, false).t).toBe(1)
  })
})

describe('onRing', () => {
  const band = ringBand(anchor)!

  it('accepts the band and rejects inside the cluster or past the outer edge', () => {
    // Slack 0 = the strict annulus. The default is deliberately wider (below).
    expect(onRing(band.radius, band, 0)).toBe(true)
    expect(onRing(band.rMin - 0.01, band, 0)).toBe(false)
    expect(onRing(band.rMax + 0.01, band, 0)).toBe(false)
  })

  it('grabs just outside the painted stroke, but not indefinitely', () => {
    // The stroke is what the eye aims at, not what the thumb lands on: a
    // strict test dropped near-misses through to the pad as cursor moves.
    const slack = CONFIG.PHONE_REMOTE.APP_RING_GRAB_SLACK_PX
    expect(onRing(band.rMin - slack + 1, band)).toBe(true)
    expect(onRing(band.rMax + slack - 1, band)).toBe(true)
    expect(onRing(band.rMin - slack - 1, band)).toBe(false)
    expect(onRing(band.rMax + slack + 1, band)).toBe(false)
  })

  it('accepts the full painted stroke width, edge to edge', () => {
    // The hit range must span exactly the stroke -- a band you can see but
    // cannot land on is the same bug as no band.
    expect(onRing(band.rMin, band)).toBe(true)
    expect(onRing(band.rMax, band)).toBe(true)
    expect(band.rMax - band.rMin).toBe(BAND)
  })
})

describe('ringSlotCount', () => {
  it('is one slot per app up to the fingertip cap', () => {
    expect(ringSlotCount(3)).toBe(3)
    expect(ringSlotCount(50)).toBe(CONFIG.PHONE_REMOTE.APP_RING_MAX_SLOTS)
  })

  it('never returns zero, so slot math cannot divide by it', () => {
    expect(ringSlotCount(0)).toBe(1)
  })
})

describe('ringDismissZoneT', () => {
  // The regression this exists for: a flat 0.12 zone reached past slot 0's
  // centre from five apps up, so holding the first icon put the ring away
  // instead of opening its app (Roy, on-device portrait 2026-08-01).
  it('ends below slot 0 at every slot count', () => {
    for (let slots = 1; slots <= CONFIG.PHONE_REMOTE.APP_RING_MAX_SLOTS; slots++) {
      expect(ringDismissZoneT(slots)).toBeLessThan(ringSlotCenter(0, slots))
    }
  })

  it('never exceeds the configured ceiling', () => {
    for (let slots = 1; slots <= CONFIG.PHONE_REMOTE.APP_RING_MAX_SLOTS; slots++) {
      expect(ringDismissZoneT(slots)).toBeLessThanOrEqual(
        CONFIG.PHONE_REMOTE.APP_RING_DISMISS_ZONE_MAX_T
      )
    }
  })
})

describe('ringHitBox', () => {
  const band = ringBand(anchor)!
  const slack = CONFIG.PHONE_REMOTE.APP_RING_GRAB_SLACK_PX

  // How far the box must reach PAST the anchor on each leg. ringPolar clamps a
  // touch beyond an arc end back onto it, so onRing accepts that whole strip.
  const over = band.band / 2 + slack

  it('covers the whole grabbable band', () => {
    const box = ringHitBox(anchor, band, false)
    expect(box.width).toBe(band.rMax + slack + over)
    expect(box.height).toBe(band.rMax + slack + over)
  })

  it('overhangs the anchor by the grab width on both legs', () => {
    // The dead-slot bug: the box used to STOP at the anchor while ringPolar
    // clamped touches past it onto slot 0, so the band's outermost stroke had
    // no hit layer above it and the pad conceded to nobody. Right-handed with
    // keys at the bottom, that strip is below cy and right of cx.
    const box = ringHitBox(anchor, band, false)
    expect(box.left + box.width).toBeCloseTo(anchor.cx + over, 5)
    expect(box.top + box.height).toBeCloseTo(anchor.cy + over, 5)
    // Mirrored, the sweep flips, so the overhang moves to the other side.
    const m = ringHitBox(anchor, band, true)
    expect(m.left).toBeCloseTo(anchor.cx - over, 5)
  })

  it('contains every point onRing accepts at the arc ends', () => {
    // The invariant the two mechanisms have to share. Slot 0 sits at t=0, so
    // walk its stroke out to the slack and assert the box holds it.
    const box = ringHitBox(anchor, band, false)
    for (const r of [band.rMin - slack, band.radius, band.rMax + slack]) {
      expect(onRing(r, band)).toBe(true)
      // t=0 is along -x from the anchor at y === cy; the touch may sit up to
      // `over` below that line and still clamp onto the arc.
      const x = anchor.cx - r
      const y = anchor.cy + over
      expect(x).toBeGreaterThanOrEqual(box.left)
      expect(y).toBeLessThanOrEqual(box.top + box.height)
    }
  })

  it('clips to an annulus, so it never covers the cluster it wraps', () => {
    // evenodd + two subpaths is what punches the inner hole. A filled
    // quarter-disc here would sit over the buttons the radius exists to clear,
    // and over a quarter of the trackpad.
    const { clipPath } = ringHitBox(anchor, band, false)
    expect(clipPath).toContain('evenodd')
    expect(clipPath.match(/M /g)).toHaveLength(2)
  })
})

describe('ringSlotAt', () => {
  it('divides the arc into equal slots', () => {
    expect(ringSlotAt(0, 4)).toBe(0)
    expect(ringSlotAt(0.26, 4)).toBe(1)
    expect(ringSlotAt(0.51, 4)).toBe(2)
    expect(ringSlotAt(0.99, 4)).toBe(3)
  })

  it('clamps the far end instead of indexing past the list', () => {
    // t === 1 * 4 would floor to 4, one past a 4-slot list.
    expect(ringSlotAt(1, 4)).toBe(3)
    expect(ringSlotAt(1.5, 4)).toBe(3)
  })

  it('collapses to the only slot when there is one app', () => {
    expect(ringSlotAt(0.7, 1)).toBe(0)
  })

  it('round-trips a slot through its own center', () => {
    // Painting a slot's tick and hit-testing it must agree, or the lit tile
    // and the activated app drift apart.
    for (const slots of [2, 5, 9]) {
      for (let s = 0; s < slots; s++) {
        expect(ringSlotAt(ringSlotCenter(s, slots), slots)).toBe(s)
      }
    }
  })
})

describe('ringArcPath / ringPointAt', () => {
  const band = ringBand(anchor)!

  it('starts on the bottom edge and ends up the side', () => {
    const path = ringArcPath(anchor, band, false)
    expect(path).toMatch(/^M \d/)
    expect(path).toContain('A')
    const start = ringPointAt(0, anchor, band, false)
    expect(start.x).toBeCloseTo(360 - band.radius, 5)
    expect(start.y).toBeCloseTo(400, 5)
    const end = ringPointAt(1, anchor, band, false)
    expect(end.x).toBeCloseTo(360, 5)
    expect(end.y).toBeCloseTo(400 - band.radius, 5)
  })

  it('ends clear of the cluster, and well inside the pad edge', () => {
    // Both halves matter: the old assertion demanded each end land ON the pad
    // edge, which is precisely the corner-to-corner sweep that shipped.
    const end = ringPointAt(1, anchor, band, false)
    expect(anchor.cy - end.y - BAND / 2).toBeGreaterThanOrEqual(anchor.clusterY + GAP)
    expect(band.rMax).toBeLessThan(anchor.reachY)
  })

  it('writes the same radius twice -- it is a circle', () => {
    expect(ringArcPath(anchor, band, false)).toContain(`A ${band.radius} ${band.radius}`)
  })

  it('sweeps the other way when mirrored', () => {
    expect(ringArcPath(anchor, band, false)).not.toBe(ringArcPath(anchor, band, true))
    expect(ringPointAt(0, anchor, band, true).x).toBeCloseTo(360 + band.radius, 5)
  })

  it('sweeps DOWN from a top-keys cluster, not up through it', () => {
    // The other keys position is the half of the matrix a bottom-only fixture
    // never exercises -- and an arc that rises from a top corner leaves the pad.
    const top: RingAnchor = { ...anchor, cy: 0, reachY: 400, keysPosition: 'top' }
    const b = ringBand(top)!
    expect(ringPointAt(1, top, b, false).y).toBeCloseTo(b.radius, 5)
  })

  it('stays exactly one radius from the corner all the way round', () => {
    // The circle stated directly: every painted point is the same distance
    // from the anchor, so the band never bulges toward one axis.
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      const p = ringPointAt(t, anchor, band, false)
      expect(Math.hypot(p.x - anchor.cx, p.y - anchor.cy)).toBeCloseTo(band.radius, 5)
    }
  })
})

describe('ringNearness', () => {
  const band = ringBand(anchor)!

  it('is 0 when nothing is being touched, so every icon rests', () => {
    expect(ringNearness(null, 0.5, band, 5)).toBe(0)
  })

  it('peaks at the slot the finger is on and falls to 0 outside the falloff', () => {
    expect(ringNearness(0.5, 0.5, band, 5)).toBeCloseTo(1, 5)
    // Far end of the arc is many falloff widths away on this pad.
    expect(ringNearness(0, 1, band, 5)).toBe(0)
  })

  it('never dims as the finger closes in', () => {
    // Monotonicity is the whole feel: a non-monotonic falloff reads as the
    // icon flickering while the thumb approaches steadily.
    let prev = -1
    for (const t of [0.2, 0.3, 0.4, 0.45, 0.5]) {
      const n = ringNearness(t, 0.5, band, 5)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
  })

  it('lifts a neighbour before the finger arrives', () => {
    // Falloff is deliberately wider than one slot, so the row reads as
    // continuous rather than as separate buttons blinking on and off.
    // Checked at both extremes of the slot count: the falloff is derived from
    // the arc length per slot, so a fixed px value would satisfy one and not
    // the other -- which is exactly how it broke when the arc grew.
    for (const slots of [2, 5, CONFIG.PHONE_REMOTE.APP_RING_MAX_SLOTS]) {
      const near = ringNearness(ringSlotCenter(0, slots), ringSlotCenter(1, slots), band, slots)
      expect(near).toBeGreaterThan(0)
      expect(near).toBeLessThan(1)
    }
  })

  it('still falls to rest two slots away, so the whole band never lights at once', () => {
    const slots = 9
    expect(ringNearness(ringSlotCenter(0, slots), ringSlotCenter(3, slots), band, slots)).toBe(0)
  })
})

describe('ring icon response', () => {
  it('maps rest and peak nearness onto the configured ranges', () => {
    expect(ringIconSize(0)).toBe(CONFIG.PHONE_REMOTE.APP_RING_ICON_PX)
    expect(ringIconSize(1)).toBe(CONFIG.PHONE_REMOTE.APP_RING_ICON_PEAK_PX)
    expect(ringIconOpacity(0)).toBe(CONFIG.PHONE_REMOTE.APP_RING_ICON_REST_OPACITY)
    expect(ringIconOpacity(1)).toBe(CONFIG.PHONE_REMOTE.APP_RING_ICON_PEAK_OPACITY)
  })

  it('keeps a peaked icon inside the band it belongs to', () => {
    // A lit icon spilling past the band would read as a detached tile floating
    // over the pad rather than part of the ring.
    expect(CONFIG.PHONE_REMOTE.APP_RING_ICON_PEAK_PX).toBeLessThanOrEqual(
      CONFIG.PHONE_REMOTE.APP_RING_BAND_PX
    )
  })
})

describe('the pad stands down by radius, not by travel', () => {
  const band = ringBand(anchor)!

  it('claims a touch that lands on the band without any movement', () => {
    // The pad asks onRing() at ITS touchstart and returns early. Before this,
    // ownership waited for ENGAGE_PX of travel, so the first pixels of every
    // scrub moved the Mac cursor and a still thumb armed a drag.
    const onBand = ringPolar({ x: 360 - band.radius, y: 400 }, anchor, band, false)
    expect(onRing(onBand.dist, band)).toBe(true)
  })

  it('leaves a touch inside the cluster or out on open pad to the pad', () => {
    const inCluster = ringPolar({ x: 360 - 40, y: 400 - 40 }, anchor, band, false)
    expect(onRing(inCluster.dist, band)).toBe(false)
    const openPad = ringPolar({ x: 360 - band.radius + 30 + BAND, y: 400 }, anchor, band, false)
    expect(onRing(openPad.dist, band)).toBe(false)
  })

  it('resolves a slot from the landing point alone, so a tap can commit', () => {
    // A tap that never moves still has a slot -- lifting on it activates that
    // app, which is what an icon lighting under the thumb promises.
    const landing = ringPolar(ringPointAt(0.5, anchor, band, false), anchor, band, false)
    expect(ringSlotAt(landing.t, 5)).toBe(2)
  })
})

describe('ringPopoutAt', () => {
  const band = ringBand(anchor)!
  const SIZE = CONFIG.PHONE_REMOTE.APP_RING_POPOUT_PX
  const GAP_OUT = CONFIG.PHONE_REMOTE.APP_RING_POPOUT_GAP_PX

  it('sits OUTSIDE the band, not inside it', () => {
    // Inside the arc is the cluster -- ringBand's whole radius exists to clear
    // it -- so a preview pulled toward the corner lands on the buttons.
    const p = ringPopoutAt(0.5, anchor, band, false, SIZE)
    const d = Math.hypot(p.x - anchor.cx, p.y - anchor.cy)
    expect(d).toBeGreaterThan(band.rMax)
    expect(d).toBeCloseTo(band.rMax + GAP_OUT + SIZE / 2, 5)
  })

  it('holds the finger ANGLE, so the preview rides the touch', () => {
    // Roy's rule: it follows the touch, angled out of the ring. Same bearing
    // from the corner as the thumb, only further out.
    // A pad with room to spare on every side, so the edge clamp cannot fire and
    // this case tests the bearing alone. The clamp has its own case below.
    const roomy = { ...anchor, reachX: 900, reachY: 900 }
    const wide = ringBand(roomy)!
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const on = ringPointAt(t, roomy, wide, false)
      const out = ringPopoutAt(t, roomy, wide, false, SIZE)
      // Compared as unit vectors, not as atan2 angles: at t === 0 the bearing
      // is exactly +/-pi, so a sign flip in a zero-height leg fails a numeric
      // compare on two points that are perfectly collinear.
      const unit = (p: { x: number; y: number }): { x: number; y: number } => {
        const dx = p.x - roomy.cx
        const dy = p.y - roomy.cy
        const d = Math.hypot(dx, dy)
        return { x: dx / d, y: dy / d }
      }
      expect(unit(out).x).toBeCloseTo(unit(on).x, 5)
      expect(unit(out).y).toBeCloseTo(unit(on).y, 5)
    }
  })

  it('clears the thumb by more than a fingertip', () => {
    // The point of the feature: the icon on the band is under the finger that
    // picked it, so the preview has to be out of that finger's shadow.
    const on = ringPointAt(0.5, anchor, band, false)
    const out = ringPopoutAt(0.5, anchor, band, false, SIZE)
    expect(Math.hypot(out.x - on.x, out.y - on.y)).toBeGreaterThan(44)
  })

  it('mirrors with handedness', () => {
    const right = ringPopoutAt(0.3, anchor, band, false, SIZE)
    const left = ringPopoutAt(0.3, anchor, band, true, SIZE)
    expect(left.x - anchor.cx).toBeCloseTo(-(right.x - anchor.cx), 5)
    expect(left.y).toBeCloseTo(right.y, 5)
  })

  it('stays on the pad when the arc end would push it off', () => {
    // A tight pad clamps the preview to the edge rather than letting half of it
    // hang off the card.
    // Only the two edges the arc sweeps toward are bounded -- those are the
    // ones `reach` measures. The corner side is free by design (see the helper).
    const tight = { ...anchor, reachX: 120, reachY: 120 }
    const b = ringBand(tight) ?? band
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = ringPopoutAt(t, tight, b, false, SIZE)
      expect(p.x).toBeGreaterThanOrEqual(tight.cx - tight.reachX)
      expect(p.y).toBeGreaterThanOrEqual(tight.cy - tight.reachY)
    }
  })
})

describe('ringLabelBox', () => {
  const band = ringBand(anchor)!
  const SIZE = CONFIG.PHONE_REMOTE.APP_RING_POPOUT_PX
  const GAP = CONFIG.PHONE_REMOTE.APP_RING_LABEL_GAP_PX
  const H = CONFIG.PHONE_REMOTE.APP_RING_LABEL_HEIGHT_PX

  it('clears the preview instead of overlapping it', () => {
    const pop = ringPopoutAt(0.5, anchor, band, false, SIZE)
    const box = ringLabelBox(pop, anchor, false, SIZE, 6)
    // Cluster at the bottom, so the label goes ABOVE.
    expect(box.cy + box.height / 2).toBeCloseTo(pop.y - SIZE / 2 - GAP, 5)
    expect(box.height).toBe(H)
  })

  it('follows the arc AWAY from the cluster when the keys are on top', () => {
    // Below the preview here: above would put the name on the buttons.
    const top: RingAnchor = { ...anchor, cy: 40, keysPosition: 'top', reachY: 400 }
    const b = ringBand(top)!
    const pop = ringPopoutAt(0.5, top, b, false, SIZE)
    const box = ringLabelBox(pop, top, false, SIZE, 6)
    expect(box.cy).toBeGreaterThan(pop.y)
  })

  it('grows with the name, so a long one is not clipped', () => {
    const pop = ringPopoutAt(0.5, anchor, band, false, SIZE)
    const short = ringLabelBox(pop, anchor, false, SIZE, 4)
    const long = ringLabelBox(pop, anchor, false, SIZE, 20)
    expect(long.width).toBeGreaterThan(short.width)
    expect(long.width).toBeGreaterThan(20 * CONFIG.PHONE_REMOTE.APP_RING_LABEL_FONT_PX * 0.5)
  })

  it('stays on the pad at both arc ends, where the preview is clamped', () => {
    // A pill centred on a clamped preview hangs off the edge it was clamped
    // against -- and being wider than tall, BOTH side edges bind.
    const tight = { ...anchor, reachX: 160, reachY: 160 }
    const b = ringBand(tight) ?? band
    for (const mirrored of [false, true]) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const pop = ringPopoutAt(t, tight, b, mirrored, SIZE)
        const box = ringLabelBox(pop, tight, mirrored, SIZE, 14)
        const far = tight.cx + (mirrored ? tight.reachX : -tight.reachX)
        const lo = Math.min(tight.cx, far)
        const hi = Math.max(tight.cx, far)
        expect(box.cx - box.width / 2).toBeGreaterThanOrEqual(lo - 0.001)
        expect(box.cx + box.width / 2).toBeLessThanOrEqual(hi + 0.001)
      }
    }
  })

  it('centres a pill too wide for the room rather than pinning it to one edge', () => {
    const tight = { ...anchor, reachX: 90, reachY: 400 }
    const b = ringBand(tight) ?? band
    const pop = ringPopoutAt(0.5, tight, b, false, SIZE)
    const box = ringLabelBox(pop, tight, false, SIZE, 40)
    expect(box.width).toBeGreaterThan(tight.reachX)
    expect(box.cx).toBeCloseTo(tight.cx - tight.reachX / 2, 5)
  })
})
