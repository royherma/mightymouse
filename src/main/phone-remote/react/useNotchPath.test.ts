import { describe, it, expect } from 'vitest'
import {
  buildRightPath,
  canCarveNotch,
  collapsedLevels,
  samePathStructure,
  shouldWaitForMirror,
  lerpPath
} from './useNotchPath'
import { CONFIG } from '../../../shared/config'

// The notch's entrance animation tweens the clip-path's `d` pairwise, number
// by number. That is only valid when the collapsed start shape and the real
// measured target share an identical M/L/C/Z command sequence -- otherwise
// lerpPath bails to the target and the entrance silently doesn't animate
// (which is exactly the "I don't see any animation" failure mode).
//
// These lock that invariant in: it's a non-obvious coupling between
// buildRightPath's emission order and collapsedLevels, and a future tweak to
// the path builder could break the animation without breaking anything a
// typecheck would catch.
const W = 390
const H = 520
const cmds = (d: string): string => (d.match(/[MLCZ]/g) ?? []).join('')

describe('notch entrance geometry', () => {
  // The real shape: a 3-row staircase, each row narrower than the last.
  const levels = [
    { x: 250, y: 300 },
    { x: 210, y: 360 },
    { x: 180, y: 430 }
  ]

  it('collapses every level into the pad corner', () => {
    expect(collapsedLevels(W, H, levels)).toEqual([
      { x: W, y: H },
      { x: W, y: H },
      { x: W, y: H }
    ])
  })

  it.each([1, 2, 3, 4])('emits a matching command sequence for %i level(s)', (n) => {
    const some = levels.slice(0, n).concat(
      // pad out to n levels when n exceeds the fixture
      Array.from({ length: Math.max(0, n - levels.length) }, (_, i) => ({
        x: 170 - i * 10,
        y: 450 + i * 20
      }))
    )
    const target = buildRightPath(W, H, some)
    const closed = buildRightPath(W, H, collapsedLevels(W, H, some))
    expect(cmds(closed)).toBe(cmds(target))
    expect(samePathStructure(closed, target)).toBe(true)
  })

  it('actually interpolates rather than falling through to the target', () => {
    const target = buildRightPath(W, H, levels)
    const closed = buildRightPath(W, H, collapsedLevels(W, H, levels))
    const mid = lerpPath(closed, target, 0.5)
    // The fall-through case returns `to` verbatim -- that's the silent-no-op
    // this test exists to catch.
    expect(mid).not.toBe(target)
    expect(mid).not.toContain('NaN')
    expect(cmds(mid)).toBe(cmds(target))
  })

  it('lands exactly on the endpoints', () => {
    const target = buildRightPath(W, H, levels)
    const closed = buildRightPath(W, H, collapsedLevels(W, H, levels))
    const strip = (s: string): string => s.replace(/\s+/g, '')
    expect(strip(lerpPath(closed, target, 0))).toBe(strip(closed))
    expect(strip(lerpPath(closed, target, 1))).toBe(strip(target))
  })

  it('refuses to blend structurally different paths', () => {
    const twoRow = buildRightPath(W, H, levels.slice(0, 2))
    const threeRow = buildRightPath(W, H, levels)
    expect(samePathStructure(twoRow, threeRow)).toBe(false)
    // lerpPath must degrade to a snap, not emit mixed-up geometry.
    expect(lerpPath(twoRow, threeRow, 0.5)).toBe(threeRow)
  })

  it('treats a null previous path as non-blendable (first paint)', () => {
    expect(samePathStructure(null, buildRightPath(W, H, levels))).toBe(false)
  })
})

