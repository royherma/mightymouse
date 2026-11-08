import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CONFIG } from '@shared/config'
import type { PhoneRemoteHandedness } from '@shared/types'
import {
  onRing,
  ringBand,
  ringDismissZoneT,
  ringHitBox,
  ringPolar,
  ringSlotAt,
  ringSlotCount,
  ringZoomBand,
  ringZoomScale,
  ringZoomT,
  ringZoomTrackT,
  ringZoomTrackTInverse,
  type RingAnchor,
  type RingBand,
  type RingPoint
} from './app-ring-geometry'
import { controlsRect } from './controls-rect'

// Touch handling for the app ring: measures the cluster via real rects (never
// hand-derived, same as useNotchPath) and turns a drag along the band into a
// slot. Two directory rules shape the effects below:
//   1. The listener effect keys on the trackpad NODE, never a proxy -- gates
//      unmount the pad, so a proxy binds nothing (6ef1e72d, 290e45d2).
//   2. `isLandscape` is a dep the math never reads: rotation changes no other
//      input, so without it the measurement freezes at the old orientation.

export type AppRingState = {
  /** Null until the cluster has been measured, or when there's no room. */
  anchor: RingAnchor | null
  band: RingBand | null
  /** Card-local box of the hit layer, clipped to the band. Null whenever there
   *  is no band. Deliberately not the whole card, and clipped rather than
   *  square: the layer sits above the pad, so anything it covers is stolen
   *  from the trackpad. Spread straight onto the layer's `style`. */
  hitBox: { left: number; top: number; width: number; height: number; clipPath: string } | null
  /** Which slot the finger is on, or null when it isn't scrubbing. */
  activeSlot: number | null
  /** Normalized finger position along the arc, for the touch glow. */
  activeT: number | null
  /** The zoom track, concentric with the app ring and outside it. Measured off
   *  the SAME anchor rather than in a hook of its own: two measurements of one
   *  corner is how the bands would drift apart. Null when there's no room --
   *  or, unlike `band`, when there is nothing on the other end to zoom. */
  zoomBand: RingBand | null
  /** Its hit layer's box, same contract as `hitBox`. */
  zoomHitBox: AppRingState['hitBox']
  /** True while a finger is on the zoom track, for the knob's active paint. */
  zoomActive: boolean
}


/** `onCommit` fires on lift with the settled SLOT -- the caller maps it to a
 *  bundle id against the list it renders, so this hook never resolves an app. */
