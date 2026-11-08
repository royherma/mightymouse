// ── SnailTrail ────────────────────────────────────────────────────────────────
// A mouse sprite that crawls along an axis, facing the direction it travels,
// with a comet/snail trail of fading copies lagging behind it.
//
// Two operating modes:
//   • Controlled  — caller passes `progress` (0..1). Position is fully driven by
//     the prop; useful as a themed progress indicator.
//   • Auto (default) — no `progress` prop. The sprite bounces back and forth
//     via an internal rAF loop with ease-in-out timing.
//
// Why rAF writes directly to DOM refs instead of useState:
//   Per-frame React state updates would re-render the whole subtree at 60 fps,
//   causing jank. We mirror the island glow pump: grab DOM refs once, mutate
//   transforms directly in the rAF callback — React never sees the animation.
//   Trail segment positions are stored in a plain ring-buffer (not React state)
//   that the rAF callback writes; React only renders the static structure once.

import { useRef, useEffect, useMemo, useCallback, type CSSProperties, type JSX } from 'react'
import { MOUSE_FRAMES, vectorToFrame, headingToFrame, type MouseFrame } from '../assets/mouse'

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrailAxis = 'horizontal' | 'vertical'

/** A point on a custom travel path, in px relative to the SnailTrail container. */
export interface TrailPoint {
  x: number
  y: number
}

export interface SnailTrailProps {
  /** Direction of travel. @default 'horizontal' */
  axis?: TrailAxis
  /**
   * Custom travel path as a polyline of points (px, relative to the container).
   * When set, the sprite walks along the path instead of a straight axis — used
   * by the island to crawl the U around the camera notch. Position is the eased
   * arc-length along the polyline; facing frame comes from the local segment
   * direction. Overrides `axis`.
   */
  path?: TrailPoint[]
  /**
   * Controlled position 0..1 along the axis/path. When provided the sprite is
   * driven by this value; auto-loop is disabled.
   */
  progress?: number
  /** Sprite size in px. @default 28 */
  size?: number
  /**
   * Seconds for one full end-to-end pass in auto mode.
   * @default 4
   */
  speed?: number
  /** Number of trail ghost segments (comet mode only). @default 10 */
  trailLength?: number
  /**
   * Path mode only. When true the trail becomes a glowing stroke that FILLS the
   * path from 0% up to the mouse's current position, then RESETS to empty and the
   * mouse restarts from 0 — a charging/progress lap. The motion is a one-way ramp
   * (no bounce). Requires a `path`. @default false (comet trail + bounce)
   */
  fill?: boolean
  /** Stroke width of the glowing fill in px. @default 3 */
  fillWidth?: number
  /** Override the frame (pose) regardless of travel direction. */
  frame?: MouseFrame
  /**
   * Where the path line passes through the sprite.
   *  • 'center' — path runs through the sprite middle (default).
   *  • 'edge'   — the sprite HANGS off the line, offset along the local edge normal
   *    (perpendicular to travel). The DIRECTION is set by `anchorSide`. So it dangles
   *    off whichever edge it's on, hugging the rounded-rectangle border. @default 'center'
   */
  anchor?: 'center' | 'edge'
  /**
   * Edge-anchor direction (only when `anchor='edge'`).
   *  • 'inward'  — toward the path centroid (into the shape).
   *  • 'outward' — away from the centroid (out of the shape) — e.g. the island mouse
   *    rides the OUTER side of the notch border so it isn't clipped behind the notch.
   * @default 'inward'
   */
  anchorSide?: 'inward' | 'outward'
  /**
   * Trail color (any CSS color). The trail is rendered as fading glowing DOTS in
   * this color — far more visible than ghost-sprite copies. @default 'white'
   */
  trailColor?: string
  className?: string
  style?: CSSProperties
}

// ── Easing ────────────────────────────────────────────────────────────────────

// Cubic ease-in-out: slow at both ends, fast in the middle. Makes the sprite
// feel like a creature rather than a mechanical slider.
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

// Map a 0..1 bounce phase (0=left end, 0.5=right end, 1=left end) to an eased
// 0..1 position. We use a triangle wave: phase 0→0.5 maps raw t to 0→1, phase
// 0.5→1 maps it back 1→0, with ease-in-out applied symmetrically.
function bounceEase(phase: number): number {
  const raw = phase <= 0.5 ? phase * 2 : 2 - phase * 2
  return easeInOut(raw)
}

// ── Path walking ────────────────────────────────────────────────────────────

function isPathProp(p?: TrailPoint[]): p is TrailPoint[] {
  return !!p && p.length >= 2
}

