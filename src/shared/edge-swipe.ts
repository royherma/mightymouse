const EDGE_PX = 24
const SLOP_PX = 8
const FLING_PX_PER_MS = 0.5

export type SwipeDirection = 'right' | 'left'

export interface EdgeSwipeOptions {
  direction: SwipeDirection
  fromEdgeOnly: boolean
  width: () => number
  onDrag: (dx: number) => void
  onEnd: (commit: boolean) => void
  ignore?: (target: EventTarget | null) => boolean
}

export function swipeCommits(dx: number, ms: number, width: number, direction: SwipeDirection): boolean {
  const toward = direction === 'right' ? dx : -dx
  return toward > width / 3 || toward / Math.max(1, ms) > FLING_PX_PER_MS
}

export function attachEdgeSwipe(opts: EdgeSwipeOptions): () => void {
  let startX = 0
  let startY = 0
  let startT = 0
  let dx = 0
  let tracking = false
  let dragging = false

  const down = (e: TouchEvent): void => {
    const t = e.touches[0]
    tracking = false
    dragging = false
    if (e.touches.length !== 1 || !t) return
    if (opts.fromEdgeOnly && t.clientX > EDGE_PX) return
    if (opts.ignore?.(e.target)) return
    startX = t.clientX
    startY = t.clientY
    startT = e.timeStamp
    dx = 0
    tracking = true
  }

  const move = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!tracking || !t) return
    const x = t.clientX - startX
    const y = t.clientY - startY
    if (!dragging) {
      if (Math.abs(x) < SLOP_PX && Math.abs(y) < SLOP_PX) return
      const wrongWay = opts.direction === 'right' ? x < 0 : x > 0
      if (Math.abs(y) > Math.abs(x) || wrongWay) {
        tracking = false
        return
      }
      dragging = true
    }
    e.preventDefault()
    dx = opts.direction === 'right' ? Math.max(0, x) : Math.min(0, x)
    opts.onDrag(dx)
  }

  const finish = (commit: boolean): void => {
    const was = dragging
    tracking = false
    dragging = false
    if (was) opts.onEnd(commit)
  }
  const up = (e: TouchEvent): void => finish(dragging && swipeCommits(dx, e.timeStamp - startT, opts.width(), opts.direction))
  const cancel = (): void => finish(false)

  document.addEventListener('touchstart', down, { passive: true })
  document.addEventListener('touchmove', move, { passive: false })
  document.addEventListener('touchend', up)
  document.addEventListener('touchcancel', cancel)
  return () => {
    document.removeEventListener('touchstart', down)
    document.removeEventListener('touchmove', move)
    document.removeEventListener('touchend', up)
    document.removeEventListener('touchcancel', cancel)
  }
}
