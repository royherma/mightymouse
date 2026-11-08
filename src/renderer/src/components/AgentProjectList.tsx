import { Button } from './Button'
import { JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Bell, CircleDot, House, Pencil, Pin, PinOff, Plus, Search, Terminal } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { ProjectGroupHeader } from './ProjectIcon'
import { matchesSession, sessionHaystack, sessionRow } from '../../../shared/relay-status'
import type { SessionRow } from '../../../shared/relay-status'
import { sortEntries, sessionSpoke } from '../../../shared/relay-sessions'
import type { SessionEntry } from '../../../shared/relay-sessions'
import { mightyProjectForCwd } from '../../../shared/relay-sessions'
import { writeCodeDrag } from '../../../shared/canvas'
import type { SessionActivity } from '../../../shared/relay-cards'
import type { AgentRelaySessionInfo, MightyProject } from '../../../shared/types'
import { relayProgressBand } from '../../../shared/relay-progress'
import {
  MAC_METER_CLASSES,
  MAC_RING_CLASSES,
  PROGRESS_DOT_SIZE,
  ProgressMeter,
  ProgressRing
} from '../../../shared/progress-ring'
import './AgentProjects.css'
import { HoverScroll } from './hover-scroll'
import { PROJECT_MENU, SESSION_MENU, showMenu } from './sidebar-menus'
import { FoldChevron } from '../mighty/MightySidebar'
import { useFolded } from '../hooks/useFolded'
import { ConductorImport } from './ConductorImport'

const CAP = 5
const UNASSIGNED = 'unassigned'
const FOLD_SECTION = 'section:agents'
const HOTKEY_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const HOTKEY_HINT_DELAY_MS = 200

function useCommandHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = (): void => {
      clearTimeout(timer)
      timer = undefined
      setHeld(false)
    }
    const onDown = (e: KeyboardEvent): void => {
      if (e.key === 'Meta' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (!timer) timer = setTimeout(() => setHeld(true), HOTKEY_HINT_DELAY_MS)
      } else if (!HOTKEY_DIGITS.includes(e.key)) release()
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') release()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', release)
    return () => {
      release()
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', release)
    }
  }, [enabled])
  return held
}

export const ALL_SESSIONS_TABLE = '__all__'

export type AgentGroup = {
  id: string
  name: string
  icon?: string
  imagePath?: string
  repoFolder?: string
  entries: SessionEntry[]
  /** How many of this project's agents want something from you — the header
   *  badge, and what keeps a project visible under the alerts-only filter. */
  alerts: number
}

/** Does this agent want something from the user right now? A card it is blocked
 *  on, or a turn it handed back and nobody has opened. The same two states the
 *  row's dot already claims, so the filter cannot show rows that look quiet. */
export function sessionHasAlert(entry: SessionEntry): boolean {
  if (entry.row.health === 'ended') return false
  return entry.activity.waiting > 0 || entry.row.health === 'your-turn'
}

function sessionIsRunning(entry: SessionEntry): boolean {
  return entry.row.health === 'working'
}

export function respondingWithoutNumber(
  session: AgentRelaySessionInfo,
  health: SessionRow['health']
): boolean {
  return health === 'working' && relayProgressBand(session.progress) === null
}

export function AgentWorkingMark({
  session,
  health,
  compact = false,
  dot = false
}: {
  session: AgentRelaySessionInfo
  health: SessionRow['health']
  compact?: boolean
  dot?: boolean
}): JSX.Element | null {
  if (health !== 'working') return null
  const progress = session.progress
  if (dot && !(typeof progress === 'number' && relayProgressBand(progress))) {
    return <span className="agent-projects-live" title="Responding…" />
  }
  if (typeof progress === 'number' && relayProgressBand(progress)) {
    if (compact) {
      return (
        <span className="agent-projects-mark">
          <ProgressRing value={progress} size={PROGRESS_DOT_SIZE} classes={MAC_RING_CLASSES} />
        </span>
      )
    }
    return (
      <span className="agent-projects-mark">
        <ProgressMeter value={progress} classes={MAC_METER_CLASSES} size={PROGRESS_DOT_SIZE} />
      </span>
    )
  }
  return (
    <span className="agent-projects-mark" title="Responding…">
      <ProgressRing
        value={Number.NaN}
        indeterminate
        size={PROGRESS_DOT_SIZE}
        classes={MAC_RING_CLASSES}
      />
    </span>
  )
}

