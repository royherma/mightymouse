import { useState, useCallback, useRef, useLayoutEffect, useMemo, type RefObject } from 'react'

const SCROLL_STEP_PX = 96

// Renders only on-screen rows; `rowHeight` is one number or a per-index array.
export function useVirtualList<T extends HTMLElement>(
  count: number,
  rowHeight: number | number[],
  overscan = 6
): {
  scrollRef: RefObject<T | null>
  onScroll: () => void
  start: number
  end: number
  totalHeight: number
  offsetY: number
} {
  const scrollRef = useRef<T>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Must stay under overscan x smallest row, or the edge of the list shows blank.
    setScrollTop(Math.floor(el.scrollTop / SCROLL_STEP_PX) * SCROLL_STEP_PX)
    // Cheap to read here; the viewport rarely changes but resizing the window
    // fires scroll-adjacent layout often enough that re-reading is free.
    if (el.clientHeight !== viewport) setViewport(el.clientHeight)
  }, [viewport])

  // Measure the viewport once mounted (and whenever it resizes) so we don't
  // under-render before the first scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewport(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Caller must memoize a `rowHeight` array or this rebuilds every render.
  const offsets = useMemo(() => {
    if (typeof rowHeight === 'number') return null
    const acc = new Array<number>(rowHeight.length + 1)
    acc[0] = 0
    for (let i = 0; i < rowHeight.length; i++) acc[i + 1] = acc[i] + rowHeight[i]
    return acc
  }, [rowHeight])

  if (typeof rowHeight === 'number') {
    const visibleRows = Math.ceil((viewport || 800) / rowHeight)
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    const end = Math.min(count, start + visibleRows + overscan * 2)
    return {
      scrollRef,
      onScroll,
      start,
      end,
      totalHeight: count * rowHeight,
      offsetY: start * rowHeight
    }
  }

  const acc = offsets as number[]
  const totalHeight = acc[count] ?? acc[acc.length - 1] ?? 0
  const rawStart = Math.max(0, bisectRight(acc, scrollTop, count) - 1 - overscan)
  const rawEnd = bisectRight(acc, scrollTop + (viewport || 800), count) + overscan
  const start = Math.max(0, Math.min(rawStart, count))
  const end = Math.max(start, Math.min(rawEnd, count))

  return {
    scrollRef,
    onScroll,
    start,
    end,
    totalHeight,
    offsetY: acc[start] ?? 0
  }
}

function bisectRight(offsets: number[], value: number, count: number): number {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}
