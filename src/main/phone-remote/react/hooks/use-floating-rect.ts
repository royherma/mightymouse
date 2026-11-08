/**
 * The position + size half of a floating overlay: drag to move, two-finger
 * pinch to resize, clamped to the viewport and persisted per surface.
 *
 * Extracted from `CameraPip` so the control island runs the same machine
 * rather than a second copy. Deliberately does NOT own tap gestures --
 * the camera's double-tap-to-flip stays in CameraPip, because a tap means
 * something different on every surface while "where is it and how big" does
 * not.
 */

import { useEffect, useRef, useState } from 'react'

export type FloatingRect = { x: number; y: number; w: number }

export type FloatingRectOptions = {
  /** localStorage key -- each surface persists its own placement. */
  prefKey: string
  /** width / height. A plain number, never a surface-specific union. */
  aspect: number
  minW: number
  maxW: number
  defaultW: number
  bottomInset?: number
  /** Where the surface sits before it has ever been dragged. */
  place: (w: number) => { x: number; y: number }
  /** True for a touch that is a control press, so it must not start a drag. */
  isInteractive?: (target: EventTarget | null) => boolean
  /** Fires on a touch that begins a drag -- a popover owner dismisses here. */
  onDragStart?: () => void
  /** Fires when a drag ended without moving. The surface decides what a tap
   *  means: the camera counts them into a double-tap flip, the island ignores
   *  it. Kept out of the hook because a tap is surface semantics, not layout. */
  onTap?: () => void
  /** Off while the surface is hidden: no listeners, no persistence. */
  enabled?: boolean
}

// A WKWebView can run this before its first layout, where innerWidth is 0 and
// any right/bottom anchor collapses to the opposite edge. Treated as "not
// measurable yet" so the caller can re-place against real dimensions.
/** Tap-vs-drag split for `onTap`. Same numbers the camera's flip used, so the
 *  lift did not change how forgiving a tap is. */
const TAP_MAX_MOVE_PX = 8
const TAP_MAX_MS = 300

export function viewportReady(): boolean {
  return window.innerWidth > 0 && window.innerHeight > 0
}

export function clampRect(rect: FloatingRect, o: FloatingRectOptions): FloatingRect {
  const maxW =
    o.bottomInset === undefined
      ? o.maxW
      : Math.min(o.maxW, (window.innerHeight - o.bottomInset) * o.aspect)
  const w = Math.min(maxW, Math.max(o.minW, rect.w))
  const h = w / o.aspect
  const maxX = Math.max(0, window.innerWidth - w)
  const maxY = Math.max(0, window.innerHeight - (o.bottomInset ?? 0) - h)
  return {
    w,
    x: Math.min(maxX, Math.max(0, rect.x)),
    y: Math.min(maxY, Math.max(0, rect.y))
  }
}

/** Clamping a rect saved under a different viewport welds it to the edge it
 *  overflowed, which reads as the surface placing itself. Re-place instead. */
export function rectFits(rect: FloatingRect, aspect: number, bottomInset = 0): boolean {
  if (!viewportReady()) return true
  const h = rect.w / aspect
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= window.innerWidth &&
    rect.y + h <= window.innerHeight - bottomInset
  )
}

function readPref(key: string): FloatingRect | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.w === 'number'
    ) {
      return parsed
    }
  } catch {
    // Fall through to the default placement.
  }
  return null
}

function writePref(key: string, rect: FloatingRect): void {
  try {
    localStorage.setItem(key, JSON.stringify(rect))
  } catch {
    // Best-effort.
  }
}

