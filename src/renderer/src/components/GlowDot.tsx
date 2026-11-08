import type { JSX } from 'react'

/**
 * A small colored status dot with a matching glow halo, optionally followed by
 * a label in the same color. The single source of truth for the glow-dot
 * pattern that SettingsApp renders for permissions, binaries, and the backend
 * connection test.
 */
export function GlowDot({
  color,
  label,
  size = 'w-2.5 h-2.5'
}: {
  color: string
  label?: string
  size?: string
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`${size} rounded-full shrink-0`}
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      />
      {label && (
        <span className="text-md font-semibold" style={{ color }}>
          {label}
        </span>
      )}
    </span>
  )
}
