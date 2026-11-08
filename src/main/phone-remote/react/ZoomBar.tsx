import { useRef } from 'react'
import { Lock, Minus, Plus } from 'lucide-react'
import { CONFIG } from '@shared/config'
import { hapticTick } from './haptics'
import { Button } from '@shared/ui/Button'

// Zoom control for the Pro layout's mirror, sitting directly under the video.
//
// Three interactions in one bar, deliberately:
//   - DRAG anywhere along the track  -> continuous, fine-grained zoom.
//   - TAP an end cap                 -> jump straight to that extreme
//                                       (- = fully zoomed out, + = max).
//   - LONG-PRESS at the current value -> lock the view onto the Mac cursor so
//                                        it keeps following as the cursor
//                                        moves; tap again to unlock.
// The end caps are a jump, NOT a step-by-increment: the common cases are
// "get me all the way in" and "get me back out", and making those one tap
// each beats making them N taps.
//
// Zoom always anchors on the Mac cursor (see zoomToScale in App.tsx) -- this
// component only decides WHAT scale to ask for, never where to center it.
// How close to the knob a press must land to count as a hold-to-lock rather
// than a scrub. Beyond it, the same press is an ordinary jump-and-drag, so
// grabbing the far end of the track never arms follow.
const KNOB_GRAB_PX = 28

/** True when a touch at `clientX` landed on the knob currently sitting at
 *  `pct` along a track spanning [left, left+width]. Exported for test: the
 *  hold-vs-scrub fork hangs entirely off this, and getting it wrong makes the
 *  whole track lock instead of just the knob. */
export function isOnZoomKnob(
  clientX: number,
  pct: number,
  trackLeft: number,
  trackWidth: number
): boolean {
  if (!trackWidth) return false
  const knobX = trackLeft + (pct / 100) * trackWidth
  return Math.abs(clientX - knobX) <= KNOB_GRAB_PX
}