export function useFloatingRect(
  nodeRef: React.RefObject<HTMLElement | null>,
  options: FloatingRectOptions
): {
  rect: FloatingRect
  setRect: React.Dispatch<React.SetStateAction<FloatingRect>>
  /** True while a finger is dragging or pinching. A surface with an expensive
   *  paint (a backdrop-filter) drops it for the duration -- re-sampling a
   *  moving backdrop is what costs the framerate. */
  moving: boolean
} {
  const enabled = options.enabled ?? true
  const optRef = useRef(options)
  optRef.current = options

  const [rect, setRect] = useState<FloatingRect>(() => {
    const o = optRef.current
    const saved = readPref(o.prefKey)
    if (saved && rectFits(saved, o.aspect, o.bottomInset)) return saved
    const w = saved?.w ?? o.defaultW
    return { w, ...o.place(w) }
  })

  const rectRef = useRef(rect)
  rectRef.current = rect

  useEffect(() => {
    if (enabled) writePref(optRef.current.prefKey, rect)
  }, [rect, enabled])

  // Re-clamp on rotation/resize so a surface parked near an edge never ends up
  // stranded off-screen after the viewport changes shape.
  useEffect(() => {
    const onResize = (): void => setRect((r) => clampRect(r, optRef.current))
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  // The stream dimensions can arrive after the floating pane mounts. Re-clamp
  // its saved position against the measured aspect so a tall display cannot
  // park its bottom edge off-screen.
  useEffect(() => {
    setRect((current) => {
      const next = clampRect(current, optRef.current)
      return next.x === current.x && next.y === current.y && next.w === current.w ? current : next
    })
  }, [options.aspect, options.bottomInset])

  const [moving, setMoving] = useState(false)
  const [node, setNode] = useState<HTMLElement | null>(null)
  // The node, never a proxy for it: this directory's trackpad and mic both
  // shipped dead listeners from an effect keyed on something that merely
  // described when the node should exist.
  useEffect(() => {
    setNode(nodeRef.current)
  })

  useEffect(() => {
    if (!node || !enabled) return undefined

    let mode: 'none' | 'drag' | 'pinch' = 'none'
    let startX = 0
    let startY = 0
    let dragOriginX = 0
    let dragOriginY = 0
    let pinchStartDist = 0
    let pinchStartW = 0
    let startAt = 0
    let maxMove = 0

    const distance = (t0: Touch, t1: Touch): number =>
      Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)

    function onTouchStart(e: TouchEvent): void {
      e.stopPropagation() // never let this reach the trackpad underneath
      const o = optRef.current
      if (o.isInteractive?.(e.target)) {
        mode = 'none'
        return
      }
      o.onDragStart?.()
      if (e.touches.length === 2) {
        mode = 'pinch'
        setMoving(true)
        pinchStartDist = distance(e.touches[0], e.touches[1])
        pinchStartW = rectRef.current.w
        return
      }
      mode = 'drag'
      setMoving(true)
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      startAt = Date.now()
      maxMove = 0
      dragOriginX = rectRef.current.x
      dragOriginY = rectRef.current.y
    }

    function onTouchMove(e: TouchEvent): void {
      e.stopPropagation()
      const o = optRef.current
      if (mode === 'pinch' && e.touches.length === 2) {
        const dist = distance(e.touches[0], e.touches[1])
        const w = Math.min(o.maxW, Math.max(o.minW, pinchStartW * (dist / pinchStartDist)))
        setRect((r) => clampRect({ ...r, w }, o))
        return
      }
      if (mode !== 'drag' || e.touches.length !== 1) return
      const t = e.touches[0]
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      maxMove = Math.max(maxMove, Math.abs(dx) + Math.abs(dy))
      setRect((r) => clampRect({ ...r, x: dragOriginX + dx, y: dragOriginY + dy }, o))
    }

    function onTouchEnd(e: TouchEvent): void {
      e.stopPropagation()
      if (mode === 'drag' && e.touches.length === 0) {
        const moved = maxMove > TAP_MAX_MOVE_PX || Date.now() - startAt > TAP_MAX_MS
        if (!moved) optRef.current.onTap?.()
      }
      if (e.touches.length === 0) {
        mode = 'none'
        setMoving(false)
      }
    }

    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchmove', onTouchMove, { passive: true })
    node.addEventListener('touchend', onTouchEnd, { passive: true })
    node.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      node.removeEventListener('touchstart', onTouchStart)
      node.removeEventListener('touchmove', onTouchMove)
      node.removeEventListener('touchend', onTouchEnd)
      node.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [node, enabled])

  return { rect, setRect, moving }
}
