import { CONFIG } from '@shared/config'

// Comet trail behind the touchpad pointer: one dot per sampled touch point,
// tapering in size and opacity from the finger backwards so a drag reads as a
// stroke with direction rather than a scatter of equal dots.
//
// Rendered as N absolutely-positioned divs, not an SVG path or a canvas. At
// TRAIL_MAX_POINTS (14) that's a trivial number of nodes, and it keeps the dots
// in the same coordinate space and stacking context as the pointer itself --
// an SVG overlay would need its own sizing/viewBox kept in sync with the pad,
// which is exactly the kind of duplicated geometry that drifts.

type TrailPoint = { id: number; x: number; y: number; bornAt: number }

export default function CursorTrail(props: {
  points: TrailPoint[]
  /** Frame clock (performance.now()) driving each dot's age-based fade. */
  now: number
}): React.JSX.Element | null {
  const { points, now } = props
  if (points.length === 0) return null

  const {
    TRAIL_DOT_MIN_PX,
    TRAIL_DOT_MAX_PX,
    TRAIL_POINT_TTL_MS,
    TRAIL_COLOR_TAIL,
    TRAIL_COLOR_HEAD
  } = CONFIG.PHONE_REMOTE

  return (
    <div className="cursorTrail" aria-hidden="true">
      {points.map((p) => {
        // t is driven by the point's OWN AGE, not its index. Index-based
        // shading looks identical while a finger is moving, but the moment it
        // stops and the sweeper starts dropping expired points, every surviving
        // dot's index shifts -- so the whole tail visibly jumps brighter and
        // larger on each removal. Age is stable per point: a dot only ever
        // shrinks and fades, from birth to removal, regardless of how many
        // neighbours it has.
        const age = Math.min(1, Math.max(0, (now - p.bornAt) / TRAIL_POINT_TTL_MS))
        const t = 1 - age
        const size = TRAIL_DOT_MIN_PX + (TRAIL_DOT_MAX_PX - TRAIL_DOT_MIN_PX) * t
        // Squared falloff, not linear: a linear ramp leaves the tail's oldest
        // dots too solid, so the stroke ends in a visible stub instead of
        // dissolving. Capped below 1 so even the head sits under the pointer.
        const opacity = 0.95 * t * t
        // Colour travels along the stroke (muted pad brown -> accent amber),
        // so the trail still reads as start -> end without leaving the Pro
        // layout's own warm palette. Saturation carries most of that read --
        // the hue barely moves (32deg -> 25deg), which is what keeps it on
        // brand instead of turning into a rainbow.
        const lerp = (a: number, b: number): number => a + (b - a) * t
        const color = `hsl(${lerp(TRAIL_COLOR_TAIL.h, TRAIL_COLOR_HEAD.h)}, ${lerp(
          TRAIL_COLOR_TAIL.s,
          TRAIL_COLOR_HEAD.s
        )}%, ${lerp(TRAIL_COLOR_TAIL.l, TRAIL_COLOR_HEAD.l)}%)`
        return (
          <div
            key={p.id}
            className="cursorTrailDot"
            style={{
              left: p.x,
              top: p.y,
              width: size,
              height: size,
              // Pull back by half so each dot is centred on its sample point;
              // without this the trail rides down-right of the actual path.
              marginLeft: -size / 2,
              marginTop: -size / 2,
              background: color,
              opacity
            }}
          />
        )
      })}
    </div>
  )
}