// SVG path `d` for a polyline. Used by the glowing fill stroke.
function polylineD(path: TrailPoint[]): string {
  return path.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
}

// Total length of a polyline + per-segment cumulative lengths, so we can map a
// 0..1 arc-length fraction to a point at constant speed (longer segments take
// proportionally longer to cross — no speed-up on the diagonals).
function pathMetrics(path: TrailPoint[]): {
  total: number
  cum: number[]
  centroid: TrailPoint
} {
  const cum = [0]
  let total = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < path.length; i++) {
    sx += path[i].x
    sy += path[i].y
    if (i > 0) {
      total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
      cum.push(total)
    }
  }
  // Centroid = "inside" of the shape; the edge normal points toward it so the
  // sprite hangs inward off whichever edge it's currently on.
  return { total, cum, centroid: { x: sx / path.length, y: sy / path.length } }
}

// Point + local direction at arc-length fraction `f` (0..1) along the polyline.
function pointOnPath(
  path: TrailPoint[],
  cum: number[],
  total: number,
  f: number
): { x: number; y: number; dx: number; dy: number } {
  if (path.length < 2 || total === 0) {
    const p = path[0] ?? { x: 0, y: 0 }
    return { x: p.x, y: p.y, dx: 0, dy: 0 }
  }
  const dist = Math.max(0, Math.min(1, f)) * total
  // Find the segment containing `dist`.
  let i = 1
  while (i < cum.length && cum[i] < dist) i++
  const a = path[i - 1]
  const b = path[i]
  const segLen = cum[i] - cum[i - 1] || 1
  const t = (dist - cum[i - 1]) / segLen
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    dx: b.x - a.x,
    dy: b.y - a.y
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SnailTrail({
  axis = 'horizontal',
  path,
  progress,
  size = 28,
  speed = 4,
  trailLength = 10,
  frame: frameProp,
  trailColor = 'white',
  anchor = 'center',
  anchorSide = 'inward',
  fill = false,
  fillWidth = 3,
  className,
  style
}: SnailTrailProps): JSX.Element {
  const isFill = fill && isPathProp(path)
  const isControlled = progress !== undefined
  const isPath = !!path && path.length >= 2

  // Precompute polyline arc-length metrics; only recompute when the path changes.
  // Key on the point coords so a structurally-equal new array doesn't churn.
  const pathKey = path?.map((p) => `${p.x},${p.y}`).join(' ')
  const pathMetricsRef = useRef<ReturnType<typeof pathMetrics> | null>(null)
  useMemo(() => {
    pathMetricsRef.current = path && path.length >= 2 ? pathMetrics(path) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey])

  // Ref to the container div so we can measure its pixel width/height once.
  const containerRef = useRef<HTMLDivElement>(null)

  // Ref to the sprite image (head).
  const spriteRef = useRef<HTMLImageElement>(null)

  // Refs to every trail segment (glowing dots), 0 = directly behind the head.
  const segRefs = useRef<(HTMLDivElement | null)[]>([])

  // Fill mode: the glowing stroke that draws 0→current. We animate its
  // stroke-dashoffset (classic "draw the line" trick) from full length (empty) to
  // 0 (full) as progress goes 0→1.
  const fillPathRef = useRef<SVGPathElement>(null)
  const fillSvgRef = useRef<SVGSVGElement>(null)
  const fillLenRef = useRef(0)

  // Ring-buffer of recent head pixel positions, length = trailLength.
  // We store {x, y} in screen coords relative to the container.
  const trailBuf = useRef<{ x: number; y: number }[]>([])

  // Current raw phase in auto mode [0, 1) — advances by Δt/speed each frame.
  const phaseRef = useRef(0)

  // Last timestamp from rAF — used to compute Δt.
  const lastTsRef = useRef<number | null>(null)

  // The frame string currently shown on the sprite — avoids redundant src swaps.
  const currentFrameRef = useRef<MouseFrame>('right')

  // Fill mode lap counter. Each completed lap flips the fill direction: even laps
  // draw 0→1 (left→bottom→right), odd laps draw 1→0 (right→bottom→left). So the
  // mouse + fill alternate which end they start from instead of always snapping
  // back to the same side.
  const lapRef = useRef(0)

  // ── rAF loop ───────────────────────────────────────────────────────────────

  const rafIdRef = useRef<number>(0)

  const tick = useCallback(
    (ts: number) => {
      const container = containerRef.current
      const sprite = spriteRef.current
      if (!container || !sprite) {
        rafIdRef.current = requestAnimationFrame(tick)
        return
      }

      // Measure once per tick (cheap: cached by browser layout engine).
      const containerW = container.offsetWidth
      const containerH = container.offsetHeight

      // Keep the fill SVG pinned to the container's pixel box. A %-sized SVG inside
      // an abspos box collapses to height 0 (the stroke vanishes), so we force numeric
      // width/height here every frame — robust against HMR + late layout.
      const fsvg = fillSvgRef.current
      if (isFill && fsvg && containerW && containerH) {
        if (fsvg.getAttribute('width') !== String(containerW))
          fsvg.setAttribute('width', String(containerW))
        if (fsvg.getAttribute('height') !== String(containerH))
          fsvg.setAttribute('height', String(containerH))
      }

      // ── Compute current position ──────────────────────────────────────────
      // `x`/`y` = sprite top-left offset; `dx`/`dy` = travel direction this frame
      // (drives the facing frame).
      let x = 0
      let y = 0
      let dx = 0
      let dy = 0

      if (isPath) {
        const m = pathMetricsRef.current!
        // `f` = current arc-length fraction along the path. Two motions:
        //  • fill mode → one-way ramp 0→1, then reset to 0 (a charging lap).
        //  • comet/default → bounce 0→1→0.
        // `f` = MOUSE position fraction (0=path start, 1=path end). For the fill we
        // separately track `fillAmt` (how much of the path is lit, always 0→1) and
        // which end it grows from — these flip each lap so the fill alternates sides.
        let f: number
        let prevF: number
        let fillAmt = 0
        let reverse = false
        if (isControlled) {
          f = Math.max(0, Math.min(1, progress!))
          prevF = phaseRef.current
          phaseRef.current = f
          fillAmt = f
        } else {
          const Δt = lastTsRef.current !== null ? (ts - lastTsRef.current) / 1000 : 0
          lastTsRef.current = ts
          const prevPhase = phaseRef.current
          const raw = prevPhase + Δt / speed
          phaseRef.current = raw % 1
          if (isFill) {
            // One linear lap per cycle. On wrap (raw crossed 1) bump the lap counter.
            // `phaseRef` (0→1) IS the fill amount — the lit stroke always GROWS from
            // empty to full each lap. On odd laps the mouse walks the path in REVERSE
            // (f = 1-phase) and the fill grows from the OTHER end, so each lap enters
            // from the opposite side instead of snapping back to the same start.
            if (raw >= 1) lapRef.current += 1
            reverse = lapRef.current % 2 === 1
            fillAmt = phaseRef.current
            f = reverse ? 1 - phaseRef.current : phaseRef.current
            prevF = reverse ? 1 - prevPhase : prevPhase
          } else {
            prevF = bounceEase(prevPhase)
            f = bounceEase(phaseRef.current)
          }
        }

        const p = pointOnPath(path!, m.cum, m.total, f)
        const prev = pointOnPath(path!, m.cum, m.total, prevF)
        dx = p.x - prev.x
        dy = p.y - prev.y

        // Anchor placement. 'edge' offsets the sprite INWARD along the local edge
        // normal (perpendicular to travel, pointing toward the path centroid), so
        // the mouse hangs into the shape off whichever edge it's on — down on the
        // bottom, right on the left edge, left on the right edge. 'center' = on line.
        if (anchor === 'edge') {
          // Local edge normal: rotate the travel dir 90°, then orient by anchorSide.
          let nx = -dy
          let ny = dx
          const nlen = Math.hypot(nx, ny) || 1
          nx /= nlen
          ny /= nlen
          // toC > 0 means the normal currently points toward the centroid (inward).
          const toC = (m.centroid.x - p.x) * nx + (m.centroid.y - p.y) * ny
          // Flip so the normal points the way anchorSide asks: inward → toward
          // centroid, outward → away from it (so the sprite sits OUTSIDE the border).
          const wantInward = anchorSide === 'inward'
          if (wantInward ? toC < 0 : toC > 0) {
            nx = -nx
            ny = -ny
          }
          // Hang the sprite so its NEAR edge sits on the line: center is size/2 along
          // the chosen normal.
          x = p.x + nx * (size / 2) - size / 2
          y = p.y + ny * (size / 2) - size / 2
        } else {
          x = p.x - size / 2
          y = p.y - size / 2
        }

        // Draw the glowing fill. dash gap = len*(1-fillAmt): fillAmt=0 empty, 1 full —
        // the stroke GROWS each lap. On reverse (odd) laps we NEGATE the offset so the
        // dash is consumed from the path's OTHER end, so the fill grows from the
        // opposite side, matching the mouse's reversed walk.
        if (isFill && fillPathRef.current) {
          const len = fillLenRef.current
          const gap = len * (1 - fillAmt)
          fillPathRef.current.style.strokeDashoffset = String(reverse ? -gap : gap)
        }
      } else {
        // Straight-axis mode (original behavior).
        const travelPx = axis === 'horizontal' ? containerW - size : containerH - size
        let pos: number
        if (isControlled) {
          pos = Math.max(0, Math.min(1, progress!)) * travelPx
          const prev = phaseRef.current
          const delta = pos - prev
          phaseRef.current = pos
          if (axis === 'horizontal') dx = delta
          else dy = delta
        } else {
          const Δt = lastTsRef.current !== null ? (ts - lastTsRef.current) / 1000 : 0
          lastTsRef.current = ts
          const prevPhase = phaseRef.current
          phaseRef.current = (phaseRef.current + Δt / speed) % 1
          const prevPos = bounceEase(prevPhase) * travelPx
          pos = bounceEase(phaseRef.current) * travelPx
          const delta = pos - prevPos
          if (axis === 'horizontal') dx = delta
          else dy = delta
        }
        x = axis === 'horizontal' ? pos : 0
        y = axis === 'vertical' ? pos : 0
      }

      // ── Apply sprite transform ────────────────────────────────────────────
      sprite.style.transform = `translate(${x}px, ${y}px)`

      // ── Update facing frame ───────────────────────────────────────────────
      let targetFrame: MouseFrame
      if (frameProp) {
        targetFrame = frameProp
      } else if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
        // Barely moving (eased ends) — hold last frame to prevent snap.
        targetFrame = currentFrameRef.current
      } else {
        targetFrame = vectorToFrame(dx, dy)
      }
      if (targetFrame !== currentFrameRef.current) {
        sprite.src = MOUSE_FRAMES[targetFrame]
        currentFrameRef.current = targetFrame
      }

      // ── Update trail ring buffer ──────────────────────────────────────────
      // Push current head pos; trim to trailLength.
      trailBuf.current.unshift({ x, y })
      if (trailBuf.current.length > trailLength) {
        trailBuf.current.length = trailLength
      }

      // ── Animate trail segments (comet mode only) ──────────────────────────
      // In fill mode the trail is the glowing SVG stroke, so the dots are skipped.
      // Segment 0 = one step behind head, segment N-1 = tail. Each sample in the
      // ring-buffer was the head 1 frame earlier.
      if (!isFill) {
        for (let i = 0; i < trailLength; i++) {
          const el = segRefs.current[i]
          if (!el) continue
          const sample = trailBuf.current[i]
          if (!sample) {
            el.style.opacity = '0'
            continue
          }
          // t = 0 at the segment just behind the head, t = 1 at the tail.
          const t = i / (trailLength - 1)
          // Bright near the head, fading to nothing at the tail.
          const opacity = (1 - t) * 0.9
          // Dots shrink toward the tail. They follow the sprite center (where the
          // trail visually emanates from), giving a comet that lags the head.
          const scale = 1 - t * 0.6
          const cx = sample.x + size / 2
          const cy = sample.y + size / 2
          el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%) scale(${scale})`
          el.style.opacity = String(opacity)
        }
      }

      rafIdRef.current = requestAnimationFrame(tick)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      axis,
      isPath,
      isFill,
      pathKey,
      isControlled,
      progress,
      speed,
      size,
      trailLength,
      frameProp,
      anchor,
      anchorSide
    ]
  )

  useEffect(() => {
    // Seed trail buffer so the first few frames don't show orphan dots.
    trailBuf.current = []
    lastTsRef.current = null

    rafIdRef.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafIdRef.current)
    }
  }, [tick])

  // Fill mode: measure the SVG path's total length once it mounts/changes, then
  // prime it EMPTY (dashoffset = full length). The rAF loop draws it 0→full by
  // shrinking the offset. Re-runs when the path geometry changes.
  useEffect(() => {
    const el = fillPathRef.current
    const svg = fillSvgRef.current
    const container = containerRef.current
    if (!isFill || !el || !svg || !container) return
    // Pin the SVG to the container's exact pixel box. A %-height SVG collapses to
    // height 0 inside an abspos box, so the stroke never shows — set numeric attrs.
    svg.setAttribute('width', String(container.offsetWidth))
    svg.setAttribute('height', String(container.offsetHeight))
    const len = el.getTotalLength()
    fillLenRef.current = len
    el.style.strokeDasharray = String(len)
    el.style.strokeDashoffset = String(len)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFill, pathKey, fillWidth])

  // ── Frame shown in controlled mode during first render (no motion yet) ────
  const initialFrame: MouseFrame =
    frameProp ?? (axis === 'horizontal' ? 'right' : 'front')

  // ── Render ────────────────────────────────────────────────────────────────
  // The container is position:relative; sprite + trail segments are absolute
  // starting at (0,0) — the rAF loop drives their transforms.

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        // Fill the parent so abspos children (and the fill SVG, sized from this box)
        // have real width/height. Without this the div collapses to 0 height — the
        // SVG then renders at height 0 and the trail vanishes. Path-mode needs the
        // parent to be sized (the island's .snail-trail-wrap is the notch box).
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
        ...style
      }}
    >
      {/* Fill mode: a glowing stroke that DRAWS the path 0→100% behind the mouse
          (stroke-dashoffset trick, driven by the rAF loop), then resets each lap.
          overflow:visible + the glow drop-shadow lets it bleed past the box edges
          so the border "glows beautifully on the edges". */}
      {isFill && isPathProp(path) && (
        <svg
          ref={fillSvgRef}
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            display: 'block',
            overflow: 'visible',
            pointerEvents: 'none'
          }}
        >
          <path
            ref={fillPathRef}
            d={polylineD(path)}
            fill="none"
            stroke={trailColor}
            strokeWidth={fillWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              filter: `drop-shadow(0 0 ${Math.round(fillWidth * 1.5)}px ${trailColor}) drop-shadow(0 0 ${Math.round(fillWidth * 3)}px ${trailColor})`
            }}
          />
        </svg>
      )}

      {/* Comet trail = glowing DOTS (not ghost sprites) in `trailColor`. A soft
          radial gradient core + a glow makes the trail read clearly behind the
          mouse. Skipped in fill mode (the SVG stroke is the trail there).
          Rendered BEFORE the head so the head draws on top. */}
      {!isFill && Array.from({ length: trailLength }, (_, i) => {
        const dot = Math.round(size * 0.42) // dot diameter relative to sprite
        return (
          <div
            key={`seg-${i}`}
            ref={(el) => {
              segRefs.current[i] = el
            }}
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: dot,
              height: dot,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${trailColor} 0%, ${trailColor} 35%, transparent 72%)`,
              boxShadow: `0 0 ${Math.round(size * 0.3)}px ${trailColor}`,
              opacity: 0,
              pointerEvents: 'none'
            }}
          />
        )
      })}

      {/* Head sprite */}
      <img
        ref={spriteRef}
        src={MOUSE_FRAMES[initialFrame]}
        alt=""
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          objectFit: 'contain',
          pointerEvents: 'none',
          userSelect: 'none'
        }}
      />
    </div>
  )
}

