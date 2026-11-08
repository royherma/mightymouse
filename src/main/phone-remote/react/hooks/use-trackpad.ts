import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { CONFIG } from '@shared/config'
import {
  hapticTick,
  hapticDragRelease,
  hapticDragDetent,
  hapticDragEngage,
  resetDragDetent
} from '../haptics'
import {
  touchSpread,
  decideTwoFingerMode,
  zoomStepsFor,
  PINCH_ZOOM_ENABLED,
  SMART_ZOOM_ENABLED,
  type TwoFingerMode
} from '../pinch-zoom'
import type { RingSummonHandle } from '../ring-summon'
import type { RailSummonHandle } from '../scroll-rail'
import type { RubHandle } from '../rub-toggle'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

export const MOVE_THROTTLE_MS = 20
// Tap detection: a touchstart->touchend under this movement (px) and this
// duration counts as a tap/click rather than a drag.
export const TAP_MAX_MOVE_PX = 10
export const TAP_MAX_MS = 300
// Two taps landing within this window and this close together count as a
// double-tap (click-and-drag's sibling gesture) instead of two single taps.
export const DOUBLE_TAP_MAX_MS = 300
export const DOUBLE_TAP_MAX_MOVE_PX = 30
// A 1-finger touch held past this long WITHOUT lifting starts a
// click-and-drag (mirrors MIC_HOLD_THRESHOLD_MS's press-vs-tap split, but
// here "held" means "start dragging" instead of "start recording").
export const DRAG_HOLD_MS = 350
// 44px: a 3-finger swipe fires ONCE and opens a full-screen animation, so the
// cost of a false positive is far higher than for scroll. Well past the 10px
// tap threshold and past the spread of three fingers landing unevenly.
const THREE_FINGER_MIN_TRAVEL_PX = 44
type TrailPoint = { id: number; x: number; y: number; bornAt: number }

interface UseTrackpadArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  showCursor: boolean
  closeAppSwitcher: () => void
  exitTouchMode: () => void
  cursorSurfaceEnabled: boolean
  touchModeLockedRef: RefObject<boolean>
  remoteLogRef: RefObject<(message: string) => void>
  ringClaimRef: MutableRefObject<boolean>
  ringHitRef: MutableRefObject<((t: { clientX: number; clientY: number }) => boolean) | null>
  zoomHitRef: MutableRefObject<((t: { clientX: number; clientY: number }) => boolean) | null>
  minimapHitRef: MutableRefObject<((t: { clientX: number; clientY: number }) => boolean) | null>
  ringSummonRef: MutableRefObject<RingSummonHandle | null>
  ringDraggingRef: MutableRefObject<boolean>
  deferRingRefreshRef: MutableRefObject<(() => void) | null>
  railClaimRef: MutableRefObject<boolean>
  railSummonRef: MutableRefObject<RailSummonHandle | null>
  rubRef: MutableRefObject<RubHandle | null>
  appSwitchOpenRef: RefObject<boolean>
}

