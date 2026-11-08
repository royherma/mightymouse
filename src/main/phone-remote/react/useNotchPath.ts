import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { PhoneRemoteHandedness, PhoneRemoteKeysPosition } from '@shared/types'

// The button cluster is a 3-row staircase, not a single rectangle: the Esc/
// keyboard row, the Tab/Enter row, and the icon row are each a different
// width, so any single-edge cutout wastes touchpad space beside the narrower
// rows. Fix: measure the REAL rect of EVERY row (the key grid's two child
// rows + the icon row) via ResizeObserver and build a clip-path that cascades
// in to hug each row's actual inner edge. Each level-to-level transition is
// one tangent-continuous S-cubic (not fillet + line + fillet) so the whole
// notch reads as a flowing wave -- the curve style the user picked from rendered
// mock variants, not a stepped rectangle.
const MARGIN = 10
const CORNER_R = 28

// The <path> inside the clipPath, addressed directly during a morph so the
// tween can bypass React. Exported so TouchpadLayout renders the same id
// rather than duplicating the literal.
export const NOTCH_PATH_ID = 'proNotchDynamicPath'
export const NOTCH_PATH_B_ID = 'proNotchDynamicPathB'

// Respect the OS "Reduce Motion" setting -- the notch snaps instead of
// easing. Read per-morph rather than cached: the user can flip it mid-session.
const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const EDGE_BLEND = 44 // right edge -> first row's top
const CORNER_BLEND = 32 // first row's top -> its inner edge
const STEP_LAND = 24 // how far below a row's top an S-step touches down
const STEP_LEAD = 20 // straight run kept above a row's top before the S bends
const FOOT_BLEND = 48 // last row's column -> bottom edge
const FOOT_BLEND_TOP = 18
const STEP_CUT = 10
const MIN_STEP_FRAC = 0.045
const MIN_STEP_X_FLOOR = 8

const MORPH_MS = 190
const MIRROR_SETTLE_MS = 1200
const SETTLE_DEBOUNCE_MS = 32
const SKIN_SNAP_WINDOW_MS = SETTLE_DEBOUNCE_MS * 3
// The notch carving itself out on first paint. Slower than a reshape (this
// one is meant to be watched, not just absorbed) and delayed a beat so the
// card has settled before the pad edge starts moving.
const ENTRANCE_MS = 620
const ENTRANCE_DELAY_MS = 120
const OVERSHOOT = 1.35

// easeOutBack. Standard form: 1 + (s+1)(t-1)^3 + s(t-1)^2.
const easeOutBack = (t: number): number => {
  const u = t - 1
  return 1 + (OVERSHOOT + 1) * u * u * u + OVERSHOOT * u * u
}

const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))

export function lerpPath(from: string, to: string, t: number): string {
  const a = from.match(/[MLCZ]|-?\d+(?:\.\d+)?/g) ?? []
  const b = to.match(/[MLCZ]|-?\d+(?:\.\d+)?/g) ?? []
  if (a.length !== b.length) return to
  let out = ''
  let argIndex = 0
  for (let i = 0; i < b.length; i++) {
    const tok = b[i]
    if (/[MLCZ]/.test(tok)) {
      argIndex = 0
      out += tok
      continue
    }
    const av = parseFloat(a[i])
    const bv = parseFloat(b[i])
    // Overshoot can push a value past its endpoint; that's the point, and
    // the clip-path stays valid either way (it's just a slightly larger or
    // smaller bite for a frame or two).
    const val = av + (bv - av) * t
    out += (argIndex % 2 === 0 ? ' ' : ',') + String(Math.round(val * 100) / 100)
    argIndex++
  }
  return out.trim()
}

export function collapsedLevels(w: number, h: number, levels: NotchLevel[]): NotchLevel[] {
  return levels.map(() => ({ x: w, y: h }))
}

// Two paths can be tweened iff their command sequences match exactly.
export function samePathStructure(a: string | null, b: string): boolean {
  if (!a) return false
  const ca = a.match(/[MLCZ]/g)?.join('') ?? ''
  const cb = b.match(/[MLCZ]/g)?.join('') ?? ''
  return ca === cb && ca.length > 0
}