// ── CursorFacingMouse ─────────────────────────────────────────────────────────
// Stationary sprite that rotates to face the user's cursor. Not animated via
// rAF — it's event-driven (one frame update per mouse-move), so React state is
// appropriate and won't jank.

export function CursorFacingMouse({
  size = 40,
  style,
  className
}: {
  size?: number
  style?: CSSProperties
  className?: string
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const currentFrameRef = useRef<MouseFrame>('front')

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current
    const img = imgRef.current
    if (!container || !img) return

    const rect = container.getBoundingClientRect()
    // Sprite center.
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = e.clientX - cx
    const dy = e.clientY - cy

    const frame = vectorToFrame(dx, dy)
    if (frame !== currentFrameRef.current) {
      img.src = MOUSE_FRAMES[frame]
      currentFrameRef.current = frame
    }
  }, [])

  const handleMouseLeave = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    const frame: MouseFrame = 'front'
    img.src = MOUSE_FRAMES[frame]
    currentFrameRef.current = frame
  }, [])

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...style }}
    >
      <img
        ref={imgRef}
        src={MOUSE_FRAMES['front']}
        alt="Direction-tracking mouse"
        style={{ width: size, height: size, objectFit: 'contain', pointerEvents: 'none' }}
      />
    </div>
  )
}

// ── HeadingDemo ───────────────────────────────────────────────────────────────
// Shows a single mouse sprite snapped to an explicit heading angle, for testing
// headingToFrame directly in the Playground.

export function HeadingDemo({
  deg,
  size = 32
}: {
  deg: number
  size?: number
}): JSX.Element {
  const frame = headingToFrame(deg)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <img
        src={MOUSE_FRAMES[frame]}
        alt={frame}
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
      <span style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'monospace' }}>
        {deg}°
      </span>
      <span style={{ fontSize: 9, color: 'var(--accent)', fontFamily: 'monospace' }}>
        {frame}
      </span>
    </div>
  )
}