function groupCwd(group: AgentGroup): string | undefined {
  if (group.repoFolder) return group.repoFolder
  for (const entry of group.entries) {
    if (entry.session.cwd) return entry.session.cwd
  }
  return undefined
}



export function groupByProject(
  sessions: AgentRelaySessionInfo[],
  projects: MightyProject[],
  activityFor: (session: AgentRelaySessionInfo) => SessionActivity,
  now: number
): AgentGroup[] {
  const open = projects.filter((p) => !p.archived)
  const groups = new Map<string, AgentGroup>()
  for (const p of open) {
    if (p.repoFolder === undefined) continue
    groups.set(p.id, {
      id: p.id,
      name: p.name,
      icon: p.icon,
      imagePath: p.imagePath,
      repoFolder: p.repoFolder,
      entries: [],
      alerts: 0
    })
  }
  for (const s of sessions) {
    const project = mightyProjectForCwd(s.cwd, open)
    const id = project?.id ?? UNASSIGNED
    const entry: SessionEntry = { session: s, row: sessionRow(s, now), activity: activityFor(s) }
    const existing = groups.get(id)
    if (existing) existing.entries.push(entry)
    else
      groups.set(id, {
        id,
        name: project?.name ?? CONFIG.UI_LABELS.CODE_AGENTS_NO_PROJECT,
        icon: project?.icon,
        imagePath: project?.imagePath,
        repoFolder: project?.repoFolder,
        entries: [entry],
        alerts: 0
      })
  }
  const views = [...groups.values()].map((g) => ({
    ...g,
    // 'recent' is last-card-first, falling back to when the pane opened, so a
    // silent new agent still lands above a silent old one.
    entries: sortEntries(g.entries, 'recent'),
    alerts: g.entries.filter(sessionHasAlert).length
  }))
  return views.sort((a, b) => Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED))
}

