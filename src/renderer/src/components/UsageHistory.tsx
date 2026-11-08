import { useEffect, useState, useCallback, JSX } from 'react'
import type { UsageEvent } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { MODE_COLORS } from '../mode-colors'
import { Button } from './Button'

// User-facing billing/usage list. Pulls the caller's own usage_events (RLS) via
// window.api.billingListUsage and renders them grouped by day, newest first, with
// a per-call expand for the exact IDs / tokens / duration. Self-contained so the
// same component backs BOTH the compact Settings card and the full Billing window.
//
//   compact=true  → last few rows, small, a "Show all →" button (Settings card)
//   compact=false → full list, larger, no cap (the dedicated Billing window)

const FEATURE_LABEL: Record<string, string> = {
  rewrite: 'Rewrite',
  ask: 'Ask',
  act: 'Action',
  unknown: 'Other'
}

// Colors come from the canonical MODE_COLORS (mode-colors.ts) so a mode never
// reads as two different colors across the app. `unknown` isn't a mode, so it's
// the only color defined locally.
const FEATURE_COLOR: Record<string, string> = {
  ...MODE_COLORS,
  unknown: 'var(--muted)'
}

const COMPACT_ROWS = 5

// Format a dollar amount: always 2 decimals, but a real-but-sub-cent amount shows
// "< $0.01" instead of a misleading "$0.00". We work from the true cost (micros),
// not the integer charged_cents, so a 0.6¢ call reads "< $0.01", not "$0.00".
function moneyFromUsd(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.005) return '< $0.01' // rounds to $0.00 at 2dp but wasn't free
  return `$${usd.toFixed(2)}`
}

export function moneyFromMicros(micros: number): string {
  return moneyFromUsd(micros / 1_000_000)
}

function dayKey(iso: string): string {
  return iso.slice(0, 10) // YYYY-MM-DD — stable, locale-independent grouping key
}

function dayLabel(key: string): string {
  const d = new Date(key + 'T00:00:00')
  const today = dayKey(new Date().toISOString())
  if (key === today) return 'Today'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Note: we never render a provider/model name here. The user-facing label
// (ev.displayName) is resolved server-side from billing_config; the raw model
// never reaches the client. See billing.ts.

function FeatureChip({ feature }: { feature: string }): JSX.Element {
  const color = FEATURE_COLOR[feature] ?? FEATURE_COLOR.unknown
  return (
    <span
      className="font-semibold uppercase rounded-full shrink-0 leading-none"
      style={{
        // Hardcoded size — the text-xlg token doesn't resolve in every window, so a
        // class-based size renders huge. Inline px is the reliable fix.
        fontSize: '9px',
        letterSpacing: '0.04em',
        padding: '3px 7px',
        color,
        background: 'var(--surface2)',
        border: `1px solid ${color}`
      }}
    >
      {FEATURE_LABEL[feature] ?? feature}
    </span>
  )
}

function Row({ ev }: { ev: UsageEvent }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-surface3 last:border-b-0">
      <Button
        variant="bare"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 py-1.5 text-left hover:bg-surface2 px-1.5 rounded-sm transition-colors"
      >
        <span className="text-muted tabular-nums shrink-0 whitespace-nowrap" style={{ fontSize: '12px', width: '58px' }}>
          {timeLabel(ev.createdAt)}
        </span>
        <FeatureChip feature={ev.feature} />
        <span className="text-muted truncate flex-1" style={{ fontSize: '12px' }}>
          {ev.displayName}
        </span>
        <span className="font-semibold text-on-surface tabular-nums shrink-0" style={{ fontSize: '13px' }}>
          {moneyFromMicros(ev.costUsdMicros)}
        </span>
      </Button>
      {open && (
        <div
          className="px-1.5 pb-2 pt-0.5 grid grid-cols-2 gap-x-4 gap-y-1 text-muted"
          style={{ fontSize: '11px' }}
        >
          <span>Tokens in</span>
          <span className="text-right tabular-nums text-on-surface">{ev.inputTokens.toLocaleString()}</span>
          <span>Tokens out</span>
          <span className="text-right tabular-nums text-on-surface">{ev.outputTokens.toLocaleString()}</span>
          <span>Duration</span>
          <span className="text-right tabular-nums text-on-surface">{(ev.durationMs / 1000).toFixed(1)}s</span>
          <span>Run ID</span>
          <span className="text-right font-mono text-on-surface break-all select-all">{ev.runId}</span>
        </div>
      )}
    </div>
  )
}

export function UsageHistory({ compact = false }: { compact?: boolean }): JSX.Element {
  const [events, setEvents] = useState<UsageEvent[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setEvents(await window.api.billingListUsage(compact ? COMPACT_ROWS : 200))
    } finally {
      setBusy(false)
    }
  }, [compact])

  useEffect(() => {
    void load()
  }, [load])

  if (events === null) {
    return <div className="text-muted text-sm py-2">{busy ? 'Loading…' : ''}</div>
  }

  if (events.length === 0) {
    return (
      <div className="text-muted text-sm py-2">
        No usage yet. Charges show up here the moment you use the {CONFIG.PRODUCT_NAME} model.
      </div>
    )
  }

  // Group by day, preserving the newest-first order the query already returned.
  const groups: Array<{ key: string; total: number; rows: UsageEvent[] }> = []
  for (const ev of events) {
    const k = dayKey(ev.createdAt)
    let g = groups.find((x) => x.key === k)
    if (!g) {
      g = { key: k, total: 0, rows: [] }
      groups.push(g)
    }
    g.total += ev.costUsdMicros
    g.rows.push(ev)
  }

  const grandTotal = events.reduce((s, e) => s + e.costUsdMicros, 0)

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-muted text-sm">
          {compact ? `Recent charges` : `${events.length} charges`}
        </span>
        <span className="text-muted text-sm">
          Total <span className="font-semibold text-on-surface">{moneyFromMicros(grandTotal)}</span>
        </span>
      </div>

      {groups.map((g) => (
        <div key={g.key} className="mb-2.5">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-on-surface text-sm font-semibold">{dayLabel(g.key)}</span>
            <span className="text-muted tabular-nums" style={{ fontSize: '11px' }}>
              {moneyFromMicros(g.total)}
            </span>
          </div>
          <div className="rounded-md border border-surface3 bg-surface1 px-1.5">
            {g.rows.map((ev) => (
              <Row key={ev.id} ev={ev} />
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2 mt-1">
        {compact ? (
          <Button
            variant="ghost"
            onClick={() => window.api.openBillingWindow()}
          >
            Show all →
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={load}
            disabled={busy}
            className="disabled:opacity-50"
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        )}
      </div>
    </div>
  )
}
