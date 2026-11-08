import type { HTMLAttributes, JSX, ReactNode } from 'react'

export const CARD_CLS = 'bg-surface1 border border-surface3 rounded-md p-4 mb-3 shadow-card'
const PANEL_CLS = 'bg-surface1 rounded-lg shadow-card p-5'

export function Card({
  panel,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { panel?: boolean }): JSX.Element {
  const base = panel ? PANEL_CLS : CARD_CLS
  return <div {...rest} className={className ? `${base} ${className}` : base} />
}

export const SECTION_HEADER_CLS = 'text-md uppercase text-muted font-bold tracking-wider mt-6 mb-2'

export function SectionHeader({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <h2 className={className ? `${SECTION_HEADER_CLS} ${className}` : SECTION_HEADER_CLS}>
      {children}
    </h2>
  )
}
