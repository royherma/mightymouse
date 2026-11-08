import type { JSX } from 'react'

export function Spinner({
  size = 'w-6 h-6',
  accent = 'border-t-blue'
}: {
  size?: string
  accent?: string
}): JSX.Element {
  return <span className={`${size} rounded-full border-2 border-surface3 ${accent} animate-spin`} />
}
