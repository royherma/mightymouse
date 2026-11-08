import { useEffect, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import { hapticTick } from './haptics'
import {
  minimapFrame,
  minimapVisible,
  panPointFromTouch,
  viewBoxFraction,
  viewBoxOffset
} from './minimap-geometry'

// The minimap: a small screen-shaped frame showing which part of the Mac the
// glasses are currently looking at, with the view rectangle draggable to aim
// them somewhere else.
//
// Only ever rendered on a CONTROLLER driving glasses (`zoomTrackOn`). It cannot
// nest inside .mirrorPane the way the audio/mic badges do, because a controller
// with glasses has no mirror pane at all -- it isn't mirroring locally, which is
// the same reason mirrorZoom stays at 1 here and the zoom ring keeps its own
// published value. So this floats over the pad instead, and every number it
// draws comes off the wire.
//
// The phone is the single WRITER of the aim point, matching how it already owns
// the viewer's zoom: the glasses never report a pan back, so there is no echo to
// reconcile and no second source of truth. Their own Neural Band swipes still
// pan locally; the phone re-asserts on attach, exactly as the ring does.

export default function MirrorMinimap(props: {
  screenW: number
  screenH: number
  scale: number
  centre: { x: number; y: number }
  onPan: (point: { x: number; y: number }) => void
  hitRef: React.RefObject<((t: { clientX: number; clientY: number }) => boolean) | null>
}): React.JSX.Element {
  const { screenW, screenH, scale, centre, onPan, hitRef } = props
  const frameRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const frame = minimapFrame(screenW, screenH)
  const fraction = viewBoxFraction(scale)
  const box = viewBoxOffset(frame, fraction, centre)

  // At 1x the view IS the whole screen, so there is nothing to aim -- the box
  // fills the frame and a drag would be a no-op that still felt like a control.
  const aimable = fraction < 1

  // Holds the widget up through the dwell after zoom returns to 1x, so a 3x->1x
  // change plays as the box growing to fill the frame rather than as the whole
  // thing blinking out. Starts false: arriving already at 1x (attach with no
  // zoom set) should show nothing at all, which is why this keys on the
  // TRANSITION -- it is only ever armed by having been zoomed.
  const [lingering, setLingering] = useState(false)
  useEffect(() => {
    if (aimable) {
      setLingering(true)
      return
    }
    if (!lingering) return
    const timer = window.setTimeout(
      () => setLingering(false),
      CONFIG.PHONE_REMOTE.MINIMAP_IDLE_HIDE_MS
    )
    return () => window.clearTimeout(timer)
    // `lingering` is read, not tracked: adding it would restart the timer on its
    // own resolution and the widget would never leave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aimable])

  const visible = minimapVisible(aimable, lingering)

  // The pad's gesture handler asks this at touchstart and stands down for the
  // whole gesture if it answers true. The WHOLE frame absorbs, not just the view
  // box: a thumb landing in the dark margin is still aiming the glasses, and
  // letting that one drive the cursor instead is precisely the "it steals my
  // touches" report. Answers false while faded out -- an invisible rect must
  // never eat a tap (the transcript toast's bug).
  useEffect(() => {
    hitRef.current = (t) => {
      if (!aimable || !visible) return false
      const el = frameRef.current
      if (!el) return false
      const r = el.getBoundingClientRect()
      return (
        t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom
      )
    }
    return () => {
      hitRef.current = null
    }
  }, [aimable, hitRef, visible])

  function pointFrom(touch: { clientX: number; clientY: number }): {
    x: number
    y: number
  } | null {
    const el = frameRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return panPointFromTouch(
      frame,
      fraction,
      touch.clientX - rect.left,
      touch.clientY - rect.top
    )
  }

  function onTouchStart(e: React.TouchEvent<HTMLDivElement>): void {
    if (!aimable) return
    // The minimap floats over the live trackpad, so a touch that reaches it must
    // never also be read as a cursor move underneath.
    e.stopPropagation()
    const touch = e.touches[0]
    if (!touch) return
    const point = pointFrom(touch)
    if (!point) return
    draggingRef.current = true
    hapticTick()
    onPan(point)
  }

  function onTouchMove(e: React.TouchEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return
    e.stopPropagation()
    const touch = e.touches[0]
    if (!touch) return
    const point = pointFrom(touch)
    if (point) onPan(point)
  }

  function onTouchEnd(e: React.TouchEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return
    e.stopPropagation()
    draggingRef.current = false
  }

  return (
    <div
      className={`mirrorMinimap${visible ? ' show' : ''}${aimable ? ' aimable' : ''}`}
      aria-hidden={!visible}
      ref={frameRef}
      style={{
        width: frame.width,
        height: frame.height,
        '--mirror-minimap-fade': `${CONFIG.PHONE_REMOTE.MINIMAP_FADE_MS}ms`
      } as React.CSSProperties}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      role="group"
      aria-label="What your glasses are showing"
    >
      <div
        className="mirrorMinimapView"
        style={{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`
        }}
      />
    </div>
  )
}
