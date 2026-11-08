import type { JSX, ReactNode } from 'react'
import { Button } from './Button'
import './SegmentedControl.css'

export type SegmentItem<T extends string> = {
  id: T
  label: string
  count?: number
  icon?: ReactNode
  activeColor?: string
}

type Look = 'track' | 'pill' | 'tint'

const PILL_ITEM = 'gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors'
const TINT_ITEM = 'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors'
const LOOK: Record<Exclude<Look, 'track'>, { box: string; item: string; on: string; off: string }> = {
  pill: {
    box: 'rounded-full bg-surface2 p-1',
    item: `inline-flex items-center justify-center ${PILL_ITEM}`,
    on: 'bg-surface1 text-on-surface shadow-card',
    off: 'text-muted hover:text-on-surface'
  },
  tint: {
    box: 'flex items-center gap-1',
    item: TINT_ITEM,
    on: 'bg-accent/12 text-accent',
    off: 'bg-transparent text-muted hover:bg-surface2 hover:text-on-surface'
  }
}

export function SegmentedControl<T extends string>({
  items,
  active,
  onChange,
  look = 'track',
  stretch = false,
  textSize = 'text-sm',
  activeWeight = 600,
  inactiveColor = 'var(--muted)',
  className
}: {
  items: ReadonlyArray<SegmentItem<T>>
  active: T
  onChange: (id: T) => void
  look?: Look
  stretch?: boolean
  textSize?: string
  activeWeight?: number
  inactiveColor?: string
  className?: string
}): JSX.Element {
  const l = look === 'track' ? null : LOOK[look]
  const box = l
    ? `${l.box} ${look === 'pill' ? (stretch ? 'flex w-full' : 'inline-flex self-start') : ''}`
    : `segmented ${className ?? 'mb-4'}`
  return (
    <div className={l && className ? `${box} ${className}` : box} role="tablist">
      {items.map(it => {
        const on = active === it.id
        return (
          <Button
            key={it.id}
            variant="bare"
            role="tab"
            aria-selected={on}
            data-on={on || undefined}
            onClick={() => onChange(it.id)}
            className={
              l
                ? `${l.item} ${stretch ? 'flex-1' : ''} ${on ? l.on : l.off}`
                : `segmented-item ${textSize}`
            }
            style={
              l
                ? undefined
                : {
                    background: on ? it.activeColor : undefined,
                    color: on ? undefined : inactiveColor,
                    fontWeight: on ? activeWeight : 500
                  }
            }
          >
            {it.icon}
            {it.label}
            {it.count !== undefined && <span className="segmented-count">{it.count}</span>}
          </Button>
        )
      })}
    </div>
  )
}
