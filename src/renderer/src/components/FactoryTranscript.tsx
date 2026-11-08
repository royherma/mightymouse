import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronLeft, FolderOpen, Loader2, Wrench } from 'lucide-react'
import {
  factoryAgentName,
  FACTORY_ROLE_AGENT,
  type FactoryAttempt,
  type FactoryTranscript as Transcript,
  type FactoryTranscriptEntry
} from '../../../shared/factory'
import { Button } from './Button'

type ToolEntry = Extract<FactoryTranscriptEntry, { kind: 'tool' }>
type ToolEnd = Extract<FactoryTranscriptEntry, { kind: 'tool_end' }>

const stamp = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })

function summary(entry: ToolEntry): string {
  try {
    const input = JSON.parse(entry.input) as Record<string, unknown>
    const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url
    if (typeof pick === 'string') return pick
  } catch {
    return entry.input.split('\n')[0]
  }
  return entry.input.split('\n')[0]
}

export function FactoryTranscript({
  attempts,
  initialId,
  onClose
}: {
  attempts: FactoryAttempt[]
  initialId: string
  onClose: () => void
}): React.JSX.Element {
  const [id, setId] = useState(initialId)
  const [data, setData] = useState<Transcript | null>(null)
  const [error, setError] = useState('')
  const list = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  const attempt = attempts.find((item) => item.id === id)
  const live = attempt?.state === 'started'
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .factoryTranscript(id)
        .then((next) => alive && (setData(next), setError('')))
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'This run could not be read.')
        )
    }
    load()
    if (!live) return () => void (alive = false)
    const timer = window.setInterval(load, 2_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [id, live])
  useLayoutEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [data])
  const ends = new Map<string, ToolEnd>()
  for (const entry of data?.entries ?? []) if (entry.kind === 'tool_end') ends.set(entry.id, entry)
  const models = attempt?.audit?.flatMap((run) => run.models) ?? []
  return (
    <section className="factory-transcript" aria-label="Agent transcript">
      <header className="factory-transcript-head">
        <Button variant="bare" className="factory-transcript-back" onClick={onClose}>
          <ChevronLeft size={15} /> Task
        </Button>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {attempt ? FACTORY_ROLE_AGENT[attempt.role] : 'Run'} · {factoryAgentName(models)}
          </p>
          <p className="text-xs text-muted">
            {attempt?.startedAt ? `Started ${stamp(attempt.startedAt)}` : 'Not started'}
            {live && <span className="factory-live-dot">Live</span>}
          </p>
        </div>
        {data?.file && (
          <Button
            variant="ghost"
            className="inline-flex items-center gap-1.5"
            title={data.file}
            onClick={() => void window.api.factoryTranscript(id, true)}
          >
            <FolderOpen size={14} /> Show file
          </Button>
        )}
      </header>
      {attempts.length > 1 && (
        <div className="factory-transcript-runs" role="tablist" aria-label="Runs">
          {attempts.map((item, index) => (
            <Button
              key={item.id}
              variant="bare"
              role="tab"
              aria-selected={item.id === id}
              className="factory-transcript-run"
              onClick={() => setId(item.id)}
            >
              {index + 1}. {FACTORY_ROLE_AGENT[item.role]}
            </Button>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red">{error}</p>}
      <ol
        ref={list}
        className="factory-transcript-list"
        onScroll={(event) => {
          const el = event.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {data && data.entries.length === 0 && (
          <li className="text-sm text-muted">
            {live
              ? 'Waiting for the agent to say something…'
              : 'No transcript was saved for this run.'}
          </li>
        )}
        {data?.entries.map((entry, index) => {
          if (entry.kind === 'tool_end') return null
          if (entry.kind === 'prompt')
            return (
              <li key={index} className="factory-say" data-kind="prompt">
                <details>
                  <summary>What it was asked</summary>
                  <pre>{entry.text}</pre>
                </details>
              </li>
            )
          if (entry.kind === 'done')
            return (
              <li key={index} className="factory-say" data-kind="done">
                {entry.exitCode === 0 ? (
                  <CheckCircle2 size={14} className="text-green" />
                ) : (
                  <AlertCircle size={14} className="text-red" />
                )}
                {entry.exitCode === 0 ? 'Finished' : `Stopped (exit ${entry.exitCode})`}
                <time>{stamp(entry.at)}</time>
              </li>
            )
          if (entry.kind === 'tool') {
            const end = ends.get(entry.id)
            return (
              <li
                key={index}
                className="factory-say"
                data-kind="tool"
                data-failed={end?.failed || undefined}
              >
                <details>
                  <summary>
                    {end?.failed ? (
                      <AlertCircle size={13} className="text-red" />
                    ) : !end && live ? (
                      <Loader2 size={13} className="factory-spin" />
                    ) : (
                      <Wrench size={13} />
                    )}
                    <span className="font-medium">{entry.name}</span>
                    <span className="factory-say-target">{summary(entry)}</span>
                    <time>{stamp(entry.at)}</time>
                  </summary>
                  <pre>{entry.input}</pre>
                  {end && <pre data-output>{end.output || '(no output)'}</pre>}
                </details>
              </li>
            )
          }
          return (
            <li key={index} className="factory-say" data-kind={entry.kind}>
              <p>{entry.text}</p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
