import { JSX, memo, useMemo, useState, type MouseEvent } from 'react'
import { fmt as fmtClock } from './MediaPlayer'

const PITCH = 3
const BAR_W = 2
const WAVE_H = 28
const UNPLAYED_OPACITY = 0.35

export const RowWaveform = memo(function RowWaveform({
  peaks,
  bars,
  color,
  cur,
  dur,
  onSeek
}: {
  peaks: number[]
  bars: number
  color: string
  cur?: number
  dur?: number
  onSeek: (frac: number) => void
}): JSX.Element {
  const [hoverBar, setHoverBar] = useState<number | null>(null)
  const heights = useMemo(() => {
    const step = peaks.length / bars
    return Array.from({ length: bars }, (_, i) => {
      const from = Math.floor(i * step)
      const peak = Math.max(...peaks.slice(from, Math.max(from + 1, Math.floor((i + 1) * step))), 0)
      return Math.max(1, peak * WAVE_H)
    })
  }, [peaks, bars])

  const playing = cur != null
  const playedBars = playing && dur ? Math.round((cur / dur) * bars) : bars
  const litBars = hoverBar ?? playedBars
  const clock = hoverBar != null && dur ? (hoverBar / bars) * dur : playing ? cur : dur

  const barAt = (e: MouseEvent<HTMLDivElement>): number => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    return Math.min(bars - 1, Math.max(0, Math.floor(x / PITCH)))
  }

  return (
    <div className="flex items-center gap-2.5 shrink-0">
      <div
        title="Play from here"
        onMouseMove={(e) => setHoverBar(barAt(e))}
        onMouseLeave={() => setHoverBar(null)}
        onClick={(e) => {
          e.stopPropagation()
          onSeek(barAt(e) / bars)
        }}
        style={{ color: playing ? 'var(--on-surface)' : color }}
        className={`py-2 -my-2 transition-opacity duration-150 motion-reduce:transition-none ${
          playing || hoverBar != null ? 'opacity-100' : 'opacity-60 group-hover:opacity-100'
        }`}
      >
        <svg
          width={bars * PITCH}
          height={WAVE_H}
          viewBox={`0 0 ${bars * PITCH} ${WAVE_H}`}
          className="block"
          aria-hidden="true"
        >
          {heights.map((h, i) => (
            <rect
              key={i}
              x={i * PITCH}
              y={(WAVE_H - h) / 2}
              width={BAR_W}
              height={h}
              rx={1}
              fill="currentColor"
              opacity={i < litBars ? 1 : UNPLAYED_OPACITY}
            />
          ))}
          {hoverBar != null && (
            <rect
              x={Math.max(0, hoverBar * PITCH - 1)}
              y={0}
              width={1}
              height={WAVE_H}
              fill="var(--on-surface)"
            />
          )}
        </svg>
      </div>
      <span
        className={`w-11 text-right text-sm tabular-nums ${
          playing || hoverBar != null ? 'text-on-surface' : 'text-muted'
        }`}
      >
        {clock != null ? fmtClock(clock) : ''}
      </span>
    </div>
  )
})