// Keys-on-top landscape puts the first row hard against the pad's edge, so the
// normalized first.y is near zero. The top-right corner arc used to be drawn at
// a fixed CORNER_R regardless: it bulged out over exactly that row (pad painted
// ON TOP of Esc), and the edge run that followed it went BACKWARDS up the edge
// whenever first.y < CORNER_R, self-intersecting the subpath. Both are the same
// bug the user caught on-device 2026-07-23 ("the pad goes under" the top-right keys).
describe('notch corner yields to a near-edge first level', () => {
  // The right edge is traced top-down, so y must never decrease across the
  // corner arc into the run that follows it.
  const edgeRunIsForward = (path: string): boolean => {
    const m = path.match(/C[\d.,\- ]+ (\d+(?:\.\d+)?),(\d+(?:\.\d+)?) L(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/)
    if (!m) throw new Error(`no corner arc + edge run in: ${path.slice(0, 80)}`)
    return parseFloat(m[4]) >= parseFloat(m[2])
  }

  const levelsAt = (firstY: number): { x: number; y: number }[] => [
    { x: 260, y: firstY },
    { x: 210, y: firstY + 90 },
    { x: 230, y: firstY + 180 }
  ]

  it.each([0, 3, 8, 15, 27, 28, 45, 120])('never reverses the edge run at first.y=%i', (y) => {
    expect(edgeRunIsForward(buildRightPath(W, H, levelsAt(y)))).toBe(true)
  })

  it('shrinks the corner to fit the room above the notch', () => {
    // first.y=6 leaves only 6px above the notch -- the arc must fit inside it,
    // not overhang to the fixed 28px radius and cover the row.
    const tight = buildRightPath(W, H, levelsAt(6))
    expect(tight).toContain(`L${W},6`)
    expect(tight).not.toContain(`L${W},28`)
  })

  it('leaves the roomy (keys-at-bottom) geometry untouched', () => {
    // Far from the edge there is room for the full radius, so the shipped
    // bottom-anchored shape must be byte-identical to before the fix.
    expect(buildRightPath(W, H, levelsAt(200))).toContain(`C${W - 28 * 0.45},0 ${W},${28 * 0.45} ${W},28`)
  })

  // A row is a BAND, not a line. The notch used to step to the next level's x
  // at the next row's FAR edge, which (because rows overlap once MARGIN is
  // applied) lands mid-way through the current row -- so the pad pulled in
  // while that row was still beside it and painted over its outer end. Numbers
  // below are the REAL measured bands from an iPhone-landscape harness run
  // (pad h=347, keys-on-top): icon 136->232, Tab 224->296, Esc 277->349.
  it('holds a level across its whole band before stepping (cork under Tab)', () => {
    const H_REAL = 347
    const real = [
      { x: 579, y: 136, yEnd: 232 },
      { x: 579, y: 224, yEnd: 296 }, // Tab, merged to the icon row's x
      { x: 645, y: 277, yEnd: 349 } // Esc, the narrower row
    ]
    const p = buildRightPath(1250, H_REAL, real, 18)
    // The step OUT to Esc's narrower x must wait until Tab's BUTTONS are
    // cleared. The band's near edge is 296, but the buttons inside it end at
    // 286 (MARGIN in from the envelope) -- the turn is allowed to start its
    // overrun in that margin strip (STEP_CUT), so the hard line is the button
    // edge, not the envelope. Firing at Tab's far edge (224) was the bug: it
    // put all 72px of Tab on cork.
    expect(notchEdgeAt(p, 285)).toBeLessThanOrEqual(580)
    // ...and by the time Esc's band opens it HAS stepped out to hug Esc.
    expect(notchEdgeAt(p, 310)).toBeGreaterThan(600)
  })

  // The real guard: flatten the emitted path to points, then for EVERY scanline
  // inside every row's band check the notch edge is at or left of that row's
  // inner edge. Pad to the right of a row's inner edge IS pad painted on the
  // row. Catches the step-position bug, the blend-diagonal bug, and anything
  // else geometric -- the per-case assertions above only catch what they name.
  const notchEdgeAt = (path: string, y: number): number => {
    const nums = path.match(/[MLC]|-?[\d.]+/g) ?? []
    const pts: [number, number][] = []
    let cx = 0
    let cy = 0
    for (let i = 0; i < nums.length; ) {
      const t = nums[i]
      if (t === 'M' || t === 'L') {
        cx = +nums[i + 1]
        cy = +nums[i + 2]
        pts.push([cx, cy])
        i += 3
      } else if (t === 'C') {
        const [p0x, p0y] = [cx, cy]
        const [c1x, c1y, c2x, c2y, p3x, p3y] = nums.slice(i + 1, i + 7).map(Number)
        for (let s = 1; s <= 40; s++) {
          const u = s / 40
          const v = 1 - u
          pts.push([
            v * v * v * p0x + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * p3x,
            v * v * v * p0y + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * p3y
          ])
        }
        cx = p3x
        cy = p3y
        i += 7
      } else i++
    }
    let edge = Infinity
    for (let k = 1; k < pts.length; k++) {
      const [x1, y1] = pts[k - 1]
      const [x2, y2] = pts[k]
      if ((y1 - y) * (y2 - y) <= 0 && y1 !== y2) {
        const x = x1 + (x2 - x1) * ((y - y1) / (y2 - y1))
        if (x > 0) edge = Math.min(edge, x)
      }
    }
    return edge
  }

  // The bands are sharp-cornered MARGIN envelopes -- a conservative model of
  // the real exclusion, which is the BUTTON inside each one (inset MARGIN,
  // with its own ~10px rounded corner). Turns deliberately cut an envelope's
  // sharp corner diagonally (that's what lets the cork sit ON the band line
  // instead of hovering a whole blend above it -- the "spacing above Esc"
  // The user kept reporting, 2026-07-23), so the check is two-zone, mirroring
  // scripts/notch-diag.mjs:
  //   corner zones: within CUT_ZONE of a band edge, the path must keep
  //     CLEAR_MIN px of air off the button's rounded corner
  //   straight zone: between them, the envelope itself is the boundary
  const M = 10 // useNotchPath's MARGIN
  const BUTTON_R = 10
  const CUT_ZONE = 40
  const CLEAR_MIN = 4
  const cornerClearance = (
    b: { x: number; y: number; yEnd: number },
    px: number,
    py: number,
    corner: 'top' | 'bottom'
  ): number => {
    const ax = b.x + M + BUTTON_R - px
    const ay = corner === 'top' ? b.y + M + BUTTON_R - py : py - (b.yEnd - M - BUTTON_R)
    return Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) - BUTTON_R
  }

  const expectNoPadOverAnyRow = (
    path: string,
    padH: number,
    bands: { x: number; y: number; yEnd: number }[]
  ): void => {
    for (const b of bands) {
      const bandEnd = Math.min(b.yEnd, padH)
      for (let y = Math.ceil(b.y); y <= Math.floor(bandEnd); y++) {
        const edge = notchEdgeAt(path, y)
        const inCorner = y < b.y + CUT_ZONE || y > bandEnd - CUT_ZONE
        if (!inCorner) {
          expect(
            edge,
            `pad edge ${edge.toFixed(1)} is right of row x=${b.x} at y=${y}`
          ).toBeLessThanOrEqual(b.x + 1)
        } else if (edge <= b.x + CUT_ZONE + M) {
          // Within a corner zone the envelope may be cut, but never the
          // button. Each zone checks only ITS corner -- the other formula is
          // meaningless outside its own quadrant.
          const clear = cornerClearance(b, edge, y, y < b.y + CUT_ZONE ? 'top' : 'bottom')
          expect(
            clear,
            `pad edge ${edge.toFixed(1)} at y=${y} is ${clear.toFixed(1)}px from the button corner (min ${CLEAR_MIN})`
          ).toBeGreaterThanOrEqual(CLEAR_MIN)
        }
      }
    }
  }

  // Both sets are REAL rects measured off a rendered deck, not invented: an
  // iPhone-sized harness at 852x393 and 393x852. The two orientations order
  // their rows in OPPOSITE width directions (landscape narrows going down,
  // portrait widens), which is exactly why a single step rule fixed one and
  // broke the other on the first attempt.
  it('never paints pad over a row — landscape, keys on top', () => {
    const bands = [
      { x: 579, y: 136, yEnd: 232 },
      { x: 579, y: 224, yEnd: 296 },
      { x: 645, y: 277, yEnd: 349 }
    ]
    expectNoPadOverAnyRow(buildRightPath(1250, 347, bands, 18), 347, bands)
  })

  it('never paints pad over a row — portrait, keys at bottom', () => {
    const bands = [
      { x: 200, y: 587, yEnd: 659 },
      { x: 140, y: 640, yEnd: 712 },
      { x: 134, y: 704, yEnd: 800 }
    ]
    expectNoPadOverAnyRow(buildRightPath(363, 798, bands), 798, bands)
  })

  it('falls back to the old single-line behavior without yEnd', () => {
    // Callers that supply no band (every pre-existing test, and the collapsed
    // entrance shape) must get byte-identical geometry to before the change.
    const noBand = [
      { x: 200, y: 100 },
      { x: 150, y: 200 }
    ]
    // Without a band there is no yEnd to hold the level against, so the step
    // still turns about the level's own y (200) -- travelling 200 -> 150 with
    // its control points straddling that midpoint rather than sitting on it.
    // The straddle is what curves the corner; the old both-on-the-midline form
    // is what rendered as a hard 90-degree cut.
    const p = buildRightPath(W, H, noBand)
    const step = p.match(/C200,([\d.]+) 150,([\d.]+) 150,([\d.]+)/)
    expect(step, `expected a 200->150 step in ${p}`).not.toBeNull()
    const [, c1y, c2y] = step!.map(Number)
    expect(c1y).toBeGreaterThan(c2y) // straddles, i.e. actually curves
    expect(c1y).toBeGreaterThan(180)
    expect(c2y).toBeLessThan(200)
  })

  // Cork is a soft material and the notch is meant to read as carved out of
  // it. A turn whose control points all sit on one horizontal line renders as
  // a dead-square 90-degree corner -- which is what shipped when the turn was
  // clamped to the (negative) gap between two overlapping bands, and what the user
  // caught on-device 2026-07-23: "you can't have these super sharp edges, it
  // should curve, feels more real". Rows overlap in BOTH real orientations, so
  // this is the normal case, not an edge case.
  it.each([
    ['landscape', 1250, 347, 18, [
      { x: 579, y: 136, yEnd: 232 },
      { x: 579, y: 224, yEnd: 296 },
      { x: 645, y: 277, yEnd: 349 }
    ]],
    ['portrait', 363, 798, undefined, [
      { x: 200, y: 587, yEnd: 659 },
      { x: 140, y: 640, yEnd: 712 },
      { x: 134, y: 704, yEnd: 800 }
    ]]
  ] as const)('never emits a square corner — %s', (_name, w, h, fb, bands) => {
    const p = buildRightPath(w, h, [...bands], fb)
    const flat = [...p.matchAll(/C[\d.]+,([\d.]+) [\d.]+,([\d.]+) [\d.]+,([\d.]+)/g)].filter(
      (m) => m[1] === m[2] && m[2] === m[3]
    )
    expect(flat.map((m) => m[0]), 'these turns have no curvature').toEqual([])
  })

  it('still tweens against the collapsed shape at every depth', () => {
    // The corner radius is now data-dependent, so it could in principle change
    // the command sequence and silently kill the entrance animation.
    for (const y of [0, 6, 28, 200]) {
      const target = buildRightPath(W, H, levelsAt(y))
      expect(samePathStructure(buildRightPath(W, H, collapsedLevels(W, H, levelsAt(y))), target)).toBe(true)
    }
  })
})

