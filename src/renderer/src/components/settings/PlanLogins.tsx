import { JSX, type MouseEvent, useEffect, useState } from 'react'
import { Ellipsis, Plus, RefreshCw } from 'lucide-react'
import {
  PLAN_BACKENDS,
  PLAN_BACKEND_LABEL,
  PLAN_LOGINS,
  isPlanLoginOpen,
  type AntigravityPlan,
  type PlanBackend,
  type PlanLogin,
  type PlanWindow,
  type PlanWindowName
} from '../../../../shared/plan-logins'
import { Button } from '../Button'
import { ProgressBar } from '../ProgressBar'
import { ProviderIcon, type ProviderIconId } from '../ProviderIcon'

const DAY_MS = 24 * 60 * 60_000
const AGY_SIGN_IN_POLL_MS = 5000
const COLS = 'grid grid-cols-[minmax(0,1fr)_104px_104px_32px] items-center gap-x-4'
const WINDOWS: PlanWindowName[] = ['five_hour', 'week']
const MENU_WIDTH = 180

function when(ts: number): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })
  return ts - Date.now() < DAY_MS ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function barColor(pct: number): string {
  if (pct >= PLAN_LOGINS.FULL_PCT) return 'var(--red-light)'
  return pct >= PLAN_LOGINS.WARN_PCT ? 'var(--amber)' : 'var(--green-light)'
}

function UsageCell({ w }: { w?: PlanWindow }): JSX.Element {
  if (!w) return <span className="text-xs text-muted">-</span>
  return (
    <div className="min-w-0" title={`${w.usedPct}% used · resets ${when(w.resetsAt)}`}>
      <div className="flex justify-between gap-1 text-xs mb-1">
        <span className="font-semibold">{w.usedPct}%</span>
        <span className="text-muted truncate">{when(w.resetsAt)}</span>
      </div>
      <ProgressBar pct={Math.min(w.usedPct, PLAN_LOGINS.FULL_PCT)} color={barColor(w.usedPct)} height="h-1.5" />
    </div>
  )
}

export async function pickFromMenu(
  e: MouseEvent<HTMLButtonElement>,
  items: { id: string; label: string }[],
  align: 'left' | 'right' = 'right'
): Promise<string | null> {
  const r = e.currentTarget.getBoundingClientRect()
  return window.api.popoverMenu({
    items,
    width: MENU_WIDTH,
    anchor: { x: align === 'left' ? r.left : Math.max(0, r.right - MENU_WIDTH), y: r.top, width: MENU_WIDTH, height: r.height }
  })
}

type RowLogin = Pick<PlanLogin, 'email' | 'plan' | 'dir' | 'windows' | 'limitedUntil'>

