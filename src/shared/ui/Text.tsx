import type { JSX, ReactNode } from 'react'

type MutedSize = '2xs' | 'xs' | 'sm' | 'md'

const SIZE_CLS: Record<MutedSize, string> = {
  '2xs': 'text-xlg',
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-md'
}

export function Muted({
  size = 'sm',
  className,
  children
}: {
  size?: MutedSize
  className?: string
  children: ReactNode
}): JSX.Element {
  const base = `text-muted ${SIZE_CLS[size]}`
  return <p className={className ? `${base} ${className}` : base}>{children}</p>
}