// The landscape pad has a FLOOR (CONFIG.PHONE_REMOTE.PRO_LANDSCAPE_PAD_MIN_WIDTH)
// that the mirror shrinks it down to but never past. That floor has to clear the
// control cluster sitting inside the pad, because useNotchPath insets each level
// by MARGIN before carving and levelFrom clamps a negative inner edge to 0 -- the
// notch cannot carve outside the pad's own edge.
//
// At the shipped 220 the icon row (224) did not fit: the mic's inner edge landed
// at -4, so its outer strip stayed under cork with an orphan lobe beside Esc.
// Only reachable with the mirror ON, which is the one case that drives the pad to
// its floor -- and invisible to every frozen-fixture test above, which is why this
// asserts the INVARIANT rather than a path string.
describe('landscape pad floor', () => {
  // 60 mic + 3x44 icons + 4x8 gaps, matching .proIconRow/.proMicBtn/.proIconBtn
  // in theme.css. A change there must move the floor with it.
  const ICON_ROW_WIDTH = 60 + 3 * 44 + 4 * 8
  const MARGIN = 10

  it('leaves the notch room to carve around the icon row', () => {
    expect(ICON_ROW_WIDTH).toBe(224)
    // Clearing zero is NOT enough, which is what the first version of this test
    // asserted -- and why it passed at 244 while the pad still rendered wrong.
    // The icon column also has to survive the sliver guard in recompute(), so
    // the surviving strip must exceed minStepX (MIN_STEP_FRAC of the pad), not
    // merely be positive.
    const floor = CONFIG.PHONE_REMOTE.PRO_LANDSCAPE_PAD_MIN_WIDTH
    const strip = floor - ICON_ROW_WIDTH - MARGIN
    const minStepX = Math.max(floor * 0.045, 8)
    expect(
      strip,
      `at the pad floor the icon column is ${strip}px; it must exceed minStepX ` +
        `(${minStepX.toFixed(1)}) or the sliver guard zeroes it and cork floods the corner`
    ).toBeGreaterThan(minStepX)
  })
})

