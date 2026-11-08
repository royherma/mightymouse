import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { MOUSE_FRAMES, type MouseFrame } from '../assets/mouse'

/**
 * The two-column shell for a wizard step: an art/visual slot on the left, the
 * content column on the right.
 *
 * Why it exists: the tour used to stack everything in one narrow column inside
 * a 480x540 window, which forced every element to shrink to fit and forced two
 * of the five steps to special-case their way out of fixed-height reserved
 * slots. Splitting the axis lets the art and the copy each have room, so
 * neither has to be small.
 *
 * The left slot is optional and hides below `SINGLE_COL_AT` so the primitive
 * isn't welded to one window size — a narrow window gets the old single-column
 * reading order (content only) rather than two cramped halves.
 */

/** Below this width the art column is dropped and content goes full-width. */
const SINGLE_COL_AT = 'min-[720px]:flex'

export function StepLayout({
  art,
  children
}: {
  /** Left column — the mouse art on most steps, the QR on the phone step. */
  art?: ReactNode
  /** Right column — headline, blurb, caps, tiles. */
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex-1 flex items-center gap-8 min-h-0">
      {art && (
        <div
          // 300px holds the widest thing that lands here: the phone step's
          // 256px QR plus its frame padding.
          className={`hidden ${SINGLE_COL_AT} w-[300px] shrink-0 items-center justify-center`}
        >
          {art}
        </div>
      )}
      {/* min-h-0 + overflow-y-auto so a tall step (caps + hint card + tiles all
          on screen at once) scrolls inside the column instead of pushing the
          footer nav off the bottom of the window. */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto flex flex-col justify-center py-1">
        {children}
      </div>
    </div>
  )
}

/**
 * Which pose looks AT a cursor offset from the sprite's center.
 *
 * Deliberately not `vectorToFrame`: that maps a TRAVEL direction (SnailTrail's
 * job — a mouse crawling upward shows you its back), so feeding it a
 * cursor vector makes the sprite turn away the moment the pointer is above it.
 * The tour needs the opposite: the mouse should always be looking at you.
 *
 * The sheet has no upward-tilt poses, so a cursor directly above can't be
 * met head-on. Instead the ring is restricted to the five viewer-facing poses
 * and the sprite leans left/right to follow, staying face-on the whole time.
 * `back*` is never used here.
 */
function cursorFacingFrame(dx: number, dy: number): MouseFrame {
  // Above the sprite: it can't look up, so it faces the viewer and leans toward
  // whichever side the cursor is on. A dead zone keeps a near-vertical cursor
  // from flickering between the two leans.
  const LEAN_PX = 40
  if (dy < 0) {
    if (dx < -LEAN_PX) return 'front-left'
    if (dx > LEAN_PX) return 'front-right'
    return 'front'
  }
  // Below/level: strong horizontal offset turns it side-on, otherwise face-on.
  const TURN_PX = 120
  if (dx < -TURN_PX) return 'left'
  if (dx > TURN_PX) return 'right'
  if (dx < -LEAN_PX) return 'front-left'
  if (dx > LEAN_PX) return 'front-right'
  return 'front'
}

/**
 * The mouse art with its soft radial glow, watching the user's cursor.
 *
 * It turns to face wherever the pointer is: cursor up-and-left of the sprite
 * and it leans that way, picking from the viewer-facing poses via
 * `cursorFacingFrame`. Split out from StepLayout because the phone step swaps
 * the whole left slot for a QR — the glow belongs to the art, not the column.
 *
 * Why this doesn't reuse CursorFacingMouse: that one binds onMouseMove to its
 * OWN element, so it only tracks while the pointer is on top of the sprite. A
 * 200px sprite parked in the left column would be looking away almost all of
 * the time — the pointer is over the buttons on the right. This listens on the
 * window instead, so the mouse follows the user across the whole step.
 */
export function StepArt({ alt = '' }: { alt?: string }): JSX.Element {
  const imgRef = useRef<HTMLImageElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // The rendered frame, tracked in a ref and written straight to img.src: a
  // pointermove-rate setState would re-render the whole step on every mouse
  // twitch for a change React can't see anyway.
  const frameRef = useRef<MouseFrame>('front')

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const box = boxRef.current
      const img = imgRef.current
      if (!box || !img) return

      const rect = box.getBoundingClientRect()
      const dx = e.clientX - (rect.left + rect.width / 2)
      const dy = e.clientY - (rect.top + rect.height / 2)

      const next = cursorFacingFrame(dx, dy)
      if (next === frameRef.current) return // 5 poses, so most moves are no-ops
      frameRef.current = next
      img.src = MOUSE_FRAMES[next]
    }

    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  return (
    /* Fixed square, not a shrink-to-fit flex row: the glow is positioned
       against THIS box, so a wrapper sized by its content let the bloom drift
       off the sprite (it rendered up by the progress bar). */
    <div
      ref={boxRef}
      className="relative w-[240px] h-[240px] flex items-center justify-center shrink-0"
    >
      {/* Warm bloom behind the art. inset-0 ties it to the square above rather
          than to its own intrinsic size. Pointer-events-none so it can never
          eat a click meant for the content column. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, color-mix(in srgb, var(--accent) 26%, transparent) 0%, transparent 70%)'
        }}
      />
      <img
        ref={imgRef}
        src={MOUSE_FRAMES[frameRef.current]}
        alt={alt}
        className="relative w-[200px] h-[200px] object-contain select-none"
        draggable={false}
      />
    </div>
  )
}
