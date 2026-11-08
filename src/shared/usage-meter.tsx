import type { JSX } from 'react'
import { CONFIG } from './config'
import { usagePercentLeft, usageResetText, type UsageMeter } from './billing-math'

function usagePlanName(plan: string): string {
  return CONFIG.BILLING.PLANS.find((p) => p.id === plan)?.name ?? 'Free'
}

function extraUsageLine(meter: UsageMeter): string | null {
  if (meter.extraCents <= 0) return null
  return `Extra usage: $${(meter.extraCents / 100).toFixed(2)}, never expires`
}

export function UsageMeterView({
  meter,
  compact = false
}: {
  meter: UsageMeter
  compact?: boolean
}): JSX.Element {
  const pct = usagePercentLeft(meter)
  const extra = extraUsageLine(meter)
  const low = pct <= 10
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12
        }}
      >
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>
          {usagePlanName(meter.plan)} plan
        </span>
        <span style={{ fontWeight: 700, fontSize: compact ? 14 : 20, lineHeight: 1 }}>
          {pct}% left
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Usage left on your plan"
        style={{ height: 6, borderRadius: 3, background: 'var(--surface3)', overflow: 'hidden' }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background: low ? 'var(--red-light)' : 'var(--accent)',
            transition: 'width 200ms ease'
          }}
        />
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
        {usageResetText(meter.resetsAt)}
        {extra && (
          <>
            {meter.resetsAt ? ' · ' : ''}
            {extra}
          </>
        )}
      </div>
    </div>
  )
}
