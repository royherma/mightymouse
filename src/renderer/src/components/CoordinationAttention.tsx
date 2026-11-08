import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import {
  holdingLine,
  messageFields,
  messageLine,
  workFields,
  workLine,
  type CoordField
} from '../../../shared/coordination-lines'
import './CoordRows.css'
import { quietLabel, type Roster, type RosterAgent } from '../../../shared/coordination-roster'
import {
  buildAttentionRows,
  groupAttentionRows,
  type AttentionGroup,
  type AttentionRow
} from '../../../shared/coordination-attention'
import { sessionRow } from '../../../shared/relay-status'
import type { AgentRelaySessionInfo } from '../../../shared/types'
import { AgentMark } from './AgentMark'
import { Button } from './Button'

const ROWS_PER_BOX = 6

const LABELS = CONFIG.UI_LABELS

/** A note whose reader is no longer running, so it sits beside the agents that
 *  need nothing rather than in a group of its own. */
interface Unread {
  id: string
  title: string
  meta: string
  fields: CoordField[]
  holding: string | null
  open: boolean
}

function Box<T>({
  title,
  hint,
  tone,
  items,
  empty,
  keyOf,
  render
}: {
  title: string
  hint: string
  tone: AttentionGroup
  items: T[]
  empty: string
  keyOf: (item: T) => string
  render: (item: T) => React.JSX.Element
}): React.JSX.Element {
  const [page, setPage] = useState(0)
  const last = Math.max(0, Math.ceil(items.length / ROWS_PER_BOX) - 1)
  const at = Math.min(page, last)
  const start = at * ROWS_PER_BOX
  return (
    <section className="coord-box" data-tone={tone} aria-label={title}>
      <header className="coord-box-head" title={hint}>
        <h3 className="coord-box-title">{title}</h3>
        <span className="coord-box-count">{items.length}</span>
        {last > 0 && (
          <span className="coord-box-pager" role="group" aria-label={`Pages of ${title}`}>
            <Button
              variant="bare"
              className="code-deck-btn"
              aria-label="Previous page"
              disabled={at === 0}
              onClick={() => setPage(at - 1)}
            >
              <ChevronLeft size={13} />
            </Button>
            <span aria-live="polite">
              {at + 1}/{last + 1}
            </span>
            <Button
              variant="bare"
              className="code-deck-btn"
              aria-label="Next page"
              disabled={at === last}
              onClick={() => setPage(at + 1)}
            >
              <ChevronRight size={13} />
            </Button>
          </span>
        )}
      </header>
      {items.length === 0 ? (
        <p className="coord-box-empty">{empty}</p>
      ) : (
        <ul className="coord-rows">
          {items.slice(start, start + ROWS_PER_BOX).map((item) => (
            <li key={keyOf(item)}>{render(item)}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AgentLine({
  row,
  now,
  projectName,
  onOpenSession
}: {
  row: AttentionRow
  now: number
  projectName?: string
  onOpenSession?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { agent, relay } = row
  const identity = relay ? sessionRow(relay, now) : undefined
  const name = identity?.name ?? relay?.tldr ?? agent.session.label
  const checkout = identity ? [identity.repo, identity.branch].filter(Boolean).join('/') : ''
  const place = checkout && checkout !== name ? checkout : (projectName ?? '')
  const sub = row.reason && row.reason !== name ? row.reason : place
  const stateLine = row.reason && row.reason !== name ? `${name} - ${row.reason}` : name
  return (
    <div className="coord-row" data-open={open ? '' : undefined}>
      <Button
        variant="bare"
        className="coord-row-main"
        title={stateLine}
        aria-expanded={onOpenSession ? undefined : open}
        onClick={() => (onOpenSession ? onOpenSession() : setOpen((v) => !v))}
      >
        <span className="coord-row-mark">
          <AgentMark vendor={agent.session.harness} size={13} />
        </span>
        <span className="coord-row-text">
          <span className="coord-row-top">
            <span className="coord-row-name">{name}</span>
            <span className="coord-row-time">{quietLabel(agent.quietFor)}</span>
          </span>
          <span className="coord-row-sub">{sub}</span>
        </span>
        {onOpenSession && (
          <ChevronRight className="coord-row-go" size={13} strokeWidth={2.5} aria-hidden="true" />
        )}
      </Button>
      {open && (
        <p className="coord-row-more">
          {agent.session.cwd}
          <br />
          {LABELS.CODE_ATTENTION_NOT_CONNECTED}
        </p>
      )}
    </div>
  )
}

function FieldValue({ text, clamp }: { text: string; clamp: boolean }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !clamp || open) {
      setOverflows(false)
      return
    }
    const hadClamp = el.classList.contains('is-clamped')
    el.classList.remove('is-clamped')
    const full = el.scrollHeight
    const line = parseFloat(getComputedStyle(el).lineHeight)
    const tooTall = line > 0 && full > line * 3 + 1
    if (hadClamp && tooTall) el.classList.add('is-clamped')
    setOverflows(tooTall)
  }, [text, clamp, open])

  const clamped = clamp && !open && overflows
  return (
    <div className="coord-field-value">
      <span ref={ref} className={clamped ? 'coord-field-text is-clamped' : 'coord-field-text'}>
        {text}
      </span>
      {clamped && (
        <Button variant="bare" className="coord-field-more" onClick={() => setOpen(true)}>
          More
        </Button>
      )}
    </div>
  )
}

function FieldRow({ field, clamp }: { field: CoordField; clamp: boolean }): React.JSX.Element {
  return (
    <div className="coord-field">
      <FieldValue text={field.text} clamp={clamp} />
    </div>
  )
}

function UnreadLine({ item }: { item: Unread }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const stateLine = item.meta && item.meta !== item.title ? `${item.title} - ${item.meta}` : item.title
  return (
    <div className="coord-row" data-open={open ? '' : undefined}>
      <Button
        variant="bare"
        className="coord-row-main"
        title={stateLine}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="coord-row-text">
          <span className="coord-row-top">
            <span className="coord-row-name">{item.title}</span>
          </span>
          <span className="coord-row-sub">{item.meta}</span>
        </span>
      </Button>
      {open && item.fields.length > 0 && (
        <div className="coord-fields">
          {item.fields.map((field, i) => (
            <FieldRow key={field.text} field={field} clamp={i === 0} />
          ))}
        </div>
      )}
    </div>
  )
}

export function CoordinationAttention({
  roster,
  project,
  now,
  sessions,
  onOpenSession,
  onChecking
}: {
  roster: Roster
  project: string
  now: number
  sessions: AgentRelaySessionInfo[]
  onOpenSession: (label: string, shared: Pick<RosterAgent, 'work' | 'messages'>) => void
  onChecking: (state: 'checking' | 'failed' | 'done') => void
}): React.JSX.Element {
  const [scored, setScored] = useState<AttentionRow[] | null>(null)
  const hovering = useRef(false)
  const pending = useRef<AttentionRow[] | null>(null)

  const relayById = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions])
  const agents = useMemo(() => roster.projects.flatMap((p) => p.agents), [roster])
  const byRules = useMemo(
    () =>
      buildAttentionRows(
        agents.map((agent) => ({ agent, relay: relayById.get(agent.session.session) })),
        new Map()
      ),
    [agents, relayById]
  )

  useEffect(() => {
    let active = true
    onChecking('checking')
    window.api
      .coordinationAttention(sessions)
      .then((rows) => {
        if (!active) return
        if (hovering.current) pending.current = rows
        else setScored(rows)
        onChecking('done')
      })
      .catch(() => {
        if (active) onChecking('failed')
      })
    return () => {
      active = false
    }
  }, [agents.length, sessions, onChecking])

  const releaseHover = (): void => {
    hovering.current = false
    if (pending.current) {
      setScored(pending.current)
      pending.current = null
    }
  }

  const rows = useMemo(() => {
    const known = new Map((scored ?? []).map((r) => [r.agent.session.id, r]))
    return byRules
      .map((r) => {
        const hit = known.get(r.agent.session.id)
        return hit ? { ...r, group: hit.group, level: hit.level, scored: hit.scored } : r
      })
      .filter((r) => !project || r.agent.session.project === project)
  }, [byRules, scored, project])
  const groups = groupAttentionRows(rows)

  const unread: Unread[] = [
    ...roster.orphanWork
      .filter((w) => !project || w.project === project)
      .map((w) => ({
        id: w.project + w.id,
        title: w.title,
        meta: workLine(w),
        fields: workFields(w),
        holding: holdingLine(w.state),
        open: w.state !== 'complete'
      })),
    ...roster.orphanMessages
      .filter((m) => !project || m.project === project)
      .map((m) => ({
        id: m.id,
        title: m.subject,
        meta: messageLine(m.state, m.offeredAt),
        fields: messageFields(m),
        holding: null,
        open: m.state === 'pending'
      }))
  ].sort((a, b) => Number(b.open) - Number(a.open))

  const names = new Map(roster.projectNames)
  const line = (row: AttentionRow): React.JSX.Element => {
    const live = relayById.get(row.agent.session.session)
    return (
      <AgentLine
        row={row}
        now={now}
        projectName={names.get(row.agent.session.project)}
        onOpenSession={
          live &&
          (() => onOpenSession(live.label, { work: row.agent.work, messages: row.agent.messages }))
        }
      />
    )
  }
  const agentKey = (row: AttentionRow): string => row.agent.session.id
  const waiting: (AttentionRow | Unread)[] = [...groups.wait, ...unread]

  return (
    <div
      className="coord-board"
      onMouseEnter={() => (hovering.current = true)}
      onMouseLeave={releaseHover}
    >
      <Box
        title={LABELS.CODE_ATTENTION_TALK}
        hint={LABELS.CODE_ATTENTION_TALK_HINT}
        tone="talk"
        items={groups.talk}
        empty={LABELS.CODE_ATTENTION_TALK_EMPTY}
        keyOf={agentKey}
        render={line}
      />
      <Box
        title={LABELS.CODE_ATTENTION_WAIT}
        hint={LABELS.CODE_ATTENTION_WAIT_HINT}
        tone="wait"
        items={waiting}
        empty={LABELS.CODE_ATTENTION_WAIT_EMPTY}
        keyOf={(item) => ('agent' in item ? agentKey(item) : item.id)}
        render={(item) => ('agent' in item ? line(item) : <UnreadLine item={item} />)}
      />
      <Box
        title={LABELS.CODE_ATTENTION_WRAP}
        hint={LABELS.CODE_ATTENTION_WRAP_HINT}
        tone="wrap"
        items={groups.wrap}
        empty={LABELS.CODE_ATTENTION_WRAP_EMPTY}
        keyOf={agentKey}
        render={line}
      />
    </div>
  )
}
