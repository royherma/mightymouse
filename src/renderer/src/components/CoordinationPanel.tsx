import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Pencil, RefreshCw, X } from 'lucide-react'
import { COORDINATION, type CoordinationSnapshot } from '../../../shared/coordination'
import type { AgentRelaySessionInfo } from '../../../shared/types'
import {
  buildRoster,
  quietLabel,
  type RosterAgent,
  type RosterProject
} from '../../../shared/coordination-roster'
import { CONFIG } from '../../../shared/config'
import type { FactoryBlocker, FactorySnapshot } from '../../../shared/factory'
import { Button } from './Button'
import { CoordinationAttention } from './CoordinationAttention'

const QUIET_PHRASES = {
  working: 'working',
  idle: 'waiting for their next turn',
  gone: 'with no recent check-in'
} as const

const needsYou = (a: RosterAgent): boolean => a.state === 'blocked' || a.state === 'waiting'

function countLine(agents: RosterAgent[]): string {
  return (['working', 'idle', 'gone'] as const)
    .map((state) => [agents.filter((a) => a.state === state).length, QUIET_PHRASES[state]] as const)
    .filter(([n]) => n > 0)
    .map(([n, phrase]) => `${n} ${phrase}`)
    .join(' · ')
}

function ProjectHead({
  project,
  busy,
  onRename,
  onArchive
}: {
  project: RosterProject
  busy: boolean
  onRename: (id: string, name: string) => void
  onArchive: (id: string, archived: boolean) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null)
    return (
      <div className="coord-project-head">
        <input
          className="coord-project-input"
          aria-label="Project name"
          value={draft}
          autoFocus
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              onRename(project.id, draft.trim())
              setDraft(null)
            }
            if (e.key === 'Escape') setDraft(null)
          }}
        />
        <Button
          variant="bare"
          className="code-deck-btn"
          aria-label="Save project name"
          disabled={busy || !draft.trim()}
          onClick={() => {
            onRename(project.id, draft.trim())
            setDraft(null)
          }}
        >
          <Check size={13} />
        </Button>
        <Button
          variant="bare"
          className="code-deck-btn"
          aria-label="Keep the current name"
          onClick={() => setDraft(null)}
        >
          <X size={13} />
        </Button>
      </div>
    )
  return (
    <div className="coord-project-head">
      <h3 className="coord-project-name">{project.name}</h3>
      <span className="coord-project-count">
        {project.agents.length} {project.agents.length === 1 ? 'agent' : 'agents'}
      </span>
      <Button
        variant="bare"
        className="code-deck-btn coord-project-edit"
        aria-label={`Rename ${project.name}`}
        disabled={busy}
        onClick={() => setDraft(project.name)}
      >
        <Pencil size={13} />
      </Button>
      <Button
        variant="bare"
        className="code-session-filter"
        disabled={busy}
        onClick={() => onArchive(project.id, !project.archived)}
      >
        {project.archived ? 'Bring back' : 'Put away'}
      </Button>
    </div>
  )
}

