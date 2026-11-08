import { CONFIG } from '@shared/config'
import {
  ringArcPath,
  ringIconOpacity,
  ringIconSize,
  ringLabelBox,
  ringNearness,
  ringPointAt,
  ringDismissZoneT,
  ringPopoutAt,
  ringSlotCenter,
  ringSubArcPath,
  ringZonePath,
  ringZoomT,
  ringZoomTrackT,
  type RingAnchor,
  type RingBand
} from './app-ring-geometry'
import type { QuickSwitchTarget } from './TouchpadControls'

// The arc itself. Renders in .proCard, above the pad face but below the
// control cluster. NOT inside the pad: that box carries the notch carve as a
// clip-path, which trimmed the whole arc away.
//
// The band is ONE stroke. A second path at the same radius drew a bright line
// down its middle, not an outline -- CSS stroke-width beats the JSX attribute.
//
// Glows are filters, not box-shadows: on image skins [data-img] forces
// border-radius: 0, so any box-shadow traces a RECTANGLE regardless of the
// shape drawn (the mic's square halo, shipped twice -- see this directory's
// CLAUDE.md).

/** The band a finger must trace to bring the ring BACK, painted while the ring
 *  is off. Debug-only: on glass the summon region is invisible, so "it wouldn't
 *  come back" and "I never crossed the band" look identical. Same annulus the
 *  summon tracker tests, drawn from the same geometry. */
export function AppRingSummonZone(props: {
  anchor: RingAnchor
  band: RingBand
  mirrored: boolean
}): React.JSX.Element {
  const { anchor, band, mirrored } = props
  return (
    <svg className="proAppRing proAppRingGhost" aria-hidden="true" focusable="false">
      <path
        className="proAppRingZone summon"
        d={ringZonePath(0, 1, anchor, band, mirrored)}
      />
    </svg>
  )
}

/** The zoom track: the outer band, with a knob at the published scale. Paints
 *  whenever a viewer is showing the picture, whether or not the app ring is up
 *  — it is the same geometry either way, so the corner reads as one control
 *  surface rather than as a ring with a stray stripe outside it.
 *
 *  The filled arc runs from the track's zero end to the knob, so the amount of
 *  zoom is readable without moving: on glasses the user cannot see the phone
 *  and the picture at once, and a bare knob on a bare band says nothing about
 *  where it sits in the range. */
export function RingZoomTrack(props: {
  anchor: RingAnchor
  band: RingBand
  mirrored: boolean
  scale: number
  active: boolean
}): React.JSX.Element {
  const { anchor, band, mirrored, scale, active } = props
  // Inset, so the track stops short of the pad edges instead of running into
  // them: the knob centres on this point, and flush it hung half off the pad.
  const t0 = ringZoomTrackT(0, band)
  const t1 = ringZoomTrackT(1, band)
  const t = ringZoomTrackT(ringZoomT(scale), band)
  const knob = ringPointAt(t, anchor, band, mirrored)
  const knobR = CONFIG.PHONE_REMOTE.RING_ZOOM_KNOB_PX / 2
  // While scrubbing, the number moves OFF the band -- the thumb holding the
  // knob is exactly what covers it. Same push-outward the app ring does with
  // the picked icon, from the same helper, so both controls read the same way.
  const popSize = CONFIG.PHONE_REMOTE.RING_ZOOM_POPOUT_PX
  const pop = active ? ringPopoutAt(t, anchor, band, mirrored, popSize) : null
  return (
    <svg className={`proRingZoom${active ? ' live' : ''}`} aria-hidden="true" focusable="false">
      {/* The INSET span, not the full quarter: a stroke drawn past where the
          knob can go advertises dead arc. */}
      <path
        className="proRingZoomTrack"
        d={ringSubArcPath(t0, t1, anchor, band, mirrored)}
        strokeWidth={band.band}
      />
      {/* Zero-length at the track's start, which an `A` command cannot express
          -- it renders nothing, so the fill simply isn't drawn there. */}
      {t > t0 + 0.001 && (
        <path
          className="proRingZoomFill"
          d={ringSubArcPath(t0, t, anchor, band, mirrored)}
          strokeWidth={band.band}
        />
      )}
      <circle className="proRingZoomKnob" cx={knob.x} cy={knob.y} r={knobR} />
      {/* The multiplier, ON the knob at rest: the knob is big enough for two
          glyphs, and beside it would need the clamping the app label does.
          Handed to the popout below while a thumb is on it. */}
      {!pop && (
        <text
          className="proRingZoomLabel"
          x={knob.x}
          y={knob.y}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {`${scale.toFixed(1)}x`}
        </text>
      )}
      {pop && (
        <g className="proRingZoomPop">
          <circle
            className="proRingZoomPopPlate"
            cx={pop.x}
            cy={pop.y}
            r={popSize / 2}
          />
          <text
            className="proRingZoomPopLabel"
            x={pop.x}
            y={pop.y}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {`${scale.toFixed(1)}x`}
          </text>
        </g>
      )}
    </svg>
  )
}