function LoginRow({
  login,
  icon,
  name,
  next,
  idle,
  busy,
  onRemove,
  onReconnect,
  onMoreCredits
}: {
  login: RowLogin
  icon: ProviderIconId
  name: string
  next: boolean
  idle?: string
  busy: boolean
  onRemove: () => void
  onReconnect: () => void
  onMoreCredits?: () => void
}): JSX.Element {
  const now = Date.now()
  const out = !isPlanLoginOpen(login, now)
  const status = out
    ? `Used up until ${when(Math.max(login.limitedUntil ?? 0, ...login.windows.filter((w) => w.usedPct >= PLAN_LOGINS.FULL_PCT).map((w) => w.resetsAt)))}`
    : next
      ? 'Runs next'
      : idle ?? 'Standing by'
  const groups = [...new Set(login.windows.map((w) => w.label ?? ''))]
  const labelled = groups.some((g) => g !== '')
  const find = (group: string, name: PlanWindowName): PlanWindow | undefined =>
    login.windows.find((w) => (w.label ?? '') === group && w.name === name)
  const menu = [
    { id: 'reconnect', label: 'Reconnect' },
    ...(onMoreCredits ? [{ id: 'credits', label: 'Get more credits' }] : []),
    { id: 'remove', label: 'Remove' }
  ]
  return (
    <div className="border-t border-surface3 py-2">
      <div className={COLS}>
        <div className="flex items-center gap-2.5 min-w-0">
          <ProviderIcon id={icon} size={16} />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{login.email || `${name} (not signed in)`}</div>
            <div className="flex items-center gap-1.5 text-xs min-w-0">
              {login.plan && (
                <span className="shrink-0 rounded-full bg-surface2 px-1.5 font-semibold capitalize text-muted">{login.plan}</span>
              )}
              <span
                className="truncate"
                style={{ color: out ? 'var(--red-light)' : next ? 'var(--green)' : 'var(--muted)' }}
              >
                {status}
              </span>
            </div>
          </div>
        </div>
        {login.windows.length === 0 ? (
          <span className="col-span-2 text-xs text-muted">Shows how much is left after its next run.</span>
        ) : labelled ? (
          <span className="col-span-2" />
        ) : (
          WINDOWS.map((n) => <UsageCell key={n} w={find('', n)} />)
        )}
        <Button
          variant="quiet"
          aria-label="More"
          disabled={busy}
          onClick={async (e) => {
            const picked = await pickFromMenu(e, menu)
            if (picked === 'reconnect') onReconnect()
            if (picked === 'credits') onMoreCredits?.()
            if (picked === 'remove') onRemove()
          }}
        >
          <Ellipsis size={16} />
        </Button>
      </div>
      {labelled &&
        groups.map((g) => (
          <div key={g} className={`${COLS} mt-1.5`}>
            <span className="pl-[26px] text-xs text-muted truncate">{g}</span>
            {WINDOWS.map((n) => (
              <UsageCell key={n} w={find(g, n)} />
            ))}
            <span />
          </div>
        ))}
    </div>
  )
}

