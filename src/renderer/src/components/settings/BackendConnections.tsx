import { JSX, useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { BackendId, BackendProbeRecord } from '../../../../shared/types'
import { Button } from '../Button'
import { GlowDot } from '../GlowDot'
import { ProviderIcon, type ProviderIconId } from '../ProviderIcon'
import { useInterval } from '../../hooks/useInterval'
import { timeAgo } from '../../mighty/mighty-shared'

type Probes = Partial<Record<BackendId, BackendProbeRecord>>

export interface ConnectionRow {
  value: BackendId
  label: string
  icon: ProviderIconId
}

function statusLine(record: BackendProbeRecord): string {
  const { result } = record
  if (!result.ok) return result.advice ?? result.checks.find((c) => !c.ok)?.detail ?? 'Not working'
  return result.checks[result.checks.length - 1]?.detail || 'Ready'
}

function disconnectQuestion(id: BackendId, label: string): string {
  if (id === 'mightymouse') return 'Sign out of MightyMouse on this Mac?'
  if (id === 'openrouter') return 'Remove your OpenRouter key from this Mac?'
  return `Sign out of ${label}? This also signs you out of ${label} in your terminal.`
}

export function BackendConnections({ rows }: { rows: ConnectionRow[] }): JSX.Element {
  const [probes, setProbes] = useState<Probes>({})
  const [checking, setChecking] = useState<Set<BackendId>>(new Set())
  const [, setTick] = useState(0)
  useInterval(() => setTick((t) => t + 1), 30_000)

  const check = useCallback(async (ids: BackendId[]) => {
    if (ids.length === 0) return
    setChecking((prev) => new Set([...prev, ...ids]))
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await window.api.settingsTestBackend(id)
        } finally {
          setChecking((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        }
      })
    )
    setProbes(await window.api.settingsBackendProbes())
  }, [])

  const rowIds = rows.map((r) => r.value).join(',')
  useEffect(() => {
    let cancelled = false
    void window.api.settingsBackendProbes().then((known) => {
      if (cancelled) return
      setProbes(known)
      void check(rowIds.split(',').filter((id) => !known[id as BackendId]) as BackendId[])
    })
    return () => {
      cancelled = true
    }
  }, [rowIds, check])

  const disconnect = async (row: ConnectionRow): Promise<void> => {
    if (!window.confirm(disconnectQuestion(row.value, row.label))) return
    setChecking((prev) => new Set([...prev, row.value]))
    try {
      await window.api.settingsDisconnectBackend(row.value)
    } finally {
      setChecking((prev) => {
        const next = new Set(prev)
        next.delete(row.value)
        return next
      })
      setProbes(await window.api.settingsBackendProbes())
    }
  }

  const busy = checking.size > 0
  return (
    <div className="mt-4 pt-4 border-t border-surface3 first:mt-0 first:pt-0 first:border-t-0">
      <div className="flex items-center justify-between mb-2">
        <div className="text-md font-semibold">Connections</div>
        <Button variant="ghost" disabled={busy} onClick={() => check(rows.map((r) => r.value))}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />
          {busy ? 'Checking…' : 'Check all'}
        </Button>
      </div>
      <div className="flex flex-col">
        {rows.map((r) => {
          const record = probes[r.value]
          const running = checking.has(r.value)
          const color =
            running || !record
              ? 'var(--muted)'
              : record.result.ok
                ? 'var(--green-light)'
                : 'var(--red-light)'
          return (
            <div key={r.value} className="flex items-center gap-3 py-2">
              <ProviderIcon id={r.icon} size={18} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-md font-semibold">{r.label}</span>
                  <GlowDot color={color} size="w-2 h-2" />
                </div>
                <div className="text-muted text-sm truncate">
                  {running ? 'Checking…' : record ? statusLine(record) : 'Not checked yet'}
                </div>
              </div>
              <span className="text-muted text-sm shrink-0">
                {record ? `Checked ${timeAgo(new Date(record.at).toISOString())}` : ''}
              </span>
              {record?.result.ok && record.canDisconnect && (
                <Button
                  variant="ghost"
                  className="shrink-0"
                  disabled={running}
                  onClick={() => void disconnect(r)}
                >
                  Disconnect
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
