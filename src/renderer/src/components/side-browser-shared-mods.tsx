import { useState, type JSX } from 'react'
import { BadgeCheck, Download } from 'lucide-react'
import { Button } from './Button'
import type { SharedMod, SharedModRequest, SharedModResult, SiteModState } from '../../../shared/types'

const send = (viewId: string | undefined, request: SharedModRequest): Promise<SharedModResult> =>
  window.api.sideBrowser.sharedMod(viewId ?? '', request).catch(() => ({ ok: false, message: 'That did not go through. Try again.' }))

export function Maker({ name, verified }: { name: string; verified: boolean }): JSX.Element {
  return (
    <span className="side-browser-mod-maker" title={verified ? `${name} is a verified maker` : undefined}>
      by {name}
      {verified && <BadgeCheck size={12} aria-label="Verified maker" />}
    </span>
  )
}

const can = (asks: string[]): string => `It ${asks.join(', and it ')}.`

function useAdd(viewId: string | undefined, mod: SharedMod, onAdded?: () => void): {
  busy: boolean
  asking: string[] | null
  error: string | null
  stopped: boolean
  add: (yes?: boolean) => void
  cancel: () => void
} {
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const add = (yes = false): void => {
    setBusy(true)
    setError(null)
    void send(viewId, { do: 'add', sharedId: mod.id, yes }).then((res) => {
      setBusy(false)
      setAsking(res.needsYes ?? null)
      if (!res.ok && !res.needsYes) setError(res.message ?? 'This mod could not be added.')
      setStopped(!res.ok && !res.needsYes && !res.canRetry)
      if (res.ok) onAdded?.()
    })
  }
  return { busy, asking, error, stopped, add, cancel: () => setAsking(null) }
}

export function SharedModBar({
  viewId,
  mod,
  onDecline
}: {
  viewId: string
  mod: SharedMod
  onDecline?: () => void
}): JSX.Element {
  const { busy, asking, error, stopped, add, cancel } = useAdd(viewId, mod)
  return (
    <div className="side-browser-permission">
      <span>
        <b>{mod.name}</b> <Maker {...mod.maker} />
        {' - '}
        {error ? <span data-tone="bad">{error}</span> : asking ? can(asking) : mod.summary || `A mod for ${mod.host}`}
      </span>
      {asking ? (
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      ) : (
        onDecline && (
          <Button variant="ghost" onClick={onDecline}>
            No thanks
          </Button>
        )
      )}
      {!stopped && (
        <Button variant="primary" disabled={busy} onClick={() => add(Boolean(asking))}>
          {busy ? 'Adding…' : asking ? 'Yes, add it' : error ? 'Try again' : 'Add'}
        </Button>
      )}
    </div>
  )
}

export function SharedModRow({
  viewId,
  mod,
  onChanged
}: {
  viewId: string | undefined
  mod: SharedMod
  onChanged: () => void
}): JSX.Element {
  const { busy, asking, error, add, cancel } = useAdd(viewId, mod, onChanged)
  return (
    <>
      <Button
        variant="bare"
        role="menuitem"
        className="side-browser-menu-row"
        title={mod.summary || undefined}
        disabled={busy}
        onClick={() => add(false)}
      >
        <Download size={13} />
        <span className="side-browser-suggest-title">{mod.name}</span>
        <span className="side-browser-suggest-url">
          <Maker {...mod.maker} /> · {busy ? 'Adding…' : 'Add'}
        </span>
      </Button>
      {(asking || error) && (
        <div className="side-browser-mod-panel" data-tone={error ? 'bad' : undefined}>
          <span>{error ?? can(asking ?? [])}</span>
          {asking && (
            <div className="side-browser-mod-panel-actions">
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => add(true)}>
                Yes, add it
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export function SharePanel({
  viewId,
  mod,
  onChanged
}: {
  viewId: string | undefined
  mod: SiteModState
  onChanged: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [needsName, setNeedsName] = useState(false)
  const [makerName, setMakerName] = useState('')
  const [copied, setCopied] = useState(false)
  const run = (request: SharedModRequest): void => {
    setBusy(true)
    setNote(null)
    void send(viewId, request).then((res) => {
      setBusy(false)
      setNeedsName(Boolean(res.needsName))
      if (!res.ok && !res.needsName) setNote(res.message ?? 'That did not go through. Try again.')
      if (res.ok) onChanged()
    })
  }
  const shared = mod.shared
  if (shared) {
    const line =
      shared.status === 'live'
        ? 'Shared. Anyone with the link can add it.'
        : shared.status === 'pending'
          ? 'MightyMouse is checking it. The link works for other people once it passes.'
          : (mod.pulled ?? 'MightyMouse turned this mod off.')
    return (
      <div className="side-browser-mod-panel" data-tone={note || shared.status === 'pulled' ? 'bad' : undefined}>
        <span>{note ?? line}</span>
        <div className="side-browser-mod-panel-actions">
          <Button variant="ghost" disabled={busy} onClick={() => run({ do: 'unshare', modId: mod.id })}>
            Stop sharing
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard.writeText(shared.url)
              setCopied(true)
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="side-browser-mod-panel" data-tone={note ? 'bad' : undefined}>
      <span>
        {note ??
          (mod.kind === 'look'
            ? 'This mod only changes how the site looks, so anyone with the link can add it right away.'
            : 'This mod has code, so MightyMouse checks it before other people can add it.')}
      </span>
      {needsName && (
        <input
          className="side-browser-mod-rename"
          value={makerName}
          autoFocus
          maxLength={30}
          placeholder="Your maker name, shown on your mods"
          aria-label="Your maker name"
          spellCheck={false}
          onChange={(e) => setMakerName(e.currentTarget.value)}
        />
      )}
      <div className="side-browser-mod-panel-actions">
        <Button
          variant="primary"
          disabled={busy || (needsName && makerName.trim().length < 2)}
          onClick={() => run({ do: 'share', modId: mod.id, ...(needsName ? { makerName: makerName.trim() } : {}) })}
        >
          {busy ? 'Sharing…' : 'Share'}
        </Button>
      </div>
    </div>
  )
}

export function ReportPanel({ viewId, sharedId, onDone }: { viewId: string | undefined; sharedId: string; onDone: () => void }): JSX.Element {
  const [reason, setReason] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const submit = (): void => {
    setState('busy')
    void send(viewId, { do: 'report', sharedId, reason: reason.trim() }).then((res) => {
      setState(res.ok ? 'sent' : 'idle')
      setError(res.ok ? null : (res.message ?? 'That did not go through. Try again.'))
    })
  }
  if (state === 'sent')
    return (
      <div className="side-browser-mod-panel">
        <span>Thanks. MightyMouse will look at it.</span>
        <div className="side-browser-mod-panel-actions">
          <Button variant="ghost" onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    )
  return (
    <div className="side-browser-mod-panel" data-tone={error ? 'bad' : undefined}>
      {error && <span>{error}</span>}
      <input
        className="side-browser-mod-rename"
        value={reason}
        autoFocus
        maxLength={500}
        placeholder="What is wrong with this mod?"
        aria-label="What is wrong with this mod?"
        onChange={(e) => setReason(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && reason.trim()) submit()
        }}
      />
      <div className="side-browser-mod-panel-actions">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={state === 'busy' || !reason.trim()} onClick={submit}>
          Report
        </Button>
      </div>
    </div>
  )
}
