import { useEffect, useRef, useState, type RefObject } from 'react'
import { CONFIG } from '@shared/config'
import type { PhoneRemoteHandedness } from '@shared/types'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'
import { hapticTick } from './haptics'
import { controlsRect } from './controls-rect'
import {
  railEdgeFor,
  railRateDelta,
  railSummonBegin,
  railSummonMove,
  railSummonQualifies,
  railZone,
  type RailEdge,
  type RailSummonHandle,
  type RailSummonTrace
} from './scroll-rail'

// Touch handling for the scroll rail: same two rules as useAppRing.ts --
//   1. Listener effects key on the trackpad NODE, never a proxy (gates unmount
//      the pad; 6ef1e72d, 290e45d2).
//   2. The rail's own drag, once summoned, is WINDOW-scoped so it is followed
//      wherever the finger goes, same as the ring's scrub.
// Deliberately simpler than the ring: no dwell, no slots, no dismiss zone --
// just a claimed touch, a rate-zone timer, and a teardown.

/** Where the held finger is on the rail and which way it's driving, or null
 *  whenever nothing is touching it. The island paints a knob from this: with
 *  no cursor of its own on the phone, a thumb on the strip otherwise gets no
 *  confirmation the rail took the touch at all. */
export type RailKnob = {
  /** Along-rail position, 0..1 of the island's own length. */
  t: number
  /** Which way the scroll is going, null until the finger commits to one. In a
   *  rate zone this is the zone's own direction, held while the thumb rests. */
  dir: 'up' | 'down' | null
  /** True in a rate zone, where the scroll continues without the finger
   *  moving -- the knob pulses there so a held thumb reads as live. */
  rate: boolean
}

export type ScrollRailState = {
  edge: RailEdge
  /** True while the island is up. */
  active: boolean
  /** The live touch, or null when the rail is untouched. */
  knob: RailKnob | null
  dismiss: () => void
  /** Which way the island LIES, never which way it scrolls -- both send dy. */
  axis: 'y' | 'x'
  /** Attach to the island. Zones measure against THIS box, never the pad's. */
  islandRef: (el: HTMLDivElement | null) => void
  /** Card-local px from the card's bottom to the cluster's top edge, or null
   *  before it measures. Drives --pro-rail-bottom so the island stops above
   *  the keys instead of sitting on them. */
  bottomInset: number | null
}

/** A touch, trimmed to the fields the rail's own drag reads. Both axes: the
 *  island lies down in landscape, so which one is "along the rail" varies. */
type RailTouch = { identifier: number; clientX: number; clientY: number }

