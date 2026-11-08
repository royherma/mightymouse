import { CSSProperties, MouseEvent as ReactMouseEvent, RefObject, useCallback, useState } from 'react'
import { CONFIG } from '../../../shared/config'

const WIDTH_KEY = 'mm.railWidth'

function savedWidth(): number | undefined {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

function saveWidth(width: number | undefined): void {
  try {
    if (width) localStorage.setItem(WIDTH_KEY, String(width))
    else localStorage.removeItem(WIDTH_KEY)
  } catch {
    // Storage blocked: the width still holds until the app restarts.
  }
}

let keptWidth = savedWidth()

export interface RailResize {
  width: number | undefined
  dragging: boolean
  onGripDown: (down: ReactMouseEvent) => void
  reset: () => void
  style: CSSProperties | undefined
  gripProps: {
    className: string
    'data-dragging': '' | undefined
    onMouseDown: (down: ReactMouseEvent) => void
    onDoubleClick: () => void
    title: string
    role: 'separator'
    'aria-orientation': 'vertical'
  }
}

// One width shared by every rail and both modes, so switching Details/Browser
// never snaps the pane.
export function useRailResize(
  sheetRef: RefObject<HTMLElement | null>,
  gripClassName = 'chat-rail-grip'
): RailResize {
  const [width, setWidth] = useState(keptWidth)
  const reset = useCallback(() => {
    saveWidth((keptWidth = undefined))
    setWidth(undefined)
  }, [])
  const [dragging, setDragging] = useState(false)
  const onGripDown = useCallback(
    (down: ReactMouseEvent) => {
      down.preventDefault()
      const box = sheetRef.current?.getBoundingClientRect()
      const right = box?.right ?? window.innerWidth
      const { MIN_WIDTH } = CONFIG.MIGHTY.RAIL
      const max = Math.max(MIN_WIDTH, (box?.width ?? window.innerWidth) - CONFIG.MIGHTY.CHAT_MIN_WIDTH)
      setDragging(true)
      const move = (ev: MouseEvent): void => {
        const w = Math.max(MIN_WIDTH, Math.min(max, right - ev.clientX))
        setWidth((keptWidth = w))
      }
      const up = (): void => {
        saveWidth(keptWidth)
        setDragging(false)
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [sheetRef]
  )
  return {
    width,
    dragging,
    onGripDown,
    reset,
    style: width ? ({ '--rail-width': `${width}px` } as CSSProperties) : undefined,
    gripProps: {
      className: gripClassName,
      'data-dragging': dragging ? '' : undefined,
      onMouseDown: onGripDown,
      onDoubleClick: reset,
      title: 'Drag to resize · double-click to reset',
      role: 'separator',
      'aria-orientation': 'vertical'
    }
  }
}