export function CoordinationPanel({
  sessions,
  onOpenSession,
  onOpenFactory
}: {
  sessions: AgentRelaySessionInfo[]
  /** The agent's work rides along with the label: the roster is polled in here,
   *  and hoisting it just to read two arrays would move the polling too. */
  onOpenSession: (label: string, shared: Pick<RosterAgent, 'work' | 'messages'>) => void
  onOpenFactory?: (taskId: string) => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot | null>(null)
  const [blockers, setBlockers] = useState<FactoryBlocker[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [project, setProject] = useState('')
  const [showCold, setShowCold] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [setup, setSetup] = useState<string[]>([])
  const [checking, setChecking] = useState<'checking' | 'failed' | 'done'>('done')

  const loadFactory = useCallback(async (): Promise<void> => {
    try {
      const snap = await (
        window.api as { factoryGet: () => Promise<FactorySnapshot> }
      ).factoryGet()
      setBlockers(snap.blockers)
    } catch {
      setBlockers([])
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await window.api.coordinationGet())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Work history could not be loaded.')
    }
    await loadFactory()
    setNow(Date.now())
  }, [loadFactory])

  useEffect(() => {
    let active = true
    let running = false
    const poll = async (): Promise<void> => {
      if (running || document.hidden) return
      running = true
      try {
        const data = await window.api.coordinationGet()
        if (active) {
          setSnapshot(data)
          setError('')
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Work history could not be loaded.')
      } finally {
        if (active) await loadFactory()
        running = false
        if (active) setNow(Date.now())
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), COORDINATION.pollMs)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [loadFactory])

  const roster = useMemo(
    () =>
      snapshot
        ? buildRoster(snapshot, showCold)
        : { projects: [], hidden: 0, projectNames: [], orphanWork: [], orphanMessages: [] },
    [snapshot, showCold]
  )

  const run = async (action: () => Promise<CoordinationSnapshot>): Promise<void> => {
    setBusy(true)
    try {
      setSnapshot(await action())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change could not be saved.')
    } finally {
      setNow(Date.now())
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    try {
      setSetup(await window.api.coordinationSetup())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your agents could not be connected.')
    } finally {
      setBusy(false)
    }
  }

  const shown = project ? roster.projects.filter((p) => p.id === project) : roster.projects
  const totalAgents = shown.reduce((n, p) => n + p.agents.length, 0)
  const wanting = shown.flatMap((p) =>
    p.agents.filter(needsYou).map((agent) => ({ agent, projectName: p.name }))
  )
  const summary = [
    wanting.length > 0 ? `${wanting.length} waiting on you` : '',
    countLine(shown.flatMap((p) => p.agents.filter((a) => !needsYou(a))))
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="coord-panel p-4 text-on-surface" aria-label="Shared work">
      <div className="coord-top">
        <h2 className="text-base font-semibold">Your agents right now</h2>
        <div className="coord-actions">
          {snapshot && (
            <>
              {snapshot.enabled && (
                <Button
                  variant="bare"
                  className="code-session-filter"
                  disabled={busy}
                  onClick={() => void connect()}
                >
                  Connect my agents
                </Button>
              )}
              <Button
                variant="bare"
                className="code-session-filter"
                data-on={snapshot.enabled ? undefined : ''}
                disabled={busy}
                onClick={() => void run(() => window.api.coordinationSetEnabled(!snapshot.enabled))}
              >
                {busy
                  ? 'Updating...'
                  : snapshot.enabled
                    ? 'Pause shared work'
                    : 'Turn on shared work'}
              </Button>
            </>
          )}
          <span className="coord-checking" aria-live="polite">
            {checking === 'checking'
              ? CONFIG.UI_LABELS.CODE_ATTENTION_CHECKING
              : checking === 'failed'
                ? CONFIG.UI_LABELS.CODE_ATTENTION_UNCHECKED
                : ''}
          </span>
          <Button
            variant="bare"
            className="code-deck-btn"
            aria-label="Refresh shared work"
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      </div>

      <p className="coord-summary">
        {summary || 'Who is working, who is stuck, and what they are holding.'}
      </p>

      {error && (
        <p role="alert" className="code-refusal mb-3">
          {error}
          {snapshot ? ' Showing the last loaded state.' : ''}
        </p>
      )}

      {!snapshot ? (
        <p className="code-loading" aria-live="polite">
          Loading your agents...
        </p>
      ) : (
        <>
          {(roster.projectNames.length > 1 || roster.hidden > 0) && (
            <div className="coord-toolbar" role="group" aria-label="Filter your agents">
              {roster.projectNames.length > 1 &&
                [['', 'All'] as [string, string], ...roster.projectNames].map(([id, name]) => {
                  const inside = roster.projects.find((p) => p.id === id)
                  return (
                    <Button
                      variant="bare"
                      key={id}
                      className="code-session-filter coord-chip"
                      data-on={project === id ? '' : undefined}
                      aria-pressed={project === id}
                      onClick={() => setProject(id)}
                    >
                      {name}
                      {inside && <span className="coord-chip-count">{inside.agents.length}</span>}
                      {inside && inside.wanting > 0 && <span className="coord-chip-dot" aria-hidden="true" />}
                    </Button>
                  )
                })}
              {roster.hidden > 0 && (
                <Button
                  variant="bare"
                  className="code-session-filter"
                  data-on={showCold ? '' : undefined}
                  aria-pressed={showCold}
                  onClick={() => setShowCold((v) => !v)}
                >
                  {showCold ? 'Hide' : 'Show'} {roster.hidden}{' '}
                  {roster.hidden === 1 ? 'agent' : 'agents'} with no recent check-in
                </Button>
              )}
            </div>
          )}

          {setup.length > 0 && (
            <div role="status" className="text-sm mb-4 space-y-1">
              {setup.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}

          {totalAgents === 0 && (
            <div className="py-5">
              <p className="font-medium">
                {!snapshot.enabled
                  ? 'Shared work is paused'
                  : roster.hidden > 0
                    ? 'Nobody has checked in lately'
                    : 'Bring your agents into the same conversation'}
              </p>
              <p className="text-sm text-muted mt-1">
                {!snapshot.enabled
                  ? 'Your work history is kept. Turn it on and your agents show up here.'
                  : roster.hidden > 0
                    ? 'Your past work is kept. Start a conversation in one of your projects and it shows up here.'
                    : 'Connect your agents, then start a new conversation in your project. Existing conversations keep running.'}
              </p>
            </div>
          )}

          {shown.length === 1 && project && (
            <div data-archived={shown[0].archived ? '' : undefined}>
              <ProjectHead
                project={shown[0]}
                busy={busy}
                onRename={(id, name) => void run(() => window.api.coordinationRenameProject(id, name))}
                onArchive={(id, archived) =>
                  void run(() => window.api.coordinationArchiveProject(id, archived))
                }
              />
            </div>
          )}

          {blockers.length > 0 && (
            <div className="mb-4 space-y-2">
              <h3 className="text-sm font-semibold">Factory needs you</h3>
              {blockers.map((blocker) => (
                <Button
                  key={blocker.taskId}
                  variant="ghost"
                  className="w-full whitespace-normal text-left h-auto"
                  onClick={() => onOpenFactory?.(blocker.taskId)}
                >
                  {blocker.projectName} · {blocker.title} · {blocker.question} · {blocker.nextAction}
                </Button>
              ))}
            </div>
          )}

          {(totalAgents > 0 || roster.orphanWork.length + roster.orphanMessages.length > 0) && (
            <CoordinationAttention
              roster={roster}
              project={project}
              now={now}
              sessions={sessions}
              onOpenSession={onOpenSession}
              onChecking={setChecking}
            />
          )}

          <p className="text-xs text-muted mt-3">
            Checked {quietLabel(Math.max(0, now - snapshot.generatedAt))} ago.{' '}
            {snapshot.enabled
              ? "A new handoff waits for the agent's next turn."
              : 'Paused. Your work history is kept.'}
          </p>
        </>
      )}
    </section>
  )
}
