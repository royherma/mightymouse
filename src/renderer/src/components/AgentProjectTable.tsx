import type { JSX, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from 'lucide-react'
import { TalkButton } from './TalkButton'
import { Button } from './Button'
import { CONFIG } from '../../../shared/config'
import type { AgentRelaySessionInfo } from '../../../shared/types'
import { lastEventAt, type SessionEntry } from '../../../shared/relay-sessions'
import type { SessionRow } from '../../../shared/relay-status'
import {
  AgentWorkingMark,
  respondingWithoutNumber,
  sessionHasAlert,
  type AgentGroup
} from './AgentProjectList'
import { ProjectAvatar } from './ProjectIcon'
import { matchesSession, recapLine, sessionHaystack } from '../../../shared/relay-status'
import { startedAt, shortWhen } from './session-facts'
import { PriorityToolbar } from './SessionPriority'
import type { SessionPriorityState } from '../hooks/useSessionPriority'
import {
  PRIORITY_COPY,
  priorityKey,
  priorityWeight,
  type SessionPriorityRow
} from '../../../shared/session-priority'

const L = CONFIG.UI_LABELS

type SortKey = 'priority' | 'name' | 'project' | 'status' | 'agent' | 'branch' | 'started' | 'active'
type StatusFilter = 'all' | 'needs-you' | 'responding' | 'idle'

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'priority', label: L.CODE_AGENTS_TABLE_COL_PRIORITY },
  { key: 'name', label: L.CODE_AGENTS_TABLE_COL_SESSION },
  { key: 'project', label: L.CODE_AGENTS_TABLE_COL_PROJECT },
  { key: 'status', label: L.CODE_AGENTS_TABLE_COL_STATUS },
  { key: 'agent', label: L.CODE_AGENTS_TABLE_COL_AGENT },
  { key: 'branch', label: L.CODE_AGENTS_TABLE_COL_BRANCH },
  { key: 'started', label: L.CODE_AGENTS_TABLE_COL_STARTED },
  { key: 'active', label: L.CODE_AGENTS_TABLE_COL_ACTIVE }
]

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: L.CODE_AGENTS_TABLE_ALL },
  { key: 'needs-you', label: L.CODE_AGENTS_ONLY_ALERTS },
  { key: 'responding', label: L.CODE_AGENTS_TABLE_RESPONDING },
  { key: 'idle', label: L.CODE_AGENTS_TABLE_IDLE }
]

const HEALTH_RANK: Record<SessionRow['health'], number> = {
  waiting: 0,
  'your-turn': 1,
  working: 2,
  connected: 3,
  ended: 4
}

function agentName(entry: SessionEntry): string {
  const row = entry.row
  return row.name ?? row.agent ?? row.repo ?? row.tldr ?? ''
}

function agentLabel(entry: SessionEntry): string {
  return [entry.row.agent, entry.row.model].filter(Boolean).join(' · ')
}

const activeAt = lastEventAt

function statusOf(entry: SessionEntry): Exclude<StatusFilter, 'all'> {
  if (sessionHasAlert(entry)) return 'needs-you'
  if (entry.row.health === 'working') return 'responding'
  return 'idle'
}

function shortStarted(since: number | undefined, now: number): string {
  if (!since) return ''
  const at = new Date(since)
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (at.toDateString() === new Date(now).toDateString()) return time
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

type Row = { entry: SessionEntry; group: AgentGroup }

type ColumnWidths = Partial<Record<SortKey, number>>

const WIDTHS_KEY = 'agent-project-table-widths'
const MIN_COL_WIDTH = 60
const MIN_SESSION_WIDTH = 160

function readWidths(): ColumnWidths {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}') as ColumnWidths
  } catch {
    return {}
  }
}

function saveWidths(widths: ColumnWidths): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
  } catch {
    return
  }
}

function compare(a: Row, b: Row, key: SortKey): number {
  if (key === 'project') return a.group.name.localeCompare(b.group.name)
  if (key === 'priority') return comparePriority(a.entry.priority, b.entry.priority)
  return compareEntries(a.entry, b.entry, key)
}

function comparePriority(a?: SessionPriorityRow, b?: SessionPriorityRow): number {
  return priorityWeight(a) - priorityWeight(b) || (a?.heat ?? -1) - (b?.heat ?? -1)
}

function compareEntries(
  a: SessionEntry,
  b: SessionEntry,
  key: Exclude<SortKey, 'project' | 'priority'>
): number {
  switch (key) {
    case 'name':
      return agentName(a).localeCompare(agentName(b))
    case 'status':
      return HEALTH_RANK[a.row.health] - HEALTH_RANK[b.row.health]
    case 'agent':
      return agentLabel(a).localeCompare(agentLabel(b))
    case 'branch':
      return (a.row.branch ?? '').localeCompare(b.row.branch ?? '')
    case 'started':
      return (a.session.since ?? 0) - (b.session.since ?? 0)
    case 'active':
      return activeAt(a) - activeAt(b)
  }
}

