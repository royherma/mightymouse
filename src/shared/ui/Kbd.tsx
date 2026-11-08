import type { JSX } from 'react'

export function Kbd({ combo, glyphs }: { combo?: string; glyphs?: string[] }): JSX.Element {
  const caps = glyphs ?? (combo ?? '').split('+')
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {caps.map((k, i) => (
        <kbd
          key={i}
          className="inline-block bg-surface2 border border-surface3 rounded px-1.5 py-0.5 text-sm font-mono text-on-surface min-w-[20px] text-center"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}
