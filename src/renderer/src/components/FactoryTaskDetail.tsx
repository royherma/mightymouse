import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  GitMerge,
  Loader2,
  RotateCcw,
  ScrollText,
  Wrench,
  X,
  XCircle
} from 'lucide-react'
import {
  factoryAgentName,
  FACTORY_ROLE_AGENT,
  FACTORY_STATIONS,
  FACTORY_STATION_LABEL,
  type FactoryAttempt,
  type FactoryAuditEvent,
  type FactoryEvidence,
  type FactoryTask,
  withoutNodeWarnings
} from '../../../shared/factory'
import {
  FACTORY_ACTION as ACT,
  FACTORY_RETRY_LABEL,
  FACTORY_STATE,
  factoryHint
} from '../../../shared/factory-words'
import { Button } from './Button'
import { FactoryFiles } from './FactoryFiles'
import { FactoryAudit } from './FactoryAudit'
import { FactoryTranscript } from './FactoryTranscript'
import { FactoryAgentRail } from './factory-agent-rail'
import './FactoryDetail.css'

const clock = (at: number): string => {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}
const span = (from: number, to: number): string => {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
const ROLE_LABEL = {
  plan: 'Plan',
  prepare: 'Prepare',
  build: 'Build',
  check: 'Check',
  review: 'Review'
} as const
const TALKS = new Set(['plan', 'build', 'review'])
export function FactoryTaskDetail({
  task,
  attempts,
  evidence,
  auditEvents = [],
  onClose,
  onCancel,
  onRestore,
  onPark,
  onRetry,
  onMerge
}: {
  task: FactoryTask
  attempts: FactoryAttempt[]
  evidence: FactoryEvidence[]
  auditEvents?: FactoryAuditEvent[]
  onClose: () => void
  onCancel: () => void
  onRestore: () => void
  onPark: () => void
  onRetry: (options: { note: string; rebuild: boolean }) => void
  onMerge: () => Promise<void>
}): React.JSX.Element {
  const rows = evidence.filter((item) => item.taskId === task.id)
  const history = attempts
    .filter((item) => item.taskId === task.id)
    .sort((a, b) => a.startedAt - b.startedAt || a.generation - b.generation)
  const current = FACTORY_STATIONS.findIndex((stage) => stage === task.stage)
  const stopped = task.condition === 'blocked' || task.condition === 'interrupted'
  const [reading, setReading] = useState<string | null>(null)
  const [retryNote, setRetryNote] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [merge, setMerge] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const running = history.find((item) => item.state === 'started')
  const focus = running ?? history.at(-1)
  const models = history.flatMap((item) => item.audit?.flatMap((run) => run.models) ?? [])
  const lastAction = focus?.audit?.at(-1)?.actions.at(-1)
  const talkers = history.filter((item) => TALKS.has(item.role) && item.startedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running?.id])
  const canRebuild = stopped && (task.stage === 'checking' || task.stage === 'reviewing')
  const retry = (rebuild: boolean): void => {
    onRetry({ note: retryNote, rebuild })
    setRetryNote('')
  }
  const [log, setLog] = useState('')
  const [logError, setLogError] = useState('')
  const openLog = (id: string): void => {
    setLog('')
    setLogError('')
    void window.api
      .factoryArtifact(id)
      .then(setLog)
      .catch((err: unknown) =>
        setLogError(err instanceof Error ? err.message : 'That log could not be opened.')
      )
  }
  const stage =
    task.stage === 'draft'
      ? FACTORY_STATE.idea.label
      : task.stage === 'merged'
        ? FACTORY_STATE.shipped.label
        : FACTORY_STATION_LABEL[task.stage]
  const state = stopped
    ? task.condition === 'blocked'
      ? FACTORY_STATE.stuck.label
      : FACTORY_STATE.interrupted.label
    : task.condition === 'canceled'
      ? FACTORY_STATE.canceled.label
      : stage
  const tone = stopped
    ? 'stuck'
    : task.stage === 'ready' || task.stage === 'merged'
      ? 'done'
      : history.some((item) => item.state === 'started')
        ? 'working'
        : 'idle'
  const nextAction = task.nextAction.startsWith('Reconcile to see')
    ? 'Retry picks up from what it left on the branch.'
    : task.nextAction
  const stageName = task.stage in FACTORY_STATION_LABEL ? stage.toLowerCase() : 'this step'
  const steps = task.acceptance.map((line) => ({
    text: line.text,
    done: rows.some(
      (row) =>
        row.criterion === line.text &&
        row.commitSha === task.commitSha &&
        !!task.commitSha &&
        !row.stale &&
        row.exitCode === 0
    )
  }))
  const checked = steps.filter((step) => step.done).length
  const waiting = !stopped && !running && task.stage !== 'ready' && task.stage !== 'merged'
  const headline = stopped
    ? `Stuck at ${stageName}`
    : task.condition === 'canceled'
      ? FACTORY_STATE.canceled.label
      : task.stage === 'merged'
        ? FACTORY_STATE.shipped.label
        : task.stage === 'ready'
          ? FACTORY_STATE.ready.label
          : running
            ? `${stage}…`
            : FACTORY_STATE.waiting.label
  const subline = stopped
    ? withoutNodeWarnings(task.blockReason || task.activity) || FACTORY_STATE[task.condition === 'blocked' ? 'stuck' : 'interrupted'].means
    : task.stage === 'ready'
      ? task.acceptance.length
        ? `${checked} of ${task.acceptance.length} checks passed`
        : FACTORY_STATE.ready.means
      : task.stage === 'merged'
        ? `${FACTORY_STATE.shipped.label} ${clock(task.updatedAt)}`
        : running
          ? `${span(running.startedAt || now, now)} · ${
              lastAction && !lastAction.finishedAt
                ? `${lastAction.name} ${lastAction.detail}`.trim()
                : task.activity || FACTORY_ROLE_AGENT[running.role]
            }`
          : waiting
            ? FACTORY_STATE.waiting.means
            : ''
  return (
    <aside className="factory-detail" aria-label={`Task: ${task.title}`}>
      <div className="flex items-start justify-between gap-2">
        <h2>{task.title}</h2>
        <Button variant="icon" aria-label="Close" title="Close" onClick={onClose}>
          <X size={16} />
        </Button>
      </div>
      <div
        className="factory-progress"
        data-working={tone === 'working' || undefined}
        aria-label={`Current stage: ${stage}`}
      >
        {FACTORY_STATIONS.map((item, index) => (
          <span
            key={item}
            title={FACTORY_STATION_LABEL[item]}
            data-passed={index < current || task.stage === 'merged' || undefined}
            data-current={index === current || undefined}
            data-stuck={(index === current && stopped) || undefined}
          />
        ))}
      </div>
      {reading ? (
        <FactoryTranscript
          attempts={talkers}
          initialId={reading}
          onClose={() => setReading(null)}
        />
      ) : (
        <>
          <section className="factory-decide" data-tone={tone}>
            <p className="factory-decide-head">{headline}</p>
            {subline && (
              <p className="factory-decide-sub" data-open={reasonOpen || undefined}>
                {subline}
              </p>
            )}
            {subline.length > 110 && (
              <Button
                variant="bare"
                className="factory-decide-more"
                onClick={() => setReasonOpen(!reasonOpen)}
              >
                {reasonOpen ? 'Show less' : 'Read all'}
              </Button>
            )}
            {stopped && noteOpen && (
              <textarea
                className="factory-note-input"
                rows={2}
                autoFocus
                aria-label="What should it do differently"
                placeholder="What should it do differently?"
                value={retryNote}
                onChange={(event) => setRetryNote(event.target.value)}
              />
            )}
            <div className="factory-decide-actions">
              {task.condition === 'canceled' && task.stage !== 'draft' && (
                <Button className="factory-cta" title={ACT.restore.keeps} onClick={onRestore}>
                  <span>
                    <RotateCcw size={16} /> {ACT.restore.label}
                  </span>
                  <small>{ACT.restore.does}</small>
                </Button>
              )}
              {stopped && (
                <>
                  <Button
                    className="factory-cta"
                    title={ACT.retry.keeps}
                    onClick={() => retry(false)}
                  >
                    <span>
                      <RotateCcw size={16} /> {FACTORY_RETRY_LABEL[task.stage] ?? ACT.retry.label}
                    </span>
                    <small>{ACT.retry.does}</small>
                  </Button>
                  {canRebuild && (
                    <Button
                      variant="ghost"
                      className="factory-cta"
                      title={ACT.rebuild.keeps}
                      onClick={() => retry(true)}
                    >
                      <span>
                        <Wrench size={16} /> {ACT.rebuild.label}
                      </span>
                      <small>{ACT.rebuild.does}</small>
                    </Button>
                  )}
                </>
              )}
              {task.stage === 'ready' && task.prUrl && (
                <>
                  <Button
                    variant="success"
                    className="factory-cta"
                    disabled={merge === 'busy'}
                    title={factoryHint('ship')}
                    onClick={() => {
                      if (merge !== 'confirm') return setMerge('confirm')
                      setMerge('busy')
                      void onMerge().finally(() => setMerge('idle'))
                    }}
                    onBlur={() => merge === 'confirm' && setMerge('idle')}
                  >
                    {merge === 'busy' ? (
                      <Loader2 size={16} className="factory-spin" />
                    ) : (
                      <GitMerge size={16} />
                    )}
                    {merge === 'busy'
                      ? ACT.shipping.label
                      : merge === 'confirm'
                        ? ACT.shipConfirm.label
                        : ACT.ship.label}
                  </Button>
                  <Button
                    variant="ghost"
                    className="factory-cta"
                    title={factoryHint('changes')}
                    onClick={() => void window.api.openExternal(task.prUrl!)}
                  >
                    <ExternalLink size={16} /> {ACT.changes.label}
                  </Button>
                </>
              )}
              {running && talkers.length > 0 && (
                <Button
                  variant="ghost"
                  className="factory-cta"
                  onClick={() => setReading((running ?? talkers.at(-1))!.id)}
                >
                  <ScrollText size={16} /> {ACT.watch.label}
                </Button>
              )}
            </div>
            {stopped && (
              <div className="factory-decide-links">
                <Button
                  variant="bare"
                  title={factoryHint('note')}
                  onClick={() => setNoteOpen(!noteOpen)}
                >
                  {noteOpen ? 'No note' : ACT.note.label}
                </Button>
                {task.condition === 'blocked' && (
                  <Button
                    variant="bare"
                    title={factoryHint(task.parked ? 'unpark' : 'park')}
                    onClick={onPark}
                  >
                    {task.parked ? ACT.unpark.label : ACT.park.label}
                  </Button>
                )}
                <Button variant="bare" title={factoryHint('cancel')} onClick={onCancel}>
                  {ACT.cancel.label}
                </Button>
              </div>
            )}
            {!stopped && waiting && (
              <div className="factory-decide-links">
                <Button variant="bare" title={factoryHint('cancel')} onClick={onCancel}>
                  {ACT.cancel.label}
                </Button>
              </div>
            )}
          </section>
          <FactoryAgentRail
            task={task}
            attempt={focus}
            attempts={history}
            talks={!!focus && TALKS.has(focus.role)}
            steps={steps}
            now={now}
            onWatch={
              focus && TALKS.has(focus.role) && focus.startedAt
                ? () => setReading(focus.id)
                : undefined
            }
          />
          <details className="factory-more">
            <summary>Details</summary>
            <div className="factory-detail-state" data-tone={tone}>
              <span className="factory-detail-pill">{state}</span>
              {current >= 0 && (
                <span>
                  Step {current + 1} of {FACTORY_STATIONS.length}
                </span>
              )}
              <time className="ml-auto">Updated {clock(task.updatedAt)}</time>
            </div>
            <div className="factory-detail-body">
              <div className="factory-detail-main">
                {(stopped || task.blockReason || task.nextAction) && (
                  <div className="factory-callout" role="status">
                    <AlertCircle size={16} />
                    <div className="min-w-0 flex-1">
                      {task.blockReason && <p>{task.blockReason}</p>}
                      {nextAction && <p className="mt-1 font-medium">{nextAction}</p>}
                      {!task.blockReason && !task.nextAction && (
                        <p>{task.activity || 'It stopped.'}</p>
                      )}
                    </div>
                  </div>
                )}
                {task.repairNote && (
                  <details className="factory-repair" open={stopped || undefined}>
                    <summary>What the next try will be told</summary>
                    <pre>{task.repairNote}</pre>
                  </details>
                )}
                <section className="factory-detail-section">
                  <h3>What we’re making</h3>
                  <p className="text-sm whitespace-pre-wrap">{task.outcome}</p>
                </section>
                <section className="factory-detail-section">
                  <h3>Done when</h3>
                  <ul className="factory-results">
                    {task.acceptance.map((line, index) => {
                      const matches = rows.filter(
                        (row) =>
                          row.criterion === line.text &&
                          row.commitSha === task.commitSha &&
                          !!task.commitSha &&
                          !row.stale
                      )
                      const passed = matches.some((row) => row.exitCode === 0)
                      return (
                        <li key={`${index}:${line.text}`}>
                          {passed ? (
                            <CheckCircle2 size={15} className="text-green" />
                          ) : matches.length ? (
                            <XCircle size={15} className="text-red" />
                          ) : (
                            <Circle size={15} className="text-muted" />
                          )}
                          <span>{line.text}</span>
                          <span className="factory-result-note">
                            {passed ? 'Verified' : matches.length ? 'Failed' : 'Not checked yet'}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
                {rows.length > 0 && (
                  <section className="factory-detail-section">
                    <h3>Check results</h3>
                    <ul className="factory-results">
                      {rows.map((row) => {
                        const earlier = row.stale || row.commitSha !== task.commitSha
                        return (
                          <li key={row.id} data-earlier={earlier || undefined}>
                            {row.exitCode === 0 ? (
                              <CheckCircle2 size={15} className="text-green" />
                            ) : (
                              <XCircle size={15} className="text-red" />
                            )}
                            <span>
                              {row.criterion || row.command || 'Review'}
                              {earlier && <span className="text-muted"> · earlier version</span>}
                            </span>
                            {row.artifactPath && (
                              <Button
                                variant="bare"
                                className="factory-result-link"
                                onClick={() => openLog(row.id)}
                              >
                                {row.provenance === 'reviewer' ? 'Findings' : 'Log'}
                              </Button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                    {logError && <p className="mt-2 text-sm text-accent">{logError}</p>}
                    {log && (
                      <div className="factory-log">
                        <Button
                          variant="icon"
                          className="factory-log-close"
                          aria-label="Close log"
                          title="Close log"
                          onClick={() => setLog('')}
                        >
                          <X size={13} />
                        </Button>
                        <pre>{log}</pre>
                      </div>
                    )}
                  </section>
                )}
                <section className="factory-detail-section">
                  <h3>Progress</h3>
                  {history.length === 0 ? (
                    <p className="text-sm text-muted">
                      {task.stage === 'draft'
                        ? 'Review this task before it starts.'
                        : 'Waiting for its first attempt.'}
                    </p>
                  ) : (
                    <ol className="factory-timeline">
                      {history.map((attempt) => {
                        let result: {
                          kind?: string
                          error?: string
                          pass?: boolean
                          failures?: string[]
                        } = {}
                        try {
                          result = JSON.parse(attempt.result || '{}')
                        } catch {
                          result = {}
                        }
                        const failed =
                          result.kind === 'blocked' ||
                          result.kind === 'interrupted' ||
                          result.pass === false ||
                          !!result.failures?.length ||
                          !!result.error
                        const canceled = attempt.state === 'finished' && result.kind === 'canceled'
                        return (
                          <li key={attempt.id} data-live={attempt.state === 'started' || undefined}>
                            {failed ? (
                              <AlertCircle size={15} className="text-red" />
                            ) : attempt.state === 'started' ? (
                              <Clock3 size={15} className="text-accent" />
                            ) : attempt.state === 'finished' && !canceled ? (
                              <CheckCircle2 size={15} className="text-green" />
                            ) : (
                              <Circle size={15} className="text-muted" />
                            )}
                            <span>
                              <span className="font-medium">{ROLE_LABEL[attempt.role]}</span>
                              <span className="text-muted">
                                {' · '}
                                {failed
                                  ? 'Stopped'
                                  : canceled
                                    ? 'Canceled'
                                    : attempt.state === 'finished'
                                      ? 'Done'
                                      : attempt.state === 'started'
                                        ? 'Working'
                                        : 'Waiting'}
                              </span>
                              {TALKS.has(attempt.role) && attempt.startedAt > 0 && (
                                <Button
                                  variant="bare"
                                  className="factory-result-link ml-2"
                                  onClick={() => setReading(attempt.id)}
                                >
                                  Transcript
                                </Button>
                              )}
                            </span>
                            <time
                              title={
                                attempt.startedAt
                                  ? new Date(attempt.startedAt).toLocaleString()
                                  : undefined
                              }
                            >
                              {attempt.startedAt ? clock(attempt.startedAt) : 'Not started'}
                              {attempt.startedAt && attempt.finishedAt
                                ? ` · ${span(attempt.startedAt, attempt.finishedAt)}`
                                : ''}
                            </time>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </section>
                <FactoryFiles key={task.id} task={task} />
              </div>
              <div className="factory-side">
                <section className="factory-agent" data-working={!!running || undefined}>
                  <div className="factory-agent-head">
                    <span className="factory-agent-avatar" aria-hidden>
                      <Bot size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="factory-agent-name">{factoryAgentName(models)}</p>
                      <p className="factory-agent-role">
                        {focus ? FACTORY_ROLE_AGENT[focus.role] : 'No agent yet'}
                        {running && (
                          <>
                            {' · '}
                            <span className="factory-typing" aria-hidden>
                              <i />
                              <i />
                              <i />
                            </span>{' '}
                            {span(running.startedAt || now, now)}
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  {running && (task.activity || lastAction) && (
                    <p className="factory-agent-now" aria-live="polite">
                      {lastAction && !lastAction.finishedAt
                        ? `${lastAction.name} ${lastAction.detail}`.trim()
                        : task.activity}
                    </p>
                  )}
                  {talkers.length > 0 && !running && (
                    <Button
                      variant="ghost"
                      className="factory-act"
                      onClick={() => setReading((running ?? talkers.at(-1))!.id)}
                    >
                      <ScrollText size={14} /> Open transcript
                    </Button>
                  )}
                </section>
                <section className="factory-side-card">
                  <dl className="factory-facts">
                    <dt>Created</dt>
                    <dd>{clock(task.createdAt)}</dd>
                    <dt>Approved</dt>
                    <dd>{task.approvedAt ? clock(task.approvedAt) : 'Not yet'}</dd>
                    {task.branch && (
                      <>
                        <dt>Branch</dt>
                        <dd className="break-all" title={task.branch}>
                          {task.branch}
                        </dd>
                      </>
                    )}
                    {task.commitSha && (
                      <>
                        <dt>Commit</dt>
                        <dd className="font-mono">{task.commitSha.slice(0, 7)}</dd>
                      </>
                    )}
                  </dl>
                  <FactoryAudit
                    title="Actions and usage"
                    events={auditEvents.filter(
                      (event) => event.target === task.id || event.target === task.batchId
                    )}
                    attempts={attempts.filter(
                      (attempt) => attempt.taskId === task.id || attempt.id === task.originAttemptId
                    )}
                  />
                </section>
                {task.condition !== 'canceled' && task.stage !== 'merged' && (
                  <Button variant="bare" className="factory-cancel" onClick={onCancel}>
                    Cancel task
                  </Button>
                )}
              </div>
            </div>
          </details>
        </>
      )}
    </aside>
  )
}