export function canCarveNotch(
  pad: Element | null,
  keyGrid: Element | null,
  iconRow: Element | null
): boolean {
  return !!pad && (!!keyGrid || !!iconRow)
}

export function shouldWaitForMirror(
  mirrorPending: boolean,
  elapsedSinceRotation: number,
  settleMs: number = MIRROR_SETTLE_MS
): boolean {
  return mirrorPending && elapsedSinceRotation < settleMs
}

type NotchLevel = { x: number; y: number; yEnd?: number }

export function useNotchPath(
  touchpadRef: RefObject<HTMLDivElement | null>,
  keyGridRef: RefObject<HTMLDivElement | null>,
  iconRowRef: RefObject<HTMLDivElement | null>,
  handedness: PhoneRemoteHandedness,
  keysPosition: PhoneRemoteKeysPosition = 'bottom',
  pathId: string = NOTCH_PATH_ID,
  isLandscape: boolean = false,
  skin: string = ''
): string | null {
  const [path, setPath] = useState<string | null>(null)
  // The path currently PAINTED (tween included), as opposed to the committed
  // React state. Steady-state frames are written straight to the DOM node, so
  // this is the only thing that knows what's actually on screen mid-morph.
  const paintedRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const snapUntilRef = useRef(0)

  useLayoutEffect(() => {
    snapUntilRef.current = performance.now() + SKIN_SNAP_WINDOW_MS
  }, [skin])

  useEffect(() => {
    const padEl = touchpadRef.current
    const gridEl = keyGridRef.current
    const rowEl = iconRowRef.current
    if (!padEl || !canCarveNotch(padEl, gridEl, rowEl)) return

    const paintPath = (d: string): void => {
      paintedRef.current = d
      document.getElementById(pathId)?.setAttribute('d', d)
    }

    const tween = (
      from: string,
      target: string,
      durationMs: number,
      ease: (t: number) => number,
      delayMs = 0
    ): void => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      const start = performance.now() + delayMs
      const step = (now: number): void => {
        // During the delay the start shape is held on screen, so the notch is
        // already closed when the carve begins rather than popping to closed.
        const t = Math.min(1, Math.max(0, (now - start) / durationMs))
        paintPath(t >= 1 ? target : lerpPath(from, target, ease(t)))
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step)
        } else {
          rafRef.current = null
          // Commit the settled path to state so React's DOM matches reality;
          // otherwise the next render would repaint a stale `d`.
          setPath(target)
        }
      }
      rafRef.current = requestAnimationFrame(step)
    }

    const animateTo = (target: string, entranceFrom: string | null): void => {
      const from = paintedRef.current
      if (performance.now() < snapUntilRef.current) {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
        rafRef.current = null
        paintedRef.current = target
        paintPath(target)
        setPath(target)
        return
      }
      if (prefersReducedMotion()) {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
        paintedRef.current = target
        setPath(target)
        return
      }
      // First paint: carve out from the collapsed shape. React hasn't mounted
      // the <path> yet on this pass, so seed state with the closed shape and
      // let the tween start on the next frame, once the node exists.
      if (!from) {
        if (!entranceFrom || !samePathStructure(entranceFrom, target)) {
          paintedRef.current = target
          setPath(target)
          return
        }
        paintedRef.current = entranceFrom
        setPath(entranceFrom)
        tween(entranceFrom, target, ENTRANCE_MS, easeOutExpo, ENTRANCE_DELAY_MS)
        return
      }
      // Mid-session reshape. A structural change (row count differs) can't be
      // blended pairwise, so it snaps.
      if (!samePathStructure(from, target)) {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
        paintedRef.current = target
        setPath(target)
        return
      }
      tween(from, target, MORPH_MS, easeOutBack)
    }

    let settleFrom = performance.now()
    let settleTimer: number | null = null
    let burstTimer: number | null = null

    // Coalesce a burst of observer/resize ticks into ONE measure+morph.
    // See SETTLE_DEBOUNCE_MS: animating per tick restarts the tween mid-flight.
    const scheduleRecompute = (): void => {
      if (burstTimer !== null) clearTimeout(burstTimer)
      burstTimer = window.setTimeout(() => {
        burstTimer = null
        recompute()
      }, SETTLE_DEBOUNCE_MS)
    }

    // A rotation invalidates the mirror's published width, so the notch must
    // wait for the new one exactly as it does on a cold boot.
    const onOrientation = (): void => {
      settleFrom = performance.now()
      if (settleTimer !== null) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      scheduleRecompute()
    }

    const recompute = (): void => {
      const root = padEl.closest('.proRoot')
      const mirrorPending =
        root?.getAttribute('data-orient') === 'landscape' &&
        root.getAttribute('data-mirror') !== 'off' &&
        !getComputedStyle(padEl.ownerDocument.documentElement)
          .getPropertyValue('--pro-mirror-w')
          .trim()
      const waited = performance.now() - settleFrom
      if (shouldWaitForMirror(!!mirrorPending, waited)) {
        // Nothing schedules another pass on its own if the property never
        // lands, so hold one retry at the deadline.
        if (settleTimer === null) {
          settleTimer = window.setTimeout(() => {
            settleTimer = null
            recompute()
          }, MIRROR_SETTLE_MS - waited)
        }
        return
      }
      const pad = padEl.getBoundingClientRect()
      if (pad.width === 0 || pad.height === 0) return
      const scale = pad.width / (padEl.offsetWidth || pad.width)
      // Everything below derives from screen-pixel rects, so undo the scale
      // once here and the whole builder -- including its pixel constants --
      // works in local space. On the live deck scale is 1 and this is a no-op.
      const unscale = (v: number): number => v / scale
      const w = unscale(pad.width)
      const h = unscale(pad.height)
      // TEMPORARY: reports what recompute MEASURES, to tell
      // "never ran" apart from "ran and measured the wrong box". Remove with
      // the App.tsx rotation diagnostic.
      ;(window as unknown as { __notchTrace?: (s: string) => void }).__notchTrace?.(
        `${pathId} measure w=${Math.round(w)} h=${Math.round(h)} scale=${scale.toFixed(2)}`
      )
      // Sliver threshold scaled to THIS pad (see MIN_STEP_FRAC). Same judgement
      // on any skin at any size, instead of a fixed count tuned to one skin.
      const minStepX = Math.max(w * MIN_STEP_FRAC, MIN_STEP_X_FLOOR)

      const levelFrom = (els: Element[], fallback: Element): NotchLevel | null => {
        const rects = (els.length > 0 ? els : [fallback])
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
        if (rects.length === 0) return null
        // Each delta is measured in screen pixels and unscaled to local space
        // BEFORE the margin is applied -- MARGIN is a local-space constant, so
        // adding it to a scaled delta would shrink the gap by the scale factor.
        const inner =
          handedness === 'right'
            ? unscale(Math.min(...rects.map((r) => r.left)) - pad.left) - MARGIN
            : w - (unscale(Math.max(...rects.map((r) => r.right)) - pad.left) + MARGIN)
        const top = unscale(Math.min(...rects.map((r) => r.top)) - pad.top) - MARGIN
        const bottom = h - (unscale(Math.max(...rects.map((r) => r.bottom)) - pad.top) + MARGIN)
        // Both edges of the row, normalized. `y` is the far edge (where this
        // row's carve STARTS); `yEnd` is the near edge (where it may stop).
        // Keys-on-top reflects y, which also swaps which raw edge is which.
        const far = keysPosition === 'bottom' ? top : bottom
        const near = keysPosition === 'bottom' ? h - bottom : h - top
        return {
          x: Math.min(Math.max(inner, 0), w),
          y: Math.max(0, far),
          yEnd: Math.max(0, near)
        }
      }

      const gridRowEls = gridEl ? Array.from(gridEl.children) : []
      const rawLevels = [
        ...(!gridEl
          ? []
          : gridRowEls.length >= 2
            ? gridRowEls.map((rowContainer) =>
                levelFrom(Array.from(rowContainer.children), rowContainer)
              )
            : [levelFrom([], gridEl)]),
        ...(rowEl ? [levelFrom(Array.from(rowEl.children), rowEl)] : [])
      ].filter((l): l is NotchLevel => l !== null)
      if (rawLevels.length === 0) return

      const ordered = rawLevels.sort((a, b) => a.y - b.y)
      const xs = ordered.map((l) => l.x)
      let runMin = Infinity
      if (keysPosition === 'bottom') {
        for (let i = 0; i < xs.length; i++) xs[i] = runMin = Math.min(runMin, xs[i])
      } else {
        for (let i = xs.length - 1; i >= 0; i--) xs[i] = runMin = Math.min(runMin, xs[i])
      }
      for (let changed = true; changed; ) {
        changed = false
        for (let i = 1; i < xs.length; i++) {
          if (xs[i] !== xs[i - 1] && Math.abs(xs[i] - xs[i - 1]) < minStepX) {
            xs[i] = xs[i - 1] = Math.max(xs[i], xs[i - 1])
            changed = true
          }
        }
      }
      const deepest = Math.min(...xs)
      for (let i = 0; i < xs.length; i++) if (xs[i] < minStepX && xs[i] > deepest) xs[i] = 0
      const levels: NotchLevel[] = ordered.map((l, i) => ({ x: xs[i], y: l.y, yEnd: l.yEnd }))

      // Both reflections applied to the one canonical (right-hand, keys-bottom)
      // path. Order is irrelevant -- they act on independent coordinate slots.
      const reflect = (p: string): string => {
        const hFlipped = handedness === 'right' ? p : mirrorPath(p, w, 'x')
        return keysPosition === 'bottom' ? hFlipped : mirrorPath(hFlipped, h, 'y')
      }

      const foot = keysPosition === 'top' ? FOOT_BLEND_TOP : FOOT_BLEND
      const next = reflect(buildRightPath(w, h, levels, foot))

      const live = document.getElementById(pathId)?.getAttribute('d') ?? null
      const maxX = (p: string | null): string => {
        if (!p) return 'none'
        const xs = (p.match(/[ML] *(-?[\d.]+)/g) ?? []).map((s) => parseFloat(s.slice(1)))
        return xs.length ? String(Math.round(Math.max(...xs))) : '?'
      }
      ;(window as unknown as { __notchTrace?: (s: string) => void }).__notchTrace?.(
        `${pathId} next=${maxX(next)} live=${maxX(live)} painted=${maxX(paintedRef.current)}` +
          ` bail=${next === paintedRef.current && next === live}`
      )
      if (next === paintedRef.current && next === live) return
      // Resync so the tween starts from what is genuinely on screen rather
      // than from a value React has already discarded.
      paintedRef.current = live

      // Only needed on first paint; cheap enough to build unconditionally and
      // keeps animateTo's branching in one place.
      const closed = reflect(buildRightPath(w, h, collapsedLevels(w, h, levels), foot))
      animateTo(next, closed)
    }

    const ro = new ResizeObserver(scheduleRecompute)
    ro.observe(padEl)
    if (gridEl) ro.observe(gridEl)
    if (rowEl) ro.observe(rowEl)
    // Both events, for the same reason App.tsx listens to both: Safari fires
    // resize reliably, orientationchange covers the standalone PWA path.
    window.addEventListener('resize', onOrientation)
    window.addEventListener('orientationchange', onOrientation)
    // First paint is not a burst -- measure now so the entrance carve starts on
    // the frame the deck mounts rather than a debounce later.
    recompute()

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onOrientation)
      window.removeEventListener('orientationchange', onOrientation)
      if (settleTimer !== null) clearTimeout(settleTimer)
      if (burstTimer !== null) clearTimeout(burstTimer)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [touchpadRef, keyGridRef, iconRowRef, handedness, keysPosition, pathId, isLandscape])

  return path
}

