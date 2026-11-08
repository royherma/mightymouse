import type { SessionPriorityState } from '../hooks/useSessionPriority'
import { useRef, useState, type ReactNode } from 'react'
import { ArrowDownWideNarrow, RefreshCw } from 'lucide-react'
import type { AgentRelaySessionInfo, AgentTranscriptTurn } from '../../../shared/types'
import {
  PRIORITY_COPY,
  priorityKey,
  suggestedReply,
  type SessionPriorityRow
} from '../../../shared/session-priority'
import { sessionCanReply, sessionRow } from '../../../shared/relay-status'
import { Button } from './Button'
import './SessionPriority.css'

export function PriorityToolbar({
  priority,
  onRank,
  onSettings
}: {
  priority: SessionPriorityState
  onRank: () => void
  onSettings: () => void
}): React.JSX.Element {
  const failed = priority.failed || priority.result?.status === 'unavailable'
  const openWork = priority.roster?.orphanWork.filter((work) => work.state === 'working' || work.state === 'blocked') ?? []
  const openMessages = priority.roster?.orphanMessages.filter((message) => message.state === 'pending') ?? []
  return (
    <>
      <div className="session-priority-inline" data-busy={priority.busy || undefined}>
        <Button
          variant="bare"
          className="session-priority-rank"
          data-changed={(priority.changed && !priority.busy) || undefined}
          disabled={priority.busy}
          onClick={onRank}
          title={[PRIORITY_COPY.intro, ...PRIORITY_COPY.rules].join('\n')}
        >
          {priority.result ? <RefreshCw size={13} /> : <ArrowDownWideNarrow size={13} />}
          {priority.result ? PRIORITY_COPY.refresh : PRIORITY_COPY.button}
        </Button>
        {(priority.busy || failed || priority.result) && (
          <span role="status" aria-live="polite" className="session-priority-status">
            {priority.busy
              ? PRIORITY_COPY.checking
              : failed
                ? PRIORITY_COPY.failed
                : `${PRIORITY_COPY.rankedAt} ${new Date(priority.result!.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${priority.old ? PRIORITY_COPY.old : PRIORITY_COPY.scale}`}
          </span>
        )}
        {priority.result && (
          <Button variant="bare" className="session-priority-back" onClick={priority.clear}>
            {PRIORITY_COPY.byStatus}
          </Button>
        )}
      </div>
      {openWork.length + openMessages.length > 0 && (
        <details className="session-priority-unassigned">
          <summary>
            {PRIORITY_COPY.unassigned.replace('{n}', String(openWork.length + openMessages.length))}{' '}
            <u>{PRIORITY_COPY.checkThem}</u>
          </summary>
          <ul>
            {openWork.map((work) => (
              <li key={work.id} data-blocked={work.state === 'blocked' || undefined}>
                <span>{work.title}</span>
                <em>{PRIORITY_COPY.workStates[work.state as 'working' | 'blocked']}</em>
              </li>
            ))}
            {openMessages.map((message) => (
              <li key={message.id}>
                <span>{message.subject}</span>
                <em>{PRIORITY_COPY.workStates.pending}</em>
              </li>
            ))}
          </ul>
          <Button variant="bare" onClick={onSettings}>
            {PRIORITY_COPY.openWork}
          </Button>
        </details>
      )}
    </>
  )
}

export function ArchiveSuggestions({
  sessions,
  priority,
  onArchive
}: {
  sessions: readonly AgentRelaySessionInfo[]
  priority: SessionPriorityState
  onArchive: (sessions: readonly AgentRelaySessionInfo[], archived: boolean) => void
}): React.JSX.Element | null {
  const [undo, setUndo] = useState<readonly AgentRelaySessionInfo[]>([])
  const done = sessions.filter((session) => {
    if (session.stale) return true
    const row = priority.result ? priority.rows.get(priorityKey(session)) : undefined
    return row?.level === 0 && !row.stale
  })
  if (undo.length > 0)
    return (
      <div className="session-priority-unassigned session-priority-tidy-done" role="status">
        <span>{PRIORITY_COPY.tidyDone.replace('{n}', String(undo.length))}</span>
        <Button variant="bare" onClick={() => { onArchive(undo, false); setUndo([]) }}>
          {PRIORITY_COPY.tidyUndo}
        </Button>
      </div>
    )
  if (done.length === 0) return null
  const now = Date.now()
  return (
    <details className="session-priority-unassigned">
      <summary>
        {PRIORITY_COPY.tidy}
        <b>{done.length}</b>
      </summary>
      <ul>
        {done.map((session) => (
          <li key={priorityKey(session)}>
            <span>{sessionRow(session, now).name ?? session.label}</span>
            <em>{session.stale ? PRIORITY_COPY.tidyEnded : PRIORITY_COPY.tidyFinished}</em>
          </li>
        ))}
      </ul>
      <Button variant="bare" onClick={() => { onArchive(done, true); setUndo(done) }}>
        {PRIORITY_COPY.tidyAll.replace('{n}', String(done.length))}
      </Button>
    </details>
  )
}

export function SuggestedReplyActions({
  session,
  turns,
  onEdit
}: {
  session: AgentRelaySessionInfo
  turns: AgentTranscriptTurn[]
  onEdit: (text: string) => void
}): React.JSX.Element | null {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const sending = useRef(false)
  const suggestion = suggestedReply(turns)
  if (
    !session.sessionId ||
    !suggestion ||
    session.stale ||
    session.busySince ||
    (session.waiting ?? 0) > 0 ||
    !sessionCanReply(session)
  )
    return null
  const send = async (): Promise<void> => {
    if (sending.current || state !== 'idle') return
    sending.current = true
    setState('sending')
    try {
      const result = await window.api.agentRelaySessionReply(
        session.sessionId || session.label,
        suggestion.text,
        undefined,
        suggestion.evidence
      )
      setState(result.ok ? 'sent' : 'failed')
    } catch {
      setState('failed')
    } finally {
      sending.current = false
    }
  }
  return (
    <div className="session-priority-suggestion">
      <strong>{PRIORITY_COPY.waiting}</strong>
      <span>{PRIORITY_COPY.evidence}</span>
      <blockquote>{suggestion.scope}</blockquote>
      <div className="session-priority-actions">
        <Button disabled={state !== 'idle'} onClick={() => void send()}>
          {state === 'sending'
            ? PRIORITY_COPY.sending
            : state === 'sent'
              ? PRIORITY_COPY.sent
              : PRIORITY_COPY.send}
        </Button>
        <Button
          variant="ghost"
          disabled={state === 'sending' || state === 'sent'}
          onClick={() => onEdit(suggestion.text)}
        >
          {PRIORITY_COPY.edit}
        </Button>
      </div>
      {state === 'failed' && <span role="alert">{PRIORITY_COPY.sendFailed}</span>}
    </div>
  )
}

export function PrioritySession({
  row,
  onArchive,
  children
}: {
  row?: SessionPriorityRow
  onArchive: () => void
  children: ReactNode
}): React.JSX.Element {
  if (row?.level !== 0) return <>{children}</>
  return (
    <div className="session-priority-item">
      {children}
      <Button variant="ghost" className="session-priority-archive" onClick={onArchive}>
        {PRIORITY_COPY.archive}
      </Button>
    </div>
  )
}