export function PlanLogins(): JSX.Element {
  const [logins, setLogins] = useState<PlanLogin[]>([])
  const [checking, setChecking] = useState(false)
  const [signingIn, setSigningIn] = useState<PlanBackend | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agy, setAgy] = useState<AntigravityPlan[]>([])
  const [agyBusy, setAgyBusy] = useState<'setting-up' | 'signing-in' | null>(null)
  const agySignedIn = agy.filter((a) => a.windows.length > 0)
  const agyRows = agy.filter((a) => a.email !== '')

  useEffect(() => {
    let cancelled = false
    void window.api.planLoginsList().then((l) => !cancelled && setLogins(l))
    void window.api.planAntigravity().then((a) => !cancelled && setAgy(a))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (agyBusy !== 'signing-in') return
    const before = agySignedIn.length
    const timer = setInterval(() => {
      void window.api.planAntigravity().then((a) => {
        if (a.filter((x) => x.windows.length > 0).length <= before) return
        setAgy(a)
        setAgyBusy(null)
      })
    }, AGY_SIGN_IN_POLL_MS)
    return () => clearInterval(timer)
  }, [agyBusy])

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      const [l, a] = await Promise.all([window.api.planLoginsCheck(), window.api.planAntigravity()])
      setLogins(l)
      setAgy(a)
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
    const keep = login.dir === null ? ` You stay signed in to ${PLAN_BACKEND_LABEL[login.backend]} on this computer.` : ''
    if (!window.confirm(`Remove ${login.email}? MightyMouse stops using this account.${keep}`)) return
    setLogins(await window.api.planLoginsRemove(login.id))
  }

  const reconnect = async (login: PlanLogin): Promise<void> => {
    setError(null)
    setSigningIn(login.backend)
    setReconnecting(true)
    try {
      const r = await window.api.planLoginsReconnect(login.id)
      setLogins(r.logins)
      setError(r.error)
    } finally {
      setSigningIn(null)
      setReconnecting(false)
    }
  }

  const addAgy = async (): Promise<void> => {
    setError(null)
    setAgyBusy('setting-up')
    const r = await window.api.planAntigravityAdd()
    setAgy(r.plans)
    setError(r.error)
    setAgyBusy(r.signingIn ? 'signing-in' : null)
  }

  const removeAgy = async (a: AntigravityPlan): Promise<void> => {
    const msg = a.main
      ? `Hide ${a.email}? You stay signed in to Antigravity on this computer. Add Antigravity account brings it back.`
      : `Remove ${a.email}? MightyMouse stops using this account.`
    if (!window.confirm(msg)) return
    setAgy(await window.api.planAntigravityRemove(a.id))
  }

  const reconnectAgy = async (a: AntigravityPlan): Promise<void> => {
    setAgy(await window.api.planAntigravityReconnect(a.id))
    if (a.windows.length === 0) setAgyBusy('signing-in')
  }

  const busy = checking || signingIn !== null || agyBusy === 'setting-up'
  const now = Date.now()
  return (
    <div className="mt-4 pt-4 border-t border-surface3 first:mt-0 first:pt-0 first:border-t-0">
      <div className="flex items-center justify-between mb-1">
        <div className="text-md font-semibold">Your AI plans</div>
        <Button variant="text" disabled={busy} onClick={() => void check()}>
          <RefreshCw size={14} className={checking ? 'animate-spin' : undefined} />
          {checking ? 'Checking…' : 'Check usage'}
        </Button>
      </div>
      <p className="text-muted text-sm mb-2">
        Add every Claude and ChatGPT account you pay for. When one runs out, the next one picks up the work.
      </p>
      {(logins.length > 0 || agyRows.length > 0) && (
        <div className={`${COLS} text-xs text-muted pb-1`}>
          <span />
          <span>5-hour</span>
          <span>Weekly</span>
          <span />
        </div>
      )}
      {PLAN_BACKENDS.map((backend) => {
        const mine = logins.filter((l) => l.backend === backend && !l.paused)
        const nextId = mine.find((l) => isPlanLoginOpen(l, now))?.id
        return (
          <div key={backend} className="flex flex-col">
            {mine.map((l) => (
              <LoginRow
                key={l.id}
                login={l}
                icon={backend}
                name={PLAN_BACKEND_LABEL[backend]}
                next={l.id === nextId}
                busy={busy}
                onRemove={() => void remove(l)}
                onReconnect={() => void reconnect(l)}
              />
            ))}
          </div>
        )
      })}
      {agyRows.map((a) => (
        <LoginRow
          key={a.id}
          login={{ email: a.email, plan: 'Antigravity', dir: a.main ? null : a.id, windows: a.windows, limitedUntil: null }}
          icon="gemini"
          name="Antigravity"
          next={false}
          idle={a.windows.length === 0 ? 'Signed out. Click Reconnect.' : a.credits === null ? 'Runs your Antigravity agents' : `${a.credits.toLocaleString()} credits left`}
          busy={busy}
          onRemove={() => void removeAgy(a)}
          onReconnect={() => void reconnectAgy(a)}
          onMoreCredits={a.upgradeUrl ? () => void window.api.openExternal(a.upgradeUrl) : undefined}
        />
      ))}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {agyBusy === 'signing-in' ? (
          <>
            <span className="text-sm">Finish signing in to Antigravity in the Terminal window. Use a different Google account from the ones above.</span>
            <Button variant="ghost" onClick={() => setAgyBusy(null)}>
              Cancel
            </Button>
          </>
        ) : signingIn ? (
          <>
            <span className="text-sm">
              Finish signing in to {PLAN_BACKEND_LABEL[signingIn]} in your browser.
              {reconnecting ? '' : ' Use a different account from the ones above.'}
            </span>
            <Button variant="ghost" onClick={() => void window.api.planLoginsCancel()}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async (e) => {
              const picked = await pickFromMenu(e, [
                ...PLAN_BACKENDS.map((b) => ({ id: b, label: PLAN_BACKEND_LABEL[b] })),
                { id: 'antigravity', label: 'Antigravity' }
              ], 'left')
              if (picked === 'antigravity') void addAgy()
              else if (picked) void add(picked as PlanBackend)
            }}
          >
            <Plus size={14} />
            {agyBusy === 'setting-up' ? 'Setting up Antigravity…' : 'Add account'}
          </Button>
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