type ProjectHome = {
  name: string
  onOpen: (ref: string) => void
  onStartNew: (text: string) => Promise<void>
}

const sessionRef = (s: AgentRelaySessionInfo): string => s.sessionId ?? s.stated ?? s.label

function ProjectHomeAsk({ home, entries }: { home: ProjectHome; entries: SessionEntry[] }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const send = async (): Promise<void> => {
    const said = text.trim()
    if (!said || busy) return
    setBusy(true)
    setProblem('')
    const open = entries.filter((e) => e.row.health !== 'ended' && !e.session.stale)
    const ref = await window.api.codeRouteTask(
      said,
      open.map((e) => ({
        ref: sessionRef(e.session),
        title: e.session.tldr || e.session.stated || agentName(e),
        recap: recapLine(e.row)
      }))
    )
    try {
      if (ref && (await window.api.agentRelaySessionReply(ref, said)).ok) home.onOpen(ref)
      else await home.onStartNew(said)
      setText('')
    } catch {
      setProblem(L.CODE_PROJECT_HOME_FAILED)
    }
    setBusy(false)
  }

  return (
    <div className="agent-project-home-ask" data-busy={busy ? '' : undefined}>
      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        disabled={busy}
        placeholder={busy ? L.CODE_PROJECT_HOME_ROUTING : L.CODE_PROJECT_HOME_PLACEHOLDER.replace('{name}', home.name)}
        aria-label={L.CODE_PROJECT_HOME_PLACEHOLDER.replace('{name}', home.name)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {problem && <span className="agent-project-home-problem" role="alert">{problem}</span>}
      <TalkButton inputRef={inputRef} />
      <Button
        variant="bare"
        className="agent-project-home-send"
        onClick={() => void send()}
        disabled={busy || !text.trim()}
        aria-label={L.CODE_PROJECT_HOME_SEND}
      >
        <ArrowUp size={14} strokeWidth={2.5} />
      </Button>
    </div>
  )
}

export function AgentProjectTable({
  groups,
  title,
  now,
  priority,
  onSettings,
  onPick,
  onBack,
  home
}: {
  groups: AgentGroup[]
  title: string
  now: number
  priority: SessionPriorityState
  onSettings: () => void
  onPick: (session: AgentRelaySessionInfo) => void
  onBack: () => void
  home?: ProjectHome
}): JSX.Element {
  const [pickedSort, setSortKey] = useState<SortKey>('active')
  const [sortDesc, setSortDesc] = useState(true)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [grouped, setGrouped] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [widths, setWidths] = useState<ColumnWidths>(readWidths)
  const [resizing, setResizing] = useState<SortKey | null>(null)

  const ranked = priority.result !== null
  const sortKey = pickedSort === 'priority' && !ranked ? 'active' : pickedSort
  const multi = groups.length > 1
  const byProject = multi && grouped
  const columns = COLUMNS.filter(
    (c) => (c.key !== 'project' || (multi && !byProject)) && (c.key !== 'priority' || ranked)
  )
  const all = useMemo(
    () =>
      groups.flatMap((group) =>
        group.entries
          .filter((entry) => entry.row.health !== 'ended')
          .map((entry) => ({
            entry: { ...entry, priority: priority.rows.get(priorityKey(entry.session)) },
            group
          }))
      ),
    [groups, priority.rows]
  )

  const places = useMemo(() => {
    const scored = all
      .filter(({ entry }) => entry.priority?.heat != null)
      .sort((a, b) => comparePriority(b.entry.priority, a.entry.priority) || activeAt(b.entry) - activeAt(a.entry))
    return new Map(scored.map(({ entry }, index) => [entry.session, index + 1]))
  }, [all])

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: all.length,
      'needs-you': 0,
      responding: 0,
      idle: 0
    }
    for (const { entry } of all) c[statusOf(entry)] += 1
    return c
  }, [all])

  const rows = useMemo(() => {
    const filtered = all.filter(
      ({ entry }) =>
        (status === 'all' || statusOf(entry) === status) &&
        (!query.trim() || matchesSession(sessionHaystack(entry.session, entry.row), query))
    )
    const dir = sortDesc ? -1 : 1
    return filtered.sort(
      (a, b) => dir * compare(a, b, sortKey) || activeAt(b.entry) - activeAt(a.entry)
    )
  }, [all, status, query, sortKey, sortDesc])

  const sections = useMemo(() => {
    if (!byProject) return [{ group: null, rows }]
    return groups
      .map((group) => ({ group, rows: rows.filter((r) => r.group.id === group.id) }))
      .filter((section) => section.rows.length > 0)
  }, [byProject, groups, rows])

  const sortBy = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDesc(!sortDesc)
      return
    }
    setSortKey(key)
    setSortDesc(key === 'started' || key === 'active' || key === 'priority')
  }

  const startResize = (left: SortKey, right: SortKey, down: ReactPointerEvent<HTMLElement>): void => {
    down.preventDefault()
    const grip = down.currentTarget
    grip.setPointerCapture(down.pointerId)
    const th = grip.parentElement
    const leftStart = th?.previousElementSibling?.getBoundingClientRect().width ?? 0
    const rightStart = th?.getBoundingClientRect().width ?? 0
    const leftMin = left === 'name' ? MIN_SESSION_WIDTH : MIN_COL_WIDTH
    const rightMin = right === 'name' ? MIN_SESSION_WIDTH : MIN_COL_WIDTH
    let latest = widths
    setResizing(right)
    const move = (ev: PointerEvent): void => {
      const dx = Math.max(
        leftMin - leftStart,
        Math.min(rightStart - rightMin, ev.clientX - down.clientX)
      )
      latest = { ...latest }
      if (left !== 'name') latest[left] = Math.round(leftStart + dx)
      if (right !== 'name') latest[right] = Math.round(rightStart - dx)
      setWidths(latest)
    }
    const up = (): void => {
      setResizing(null)
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      saveWidths(latest)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }

  const resetWidths = (...keys: SortKey[]): void => {
    const next = { ...widths }
    for (const key of keys) delete next[key]
    setWidths(next)
    saveWidths(next)
  }

  const rank = (): void => {
    setSortKey('priority')
    setSortDesc(true)
    setGrouped(false)
    void priority.rank()
  }

  const renderRow = ({ entry, group }: Row): JSX.Element => {
    const session = entry.session
    const name = agentName(entry)
    const recap = recapLine(entry.row)
    const responding = respondingWithoutNumber(session, entry.row.health)
    const lastAt = activeAt(entry)
    const open = (): void => onPick(session)
    const onKey = (event: KeyboardEvent<HTMLTableRowElement>): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      open()
    }
    return (
      <tr
        key={session.sessionId ?? `${session.label}:${session.pid ?? ''}:${session.since ?? ''}`}
        className="agent-project-row"
        data-alert={sessionHasAlert(entry) || undefined}
        tabIndex={0}
        aria-label={responding ? `${name}, Responding…` : name}
        onClick={open}
        onKeyDown={onKey}
      >
        {ranked && <PriorityCell row={entry.priority} place={places.get(session)} of={places.size} />}
        <td className="agent-project-main">
          <span className="agent-project-name">{name}</span>
          {recap && <span className="agent-project-doing">{recap}</span>}
        </td>
        {multi && !byProject && (
          <td className="agent-project-cell">
            <span className="agent-project-state-inner">
              <ProjectAvatar icon={group.icon} imagePath={group.imagePath} size={14} />
              {group.name}
            </span>
          </td>
        )}
        <td className="agent-project-cell">
          <span className="agent-project-state-inner">
            {sessionHasAlert(entry) && <span className="agent-projects-dot" />}
            {entry.row.health === 'working' ? (
              <AgentWorkingMark session={session} health={entry.row.health} />
            ) : (
              entry.row.state_text
            )}
          </span>
        </td>
        <td className="agent-project-cell">{agentLabel(entry)}</td>
        <td className="agent-project-cell">{entry.row.branch ?? ''}</td>
        <td className="agent-project-cell" title={startedAt(session.since)}>
          {shortStarted(session.since, now)}
        </td>
        <td className="agent-project-cell">{lastAt ? shortWhen(lastAt, now) : ''}</td>
      </tr>
    )
  }

  return (
    <div className="agent-project-table-pane">
      <div className="agent-project-table-bar">
        <Button variant="bare" className="code-detail-back" onClick={onBack}>
          <ChevronLeft size={13} strokeWidth={2.5} />
          Agents
        </Button>
        <h2 className="agent-project-table-title">
          {title}
          <span className="agent-project-table-chip-count">{all.length}</span>
        </h2>
        <label className="agent-project-table-search">
          <Search size={12} className="shrink-0" />
          <input
            type="search"
            value={query}
            placeholder={L.CODE_AGENTS_TABLE_FILTER}
            aria-label={L.CODE_AGENTS_SEARCH}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
        </label>
      </div>
      {home && <ProjectHomeAsk home={home} entries={groups[0]?.entries ?? []} />}
      <div className="agent-project-table-subbar">
        <div className="agent-project-table-filters" role="group">
          {STATUS_FILTERS.map((f) =>
            f.key !== 'all' && counts[f.key] === 0 ? null : (
              <Button
                key={f.key}
                variant="bare"
                className="agent-project-table-chip"
                aria-pressed={status === f.key}
                onClick={() => setStatus(f.key)}
              >
                {f.label}
                <span className="agent-project-table-chip-count">{counts[f.key]}</span>
              </Button>
            )
          )}
        </div>
        <PriorityToolbar priority={priority} onRank={rank} onSettings={onSettings} />
        <div className="agent-project-table-filters">
          {multi && (
            <Button
              variant="bare"
              className="agent-project-table-chip"
              aria-pressed={grouped}
              onClick={() => setGrouped(!grouped)}
            >
              {L.CODE_AGENTS_TABLE_GROUP}
            </Button>
          )}
        </div>
      </div>
      {all.length === 0 ? (
        <div className="agent-project-table-empty">No agents in this project.</div>
      ) : (
        <div className="agent-project-table-scroll">
          <table className="agent-project-table">
            <thead>
              <tr>
                {columns.map((col, i) => {
                  const active = col.key === sortKey
                  const prev = columns[i - 1]?.key
                  return (
                    <th
                      key={col.key}
                      className={`agent-project-col-${col.key}`}
                      style={widths[col.key] ? { width: widths[col.key] } : undefined}
                      aria-sort={active ? (sortDesc ? 'descending' : 'ascending') : 'none'}
                    >
                      {prev && (
                        <span
                          className="agent-project-col-grip"
                          data-dragging={resizing === col.key ? '' : undefined}
                          onPointerDown={(e) => startResize(prev, col.key, e)}
                          onDoubleClick={() => resetWidths(prev, col.key)}
                          title="Drag to resize · double-click to reset"
                          role="separator"
                          aria-orientation="vertical"
                        />
                      )}
                      <Button
                        variant="bare"
                        className="agent-project-sort"
                        onClick={() => sortBy(col.key)}
                      >
                        {col.label}
                        {active &&
                          (sortDesc ? (
                            <ChevronDown size={11} strokeWidth={2.5} />
                          ) : (
                            <ChevronUp size={11} strokeWidth={2.5} />
                          ))}
                      </Button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            {rows.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={columns.length} className="agent-project-table-empty">
                    {L.CODE_AGENTS_TABLE_NO_MATCH}
                  </td>
                </tr>
              </tbody>
            ) : (
              sections.map(({ group, rows: sectionRows }) => {
                const shut = group ? collapsed[group.id] === true : false
                const alerts = sectionRows.filter((r) => sessionHasAlert(r.entry)).length
                return (
                  <tbody key={group?.id ?? 'all'}>
                    {group && (
                      <tr className="agent-project-group-row">
                        <td colSpan={columns.length}>
                          <Button
                            variant="bare"
                            className="agent-project-group-head"
                            aria-expanded={!shut}
                            onClick={() => setCollapsed((prev) => ({ ...prev, [group.id]: !shut }))}
                          >
                            {shut ? (
                              <ChevronRight size={13} strokeWidth={2.5} />
                            ) : (
                              <ChevronDown size={13} strokeWidth={2.5} />
                            )}
                            <ProjectAvatar icon={group.icon} imagePath={group.imagePath} size={16} />
                            <span className="agent-project-group-name">{group.name}</span>
                            <span className="agent-project-table-chip-count">{sectionRows.length}</span>
                            {alerts > 0 && <span className="agent-project-group-alerts">{alerts}</span>}
                          </Button>
                        </td>
                      </tr>
                    )}
                    {!shut && sectionRows.map(renderRow)}
                  </tbody>
                )
              })
            )}
          </table>
        </div>
      )}
    </div>
  )
}

function PriorityCell({
  row,
  place,
  of
}: {
  row?: SessionPriorityRow
  place?: number
  of: number
}): JSX.Element {
  const label = row?.level == null ? PRIORITY_COPY.unknown : PRIORITY_COPY.labels[row.level]
  const title = [
    place && PRIORITY_COPY.rankOf.replace('{rank}', String(place)).replace('{of}', String(of)),
    row?.reason,
    row?.stale && PRIORITY_COPY.heatStale
  ]
  return (
    <td className="agent-project-cell" title={title.filter(Boolean).join('\n')}>
      <span className="agent-project-state-inner">
        {place != null && row?.heat != null && (
          <span
            className="session-priority-heat"
            data-stale={row.stale || undefined}
            style={{ '--heat': `${row.heat}%` } as React.CSSProperties}
          >
            #{place}
          </span>
        )}
        {row?.heat != null && <b className="agent-project-heat">{row.heat}</b>}
        {label}
      </span>
    </td>
  )
}
