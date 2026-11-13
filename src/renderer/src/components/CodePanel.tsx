import { OPEN_CODE_EVENT } from '../../../shared/canvas'
import { ArchiveSuggestions, PriorityToolbar, PrioritySession } from './SessionPriority'
import { useSessionPriority } from '../hooks/useSessionPriority'
import { PRIORITY_COPY, priorityKey } from '../../../shared/session-priority'
import { Button } from './Button'
import type { ReasoningEffort } from '../../../shared/model-sources'
import { SegmentedControl, type SegmentItem } from './SegmentedControl'
import './SessionTable.css'
import { PulseCell } from './session-pulse'
import { usePulseFresh } from './session-pulse-mac'
import type { PulseRow } from '../../../shared/session-pulse'
import { Tooltip, useTooltip } from './Tooltip'
import { createPortal } from 'react-dom'
import { SidebarRow } from '../mighty/MightySidebar'
import { useSessionArchive } from '../hooks/useSessionArchive'
import { useIsAdmin } from '../hooks/useIsAdmin'
/**
 * The Mac's Code surface. Deliberately NOT a port of
 * CodeSheet.tsx: every decision with a right answer comes from
 * `@shared/relay-cards`, and nothing about how it looks is shared.
 */

import { EMPTY_TRAIL, claimStepKey, trailBack, trailForward, trailMove, type AgentsTrail } from './agents-trail'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Folder,
  GitBranch,
  Layers,
  LayoutGrid,
  Columns3,
  KeyRound,
  Server,
  BarChart3,
  Rows3,
  Search,
  Smartphone,
  SquarePen,
  Terminal,
  X
} from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { AgentMark } from './AgentMark'
import { RelayCard, SenderChip, type SenderProject } from './relay-card'
import { AgentFace } from '../../../shared/agent-face-view'
import { ProgressMeter, MAC_METER_CLASSES } from '../../../shared/progress-ring'
import { sessionFaceId, AGENT_FACE_SIZE } from '../../../shared/agent-face'
import { CodeDetail } from './code-detail'
import { ProjectSettingsModal } from '../mighty/MightySessionNavigation'
import { CreateProjectModal } from '../mighty/CreateProjectModal'
import { CoordinationPanel } from './CoordinationPanel'
import { FactoryPanel } from './FactoryPanel'
import type { RosterAgent } from '../../../shared/coordination-roster'
import { SessionDetail } from './session-detail'
import { startedSession } from './starting-agent'
import {
  groupBySender,
  senderMatchKey,
  sessionActivity,
  formatDuration,
  refusalMessage,
  previousList,
  sortRequests,
  filterRequests,
  filteredEmptyNote,
  sortLabel,
  filterLabel,
  RELAY_SORTS,
  RELAY_FILTERS,
  UNKNOWN_SENDER
} from '../../../shared/relay-cards'
import type {
  RelayRefusal,
  RelaySort,
  RelayFilter,
  SessionActivity
} from '../../../shared/relay-cards'
import {
  readSort,
  readFilter,
  writeSort,
  writeFilter,
  readSessionGroup,
  writeSessionGroup,
  readSessionSort,
  writeSessionSort,
  readSessionDensity,
  writeSessionDensity,
  readBoardCompact,
  writeBoardCompact,
  readCollapsedGroups,
  writeCollapsedGroups,
  readSessionProject,
  writeSessionProject
} from '../../../shared/relay-view-prefs'
import {
  groupSessions,
  boardColumns,
  rankColumns,
  sessionEntry,
  SESSION_GROUPS,
  SESSION_SORTS,
  SESSION_GROUP_LABELS,
  SESSION_SORT_LABELS,
  SESSION_LIST_THRESHOLD,
  passesFilters,
  lastEventAt
} from '../../../shared/relay-sessions'
import type {
  SessionGroup,
  SessionSort,
  SessionFilter,
  SessionDensity,
  SessionEntry
} from '../../../shared/relay-sessions'
import { pruneDrafts } from '../../../shared/relay-drafts'
import type { RelayRequestWire, RelayResponseWire } from '../../../shared/phone-remote-protocol'
import type {
  AgentModelChoice,
  AgentRelaySessionInfo,
  AgentRelayStatus,
  CodeTab,
  McpClientState,
  MightyProject,
  StartedAgent
} from '../../../shared/types'
import { ALL_SESSIONS_TABLE, AgentProjectList, groupByProject, type AgentGroup } from './AgentProjectList'
import { mightyProjectForCwd } from '../../../shared/relay-sessions'
import { AgentDraftPane, type AgentDraft } from './AgentDraftPane'
import { ProjectScopePicker } from './ProjectScopePicker'
import { AgentProjectTable } from './AgentProjectTable'
import { PreviousList } from './PreviousList'
import { KeysPanel } from './KeysPanel'
import { InfraPanel } from './InfraPanel'
import { ReportsPanel } from './ReportsPanel'
import { BuiltPanel } from './BuiltPanel'
import {
  relayStatusLine,
  sessionRow,
  isGeneratedTag,
  sessionHaystack,
  matchesSession,
  withSeenIdle,
  recapLine,
  relativeAge
} from '../../../shared/relay-status'

const ADMIN_CODE_TABS: readonly CodeTab[] = ['factory', 'keys']

const L = CONFIG.UI_LABELS

type SessionSegment = SessionFilter | 'all'
const CODE_VIEW_TITLES: Record<CodeTab, string> = {
  agents: 'Code',
  needs: L.CODE_TAB_NEEDS,
  previous: L.CODE_TAB_NEEDS,
  sessions: L.CODE_TAB_SESSIONS,
  work: L.CODE_TAB_SESSIONS,
  factory: L.CODE_TAB_FACTORY,
  keys: L.CODE_TAB_KEYS,
  infra: L.CODE_TAB_INFRA,
  reports: L.CODE_TAB_REPORTS,
  built: L.CODE_TAB_MADE,
  browser: L.CODE_TAB_BROWSER
}

const RESUME_COUNT = 3
const sessionRowKey = (s: AgentRelaySessionInfo): string => s.sessionId ?? senderMatchKey(s.stated ?? s.label)
// Agents re-register ~10s after an app restart; past this a saved session is treated as gone.
const REOPEN_WAIT_MS = 20_000

export function codeViewTitle(tab: CodeTab | undefined): string {
  return CODE_VIEW_TITLES[tab ?? 'agents']
}

function mostRecentGroup(groups: AgentGroup[]): AgentGroup | null {
  let best: AgentGroup | null = null
  let bestAt = -1
  for (const group of groups) {
    if (group.id === 'unassigned' || !draftFor(group)) continue
    const at = Math.max(0, ...group.entries.map(lastEventAt))
    if (at > bestAt) {
      best = group
      bestAt = at
    }
  }
  return best
}

function draftFor(group: AgentGroup): AgentDraft | null {
  const cwd = group.repoFolder ?? group.entries.find((e) => e.session.cwd)?.session.cwd
  if (!cwd) return null
  return {
    groupId: group.id,
    name: group.name,
    cwd,
    projectId: group.id === 'unassigned' ? undefined : group.id,
    icon: group.icon,
    imagePath: group.imagePath
  }
}