export default function ZoomBar(props: {
  scale: number
  onScaleChange: (scale: number) => void
  followLocked: boolean
  onFollowLockedChange: (locked: boolean) => void
  onDebugLog?: (message: string) => void
}): React.JSX.Element {
  const { scale, onScaleChange, followLocked, onFollowLockedChange, onDebugLog } = props
  const log = (m: string): void => onDebugLog?.('zoomlock ' + m)
  const trackRef = useRef<HTMLDivElement | null>(null)
  // A hold that has fired already: the touchmove/touchend handlers read this
  // to tell "the press became a lock" from "the press was a scrub".
  const holdFiredRef = useRef(false)
  const holdTimerRef = useRef<number | null>(null)
  const holdStartRef = useRef<{ x: number; y: number } | null>(null)
  // The hold timer fires HOLD_MS after touchstart, so reading the prop from
  // its closure would toggle against whatever was current when the finger
  // landed -- stale if anything else flipped the lock meanwhile (zooming out
  // to 1x does exactly that).
  const followLockedRef = useRef(followLocked)
  followLockedRef.current = followLocked

  const MIN = CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MIN
  const MAX = CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MAX
  const HOLD_MS = CONFIG.PHONE_REMOTE.ZOOM_FOLLOW_HOLD_MS
  const SLOP_PX = CONFIG.PHONE_REMOTE.ZOOM_FOLLOW_HOLD_SLOP_PX
  const pct = ((scale - MIN) / (MAX - MIN)) * 100

  // Map a touch's X onto the track's own box -> a scale. Clamped because a
  // drag that starts on the track and slides off its end should pin to the
  // extreme, not compute an out-of-range scale.
  function scaleFromTouch(clientX: number): number {
    const el = trackRef.current
    if (!el) return scale
    const rect = el.getBoundingClientRect()
    if (!rect.width) return scale
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return MIN + t * (MAX - MIN)
  }

  function clearHold(): void {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = null
    holdStartRef.current = null
  }

  function onTouchStart(e: React.TouchEvent<HTMLDivElement>): void {
    const touch = e.touches[0]
    if (!touch) return
    holdFiredRef.current = false

    // Only a press that lands ON the current value arms the hold -- that's the
    // gesture the user described ("hold on the current position"), and it keeps a
    // deliberate scrub elsewhere on the track from ever locking.
    const rect = trackRef.current?.getBoundingClientRect()
    const onKnob = !!rect && isOnZoomKnob(touch.clientX, pct, rect.left, rect.width)
    const knobX = rect ? Math.round(rect.left + (pct / 100) * rect.width) : -1
    log(
      `touchstart x=${Math.round(touch.clientX)} knobX=${knobX} ` +
        `dist=${knobX < 0 ? '?' : Math.round(Math.abs(touch.clientX - knobX))} ` +
        `onKnob=${onKnob} scale=${scale.toFixed(2)} locked=${followLockedRef.current}`
    )

    if (onKnob) {
      holdStartRef.current = { x: touch.clientX, y: touch.clientY }
      holdTimerRef.current = window.setTimeout(() => {
        holdFiredRef.current = true
        holdTimerRef.current = null
        log(`HOLD FIRED -> locked=${!followLockedRef.current}`)
        onFollowLockedChange(!followLockedRef.current)
        hapticTick()
      }, HOLD_MS)
      log(`hold armed (${HOLD_MS}ms)`)
      // Don't scrub on a press that might become a hold -- moving the zoom out
      // from under the finger makes the lock feel like a mis-tap.
      return
    }
    onScaleChange(scaleFromTouch(touch.clientX))
  }

  function onTouchMove(e: React.TouchEvent<HTMLDivElement>): void {
    const touch = e.touches[0]
    if (!touch) return
    const start = holdStartRef.current
    if (start) {
      // Still inside the slop: keep waiting for the hold, don't scrub yet.
      const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y)
      if (moved <= SLOP_PX) return
      // Past it: this is a scrub after all. Cancel the pending lock and let
      // the drag through, so a hold-then-slide still adjusts zoom normally.
      log(`hold CANCELLED by move (${Math.round(moved)}px > ${SLOP_PX})`)
      clearHold()
    }
    if (holdFiredRef.current) return
    onScaleChange(scaleFromTouch(touch.clientX))
  }

  function onTouchEnd(e: React.TouchEvent<HTMLDivElement>): void {
    const wasPendingHold = holdStartRef.current !== null
    clearHold()
    log(`touchend pendingHold=${wasPendingHold} holdFired=${holdFiredRef.current}`)
    if (holdFiredRef.current) return
    // A short press on the knob while locked is the unlock tap. Released
    // before HOLD_MS, so the timer never fired -- handle it here.
    if (wasPendingHold) {
      if (followLockedRef.current) {
        onFollowLockedChange(false)
        hapticTick()
      }
      return
    }
    const touch = e.changedTouches[0]
    if (touch) onScaleChange(scaleFromTouch(touch.clientX))
  }

  return (
    <div className="proZoomBar">
      <Button
        variant="bare"
        className="proZoomEnd"
        aria-label="Zoom out fully"
        onClick={() => onScaleChange(MIN)}
      >
        <Minus size={16} strokeWidth={2.5} />
      </Button>

      {/* touchAction:none so a horizontal drag scrubs zoom instead of being
          claimed by Safari's own scroll/gesture handling. */}
      <div
        className="proZoomTrack"
        ref={trackRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={clearHold}
      >
        <div className="proZoomFill" style={{ width: `${pct}%` }} />
        <div
          className={followLocked ? 'proZoomKnob isFollowLocked' : 'proZoomKnob'}
          style={{ left: `${pct}%` }}
        />
      </div>

      <Button
        variant="bare"
        className="proZoomEnd"
        aria-label="Zoom in fully"
        onClick={() => onScaleChange(MAX)}
      >
        <Plus size={16} strokeWidth={2.5} />
      </Button>

      <div className={followLocked ? 'proZoomValue isFollowLocked' : 'proZoomValue'}>
        {followLocked && <Lock size={10} strokeWidth={3} aria-label="Following cursor" />}
        {scale.toFixed(1)}x
      </div>
    </div>
  )
}