export function AppRing(props: {
  anchor: RingAnchor
  band: RingBand
  mirrored: boolean
  slots: number
  activeSlot: number | null
  activeT: number | null
  apps: QuickSwitchTarget[] | null
  /** Paints the hold-to-hide wedge, so the zone that puts the ring away is
   *  visible instead of inferred. Settings -> Debug layout colors. */
  debugZones: boolean
}): React.JSX.Element {
  const { anchor, band, mirrored, slots, activeSlot, activeT, apps, debugZones } = props
  const path = ringArcPath(anchor, band, mirrored)
  const live = activeSlot !== null

  // One stop per slot, from the SAME ringSlotCenter the hit test inverts, so
  // what you see and the slot it means can never disagree. `near` falls off
  // with arc distance, so icons swell as the thumb nears them.
  const stops = Array.from({ length: slots }, (_, i) => {
    const t = ringSlotCenter(i, slots)
    const near = ringNearness(activeT, t, band, slots)
    return {
      i,
      ...ringPointAt(t, anchor, band, mirrored),
      near,
      size: ringIconSize(near),
      icon: apps?.[i]?.iconPngBase64 || null
    }
  })

  const thumb = activeT === null ? null : ringPointAt(activeT, anchor, band, mirrored)

  // Waiting on the MRU list: the arc is bare until the icons arrive over the
  // wire, and a flat 30% stroke with nothing on it reads as broken rather than
  // loading. The WHOLE band lifts and a highlight travels across it, then hands
  // off to the icons' own stagger, which runs along the same path.
  //
  // Keyed on the FIRST icon, not on `apps`: the list lands before the base64 art
  // does, so gating on the array alone stopped the sweep while the band was
  // still empty. Any icon present means the stagger has something to paint.
  const loading = !stops.some((s) => s.icon)
  // The gradient's own box, in user units, spanning the arc's bounding square.
  // gradientUnits is userSpaceOnUse rather than objectBoundingBox: a stroked
  // arc's bbox includes the stroke width, so the fractional coords would drift
  // with the band thickness instead of tracking the curve.
  const sweepBox = {
    x: Math.min(anchor.cx, anchor.cx + (mirrored ? band.radius : -band.radius)),
    y: Math.min(anchor.cy, anchor.cy + (anchor.keysPosition === 'top' ? band.radius : -band.radius)),
    size: band.radius
  }
  // One id per ring instance would be ideal, but only one ring ever mounts (it
  // is a single card-level sibling), so a constant is honest and keeps the
  // markup readable.
  const sweepGradId = 'proAppRingSweepGrad'

  // The picked app, drawn again clear of the thumb. Rides the FINGER's angle,
  // not the slot's -- a magnifier travels with the touch. The slot only decides
  // WHICH app it shows, so the art swaps while the plate never jumps.
  const popSize = CONFIG.PHONE_REMOTE.APP_RING_POPOUT_PX
  const picked = live && apps ? apps[activeSlot] : null
  const pop =
    picked && activeT !== null
      ? ringPopoutAt(activeT, anchor, band, mirrored, popSize)
      : null
  const label =
    pop && picked?.name
      ? ringLabelBox(pop, anchor, mirrored, popSize, picked.name.length)
      : null

  return (
    <svg
      className={`proAppRing${live ? ' live' : ''}`}
      aria-hidden="true"
      focusable="false"
    >
      {/* Under everything: the debug wedge is a backdrop for the band, never a
          film over the icons it exists to explain. */}
      {debugZones && (
        <path
          className="proAppRingZone dismiss"
          d={ringZonePath(0, ringDismissZoneT(slots), anchor, band, mirrored)}
        />
      )}
      {/* The band. Stroke width IS the band, so the touch target and the
          painted shape are one number. */}
      <path className="proAppRingTrack" d={path} strokeWidth={band.band} />
      {/* The loading sweep: the FULL arc, lit end to end, with a highlight
          travelling across it. Same `d` as the track, so it can never trace a
          different curve -- it differs only by paint.

          A gradient rather than a dash segment: a dash lights part of the band
          and leaves the rest dark, which reads as a progress bar. Every stop
          here is opaque and the STROKE's own opacity holds it under full
          brightness, so the whole ring glows and the shimmer moves within it.

          `gradientTransform` is what animates -- translating the gradient box
          slides the highlight along the arc without touching the geometry. */}
      {loading && (
        <>
          <defs>
            <linearGradient
              id={sweepGradId}
              gradientUnits="userSpaceOnUse"
              x1={sweepBox.x}
              y1={sweepBox.y}
              x2={sweepBox.x + sweepBox.size}
              y2={sweepBox.y + sweepBox.size}
            >
              {/* SMIL, not CSS: `gradientTransform` is an SVG attribute with no
                  CSS property of that name, so a @keyframes naming it is
                  silently dropped (same closed-list trap as @property). The
                  translate runs corner-to-corner along the gradient's own
                  vector -- which is the arc's -- and past both ends, so the
                  highlight clears the band before it repeats. */}
              <animateTransform
                attributeName="gradientTransform"
                type="translate"
                from={`${-sweepBox.size} ${-sweepBox.size}`}
                to={`${sweepBox.size} ${sweepBox.size}`}
                dur="2.2s"
                repeatCount="indefinite"
              />
              <stop offset="0%" stopColor="var(--pro-accent, var(--accent))" stopOpacity="0.55" />
              <stop offset="35%" stopColor="var(--pro-accent, var(--accent))" stopOpacity="0.55" />
              <stop offset="50%" stopColor="var(--pro-accent, var(--accent))" stopOpacity="1" />
              <stop offset="65%" stopColor="var(--pro-accent, var(--accent))" stopOpacity="0.55" />
              <stop offset="100%" stopColor="var(--pro-accent, var(--accent))" stopOpacity="0.55" />
            </linearGradient>
          </defs>
          <path
            className="proAppRingSweep"
            d={path}
            strokeWidth={band.band}
            stroke={`url(#${sweepGradId})`}
          />
        </>
      )}
      {/* The finger's own light, tracking the touch rather than snapping to the
          slot -- the snap is the icon's job, and having both snap makes the
          band feel notchy instead of smooth. Painted UNDER the icons: as a
          translucent accent disc it washes out whichever icon it covers, which
          is always the one being picked. */}
      {thumb && <circle className="proAppRingThumb" cx={thumb.x} cy={thumb.y} r={band.band / 2} />}
      {/* No icon yet, or no apps at all, renders NOTHING. A placeholder circle
          used to stand in for the missing art, but ringSlotCount floors at 1,
          so an empty MRU list painted a lone dot at the arc's midpoint that
          read as a rendering artifact. The band alone shows the ring is live. */}
      {stops.map((s) =>
        s.icon ? (
          <g
            key={s.i}
            className={`proAppRingIcon${s.i === activeSlot ? ' on' : ''}`}
            style={{ '--pro-ring-icon-delay': `${s.i * CONFIG.PHONE_REMOTE.APP_RING_ICON_STAGGER_MS}ms` } as React.CSSProperties}
          >
            {/* Halo behind the picked app only, so the choice is unmistakable
                without waiting for the lift. Sized off the icon so it tracks
                the swell rather than pulsing on its own. */}
            {s.i === activeSlot && (
              <circle className="proAppRingIconHalo" cx={s.x} cy={s.y} r={s.size / 2 + 5} />
            )}
            <image
              href={`data:image/png;base64,${s.icon}`}
              x={s.x - s.size / 2}
              y={s.y - s.size / 2}
              width={s.size}
              height={s.size}
              opacity={ringIconOpacity(s.near)}
              preserveAspectRatio="xMidYMid meet"
            />
          </g>
        ) : null
      )}
      {/* The pick, blown up off the band: the icon ON the arc sits under the
          thumb that chose it. Only the ART is keyed -- keying the plate would
          remount it, so it would jump on every slot crossing. */}
      {pop && picked && (
        <g className="proAppRingPop">
          <circle
            className="proAppRingPopPlate"
            cx={pop.x}
            cy={pop.y}
            r={popSize / 2 + 9}
          />
          {picked.iconPngBase64 && (
            <image
              key={picked.bundleId}
              href={`data:image/png;base64,${picked.iconPngBase64}`}
              x={pop.x - popSize / 2}
              y={pop.y - popSize / 2}
              width={popSize}
              height={popSize}
              preserveAspectRatio="xMidYMid meet"
            />
          )}
          {/* Below the plate, not beside it: the preview can be clamped to
              either pad edge, and a side-anchored label would run off the one
              it was clamped against. The pill is what makes the name readable —
              accent text with a stroke halo washed out over a photo pad. */}
          {label && (
            <>
              <rect
                className="proAppRingLabelPill"
                x={label.cx - label.width / 2}
                y={label.cy - label.height / 2}
                width={label.width}
                height={label.height}
                rx={label.height / 2}
              />
              <text
                className="proAppRingLabel"
                x={label.cx}
                y={label.cy}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {picked.name}
              </text>
            </>
          )}
        </g>
      )}
    </svg>
  )
}