export function AgentProjectList({
  groups,
  selectedKey,
  showSelected = true,
  keyFor,
  isOnScreen,
  onPick,
  onEditProject,
  onOpenTable,
  onPrepareNewAgent,
  archived,
  archivedCount,
  onToggleArchived,
  onArchive,
  isPinned,
  onPin,
  onNewChat,
  searchRequest = 0,
  onConductorStarted,
  heading = CONFIG.UI_LABELS.CODE_AGENTS_SIDEBAR_TITLE
}: {
  heading?: string
  onConductorStarted?: (pane: string) => void
  groups: AgentGroup[]
  archived?: boolean
  archivedCount?: number
  onToggleArchived?: () => void
  onArchive?: (session: AgentRelaySessionInfo) => void
  isPinned?: (session: AgentRelaySessionInfo) => boolean
  onPin?: (session: AgentRelaySessionInfo) => void
  onNewChat?: () => void
  searchRequest?: number
  selectedKey: string
  showSelected?: boolean
  keyFor: (session: AgentRelaySessionInfo) => string
  isOnScreen?: (session: AgentRelaySessionInfo) => boolean
  onPick: (session: AgentRelaySessionInfo) => void
  /** Absent for the sessions with no project of their own to open. */
  onEditProject?: (projectId: string) => void
  onOpenTable: (projectId: string) => void
  onPrepareNewAgent?: (group: AgentGroup) => void
}): JSX.Element {
  const [folded, fold] = useFolded('agents')
  const sectionShut = folded[FOLD_SECTION] === true
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  const [onlyRunning, setOnlyRunning] = useState(false)
  const only = onlyAlerts || onlyRunning
  // Opening a row spends its alert; without this the row you just opened drops out of the filter.
  const [openedWhileFiltering, setOpenedWhileFiltering] = useState<ReadonlySet<string>>(() => new Set())
  const toggleOnly = (next: 'alerts' | 'running'): void => {
    if (next === 'alerts') setOnlyAlerts((on) => !on)
    else setOnlyRunning((on) => !on)
    setOpenedWhileFiltering(new Set())
  }
  if (only && selectedKey && !openedWhileFiltering.has(selectedKey)) {
    setOpenedWhileFiltering(new Set(openedWhileFiltering).add(selectedKey))
  }
  const [showQuiet, setShowQuiet] = useState(false)
  const [query, setQuery] = useState('')
  const [endedOpen, setEndedOpen] = useState<Record<string, boolean>>({})
  const folding = !archived && !query.trim()
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])
  const [seenSearchRequest, setSeenSearchRequest] = useState(searchRequest)
  if (seenSearchRequest !== searchRequest) {
    setSeenSearchRequest(searchRequest)
    setSearchOpen(true)
    fold(FOLD_SECTION, false)
  }
  useEffect(() => {
    if (searchRequest > 0) searchRef.current?.focus()
  }, [searchRequest])
  const total = useMemo(() => groups.reduce((n, g) => n + g.entries.length, 0), [groups])
  const waiting = useMemo(() => groups.reduce((n, g) => n + g.alerts, 0), [groups])
  const quiet = useMemo(
    () => groups.reduce((n, g) => n + g.entries.filter((e) => !sessionSpoke(e)).length, 0),
    [groups]
  )
  const pinnedHere = useCallback(
    (entry: SessionEntry): boolean => !archived && isPinned?.(entry.session) === true,
    [archived, isPinned]
  )
  const { shownGroups, pinnedEntries } = useMemo(() => {
    const terms = query.trim()
    const keep = (entry: SessionEntry): boolean => {
      if (
        !archived &&
        only &&
        !(onlyAlerts && sessionHasAlert(entry)) &&
        !(onlyRunning && sessionIsRunning(entry)) &&
        !openedWhileFiltering.has(keyFor(entry.session))
      )
        return false
      // A search reaches every agent, including the quiet ones: someone typing a
      // name is asking for that row, not for the default view's shortlist.
      if (!archived && !showQuiet && !onlyRunning && !terms && !sessionSpoke(entry) && !pinnedHere(entry)) return false
      if (terms && !matchesSession(sessionHaystack(entry.session, entry.row), terms)) return false
      return true
    }
    const filtering = archived || only || terms !== ''
    const kept = groups.map((g) => ({ ...g, entries: g.entries.filter(keep) }))
    return {
      pinnedEntries: kept.flatMap((g) => g.entries.filter(pinnedHere)),
      shownGroups: kept
        .map((g) => ({ ...g, entries: g.entries.filter((e) => !pinnedHere(e)) }))
        .filter((g) => g.entries.length > 0 || (!filtering && g.id !== UNASSIGNED))
    }
  }, [groups, only, onlyAlerts, onlyRunning, openedWhileFiltering, keyFor, showQuiet, query, archived, pinnedHere])

  const groupView = (
    group: AgentGroup
  ): {
    shut: boolean
    showAll: boolean
    live: SessionEntry[]
    ended: SessionEntry[]
    endedShown: boolean
    shown: SessionEntry[]
  } => {
    const shut = folded[group.id] === true
    const showAll = expanded[group.id] === true
    const live = folding ? group.entries.filter((e) => e.row.health !== 'ended') : group.entries
    const ended = folding ? group.entries.filter((e) => e.row.health === 'ended') : []
    const endedShown =
      endedOpen[group.id] ?? ended.some((e) => keyFor(e.session) === selectedKey)
    const shown = showAll ? live : live.slice(0, CAP)
    return { shut, showAll, live, ended, endedShown, shown }
  }
  const hotkeyOrder = sectionShut
    ? []
    : [
        ...pinnedEntries,
        ...shownGroups.flatMap((g) => {
          const v = groupView(g)
          return v.shut ? [] : [...v.shown, ...(v.endedShown ? v.ended : [])]
        })
      ].slice(0, HOTKEY_DIGITS.length)
  const hotkeyOrderRef = useRef(hotkeyOrder)
  useEffect(() => {
    hotkeyOrderRef.current = hotkeyOrder
  })
  const onPickRef = useRef(onPick)
  useEffect(() => {
    onPickRef.current = onPick
  })
  useEffect(() => {
    if (!showSelected) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return
      const slot = HOTKEY_DIGITS.indexOf(e.key)
      if (slot < 0) return
      const entry = hotkeyOrderRef.current[slot]
      if (!entry) return
      e.preventDefault()
      e.stopPropagation()
      onPickRef.current(entry.session)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [showSelected])
  const commandHeld = useCommandHeld(showSelected)

  const renderEntry = (entry: SessionEntry): JSX.Element => {
    const session = entry.session
    const key = keyFor(session)
    const row = entry.row
    const name = row.name ?? row.tldr ?? row.agent ?? row.repo ?? ''
    const responding = respondingWithoutNumber(session, row.health)
    const slot = commandHeld ? hotkeyOrder.indexOf(entry) : -1
    return (
      <div
        key={session.sessionId ?? key}
        className="agent-session-row-wrap"
        data-pin={onPin && !archived ? '' : undefined}
        draggable
        onDragStart={(e) =>
          writeCodeDrag(e.dataTransfer, {
            id: session.sessionId ?? session.stated ?? session.label,
            title: name,
            cwd: session.cwd
          })
        }
        onContextMenu={(e) =>
          void showMenu(e, SESSION_MENU, {
            session,
            cwd: session.cwd,
            ended: row.health === 'ended',
            archived: archived === true,
            pinned: pinnedHere(entry),
            open: () => onPick(session),
            pin: onPin && (() => onPin(session)),
            archive: onArchive && (() => onArchive(session))
          })
        }
      >
      <Button variant="bare"
        type="button"
        role="treeitem"
        aria-selected={showSelected && key === selectedKey}
        data-active={(showSelected && key === selectedKey) || isOnScreen?.(session) || undefined}
        className="agent-projects-row"
        aria-label={responding ? `${name}, Responding…` : undefined}
        title={responding ? 'Responding…' : undefined}
        onClick={() => onPick(session)}
      >
        {pinnedHere(entry) && (
          <span className="agent-projects-row-icon" aria-hidden>
            <Terminal size={14} />
          </span>
        )}
        <span className="agent-projects-row-text min-w-0 flex-1">
          {row.unnamed ? (
            <span className="session-title-skeleton skeleton" aria-label="Naming this session" />
          ) : (
            <HoverScroll
              text={name}
              className="agent-projects-row-name"
            />
          )}
        </span>
        {sessionHasAlert(entry) && (
          <span className="agent-projects-dot" aria-hidden />
        )}
        {session.stale === true && !folding && (
          <span className="agent-projects-row-stale">ended</span>
        )}
        {slot >= 0 ? (
          <kbd className="agent-projects-hotkey">⌘{HOTKEY_DIGITS[slot]}</kbd>
        ) : (
          <AgentWorkingMark session={session} health={row.health} compact dot />
        )}
      </Button>
      {onPin && !archived && (
        <Button variant="icon" className="agent-session-pin" title={pinnedHere(entry) ? 'Unpin' : 'Pin to top'} aria-label={`${pinnedHere(entry) ? 'Unpin' : 'Pin'} ${name}`} onClick={() => onPin(session)}>
          {pinnedHere(entry) ? <PinOff size={15} /> : <Pin size={15} />}
        </Button>
      )}
      {onArchive && (
        <Button variant="icon" className="agent-session-archive" title={archived ? 'Restore session' : 'Archive session'} aria-label={`${archived ? 'Restore' : 'Archive'} ${name}`} onClick={() => onArchive(session)}>
          {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
        </Button>
      )}
      </div>
    )
  }

  const emptyBody =
    total === 0
      ? archived ? 'No archived sessions.' : 'No sessions to show.'
      : query.trim()
        ? CONFIG.UI_LABELS.CODE_AGENTS_NO_MATCH
        : onlyAlerts && onlyRunning
          ? CONFIG.UI_LABELS.CODE_AGENTS_NO_ALERTS_OR_RUNNING
          : onlyAlerts
          ? CONFIG.UI_LABELS.CODE_AGENTS_NO_ALERTS
          : onlyRunning
            ? CONFIG.UI_LABELS.CODE_AGENTS_NO_RUNNING
            : null

  return (
    <div className="agent-projects-list flex min-h-0 flex-1 flex-col" role="tree">
      <div className="group/head flex shrink-0 items-center px-2.5 pb-[5px] pt-4 text-[11.5px] font-semibold text-muted">
        {archived ? (
          <span>Archived sessions</span>
        ) : (
          <Button
            variant="bare"
            onClick={() => onOpenTable(ALL_SESSIONS_TABLE)}
            className="flex items-center gap-1.5 rounded-md text-[11.5px] font-semibold hover:text-on-surface"
            title={CONFIG.UI_LABELS.CODE_AGENTS_TABLE_OPEN_ALL}
          >
            {heading}
          </Button>
        )}
        <Button
          variant="bare"
          onClick={() => fold(FOLD_SECTION, !sectionShut)}
          aria-expanded={!sectionShut}
          aria-label={`${sectionShut ? CONFIG.UI_LABELS.SIDEBAR_EXPAND : CONFIG.UI_LABELS.SIDEBAR_COLLAPSE} ${heading}`}
          title={sectionShut ? CONFIG.UI_LABELS.SIDEBAR_EXPAND : CONFIG.UI_LABELS.SIDEBAR_COLLAPSE}
          className="ml-0.5 grid place-items-center rounded-md p-1 hover:text-on-surface"
        >
          <FoldChevron shut={sectionShut} />
        </Button>
        {sectionShut && waiting > 0 && <span className="agent-projects-dot !ml-1.5" title={`${waiting} waiting on you`} />}
        <div className={`ml-auto flex items-center gap-0.5 ${sectionShut ? '[&>.agent-projects-tool]:hidden' : ''}`}>
          <Button
            variant="bare"
            onClick={() => {
              if (searchOpen) {
                setSearchOpen(false)
                setQuery('')
              } else {
                setSearchOpen(true)
              }
            }}
            className={`agent-projects-tool grid place-items-center rounded-md p-1 ${searchOpen ? 'text-on-surface' : ''}`}
            data-on={searchOpen ? '' : undefined}
            title={CONFIG.UI_LABELS.CODE_AGENTS_SEARCH}
          >
            <Search size={13} />
          </Button>
          <Button
            variant="bare"
            className="agent-projects-tool grid place-items-center rounded-md p-1"
            data-on={onlyAlerts ? '' : undefined}
            aria-pressed={onlyAlerts}
            onClick={() => toggleOnly('alerts')}
            title={CONFIG.UI_LABELS.CODE_AGENTS_ONLY_ALERTS}
          >
            <Bell size={13} />
          </Button>
          <Button
            variant="bare"
            className="agent-projects-tool grid place-items-center rounded-md p-1"
            data-on={onlyRunning ? '' : undefined}
            aria-pressed={onlyRunning}
            onClick={() => toggleOnly('running')}
            title={CONFIG.UI_LABELS.CODE_AGENTS_ONLY_RUNNING}
          >
            <CircleDot size={13} />
          </Button>
          {onToggleArchived && (archived || (archivedCount ?? 0) > 0) && (
            <Button
              variant="bare"
              className="agent-projects-tool grid place-items-center rounded-md p-1"
              data-on={archived ? '' : undefined}
              aria-pressed={archived}
              onClick={onToggleArchived}
              title={archived ? 'Back to sessions' : `Archived (${archivedCount ?? 0})`}
            >
              <Archive size={13} />
            </Button>
          )}
          {onNewChat && !archived && (
            <Button
              variant="bare"
              onClick={onNewChat}
              className="grid place-items-center rounded-md p-1 hover:text-on-surface"
              title={CONFIG.UI_LABELS.CODE_AGENTS_NEW_CHAT}
              aria-label={CONFIG.UI_LABELS.CODE_AGENTS_NEW_CHAT}
            >
              <Plus size={15} />
            </Button>
          )}
        </div>
      </div>
      {searchOpen && !sectionShut && (
        <div className="px-2.5 py-2 border-b border-surface3 shrink-0">
          <div className="flex items-center gap-1.5 rounded-lg bg-surface1 border border-surface3 px-2 py-1 focus-within:border-blue">
            <Search size={13} className="text-muted shrink-0" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={CONFIG.UI_LABELS.CODE_AGENTS_SEARCH_PLACEHOLDER}
              aria-label={CONFIG.UI_LABELS.CODE_AGENTS_SEARCH}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchOpen(false)
                  setQuery('')
                }
              }}
              className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </div>
        </div>
      )}
      <div className={`flex-1 min-h-0 overflow-y-auto ${sectionShut ? 'hidden' : ''}`}>
        {emptyBody && shownGroups.length === 0 && pinnedEntries.length === 0 && (
          <div className="px-3 text-sm text-muted text-center py-8">{emptyBody}</div>
        )}
      {pinnedEntries.length > 0 && (
        <div className="agent-projects-group mb-1">
          <div className="flex items-center gap-1.5 px-2.5 pb-[5px] pt-3 text-[11.5px] font-semibold text-muted">
            <Pin size={11} />
            Pinned
          </div>
          {pinnedEntries.map(renderEntry)}
        </div>
      )}
      {shownGroups.map((group) => {
        const { shut, showAll, live, ended, endedShown, shown } = groupView(group)
        const full = groups.find((g) => g.id === group.id) ?? group
        const cwd = groupCwd(full)
        return (
          <div key={group.id} className="agent-projects-group mb-1" data-project="">
            <div
              className="agent-projects-headrow"
              onContextMenu={(e) =>
                void showMenu(e, PROJECT_MENU, {
                  cwd,
                  collapsed: shut,
                  toggleCollapsed: () => fold(group.id, !shut),
                  openAll: () => onOpenTable(group.id),
                  startAgent: onPrepareNewAgent && (() => onPrepareNewAgent(full)),
                  edit: onEditProject && group.id !== UNASSIGNED ? () => onEditProject(group.id) : undefined
                })
              }
            >
              <ProjectGroupHeader
                name={group.name}
                count={live.length}
                collapsed={shut}
                alertCount={group.alerts}
                icon={group.id === UNASSIGNED ? 'folder' : group.icon}
                imagePath={group.imagePath}
                onToggle={() => fold(group.id, !shut)}
                alertFilterOn={onlyAlerts}
                onAlertClick={() => {
                  if (!onlyAlerts) fold(group.id, false)
                  toggleOnly('alerts')
                }}
              />
              <span className="agent-projects-actions">
                <Button
                  variant="bare"
                  className="agent-projects-action"
                  aria-label={`${CONFIG.UI_LABELS.CODE_PROJECT_HOME}: ${group.name}`}
                  title={CONFIG.UI_LABELS.CODE_PROJECT_HOME}
                  onClick={() => onOpenTable(group.id)}
                >
                  <House size={13} />
                </Button>
                {cwd && (
                  <Button
                    variant="bare"
                    className="agent-projects-action"
                    aria-label={`Start an agent in ${group.name}`}
                    title={CONFIG.UI_LABELS.CODE_AGENTS_START_IN_APP}
                    disabled={!cwd}
                    onClick={() => cwd && onPrepareNewAgent?.(full)}
                  >
                    <Plus size={13} />
                  </Button>
                )}
                {onEditProject && group.id !== UNASSIGNED && (
                  <Button
                    variant="bare"
                    className="agent-projects-edit"
                    title={`Edit ${group.name}`}
                    aria-label={`Edit ${group.name}`}
                    onClick={() => onEditProject(group.id)}
                  >
                    <Pencil size={12} />
                  </Button>
                )}
              </span>
            </div>
            {!shut && (
              <>
                {shown.map(renderEntry)}
                {((live.length === 0 && cwd && onPrepareNewAgent) || live.length > CAP || ended.length > 0) && (
                  <div className="agent-projects-foot">
                    {live.length === 0 && cwd && onPrepareNewAgent && (
                      <Button variant="bare" className="agent-projects-more" onClick={() => onPrepareNewAgent(full)}>
                        {CONFIG.UI_LABELS.CODE_AGENTS_START_IN_APP}
                      </Button>
                    )}
                    {ended.length > 0 && (
                      <Button
                        variant="bare"
                        className="agent-projects-more"
                        aria-expanded={endedShown}
                        onClick={() => setEndedOpen((prev) => ({ ...prev, [group.id]: !endedShown }))}
                      >
                        {endedShown
                          ? CONFIG.UI_LABELS.CODE_AGENTS_HIDE_FINISHED
                          : `${ended.length} ${CONFIG.UI_LABELS.CODE_AGENTS_FINISHED}`}
                      </Button>
                    )}
                    {live.length > CAP && (
                      <Button
                        variant="bare"
                        className="agent-projects-more"
                        data-hover-only={showAll ? undefined : ''}
                        onClick={() => setExpanded((prev) => ({ ...prev, [group.id]: !showAll }))}
                      >
                        {showAll ? CONFIG.UI_LABELS.SIDEBAR_SHOW_LESS : CONFIG.UI_LABELS.SIDEBAR_SHOW_MORE}
                      </Button>
                    )}
                  </div>
                )}
                {endedShown && (
                  <div data-finished="" className="pl-4">
                    {ended.map(renderEntry)}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}
      {quiet > 0 && !query.trim() && !only && (
        <Button
          variant="bare"
          className="agent-projects-quiet"
          onClick={() => setShowQuiet((on) => !on)}
        >
          {showQuiet
            ? CONFIG.UI_LABELS.CODE_AGENTS_HIDE_QUIET
            : `${quiet} ${quiet === 1 ? CONFIG.UI_LABELS.CODE_AGENTS_QUIET_ONE : CONFIG.UI_LABELS.CODE_AGENTS_QUIET_MANY}`}
        </Button>
      )}
      </div>
      {onConductorStarted && !archived && <ConductorImport onStarted={onConductorStarted} />}
    </div>
  )
}