export function CodePanel(props: {
  /** Agents tab only, driven by the window title bar's pane toggles. */
  showAgentList?: boolean
  listSlot?: HTMLElement | null
  listHeading?: string
  actionsSlot?: HTMLElement | null
  onOpenCount?: (count: number) => void
  active?: boolean
  showAgentRail?: boolean
  onToggleAgentRail?: () => void
  /** False until `useAgentRelay`'s first status reply lands. Gates the whole
   *  panel on a neutral loading state -- without it, a slow-starting relay
   *  renders the same "nothing needs you" copy as a checked, empty inbox
   *  (DESIGN.md rule 11: gate on loading, never loading && !data). */
  known?: boolean
  pending: RelayRequestWire[]
  resolved: RelayRequestWire[]
  /** Cleared without answering. Rendered alongside `resolved` under Previous,
   *  not on a tab of their own. */
  dismissed?: RelayRequestWire[]
  /** Fire-and-forget: the store decides first-answer-wins across surfaces. A
   *  card that loses that race comes back through `refusal`, not through this. */
  onRespond: (requestId: string, response: RelayResponseWire) => void
  /** Take a clear back, while the agent still has not been told. */
  onUndismiss?: (requestId: string) => void
  /** Set when the store threw the last answer away -- answered on the phone
   *  first, or the agent already gave up waiting. */
  refusal?: RelayRefusal | null
  onClearRefusal?: () => void
  /** 'flyout' is the panel's popover (closes, re-measures); 'tab' is the Mighty
   *  window's Code tab, which owns the full pane and neither closes nor sizes to
   *  its content. Same cards either way — only the chrome differs. */
  variant?: 'flyout' | 'tab'
  /** Drives the status line. Omitted in the flyout, which has no room for it. */
  status?: AgentRelayStatus
  clients?: McpClientState[]
  onClose?: () => void
  /** Panel windows size to their content — every show/hide of a card has to
   *  re-measure or the flyout gets clipped. */
  onContentChange?: () => void
  tabsInSidebar?: boolean
  onTabChange?: (tab: CodeTab) => void
  onShow?: () => void
  /** Which sub-tab to land on. The tray's Shared work row is a second way in,
   *  and without it every route lands on Agents. */
  initialTab?: CodeTab
  onOpenAgent?: (ref: string) => void
  onOpenSix?: (cwd: string, count?: number) => void
  agentsOnScreen?: string[]
  onProjectInView?: (project: MightyProject | undefined) => void
}): React.JSX.Element {
  const {
    known = true,
    showAgentList = true,
    listSlot = null,
    listHeading,
    actionsSlot = null,
    onOpenCount,
    onProjectInView,
    active = true,
    showAgentRail = true,
    pending,
    resolved,
    dismissed,
    onRespond,
    onUndismiss,
    refusal,
    onClearRefusal,
    variant = 'flyout',
    status,
    clients,
    onClose,
    onContentChange,
    tabsInSidebar = false,
    onTabChange,
    onShow,
    initialTab,
    onOpenAgent,
    onOpenSix,
    agentsOnScreen
  } = props
  const [tab, setTab] = useState<CodeTab>(initialTab === 'work' ? 'sessions' : initialTab ?? 'agents')
  const [factoryTaskId, setFactoryTaskId] = useState<string | null>(null)
  const isAdmin = useIsAdmin()
  // A second tray click has to move an ALREADY-OPEN window, so this follows the
  // prop rather than only seeding the first render.
  const [previousInitialTab, setPreviousInitialTab] = useState(initialTab)
  if (previousInitialTab !== initialTab) {
    setPreviousInitialTab(initialTab)
    if (initialTab) setTab(initialTab === 'work' ? 'sessions' : initialTab)
  }
  const previous = previousList(resolved, dismissed ?? [])
  const line = useMemo(() => (status ? relayStatusLine(status, clients ?? []) : null), [status, clients])
  // "Your turn" is unread state, per surface: opening the sheet spends it.
  const [seenIdle, setSeenIdle] = useState<ReadonlyMap<string, number>>(() => new Map())
  const allSessions = useMemo(
    () => (line?.names ?? []).map((s) => withSeenIdle(s, seenIdle.get(s.stated ?? s.label))),
    [line, seenIdle]
  )
  const archive = useSessionArchive(allSessions, status?.sessionMarks, {
    mark: window.api.agentSessionMark,
    importLegacy: window.api.agentSessionImport
  })
  const priority = useSessionPriority(
    allSessions.filter((s) => !archive.isArchived(s)),
    allSessions.filter(archive.isArchived)
  )

  const agentsGridRef = useRef<HTMLDivElement>(null)
  const [listWidth, setListWidth] = useState<number>(CONFIG.MIGHTY.SIDEBAR.DEFAULT_WIDTH)
  const [draggingList, setDraggingList] = useState(false)
  // Off the grid's own left edge, not clientX: this list sits inside a padded pane.
  const startListResize = useCallback((down: ReactMouseEvent) => {
    down.preventDefault()
    const grid = agentsGridRef.current?.getBoundingClientRect()
    const left = grid?.left ?? 0
    const { MIN_WIDTH, MAX_WIDTH } = CONFIG.MIGHTY.SIDEBAR
    const room = (grid?.width ?? window.innerWidth) - CONFIG.MIGHTY.CHAT_MIN_WIDTH - CONFIG.MIGHTY.RAIL.MIN_WIDTH
    const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, room))
    setDraggingList(true)
    const move = (ev: MouseEvent): void => setListWidth(Math.max(MIN_WIDTH, Math.min(max, ev.clientX - left)))
    const up = (): void => {
      setDraggingList(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  const [projects, setProjects] = useState<MightyProject[]>([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const loadProjects = useCallback(() => {
    void window.api.mighty
      .listProjects()
      .then(setProjects)
      // Without the project list every agent still lists, under No project.
      .catch(() => setProjects([]))
      .finally(() => setProjectsLoaded(true))
  }, [])
  useEffect(() => loadProjects(), [loadProjects])
  useEffect(() => window.api.mighty.onProjectsChanged(loadProjects), [loadProjects])
  const [editingProject, setEditingProject] = useState<MightyProject | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [openWhenListed, setOpenWhenListed] = useState<string | null>(null)

  const [sessionQuery, setSessionQuery] = useState('')
  // `now` is 0 on purpose: the haystack is built from the row's identity fields,
  // none of which are the age, so pinning it keeps a search from re-running on
  // every minute tick.
  const [sessionProject, setSessionProject] = useState(readSessionProject)
  const sessionProjects = [...new Set(archive.sessions.map((s) => sessionRow(s, 0).repo?.trim()).filter((r): r is string => !!r))].sort(
    (a, b) => a.localeCompare(b)
  )
  const activeProject = sessionProjects.includes(sessionProject) ? sessionProject : ''
  const changeSessionProject = (next: string): void => {
    setSessionProject(next)
    writeSessionProject(next)
  }
  const inProject = activeProject
    ? archive.sessions.filter((s) => sessionRow(s, 0).repo?.trim() === activeProject)
    : archive.sessions
  const matching = sessionQuery.trim()
    ? inProject.filter((s) => matchesSession(sessionHaystack(s, sessionRow(s, 0)), sessionQuery))
    : inProject

  // A card's `from` is the STATED name when there is one -- the same join main
  // uses to count waiting (ipc/agent-relay.ts). The label is the Mac's display
  // name and matches no card.
  const everything = [...pending, ...previous]
  const activityFor = (s: AgentRelaySessionInfo): SessionActivity =>
    sessionActivity(s.stated ?? s.label, everything)
  // Notify is dropped from Previous, but the board files Still working / All
  // done off those cards, so this list keeps them.
  const boardTraffic = [...pending, ...resolved]

  // How the Sessions pane is organised. Each is its own stored choice: the
  // grouping answers "which of my checkouts", the sort answers "which one
  // first", and neither should move when the other changes.
  const [sessionGroup, setSessionGroup] = useState<SessionGroup>(readSessionGroup)
  const [sessionSort, setSessionSort] = useState<SessionSort>(readSessionSort)
  // Opens on Handed back: that is what you come to the list for. With nothing
  // handed back the chip stays off and the list shows everything.
  const [sessionFilters, setSessionFilters] = useState<SessionFilter[] | null>(null)
  const [density, setDensity] = useState<SessionDensity | null>(readSessionDensity)
  const [boardCompact, setBoardCompact] = useState(readBoardCompact)
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsedGroups)

  // Minute-granular for the same reason the card ticks that slowly: `row.age`
  // is the only thing here that moves with the clock. Held at this level now
  // because the ROW is built here, for grouping, rather than inside each card.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])

  const ranked = sessionSort === 'priority' && priority.result !== null
  const entries: SessionEntry[] = matching.map((s) => ({
    ...sessionEntry(s, activityFor(s), now),
    priority: ranked ? priority.rows.get(priorityKey(s)) : undefined
  }))
  const hasHandedBack = entries.some((e) => passesFilters(e, ['your-turn']))
  const activeFilters: SessionFilter[] =
    archive.showArchived ? [] : (sessionFilters ?? (hasHandedBack ? ['your-turn'] : []))
  // A grid of cards stops being scannable somewhere around a dozen; above that
  // the list is the better default. Board is never the auto pick.
  const effectiveDensity: SessionDensity =
    density ?? (allSessions.length > SESSION_LIST_THRESHOLD ? 'list' : 'grid')
  const onBoard = effectiveDensity === 'board'
  const pulses = usePulseFresh(
    allSessions.flatMap((session) => (session.sessionId ? [session.sessionId] : [])),
    effectiveDensity === 'list'
  )
  const sessionGroupViews = groupSessions(
    entries,
    sessionGroup,
    sessionSort,
    onBoard ? [] : activeFilters
  )
  if (ranked) {
    const rankedEntries = sessionGroupViews.flatMap((group) => group.entries).filter((entry) => entry.priority?.heat != null)
    rankedEntries.forEach((entry, index) => {
      entry.rank = index + 1
      entry.rankOf = rankedEntries.length
    })
  }
  const archiveSession = (session: AgentRelaySessionInfo): void => {
    archive.setArchived(session, !archive.showArchived)
  }
  const boardViews = ranked
    ? rankColumns(entries, sessionGroup, sessionSort)
    : boardColumns(entries, boardTraffic, now, sessionSort, sessionGroup)
  // Flat count of what survived the chips, for the "nothing matches" copy --
  // the groups themselves are already the filtered set. Board ignores chips.
  const shown = onBoard
    ? boardViews.reduce((n, c) => n + c.entries.length, 0)
    : sessionGroupViews.reduce((n, g) => n + g.entries.length, 0)

  const changeGroup = (next: SessionGroup): void => {
    setSessionGroup(next)
    writeSessionGroup(next)
  }
  const changeSessionSort = (next: SessionSort): void => {
    setSessionSort(next)
    writeSessionSort(next)
  }
  const changeDensity = (next: SessionDensity): void => {
    setDensity(next)
    writeSessionDensity(next)
  }
  const toggleBoardCompact = (): void => {
    setBoardCompact((prev) => {
      const next = !prev
      writeBoardCompact(next)
      return next
    })
  }
  const handedBack: SessionEntry[] = archive.showArchived
    ? []
    : archive.sessions
        .map((s) => sessionEntry(s, activityFor(s), now))
        .filter((e) => e.activity.waiting === 0 && passesFilters(e, ['your-turn']))
  const handedBackList =
    handedBack.length > 0 ? (
      <div className="code-group">
        <div className="code-hidden-note">{L.CODE_NEEDS_REPLY}</div>
        {handedBack.map((entry) => (
          <SessionCard
            entry={entry}
            density="list"
            now={now}
            key={priorityKey(entry.session)}
            archived={false}
            onArchive={() => archiveSession(entry.session)}
            onOpen={() => openSession(entry.session.sessionId || entry.session.label)}
          />
        ))}
      </div>
    ) : null
  const segmentCount = (f: SessionFilter): number => entries.filter((e) => passesFilters(e, [f])).length
  const sessionSegments: SegmentItem<SessionSegment>[] = [
    { id: 'waiting', label: L.CODE_SESSIONS_SEG_WAITING, count: segmentCount('waiting') },
    { id: 'your-turn', label: L.CODE_SESSIONS_SEG_HANDED_BACK, count: segmentCount('your-turn') },
    { id: 'working', label: L.CODE_SESSIONS_SEG_WORKING, count: segmentCount('working') },
    { id: 'all', label: L.CODE_SESSIONS_SEG_ALL, count: entries.length }
  ]
  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      writeCollapsedGroups(next)
      return next
    })
  }

  // A request answered on the PHONE never runs this surface's resolve path --
  // it just drops out of `pending` -- so its draft would outlive it. Prune
  // against whatever is still outstanding.
  useEffect(() => {
    pruneDrafts(pending.map((r) => r.id))
  }, [pending])

  const [sort, setSort] = useState(readSort)
  const [filter, setFilter] = useState(readFilter)

  const changeSort = (next: RelaySort): void => {
    setSort(next)
    writeSort(next)
  }
  const changeFilter = (next: RelayFilter): void => {
    setFilter(next)
    writeFilter(next)
  }

  const visible = sortRequests(filterRequests(pending, filter), sort)
  const hiddenNote = filteredEmptyNote(pending.length - visible.length, filter)

  // Sender grouping only survives the priority sort: it is oldest-first within
  // a rank, which is the order groupBySender already produces. Under 'newest'
  // the grouping would silently re-order the list it was handed, so that sort
  // renders one flat list instead.
  const groups = sort === 'priority' ? groupBySender(visible) : null

  // The card open on its own, held by ID rather than by index: the list
  // re-sorts and re-filters under it, and the PHONE can answer any card at any
  // moment (first-answer-wins is server-side), so an index would silently start
  // pointing at a different request. Null means the list.
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailIndex = detailId ? visible.findIndex((r) => r.id === detailId) : -1
  const detailRequest = detailIndex >= 0 ? visible[detailIndex] : null

  // The open session sheet, held by LABEL for the same reason a card is held by
  // id: sessions come and go under the view.
  const [reopenLabel] = useState(() =>
    variant === 'tab' ? new URLSearchParams(window.location.search).get('codeSession') : null
  )
  const [detailLabel, setDetailLabel] = useState<string | null>(reopenLabel)
  const [reopening, setReopening] = useState(reopenLabel !== null)
  const [agentsProjectFocus, setAgentsProjectFocus] = useState<string | undefined>(undefined)
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null)
  const [startFailure, setStartFailure] = useState<{ cwd: string; message: string; reason: string } | null>(null)
  const [awaitingAgent, setAwaitingAgent] = useState<
    (Omit<StartedAgent, 'pane'> & { pane?: string; handedTo?: string }) | null
  >(null)
  const [agentTableId, setAgentTableId] = useState<string | null>(null)
  const [agentFromTable, setAgentFromTable] = useState(false)
  const sheetLabelBeforeTable = useRef<string | null>(null)
  const [agentsTrail, setAgentsTrail] = useState<AgentsTrail>(EMPTY_TRAIL)
  useEffect(() => {
    const next = { label: detailLabel, tableId: agentTableId, fromTable: agentFromTable }
    setAgentsTrail((t) => trailMove(t, next, tab === 'agents'))
  }, [detailLabel, agentTableId, agentFromTable])

  // Set only when the sheet was opened from Shared work. It carries that
  // agent's claims into the sheet, and sends Back to the tab the click came
  // from -- landing on the Sessions grid instead is the "where am I" surprise.
  const [fromWork, setFromWork] = useState<Pick<RosterAgent, 'work' | 'messages'> | null>(null)

  const openAgentPane = (pane: string): void => {
    setTab('agents')
    setAgentTableId(null)
    setAgentDraft(null)
    setFocusPane(pane)
  }

  // Every route into the sheet goes through here, so opening one agent can
  // never inherit the previous agent's claims. Four call sites clearing a
  // second piece of state by hand is a bug waiting for the fifth one.
  const openSession = (
    label: string,
    shared: Pick<RosterAgent, 'work' | 'messages'> | null = null
  ): void => {
    setTab('sessions')
    setDetailLabel(label)
    setFromWork(shared)
  }
  // Matched on either name: a session card opens this by `label`, but a relay
  // card only knows `params.from`, which is the STATED name when an agent set
  // one. Keying on label alone sent every stated-name agent to the dead-agent
  // fallback below, history and all.
  const isDetail = (s: AgentRelaySessionInfo): boolean =>
    s.sessionId === detailLabel || s.label === detailLabel || s.stated === detailLabel
  const lastDetail = useRef<AgentRelaySessionInfo | null>(null)
  const listedDetail = detailLabel ? archive.all.find(isDetail) : undefined
  const last = lastDetail.current && isDetail(lastDetail.current) ? lastDetail.current : null
  const sameProcess =
    !listedDetail && last?.pid !== undefined
      ? archive.all.find((s) => !s.stale && s.pid === last.pid && s.cwd === last.cwd)
      : undefined
  if (sameProcess) setDetailLabel(sameProcess.sessionId ?? sameProcess.label)
  const liveSession = listedDetail ?? sameProcess ?? null
  if (liveSession) lastDetail.current = liveSession
  if (reopening && (liveSession || detailLabel !== reopenLabel)) setReopening(false)
  useEffect(() => {
    if (!reopening) return
    const giveUp = setTimeout(() => {
      setReopening(false)
      setDetailLabel((l) => (l === reopenLabel ? null : l))
    }, REOPEN_WAIT_MS)
    return () => clearTimeout(giveUp)
  }, [reopening, reopenLabel])
  const savedCodeSession = tab === 'agents' && !agentTableId && liveSession ? detailLabel : ''
  useEffect(() => {
    if (variant === 'tab' && !reopening) void window.api.mighty.setLastCodeSession(savedCodeSession ?? '')
  }, [variant, reopening, savedCodeSession])

  // Marked off the RAW session: the displayed one has idleSince stripped the
  // instant it lands in seenIdle, so watching it would never fire. Also catches
  // a fresh ping arriving while the sheet is already open on that session.
  const viewedRawSession = detailLabel
    ? (line?.names ?? []).find((s) => s.sessionId === detailLabel || s.label === detailLabel || s.stated === detailLabel)
    : undefined
  const viewedIdleAt = viewedRawSession?.idleSince
  const viewedIdleKey = viewedRawSession?.stated ?? viewedRawSession?.label
  if (
    viewedIdleKey &&
    viewedIdleAt !== undefined &&
    (seenIdle.get(viewedIdleKey) ?? -1) < viewedIdleAt
  ) {
    setSeenIdle(new Map(seenIdle).set(viewedIdleKey, viewedIdleAt))
  }

  // A session row is reaped ~30s after its agent exits, but that agent's cards
  // live in the relay store for 6h -- so the interesting case, "what did that
  // dead agent ask me", is exactly the one where the lookup above returns null.
  // Falling back to the grid there would dead-end the only route to that
  // history, so a sender we still have cards for gets a sheet synthesized from
  // the cards themselves. It carries a name and nothing else on purpose: pid,
  // folder and branch lived on the reaped row and are genuinely gone, and a
  // table of blanks claims less honestly than no table.
  const detailSession =
    liveSession ??
    (last ? { ...last, stale: true } : null) ??
    (detailLabel &&
    [...pending, ...previous].some(
      (r) => senderMatchKey(r.params.from) === senderMatchKey(detailLabel)
    )
      ? ({ label: detailLabel, stale: true } satisfies AgentRelaySessionInfo)
      : null)
  // The agent being started right now. It has no relay row yet -- the shim has
  // not connected -- so the sheet is built from what the spawn already knows,
  // and `busySince` is what makes it read as thinking rather than idle.
  const startingSession: AgentRelaySessionInfo | null =
    awaitingAgent && !awaitingAgent.handedTo
      ? {
          label: awaitingAgent.project,
          cwd: awaitingAgent.cwd,
          since: awaitingAgent.since,
          busySince: awaitingAgent.since,
          lastActivityAt: now
        }
      : null
  const startInView =
    !!awaitingAgent && (!awaitingAgent.handedTo || awaitingAgent.handedTo === detailLabel)
  const detailKey = senderMatchKey(detailSession?.stated ?? detailSession?.label)

  const activeTab: CodeTab = !isAdmin && ADMIN_CODE_TABS.includes(tab) ? 'needs' : tab
  // Sessions tab has no archive toggle, so it must never open stuck on the archived view.
  useEffect(() => {
    if (activeTab === 'sessions') archive.setShowArchived(false)
  }, [activeTab])
  useEffect(() => onTabChange?.(activeTab), [activeTab, onTabChange])

  const listedSessions =
    startingSession && !archive.showArchived && !startedSession(allSessions, awaitingAgent!)
      ? [startingSession, ...archive.sessions]
      : archive.sessions
  const agentGroups = groupByProject(listedSessions, projects, activityFor, now)
  const projectOf = (from?: string): SenderProject | undefined => {
    if (!from) return undefined
    const key = senderMatchKey(from)
    const group = agentGroups.find((g) =>
      g.id !== 'unassigned' && g.entries.some((e) => senderMatchKey(e.session.stated ?? e.session.label) === key)
    )
    return group ?? projects.find((p) => from === p.name || from.startsWith(`${p.name} ·`))
  }
  const agentTable: AgentGroup | null =
    agentTableId === ALL_SESSIONS_TABLE
      ? {
          id: ALL_SESSIONS_TABLE,
          name: CONFIG.UI_LABELS.CODE_AGENTS_TABLE_ALL_TITLE,
          entries: agentGroups.flatMap((g) => g.entries),
          alerts: 0
        }
      : (agentGroups.find((g) => g.id === agentTableId) ?? null)
  if (agentTableId && !agentTable) {
    setAgentTableId(null)
    setAgentFromTable(false)
  }
  const projectsPick = detailLabel ? detailSession : startingSession
  const projectsKey = projectsPick ? senderMatchKey(projectsPick.stated ?? projectsPick.label) : ''
  const selectedRowKey = projectsPick ? sessionRowKey(projectsPick) : ''
  const activeAgentGroup = projectsPick
    ? (agentGroups.find((g) => g.entries.some((e) => sessionRowKey(e.session) === selectedRowKey)) ?? null)
    : agentsProjectFocus
      ? (agentGroups.find((g) => g.id === agentsProjectFocus) ?? null)
      : null
  const openProjects = projects.filter((p) => !p.archived)
  const agentsScopeProjectId =
    activeAgentGroup?.id === 'unassigned' ? undefined : (activeAgentGroup?.id ?? agentsProjectFocus)
  const projectInView = openProjects.find((p) => p.id === agentsScopeProjectId)
  useEffect(() => onProjectInView?.(projectInView), [projectInView, onProjectInView])
  const focusAgentsProject = useCallback((projectId: string | undefined) => {
    setAgentTableId(null)
    setAgentFromTable(false)
    setAgentsProjectFocus(projectId)
    setDetailLabel(null)
    setAgentDraft(null)
  }, [])
  const clearAgentsHome = useCallback(() => {
    setDetailLabel(null)
    setAgentsProjectFocus(undefined)
    setAgentTableId(null)
    setAgentFromTable(false)
    setAgentDraft(null)
    setAwaitingAgent(null)
  }, [])

  const agentsBack = agentsTrail.back.at(-1)
  const stepAgents = (to: AgentsTrail | null): void => {
    if (!to) return
    setAgentsTrail(to)
    setAgentDraft(null)
    setAwaitingAgent(null)
    setDetailLabel(to.at.label)
    setAgentTableId(to.at.tableId)
    setAgentFromTable(to.at.fromTable)
  }
  const goBackInAgents = (): void => stepAgents(trailBack(agentsTrail))
  const agentsStepKeys = useRef({ trail: agentsTrail, enabled: false, step: stepAgents })
  agentsStepKeys.current = {
    trail: agentsTrail,
    enabled: variant === 'tab' && active && activeTab === 'agents',
    step: stepAgents
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = agentsStepKeys.current
      const key = claimStepKey(e, k.trail, k.enabled)
      if (!key) return
      e.preventDefault()
      k.step(key === 'back' ? trailBack(k.trail) : trailForward(k.trail))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const agentsBackName = !agentsBack
    ? undefined
    : agentsBack.tableId && (!agentsBack.fromTable || !agentsBack.label)
      ? agentsBack.tableId === ALL_SESSIONS_TABLE
        ? CONFIG.UI_LABELS.CODE_AGENTS_TABLE_ALL_TITLE
        : (agentGroups.find((g) => g.id === agentsBack.tableId)?.name ?? CONFIG.UI_LABELS.CODE_AGENTS_TABLE_ALL_TITLE)
      : agentsBack.label
        ? ((s) => s?.tldr || s?.stated || s?.label || agentsBack.label)(
            archive.all.find(
              (s) => s.sessionId === agentsBack.label || s.label === agentsBack.label || s.stated === agentsBack.label
            )
          )
        : CONFIG.UI_LABELS.CODE_AGENTS_BACK_HOME

  const [noProjectCwd, setNoProjectCwd] = useState('')
  useEffect(() => {
    void window.api.codeNoProjectFolder().then(setNoProjectCwd)
  }, [])
  const openNoProject = (): void => {
    focusAgentsProject(undefined)
    setAwaitingAgent(null)
    setAgentDraft({ groupId: 'unassigned', name: CONFIG.UI_LABELS.CODE_NO_PROJECT, cwd: noProjectCwd })
  }
  const prepareNewAgent = useCallback((group: AgentGroup) => {
    const next = draftFor(group)
    if (!next) return
    setAgentTableId(null)
    setAgentFromTable(false)
    setAgentsProjectFocus(next.projectId)
    setDetailLabel(null)
    setAwaitingAgent(null)
    setAgentDraft(next)
  }, [])
  const homePin = useRef<string | null>(null)
  const homeGroup =
    activeAgentGroup && activeAgentGroup.id !== 'unassigned'
      ? activeAgentGroup
      : (agentGroups.find((g) => g.id === homePin.current && draftFor(g)) ?? mostRecentGroup(agentGroups))
  homePin.current = homeGroup?.id ?? null
  const projectHomeDraft =
    !projectsPick && !agentTable && !startInView && !reopening && homeGroup ? draftFor(homeGroup) : null
  const draft = agentDraft ?? projectHomeDraft

  const startAgentIn = (draft: AgentDraft | null) => async (
    message: string,
    paths: string[],
    model: AgentModelChoice | null,
    effort?: ReasoningEffort,
    count = 1,
    plan = false
  ): Promise<void> => {
      if (!draft) return
      const since = Date.now()
      // The thread opens BEFORE the spawn is awaited. Starting an agent is a
      // tmux spawn plus a CLI boot plus the shim connecting back, and waiting
      // on all three left the first message you ever send looking swallowed.
      setAgentDraft(null)
      setStartFailure(null)
      setAwaitingAgent({ cwd: draft.cwd, since, project: draft.name, message, files: paths })
      const result = await window.api.codeStartAgent({
        project: draft.name,
        cwd: draft.cwd,
        inApp: true,
        message,
        paths,
        ...(model ? { harness: model.harness, model: model.model } : {}),
        effort,
        plan
      })
      if (!result.ok) {
        setAwaitingAgent(null)
        setAgentDraft(draft)
        setStartFailure({ cwd: draft.cwd, message, reason: result.reason })
        return
      }
      setAwaitingAgent((prev) => (prev?.since === since ? { ...prev, pane: result.pane } : prev))
      for (let i = 1; i < count; i++) {
        void window.api.codeStartAgent({
          project: draft.name,
          cwd: draft.cwd,
          inApp: true,
          message,
          paths,
          ...(model ? { harness: model.harness, model: model.model } : {}),
          effort,
          plan
        })
      }
    }

  const sendDraftAgent = startAgentIn(draft)
  const homeDraft = agentTable && agentTable.id !== ALL_SESSIONS_TABLE ? draftFor(agentTable) : null

  const retryStart = (): void => {
    if (!awaitingAgent) return
    const { cwd, project, message, files } = awaitingAgent
    const since = Date.now()
    setAwaitingAgent({ cwd, project, message, files, since })
    void window.api
      .codeStartAgent({ project, cwd, inApp: true, message, paths: files })
      .then((result) =>
        setAwaitingAgent((prev) =>
          prev?.since !== since ? prev : result.ok ? { ...prev, pane: result.pane } : null
        )
      )
  }

  useEffect(() => {
    const take = (): void => {
      void window.api.codeTakeStartedAgent().then((started) => {
        if (!started) return
        setTab('agents')
        setAgentTableId(null)
        setAgentDraft(null)
        setDetailLabel(null)
        if ('newIn' in started) setNewSessionIn({ projectId: started.newIn })
        else if ('ref' in started) setDetailLabel(started.ref)
        else if (started.message === '') setFocusPane(started.pane)
        else setAwaitingAgent(started)
      })
    }
    take()
    return window.api.onMightyFocusCode(take)
  }, [])

  const [focusPane, setFocusPane] = useState<string | null>(null)
  useEffect(() => {
    const pick = focusPane ? allSessions.find((s) => !s.stale && s.origin?.tmuxPane === focusPane) : undefined
    if (!pick) return
    setDetailLabel(pick.sessionId ?? pick.stated ?? pick.label)
    setFocusPane(null)
  }, [allSessions, focusPane])

  const startThreadKeys = useRef(new Map<string, string>())
  useEffect(() => {
    if (!awaitingAgent || awaitingAgent.handedTo) return
    const pick = startedSession(allSessions, awaitingAgent)
    if (!pick) return
    const ref = pick.sessionId ?? pick.stated ?? pick.label
    startThreadKeys.current.set(ref, `start-${awaitingAgent.since}`)
    setDetailLabel(ref)
    setAwaitingAgent((prev) => (prev ? { ...prev, handedTo: ref } : null))
  }, [allSessions, awaitingAgent])

  // Main and the transcript both hold the opening message by now; this copy only bridges the gap.
  useEffect(() => {
    if (!awaitingAgent?.handedTo) return
    const drop = setTimeout(() => setAwaitingAgent(null), 15_000)
    return () => clearTimeout(drop)
  }, [awaitingAgent?.handedTo])
  const openingFor = (session: AgentRelaySessionInfo): { text: string; files: string[] } | undefined =>
    awaitingAgent &&
    (!awaitingAgent.handedTo ||
      [session.sessionId, session.stated, session.label].includes(awaitingAgent.handedTo))
      ? { text: awaitingAgent.message, files: awaitingAgent.files }
      : undefined
  const projectsHistory = [...pending, ...previous]
    .filter((r) => projectsKey !== '' && senderMatchKey(r.params.from) === projectsKey)
    .sort((a, b) => b.createdAt - a.createdAt)

  // The card was answered elsewhere, cleared, or filtered away while it was
  // open. Fall back to the list rather than an empty pane -- the answer already
  // landed, so this is a normal exit, not an error.
  if (detailId && detailIndex < 0) setDetailId(null)

  // Leaving the tab closes the detail view, so coming back never lands
  // mid-stack on a card the user has since dealt with somewhere else.
  if (detailId && activeTab !== 'needs') setDetailId(null)

  // Panel windows size to their content, so every show/hide has to re-measure
  // or the flyout gets clipped. `detailId` is in the list because opening,
  // paging, and closing the detail view each swap one card for another of a
  // different height.
  useEffect(() => {
    onContentChange?.()
    // `collapsed` and `effectiveDensity` are in the list because expanding a group
    // or switching to the list changes the pane's height, and a flyout that does
    // not re-measure on that gets clipped.
  }, [
    tab,
    pending.length,
    previous.length,
    shown,
    collapsed,
    effectiveDensity,
    detailId,
    onContentChange
  ])

  // No wraparound: hitting the end of a queue of blocked agents should feel
  // like an end, not loop silently back to the card you just answered.
  const pageDetail = (delta: 1 | -1): void => {
    const next = detailIndex + delta
    if (next < 0 || next >= visible.length) return
    setDetailId(visible[next].id)
  }

  // The keydown handler is bound ONCE (empty deps) and reads everything it
  // needs through refs -- `visible` is rebuilt on every relay snapshot, so a
  // handler re-bound every render was doing real work (add + remove a window
  // listener) on every keystroke, poll tick, and card update.
  const visibleRef = useRef(visible)
  const detailRequestRef = useRef(detailRequest)
  const detailIndexRef = useRef(detailIndex)
  const onCloseRef = useRef(onClose)
  const activeRef = useRef(active)
  useLayoutEffect(() => {
    activeRef.current = active
    visibleRef.current = visible
    detailRequestRef.current = detailRequest
    detailIndexRef.current = detailIndex
    onCloseRef.current = onClose
  })

  // Escape closes the DETAIL first and the panel only once the list is back --
  // one press should undo one thing. The arrow keys page, but never while a
  // draft field has focus, where they are the caret's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!activeRef.current) return
      if (e.key === 'Escape') {
        if (detailRequestRef.current) {
          e.stopPropagation()
          setDetailId(null)
          return
        }
        onCloseRef.current?.()
        return
      }
      if (!detailRequestRef.current) return
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const delta = e.key === 'ArrowRight' ? 1 : -1
        const next = detailIndexRef.current + delta
        if (next < 0 || next >= visibleRef.current.length) return
        setDetailId(visibleRef.current[next].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Which sender the user just clicked in the session list. Held in state, not
  // as a scroll side-effect, because the highlight has to survive the re-render
  // that switching to the "Needs you" tab causes.
  const [focused, setFocused] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // A card's expand lands on its SESSION, question included, not on a bigger
  // copy of the same card.
  // A sender-less card has no session to land on, so it opens as itself.
  const openCard = (request: RelayRequestWire): void => {
    if (!request.params.from) {
      setDetailId(request.id)
      return
    }
    openSession(request.params.from)
  }

  // Scroll after the tab switch has painted, or the target is still unmounted
  // and scrollIntoView silently no-ops.
  useEffect(() => {
    if (!focused) return
    const target = scrollRef.current?.querySelector(`[data-sender="${CSS.escape(focused)}"]`)
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // Long enough to follow the scroll to a card near the bottom, then gone:
    // a highlight that stays becomes a selection the user has to clear.
    const clear = setTimeout(() => setFocused(null), 2200)
    return () => clearTimeout(clear)
  }, [focused, tab])

  const [searchRequest, setSearchRequest] = useState(0)
  const addFirstProject = async (): Promise<void> => {
    const link = await window.api.mighty.pickProjectFolder()
    if (!link) return
    const now = new Date().toISOString()
    await window.api.mighty.upsertProject({
      id: crypto.randomUUID(),
      name: link.repoFolder.split('/').pop() || link.repoFolder,
      created: now,
      updated: now,
      ...link
    })
    setTab('agents')
  }
  const startNewSession = (): void => {
    onShow?.()
    setTab('agents')
    if (homeGroup) prepareNewAgent(homeGroup)
    else if (openProjects.length === 0) void addFirstProject()
  }
  const [newSessionIn, setNewSessionIn] = useState<{ projectId: string | null } | null>(null)
  useEffect(() => {
    if (!newSessionIn || !projectsLoaded) return
    setNewSessionIn(null)
    const group = newSessionIn.projectId && agentGroups.find((g) => g.id === newSessionIn.projectId)
    if (group) prepareNewAgent(group)
    else startNewSession()
  })
  useEffect(() => {
    const group = openWhenListed && agentGroups.find((g) => g.id === openWhenListed)
    if (!group) return
    setOpenWhenListed(null)
    onShow?.()
    setTab('agents')
    prepareNewAgent(group)
  })
  const searchSessions = (): void => setSearchRequest((n) => n + 1)
  const shortcutsRef = useRef({ startNewSession, searchSessions })
  useLayoutEffect(() => {
    shortcutsRef.current = { startNewSession, searchSessions }
  })
  useEffect(() => {
    if (!active || !actionsSlot) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'n') shortcutsRef.current.startNewSession()
      else if (k === 'f') shortcutsRef.current.searchSessions()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, actionsSlot])

  const inlineAgentList = showAgentList && !listSlot
  const pickAgentSession = (session: AgentRelaySessionInfo): void => {
    if (onOpenAgent) return onOpenAgent(session.sessionId ?? session.stated ?? session.label)
    onShow?.()
    setTab('agents')
    setAgentTableId(null)
    setAgentFromTable(false)
    setAgentDraft(null)
    setDetailLabel(session.sessionId ?? session.stated ?? session.label)
    const key = senderMatchKey(session.stated ?? session.label)
    const group = agentGroups.find((g) =>
      g.entries.some((e) => senderMatchKey(e.session.stated ?? e.session.label) === key)
    )
    setAgentsProjectFocus(group && group.id !== 'unassigned' ? group.id : undefined)
  }

  const openCount = agentGroups.reduce((n, g) => n + g.entries.filter((e) => e.row.health !== 'ended').length, 0)
  useEffect(() => onOpenCount?.(openCount), [onOpenCount, openCount])
  const openFromCanvas = useRef<(ref: string) => void>(() => {})
  openFromCanvas.current = (ref) => {
    const key = senderMatchKey(ref)
    const hit = agentGroups
      .flatMap((g) => g.entries)
      .find((e) => e.session.sessionId === ref || senderMatchKey(e.session.stated ?? e.session.label) === key)
    if (hit) pickAgentSession(hit.session)
  }
  useEffect(() => {
    const onOpen = (e: Event): void => openFromCanvas.current((e as CustomEvent<string>).detail)
    window.addEventListener(OPEN_CODE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_CODE_EVENT, onOpen)
  }, [])

  const agentList = (
    <AgentProjectList
      heading={listHeading}
      groups={agentGroups}
      archived={archive.showArchived}
      archivedCount={archive.count}
      onToggleArchived={() => { archive.setShowArchived(!archive.showArchived); setDetailLabel(null) }}
      onArchive={(session) => {
        if (archive.setArchived(session, !archive.showArchived)) setDetailLabel(null)
      }}
      isPinned={archive.isPinned}
      onPin={(session) => archive.setPinned(session, !archive.isPinned(session))}
      selectedKey={selectedRowKey}
      showSelected={active}
      keyFor={sessionRowKey}
      isOnScreen={agentsOnScreen && ((s) => [s.sessionId, s.stated, s.label].some((k) => k && agentsOnScreen.includes(k)))}
      onPick={pickAgentSession}
      onPrepareNewAgent={(group) => {
        onShow?.()
        prepareNewAgent(group)
      }}
      onNewProject={() => setCreatingProject(true)}
      searchRequest={searchRequest}
      onConductorStarted={setFocusPane}
      onOpenTable={(id) => {
        onShow?.()
        if (agentTableId === null) sheetLabelBeforeTable.current = detailLabel
        setAgentFromTable(false)
        setAgentTableId(id)
      }}
      onEditProject={(id) =>
        setEditingProject(projects.find((p) => p.id === id) ?? null)
      }
    />
  )

  return (
    <div className="code-panel" data-variant={variant}>
      {(!tabsInSidebar || activeTab !== 'agents' || onClose) && (
      <div className="code-panel-head">
        {tabsInSidebar && <h1 className="code-view-title">{codeViewTitle(activeTab)}</h1>}
        {tabsInSidebar && activeTab !== 'needs' && activeTab !== 'previous' ? null : tabsInSidebar ? (
          <div className="code-tabs" data-pill role="tablist">
            {(['needs', 'previous'] as const).map((t) => (
              <Button
                variant="bare"
                key={t}
                className="code-tab"
                data-pill
                role="tab"
                aria-selected={activeTab === t}
                data-active={activeTab === t || undefined}
                onClick={() => setTab(t)}
              >
                {t === 'needs' ? CONFIG.UI_LABELS.CODE_NEEDS_WAITING : CONFIG.UI_LABELS.CODE_NEEDS_ANSWERED}
                {t === 'needs' && pending.length > 0 && <span className="code-tab-count">{pending.length}</span>}
              </Button>
            ))}
          </div>
        ) : (
        <div className="code-tabs" role="tablist">
          <Button
            variant="bare"
            className="code-tab"
            role="tab"
            aria-selected={activeTab === 'agents'}
            data-active={activeTab === 'agents' || undefined}
            onClick={() => setTab('agents')}
          >
            Agents
          </Button>
          {isAdmin && (
            <Button
              variant="bare"
              className="code-tab"
              role="tab"
              aria-selected={activeTab === 'factory'}
              data-active={activeTab === 'factory' || undefined}
              onClick={() => setTab('factory')}
            >
              Factory
            </Button>
          )}
          <Button
            variant="bare"
            className="code-tab"
            role="tab"
            aria-selected={activeTab === 'needs'}
            data-active={activeTab === 'needs' || undefined}
            onClick={() => setTab('needs')}
          >
            Needs you
            {pending.length > 0 && <span className="code-tab-count">{pending.length}</span>}
          </Button>
          <Button
            variant="bare"
            className="code-tab"
            role="tab"
            aria-selected={activeTab === 'previous'}
            data-active={activeTab === 'previous' || undefined}
            onClick={() => setTab('previous')}
          >
            Previous
          </Button>
          {/* Only once an agent has actually connected. A permanent tab reading
              "Sessions 0" would advertise a pane that can only ever be empty on
              a Mac where nothing is set up yet -- the status line already tells
              that story, and better. */}
          {archive.all.length > 0 && (
            <Button
              variant="bare"
              className="code-tab"
              role="tab"
              aria-selected={activeTab === 'sessions'}
              data-active={activeTab === 'sessions' || undefined}
              onClick={() => {
                setDetailLabel(null)
                setFromWork(null)
                setTab('sessions')
              }}
            >
              Sessions
              {/* The count is always the real one. A badge that fell to the
                  filtered number would make searching look like agents leaving. */}
              <span className="code-tab-count" data-quiet="">
                {archive.all.length - archive.count}
              </span>
            </Button>
          )}
          {isAdmin && (
            <Button
              variant="bare"
              className="code-tab"
              role="tab"
              aria-selected={activeTab === 'keys'}
              data-active={activeTab === 'keys' || undefined}
              onClick={() => setTab('keys')}
            >
              <KeyRound size={12} strokeWidth={2.5} />
              {CONFIG.UI_LABELS.CODE_TAB_KEYS}
            </Button>
          )}
          <Button variant="bare"
            className="code-tab"
            role="tab"
            aria-selected={activeTab === 'infra'}
            data-active={activeTab === 'infra' || undefined}
            onClick={() => setTab('infra')}
            type="button"
          >
            <Server size={12} strokeWidth={2.5} />
            {CONFIG.UI_LABELS.CODE_TAB_INFRA}
          </Button>
          <Button variant="bare"
            className="code-tab"
            role="tab"
            aria-selected={activeTab === 'reports'}
            data-active={activeTab === 'reports' || undefined}
            onClick={() => setTab('reports')}
            type="button"
          >
            <BarChart3 size={12} strokeWidth={2.5} />
            {CONFIG.UI_LABELS.CODE_TAB_REPORTS}
          </Button>
          <Button variant="bare"
            className="code-tab"
            role="tab"
            aria-selected={activeTab === 'built'}
            data-active={activeTab === 'built' || undefined}
            onClick={() => setTab('built')}
            type="button"
          >
            <LayoutGrid size={12} strokeWidth={2.5} />
            {CONFIG.UI_LABELS.CODE_TAB_MADE}
          </Button>
        </div>
        )}
        {(!tabsInSidebar || activeTab === 'needs' || activeTab === 'previous') && (
        <div className="code-head-right">
          {/* The same queue as "Needs you", one card at a time in its own window.
              Always available: the deck is a VIEW of this panel, not a filter on
              it, and a button that vanishes when the queue empties is a control
              nobody learns is there. Its own empty state covers the zero case. */}
          <Button
            variant="bare"
            className="code-deck-btn"
            onClick={() => window.api.openDeckWindow()}
            title="Swipe through them one at a time"
          >
            <Layers size={13} strokeWidth={2.5} />
            {CONFIG.UI_LABELS.CODE_NEEDS_ANSWER_ONE}
          </Button>
        </div>
        )}
        {onClose && (
          <Button variant="bare" className="code-close" onClick={onClose} title="Close">
            <X size={13} strokeWidth={2.5} />
          </Button>
        )}
      </div>
      )}

      {/* Hidden below two cards: sorting one card is a control that can only
          disappoint, and it would sit on screen for the common case. Hidden in
          the detail view too, where re-sorting would move the open card's
          neighbours out from under the Back/Next buttons. */}
      {activeTab === 'needs' && !detailRequest && pending.length > 1 && (
        <div className="code-viewbar">
          <select
            className="code-viewsel"
            value={sort}
            onChange={(e) => changeSort(e.target.value as RelaySort)}
            aria-label="Sort"
          >
            {RELAY_SORTS.map((s) => (
              <option key={s} value={s}>
                {sortLabel(s)}
              </option>
            ))}
          </select>
          <select
            className="code-viewsel"
            value={filter}
            onChange={(e) => changeFilter(e.target.value as RelayFilter)}
            aria-label="Show"
          >
            {RELAY_FILTERS.map((f) => (
              <option key={f} value={f}>
                {filterLabel(f)}
              </option>
            ))}
          </select>
        </div>
      )}

      {refusal && (
        // assertive, unlike the status line: the user pressed a button and it
        // did nothing, so this has to interrupt rather than wait its turn.
        <div className="code-refusal" role="alert" aria-live="assertive">
          <AlertTriangle size={13} strokeWidth={2.5} />
          <span>{refusalMessage(refusal)}</span>
          {onClearRefusal && (
            <Button
              variant="bare"
              className="code-refusal-close"
              onClick={onClearRefusal}
              title="Dismiss"
            >
              <X size={12} strokeWidth={2.5} />
            </Button>
          )}
        </div>
      )}

      {archive.error && <p role="alert" className="px-4 py-2 text-sm text-red">{archive.error}</p>}
      {listSlot && showAgentList && createPortal(agentList, listSlot)}
      {actionsSlot &&
        createPortal(
          <>
            <SidebarRow
              card
              icon={<SquarePen size={16} />}
              label={CONFIG.UI_LABELS.CODE_SIDEBAR_NEW_SESSION}
              trailing={<span className="text-xs text-muted">⌘N</span>}
              onClick={startNewSession}
            />
          </>,
          actionsSlot
        )}
      <div className="code-scroll" ref={scrollRef} data-detail={detailRequest ? '' : undefined}>
        {activeTab === 'agents' ? (
          <div
            className="agent-projects"
            data-no-side={inlineAgentList ? undefined : ''}
            ref={agentsGridRef}
            style={
              inlineAgentList
                ? { gridTemplateColumns: `${listWidth}px 1px minmax(0, 1fr)`, gap: 0 }
                : undefined
            }
          >
            {inlineAgentList && (
              <div className="agent-projects-side shrink-0 bg-surface2 flex flex-col relative min-h-0 overflow-hidden">
                {agentList}
              </div>
            )}
            {inlineAgentList && (
              <div
                className="agent-projects-grip"
                data-dragging={draggingList ? '' : undefined}
                onMouseDown={startListResize}
                onDoubleClick={() => setListWidth(CONFIG.MIGHTY.SIDEBAR.DEFAULT_WIDTH)}
                title="Drag to resize · double-click to reset"
                role="separator"
                aria-orientation="vertical"
              />
            )}
            <div className="mighty-agent-workspace flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <div className="agent-projects-main min-w-0 flex-1">
                {draft ? (
                  <AgentDraftPane
                    draft={draft}
                    withRail={showAgentRail}
                    onToggleRail={props.onToggleAgentRail}
                    projects={openProjects}
                    onSend={sendDraftAgent}
                    resume={agentGroups
                      .find((g) => g.id === draft.groupId)
                      ?.entries.filter((e) => e.row.health !== 'ended' && (e.session.tldr || e.session.stated))
                      .slice(0, RESUME_COUNT)}
                    onContinue={pickAgentSession}
                    failure={startFailure?.cwd === draft.cwd ? startFailure : undefined}
                    onProjectChange={(id) => {
                      if (id === undefined && noProjectCwd) return openNoProject()
                      if (!agentDraft) return focusAgentsProject(id)
                      if (id === undefined) {
                        focusAgentsProject(undefined)
                        clearAgentsHome()
                        return
                      }
                      const group = agentGroups.find((g) => g.id === id)
                      if (group) prepareNewAgent(group)
                    }}
                    onEditProject={(p) => setEditingProject(p)}
                    onNewProject={() => setCreatingProject(true)}
                    onOpenSideBySide={onOpenSix && ((count) => onOpenSix(draft.cwd, count))}
                  />
                ) : (
                  <>
                    {!projectsPick && !agentTable && !reopening && (
                      <div className="agent-main-scope">
                        <ProjectScopePicker
                          projects={openProjects}
                          valueId={agentsScopeProjectId}
                          onChange={(id) =>
                            id === undefined && noProjectCwd ? openNoProject() : focusAgentsProject(id)
                          }
                          onEditProject={(p) => setEditingProject(p)}
                          onNewProject={() => setCreatingProject(true)}
                        />
                      </div>
                    )}
                    {agentTable && (!agentFromTable || !projectsPick) ? (
                      <AgentProjectTable
                        groups={agentTable.id === ALL_SESSIONS_TABLE ? agentGroups : [agentTable]}
                        title={agentTable.name}
                        now={now}
                        priority={priority}
                        onSettings={() => setTab('work')}
                        onBack={() => {
                          if (agentsBack) return goBackInAgents()
                          const backTo = sheetLabelBeforeTable.current
                          setAgentTableId(null)
                          setAgentFromTable(false)
                          setDetailLabel(backTo)
                        }}
                        onPick={(session) => {
                          setAgentFromTable(true)
                          setDetailLabel(session.sessionId ?? session.stated ?? session.label)
                        }}
                        home={
                          homeDraft
                            ? {
                                name: homeDraft.name,
                                onOpen: (ref) => {
                                  setAgentFromTable(true)
                                  setDetailLabel(ref)
                                },
                                onStartNew: (text) => {
                                  setAgentFromTable(true)
                                  setDetailLabel(null)
                                  return startAgentIn(homeDraft)(text, [], null)
                                }
                              }
                            : undefined
                        }
                      />
                    ) : projectsPick ? (
                      <SessionDetail
                        session={projectsPick}
                        history={projectsHistory}
                        onRespond={onRespond}
                        opening={openingFor(projectsPick)}
                        threadKey={
                          awaitingAgent && !awaitingAgent.handedTo
                            ? `start-${awaitingAgent.since}`
                            : startThreadKeys.current.get(detailLabel ?? '')
                        }
                        starting={
                          awaitingAgent && !awaitingAgent.handedTo
                            ? { ...awaitingAgent, onRetry: retryStart, onClose: clearAgentsHome }
                            : undefined
                        }
                        shared={fromWork ?? priority.sharedFor(projectsPick) ?? undefined}
                        backTo={agentsBackName}
                        onBack={() => {
                          if (agentsBack) return goBackInAgents()
                          if (agentFromTable && agentTable) {
                            setAgentFromTable(false)
                            setDetailLabel(sheetLabelBeforeTable.current)
                            return
                          }
                          clearAgentsHome()
                        }}
                        withRail={showAgentRail}
                    onToggleRail={props.onToggleAgentRail}
                        project={mightyProjectForCwd(projectsPick.cwd, openProjects) ?? undefined}
                        archived={archive.isArchived(projectsPick)}
                        onArchive={() => {
                          const session = projectsPick
                          if (session && archive.setArchived(session, !archive.isArchived(session))) setDetailLabel(null)
                        }}
                      />
                    ) : startInView || reopening ? (
                      <div className="agent-projects-empty agent-projects-home">
                        <p>{reopening ? L.CODE_AGENTS_REOPENING : CONFIG.UI_LABELS.CODE_AGENTS_DRAFT_STARTING}</p>
                      </div>
                    ) : (
                      <div className="agent-projects-empty agent-projects-home">
                        {activeAgentGroup && activeAgentGroup.id !== 'unassigned' ? (
                          <>
                            <p className="agent-projects-home-title">{activeAgentGroup.name}</p>
                            <p>
                              {activeAgentGroup.entries.length > 0
                                ? CONFIG.UI_LABELS.CODE_AGENTS_EMPTY_PICK
                                : CONFIG.UI_LABELS.CODE_AGENTS_EMPTY_IN_PROJECT.replace(
                                    '{name}',
                                    activeAgentGroup.name
                                  )}
                            </p>
                          </>
                        ) : openProjects.length === 0 ? (
                          <>
                            <p>{CONFIG.UI_LABELS.CODE_AGENTS_EMPTY_FIRST}</p>
                            <Button variant="primary" onClick={() => void addFirstProject()}>
                              {CONFIG.UI_LABELS.CODE_START_PICK_FOLDER}
                            </Button>
                            {noProjectCwd && (
                              <Button variant="ghost" onClick={openNoProject}>
                                {CONFIG.UI_LABELS.CODE_START_NO_PROJECT}
                              </Button>
                            )}
                          </>
                        ) : (
                          <p>{CONFIG.UI_LABELS.CODE_AGENTS_EMPTY_HOME}</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ) : activeTab === 'work' ? (
          <>
            <Button variant="ghost" onClick={() => setTab('sessions')}>Back to Sessions</Button>
          <CoordinationPanel
            sessions={allSessions}
            onOpenSession={openSession}
            onOpenFactory={(taskId) => {
              setFactoryTaskId(taskId)
              setTab('factory')
            }}
          />
          </>
        ) : activeTab === 'factory' ? (
          <FactoryPanel
            projects={projects}
            focusTaskId={factoryTaskId}
            onFocusHandled={() => setFactoryTaskId(null)}
            showList={showAgentList}
            showRail={showAgentRail}
          />
        ) : !known ? (
          // No status reply yet -- distinct from every empty state below, which
          // all mean "asked, and this is what came back."
          <div className="code-loading">{CONFIG.UI_LABELS.CODE_LOADING}</div>
        ) : activeTab === 'needs' && detailRequest ? (
          <CodeDetail
            request={detailRequest}
            index={detailIndex}
            total={visible.length}
            onPage={pageDetail}
            onBack={() => setDetailId(null)}
            onRespond={onRespond}
            project={projectOf(detailRequest.params.from)}
          />
        ) : activeTab === 'needs' ? (
          visible.length === 0 && pending.length === 0 && handedBackList ? (
            handedBackList
          ) : visible.length === 0 ? (
            // A filter hiding everything is a different situation from an empty
            // inbox, and the way out is the button, not the copy.
            pending.length > 0 ? (
              <CodeEmpty
                headline="Nothing matches this filter"
                body={`${pending.length} ${pending.length === 1 ? 'card is' : 'cards are'} waiting under a different type.`}
              >
                <Button
                  variant="bare"
                  className="code-empty-link"
                  onClick={() => changeFilter('all')}
                >
                  Show everything
                </Button>
              </CodeEmpty>
            ) : (
              <CodeEmpty
                headline={CONFIG.UI_LABELS.CODE_EMPTY_HEADLINE}
                body={CONFIG.UI_LABELS.CODE_EMPTY_BODY}
                demo="stack"
              >
                {archive.all.length === 0 && (
                  <Button variant="bare" className="code-empty-link" onClick={startNewSession}>
                    {CONFIG.UI_LABELS.CODE_START_FIRST_AGENT}
                  </Button>
                )}
                {previous.length > 0 && (
                  <Button
                    variant="bare"
                    className="code-empty-link"
                    onClick={() => setTab('previous')}
                  >
                    See what you answered
                  </Button>
                )}
              </CodeEmpty>
            )
          ) : (
            <>
              {hiddenNote && <div className="code-hidden-note">{hiddenNote}</div>}
              {groups
                ? groups.map((group) => (
                    <div
                      className="code-group"
                      key={group.key}
                      // `group.from` is undefined for the unnamed-sender group
                      // (its key is `''`, not undefined) -- fall back to the
                      // same UNKNOWN_SENDER value its chip displays, so the
                      // attribute always exists and `revealSender` has a real
                      // target to scroll to instead of silently no-opping.
                      data-sender={group.from ?? UNKNOWN_SENDER}
                      data-focused={(group.from ?? UNKNOWN_SENDER) === focused ? '' : undefined}
                    >
                      {/* The chip moves to the group header when a group has more
                          than one card, so a stack from one agent states its
                          sender once. */}
                      {group.requests.length > 1 && (
                        <div className="code-group-head">
                          <SenderChip from={group.from} project={projectOf(group.from)} />
                        </div>
                      )}
                      {group.requests.map((request) => (
                        <RelayCard
                          key={request.id}
                          request={request}
                          showSender={group.requests.length === 1}
                          onRespond={onRespond}
                          onExpand={() => openCard(request)}
                          allowFlick
                          project={projectOf(request.params.from)}
                        />
                      ))}
                    </div>
                  ))
                : visible.map((request) => (
                    <RelayCard
                      key={request.id}
                      request={request}
                      showSender
                      onRespond={onRespond}
                      onExpand={() => openCard(request)}
                      allowFlick
                      project={projectOf(request.params.from)}
                    />
                  ))}
              {handedBackList}
            </>
          )
        ) : activeTab === 'sessions' && detailSession ? (
          // Matched on the normalised key, not raw equality: the same agent's
          // cards carry both separators, so `===` here silently emptied the
          // sheet while the list ring (which normalises) still showed a number.
          <SessionDetail
            session={detailSession}
            // Everything this agent has sent, newest first -- both lists, since
            // a session's story is its answered cards as much as its open ones.
            history={[...pending, ...previous]
              .filter((r) => senderMatchKey(r.params.from) === detailKey)
              .sort((a, b) => b.createdAt - a.createdAt)}
            onRespond={onRespond}
            shared={fromWork ?? priority.sharedFor(detailSession) ?? undefined}
            backLabel={fromWork ? 'Shared work' : 'All sessions'}
            withRail={showAgentRail}
                    onToggleRail={props.onToggleAgentRail}
            project={mightyProjectForCwd(detailSession.cwd, openProjects) ?? undefined}
            archived={archive.isArchived(detailSession)}
            onArchive={() => {
              const session = detailSession
              if (session && archive.setArchived(session, !archive.isArchived(session))) setDetailLabel(null)
            }}
            onBack={() => {
              if (fromWork) setTab('work')
              setDetailLabel(null)
              setFromWork(null)
            }}
          />
        ) : activeTab === 'sessions' ? (
          archive.sessions.length === 0 ? (
            <CodeEmpty
              headline={archive.showArchived ? 'No archived sessions' : 'No sessions to show'}
              body={archive.showArchived ? 'Sessions you archive stay here until you restore them.' : 'Start a new agent and it shows up here.'}
            >
              <PriorityToolbar priority={priority} onRank={() => void priority.rank()} onSettings={() => setTab('work')} />
            </CodeEmpty>
          ) : (
            <>
              <div className="code-session-head" data-density={effectiveDensity}>
              <PriorityToolbar priority={priority} onRank={() => {
                changeSessionSort('priority')
                changeGroup('none')
                void priority.rank()
              }} onSettings={() => setTab('work')} />
              <ArchiveSuggestions
                sessions={archive.sessions}
                priority={priority}
                onArchive={(sessions, archived) => sessions.forEach((s) => archive.setArchived(s, archived))}
              />
              {allSessions.length > 3 && (
                <div className="code-session-search" data-density={effectiveDensity}>
                  <Search size={13} strokeWidth={2.5} aria-hidden="true" />
                  <input
                    className="code-session-search-input"
                    type="search"
                    value={sessionQuery}
                    onChange={(e) => setSessionQuery(e.target.value)}
                    placeholder={CONFIG.UI_LABELS.CODE_SESSIONS_SEARCH}
                    aria-label="Search sessions"
                  />
                  {sessionQuery && (
                    <Button
                      variant="bare"
                      className="code-session-search-clear"
                      onClick={() => setSessionQuery('')}
                      title="Clear"
                    >
                      <X size={12} strokeWidth={2.5} />
                    </Button>
                  )}
                </div>
              )}
              {/* The controls the repeated card fields earn: the folder every
                  card prints becomes the grouping, and the state word becomes
                  the chips. Only once there is enough to be worth organising --
                  four agents need no toolbar. */}
              {allSessions.length > 3 && (
                <div className="code-session-tools" data-density={effectiveDensity}>
                  <>
                      {sessionProjects.length > 1 && (
                        <label className="code-session-select">
                          Project
                          <select value={activeProject} onChange={(e) => changeSessionProject(e.target.value)}>
                            <option value="">All projects</option>
                            {sessionProjects.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="code-session-select">
                        Group by
                        <select
                          value={sessionGroup}
                          onChange={(e) => changeGroup(e.target.value as SessionGroup)}
                        >
                          {SESSION_GROUPS.map((g) => (
                            <option key={g} value={g}>
                              {SESSION_GROUP_LABELS[g]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="code-session-select">
                        Sort
                        <select
                          value={sessionSort}
                          onChange={(e) => changeSessionSort(e.target.value as SessionSort)}
                        >
                          {SESSION_SORTS.map((s) => (
                            <option key={s} value={s}>
                              {SESSION_SORT_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!onBoard && (
                        <SegmentedControl
                          items={sessionSegments}
                          active={activeFilters[0] ?? 'all'}
                          onChange={(id) => setSessionFilters(id === 'all' ? [] : [id])}
                          textSize="text-xs"
                          className="code-session-segments"
                        />
                      )}
                  </>

                  {onBoard && (
                    <Button
                      variant="bare"
                      className="code-session-filter"
                      data-on={boardCompact || undefined}
                      aria-pressed={boardCompact}
                      onClick={toggleBoardCompact}
                      title="One line each"
                    >
                      Compact
                    </Button>
                  )}
                  <div className="code-session-density" role="group" aria-label="How much to show">
                    <Button
                      variant="bare"
                      className="code-session-density-btn"
                      data-on={effectiveDensity === 'grid' || undefined}
                      aria-pressed={effectiveDensity === 'grid'}
                      onClick={() => changeDensity('grid')}
                    >
                      <LayoutGrid size={13} strokeWidth={2.5} />
                      Cards
                    </Button>
                    <Button
                      variant="bare"
                      className="code-session-density-btn"
                      data-on={effectiveDensity === 'board' || undefined}
                      aria-pressed={effectiveDensity === 'board'}
                      onClick={() => changeDensity('board')}
                    >
                      <Columns3 size={13} strokeWidth={2.5} />
                      Board
                    </Button>
                    <Button
                      variant="bare"
                      className="code-session-density-btn"
                      data-on={effectiveDensity === 'list' || undefined}
                      aria-pressed={effectiveDensity === 'list'}
                      onClick={() => changeDensity('list')}
                    >
                      <Rows3 size={13} strokeWidth={2.5} />
                      List
                    </Button>
                  </div>
                </div>
              )}
              </div>

              {shown === 0 ? (
                // The way out is the button, not the copy: a search that matched
                // nothing is one keystroke from a search that does.
                <CodeEmpty
                  headline="No agent matches that."
                  body={
                    sessionQuery.trim()
                      ? `None of your ${allSessions.length} open agents match "${sessionQuery.trim()}"${activeProject ? ` in ${activeProject}` : ''}.`
                      : `None of your ${allSessions.length} open agents match those filters.`
                  }
                >
                  <Button
                    variant="bare"
                    className="code-empty-link"
                    onClick={() => {
                      setSessionQuery('')
                      setSessionFilters([])
                      changeSessionProject('')
                    }}
                  >
                    Show all {allSessions.length}
                  </Button>
                </CodeEmpty>
              ) : onBoard ? (
                <div
                  className="code-session-board"
                  data-compact={boardCompact || undefined}
                  style={{ '--board-cols-tab': boardViews.map((c) => (c.entries.length ? 'minmax(240px, 4fr)' : 'minmax(0, 1fr)')).join(' ') } as CSSProperties}
                >
                  <div className="code-session-board-heads">
                    {boardViews.map((column) => (
                      <header
                        className="code-session-board-head"
                        key={column.key}
                        data-column={column.key}
                        data-empty={column.entries.length === 0 || undefined}
                        title={column.title}
                      >
                        <span className="code-session-board-name">{column.title}</span>
                        <span className="code-session-group-count">{column.entries.length}</span>
                      </header>
                    ))}
                  </div>
                  <div className="code-session-board-body" role="list">
                    {boardViews.map((column) => (
                      <section
                        className="code-session-board-col"
                        key={column.key}
                        data-column={column.key}
                        data-empty={column.entries.length === 0 || undefined}
                      >
                        <div
                          className="code-sessions"
                          data-density={boardCompact ? 'list' : 'board'}
                          role="list"
                        >
                          {column.lanes.map((lane) => (
                            <div className="code-session-board-lane" key={lane.key}>
                              {lane.title !== '' && (
                                <div className="code-session-board-lane-head">{lane.title}</div>
                              )}
                              {lane.entries.map((entry) => (
                                <SessionCard
                                  entry={entry}
                                  density={boardCompact ? 'list' : 'board'}
                                  key={priorityKey(entry.session)}
                                  archived={archive.showArchived}
                                onArchive={() => archiveSession(entry.session)}
                                  onOpen={() => openSession(entry.session.sessionId || entry.session.label)}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="code-session-groups">
                  {sessionGroupViews.map((group) => {
                    // One group under "Group by: Nothing" is the whole list, so
                    // it gets no header -- a heading over everything names
                    // nothing.
                    const headed = sessionGroup !== 'none' || group.ended
                    const isCollapsed = headed && collapsed.includes(group.key)
                    return (
                      <section className="code-session-group" key={group.key}>
                        {headed && (
                          <Button
                            variant="bare"
                            className="code-session-group-head"
                            onClick={() => toggleGroup(group.key)}
                            aria-expanded={!isCollapsed}
                            data-ended={group.ended || undefined}
                          >
                            <ChevronRight
                              className="code-session-caret"
                              data-open={!isCollapsed || undefined}
                              size={12}
                              strokeWidth={3}
                            />
                            <span className="code-session-group-name">{group.title}</span>
                            <span className="code-session-group-count">{group.entries.length}</span>
                            {/* Visible while collapsed: a folded group must
                                still say something inside wants an answer. */}
                            {group.waiting > 0 && (
                              <span className="code-session-group-waiting">
                                {group.waiting} waiting
                              </span>
                            )}
                          </Button>
                        )}
                        {!isCollapsed && (
                          <div
                            className="code-sessions"
                            data-density={effectiveDensity}
                            role="list"
                          >
                            {effectiveDensity === 'list' && (
                              <div className="code-session-cols" aria-hidden="true">
                                <span>{L.CODE_SESSIONS_COL_SESSION}</span>
                                <span>{L.CODE_SESSIONS_COL_PROJECT}</span>
                                <span>{L.CODE_SESSIONS_COL_MODEL}</span>
                                <span>{L.CODE_SESSIONS_COL_STATE}</span>
                                <span>{L.CODE_SESSIONS_COL_PULSE}</span>
                                <span>{L.CODE_SESSIONS_COL_ACTIVITY}</span>
                              </div>
                            )}
                            {group.entries.map((entry) => (
                              <SessionCard
                                entry={entry}
                                density={effectiveDensity}
                                pulse={entry.session.sessionId ? pulses[entry.session.sessionId] : undefined}
                                now={now}
                                key={priorityKey(entry.session)}
                                archived={archive.showArchived}
                                onArchive={() => archiveSession(entry.session)}
                                // Every card opens, not just ones with cards
                                // waiting: a healthy agent still has a history.
                                onOpen={() => openSession(entry.session.sessionId || entry.session.label)}
                              />
                            ))}
                          </div>
                        )}
                      </section>
                    )
                  })}
                </div>
              )}
            </>
          )
        ) : activeTab === 'keys' ? (
          <KeysPanel variant={variant} />
        ) : activeTab === 'built' ? (
          <BuiltPanel onOpenSession={(id) => openSession(id)} />
        ) : activeTab === 'infra' ? (
          <InfraPanel onOpenAgent={openAgentPane} />
        ) : activeTab === 'reports' ? (
          <ReportsPanel onOpenAgent={openAgentPane} />
        ) : previous.length === 0 ? (
          <CodeEmpty
            headline={CONFIG.UI_LABELS.CODE_PREVIOUS_EMPTY_HEADLINE}
            body={CONFIG.UI_LABELS.CODE_PREVIOUS_EMPTY_BODY}
          />
        ) : (
          <PreviousList
            requests={previous}
            projectOf={projectOf}
            onUndismiss={onUndismiss}
            onOpenSender={(from) => openSession(from)}
          />
        )}
      </div>
      {creatingProject && (
        <CreateProjectModal
          noFolderHint="Starts in a new empty folder"
          onCancel={() => setCreatingProject(false)}
          onCreate={async (p) => {
            const link = p.repoFolder ? {} : await window.api.mighty.makeProjectFolder(p.name)
            const saved = await window.api.mighty.upsertProject({ ...p, ...link })
            if (!saved) throw new Error('project not saved')
            setCreatingProject(false)
            setOpenWhenListed(saved.id)
            loadProjects()
          }}
        />
      )}
      {editingProject && (
        <ProjectSettingsModal
          project={editingProject}
          onCancel={() => setEditingProject(null)}
          onSave={(p) => {
            setEditingProject(null)
            void window.api.mighty.upsertProject(p).then(() => loadProjects())
          }}
        />
      )}
    </div>
  )
}

/** One agent, as a card — the hover row is scanned, this one is READ. All of it
 *  comes from `sessionRow`, so the two surfaces agree on every name. */
function SessionCard({
  entry,
  density,
  pulse,
  now,
  archived,
  onOpen,
  onArchive
}: {
  /** Session, row, and activity together. Built by the pane, not here: the same
   *  row has to drive the grouping and the sort, and rebuilding it per card is
   *  how a card ends up in a group its own fields disagree with. */
  entry: SessionEntry
  /** 'list' is one line; 'board' is the compact card in a status column. */
  density: SessionDensity
  pulse?: PulseRow
  now?: number
  archived?: boolean
  /** Open this session on its own. Always passed — a card with no cards waiting
   *  still has a folder, an agent, and a history worth opening. */
  onOpen: () => void
  onArchive: () => void
}): React.JSX.Element {
  const { session, row, activity } = entry
  const waiting = activity.waiting
  // Both come from `sessionRow` now: the wording and the colour are the same
  // question on two surfaces, and each having its own ternary is how they drift.
  const state = row.state_text
  const health = row.health

  // A card always states a title. `sessionRow` leaves `name` unset for an
  // unnamed pane and puts the checkout on line 1 instead, which is exactly the
  // fallback wanted here.
  const title = row.name ?? row.repo ?? CONFIG.UI_LABELS.CODE_SESSION_UNNAMED
  const { tip, hoverProps } = useTooltip()

  return (
    <PrioritySession row={entry.priority} onArchive={onArchive}>
    {createPortal(<Tooltip tip={tip} />, document.body)}
    <div className="code-session-hover" data-density={density}>
    {entry.priority?.level !== 0 && (
      <Button
        variant="icon"
        className="code-session-archive"
        onClick={onArchive}
        title={archived ? 'Restore' : 'Archive'}
        aria-label={archived ? 'Restore session' : 'Archive session'}
      >
        {archived ? <ArchiveRestore size={13} strokeWidth={2} /> : <Archive size={13} strokeWidth={2} />}
      </Button>
    )}
    <Button
      variant="bare"
      className="code-session-card"
      role="listitem"
      onClick={onOpen}
      data-clickable=""
      data-health={health}
      data-density={density}
      title={session.label}
    >
      <div className="code-session-top">
        <span className="code-session-face" aria-hidden="true">
          <AgentFace id={sessionFaceId(session)} size={AGENT_FACE_SIZE.list} />
        </span>
        {/* The bdi keeps the name itself in reading order inside the rtl parent
            that moves its ellipsis to the head -- see .code-session-name. */}
        <span className="code-session-name" title={title}>
          <bdi>{title}</bdi>
        </span>
        {entry.priority?.heat != null && entry.rank != null && (
          <span
            className="session-priority-heat"
            data-stale={entry.priority.stale || undefined}
            style={{ '--heat': `${entry.priority.heat}%` } as React.CSSProperties}
            {...hoverProps(
              <span className="session-priority-tip">
                <strong>
                  {PRIORITY_COPY.rankOf.replace('{rank}', String(entry.rank)).replace('{of}', String(entry.rankOf))}
                  {' · '}
                  {PRIORITY_COPY.labels[entry.priority.level ?? 0]}
                </strong>
                <span>{entry.priority.reason}</span>
                {entry.priority.stale && <em>{PRIORITY_COPY.heatStale}</em>}
              </span>
            )}
          >
            #{entry.rank}
          </span>
        )}
        {row.waitAge && (
          <span className="code-session-age" title="How long this agent has been waiting on you">
            {row.waitAge}
          </span>
        )}
      </div>

      {/* The small print, only where it says something: which agent is running,
          a handle that tells two unnamed panes apart, and a folder that is not
          simply the repo. Every chip is absent rather than empty when the shim
          did not report it -- an older shim must read as a plain card, never as
          a card with holes in it. */}
      {(row.agent || row.model || row.effort || row.detail || row.where) && (
        <div className="code-session-meta">
          {row.agent && (
            <span className="code-session-chip" data-agent="">
              <AgentMark vendor={row.vendor} size={11} />
              {row.agent}
            </span>
          )}
          {/* Which model, when the shim could resolve one. Its own chip rather
              than a suffix on the agent: "Claude Code" and "Opus 5" are two
              facts, and only one of them changes when you switch model. */}
          {row.model && (
            <span className="code-session-chip" data-model="">
              {row.model}
            </span>
          )}
          {row.effort && <span className="code-session-chip">{row.effort}</span>}
          {row.detail && (
            <span
              className="code-session-chip"
              data-generated={isGeneratedTag(row.detail) ? '' : undefined}
            >
              {row.detail}
            </span>
          )}
          {row.where && (
            <span className="code-session-chip" title={session.cwd}>
              {row.where}
            </span>
          )}
        </div>
      )}

      {/* What this agent is on, in its own words. The subject it declared beats
          the last thing it happened to say when both exist: one answers what
          the session IS, the other only what its most recent request was. A
          card built purely from identity makes every agent in one checkout look
          the same, so this line is what tells them apart. */}
      {(recapLine(row) || activity.derivedSubject || activity.lastSummary) && (
        <div className="code-session-last">
          {/* Tags the declared subject only: neither the derived subject nor
              lastSummary was DECLARED, so labelling either "TLDR" would name it
              something it isn't. */}
          {recapLine(row) && <span className="session-tldr-tag">RECAP</span>}
          {recapLine(row) ?? activity.derivedSubject ?? activity.lastSummary}
        </div>
      )}

      {/* Which code this is -- deliberately LOW in the card. Every card in a
          group tends to share a checkout, so the repo is the field that
          distinguishes least; the name, the chips, and the agent's own words
          all answer "which of these is it?" first. Each part carries its own
          glyph, because "ShowAndTell/dev" as one string reads as a subfolder. */}
      {row.repo && (
        <div className="code-session-place">
          <span className="code-session-repo">
            <Folder size={11} strokeWidth={2} aria-hidden="true" />
            {row.repo}
          </span>
          {row.branch && (
            <span className="code-session-branch">
              <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
              {row.branch}
            </span>
          )}
        </div>
      )}

      {/* How busy it has been. Absent at zero rather than showing "0 cards" --
          a fresh agent has nothing to report, which the state line already
          says. */}
      {activity.total > 0 && (
        <div className="code-session-stats">
          <span>
            {activity.total} {activity.total === 1 ? 'card' : 'cards'}
          </span>
          {activity.medianReplyMs !== null && (
            <span title="Typical time you took to answer this agent">
              ~{formatDuration(activity.medianReplyMs)} to answer
            </span>
          )}
        </div>
      )}

      {/* The foot says what to expect from clicking. With cards waiting that is
          the answer you owe; without, it is just the rest of this agent's
          detail -- and the chevron is there either way, because the card opens
          either way. */}
      <div className="code-session-foot">
        <span className="code-session-state">{state}</span>
        {/* In the foot with a slot of its own, not layered on the avatar: a
            face is only a circle for some agents, so an arc drawn around one
            sat crooked on the rest. */}
        {session.progress !== undefined && (
          <ProgressMeter value={session.progress} classes={MAC_METER_CLASSES} />
        )}
        <span className="code-session-go">
          {waiting > 0 ? `See ${waiting === 1 ? 'it' : 'them'}` : 'Details'}
          <ChevronRight size={12} strokeWidth={2.5} />
        </span>
      </div>
      {density === 'list' && <PulseCell row={pulse} hoverProps={hoverProps} />}
      {density === 'list' && now !== undefined && (
        <SessionTime at={Math.max(lastEventAt(entry), session.lastActivityAt ?? 0)} now={now} />
      )}
    </Button>
    </div>
    </PrioritySession>
  )
}

function SessionTime({ at, now }: { at: number | undefined; now: number }): React.JSX.Element {
  return (
    <span className="code-session-time" title={at ? new Date(at).toLocaleString() : undefined}>
      {at ? relativeAge(now - at) : '-'}
    </span>
  )
}

/** The sample is plain divs, not a RelayCard, and aria-hidden: it must never be
 *  mistaken for something actually waiting on an answer. */
function CodeEmpty(props: {
  headline: string
  body: string
  demo?: 'stack'
  children?: React.ReactNode
}): React.JSX.Element {
  if (props.demo === 'stack') {
    return (
      <div className="code-empty" data-demo="stack">
        <div className="code-empty-stack" aria-hidden="true">
          <div className="code-empty-stack-card" data-pos="back" />
          <div className="code-empty-stack-card" data-pos="mid" />
          <div className="code-empty-stack-card" data-pos="front">
            <div className="code-empty-stack-top">
              <span className="code-empty-wait-dot" />
              <b>your-repo</b>
              <span>asks to go ahead</span>
              <span className="code-empty-stack-age">2m ago</span>
            </div>
            <div className="code-empty-stack-q">Push the release branch?</div>
            <div className="code-empty-stack-acts">
              <span className="code-empty-stack-approve">
                <Check size={13} strokeWidth={2.2} />
                Approve
              </span>
              <span className="code-empty-stack-deny">Don&apos;t</span>
            </div>
          </div>
        </div>
        <p className="code-empty-headline">{props.headline}</p>
        <p className="code-empty-body">{props.body}</p>
        {props.children}
        <p className="code-empty-phone-note">
          <Smartphone size={14} strokeWidth={2} aria-hidden="true" />
          {CONFIG.UI_LABELS.CODE_EMPTY_PHONE_NOTE}
        </p>
      </div>
    )
  }
  return (
    <div className="code-empty">
      <div className="code-empty-icon" aria-hidden="true">
        <Terminal size={20} strokeWidth={1.75} />
      </div>
      <p className="code-empty-headline">{props.headline}</p>
      <p className="code-empty-body">{props.body}</p>
      {props.children}

      <div className="code-sample" aria-hidden="true">
        <span className="code-sample-note">{CONFIG.UI_LABELS.CODE_EMPTY_SAMPLE_NOTE}</span>
        <div className="code-card code-sample-card">
          <div className="code-card-head">
            <span className="code-sender">
              <span className="code-sender-dot" style={{ background: 'var(--blue)' }} />
              your-repo/main
            </span>
            <span className="code-verb">Approval needed</span>
            <span className="code-waiting">Asked 2m ago</span>
          </div>
          <div className="code-card-body">Push the release branch?</div>
          <div className="code-actions">
            <span className="code-btn-approve">
              <Check size={13} />
              Approve
            </span>
            <span className="code-btn-deny">
              <X size={13} />
              Don&apos;t
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
