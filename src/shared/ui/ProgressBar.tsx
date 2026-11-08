import type { JSX } from 'react'

export function ProgressBar({
  pct,
  color = 'var(--accent)',
  height = 'h-2',
  segments,
  activeSegment,
  onSegmentClick,
  segmentClickable,
  segmentLabel
}: {
  pct: number
  color?: string
  height?: string
  segments?: number
  activeSegment?: number
  onSegmentClick?: (index: number) => void
  segmentClickable?: (index: number) => boolean
  segmentLabel?: (index: number) => string
}): JSX.Element {
  if (segments && segments > 0) {
    const filled = Math.round((pct / 100) * segments)
    return (
      <div className={`flex-1 flex items-stretch gap-1 ${height}`}>
        {Array.from({ length: segments }, (_, i) => {
          const done = i < filled
          const active = !done && activeSegment !== undefined && i === activeSegment - 1
          const clickable = !!onSegmentClick && (segmentClickable?.(i) ?? true)
          const fill = (
            <div
              className={`w-full h-full rounded-full${active ? ' segment-active' : ''}`}
              style={{
                background: done ? color : 'var(--surface3)',
                transition: 'background 0.4s ease',
                ...(active ? { ['--segment-color' as string]: color } : {})
              }}
            />
          )
          if (!clickable) return <div key={i} className="flex-1">{fill}</div>
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSegmentClick(i)}
              aria-label={segmentLabel?.(i) ?? `Go to step ${i + 1}`}
              className="flex-1 py-2 -my-2 px-0 border-0 bg-transparent cursor-pointer hover:opacity-70 transition-opacity"
            >
              {fill}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className={`flex-1 ${height} rounded-full overflow-hidden`} style={{ background: 'var(--surface3)' }}>
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: color, transition: 'width 0.4s ease' }}
      />
    </div>
  )
}
