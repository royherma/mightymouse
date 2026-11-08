import { JSX, useLayoutEffect, useRef, useState, useCallback } from 'react'

// ── Cursor-following hover tooltip (shared primitive) ─────────────────────────
//
// A single floating tooltip driven by a `tip` state on the page. SVG charts call
// `setTip` on mousemove (cursor-following); plain DOM controls use `hoverProps`
// (below) to get ready-made enter/move/leave handlers. Native HTML `title` is
// unreliable in our borderless always-on-top windows (long delay, OS chrome, can
// be eaten when the window blurs) — this renders inside the renderer, so it
// always shows. Lifted out of AnalyticsApp so every window reuses one tooltip.

export type TipState = { x: number; y: number; text: React.ReactNode } | null

const TIP_GAP = 12 // px between cursor and tooltip
const TIP_MARGIN = 8 // min px kept clear of the window edge

export function Tooltip({ tip }: { tip: TipState }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  // Flip the tooltip to the LEFT of the cursor when placing it on the right would
  // overflow the window edge. Measure after layout so the flip lands before paint.
  const [flip, setFlip] = useState(false)
  const [lift, setLift] = useState(0)
  useLayoutEffect(() => {
    if (!tip || !ref.current) return
    const width = ref.current.offsetWidth
    setFlip(tip.x + TIP_GAP + width + TIP_MARGIN > window.innerWidth)
    setLift(Math.max(0, tip.y - 8 + ref.current.offsetHeight + TIP_MARGIN - window.innerHeight))
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={ref}
      className="fixed z-50 pointer-events-none rounded-lg font-normal"
      style={{
        left: flip ? undefined : tip.x + TIP_GAP,
        right: flip ? window.innerWidth - tip.x + TIP_GAP : undefined,
        top: tip.y - 8 - lift,
        // Run wide so short tips stay on one line (see Voice & copy in CLAUDE.md);
        // only the longest copy wraps. Edge-flip keeps it inside the window.
        maxWidth: 320,
        whiteSpace: 'normal',
        fontSize: '11px',
        lineHeight: 1.35,
        padding: '5px 9px',
        // On-brand and unobtrusive: a frosted, faintly warm (brand-accent) wash
        // with muted ink, a hairline accent border and a whisper of shadow — NOT
        // the heavy dark/neumorphic chip look.
        background: 'rgba(var(--accent-rgb), 0.08)',
        color: 'var(--text-muted-medium)',
        border: '1px solid rgba(var(--accent-rgb), 0.18)',
        boxShadow: '0 4px 14px rgba(var(--shadow-rgb), 0.10)',
        backdropFilter: 'blur(14px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(14px) saturate(1.4)'
      }}
    >
      {tip.text}
    </div>
  )
}

/**
 * useTooltip — owns the single `tip` state for a window.
 *
 * - `tip` / `setTip`: pass `setTip` to SVG charts that follow the cursor.
 * - `hoverProps(text)`: spread onto any DOM element to give it a hover tip with
 *   no manual handler wiring — `{...hoverProps('explanation')}`.
 * - `<Tooltip tip={tip} />`: render once at the root of the window.
 */
export function useTooltip(): {
  tip: TipState
  setTip: (t: TipState) => void
  hoverProps: (text: React.ReactNode) => {
    onMouseEnter: (e: React.MouseEvent) => void
    onMouseMove: (e: React.MouseEvent) => void
    onMouseLeave: () => void
  }
} {
  const [tip, setTip] = useState<TipState>(null)
  const hoverProps = useCallback(
    (text: React.ReactNode) => ({
      onMouseEnter: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, text }),
      onMouseMove: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, text }),
      onMouseLeave: () => setTip(null)
    }),
    []
  )
  return { tip, setTip, hoverProps }
}