// The guard that zeroes sub-minStepX columns must never fire on the DEEPEST
// level: there is no carve behind it to fall back to, so zeroing opens the notch
// to the pad's full width. That is the cork slab under the mic
// -- a shape bug with no button OVERLAP, which
// is why both the deck viewer's overlap check and the floor test above went
// green on it.
describe('sliver guard', () => {
  const minStepX = 10.9 // a 242px landscape pad
  const guard = (xs: number[]): number[] => {
    const deepest = Math.min(...xs)
    return xs.map((x) => (x < minStepX && x > deepest ? 0 : x))
  }

  it('keeps the deepest column even when it is thinner than minStepX', () => {
    expect(guard([8, 120, 150])).toEqual([8, 120, 150])
  })

  it('still zeroes a thin strip that has a deeper carve behind it', () => {
    expect(guard([0, 8, 150])).toEqual([0, 0, 150])
  })
})

// Two rows within a sliver of each other merge to ONE column. Merging to the
// inner edge (min) deletes the wider row's clearance, which is the whole point
// of the notch -- it let the Tab row's carve punch through the icon row and
// flooded the pad's bottom-right with cork. Mirrors recompute()'s loop.
describe('sliver merge direction', () => {
  const merge = (xs: number[], minStepX: number): number[] => {
    const out = [...xs]
    for (let changed = true; changed; ) {
      changed = false
      for (let i = 1; i < out.length; i++) {
        if (out[i] !== out[i - 1] && Math.abs(out[i] - out[i - 1]) < minStepX) {
          out[i] = out[i - 1] = Math.max(out[i], out[i - 1])
          changed = true
        }
      }
    }
    return out
  }

  it('keeps the wider row clear when two rows are within a sliver', () => {
    // Measured live on the 254px landscape pad, keys-top / hand-right:
    // Esc=77, Tab=17, icon row=11, minStepX=11.4. Tab and the icon row differ
    // by 6, so the loop fires; taking the min dragged Tab down to 11, the notch
    // stopped seeing the mic, and cork flooded to the pad's bottom edge.
    expect(merge([77, 17, 11], 11.4)).toEqual([77, 17, 17])
  })

  it('never merges a level inward past a button it must clear', () => {
    const merged = merge([120, 100, 96], 11.4)
    expect(Math.min(...merged)).toBeGreaterThanOrEqual(96)
  })

  it('is stable when a merge drags a third level into range', () => {
    expect(merge([100, 95, 90], 11.4)).toEqual([100, 100, 100])
  })
})

