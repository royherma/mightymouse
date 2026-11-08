import type { JSX, ReactNode } from 'react'

export function Badge({
  color,
  size = 'md',
  className = '',
  children
}: {
  color?: string
  size?: 'md' | 'sm'
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full text-xs font-semibold whitespace-nowrap ${size === 'sm' ? 'gap-1 px-2 py-px' : 'gap-1.5 px-3 py-1.5'} ${color ? '' : 'border border-transparent bg-surface2 text-muted'} ${className}`}
      style={
        color
          ? {
              background: `var(--${color}-bg-subtle)`,
              border: `1px solid var(--${color}-border-subtle)`,
              color: `var(--${color})`
            }
          : undefined
      }
    >
      {children}
    </span>
  )
}
