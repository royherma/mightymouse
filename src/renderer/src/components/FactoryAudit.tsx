import { Download } from 'lucide-react'
import type { FactoryAttempt, FactoryAuditEvent } from '../../../shared/factory'
import { Button } from './Button'

const roles = {
  plan: 'Idea scan',
  prepare: 'Preparation',
  build: 'Build',
  check: 'Checks',
  review: 'Review'
} as const
const time = (value: number): string => (value ? new Date(value).toLocaleString() : 'Not started')
const count = (value: number | null): string =>
  value === null ? 'Unavailable' : value.toLocaleString()

export function FactoryAudit({
  attempts,
  title,
  events = [],
  open = false
}: {
  attempts: FactoryAttempt[]
  title: string
  events?: FactoryAuditEvent[]
  open?: boolean
}): React.JSX.Element {
  const ordered = [...attempts].sort((a, b) => b.startedAt - a.startedAt)
  const runs = ordered.flatMap((attempt) => attempt.audit ?? [])
  const reported = runs.filter((run) => run.usage !== null)
  const input = reported.reduce((sum, run) => sum + run.usage!.input, 0)
  const output = reported.reduce((sum, run) => sum + run.usage!.output, 0)
  const exportAudit = (): void => {
    const data = ordered.map(({ role, state, startedAt, finishedAt, result, audit }) => ({
      role,
      state,
      startedAt,
      finishedAt,
      result,
      runs: audit ?? []
    }))
    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify({ exportedAt: new Date().toISOString(), attempts: data, events }, null, 2)],
        { type: 'application/json' }
      )
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'factory-audit.json'
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <details className="factory-detail-section factory-audit" open={open || undefined}>
      <summary className="cursor-pointer text-sm font-medium">
        {title} · {ordered.length}
      </summary>
      <p
        className="factory-audit-stats"
        title="Reported runs only. Cost is the CLI estimate, not your bill."
      >
        <span>
          {reported.length
            ? `${count(input)} in · ${count(output)} out tokens`
            : 'Token usage unavailable'}
        </span>
        <Button
          variant="icon"
          aria-label="Export audit"
          title="Export audit"
          disabled={!ordered.length}
          onClick={exportAudit}
        >
          <Download size={14} />
        </Button>
      </p>
      {events.length > 0 && (
        <details className="mt-3 text-xs">
          <summary>Task changes</summary>
          <ol className="mt-2 space-y-2">
            {events.map((event) => (
              <li key={event.seq}>
                <time>{time(event.at)}</time> ·{' '}
                {event.kind.replace(/^factory[.:_-]?/, '').replaceAll('_', ' ')}
                <pre className="whitespace-pre-wrap break-all">{event.detail}</pre>
              </li>
            ))}
          </ol>
        </details>
      )}
      <ol className="mt-3 space-y-3 text-sm">
        {ordered.map((attempt) => {
          let result: Record<string, unknown> = {}
          try {
            result = JSON.parse(attempt.result || '{}')
          } catch {
            result = {}
          }
          const failure = result.error || result.reason || result.findings
          return (
            <li key={attempt.id}>
              <details>
                <summary className="cursor-pointer">
                  {roles[attempt.role]} · {time(attempt.startedAt)} ·{' '}
                  {attempt.state === 'finished'
                    ? 'Finished'
                    : attempt.state === 'started'
                      ? 'Running'
                      : 'Waiting'}
                </summary>
                <p className="mt-1 text-xs text-muted">
                  {attempt.finishedAt
                    ? `Finished ${time(attempt.finishedAt)} · ${Math.max(0, Math.round((attempt.finishedAt - attempt.startedAt) / 1000))} seconds`
                    : 'No finish recorded'}
                </p>
                {failure ? <p className="mt-2 whitespace-pre-wrap">{String(failure)}</p> : null}
                {Array.isArray(result.drafts) && (
                  <p className="mt-1">{result.drafts.length} ideas generated</p>
                )}
                {(attempt.audit ?? []).length === 0 && (
                  <p className="mt-2 text-xs text-muted">
                    Detailed usage was not recorded for this attempt.
                  </p>
                )}
                {(attempt.audit ?? []).map((run, index) => (
                  <div key={run.id} className="mt-3 border-l border-surface3 pl-3">
                    <p className="font-medium">
                      Run {index + 1}
                      {index > 0 ? ' · retry' : ''}
                    </p>
                    <p className="text-xs text-muted">
                      {time(run.startedAt)} →{' '}
                      {run.finishedAt ? time(run.finishedAt) : 'No finish recorded'}
                    </p>
                    <p className="text-xs">
                      {run.models.join(', ') || 'Model not reported'} ·{' '}
                      {run.exitCode === null ? 'No exit recorded' : `Exit ${run.exitCode}`}
                    </p>
                    {run.usage ? (
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        <dt>Input tokens</dt>
                        <dd>{count(run.usage.input)}</dd>
                        <dt>Output tokens</dt>
                        <dd>{count(run.usage.output)}</dd>
                        <dt>Cache read tokens</dt>
                        <dd>{count(run.usage.cacheRead)}</dd>
                        <dt>Cache write tokens</dt>
                        <dd>{count(run.usage.cacheWrite)}</dd>
                        <dt>Reported cost</dt>
                        <dd>
                          {run.usage.costUsd === null
                            ? 'Unavailable'
                            : `$${run.usage.costUsd.toFixed(4)}`}
                        </dd>
                      </dl>
                    ) : (
                      <p className="text-xs text-muted">Token usage unavailable</p>
                    )}
                    <ol className="mt-2 space-y-2">
                      {run.actions.map((action) => (
                        <li key={action.id} className="text-xs">
                          <span>
                            {time(action.at)} · {action.name} ·{' '}
                            {action.failed === null
                              ? 'No result recorded'
                              : action.failed
                                ? 'Failed'
                                : 'Completed'}
                          </span>
                          {action.detail && (
                            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                              {action.detail}
                            </pre>
                          )}
                        </li>
                      ))}
                    </ol>
                    {run.actions.length === 0 && (
                      <p className="mt-1 text-xs text-muted">No tool actions recorded.</p>
                    )}
                  </div>
                ))}
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer">Recorded result</summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </details>
              </details>
            </li>
          )
        })}
      </ol>
    </details>
  )
}
