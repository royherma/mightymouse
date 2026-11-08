import type { JSX, ReactNode } from 'react'

/**
 * Row / Stack — the two flex compositions this UI repeats hundreds of times
 * (`flex items-center gap-N` alone appears 18+ times verbatim). Tailwind can't
 * generate dynamic class names, so `gap` is a fixed union mapped to real
 * utility classes. Anything beyond gap (justify, wrap, min-w-0) goes through
 * `className` — these are thin layout helpers, not a styling system.
 */
type Gap = 1 | 1.5 | 2 | 3 | 4

const GAP_CLS: Record<Gap, string> = {
  1: 'gap-1',
  1.5: 'gap-1.5',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4'
}

export function Row({
  gap = 2,
  className,
  children
}: {
  gap?: Gap
  className?: string
  children: ReactNode
}): JSX.Element {
  const base = `flex items-center ${GAP_CLS[gap]}`
  return <div className={className ? `${base} ${className}` : base}>{children}</div>
}

export function Stack({
  gap = 2,
  className,
  children
}: {
  gap?: Gap
  className?: string
  children: ReactNode
}): JSX.Element {
  const base = `flex flex-col ${GAP_CLS[gap]}`
  return <div className={className ? `${base} ${className}` : base}>{children}</div>
}