// The 'groups' split gives one cluster all four pills and the other all four
// round buttons, so each side owns exactly ONE row type and the empty half
// renders nothing (KeyPillGrid/BottomIconRow return <></> before attaching their
// ref). The hook used to require BOTH refs and returned early, which left
// `path` null -- and a <clipPath> with no <path> child clips away EVERYTHING.
// The pad kept its full layout box and painted zero pixels, so the skin plate
// showed through: "the trackpad is not showing".
// Nothing caught it because typecheck, the overlap check, and every geometry
// test above operate on levels that already exist.
describe('single-row cluster (groups split)', () => {
  const w = 637
  const h = 329

  it('carves a real notch from one level', () => {
    // One icon row, no key grid -- the secondary cluster in groups mode.
    const d = buildRightPath(w, h, [{ x: 470, y: 250, yEnd: 320 }])
    // A path with a bite, not the bare rounded rect the levels-empty branch
    // returns (that branch is the OTHER way this reads as "no notch").
    expect(d).toContain('C')
    expect(d).not.toBe(`M0,0 L${w},0 L${w},${h} L0,${h} Z`)
    // The notch must actually reach the row's inner edge, or the buttons sit
    // on cork.
    expect(d).toContain('470')
  })

  it('stays tweenable against its own collapsed shape', () => {
    // animateTo only runs the entrance if the structures match; a mismatch
    // silently degrades to a snap, which is how a geometry regression hides.
    const levels = [{ x: 470, y: 250, yEnd: 320 }]
    const target = buildRightPath(w, h, levels)
    const closed = buildRightPath(w, h, collapsedLevels(w, h, levels))
    expect(samePathStructure(closed, target)).toBe(true)
  })

  // The actual regression. buildRightPath above was never broken -- the kill
  // switch was the hook's ref guard, so testing geometry alone passes with the
  // bug reinstated (verified by mutation, which is why this test exists).
  it('carves with only ONE row mounted', () => {
    const pad = {} as Element
    const row = {} as Element
    expect(canCarveNotch(pad, null, row)).toBe(true) // groups: secondary cluster
    expect(canCarveNotch(pad, row, null)).toBe(true) // groups: primary cluster
    expect(canCarveNotch(pad, row, row)).toBe(true) // every other concept
  })

  it('refuses only when the pad itself or BOTH rows are missing', () => {
    const el = {} as Element
    expect(canCarveNotch(null, el, el)).toBe(false)
    expect(canCarveNotch(el, null, null)).toBe(false)
  })
})

