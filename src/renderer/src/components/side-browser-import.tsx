import { useEffect, useState, type JSX } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from './Button'
import type { SideBrowserImportResult, SideBrowserImportSource } from '../../../shared/types'

type Phase =
  | { kind: 'loading' }
  | { kind: 'pick' }
  | { kind: 'running' }
  | { kind: 'done'; result: SideBrowserImportResult }

const FAILURE: Record<'missing' | 'denied' | 'unreadable', string> = {
  missing: 'That browser profile is gone. Pick another one.',
  denied: 'macOS didn’t give permission, so nothing was brought over.',
  unreadable: 'The sign-ins in that profile couldn’t be read on this Mac.'
}

function sourceKey(s: SideBrowserImportSource): string {
  return `${s.browser}/${s.profile}`
}

function sourceLabel(s: SideBrowserImportSource): string {
  return `${s.browserLabel} - ${s.name}${s.email ? ` (${s.email})` : ''}`
}

export function SideBrowserImport({ onClose }: { onClose: () => void }): JSX.Element {
  const [sources, setSources] = useState<SideBrowserImportSource[]>([])
  const [picked, setPicked] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    void window.api.sideBrowser.importSources().then((list) => {
      if (!live) return
      setSources(list)
      setPicked(list[0] ? sourceKey(list[0]) : '')
      setPhase({ kind: 'pick' })
    })
    return () => {
      live = false
    }
  }, [])

  const source = sources.find((s) => sourceKey(s) === picked)

  const start = async (): Promise<void> => {
    if (!source) return
    setPhase({ kind: 'running' })
    const result = await window.api.sideBrowser
      .importCookies(source.browser, source.profile)
      .catch((): SideBrowserImportResult => ({ ok: false, reason: 'unreadable' }))
    setPhase({ kind: 'done', result })
  }

  if (phase.kind === 'loading') return <div className="side-browser-empty" />

  if (phase.kind === 'done' && phase.result.ok)
    return (
      <div className="side-browser-empty">
        <KeyRound size={22} />
        <p>
          <strong>
            Signed in to {phase.result.sites.toLocaleString()} sites from{' '}
            {phase.result.browserLabel}
          </strong>
        </p>
        <p className="side-browser-error">Pages you open here now start signed in.</p>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    )

  if (!sources.length)
    return (
      <div className="side-browser-empty">
        <KeyRound size={22} />
        <p>No Chrome, Brave, Edge or Arc sign-ins found on this Mac.</p>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    )

  const running = phase.kind === 'running'
  const failure = phase.kind === 'done' && !phase.result.ok ? FAILURE[phase.result.reason] : null

  return (
    <div className="side-browser-empty">
      <KeyRound size={22} />
      <p>
        <strong>Skip logging in again</strong>
      </p>
      <p>Copy your logins from your browser, so sites open here already signed in.</p>
      {sources.length > 1 && (
        <select
          className="side-browser-import-pick"
          value={picked}
          disabled={running}
          onChange={(e) => setPicked(e.target.value)}
        >
          {sources.map((s) => (
            <option key={sourceKey(s)} value={sourceKey(s)}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
      )}
      {failure && <p className="side-browser-error">{failure}</p>}
      <p className="side-browser-error">
        {running
          ? `Waiting for macOS - click Allow on the keychain prompt.`
          : `macOS will ask to read ${source?.browserLabel ?? 'your browser'}'s keychain entry. Click Allow.`}
      </p>
      <Button variant="primary" disabled={running || !source} onClick={() => void start()}>
        {running ? 'Bringing sign-ins over…' : failure ? 'Try again' : 'Bring my sign-ins over'}
      </Button>
      <Button variant="ghost" disabled={running} onClick={onClose}>
        Not now
      </Button>
    </div>
  )
}
