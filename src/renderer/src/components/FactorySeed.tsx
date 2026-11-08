import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Clock, FileText, Loader2, RefreshCw, X } from 'lucide-react'
import type { FactoryAttempt, FactorySnapshot } from '../../../shared/factory'
import { FACTORY_SCREEN as S } from '../../../shared/factory-words'
import type { BusinessType } from '../../../shared/infra'
import { PLAYBOOK_USES, ideasGoal, type PlaybookUse } from '../../../shared/playbooks'
import { Button } from './Button'
import { Input } from '../../../shared/ui/Input'
import { FactoryAudit } from './FactoryAudit'

const ago = (now: number, at: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

export function FactorySeed({
  projectId,
  mightyId,
  now,
  planError,
  attempts,
  onSnapshot
}: {
  projectId: string
  mightyId: string
  now: number
  planError: string
  attempts: FactoryAttempt[]
  onSnapshot: (next: FactorySnapshot) => void
}): React.JSX.Element {
  const [task, setTask] = useState('')
  const [briefOpen, setBriefOpen] = useState(false)
  const [text, setText] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [asked, setAsked] = useState<PlaybookUse | null>(null)
  const [error, setError] = useState('')
  const [business, setBusiness] = useState<BusinessType[]>([])
  const history = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    void window.api.infra
      .list()
      .then((all) => setBusiness(all.find((i) => i.projectId === mightyId)?.record?.business ?? []))
    return window.api.infra.onChanged((next) => {
      if (next.projectId === mightyId) setBusiness(next.record?.business ?? [])
    })
  }, [mightyId])

  const run = async (action: () => Promise<FactorySnapshot>): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      onSnapshot(await action())
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const planAttempts = attempts.filter(
    (attempt) => attempt.projectId === projectId && attempt.role === 'plan'
  )
  const planner = planAttempts.find((attempt) => attempt.state !== 'finished')
  let planActivity = ''
  try {
    planActivity = planner
      ? ((JSON.parse(planner.result || '{}') as { activity?: string }).activity ?? '')
      : ''
  } catch {
    planActivity = ''
  }
  const elapsed = planner?.startedAt ? Math.max(0, Math.round((now - planner.startedAt) / 1000)) : 0
  const lastScan = Math.max(0, ...planAttempts.map((attempt) => attempt.startedAt))
  const tokens = planAttempts
    .flatMap((attempt) => attempt.audit ?? [])
    .reduce((sum, item) => sum + (item.usage?.output ?? 0), 0)
  const findIdeas = (use: PlaybookUse | null): void => {
    setAsked(use)
    void run(() =>
      window.api.factorySeed({
        projectId,
        source: 'audit',
        goal: use ? ideasGoal(use, business) : ''
      })
    )
  }
  const addTask = (): void => {
    const title = task.trim()
    if (!title) return
    void run(() =>
      window.api.factorySeed({
        projectId,
        source: 'write',
        drafts: [
          {
            title,
            outcome: title,
            acceptance: [title],
            scope: [],
            dependsOn: [],
            sourceFile: '',
            oversized: false
          }
        ]
      })
    ).then((ok) => ok && setTask(''))
  }
  const sendBrief = (): void =>
    void run(() => window.api.factorySeed({ projectId, source: 'brief', goal, text })).then(
      (ok) => {
        if (!ok) return
        setText('')
        setGoal('')
        setBriefOpen(false)
      }
    )

  return (
    <section className="factory-ask" id="factory-seed" aria-label={S.ask}>
      <div className="factory-ask-row">
        <span className="factory-ask-label">{S.ask}</span>
        {(Object.keys(PLAYBOOK_USES) as PlaybookUse[]).map((use) => (
          <Button
            key={use}
            variant="bare"
            className="factory-area-pill"
            disabled={busy || !!planner}
            aria-pressed={!!planner && asked === use}
            onClick={() => findIdeas(use)}
          >
            {planner && asked === use && <Loader2 size={13} className="animate-spin" />}
            {PLAYBOOK_USES[use]}
          </Button>
        ))}
        <form
          className="factory-ask-write"
          onSubmit={(event) => {
            event.preventDefault()
            addTask()
          }}
        >
          <Input
            id="factory-write-task"
            aria-label={S.write}
            placeholder={S.write}
            value={task}
            onChange={(event) => setTask(event.target.value)}
          />
          {task.trim() && (
            <Button type="submit" disabled={busy}>
              {S.add}
            </Button>
          )}
        </form>
      </div>

      {planner && (
        <p className="factory-scan" aria-live="polite">
          <Loader2 size={14} className="animate-spin" />
          {planner.state === 'pending'
            ? 'Waiting for a free slot'
            : `${planActivity || 'Looking for ideas'} · ${elapsed}s`}
        </p>
      )}
      {(planError || error) && (
        <p className="factory-inline-error" role="alert">
          <AlertTriangle size={14} />{' '}
          <span>{error || planError.replace(/\s*Refresh ideas to try again\.?/i, '')}</span>
          {!error && !planner && (
            <Button variant="ghost" disabled={busy} onClick={() => findIdeas(asked)}>
              <RefreshCw size={13} /> Try again
            </Button>
          )}
        </p>
      )}

      {briefOpen && (
        <div className="factory-composer">
          <textarea
            autoFocus
            rows={3}
            aria-label={S.brief}
            placeholder="Paste the brief"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Input
            aria-label="Goal"
            placeholder="What should it look for?"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button disabled={busy || !text.trim() || !goal.trim()} onClick={sendBrief}>
              Make tasks
            </Button>
            <Button variant="ghost" onClick={() => setBriefOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="factory-ask-foot">
        <Button
          variant="bare"
          className="factory-history-link"
          title={tokens ? `${tokens.toLocaleString()} tokens used` : undefined}
          disabled={!planAttempts.length}
          onClick={() => history.current?.showModal()}
        >
          <Clock size={13} />
          <span className="truncate">{lastScan ? S.lastScan(ago(now, lastScan)) : S.noScans}</span>
        </Button>
        {!briefOpen && (
          <Button
            variant="bare"
            className="factory-history-link"
            title={S.briefHint}
            onClick={() => setBriefOpen(true)}
          >
            <FileText size={13} /> {S.brief}
          </Button>
        )}
      </div>

      <dialog
        ref={history}
        className="factory-history"
        onClick={(event) => {
          if (event.target === event.currentTarget) history.current?.close()
        }}
      >
        <header className="factory-island-head">
          <h2>Idea scans</h2>
          <Button variant="icon" aria-label="Close" onClick={() => history.current?.close()}>
            <X size={15} />
          </Button>
        </header>
        <FactoryAudit open title="Scans" attempts={planAttempts} />
      </dialog>
    </section>
  )
}