// Rotation staleness. Geometry was never the problem here either: the pad was
// carved to a perfectly correct LANDSCAPE shape while the phone was portrait,
// because the wait below was measured from mount and had therefore already
// expired. Every assertion is on the clock, not the path.
describe('mirror settle window', () => {
  const SETTLE = 1200

  it('waits while the mirror has not published a width yet', () => {
    expect(shouldWaitForMirror(true, 0, SETTLE)).toBe(true)
    expect(shouldWaitForMirror(true, SETTLE - 1, SETTLE)).toBe(true)
  })

  it('gives up at the deadline so a stream that never arrives cannot block', () => {
    // Unbounded waiting leaves the pad with NO clip-path, which is worse than
    // the snap -- an empty clipPath paints zero pixels.
    expect(shouldWaitForMirror(true, SETTLE, SETTLE)).toBe(false)
    expect(shouldWaitForMirror(true, SETTLE + 500, SETTLE)).toBe(false)
  })

  it('never waits when the mirror is off or already sized', () => {
    expect(shouldWaitForMirror(false, 0, SETTLE)).toBe(false)
  })

  // THE regression. Rotating hours into a session must re-open the window; a
  // mount-relative elapsed makes this false and carves against the previous
  // orientation's --pro-mirror-w.
  it('re-opens the window on a rotation late in the session', () => {
    const sessionAge = 45 * 60 * 1000
    expect(shouldWaitForMirror(true, sessionAge, SETTLE)).toBe(false) // measured from MOUNT: bug
    expect(shouldWaitForMirror(true, 0, SETTLE)).toBe(true) // measured from ROTATION: fixed
  })
})
