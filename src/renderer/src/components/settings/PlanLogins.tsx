import { JSX, useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import {
  PLAN_BACKENDS,
  PLAN_BACKEND_LABEL,
  PLAN_LOGINS,
  PLAN_WINDOW_LABEL,
  isPlanLoginOpen,
  type PlanBackend,
  type PlanLogin
} from '../../../../shared/plan-logins'
import { Button } from '../Button'
import { ProgressBar } from '../ProgressBar'
import { ProviderIcon } from '../ProviderIcon'

const DAY_MS = 24 * 60 * 60_000

function when(ts: number): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return ts - Date.now() < DAY_MS ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function barColor(pct: number): string {
  if (pct >= PLAN_LOGINS.FULL_PCT) return 'var(--red-light)'
  return pct >= PLAN_LOGINS.WARN_PCT ? 'var(--amber)' : 'var(--green-light)'
}

function LoginRow({
  login,
  next,
  busy,
  onRemove
}: {
  login: PlanLogin
  next: boolean
  busy: boolean
  onRemove: () => void
}): JSX.Element {
  const now = Date.now()
  const out = !isPlanLoginOpen(login, now)
  const status = out
    ? `Used up until ${when(Math.max(login.limitedUntil ?? 0, ...login.windows.filter((w) => w.usedPct >= PLAN_LOGINS.FULL_PCT).map((w) => w.resetsAt)))}`
    : next
      ? 'Runs next'
      : 'Standing by'
  return (
    <div className="flex items-start gap-3 py-2">
      <ProviderIcon id={login.backend} size={18} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-md font-semibold truncate">
            {login.email || `${PLAN_BACKEND_LABEL[login.backend]} (not signed in)`}
          </span>
          {login.plan && <span className="text-muted text-sm shrink-0">{login.plan}</span>}
        </div>
        <div className="text-sm" style={{ color: out ? 'var(--red-light)' : 'var(--muted)' }}>
          {status}
        </div>
        {login.windows.length === 0 ? (
          <div className="text-muted text-sm">Shows how much is left after its next run.</div>
        ) : (
          login.windows.map((w) => (
            <div key={w.name} className="flex items-center gap-2 mt-1.5">
              <span className="text-muted text-sm w-16 shrink-0">{PLAN_WINDOW_LABEL[w.name]}</span>
              <ProgressBar pct={Math.min(w.usedPct, PLAN_LOGINS.FULL_PCT)} color={barColor(w.usedPct)} />
              <span className="text-muted text-sm shrink-0 w-40 text-right">
                {w.usedPct}% used · resets {when(w.resetsAt)}
              </span>
            </div>
          ))
        )}
      </div>
      {login.dir && (
        <Button variant="ghost" className="shrink-0" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  )
}

export function PlanLogins(): JSX.Element {
  const [logins, setLogins] = useState<PlanLogin[]>([])
  const [checking, setChecking] = useState(false)
  const [signingIn, setSigningIn] = useState<PlanBackend | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.planLoginsList().then((l) => !cancelled && setLogins(l))
    return () => {
      cancelled = true
    }
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setLogins(await window.api.planLoginsCheck())
    } finally {
      setChecking(false)
    }
  }

  const add = async (backend: PlanBackend): Promise<void> => {
    setError(null)
    setSigningIn(backend)
    try {
      const r = await window.api.planLoginsAdd(backend)
      setLogins(r.logins)
      setError(r.error)
    } finally {
      setSigningIn(null)
    }
  }

  const remove = async (login: PlanLogin): Promise<void> => {
    if (!window.confirm(`Remove ${login.email}? MightyMouse stops using this account.`)) return
    setLogins(await window.api.planLoginsRemove(login.id))
  }

  const busy = checking || signingIn !== null
  const now = Date.now()
  return (
    <div className="mt-4 pt-4 border-t border-surface3 first:mt-0 first:pt-0 first:border-t-0">
      <div className="flex items-center justify-between mb-1">
        <div className="text-md font-semibold">Your AI plans</div>
        <Button variant="ghost" disabled={busy} onClick={() => void check()}>
          <RefreshCw size={14} className={checking ? 'animate-spin' : undefined} />
          {checking ? 'Checking…' : 'Check usage'}
        </Button>
      </div>
      <p className="text-muted text-sm mb-2">
        Add every Claude and ChatGPT account you pay for. When one runs out, the next one picks up the work.
      </p>
      {PLAN_BACKENDS.map((backend) => {
        const mine = logins.filter((l) => l.backend === backend)
        const nextId = mine.find((l) => isPlanLoginOpen(l, now))?.id
        return (
          <div key={backend} className="flex flex-col">
            {mine.map((l) => (
              <LoginRow key={l.id} login={l} next={l.id === nextId} busy={busy} onRemove={() => void remove(l)} />
            ))}
          </div>
        )
      })}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {signingIn ? (
          <>
            <span className="text-sm">
              Finish signing in to {PLAN_BACKEND_LABEL[signingIn]} in your browser. Use a different account from the ones above.
            </span>
            <Button variant="ghost" onClick={() => void window.api.planLoginsCancel()}>
              Cancel
            </Button>
          </>
        ) : (
          PLAN_BACKENDS.map((backend) => (
            <Button key={backend} variant="ghost" disabled={busy} onClick={() => void add(backend)}>
              <Plus size={14} />
              Add {PLAN_BACKEND_LABEL[backend]} account
            </Button>
          ))
        )}
      </div>
      {error && (
        <div className="text-sm mt-2" style={{ color: 'var(--red-light)' }}>
          {error}
        </div>
      )}
    </div>
  )
}
