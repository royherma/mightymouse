import { useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import {
  factoryAgentName,
  FACTORY_ROLE_AGENT,
  type FactoryAttempt,
  type FactoryTask,
  type FactoryTranscriptEntry
} from '../../../shared/factory'
import { FilesSection, FolderActions, RailSection, ChecklistStep, workingOn } from './agent-context-rail'
import { Button } from './Button'
import { exactUptime, shortWhen, startedAt } from './session-facts'
import './AgentScreen.css'

const SCREEN_LINES = 14
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Read = { id: string; status: 'loading' | 'failed' | 'ready'; entries: FactoryTranscriptEntry[] }

function useRunTranscript(attempt: FactoryAttempt | undefined, talks: boolean): Read {
  const id = attempt?.id ?? ''
  const live = attempt?.state === 'started'
  const [read, setRead] = useState<Read>({ id, status: 'loading', entries: [] })
  useEffect(() => {
    if (!id || !talks) return
    let alive = true
    const load = (): void => {
      void window.api.factoryTranscript(id).then(
        (next) => alive && setRead({ id, status: 'ready', entries: next.entries }),
        () =>
          alive &&
          setRead((prev) =>
            prev.id === id && prev.status === 'ready' ? prev : { id, status: 'failed', entries: [] }
          )
      )
    }
    load()
    if (!live) return () => void (alive = false)
    const timer = window.setInterval(load, 2_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [id, live, talks])
  return read.id === id ? read : { id, status: 'loading', entries: [] }
}

function screenLines(entries: FactoryTranscriptEntry[]): string[] {
  const lines: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'text') lines.push(...entry.text.split('\n').filter((line) => line.trim()))
    else if (entry.kind === 'tool') lines.push(`● ${entry.name} ${entry.input.split('\n')[0]}`.trim())
    else if (entry.kind === 'tool_end' && entry.failed) lines.push('  ⎿ failed')
    else if (entry.kind === 'done') lines.push(entry.exitCode === 0 ? '✓ Finished' : `✗ Stopped (exit ${entry.exitCode})`)
  }
  return lines.slice(-SCREEN_LINES)
}

function lastSaid(entries: FactoryTranscriptEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === 'text' && entry.text.trim()) return entry.text
  }
  return undefined
}

export function FactoryAgentRail(props: {
  task: FactoryTask
  attempt?: FactoryAttempt
  attempts: FactoryAttempt[]
  talks: boolean
  steps: { text: string; done: boolean }[]
  now: number
  onWatch?: () => void
}): React.JSX.Element {
  const { task, attempt, talks, now } = props
  const [open, setOpen] = useState({ goal: false, files: true })
  const run = useRunTranscript(attempt, talks)
  const started = attempt && attempt.startedAt > 0 ? attempt : undefined
  const live = started?.state === 'started'
  const lastAction = started?.audit?.at(-1)?.actions.at(-1)
  const lines = screenLines(run.entries)
  const repliedAt = run.entries.findLast((entry) => entry.kind !== 'prompt')?.at
  const models = started?.audit?.flatMap((item) => item.models) ?? []
  const files = [
    ...new Set(
      props.attempts.flatMap((item) =>
        (item.audit ?? []).flatMap((audit) =>
          audit.actions.filter((action) => EDITS.has(action.name) && action.detail).map((action) => action.detail)
        )
      )
    )
  ]
  const nowDoing =
    live && lastAction && !lastAction.finishedAt
      ? `${lastAction.name} ${lastAction.detail}`.trim()
      : workingOn(undefined, lastSaid(run.entries) ?? task.activity)
  const screenNote = !started
    ? 'Nothing on screen yet. It starts when a slot frees up.'
    : !talks
      ? 'This step runs checks, not an agent. Results are under Details.'
      : run.status === 'loading'
        ? 'Loading…'
        : run.status === 'failed'
          ? "Couldn't read what it's doing. Its folder is below."
          : lines.length === 0
            ? live
              ? 'Starting up…'
              : 'Nothing was recorded for this run.'
            : ''
  const missing = !started
    ? 'Not started'
    : !talks
      ? 'Not an agent step'
      : run.status === 'loading'
        ? 'Loading…'
        : run.status === 'failed'
          ? 'Unavailable'
          : 'Not yet'
  const done = props.steps.filter((step) => step.done).length

  return (
    <aside className="agent-rail factory-agent-rail">
      {live ? (
        <>
          <Button
            variant="bare"
            className="agent-screen factory-screen"
            onClick={props.onWatch}
            disabled={!props.onWatch}
            title={props.onWatch ? 'Watch live' : undefined}
          >
            {screenNote ? (
              <span className="factory-screen-note">{screenNote}</span>
            ) : (
              <pre>{lines.join('\n')}</pre>
            )}
          </Button>
          <div className="agent-rail-tldr">
            <span className="agent-rail-tldr-label">
              {FACTORY_ROLE_AGENT[started.role]} is working on
            </span>
            <p className="agent-rail-tldr-value">{nowDoing}</p>
          </div>
        </>
      ) : (
        props.onWatch && (
          <Button variant="bare" className="factory-rail-read" onClick={props.onWatch}>
            <ScrollText size={13} /> Read what it did
          </Button>
        )
      )}

      <p className="factory-rail-facts">
        {started ? (
          <>
            <span>{factoryAgentName(models)}</span>
            <span title={startedAt(started.startedAt)}>
              {live ? 'running ' : 'ran '}
              {exactUptime(started.startedAt, live ? now : started.finishedAt || now)}
            </span>
            {started.generation > 1 && <span>try {started.generation}</span>}
            <span title={repliedAt ? startedAt(repliedAt) : undefined}>
              replied {repliedAt ? shortWhen(repliedAt, now) : missing.toLowerCase()}
            </span>
          </>
        ) : (
          <span>Waiting for its turn</span>
        )}
      </p>

      {task.worktree ? (
        <div className="session-detail-actions">
          <FolderActions cwd={task.worktree} />
        </div>
      ) : (
        <p className="session-detail-empty">Its working folder is made when building starts.</p>
      )}

      <RailSection
        title="Goal"
        open={open.goal}
        onToggle={() => setOpen((prev) => ({ ...prev, goal: !prev.goal }))}
        badge={props.steps.length ? `${done}/${props.steps.length}` : undefined}
      >
        {task.outcome && <p className="agent-rail-goal">{task.outcome}</p>}
        {props.steps.map((step, i) => (
          <ChecklistStep
            key={`${i}-${step.text}`}
            item={{ label: step.text, status: step.done ? 'completed' : 'pending' }}
          />
        ))}
      </RailSection>

      {files.length > 0 && (
        <FilesSection
          files={files}
          open={open.files}
          onToggle={() => setOpen((prev) => ({ ...prev, files: !prev.files }))}
        />
      )}
    </aside>
  )
}
