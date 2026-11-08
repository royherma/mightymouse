import { JSX, useEffect, useState } from 'react'
import { WindowFrame } from './WindowFrame'
import { UsageHistory, moneyFromMicros } from './components/UsageHistory'
import { CONFIG } from '../../shared/config'
import type { UsageEvent } from '../../shared/types'
import { usagePercentLeft, usageResetText, type UsageMeter } from '../../shared/billing-math'

// Dedicated Billing & Usage window (?window=billing) — the "Show all" target from
// Settings → Usage. Header shows balance + this-month spend; body is the full
// UsageHistory list (non-compact). All reads are RLS-scoped to the signed-in user.

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <div className="flex-1 rounded-md border border-surface3 bg-surface1 px-4 py-3 shadow-card">
      <div className="text-muted text-sm">{label}</div>
      <div
        className="font-bold mt-0.5 tabular-nums"
        style={{ fontSize: '24px', color: accent ? 'var(--accent)' : 'var(--on-surface)' }}
      >
        {value}
      </div>
    </div>
  )
}

export default function BillingApp(): JSX.Element {
  const [balanceCents, setBalanceCents] = useState<number | null>(null)
  const [monthMicros, setMonthMicros] = useState<number | null>(null)
  const [usage, setUsage] = useState<UsageMeter | null>(null)

  useEffect(() => {
    document.title = `${CONFIG.BRAND_NAME} Billing`
    void window.api.billingGetBalance().then((c) => setBalanceCents(c ?? 0))
    void window.api.billingGetUsage().then(setUsage)
    // This-month spend = sum of charged_cents for events in the current calendar
    // month. Pull a generous window and filter client-side (the list is small).
    void window.api.billingListUsage(500).then((evs: UsageEvent[]) => {
      const ym = new Date().toISOString().slice(0, 7) // YYYY-MM
      setMonthMicros(evs.filter((e) => e.createdAt.slice(0, 7) === ym).reduce((s, e) => s + e.costUsdMicros, 0))
    })
  }, [])

  return (
    <WindowFrame title={`${CONFIG.BRAND_NAME} Billing`}>
      <div className="p-5 max-w-[680px] mx-auto">
        <div className="flex gap-3 mb-5">
          {usage ? (
            <StatCard label={`${[...CONFIG.BILLING.PLANS, ...CONFIG.BILLING.YEARLY_PLANS].find((p) => p.id === usage.plan)?.name ?? 'Free'} plan`} value={`${usagePercentLeft(usage)}% left`} accent />
          ) : (
            <StatCard label="Balance" value={balanceCents === null ? '—' : money(balanceCents)} accent />
          )}
          <StatCard label="This month" value={monthMicros === null ? '—' : moneyFromMicros(monthMicros)} />
        </div>

        <h2 className="text-md uppercase text-muted font-bold tracking-wider mb-2">All usage</h2>
        <div className="rounded-md border border-surface3 bg-surface1 p-4 shadow-card">
          <UsageHistory />
        </div>

        <p className="text-muted mt-4" style={{ fontSize: '12px' }}>
          Every {CONFIG.PRODUCT_NAME} call is billed at cost. Tap a row for details.
          {usage ? ` ${usageResetText(usage.resetsAt)}. ` : ' '}Extra usage never expires.
        </p>
      </div>
    </WindowFrame>
  )
}
