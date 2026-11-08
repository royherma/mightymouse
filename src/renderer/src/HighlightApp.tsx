import { useEffect, useRef, useState, type JSX } from 'react'
import { CONFIG } from '../../shared/config'
import type { HighlightBoxPayload } from '../../shared/types'

// Full-screen transparent overlay for act-mode's "this is where a change is
// happening" flash. Each CHANNELS.actHighlight push mounts one dashed,
// glowing box at the given window-local rect for that push's own
// durationMs (defaults to CONFIG.ACT_HIGHLIGHT.DURATION_MS at the sender —
// see highlight-window.ts) — driven by inline animation-duration so the
// Playground demo can tune "bigger/longer" live, no restart needed. Multiple
// boxes can be alive at once (fast-fired actions), each keyed by mount time.

interface Box extends HighlightBoxPayload {
  id: number
}

export default function HighlightApp(): JSX.Element {
  const [boxes, setBoxes] = useState<Box[]>([])
  const nextId = useRef(0)

  useEffect(() => {
    const off = window.api.onActHighlight((p) => {
      const id = nextId.current++
      setBoxes((prev) => [...prev, { ...p, id }])
      setTimeout(() => {
        setBoxes((prev) => prev.filter((b) => b.id !== id))
      }, p.durationMs)
    })
    return off
  }, [])

  const T = CONFIG.THEME_TOKENS
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
      {boxes.map((b) => {
        const dur = `${b.durationMs}ms`
        return (
          <div
            key={b.id}
            className="act-highlight-box"
            style={
              {
                position: 'absolute',
                left: b.x,
                top: b.y,
                width: b.w,
                height: b.h,
                borderRadius: 12,
                color: T.violet,
                boxShadow: `0 0 0 1px ${T.violetBorderSubtle}`,
                animationDuration: dur
              } as React.CSSProperties
            }
          >
            <div className="act-highlight-glow" style={{ animationDuration: dur }} />
          </div>
        )
      })}
    </div>
  )
}