/** Owns pad gestures, cursor overlay, trail, and sensitivity. */
export function useTrackpad({
  bus,
  send,
  showCursor,
  closeAppSwitcher,
  exitTouchMode,
  cursorSurfaceEnabled,
  touchModeLockedRef,
  remoteLogRef,
  ringClaimRef,
  ringHitRef,
  zoomHitRef,
  minimapHitRef,
  ringSummonRef,
  ringDraggingRef,
  deferRingRefreshRef,
  railClaimRef,
  railSummonRef,
  rubRef,
  appSwitchOpenRef
}: UseTrackpadArgs) {
  const [touchDotActive, setTouchDotActive] = useState(false)
  const [touchDots, setTouchDots] = useState<{ id: number; x: number; y: number }[]>([])
  const [sensitivity, setSensitivity] = useState({ min: 0.5, max: 4, value: 1 })
  // Pointer position in touchpad-local px (same space as the touch dots). Null
  // until a finger has landed -- rendering nothing is the right idle state.
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)
  const [cursorVisible, setCursorVisible] = useState(false)
  // Comet trail behind the pointer. Newest point is LAST, so index maps
  // directly to age -- the renderer reads that ordering to taper size/opacity
  // without storing a per-point timestamp.
  const [trail, setTrail] = useState<TrailPoint[]>([])
  // Frame clock for the trail's age-based fade, ticked by the sweeper's rAF
  // loop below. Only advances while there are points to draw.
  const [trailNow, setTrailNow] = useState(0)
  // Stock macOS pointer until the Mac reports the user's real settings.
  const [cursorStyle, setCursorStyle] = useState({
    size: 1,
    fill: '#ffffff',
    outline: '#000000',
    animated: false
  })

  // Every gate returning before TouchpadLayout (bootGate, stranded, pairing)
  // unmounts the pad, so listener effects need the mount as a dep or they
  // attach to null forever. The ref stays real -- useNotchPath measures it.
  const [trackpadEl, setTrackpadEl] = useState<HTMLDivElement | null>(null)
  const trackpadRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (trackpadRef.current !== trackpadEl) setTrackpadEl(trackpadRef.current)
  })
  const cursorFadeTimerRef = useRef<number | null>(null)
  const lastTrailPointRef = useRef(new Map<number, { x: number; y: number }>())
  const trailIdRef = useRef(0)
  // Read inside the WS handler, which is set up once and closes over its
  // initial state — a ref keeps it seeing the CURRENT pref instead of whatever
  // showCursor was at mount (it would otherwise always read the default).
  const showCursorRef = useRef(true)

  // Pointer and trail are ONE overlay, so they go together -- clearing the
  // pointer alone strands its comet on the pad. Cancels the pending fade too,
  // or that timer lands later and re-hides an overlay already gone.
  const clearCursorOverlay = useCallback(() => {
    if (cursorFadeTimerRef.current) {
      window.clearTimeout(cursorFadeTimerRef.current)
      cursorFadeTimerRef.current = null
    }
    setCursorVisible(false)
    setCursorPos(null)
    setTrail([])
    lastTrailPointRef.current.clear()
  }, [])

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('sensitivity', (msg) => {
        setSensitivity({ min: msg.min, max: msg.max, value: msg.value })
      }),
      bus.subscribe('cursorAppearance', (msg) => {
        setCursorStyle({ size: msg.size, fill: msg.fill, outline: msg.outline, animated: msg.animated })
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus])

  useEffect(() => {
    const el = trackpadEl
    if (!el) return

    let lastMoveSentAt = 0
    let touchStartX = 0
    let touchStartY = 0
    let touchStartAt = 0
    let lastX = 0
    let lastY = 0
    let maxMoveDuringTouch = 0
    let touchCountAtStart = 0
    let pendingDx = 0
    let pendingDy = 0
    // True once a 1-finger touch has been held past DRAG_HOLD_MS without
    // moving past TAP_MAX_MOVE_PX -- from here on this touch streams
    // dragMove instead of move, until touchend sends dragEnd.
    let dragging = false
    let dragHoldTimer: ReturnType<typeof setTimeout> | null = null
    // True once a 2-finger touch has moved past TAP_MAX_MOVE_PX -- from here
    // on this touch streams scroll instead of being a twoFingerTap candidate.
    let scrolling = false
    // Scroll and pinch are both two fingers, so ONE latch picks between them
    // and holds for the rest of the touch (pinch-zoom.ts). Spread is measured
    // from the touch's origin: two fingers land a few ms apart, so a per-frame
    // delta tracks the second finger arriving, not the hand opening.
    let twoFingerMode: TwoFingerMode = 'undecided'
    let startSpread = 0
    let lastSpread = 0
    let pendingZoomPx = 0
    // Latches for the rest of the touch: the fingers stay down through Mission
    // Control's animation, so re-firing would toggle it straight back out.
    let gestureSent = false
    // Timestamp + position of the last completed 1-finger tap, so the NEXT
    // tap can decide "was that a double-tap?" before deciding to send 'tap'.
    let lastTapAt = 0
    let lastTapX = 0
    let lastTapY = 0
    let pendingTapTimer: ReturnType<typeof setTimeout> | null = null
    // Same three, for the 2-finger tap -- kept separate so a 1-finger tap
    // followed by a 2-finger tap can't pair up into either double-tap.
    let lastTwoFingerTapAt = 0
    let lastTwoFingerTapX = 0
    let lastTwoFingerTapY = 0
    let pendingTwoFingerTapTimer: ReturnType<typeof setTimeout> | null = null
    // When mirror cursor mode is locked, empty phone space becomes a second
    // relative trackpad. The real pad and mirror keep their own handlers.
    let expandedCursorGesture = false

    function isExpandedCursorTarget(target: EventTarget | null, clientY: number): boolean {
      if (!(target instanceof Element)) return false
      const root = document.querySelector<HTMLElement>('.proRoot')
      const style = root ? getComputedStyle(root) : getComputedStyle(document.documentElement)
      const topInset = Number.parseFloat(style.getPropertyValue('--safe-top')) || 0
      const bottomInset = Number.parseFloat(style.getPropertyValue('--pro-safe-bottom')) || 0
      // Preserve the phone's native top and home-indicator gestures.
      if (clientY < topInset || clientY >= window.innerHeight - bottomInset) return false
      return !target.closest(
        '.proTouchpad, .mirrorPane, .mirrorAudioControl, button, a[href], input, textarea, select, [role="button"], [role="switch"], [role="slider"], [contenteditable="true"], [data-clickable]'
      )
    }

    function clearDragHoldTimer(): void {
      if (dragHoldTimer) {
        clearTimeout(dragHoldTimer)
        dragHoldTimer = null
      }
    }

    let lastTraceKey = ''
    let lastTraceAt = 0
    function traceTouch(phase: string, e: TouchEvent, fresh: number): void {
      const ids = Array.from(e.touches, (t) => t.identifier).join(',')
      const key = `${phase}|${e.touches.length}|${fresh > 0}`
      const at = Date.now()
      if (key === lastTraceKey && at - lastTraceAt < 250) return
      lastTraceKey = key
      lastTraceAt = at
      const r = el!.getBoundingClientRect()
      const t0 = e.touches[0]
      const at0 = t0
        ? `x=${Math.round(t0.clientX - r.left)} y=${Math.round(t0.clientY - r.top)}` +
          ` fromR=${Math.round(r.right - t0.clientX)} fromB=${Math.round(r.bottom - t0.clientY)}`
        : 'x=- y=- fromR=- fromB=-'
      remoteLogRef.current(
        `pad ${phase} n=${e.touches.length} ids=[${ids}] fresh=${fresh} ${at0} pad=${Math.round(r.width)}x${Math.round(r.height)} cursor=${showCursorRef.current}`
      )
    }

    function sampleTrail(e: TouchEvent, rect: DOMRect): void {
      const born = performance.now()
      const fresh: TrailPoint[] = []
      const seen = new Set<number>()
      for (let i = 0; i < e.touches.length; i++) {
        const t = e.touches[i]
        seen.add(t.identifier)
        const pos = { x: t.clientX - rect.left, y: t.clientY - rect.top }
        // Sample only once THIS finger has travelled far enough. A stationary
        // finger keeps firing touchmove at the same coordinates; without the
        // gate its trail piles up on one spot.
        const prev = lastTrailPointRef.current.get(t.identifier)
        if (prev && Math.hypot(pos.x - prev.x, pos.y - prev.y) < CONFIG.PHONE_REMOTE.TRAIL_MIN_SAMPLE_PX) {
          continue
        }
        lastTrailPointRef.current.set(t.identifier, pos)
        fresh.push({ id: trailIdRef.current++, x: pos.x, y: pos.y, bornAt: born })
      }
      // Forget lifted fingers, or the map grows for the life of the session and
      // a recycled identifier inherits a stale position.
      for (const id of [...lastTrailPointRef.current.keys()]) {
        if (!seen.has(id)) lastTrailPointRef.current.delete(id)
      }
      traceTouch('sample', e, fresh.length)
      if (fresh.length === 0) return
      // Append (newest last) and drop from the front once over budget. The cap
      // scales with the finger count so each finger keeps a full-length comet
      // instead of N fingers splitting one fixed budget between them.
      const cap = CONFIG.PHONE_REMOTE.TRAIL_MAX_POINTS * Math.max(1, e.touches.length)
      setTrail((t) => [...t, ...fresh].slice(-cap))
    }

    function moveCursorOverlay(e: TouchEvent): void {
      const rect = el!.getBoundingClientRect()
      const t = e.touches[0]
      if (!showCursorRef.current) return
      // The Mac pointer follows the GESTURE finger only -- there is one cursor
      // on the Mac, so a second finger has nothing to move. Only the trail is
      // per-finger.
      setCursorPos({ x: t.clientX - rect.left, y: t.clientY - rect.top })
      setCursorVisible(true)
      sampleTrail(e, rect)

      // Restart the countdown on every move so the pointer fades only after
      // the finger has actually stopped, not mid-drag.
      if (cursorFadeTimerRef.current) window.clearTimeout(cursorFadeTimerRef.current)
      cursorFadeTimerRef.current = window.setTimeout(
        () => setCursorVisible(false),
        CONFIG.PHONE_REMOTE.SHOW_CURSOR_FADE_AFTER_MS
      )
    }

    function syncTouchDots(e: TouchEvent): void {
      const rect = el!.getBoundingClientRect()
      const dots: { id: number; x: number; y: number }[] = []
      for (let i = 0; i < e.touches.length; i++) {
        const t = e.touches[i]
        dots.push({ id: t.identifier, x: t.clientX - rect.left, y: t.clientY - rect.top })
      }
      setTouchDots(dots)
    }

    function onTouchStart(e: TouchEvent, expandedSurface = false): void {
      expandedCursorGesture = expandedSurface
      const t0 = e.touches[0]
      // Before the claim test: any touch at all means the user is mid-run, and
      // a reorder landing now would rebind the ring's listeners under it.
      if (!expandedSurface) deferRingRefreshRef.current?.()
      // Zoom is asked FIRST: it is the outer of the two bands, and ringZoomBand
      // guarantees they never overlap, so first-asked is a real ordering rather
      // than a tiebreak. Both answers land in ringClaimRef -- every reader of it
      // below means "a band owns this touch, stand down", which is equally true
      // either way. Claiming and starting stay ONE call, same as the ring.
      // The minimap is asked before either band: it is an opaque rect painted
      // over them at a higher z, so wherever it overlaps, it is what the user
      // sees under the thumb and the bands are not.
      ringClaimRef.current = !expandedSurface && (
        (!!t0 && (minimapHitRef.current?.(t0) ?? false)) ||
        (!!t0 && (zoomHitRef.current?.(t0) ?? false)) ||
        (!!t0 && (ringHitRef.current?.(t0) ?? false))
      )
      // Reset per-gesture, mirroring ringClaimRef -- a stale true from the
      // PREVIOUS touch would otherwise wrongly claim this new one.
      railClaimRef.current = false
      if (!expandedCursorGesture && ringClaimRef.current) {
        // Nothing below runs: no cursor overlay, no drag timer, no tap state.
        // The ring's own listeners drive the scrub from here.
        ringDraggingRef.current = true
        syncTouchDots(e)
        return
      }
      // The ring is off: this touch might be tracing it into existence. Watched
      // alongside the normal cursor drag, which proceeds untouched -- the
      // gesture only diverges if and when it qualifies, in onTouchMove.
      if (!expandedSurface && t0 && e.touches.length === 1) ringSummonRef.current?.start(t0)
      // Same watch, opposite edge: a touch starting near the off-hand strip
      // might be tracing the scroll rail into existence.
      if (!expandedSurface && t0 && e.touches.length === 1) railSummonRef.current?.start(t0)
      // Third watch on the same touch, top edge instead of a side strip. Unlike
      // the two above it never claims, so it needs no branch of its own below.
      if (!expandedSurface && t0 && e.touches.length === 1) rubRef.current?.start(t0)
      touchCountAtStart = e.touches.length
      const t = e.touches[0]
      touchStartX = lastX = t.clientX
      touchStartY = lastY = t.clientY
      touchStartAt = Date.now()
      maxMoveDuringTouch = 0
      pendingDx = 0
      pendingDy = 0
      dragging = false
      scrolling = false
      gestureSent = false
      twoFingerMode = 'undecided'
      pendingZoomPx = 0
      const [ta, tb] = [e.touches[0], e.touches[1]]
      startSpread =
        tb && ta ? touchSpread(ta.clientX, ta.clientY, tb.clientX, tb.clientY) : 0
      lastSpread = startSpread
      traceTouch('start', e, -1)
      moveCursorOverlay(e)
      syncTouchDots(e)
      setTouchDotActive(true)

      clearDragHoldTimer()
      if (touchCountAtStart === 1) {
        dragHoldTimer = setTimeout(() => {
          dragHoldTimer = null
          if (maxMoveDuringTouch > TAP_MAX_MOVE_PX) return // already moving -> it's a move, not a hold
          dragging = true
          // Fires for real inside the native shell; silent on plain Safari,
          // where engage has no user-activation window and the touch dot stays
          // the only affordance. See hapticDragEngage.
          resetDragDetent()
          hapticDragEngage()
          send({ type: 'dragStart' })
        }, DRAG_HOLD_MS)
      }
    }

    function onTouchMove(e: TouchEvent): void {
      const t = e.touches[0]
      // The ring engaged: this finger is scrubbing the app list, not moving
      // the cursor. Kill any pending drag too -- the hold timer was armed on
      // touchstart, before the ring knew it wanted this touch.
      if (!expandedCursorGesture && ringClaimRef.current) {
        clearDragHoldTimer()
        if (dragging) {
          dragging = false
          send({ type: 'dragEnd' })
        }
        syncTouchDots(e)
        return
      }
      // The rail engaged: this finger is scrolling the document, not moving
      // the cursor. Its own window-scoped listeners (TouchpadLayout) drive
      // the rest of the gesture from here, mirroring the ring's claim above.
      if (!expandedCursorGesture && railClaimRef.current) {
        clearDragHoldTimer()
        if (dragging) {
          dragging = false
          send({ type: 'dragEnd' })
        }
        syncTouchDots(e)
        return
      }
      if (!expandedCursorGesture && t && e.touches.length === 1 && ringSummonRef.current?.move(t)) {
        clearDragHoldTimer()
        if (dragging) {
          dragging = false
          send({ type: 'dragEnd' })
        }
        // The arc that summoned the ring painted a pointer and a trail on the
        // way in. A touch that LANDS on the band never shows either, so drop
        // them now rather than letting the 2.5s fade run under a live ring.
        clearCursorOverlay()
        ringClaimRef.current = true
        ringDraggingRef.current = true
        e.preventDefault()
        syncTouchDots(e)
        return
      }
      if (!expandedCursorGesture && t && e.touches.length === 1 && railSummonRef.current?.move(t)) {
        clearDragHoldTimer()
        if (dragging) {
          dragging = false
          send({ type: 'dragEnd' })
        }
        // Same reasoning as the ring's own handover: the trace that summoned
        // the rail already painted on the way in, so drop the cursor overlay
        // rather than let it fade under a live rail.
        clearCursorOverlay()
        railClaimRef.current = true
        e.preventDefault()
        syncTouchDots(e)
        return
      }
      // No `return` and no claim: the rub toggles screen share from inside the
      // handle, then gets out of the way -- this touch carries on being a
      // cursor move, so the finger never has to stop and lift to recover it.
      if (!expandedCursorGesture && t && e.touches.length === 1) rubRef.current?.move(t)
      moveCursorOverlay(e)
      syncTouchDots(e)
      const dx = t.clientX - lastX
      const dy = t.clientY - lastY
      lastX = t.clientX
      lastY = t.clientY
      const moved = Math.abs(t.clientX - touchStartX) + Math.abs(t.clientY - touchStartY)
      if (moved > maxMoveDuringTouch) maxMoveDuringTouch = moved

      if (e.touches.length >= 3) {
        // Three fingers: a vertical swipe is Mission Control / App Exposé,
        // mirroring the Mac trackpad. Never a scroll or a drag.
        clearDragHoldTimer()
        dragging = false
        if (gestureSent) return
        // Measured from the touch origin, not the frame delta -- three fingers
        // land a few ms apart, so a per-frame dy tracks the last finger
        // arriving rather than the hand travelling.
        const travelY = t.clientY - touchStartY
        if (Math.abs(travelY) < THREE_FINGER_MIN_TRAVEL_PX) return
        if (Math.abs(t.clientX - touchStartX) > Math.abs(travelY)) return
        gestureSent = true
        hapticTick()
        send({ type: 'padGesture', gesture: travelY < 0 ? 'missionControl' : 'closeMissionControl' })
        return
      }

      if (e.touches.length >= 2) {
        // A second finger landed (or this always was 2) -- moving past the
        // tap threshold commits this touch to scrolling, never a drag.
        clearDragHoldTimer()
        dragging = false

        if (PINCH_ZOOM_ENABLED) {
          const ta = e.touches[0]
          const tb = e.touches[1]
          // A second finger that arrives AFTER touchstart has no baseline yet --
          // take it on its first frame, or its whole separation reads as spread
          // and every two-finger scroll would trip the pinch threshold.
          const spread = tb ? touchSpread(ta.clientX, ta.clientY, tb.clientX, tb.clientY) : 0
          if (startSpread === 0 && spread > 0) {
            startSpread = spread
            lastSpread = spread
          }

          twoFingerMode = decideTwoFingerMode(
            twoFingerMode,
            spread === 0 ? 0 : spread - startSpread,
            moved,
            TAP_MAX_MOVE_PX
          )
          if (twoFingerMode === 'undecided') return

          if (twoFingerMode === 'zooming') {
            // Accumulate PIXELS and convert to whole notches, carrying the
            // remainder -- dropping it each frame swallows a slow pinch.
            pendingZoomPx += spread - lastSpread
            const { steps, remainderPx } = zoomStepsFor(pendingZoomPx)
            pendingZoomPx = remainderPx
            lastSpread = spread
            if (steps !== 0) {
              hapticTick()
              send({ type: 'padZoom', steps })
            }
            return
          }
        }

        scrolling = true
        // Two-finger scroll pans too -- same detent treatment as one-finger.
        hapticDragDetent(dx, dy)
        pendingDx += dx
        pendingDy += dy
        const now = Date.now()
        if (now - lastMoveSentAt >= MOVE_THROTTLE_MS) {
          lastMoveSentAt = now
          send({ type: 'scroll', dx: pendingDx, dy: pendingDy })
          pendingDx = 0
          pendingDy = 0
        }
        return
      }

      if (touchCountAtStart >= 2) return // was 2-finger, lifted to 1 mid-gesture -- ignore the tail
      if (!dragging && moved > TAP_MAX_MOVE_PX) clearDragHoldTimer() // moving fast -> plain cursor move, cancel the hold->drag timer

      hapticDragDetent(dx, dy)

      pendingDx += dx
      pendingDy += dy
      const now = Date.now()
      if (now - lastMoveSentAt >= MOVE_THROTTLE_MS) {
        lastMoveSentAt = now
        send(dragging ? { type: 'dragMove', dx: pendingDx, dy: pendingDy } : { type: 'move', dx: pendingDx, dy: pendingDy })
        pendingDx = 0
        pendingDy = 0
      }
    }

    function onTouchEnd(e: TouchEvent): void {
      const wasExpandedCursorGesture = expandedCursorGesture
      traceTouch('end', e, -1)
      syncTouchDots(e)
      setTouchDotActive(false)
      clearDragHoldTimer()
      if (!wasExpandedCursorGesture) {
        ringSummonRef.current?.end()
        railSummonRef.current?.end()
        rubRef.current?.end()
      }

      // A ring scrub ends by activating an app, never by clicking wherever the
      // finger happened to leave the pad. The ring clears the flag itself on
      // the next touchstart, not here -- its own end handler still needs it.
      if (!wasExpandedCursorGesture && ringClaimRef.current) return
      // Same reasoning: a rail drag ends via the rail's own window-scoped
      // listeners (TouchpadLayout), never by clicking under the finger.
      if (!wasExpandedCursorGesture && railClaimRef.current) return

      if (dragging) {
        dragging = false
        // Deferred past touchend teardown (see hapticDragRelease) -- a tick
        // synchronously inside this handler is still "during the touch" to
        // WebKit and got swallowed on-device.
        hapticDragRelease()
        send({ type: 'dragEnd' })
        return
      }
      if (scrolling) {
        scrolling = false
        return
      }

      const duration = Date.now() - touchStartAt
      const isTap = maxMoveDuringTouch <= TAP_MAX_MOVE_PX && duration <= TAP_MAX_MS
      if (!isTap) return

      if (touchCountAtStart >= 3) return // 3 fingers is never a right-click
      if (touchCountAtStart >= 2) {
        // touchend fires once PER FINGER, so a two-finger tap lands here twice.
        // e.touches holds the fingers still DOWN -- wait for the last one, or
        // the second event pairs with the first and every single two-finger tap
        // reads as a double-tap.
        if (e.touches.length > 0) return
        if (!SMART_ZOOM_ENABLED) {
          // No smart zoom to disambiguate against, so right-click fires at once.
          // Deferring it costs DOUBLE_TAP_MAX_MS of felt latency on every
          // two-finger tap, which is the whole gesture's responsiveness.
          hapticTick()
          send({ type: 'twoFingerTap' })
          return
        }
        // Same deferral as the 1-finger path below: a two-finger DOUBLE-tap is
        // smart-zoom on a real trackpad, so the right-click has to wait out the
        // window or the gesture lands as two right-clicks.
        const twoNow = Date.now()
        if (
          pendingTwoFingerTapTimer &&
          twoNow - lastTwoFingerTapAt <= DOUBLE_TAP_MAX_MS &&
          Math.abs(touchStartX - lastTwoFingerTapX) <= DOUBLE_TAP_MAX_MOVE_PX &&
          Math.abs(touchStartY - lastTwoFingerTapY) <= DOUBLE_TAP_MAX_MOVE_PX
        ) {
          clearTimeout(pendingTwoFingerTapTimer)
          pendingTwoFingerTapTimer = null
          lastTwoFingerTapAt = 0
          hapticTick()
          send({ type: 'padGesture', gesture: 'smartZoom' })
          return
        }
        lastTwoFingerTapAt = twoNow
        lastTwoFingerTapX = touchStartX
        lastTwoFingerTapY = touchStartY
        pendingTwoFingerTapTimer = setTimeout(() => {
          pendingTwoFingerTapTimer = null
          hapticTick()
          send({ type: 'twoFingerTap' })
        }, DOUBLE_TAP_MAX_MS)
        return
      }

      // 1-finger tap: decide against the PREVIOUS tap whether this pair is a
      // double-tap. A single tap is sent after DOUBLE_TAP_MAX_MS with no
      // follow-up, so a real double-tap never also fires a spurious single 'tap'.
      const now = Date.now()
      const sincePrevTap = now - lastTapAt
      const nearPrevTap =
        Math.abs(touchStartX - lastTapX) <= DOUBLE_TAP_MAX_MOVE_PX &&
        Math.abs(touchStartY - lastTapY) <= DOUBLE_TAP_MAX_MOVE_PX
      if (pendingTapTimer && sincePrevTap <= DOUBLE_TAP_MAX_MS && nearPrevTap) {
        clearTimeout(pendingTapTimer)
        pendingTapTimer = null
        lastTapAt = 0
        hapticTick()
        send({ type: 'doubleTap' })
        return
      }
      lastTapAt = now
      lastTapX = touchStartX
      lastTapY = touchStartY
      pendingTapTimer = setTimeout(() => {
        pendingTapTimer = null
        // Fires ~300ms after touchend -- still inside iOS/Android's transient
        // user-activation window, so the haptic engines still work here.
        hapticTick()
        send({ type: 'tap' })
      }, DOUBLE_TAP_MAX_MS)
    }

    function onTouchCancel(e: TouchEvent): void {
      traceTouch('cancel', e, -1)
      syncTouchDots(e)
      if (!expandedCursorGesture) rubRef.current?.end()
    }

    function onExpandedTouchStart(e: TouchEvent): void {
      if (
        !cursorSurfaceEnabled ||
        !touchModeLockedRef.current ||
        !e.touches[0] ||
        !isExpandedCursorTarget(e.target, e.touches[0].clientY)
      ) {
        return
      }
      if (e.cancelable) e.preventDefault()
      onTouchStart(e, true)
    }

    function onExpandedTouchMove(e: TouchEvent): void {
      if (!expandedCursorGesture) return
      if (e.cancelable) e.preventDefault()
      onTouchMove(e)
    }

    function onExpandedTouchEnd(e: TouchEvent): void {
      if (!expandedCursorGesture) return
      if (e.cancelable) e.preventDefault()
      onTouchEnd(e)
      if (e.touches.length === 0) expandedCursorGesture = false
    }

    function onExpandedTouchCancel(e: TouchEvent): void {
      if (!expandedCursorGesture) return
      onTouchCancel(e)
      expandedCursorGesture = false
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchCancel, { passive: true })
    document.addEventListener('touchstart', onExpandedTouchStart, { passive: false })
    document.addEventListener('touchmove', onExpandedTouchMove, { passive: false })
    document.addEventListener('touchend', onExpandedTouchEnd, { passive: false })
    document.addEventListener('touchcancel', onExpandedTouchCancel, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
      document.removeEventListener('touchstart', onExpandedTouchStart)
      document.removeEventListener('touchmove', onExpandedTouchMove)
      document.removeEventListener('touchend', onExpandedTouchEnd)
      document.removeEventListener('touchcancel', onExpandedTouchCancel)
      setTouchDots([])
      clearDragHoldTimer()
      if (pendingTapTimer) clearTimeout(pendingTapTimer)
      if (pendingTwoFingerTapTimer) clearTimeout(pendingTwoFingerTapTimer)
    }
  }, [send, trackpadEl, clearCursorOverlay, cursorSurfaceEnabled, touchModeLockedRef])

  // Mirror the Show cursor pref into a ref for the WS handler (which closes
  // over its mount-time state), and clear the overlay the moment it's turned
  // off so a cursor already on screen doesn't linger until its fade elapses.
  useEffect(() => {
    showCursorRef.current = showCursor
    if (!showCursor) clearCursorOverlay()
  }, [showCursor, clearCursorOverlay])

  useEffect(() => {
    if (trail.length === 0) return undefined
    let raf = 0
    const tick = (): void => {
      const t0 = performance.now()
      // Publishing the frame clock is what actually animates the fade: each
      // dot's opacity/size is a function of (now - bornAt), so without a
      // per-frame `now` the dots would sit frozen until a point expired.
      setTrailNow(t0)
      const cutoff = t0 - CONFIG.PHONE_REMOTE.TRAIL_POINT_TTL_MS
      setTrail((t) => {
        const kept = t.filter((p) => p.bornAt > cutoff)
        // Same-length means nothing expired this frame -- return the ORIGINAL
        // array, not a new one, so React can bail out of re-rendering it.
        return kept.length === t.length ? t : kept
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [trail.length === 0])

  useEffect(() => {
    return () => {
      if (cursorFadeTimerRef.current) window.clearTimeout(cursorFadeTimerRef.current)
    }
  }, [])

  const onSensitivityChange = useCallback(
    (value: number) => {
      setSensitivity((s) => ({ ...s, value }))
      send({ type: 'setSensitivity', value })
    },
    [send]
  )

  const onCursorSizeChange = useCallback(
    (size: number) => {
      setCursorStyle((s) => ({ ...s, size }))
      send({ type: 'setCursorSize', value: size })
    },
    [send]
  )

  const onCursorAnimatedChange = useCallback(
    (animated: boolean) => {
      setCursorStyle((s) => ({ ...s, animated }))
      send({ type: 'setCursorAnimated', value: animated })
    },
    [send]
  )

  // Any trackpad interaction while the switcher is open closes it first, so
  // a left-open popup never silently eats trackpad taps.
  const onTrackpadTouchStart = useCallback(() => {
    if (appSwitchOpenRef.current) closeAppSwitcher()
    exitTouchMode()
  }, [closeAppSwitcher, exitTouchMode])

  useEffect(() => {
    const el = trackpadEl
    if (!el) return
    el.addEventListener('touchstart', onTrackpadTouchStart, { passive: true })
    return () => el.removeEventListener('touchstart', onTrackpadTouchStart)
    // Keyed on the node -- see the gesture effect above for why `layout` alone
    // silently left this attached to nothing.
  }, [onTrackpadTouchStart, trackpadEl])

  return {
    sensitivity,
    onSensitivityChange,
    onCursorSizeChange,
    onCursorAnimatedChange,
    trackpadRef,
    touchDotActive,
    touchDots,
    cursorPos,
    cursorVisible,
    cursorStyle,
    trail,
    trailNow
  }
}