export function useAppRing(params: {
  /** Whether the ring is ON: it paints and owns touches. Geometry is measured
   *  either way -- the summon gesture traces the band the ring WOULD occupy,
   *  so that band has to exist before the ring does. */
  enabled: boolean
  trackpadRef: RefObject<HTMLDivElement | null>
  /** The unclipped hit layer the scrub listens on. NOT the pad: the pad's notch
   *  is a clip-path, and clipping removes hit-testing along with paint, so the
   *  band's own corner was dead to touches. Card-local, like the arc. */
  hitAreaRef: RefObject<HTMLDivElement | null>
  clusterRef: RefObject<HTMLDivElement | null>
  handedness: PhoneRemoteHandedness
  isLandscape: boolean
  keysPosition: 'top' | 'bottom'
  appCount: number
  /** Set true while the ring owns a touch, so the pad's own handler (which
   *  binds to the SAME node and sees every touch) stands down. A ref because
   *  that handler reads it synchronously inside the event. */
  claimRef: RefObject<boolean>
  onCommit: (slot: number) => void
  onSlotChange?: (slot: number) => void
  /** Fired when the ring's touch ends, after any commit. The caller uses this
   *  to release state it froze for the duration of the drag. */
  onRelease?: () => void
  /** Held at the arc's inner end: the user is putting the ring away. Fired
   *  mid-touch, and the pending activate is cancelled with it. */
  onDismiss?: () => void
  /** Whether the zoom track is live -- a viewer is attached and showing the
   *  picture. Independent of `enabled`: the track is on the OUTER ring and
   *  answers a different question, so a user who never turned the switcher on
   *  still gets it (`APP_RING_DEFAULT` is false, so that is most of them). */
  zoomEnabled: boolean
  /** The scale currently published to the viewer, so the knob paints where the
   *  last drag left it rather than resetting on every render. */
  zoomScale: number
  /** Fires with the resolved SCALE, never a delta or a t -- the same "send the
   *  resolved identity" rule the slot commit follows. */
  onZoom?: (scale: number) => void
  /** Set true while the zoom track owns a touch, same contract as claimRef. */
  zoomClaimRef?: RefObject<boolean>
}): AppRingState & {
  /** True while the ring owns the current touch, so the pad must ignore it. */
  claimsTouch: (t: { clientX: number; clientY: number }) => boolean
  /** A touch in the ring's own coordinate space, or null before the pad
   *  mounts. Lets the pad run the summon tracker against the same geometry
   *  while the ring is off. */
  pointOf: (t: { clientX: number; clientY: number }) => RingPoint | null
  /** Hands a touch the PAD claimed straight to the scrub. The pad's radius test
   *  is the authoritative one, so whatever it concedes must start scrubbing
   *  here -- relying on the hit layer to independently receive it is what left
   *  slots 0-1 owned by nobody (`make why Q="app ring dead slots"`). */
  beginTouch: (t: Touch) => void
  /** The zoom track's claim-and-start, mirroring `claimsTouch` + `beginTouch`
   *  as ONE call. One call because splitting the ring's pair is what left
   *  touches claimed by nobody -- there is no reason to relearn that here. */
  zoomTakes: (t: { clientX: number; clientY: number }) => boolean
} {
  const {
    enabled,
    trackpadRef,
    hitAreaRef,
    clusterRef,
    handedness,
    isLandscape,
    keysPosition,
    appCount,
    claimRef,
    onCommit,
    onSlotChange,
    onRelease,
    onDismiss,
    zoomEnabled,
    zoomScale,
    onZoom,
    zoomClaimRef
  } = params

  // In STATE, not a ref: a ref is invisible to the deps array, so the listener
  // effect would never re-run when the pad mounts.
  const [padNode, setPadNode] = useState<HTMLDivElement | null>(null)
  // The hit layer, same treatment and the same reason -- it mounts only with
  // the ring, so an effect keyed on anything else binds zero listeners.
  const [hitNode, setHitNode] = useState<HTMLDivElement | null>(null)
  const [geom, setGeom] = useState<{ anchor: RingAnchor; band: RingBand } | null>(null)
  const [activeSlot, setActiveSlot] = useState<number | null>(null)
  const [activeT, setActiveT] = useState<number | null>(null)
  const [zoomActive, setZoomActive] = useState(false)

  const slots = useMemo(() => ringSlotCount(appCount), [appCount])
  const mirrored = handedness === 'left'

  // Adopt the pad node once it exists, polling a frame at a time until it lands.
  // NOT gated on `enabled`: the summon gesture traces the band the ring would
  // occupy, so the geometry has to be live while the ring is still off.
  useEffect(() => {
    let raf = 0
    const look = (): void => {
      const el = trackpadRef.current
      if (el) {
        setPadNode(el)
        return
      }
      raf = requestAnimationFrame(look)
    }
    look()
    return () => cancelAnimationFrame(raf)
  }, [trackpadRef, isLandscape])

  // Adopt the hit layer. Unlike the pad it comes and goes with `enabled`, and
  // its box is only rendered once `geom` exists -- so this watches for both
  // edges rather than resolving once.
  useEffect(() => {
    if (!enabled || !geom) {
      setHitNode(null)
      return
    }
    let raf = 0
    const look = (): void => {
      const el = hitAreaRef.current
      if (el) {
        setHitNode(el)
        return
      }
      raf = requestAnimationFrame(look)
    }
    look()
    return () => cancelAnimationFrame(raf)
  }, [enabled, geom, hitAreaRef])

  // Measure the cluster corner the arc wraps. Re-runs on any resize of either
  // box, plus rotation (see rule 2 above).
  useEffect(() => {
    if (!padNode) {
      setGeom(null)
      return
    }
    const measure = (): void => {
      const cluster = clusterRef.current
      if (!cluster) return
      const pad = padNode.getBoundingClientRect()
      const cl = controlsRect(cluster)
      if (!cl || pad.width < 1 || cl.width < 1) return
      // The corner the CONTROLS hug. Handedness picks the horizontal side, keys
      // position the vertical -- the same two axes the notch carve reads.
      const cx = mirrored ? cl.left - pad.left : cl.right - pad.left
      const cy = keysPosition === 'top' ? cl.top - pad.top : cl.bottom - pad.top
      // Per axis, NOT the larger of the two. The cluster is a rectangle, and one
      // shared radius let the ellipse pass through the buttons on whichever axis
      // was narrower -- the arc visibly touching the icons.
      const clusterX = cl.width
      const clusterY = cl.height
      // CARD-local, not pad-local: the pad's notch clip-path trims every child,
      // which erased the arc -- so it paints in .proCard and needs this offset.
      const card = padNode.closest('.proCard')?.getBoundingClientRect() ?? pad
      const ox = pad.left - card.left
      const oy = pad.top - card.top
      const anchor: RingAnchor = {
        cx: cx + ox,
        cy: cy + oy,
        clusterX,
        clusterY,
        // Measured against the PAD though the arc paints in card space: the
        // card is the right canvas but the wrong ruler, since in landscape it
        // also spans the mirror pane the arc can never sweep into.
        reachX: mirrored ? pad.width - cx : cx,
        reachY: keysPosition === 'top' ? pad.height - cy : cy,
        // Floors the radius, so the ring settles at one size whether or not the
        // context bar and the switcher happen to be showing.
        padW: pad.width,
        padH: pad.height,
        keysPosition
      }
      const band = ringBand(anchor)
      // Bail when nothing actually moved. The observers below fire on every
      // button resize, so an unconditional setGeom would re-render the ring
      // (and restart its icon stagger) on layout churn that changed nothing.
      setGeom((prev) => {
        if (!band) return prev === null ? prev : null
        if (
          prev &&
          prev.anchor.cx === anchor.cx &&
          prev.anchor.cy === anchor.cy &&
          prev.band.radius === band.radius
        ) {
          return prev
        }
        return { anchor, band }
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(padNode)
    // The ROWS too: the cell is a fixed percentage of the card, so a skin that
    // resizes the buttons never resizes it, and the arc would stay anchored to
    // the previous skin's extent.
    if (clusterRef.current) {
      ro.observe(clusterRef.current)
      clusterRef.current
        .querySelectorAll<HTMLElement>('.proKeyPill, .proMicBtn, .proIconBtn')
        .forEach((btn) => ro.observe(btn))
    }
    return () => ro.disconnect()
  }, [padNode, clusterRef, mirrored, keysPosition, isLandscape])

  // Where a touch sits, in the ring's terms. Null when it isn't on the band.
  const polarOf = useCallback(
    (t: { clientX: number; clientY: number }): { dist: number; t: number } | null => {
      if (!geom || !padNode) return null
      // Card space, to match the anchor -- see the measure effect.
      const box = padNode.closest('.proCard')?.getBoundingClientRect() ?? padNode.getBoundingClientRect()
      const p = { x: t.clientX - box.left, y: t.clientY - box.top }
      return ringPolar(p, geom.anchor, geom.band, mirrored)
    },
    [geom, padNode, mirrored]
  )

  const claimsTouch = useCallback(
    (t: { clientX: number; clientY: number }): boolean => {
      if (!enabled || !geom) return false
      const polar = polarOf(t)
      return polar ? onRing(polar.dist, geom.band) : false
    },
    [enabled, geom, polarOf]
  )

  // The zoom track, off the same measured anchor. `enabled` is passed through
  // rather than required: the app band is handed over only when the ring is
  // actually PAINTED, so with the switcher off the track takes the corner
  // alone instead of hovering outside an arc that isn't there.
  const zoomBand = useMemo(() => {
    if (!zoomEnabled || !geom) return null
    return ringZoomBand(geom.anchor, enabled ? geom.band : null)
  }, [zoomEnabled, enabled, geom])

  // Card-local point for a touch, so the summon tracker can run the same
  // geometry the ring does while the ring itself is still off.
  const pointOf = useCallback(
    (t: { clientX: number; clientY: number }): RingPoint | null => {
      if (!padNode) return null
      const box = padNode.closest('.proCard')?.getBoundingClientRect() ?? padNode.getBoundingClientRect()
      return { x: t.clientX - box.left, y: t.clientY - box.top }
    },
    [padNode]
  )

  // Lets the pad start a scrub for a touch it claimed by radius. Set by the
  // effect below, so it is null exactly when there is nothing to scrub.
  const startRef = useRef<((t: Touch) => void) | null>(null)
  const beginTouch = useCallback((t: Touch): void => {
    startRef.current?.(t)
  }, [])

  // The scrub itself. Keyed on the hit NODE (rule 1) -- it remounts with the
  // ring, so this rebinds instead of silently holding zero listeners. Listening
  // on the layer rather than the pad is what makes the carved corner live: the
  // pad's clip-path removes hit-testing there, so the band's own end was dead.
  //
  // The layer is NOT the only way in, though. `ringHitBox` stops at the anchor
  // on both legs while `ringPolar` clamps a touch PAST it back onto the arc, so
  // the band's outermost ~32px of slot 0 has no layer above it and the pad --
  // which concedes on that same clamped radius -- handed the touch to nobody.
  // `beginTouch` is the pad driving the scrub directly for exactly those; the
  // move/end listeners go on the WINDOW so a scrub started either way is
  // followed identically once the finger leaves whichever node received it.
  useEffect(() => {
    if (!enabled || !geom) return
    // Ownership settles at touchstart by radius -- the pad tests the same one
    // and stands down, so there is no travel threshold to clear.
    let touchId: number | null = null
    let slot: number | null = null
    // Which slot the dwell timer has already switched to. Lift compares against
    // it so settling and then lifting fires ONE activate, not two.
    let committed: number | null = null
    let dwell = 0

    // Commits on a PAUSE, not on entry: a scrub across five apps would
    // otherwise fire five activateApp calls and thrash the window server.
    //
    // Re-armed on every MOVE, not just on a slot crossing. Gated on the
    // crossing alone it measured "180ms since I entered this slot" -- a slow
    // deliberate scrub clears that inside one slot while the finger is still
    // travelling, so it fired an activate per slot anyway: the exact thrash the
    // dwell exists to prevent. Each activate then costs a real app raise plus a
    // frontmost settle on the Mac, which is what stalls the remote.
    const armDwell = (next: number): void => {
      clearTimeout(dwell)
      if (next === committed) return
      dwell = window.setTimeout(() => {
        committed = next
        onCommit(next)
      }, CONFIG.PHONE_REMOTE.APP_RING_DWELL_MS)
    }

    // Holding at the arc's inner end puts the ring away. A tap in that zone
    // still activates its app, hence a duration rather than a zone alone.
    let dismissTimer = 0
    const armDismiss = (t: number): void => {
      clearTimeout(dismissTimer)
      if (!onDismiss || t > ringDismissZoneT(slots)) return
      dismissTimer = window.setTimeout(() => {
        // Cancels the pending activate: this gesture meant "put it away", and
        // committing the app under the finger on the way out is the opposite.
        clearTimeout(dwell)
        committed = slot
        dismissed = true
        setActiveSlot(null)
        setActiveT(null)
        onDismiss()
      }, CONFIG.PHONE_REMOTE.APP_RING_DISMISS_HOLD_MS)
    }
    // Set once the hold fires, so the lift neither commits nor re-paints.
    let dismissed = false

    const find = (e: TouchEvent): Touch | null => {
      if (touchId === null) return null
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]
        if (t.identifier === touchId) return t
      }
      return null
    }

    // The one place a touch becomes the ring's, whether it arrived through the
    // hit layer or was handed over by the pad. Re-tests the radius so the pad
    // cannot start a scrub the ring disagrees with.
    const take = (t: Touch): void => {
      if (touchId !== null) return
      const polar = polarOf(t)
      if (!polar || !onRing(polar.dist, geom.band)) return
      touchId = t.identifier
      dismissed = false
      slot = ringSlotAt(polar.t, slots)
      // Landing on the band IS the claim: the pad checks the same radius and
      // stands down, so the ring answers the finger on arrival, not after
      // ENGAGE_PX of travel.
      claimRef.current = true
      setActiveT(polar.t)
      setActiveSlot(slot)
      onSlotChange?.(slot)
      armDwell(slot)
      armDismiss(polar.t)
    }
    startRef.current = take

    const onStart = (e: TouchEvent): void => {
      const t = e.changedTouches[0]
      if (t) take(t)
    }

    const onMove = (e: TouchEvent): void => {
      const t = find(e)
      if (!t) return
      const polar = polarOf(t)
      if (!polar) return
      // The ring owns this touch from touchstart, so keep it off the trackpad.
      e.preventDefault()
      if (dismissed) return
      const next = ringSlotAt(polar.t, slots)
      setActiveT(polar.t)
      if (next !== slot) {
        slot = next
        setActiveSlot(next)
        onSlotChange?.(next)
        // Scrubbing away from the stub is a pick, not a dismiss. Re-armed
        // rather than cleared, so scrubbing BACK into the zone can still hold.
        armDismiss(polar.t)
      }
      // Outside the crossing test: the countdown has to restart while the
      // finger keeps moving WITHIN a slot, or it expires mid-scrub and commits
      // an app the user was only passing over.
      armDwell(next)
    }

    const onEnd = (e: TouchEvent): void => {
      if (!find(e)) return
      clearTimeout(dwell)
      clearTimeout(dismissTimer)
      // Commits whether or not the finger travelled, so a tap straight onto an
      // icon picks it. Skipped when dwell already switched here -- lifting off
      // an app you settled on is arriving, not a second choice.
      if (slot !== null && slot !== committed) {
        e.preventDefault()
        onCommit(slot)
      }
      // NOT cleared here: the pad's touchend runs after and reads the flag to
      // suppress its tap. touchstart clears it -- the one point both agree on.
      touchId = null
      slot = null
      committed = null
      setActiveSlot(null)
      setActiveT(null)
      // After the commit, so a list refresh held back for the drag lands on a
      // ring that is no longer under a finger.
      onRelease?.()
    }

    // Non-passive: onMove calls preventDefault once the ring owns the touch,
    // which a passive listener cannot do.
    const opts = { passive: false } as const
    // Only touchstart is node-scoped -- the layer is one of two ways in, and
    // it may not exist yet (it mounts a frame after geom lands).
    hitNode?.addEventListener('touchstart', onStart, opts)
    // Window-scoped, so the gesture is followed wherever it started. `find`
    // gates on the identifier the take() call recorded, so touches the ring
    // never claimed pass straight through to the pad.
    window.addEventListener('touchmove', onMove, opts)
    window.addEventListener('touchend', onEnd, opts)
    window.addEventListener('touchcancel', onEnd, opts)
    return () => {
      clearTimeout(dwell)
      clearTimeout(dismissTimer)
      startRef.current = null
      hitNode?.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled, hitNode, geom, slots, polarOf, onCommit, onSlotChange, onRelease, onDismiss])

  // The zoom scrub. Deliberately NOT the app ring's scrub with a flag: that one
  // owns slots, a dwell timer and a dismiss zone, none of which a continuous
  // control has, and threading three "not in zoom mode" guards through it is
  // how the ring's own logic would rot. What they share is the geometry above.
  //
  // No hit layer of its own either. The pad concedes by radius and calls
  // `zoomTakes`, which is the ring's `beginTouch` path -- the one that already
  // works. The layer exists for the ring because its arc end sits under the
  // pad's clip-path; the zoom track is further out, over live pad.
  const zoomStateRef = useRef<{ id: number; grabT: number; startScale: number } | null>(null)
  // Read inside the drag, and the drag must NOT rebind when it changes -- the
  // scale updates on every move, so a dep on it would tear the listeners down
  // and back up mid-gesture, losing the touch id the whole drag hangs on.
  const zoomScaleRef = useRef(zoomScale)
  zoomScaleRef.current = zoomScale
  // The scale this track last SENT. Cleared once the prop catches up, so the
  // glasses' own dial is not ignored forever. Read at grab time -- see there.
  const zoomSentRef = useRef<number | null>(null)
  if (zoomSentRef.current !== null && Math.abs(zoomScale - zoomSentRef.current) < 1e-6) {
    zoomSentRef.current = null
  }
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom
  useEffect(() => {
    if (!zoomBand || !geom) return
    // The last value SENT, so the step below throttles against the wire rather
    // than against a prop that only comes back after a round trip.
    let last = zoomScaleRef.current

    const find = (e: TouchEvent): Touch | null => {
      const s = zoomStateRef.current
      if (!s) return null
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === s.id) return e.changedTouches[i]
      }
      return null
    }

    const onMove = (e: TouchEvent): void => {
      const t = find(e)
      const s = zoomStateRef.current
      if (!t || !s) return
      const polar = polarOf(t)
      if (!polar) return
      // Owned since touchstart, so the pad must not also read this as a drag.
      e.preventDefault()
      // Radius is ignored on purpose: once the track has the touch it keeps it
      // however far the thumb wanders off the band. Releasing a control because
      // the finger drifted 20px is the behaviour a physical knob doesn't have.
      const next = ringZoomScale(zoomTFor(s, polar.t, zoomBand))
      // A wire message per touchmove is ~60/s of JSON at glasses latency. The
      // step is what makes it a control rather than a flood; it is in SCALE, so
      // it means the same thing at both ends of the track.
      if (Math.abs(next - last) < CONFIG.PHONE_REMOTE.RING_ZOOM_MIN_STEP) return
      last = next
      zoomSentRef.current = next
      onZoomRef.current?.(next)
    }

    const onEnd = (e: TouchEvent): void => {
      const t = find(e)
      if (!t) return
      // Flush where the thumb actually ended: the step throttle drops the last
      // sub-step move, and fine-tuning is made entirely of sub-step moves.
      const s = zoomStateRef.current
      const polar = s && polarOf(t)
      if (s && polar) {
        const settled = ringZoomScale(zoomTFor(s, polar.t, zoomBand))
        if (settled !== last) {
          last = settled
          onZoomRef.current?.(settled)
        }
      }
      zoomStateRef.current = null
      setZoomActive(false)
      // NOT cleared here, same as the ring: the pad's touchend reads the claim
      // to suppress its tap, and touchstart is the one point both agree on.
    }

    const opts = { passive: false } as const
    window.addEventListener('touchmove', onMove, opts)
    window.addEventListener('touchend', onEnd, opts)
    window.addEventListener('touchcancel', onEnd, opts)
    return () => {
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [zoomBand, geom, polarOf])

  const zoomTakes = useCallback(
    (t: { clientX: number; clientY: number }): boolean => {
      if (!zoomBand || zoomStateRef.current) return false
      const polar = polarOf(t)
      // Slack capped to the gap: the two strokes sit 5px apart, and the outer
      // band wins ties by radius, so full slack here would reach back over the
      // app ring when the switcher is on.
      if (!polar || !onRing(polar.dist, zoomBand, CONFIG.PHONE_REMOTE.RING_ZOOM_GRAB_SLACK_PX))
        return false
      // `identifier` is what the move/end listeners match on. A synthetic point
      // (the hit test alone) has none, so it can claim but never scrub -- which
      // is exactly the split that broke the ring. Refuse instead.
      if (!('identifier' in t)) return false
      zoomStateRef.current = {
        id: (t as Touch).identifier,
        grabT: polar.t,
        // What this track last sent, falling back to the prop. The prop is the
        // viewer's echo, so re-grabbing before a round trip lands would anchor
        // the drag to a stale origin and snap the knob under the thumb.
        startScale: zoomSentRef.current ?? zoomScaleRef.current
      }
      if (zoomClaimRef) zoomClaimRef.current = true
      setZoomActive(true)
      return true
    },
    [zoomBand, polarOf, zoomClaimRef]
  )

  return {
    anchor: geom?.anchor ?? null,
    band: geom?.band ?? null,
    hitBox: geom ? ringHitBox(geom.anchor, geom.band, mirrored) : null,
    activeSlot,
    activeT,
    zoomBand,
    zoomHitBox:
      geom && zoomBand
        ? ringHitBox(geom.anchor, zoomBand, mirrored, CONFIG.PHONE_REMOTE.RING_ZOOM_GRAB_SLACK_PX)
        : null,
    zoomActive,
    claimsTouch,
    pointOf,
    beginTouch,
    zoomTakes
  }
}

/** Zoom `t` for a drag: where the thumb started, plus how far it travelled.
 *  Runs in TRACK space then converts back -- the travel is arc and the track is
 *  an inset sub-range of it, so adding a raw arc delta to a zoom `t` would move
 *  the knob further than the finger. Both terms must speak the same units. */
function zoomTFor(s: { grabT: number; startScale: number }, t: number, band: RingBand): number {
  const from = ringZoomTrackT(ringZoomT(s.startScale), band)
  return ringZoomTrackTInverse(from + (t - s.grabT), band)
}