export function buildRightPath(
  w: number,
  h: number,
  levels: NotchLevel[],
  footBlend: number = FOOT_BLEND
): string {
  if (levels.length === 0) return `M0,0 L${w},0 L${w},${h} L0,${h} Z`
  const r = CORNER_R

  const first = levels[0]
  const last = levels[levels.length - 1]

  const stepYs: number[] = []
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1]
    const cur = levels[i]
    const ceil = i + 1 < levels.length ? levels[i + 1].y : h
    const late = Math.max(cur.y, prev.yEnd ?? cur.y)
    stepYs[i] = Math.min(cur.x < prev.x ? cur.y : late, ceil)
  }
  const tr = Math.max(0, Math.min(r, first.y))
  const p = [`M${r},0`, `L${w - tr},0`, `C${w - tr * 0.45},0 ${w},${tr * 0.45} ${w},${tr}`]

  const room0 = (levels.length > 1 ? stepYs[1] : h) - first.y
  const c = Math.max(0, Math.min(CORNER_BLEND, (w - first.x) / 2, room0 * 0.45))
  const cy0 = first.y

  const spanAbove = (i: number): number => stepYs[i] - (i > 1 ? stepYs[i - 1] : first.y + c)
  const spanBelowStep = (i: number): number => (i + 1 < levels.length ? stepYs[i + 1] : h) - stepYs[i]

  const entryBudget = first.yEnd !== undefined ? (first.yEnd - first.y) * 0.5 : Infinity
  const f = Math.max(0, Math.min(EDGE_BLEND, cy0 - tr, entryBudget, w - first.x - c))
  p.push(`L${w},${cy0 - f}`)
  p.push(`C${w},${cy0 - f * 0.45} ${w - f * 0.45},${cy0} ${w - f},${cy0}`)

  p.push(`L${first.x + c},${cy0}`)
  p.push(`C${first.x + c * 0.45},${cy0} ${first.x},${cy0 + c * 0.45} ${first.x},${cy0 + c}`)

  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1]
    const cur = levels[i]
    const stepAt = stepYs[i]
    // Blends measured against the bracketing STEPS, so the S-curve can't bend
    // back through the previous one now that steps no longer sit on level tops.
    const lead = Math.max(0, Math.min(STEP_LEAD, spanAbove(i) * 0.4))
    const land = Math.max(0, Math.min(STEP_LAND, spanBelowStep(i) * 0.4))
    const upper = prev.yEnd ?? stepAt // upper row's band end
    const lower = cur.y // lower row's band start

    const inward = cur.x < prev.x
    const top = inward
      ? stepAt - lead
      : Math.min(Math.max(stepAt - lead, upper - STEP_CUT), stepAt)
    const bot = inward
      ? Math.max(Math.min(stepAt + land, lower + STEP_CUT), stepAt)
      : stepAt + land
    // Control points at the thirds rather than both on the midline: that is
    // what gives the S its tangent-continuous flow instead of a corner with
    // the edges merely softened.
    const c1 = top + (bot - top) * 0.55
    const c2 = top + (bot - top) * 0.45
    p.push(`L${prev.x},${top}`)
    p.push(`C${prev.x},${c1} ${cur.x},${c2} ${cur.x},${bot}`)
  }

  // Measured from the LAST STEP rather than the last level's top: the step can
  // now sit below that top, and a foot blend sized off the top would eat back
  // through it into the previous level's column.
  const lastY = levels.length > 1 ? stepYs[levels.length - 1] : last.y
  const b = Math.max(0, Math.min(footBlend, h - lastY - STEP_LAND, last.x - r))
  p.push(`L${last.x},${h - b}`)
  p.push(`C${last.x},${h - b * 0.45} ${last.x - b * 0.45},${h} ${last.x - b},${h}`)

  p.push(`L${r},${h}`, `C${r * 0.45},${h} 0,${h - r * 0.45} 0,${h - r}`)
  p.push(`L0,${r}`, `C0,${r * 0.45} ${r * 0.45},0 ${r},0`, 'Z')
  return p.join(' ')
}

function mirrorPath(path: string, size: number, axis: 'x' | 'y'): string {
  const tokens = path.match(/[MLCZ]|-?\d+(?:\.\d+)?/g) ?? []
  const flipParity = axis === 'x' ? 0 : 1
  let out = ''
  let argIndex = 0
  for (const tok of tokens) {
    if (/[MLCZ]/.test(tok)) {
      argIndex = 0
      out += tok
      continue
    }
    const isX = argIndex % 2 === 0
    const num = parseFloat(tok)
    const val = argIndex % 2 === flipParity ? String(size - num) : String(num)
    out += (isX ? ' ' : ',') + val
    argIndex++
  }
  return out.trim()
}