export function useScrollRail(params: {
  trackpadRef: RefObject<HTMLDivElement | null>
  handedness: PhoneRemoteHandedness
  /** Stands the pad's own touch handler down while the rail owns a touch --
   *  same contract as ringClaimRef. */
  claimRef: RefObject<boolean>
  /** Populated with the summon watch the pad drives from onTouchStart/Move,
   *  mirroring ringSummonRef. Null while the rail is already up or unmeasured. */
  summonRef: RefObject<RailSummonHandle | null>
  /** The button cluster, whose top edge the island's bottom stops at. Same ref
   *  useAppRing takes -- the rail now shares the cluster's side. */
  clusterRef: RefObject<HTMLDivElement | null>
  /** Lays the island down along the top instead of standing it on the edge. */
  isLandscape: boolean
  send: (msg: PhoneRemoteMessage) => void
}): ScrollRailState {
  const { trackpadRef, handedness, claimRef, summonRef, clusterRef, isLandscape, send } = params
  const edge = railEdgeFor(handedness)
  const axis: 'y' | 'x' = isLandscape ? 'x' : 'y'

  const [padNode, setPadNode] = useState<HTMLDivElement | null>(null)
  // Preview-only seed: the island is summoned by a gesture, which a harness
  // iframe can't perform, so there'd be no way to LOOK at it (DESIGN.md r10).
  const [activeRaw, setActive] = useState(
    () => (window as Window & { __MM_RAIL_OPEN__?: boolean }).__MM_RAIL_OPEN__ === true
  )
  // Landscape is off for now. Gated here, not in CSS: a hidden island keeps a
  // live hit box, which is exactly what the --pro-rail-thickness collision did.
  const enabled = !isLandscape
  const active = activeRaw && enabled
  const [bottomInset, setBottomInset] = useState<number | null>(null)
  // State, not a ref: the island mounts in the same render `active` flips, so
  // an effect reading a ref binds to null and never re-runs. That exact shape
  // shipped twice here (6ef1e72d, 290e45d2) -- key on the NODE.
  const [islandNode, setIslandNode] = useState<HTMLDivElement | null>(null)

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
  }, [trackpadRef])

  const [knob, setKnob] = useState<RailKnob | null>(null)

  const dismiss = (): void => {
    setActive(false)
    setKnob(null)
    claimRef.current = false
  }

  // Rotating away mid-drag would leave the pad stood down on a claim nothing
  // releases -- dead trackpad until the next touchstart (App.tsx:1297).
  useEffect(() => {
    if (enabled) return
    setActive(false)
    setKnob(null)
    claimRef.current = false
  }, [enabled, claimRef])

  // Measured, not CSS: five separate rules move .proControlsCell (see
  // useClusterTop), so a sibling selector is right in one of those five states.
  useEffect(() => {
    // Lying along the top, the island never reaches the cluster, so there is
    // no inset to measure. Drop the portrait value rather than leave it: it
    // would land as a stale inline style the instant the phone rotates back.
    if (axis === 'x') {
      setBottomInset(null)
      return
    }
    if (!padNode) return
    const measure = (): void => {
      const cluster = clusterRef.current
      // Card-local, not viewport: the island paints inside .proCard.
      const card = padNode.closest('.proCard')?.getBoundingClientRect()
      if (!cluster || !card || card.height < 1) return
      // The BUTTONS' union, not the cell's box: the cell is a fixed percentage
      // of the card, so its top sits well above the topmost key and the island
      // would stop short of the space it's meant to fill (useAppRing:55).
      const cl = controlsRect(cluster)
      if (!cl || cl.height < 1) return
      // Both are siblings of the cluster cell, so controlsRect can't see either.
      let top = cl.top
      // .proAppRingTrack, never .proAppRing: the <svg> is inset:0 over the whole
      // card, so its rect would report a top near the card's and starve the
      // island. The drawn arc's own box is the actual obstacle.
      for (const sel of ['.floatingContextBar', '.proAppRingTrack']) {
        const r = document.querySelector(sel)?.getBoundingClientRect()
        // Horizontal overlap gates it: both can sit on the far side (the bar
        // has its own data-side), where they're no obstacle to this island.
        if (r && r.height > 0 && r.right > cl.left && r.left < cl.right) {
          top = Math.min(top, r.top)
        }
      }
      const inset = card.bottom - top + CONFIG.PHONE_REMOTE.RAIL_CLUSTER_GAP_PX
      setBottomInset((prev) => (prev !== null && Math.abs(prev - inset) < 1 ? prev : inset))
    }
    measure()
    // Coalesced: the card-wide MutationObserver below fires many times per
    // frame during a drag, and measure() reads layout on every call.
    let raf = 0
    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        measure()
      })
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(padNode)
    if (clusterRef.current) {
      ro.observe(clusterRef.current)
      clusterRef.current
        .querySelectorAll<HTMLElement>('.proKeyPill, .proMicBtn, .proIconBtn')
        .forEach((btn) => ro.observe(btn))
    }
    // The bar and the ring MOUNT and unmount rather than resize, which a
    // ResizeObserver never sees -- without this the island keeps the inset it
    // measured before the bar appeared, and the bar lands on top of it.
    const card = padNode.closest('.proCard')
    const mo = new MutationObserver(schedule)
    if (card) mo.observe(card, { childList: true, subtree: true, attributes: true })
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [padNode, clusterRef, axis])

  // Set by the drag effect below once it's listening, so the summon effect
  // can hand off the exact touch that qualified -- same shape as useAppRing's
  // startRef/beginTouch, and for the same reason: the drag effect mounts a
  // render after `active` flips, so the qualifying touch has to be queued.
  const adoptRef = useRef<((t: RailTouch) => void) | null>(null)

  // Publishes the summon watch while the rail is off. Cleared (not left
  // stale) the moment the rail comes up, so a finger that lands on the
  // now-visible island is never mistaken for a fresh summon trace.
  const traceRef = useRef<RailSummonTrace | null>(null)
  useEffect(() => {
    if (active || !padNode || !enabled) {
      summonRef.current = null
      return
    }
    const strip = { edge, padW: padNode.getBoundingClientRect().width }
    summonRef.current = {
      start: (t) => {
        traceRef.current = railSummonBegin(
          { x: pointX(t, padNode), y: pointY(t, padNode), t: performance.now() },
          strip
        )
      },
      move: (t) => {
        const trace = traceRef.current
        if (!trace) return false
        const next = railSummonMove(
          trace,
          { x: pointX(t, padNode), y: pointY(t, padNode), t: performance.now() },
          strip
        )
        traceRef.current = next
        if (!railSummonQualifies(next)) return false
        traceRef.current = null
        hapticTick()
        setActive(true)
        const adopt = { identifier: t.identifier, clientX: t.clientX, clientY: t.clientY }
        requestAnimationFrame(() => adoptRef.current?.(adopt))
        return true
      },
      end: () => {
        traceRef.current = null
      }
    }
    return () => {
      summonRef.current = null
    }
  }, [active, padNode, edge, summonRef, enabled])

  // The rail's own drag + rate zones, once summoned. Window-scoped so the
  // gesture is followed wherever the finger travels, same reasoning as the
  // ring's scrub -- the pad already handed this touch over in onTouchMove.
  useEffect(() => {
    if (!active || !padNode) return
    let touchId: number | null = null
    let lastY = 0
    let rateTimer = 0
    let lastTickAt = 0
    // Held across moves, not recomputed per event: below RAIL_KNOB_DIR_PX a
    // move reports no direction at all, and dropping the chevron on those
    // frames makes it strobe under a thumb that is scrolling steadily.
    let dir: 'up' | 'down' | null = null
    // Accumulates sub-threshold motion so a slow, deliberate drag still
    // commits a direction instead of never clearing the bar.
    let dirFrom = 0

    // The ISLAND's box, not the pad's. Zones are fractions of the rail's own
    // height, so measuring the pad (~2.5x taller) puts the visible middle in a
    // rate zone and the visible ends in 'middle' -- the whole thing reads dead.
    const railBox = (): DOMRect =>
      (islandNode ?? padNode).getBoundingClientRect()

    /** The rail's extent along its OWN axis -- the length the zones divide up. */
    const railLen = (): number => {
      const b = railBox()
      return axis === 'x' ? b.width : b.height
    }

    /** Position along the island, 0..1, from a client coord on the drag axis. */
    const knobT = (client: number): number => {
      const b = railBox()
      const len = railLen()
      if (len <= 0) return 0.5
      const along = (axis === 'x' ? client - b.left : client - b.top) / len
      return along < 0 ? 0 : along > 1 ? 1 : along
    }

    const take = (t: RailTouch): void => {
      if (touchId !== null) return
      touchId = t.identifier
      lastY = axis === 'x' ? t.clientX : t.clientY
      dir = null
      dirFrom = lastY
      // Painted from the touch that STARTED it, not the first move: a tap that
      // never moves must still show the rail took the finger.
      setKnob({ t: knobT(lastY), dir: null, rate: false })
    }
    adoptRef.current = take

    const stopRate = (): void => {
      if (rateTimer) {
        clearInterval(rateTimer)
        rateTimer = 0
      }
    }

    const startRate = (y: number): void => {
      stopRate()
      lastTickAt = Date.now()
      rateTimer = window.setInterval(() => {
        const now = Date.now()
        const dt = now - lastTickAt
        lastTickAt = now
        const dy = railRateDelta(y, railLen(), dt)
        if (dy !== 0) send({ type: 'scroll', dx: 0, dy })
      }, CONFIG.PHONE_REMOTE.RAIL_RATE_TICK_MS)
    }

    const find = (e: TouchEvent): Touch | null => {
      if (touchId === null) return null
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]
        if (t.identifier === touchId) return t
      }
      return null
    }

    const onMove = (e: TouchEvent): void => {
      const t = find(e)
      if (!t) return
      e.preventDefault()
      const box = railBox()
      // Along the rail, whichever way it lies. Both branches still send dy --
      // dragging right on the lying-down island scrolls DOWN, matching the
      // scrollbar model (further along the track = further into the page).
      const along = axis === 'x' ? t.clientX - box.left : t.clientY - box.top
      const zone = railZone(along, railLen())
      const cur = axis === 'x' ? t.clientX : t.clientY
      if (zone === 'middle') {
        stopRate()
        const dy = cur - lastY
        lastY = cur
        // Positive dy is further along the rail, which scrolls DOWN the page --
        // the same convention railRateDelta's sign already follows, so the
        // chevron and the rate zones can never disagree.
        if (Math.abs(cur - dirFrom) >= CONFIG.PHONE_REMOTE.RAIL_KNOB_DIR_PX) {
          dir = cur > dirFrom ? 'down' : 'up'
          dirFrom = cur
        }
        if (dy !== 0) send({ type: 'scroll', dx: 0, dy })
      } else {
        lastY = cur
        // The zone decides, not the finger: in a rate zone the thumb is HELD,
        // so its own motion is noise while the scroll runs one steady way.
        dir = zone === 'rateTop' ? 'up' : 'down'
        dirFrom = cur
        if (!rateTimer) startRate(along)
      }
      setKnob({ t: knobT(cur), dir, rate: zone !== 'middle' })
    }

    const onEnd = (e: TouchEvent): void => {
      if (!find(e)) return
      touchId = null
      stopRate()
      setKnob(null)
      claimRef.current = false
    }

    // A finger LANDING on the island, as opposed to the one that drew it into
    // existence: without this the island only ever responds to its own summon
    // gesture and reads as dead to every later touch.
    const onStart = (e: TouchEvent): void => {
      if (touchId !== null) return
      const t = e.changedTouches[0]
      if (!t) return
      // The ✕ lives inside the island, so a tap on it would otherwise start a
      // drag here and preventDefault its own pointerdown away.
      if ((e.target as Element | null)?.closest('.proScrollRailClose')) return
      e.preventDefault()
      claimRef.current = true
      hapticTick()
      take({ identifier: t.identifier, clientX: t.clientX, clientY: t.clientY })
    }

    const opts = { passive: false } as const
    islandNode?.addEventListener('touchstart', onStart, opts)
    window.addEventListener('touchmove', onMove, opts)
    window.addEventListener('touchend', onEnd, opts)
    window.addEventListener('touchcancel', onEnd, opts)
    return () => {
      stopRate()
      // A teardown mid-touch gets no touchend, so the knob would stay painted
      // at the last position the finger reached -- the exact "is this live?"
      // ambiguity it exists to remove.
      setKnob(null)
      adoptRef.current = null
      islandNode?.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [active, padNode, islandNode, claimRef, axis, send])

  return { edge, active, knob, dismiss, islandRef: setIslandNode, bottomInset, axis }
}

function pointX(t: { clientX: number }, pad: HTMLDivElement): number {
  return t.clientX - pad.getBoundingClientRect().left
}
function pointY(t: { clientY: number }, pad: HTMLDivElement): number {
  return t.clientY - pad.getBoundingClientRect().top
}
