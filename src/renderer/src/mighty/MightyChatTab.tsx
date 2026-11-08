import { JSX, type ComponentProps, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, FolderPlus, Folders, LayoutGrid, Loader2, MessageSquare, Pencil, Pin, PinOff, Plus, Search, SlidersHorizontal, SquarePen } from 'lucide-react'
import { Button } from '../components/Button'
import { ProjectGroupHeader } from '../components/ProjectIcon'

// The user's tree has 1,234 chats in one group - rendering them all is what made the sidebar crawl.
const SIDEBAR_CHAT_CAP = 5
const UNASSIGNED_SIDEBAR_KEY = 'unassigned'
const FOLD_PINNED = 'section:pinned'
const FOLD_PROJECTS = 'section:projects'
const FOLD_CHATS = 'section:chats'
import { ZoomIndicator } from '../components/ZoomIndicator'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { ConversationPane } from './ConversationPane'
import { normalizeWorkspaceTabs } from './workspace-normalize'
import { nextWorkspaceName } from './workspace-naming'
import { pruneDeadPaneBindings } from './prune-pane-bindings'
import {
  paneRenderKey,
  recordCreatedSession,
  setPendingProject,
  switchBinding
} from './pane-binding'
import { effectiveProjectIdForPane } from './effective-project'
import { chatOpenState, firstEmptyPaneId, focusedPaneId, sessionsOpenElsewhere } from './pane-selection'
import { neverSent } from './pending-draft'
import { sessionColorMap } from './pane-colors'
import { MAX_PANES_PER_TAB } from './pane-layout'
import { tabDisplayViewMode } from './tab-view-mode'
import { NerdWorkspace, useWorkspaceActions, type GridRequest } from './NerdWorkspace'
import { CodeAgentPane, type CodeAgentRelay } from './CodeAgentPane'
import { CONFIG } from '../../../shared/config'
import { buildSnippet, fuzzyMatch, MATCH_SCORE } from '../../../shared/fuzzy'
import type {
  MightySession,
  MightyTurn,
  ChatTabNameFormat,
  MightyProject,
  ChatWorkspaceTab,
  ChatPaneRef,
  PaneLayoutState
} from '../../../shared/types'

import { SessionRow, ProjectSettingsModal } from './MightySessionNavigation'
import { AllProjectsModal } from './AllProjectsModal'
import { SidebarRow, SidebarSection } from './MightySidebar'
import { useFolded } from '../hooks/useFolded'
import { ContextRail } from './MightyConversationView'
import { ChatDetails } from './chat-details'
import { RailModeSwitch, SideBrowser } from '../components/side-browser'
import { ConversationMediaProvider } from '../components/media-viewer'
import { mediaIn } from '../components/local-path'
import { RAIL_PANEL, useRailBrowserShortcut, useRailMode } from '../hooks/useRailMode'
import { useRailResize } from '../hooks/useRailResize'
import { PaneZoom, PaneZoomIndicator } from './pane-zoom'
import {
  sourceGroupOf,
  hasRealExchange,
  MOVE_MENU_GAP,
  MOVE_MENU_MARGIN,
  SOURCE_MENU_W,
  TITLE_RANK_BOOST,
  SIDEBAR_SOURCE_GROUPS,
  type HistoryHandoff,
  type SearchHit
} from './mighty-shared'
// ── Chat tab ───────────────────────────────────────────────────────────────────

const EMPTY_PANE_LAYOUT: PaneLayoutState = {}

/** One fresh tab: a single pane, no bound session yet (lazy-created on first send —
 *  mirrors the pre-multi-pane app's "New chat" behavior exactly). `format` is the
 *  user's tab-naming preference; it defaults so the two "never leave the strip empty"
 *  fallbacks below can mint a tab before the async settings read has landed. */
function makeWorkspaceTab(
  existingTabs: ChatWorkspaceTab[],
  format: ChatTabNameFormat = CONFIG.MIGHTY.DEFAULT_TAB_NAME_FORMAT
): ChatWorkspaceTab {
  return {
    id: crypto.randomUUID(),
    name: nextWorkspaceName(existingTabs, format),
    panes: [{ id: crypto.randomUUID(), sessionId: null }],
    layout: EMPTY_PANE_LAYOUT,
    createdAt: new Date().toISOString()
  }
}

export function ChatTab({
  name,
  nameFormat,
  handoff,
  onHandoffConsumed,
  showRail,
  toggleSidebar,
  setShowList,
  projectsRevision = 0,
  actionsSlot,
  listSlot,
  onShowChat,
  visible,
  chatMode,
  nerdMode,
  onNerdMode,
  relay,
  gridRequest,
  onAgentsOnScreen,
  onProjectInView,
  allMode = false
}: {
  name: string
  /** Live tab-naming preference pushed down when Settings changes it, else null. */
  nameFormat: ChatTabNameFormat | null
  /** A History-tab Reuse/Continue request to apply to this chat, or null. */
  handoff: HistoryHandoff | null
  /** Called once the handoff above has been applied, so the parent can clear it
   *  (otherwise the same request would re-fire on the next render). */
  onHandoffConsumed: () => void
  showRail: boolean
  toggleSidebar: () => void
  /** For the local "reveal the drawer on new chat" affordance (line ~418). */
  setShowList: (on: boolean) => void
  projectsRevision?: number
  actionsSlot: HTMLElement | null
  listSlot: HTMLElement | null
  onShowChat: () => void
  visible: boolean
  chatMode: boolean
  nerdMode: boolean
  onNerdMode: (on: boolean) => void
  relay: CodeAgentRelay
  gridRequest: GridRequest | null
  onAgentsOnScreen: (labels: string[]) => void
  onProjectInView?: (project: MightyProject | undefined) => void
  allMode?: boolean
}): JSX.Element {
  const [sessions, setSessions] = useState<MightySession[]>([])
  const [projects, setProjects] = useState<MightyProject[]>([])
  const [folded, fold] = useFolded('chat')
  const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({})
  const [allProjectsOpen, setAllProjectsOpen] = useState(false)
  // Session id whose "move to project" menu is open, or null.
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null)
  // Project being created/edited in the settings modal, or null when closed.
  // 'new' is a synthetic id meaning "not yet created" — the modal still edits a
  // MightyProject shape, just without a persisted id until Save.
  const [editingProject, setEditingProject] = useState<MightyProject | null>(null)
  // Set when the editor was opened from a session's "New project" menu item: the
  // chat that asked for the project gets moved into it as soon as it's created,
  // so "New project" from a row is one gesture, not create-then-move-again.
  const [pendingProjectFor, setPendingProjectFor] = useState<string | null>(null)
  // Inline conversation filter (⌘F). Empty = show everything.
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterInputRef = useRef<HTMLInputElement>(null)
  // Source filter (the funnel next to ⌘F): hidden group keys, and whether to list
  // conversations nothing was ever sent in. Both seeded from PREFS on mount; the
  // show-empty default is false, so the pre-load render already hides them and the
  // list doesn't visibly cull itself a beat after opening.
  const [hiddenSources, setHiddenSources] = useState<string[]>([])
  const [showEmpty, setShowEmpty] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const sourceMenuRef = useRef<HTMLDivElement>(null)
  const sourceBtnRef = useRef<HTMLButtonElement>(null)
  // Portalled + clamped for the same reason as SessionRow's move menu (see there):
  // the sidebar is user-resizable, so no fixed left/right anchor stays on-screen at
  // every width — anchoring right ran this menu off the window's left edge.
  const [sourceMenuPos, setSourceMenuPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0
  })

  useLayoutEffect(() => {
    if (!sourceMenuOpen || !sourceBtnRef.current) return
    const r = sourceBtnRef.current.getBoundingClientRect()
    setSourceMenuPos({
      top: r.bottom + MOVE_MENU_GAP,
      left: Math.min(
        Math.max(MOVE_MENU_MARGIN, r.left),
        window.innerWidth - SOURCE_MENU_W - MOVE_MENU_MARGIN
      )
    })
  }, [sourceMenuOpen])
  // Turns of whichever pane is currently focused — mirrored up by that pane's
  // onTurnsChange so the tab-level context rail (Outputs/Sources) has something to
  // show without owning a session itself. Reset on tab/pane focus change so the
  // rail doesn't keep showing the PREVIOUS pane's outputs for a render or two.
  const [focusedPaneTurns, setFocusedPaneTurns] = useState<MightyTurn[]>([])
  const [focusedPendingSources, setFocusedPendingSources] = useState<string[]>([])
  const focusedAttachPickRef = useRef<(() => void) | null>(null)
  // Live runId per pane, mirrored up by each pane's onRunChange. Esc reads this to
  // stop what's running before it hides the window. A ref, not state: the Esc
  // handler only needs the value at keypress time, and re-rendering every pane on
  // each run start/stop would be pure waste.
  const liveRunsRef = useRef<Map<string, string>>(new Map())
  const trackPaneRun = useCallback((paneId: string, runId: string | null): void => {
    if (runId === null) liveRunsRef.current.delete(paneId)
    else liveRunsRef.current.set(paneId, runId)
  }, [])

  const openFilter = useCallback(() => {
    setShowList(true)
    void window.api.mighty.setSidebarShown(true)
    setFilterOpen(true)
    // Focus after the input mounts.
    setTimeout(() => filterInputRef.current?.focus(), 0)
  }, [])

  // Backend picker, onPhase/onEvent live-activity subscriptions, and liveTimeline now
  // live per-pane in ConversationPane.tsx (sessionId-filtered, so concurrent panes on
  // different backends/runs never cross-talk) — see its refreshBackendPrefs/chooseBackend.
  const loadSessions = useCallback(async (): Promise<MightySession[]> => {
    const all = await window.api.mighty.listSessions()
    // Most-recent first for the drawer.
    all.sort((a, b) => (a.updated < b.updated ? 1 : -1))
    setSessions(all)
    return all
  }, [])

  const loadProjects = useCallback(async (): Promise<MightyProject[]> => {
    const all = await window.api.mighty.listProjects()
    setProjects(all)
    return all
  }, [])

  useEffect(() => {
    void loadProjects()
    void loadSessions()
    void window.api.settingsGetPrefs().then((p) => {
      setHiddenSources(p.mightySourceFilterHidden ?? [])
      setShowEmpty(p.mightyShowEmpty === true)
    })
  }, [loadProjects, loadSessions])

  useEffect(() => window.api.mighty.onProjectsChanged(() => void loadProjects()), [loadProjects])
  useEffect(() => window.api.mighty.onTurnAppended(() => void loadSessions()), [loadSessions])

  useEffect(() => {
    if (projectsRevision === 0) return
    void loadProjects()
  }, [projectsRevision, loadProjects])

  // Close the source menu on an outside click, same as the History filter popover.
  useEffect(() => {
    if (!sourceMenuOpen) return
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Node
      // The menu is portalled to <body>, so the button is NOT inside it — both have
      // to be excluded or clicking the button would close and instantly reopen it.
      if (!sourceMenuRef.current?.contains(t) && !sourceBtnRef.current?.contains(t)) {
        setSourceMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [sourceMenuOpen])

  // send/newChat/openSession, the mount-resume effect, onStartFresh/onOpenSession/
  // onTurnAppended subscriptions, and the History reuse/continue handoff all now live
  // per-pane in ConversationPane.tsx — moved out of this singleton MightyApp scope by
  // the multi-pane refactor so N concurrent panes never share one `session`/`busy`/
  // `phase` var. Cold-open (?session=/?fresh=1) and already-open-window
  // (onOpenSession/onStartFresh) routing were re-added above, targeted at
  // openSessionInActivePane/newChatInActivePane instead of the old setSession.

  const deleteSession = useCallback(
    async (id: string) => {
      await window.api.mighty.deleteSession(id)
      // Unbind every pane showing it. A pane left holding a dead id keeps the
      // deleted turns on screen, and its next send hits startTurn with an unknown
      // id — which MINTS a fresh session rather than failing, so the reply lands in
      // a chat the pane isn't showing.
      setTabs((prev) =>
        prev.map((t) => ({
          ...t,
          panes: t.panes.map((p) => (p.sessionId === id ? switchBinding(p, null) : p))
        }))
      )
      void loadSessions()
    },
    [loadSessions]
  )

  const toggleProjectPin = useCallback(
    async (p: MightyProject) => {
      const ok = await window.api.mighty.setProjectPinned(p.id, !p.pinned)
      if (ok) void loadProjects()
    },
    [loadProjects]
  )

  const toggleSessionPin = useCallback(
    async (s: MightySession) => {
      const ok = await window.api.mighty.setSessionPinned(s.id, !s.pinned)
      if (ok) void loadSessions()
    },
    [loadSessions]
  )

  const toggleSessionArchived = useCallback(
    async (s: MightySession) => {
      const ok = await window.api.mighty.setSessionArchived(s.id, !s.archived)
      if (ok) void loadSessions()
    },
    [loadSessions]
  )

  const moveSessionToProject = useCallback(
    async (sessionId: string, projectId: string | undefined) => {
      setMoveMenuFor(null)
      const ok = await window.api.mighty.assignSessionProject(sessionId, projectId)
      if (!ok) return
      void loadSessions()
    },
    [loadSessions]
  )

  const saveProject = useCallback(
    async (project: MightyProject) => {
      const trimmed = { ...project, name: project.name.trim() }
      if (trimmed.name === '') return
      const saved = await window.api.mighty.upsertProject(trimmed)
      if (!saved) return
      setEditingProject(null)
      // Created from a session row's "New project"? Move that chat straight in.
      if (pendingProjectFor && saved.id) {
        await moveSessionToProject(pendingProjectFor, saved.id)
        setPendingProjectFor(null)
      }
      void loadProjects()
    },
    [loadProjects, moveSessionToProject, pendingProjectFor]
  )

  const deleteProject = useCallback(
    async (id: string) => {
      // Deleting a project unassigns its sessions (they move to Unassigned) —
      // it never cascades to delete the conversations themselves.
      await window.api.mighty.deleteProject(id)
      setEditingProject(null)
      void loadProjects()
      void loadSessions()
    },
    [loadProjects, loadSessions]
  )

  const [tabs, setTabs] = useState<ChatWorkspaceTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [activePaneByTab, setActivePaneByTab] = useState<Record<string, string>>({})
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // A ref, not state: only read at the moment a tab is minted, never rendered. Seeded
  // here and kept fresh by the Settings tab pushing changes down via `nameFormat`.
  const tabNameFormat = useRef<ChatTabNameFormat>(CONFIG.MIGHTY.DEFAULT_TAB_NAME_FORMAT)
  useEffect(() => {
    void (async () => {
      tabNameFormat.current = (await window.api.mighty.getSettings()).tabNameFormat
    })()
  }, [])
  useEffect(() => {
    if (nameFormat) tabNameFormat.current = nameFormat
  }, [nameFormat])

  // Load once on mount. An empty result (first run, or nothing ever persisted) falls
  // back to today's single-pane default so the window never opens to a blank strip.
  useEffect(() => {
    void (async () => {
      const restored = await window.api.mighty.getWorkspaces()
      // Persisted pane bindings outlive the sessions they point at (deleted in an
      // earlier launch, or a wiped store). The store validates SHAPE only, so drop
      // ids that no longer resolve — same reason as deleteSession above.
      // A pane left on a dictation nobody sent looks like an empty new chat, and the next message lands under it.
      const pruned = await pruneDeadPaneBindings(restored, async (id) => {
        const s = await window.api.mighty.getSession(id)
        return s !== null && !neverSent(s)
      })
      const initial = normalizeWorkspaceTabs(pruned.length > 0 ? pruned : [makeWorkspaceTab([])])
      setTabs(initial)
      setActiveTabId(initial[0].id)
      setActivePaneByTab(
        Object.fromEntries(
          initial.map((t) => [t.id, t.panes.find((p) => p.sessionId)?.id ?? firstEmptyPaneId(t) ?? t.panes[0].id])
        )
      )
      setWorkspacesLoaded(true)
    })()
  }, [])

  // Persist on every structural change (tab/pane add/remove, resize-ratio change,
  // pane binding to a session on first send). Debounced so a resize drag (which can
  // fire onLayoutChange many times a second while dragging — see PaneGrid) doesn't
  // spam disk writes.
  const debouncedTabs = useDebouncedValue(tabs, CONFIG.MIGHTY.WORKSPACES_SAVE_DEBOUNCE_MS)
  useEffect(() => {
    if (!workspacesLoaded) return
    void window.api.mighty.setWorkspaces(normalizeWorkspaceTabs(debouncedTabs))
  }, [debouncedTabs, workspacesLoaded])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // THE cursor. Every surface that asks "which conversation am I in?" — the sidebar
  // highlight, the pane border, the rail, the handoff router — resolves it through
  // here, so they cannot drift apart.
  const focusedPaneFor = useCallback(
    (tab: ChatWorkspaceTab | null): string | null => focusedPaneId(tab, activePaneByTab),
    [activePaneByTab]
  )
  const activePaneId = focusedPaneFor(activeTab)
  const railKey = activeTab?.panes.find((p) => p.id === activePaneId)?.sessionId ?? activePaneId ?? 'chat'
  const [railMode, setRailMode] = useRailMode(`chat:${railKey}`)
  const railSession = sessions.find((s) => s.id === railKey)
  const railProject = projects.find((p) => p.id === railSession?.projectId)
  const focusedPane = activeTab?.panes.find((p) => p.id === activePaneId)
  const projectInViewId = railSession?.projectId ?? focusedPane?.pendingProjectId
  const projectInView = projects.find((p) => p.id === projectInViewId && !p.archived)
  useEffect(() => onProjectInView?.(projectInView), [projectInView, onProjectInView])
  const chatMedia = useMemo(
    () =>
      mediaIn(
        focusedPaneTurns.map((t) => ({ text: `${t.q}\n${t.a}`, files: [...(t.sources ?? []), ...(t.artifacts ?? [])] }))
      ),
    [focusedPaneTurns]
  )
  useRailBrowserShortcut(visible, () => setRailMode('browser'))
  const layoutRef = useRef<HTMLDivElement>(null)
  const browsingRail = railMode === 'browser'
  const railResize = useRailResize(layoutRef)

  useEffect(() => {
    setFocusedPendingSources([])
  }, [activePaneId, activeTabId])

  const registerFocusedAttach = useCallback((pick: (() => void) | null) => {
    focusedAttachPickRef.current = pick
  }, [])

  /** Rewrite one pane in one tab. The two binding operations below are its only users. */
  const updatePane = useCallback(
    (tabId: string, paneId: string, next: (pane: ChatPaneRef) => ChatPaneRef) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id !== tabId ? t : { ...t, panes: t.panes.map((p) => (p.id === paneId ? next(p) : p)) }
        )
      )
    },
    []
  )

  // Two operations, and conflating them is what made panes show the wrong chat.
  // switchPaneSession bumps bindGen so the pane REMOUNTS and keeps nothing;
  // setPaneSession must not, because the pane is reporting a session it minted for
  // its own in-flight send and a remount there kills the live run. Keep them apart.

  /** The pane finished creating its own session mid-send — record the id only. */
  const setPaneSession = useCallback(
    (tabId: string, paneId: string, sessionId: string) =>
      updatePane(tabId, paneId, (p) => recordCreatedSession(p, sessionId)),
    [updatePane]
  )

  /** The user pointed this pane at another chat (or none) — remount it. */
  const switchPaneSession = useCallback(
    (tabId: string, paneId: string, sessionId: string | null, pendingProjectId?: string) =>
      updatePane(tabId, paneId, (p) => switchBinding(p, sessionId, pendingProjectId)),
    [updatePane]
  )

  const [agentFirstSend, setAgentFirstSend] = useState<Record<string, { message: string; paths: string[] }>>({})
  const bindPaneAgent = useCallback(
    (tabId: string, paneId: string, agent: { label: string } | { cwd: string }) =>
      updatePane(tabId, paneId, (p) => ({
        ...switchBinding(p, null),
        ...('label' in agent ? { agentLabel: agent.label } : { agentCwd: agent.cwd })
      })),
    [updatePane]
  )

  const setPendingProjectOnPane = useCallback(
    (tabId: string, paneId: string, pendingProjectId?: string) =>
      updatePane(tabId, paneId, (p) => setPendingProject(p, pendingProjectId)),
    [updatePane]
  )

  const makeTab = useCallback(() => makeWorkspaceTab(tabsRef.current, tabNameFormat.current), [])
  const workspace = useWorkspaceActions({
    tabsRef,
    setTabs,
    activeTabId,
    setActiveTabId,
    activePaneByTab,
    setActivePaneByTab,
    makeTab,
    sessions
  })

  const openSessionInActivePane = useCallback(
    (id: string) => {
      if (nerdMode) return workspace.openSessionPlanned(id)
      if (!activeTab || !activePaneId) return
      if (activeTab.panes.find((p) => p.id === activePaneId)?.sessionId === id) return
      switchPaneSession(activeTab.id, activePaneId, id)
    },
    [nerdMode, workspace, activeTab, activePaneId, switchPaneSession]
  )

  const openSixPanes = useCallback(() => {
    if (!activeTab) return
    onNerdMode(true)
    workspace.addPanes(activeTab.id, MAX_PANES_PER_TAB)
  }, [activeTab, onNerdMode, workspace])

  // Lazy: unbind the pane and let the first send mint the
  // session. Creating one eagerly here wrote a turn-less row to sessions.jsonl on
  // every "+"/⌘N — invisible in the sidebar (listSessions used to filter it) but
  // live in the pane, so the two surfaces showed different things.
  const newChatInActivePane = useCallback(
    async (projectId?: string) => {
      if (!activeTab || !activePaneId) return
      const pane = activeTab.panes.find((p) => p.id === activePaneId)
      const inherited = projectId ?? (pane ? effectiveProjectIdForPane(pane, sessions) : undefined)
      switchPaneSession(activeTab.id, activePaneId, null, inherited)
    },
    [activeTab, activePaneId, switchPaneSession, sessions]
  )

  // A History Continue whose run still resolves to a real session: open that session
  // in the active pane and consume the handoff here, so it never reaches the pane's
  // seed-a-transient-copy path. Handoffs without an openSessionId (older rows) fall
  // through untouched. Keyed on nonce so continuing the same row twice re-fires.
  useEffect(() => {
    if (!handoff?.openSessionId || handoff.kind !== 'continue') return
    openSessionInActivePane(handoff.openSessionId)
    onHandoffConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.nonce])

  useEffect(() => {
    if (!gridRequest) return
    if (gridRequest.kind === 'agent' && !nerdMode && activeTab && activePaneId)
      bindPaneAgent(activeTab.id, activePaneId, { label: gridRequest.label })
    else if (gridRequest.kind === 'agent') workspace.openAgentPlanned(gridRequest.label)
    else workspace.openSix(gridRequest.cwd, gridRequest.count)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridRequest?.nonce])

  // Cold-open routing: the main process appends `?session=<id>` or `?fresh=1` to the
  // FIRST load of this window (see mighty-window.ts showMightyWindow) when expanding
  // from a live panel conversation or an empty panel, respectively. Gate on
  // workspacesLoaded so this never races the restored-tabs effect above.
  useEffect(() => {
    if (!workspacesLoaded) return
    const params = new URLSearchParams(window.location.search)
    const sessionId = params.get('session')
    const fresh = params.get('fresh') === '1'
    // ?focus= routes to the Library tab instead — handled in MightyApp, which owns
    // the tab state (this effect runs inside ChatTab).
    const focus = params.get('focus')
    const win = params.get('window')
    window.history.replaceState(null, '', win ? `?window=${win}` : window.location.pathname)
    if (focus !== null) return
    if (sessionId) openSessionInActivePane(sessionId)
    else if (fresh) void newChatInActivePane(params.get('project') ?? undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacesLoaded])

  // Already-open-window routing: the main process sends these over IPC instead of
  // reloading the window (see showMightyWindow's mightyWindow.webContents.send branch).
  useEffect(() => {
    const offOpen = window.api.mighty.onOpenSession((id) => {
      openSessionInActivePane(id)
      onShowChat()
    })
    const offFresh = window.api.mighty.onStartFresh((projectId) => {
      void newChatInActivePane(projectId)
      onShowChat()
    })
    return () => {
      offOpen()
      offFresh()
    }
  }, [openSessionInActivePane, newChatInActivePane, onShowChat])

  useEffect(() => {
    if (visible || !chatMode) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'n') return
      e.preventDefault()
      void newChatInActivePane()
      onShowChat()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, chatMode, newChatInActivePane, onShowChat])

  const orderedSessions = sessions
  const activePane = activeTab?.panes.find((p) => p.id === activePaneId) ?? null
  const focusMode = activeTab !== null && tabDisplayViewMode(activeTab) === 'single'
  const openElsewhere = useMemo(
    () => (nerdMode && !focusMode ? sessionsOpenElsewhere(activeTab, activePaneId) : new Set<string>()),
    [nerdMode, focusMode, activeTab, activePaneId]
  )
  const agentsOnScreenKey = (nerdMode && activeTab ? activeTab.panes : [])
    .filter((p) => !focusMode || p.id === activePaneId)
    .flatMap((p) => (p.agentLabel ? [p.agentLabel] : []))
    .join('\n')
  useEffect(
    () => onAgentsOnScreen(agentsOnScreenKey ? agentsOnScreenKey.split('\n') : []),
    [agentsOnScreenKey, onAgentsOnScreen]
  )
  const openColors = useMemo(
    () => (nerdMode && activeTab && activeTab.panes.length > 1 ? sessionColorMap(activeTab) : null),
    [nerdMode, activeTab]
  )

  const cycleSession = useCallback(
    (dir: 1 | -1) => {
      if (orderedSessions.length === 0) return
      const idx = orderedSessions.findIndex((s) => s.id === activePane?.sessionId)
      // No current selection → first (down) / last (up). Otherwise step and wrap.
      const nextIdx =
        idx === -1
          ? dir === 1
            ? 0
            : orderedSessions.length - 1
          : (idx + dir + orderedSessions.length) % orderedSessions.length
      openSessionInActivePane(orderedSessions[nextIdx].id)
    },
    [orderedSessions, activePane, openSessionInActivePane]
  )

  // Chat-tab keyboard shortcuts. Registered once; reads live state via the deps.
  //   ⌘F  filter conversations     ⌘\  toggle sidebar
  //   ⌘N  new chat (active pane) ⌘⇧N new project             ⌘↑/⌘↓ cycle chats
  //   Esc closes open menus / the project editor (composer keeps its own).
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (editingProject) {
          setPendingProjectFor(null)
          return setEditingProject(null)
        }
        if (moveMenuFor) return setMoveMenuFor(null)
        if (filterOpen) {
          setFilterOpen(false)
          setFilter('')
          return
        }
        // Nothing left to close, so Esc escalates: stop every live run first, and
        // only hide the window once a later press finds nothing still running.
        // Two presses when busy is deliberate — hiding mid-run would look like the
        // stop silently failed.
        const live = [...liveRunsRef.current.values()]
        if (live.length > 0) {
          for (const runId of live) void window.api.mighty.stopRun(runId)
          return
        }
        if (nerdMode && activeTab && activeTab.panes.length > 1 && !focusMode) {
          return workspace.setViewMode(activeTab.id, 'single')
        }
        if (nerdMode) return onNerdMode(false)
        void window.api.mighty.hide()
        return
      }
      if (!e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'f' && !e.shiftKey) {
        e.preventDefault()
        openFilter()
      } else if (k === '\\') {
        e.preventDefault()
        toggleSidebar()
      } else if (k === 'n' && e.shiftKey) {
        e.preventDefault()
        setEditingProject({ id: '', name: '', created: '', updated: '' })
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        void newChatInActivePane()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        cycleSession(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        cycleSession(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    visible,
    editingProject,
    moveMenuFor,
    filterOpen,
    openFilter,
    toggleSidebar,
    newChatInActivePane,
    cycleSession,
    nerdMode,
    activeTab,
    focusMode,
    workspace,
    onNerdMode
  ])

  // Search the sidebar list by title AND message text, typo-tolerantly.
  //
  // The whole session list (turns included) is already in renderer state, so
  // this is a plain in-memory pass — no IPC, nothing to await. It's debounced
  // anyway because scanning every turn's text is real work next to the old
  // title-only substring check, and it runs inside render.
  const settledFilter = useDebouncedValue(filter, CONFIG.MIGHTY.SEARCH.DEBOUNCE_MS)
  const query = settledFilter.trim()

  const searchHits = useMemo((): Map<string, SearchHit> => {
    const hits = new Map<string, SearchHit>()
    if (query === '') return hits

    for (const s of sessions) {
      // Title first: a title hit outranks any body hit, so a matching title
      // short-circuits the (much longer) turn scan.
      const titleMatch = fuzzyMatch(s.title || CONFIG.UI_LABELS.UNTITLED_CHAT, query)
      if (titleMatch.score > MATCH_SCORE.none) {
        hits.set(s.id, { score: titleMatch.score + TITLE_RANK_BOOST, snippet: null })
        continue
      }

      // Newest turns first — recent context is what people are hunting for,
      // and it lets the cap drop the stale tail rather than the fresh head.
      const turns = s.turns.slice(-CONFIG.MIGHTY.SEARCH.MAX_TURNS_SCANNED).reverse()
      let best: SearchHit | null = null
      for (const t of turns) {
        for (const text of [t.q, t.a]) {
          if (!text) continue
          const m = fuzzyMatch(text, query)
          if (m.score > MATCH_SCORE.none && (best === null || m.score > best.score)) {
            best = { score: m.score, snippet: buildSnippet(text, m) }
          }
        }
        // An exact hit is the best a body can score; stop at the first one.
        if (best !== null && best.score >= MATCH_SCORE.exactPrefix) break
      }
      if (best !== null) hits.set(s.id, best)
    }
    return hits
  }, [sessions, query])

  const toggleSource = useCallback((key: string): void => {
    setHiddenSources((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      void window.api.settingsSetMightySourceFilter(next)
      return next
    })
  }, [])

  // Lights the funnel only when the user has moved OFF the defaults. Hiding empties
  // is the default, so it deliberately doesn't count — otherwise the button reads as
  // "something is filtered" on a first run where nothing has been touched.
  const sourceFilterActive = hiddenSources.length > 0 || showArchived

  const toggleShowEmpty = useCallback((): void => {
    setShowEmpty((prev) => {
      void window.api.settingsSetMightyShowEmpty(!prev)
      return !prev
    })
  }, [])

  // A text search overrides the source filter: if you typed a term and a hidden
  // conversation matches it, hiding it would read as "search is broken". The
  // empty-conversation rule still applies — those have no body to have matched.
  const matchesFilter = useCallback(
    (s: MightySession): boolean => {
      if ((s.archived === true) !== showArchived) return false
      const open = s.id === activePane?.sessionId || openElsewhere.has(s.id) || s.runId !== undefined
      if (!showEmpty && !open && !hasRealExchange(s)) return false
      if (query !== '') return searchHits.has(s.id)
      return !hiddenSources.includes(sourceGroupOf(s))
    },
    [query, searchHits, hiddenSources, showEmpty, showArchived, activePane?.sessionId, openElsewhere]
  )

  const visibleCount = useMemo(
    () => sessions.filter(matchesFilter).length,
    [sessions, matchesFilter]
  )

  // While searching, rank by match quality (title hits, then exact body hits,
  // then typos) and let recency break ties. With no query the list keeps its
  // plain recency order — `sessions` arrives pre-sorted by `updated`.
  const rankForSearch = useCallback(
    (list: MightySession[]): MightySession[] => {
      if (query === '') return list
      return [...list].sort((a, b) => {
        const d = (searchHits.get(b.id)?.score ?? 0) - (searchHits.get(a.id)?.score ?? 0)
        return d !== 0 ? d : a.updated < b.updated ? 1 : -1
      })
    },
    [query, searchHits]
  )

  const renderRow = (s: MightySession, place: 'pinned' | 'loose' | 'project'): JSX.Element => (
    <SessionRow
      key={s.id}
      s={s}
      leading={place === 'pinned' ? <MessageSquare size={14} /> : undefined}
      nested={place === 'project'}
      openState={visible ? chatOpenState(s.id, activePane, openElsewhere) : 'closed'}
      openColor={openColors?.get(s.id) ?? null}
      snippet={searchHits.get(s.id)?.snippet ?? null}
      projects={projects}
      moveMenuOpen={moveMenuFor === s.id}
      onOpen={() => {
        openSessionInActivePane(s.id)
        onShowChat()
      }}
      onDelete={() => void deleteSession(s.id)}
      onTogglePin={() => void toggleSessionPin(s)}
      onToggleArchive={() => void toggleSessionArchived(s)}
      onToggleMoveMenu={() => setMoveMenuFor((cur) => (cur === s.id ? null : s.id))}
      onMove={(projectId) => void moveSessionToProject(s.id, projectId)}
      onNewProject={() => {
        setMoveMenuFor(null)
        setPendingProjectFor(s.id)
        setEditingProject({ id: '', name: '', created: '', updated: '' })
      }}
    />
  )

  const draftProjectId =
    draftTitle !== null && !sessions.some((s) => s.id === activePane?.sessionId)
      ? activePane?.pendingProjectId ?? null
      : undefined
  const renderDraftRow = (): JSX.Element => (
    <div className="mx-2 flex items-center gap-1 rounded-md bg-surface2 px-2.5 py-1.5 animate-pulse">
      <div className="flex-1 min-w-0 text-sm truncate font-medium text-on-surface">{draftTitle}</div>
      <Loader2 size={13} className="shrink-0 animate-spin text-muted" />
    </div>
  )

  const renderProjectGroup = (p: MightyProject): JSX.Element | null => {
    const groupSessions = rankForSearch(
      sessions.filter((s) => !s.pinned && s.projectId === p.id && matchesFilter(s))
    )
    if (query !== '' && groupSessions.length === 0) return null
    const collapsed = folded[p.id] === true
    const expanded = expandedLists[p.id] === true || query !== ''
    return (
      <div key={p.id} className="mb-1">
        <ProjectGroupHeader
          name={p.name}
          count={groupSessions.length}
          collapsed={collapsed}
          icon={p.icon}
          imagePath={p.imagePath}
          onToggle={() => fold(p.id, !collapsed)}
          actions={
            <>
              <Button
                variant="icon"
                type="button"
                onClick={() => {
                  void newChatInActivePane(p.id)
                  onShowChat()
                }}
                className="opacity-0 group-hover:opacity-100"
                title="New chat in this project"
              >
                <Plus size={13} />
              </Button>
              <Button
                variant="icon"
                type="button"
                onClick={() => void toggleProjectPin(p)}
                className="opacity-0 group-hover:opacity-100"
                title={p.pinned ? 'Unpin' : 'Pin to top'}
              >
                {p.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              </Button>
              <Button
                variant="icon"
                type="button"
                onClick={() => setEditingProject(p)}
                className="opacity-0 group-hover:opacity-100"
                title="Project settings"
              >
                <Pencil size={12} />
              </Button>
            </>
          }
        />
        {!collapsed && (
          <>
            {draftProjectId === p.id && renderDraftRow()}
            {(expanded ? groupSessions : groupSessions.slice(0, SIDEBAR_CHAT_CAP)).map((s) => renderRow(s, 'project'))}
            {query === '' && groupSessions.length > SIDEBAR_CHAT_CAP && (
              <div className="mx-2 pl-[39px]">
                <SidebarRow
                  label={<span className="text-muted">{expanded ? CONFIG.UI_LABELS.SIDEBAR_SHOW_LESS : CONFIG.UI_LABELS.SIDEBAR_SHOW_MORE}</span>}
                  onClick={() => setExpandedLists((prev) => ({ ...prev, [p.id]: !expanded }))}
                />
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const renderPane = (
    t: ChatWorkspaceTab,
    pane: ChatPaneRef,
    focused: boolean,
    chrome: Pick<ComponentProps<typeof ConversationPane>, 'slotColor' | 'headerAddAction' | 'headerCloseAction'>
  ): JSX.Element => (
    <PaneZoom>
      {pane.agentLabel || pane.agentCwd ? (
        <CodeAgentPane
          key={paneRenderKey(pane)}
          label={pane.agentLabel}
          cwd={pane.agentCwd}
          firstSend={agentFirstSend[pane.id]}
          onFirstSendTaken={() =>
            setAgentFirstSend((prev) => {
              const next = { ...prev }
              delete next[pane.id]
              return next
            })
          }
          onAgent={(label) => workspace.setPaneAgent(t.id, pane.id, label)}
          relay={relay}
          projects={projects}
          slotColor={chrome.slotColor ?? null}
          headerAddAction={chrome.headerAddAction}
          headerCloseAction={chrome.headerCloseAction}
          onClose={() => workspace.closePane(t.id, pane.id)}
        />
      ) : (
        <ConversationPane
          key={paneRenderKey(pane)}
          paneId={pane.id}
          sessionId={pane.sessionId}
          pendingProjectId={pane.pendingProjectId}
          projects={projects}
          onPendingProjectChange={(projectId) => setPendingProjectOnPane(t.id, pane.id, projectId)}
          onRouteToAgent={
            allMode && !pane.sessionId
              ? (cwd, message, paths) => {
                  setAgentFirstSend((prev) => ({ ...prev, [pane.id]: { message, paths } }))
                  bindPaneAgent(t.id, pane.id, { cwd })
                }
              : undefined
          }
          onNewProject={() => setEditingProject({ id: '', name: '', created: '', updated: '' })}
          onEditProject={setEditingProject}
          onSessionsChanged={() => void loadSessions()}
          onRegisterAttach={focused ? registerFocusedAttach : undefined}
          onPendingSourcesChange={focused ? setFocusedPendingSources : undefined}
          onSessionCreated={(sessionId) => {
            setPaneSession(t.id, pane.id, sessionId)
            void loadSessions()
          }}
          name={name}
          handoff={focused ? handoff : null}
          onHandoffConsumed={onHandoffConsumed}
          onTurnsChange={focused ? setFocusedPaneTurns : undefined}
          onRunChange={trackPaneRun}
          onDraftTitle={focused ? setDraftTitle : undefined}
          onSessionMissing={() => switchPaneSession(t.id, pane.id, null)}
          emptyAction={
            t.panes.length === 1 && sessions.length >= 2 && (
              <Button variant="bare" onClick={openSixPanes} className="agent-draft-starter">
                <LayoutGrid size={13} strokeWidth={1.75} /> {CONFIG.UI_LABELS.CHAT_OPEN_SIX}
              </Button>
            )
          }
          {...chrome}
        />
      )}
    </PaneZoom>
  )

  return (
    <div ref={layoutRef} className="mighty-chat-layout flex h-full min-h-0">
      {actionsSlot &&
        createPortal(
          <>
            <SidebarRow
              card
              icon={<SquarePen size={16} />}
              label={CONFIG.UI_LABELS.SIDEBAR_NEW_CHAT}
              trailing={<span className="text-xs text-muted">⌘N</span>}
              onClick={() => {
                void newChatInActivePane()
                onShowChat()
              }}
            />
          </>,
          actionsSlot
        )}
      {listSlot &&
        createPortal(
          (() => {
            const live = projects.filter((p) => !p.archived)
            const pinnedProjects = live.filter((p) => p.pinned)
            const otherProjects = live.filter((p) => !p.pinned)
            const pinnedChats = rankForSearch(sessions.filter((s) => s.pinned && matchesFilter(s)))
            const looseChats = rankForSearch(
              sessions.filter((s) => !s.pinned && !s.projectId && matchesFilter(s))
            )
            const looseExpanded = expandedLists[UNASSIGNED_SIDEBAR_KEY] === true || query !== ''
            const sectionShut = (id: string): boolean => query === '' && folded[id] === true
            const foldProps = (id: string): { collapsed: boolean; onToggle: () => void } => ({
              collapsed: sectionShut(id),
              onToggle: () => fold(id, !sectionShut(id))
            })
            return (
              <>
                {filterOpen && (
                  <div className="mx-3 px-0.5 py-1">
                    <div className="flex items-center gap-1.5 rounded-lg bg-surface1 border border-surface3 px-2 py-1 focus-within:border-blue">
                      <Search size={13} className="text-muted shrink-0" />
                      <input
                        ref={filterInputRef}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setFilterOpen(false)
                            setFilter('')
                          }
                        }}
                        placeholder={CONFIG.UI_LABELS.SEARCH_CONVERSATIONS_PLACEHOLDER}
                        className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted"
                      />
                    </div>
                  </div>
                )}
                {sessions.length === 0 && projects.length === 0 && (
                  <div className="text-sm text-muted text-center py-8">No chats yet.</div>
                )}
                {/* Keyed off the settled query so "No matches." doesn't flash between keystrokes. */}
                {query !== '' && searchHits.size === 0 && (
                  <div className="text-sm text-muted text-center py-8">No matches.</div>
                )}
                {query === '' && sessions.length > 0 && visibleCount === 0 && (
                  <div className="px-3 text-sm text-muted text-center py-8">
                    {CONFIG.UI_LABELS.SIDEBAR_NO_MATCHES}
                  </div>
                )}
                {(pinnedProjects.length > 0 || pinnedChats.length > 0) && (
                  <div className="mb-1">
                    <SidebarSection label={CONFIG.UI_LABELS.SIDEBAR_PINNED} {...foldProps(FOLD_PINNED)} />
                    {!sectionShut(FOLD_PINNED) && pinnedProjects.map(renderProjectGroup)}
                    {!sectionShut(FOLD_PINNED) && pinnedChats.map((s) => renderRow(s, 'pinned'))}
                  </div>
                )}
                <div className="mb-1">
                  <SidebarSection
                    label={CONFIG.UI_LABELS.SIDEBAR_PROJECTS}
                    {...foldProps(FOLD_PROJECTS)}
                    actions={
                      <>
                        <Button
                          variant="icon"
                          onClick={() => (filterOpen ? setFilterOpen(false) : openFilter())}
                          className={filterOpen ? 'text-blue' : 'hidden group-hover:inline-flex group-focus-within:inline-flex'}
                          title={`${CONFIG.UI_LABELS.SEARCH_CONVERSATIONS} (⌘F)`}
                        >
                          <Search size={14} />
                        </Button>
                        <Button variant="bare"
                          ref={sourceBtnRef}
                          onClick={() => setSourceMenuOpen((v) => !v)}
                          className={`grid place-items-center rounded-md p-1.5 ${
                            sourceMenuOpen || sourceFilterActive ? 'text-blue' : 'text-muted hidden hover:text-blue group-hover:grid group-focus-within:grid'
                          }`}
                          title={CONFIG.UI_LABELS.SIDEBAR_FILTER}
                        >
                          <SlidersHorizontal size={14} />
                        </Button>
                        {sourceMenuOpen &&
                          createPortal(
                            <div
                              ref={sourceMenuRef}
                              className="fixed rounded-lg border border-surface3 bg-surface1 shadow-lg py-1 z-50"
                              style={{
                                top: sourceMenuPos.top,
                                left: sourceMenuPos.left,
                                width: SOURCE_MENU_W
                              }}
                            >
                              <div className="px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-muted">
                                {CONFIG.UI_LABELS.SIDEBAR_FILTER_HEAD}
                              </div>
                              {SIDEBAR_SOURCE_GROUPS.map((g) => {
                                const on = !hiddenSources.includes(g.key)
                                return (
                                  <Button variant="bare"
                                    key={g.key}
                                    onClick={() => toggleSource(g.key)}
                                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface2"
                                  >
                                    <span className="grid w-4 shrink-0 place-items-center text-blue">
                                      {on && <Check size={13} strokeWidth={3} />}
                                    </span>
                                    <span className={on ? '' : 'text-muted'}>{g.label}</span>
                                  </Button>
                                )
                              })}
                              <div className="my-1 border-t border-surface3" />
                              <Button variant="bare"
                                onClick={toggleShowEmpty}
                                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface2"
                              >
                                <span className="grid w-4 shrink-0 place-items-center text-blue">
                                  {showEmpty && <Check size={13} strokeWidth={3} />}
                                </span>
                                <span className={showEmpty ? '' : 'text-muted'}>
                                  {CONFIG.UI_LABELS.SIDEBAR_SHOW_EMPTY}
                                </span>
                              </Button>
                              <Button variant="bare"
                                onClick={() => setShowArchived((v) => !v)}
                                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface2"
                              >
                                <span className="grid w-4 shrink-0 place-items-center text-blue">
                                  {showArchived && <Check size={13} strokeWidth={3} />}
                                </span>
                                <span className={showArchived ? '' : 'text-muted'}>
                                  {CONFIG.UI_LABELS.SIDEBAR_SHOW_ARCHIVED}
                                </span>
                              </Button>
                            </div>,
                            document.body
                          )}
                        <Button variant="icon" onClick={() => setAllProjectsOpen(true)} title="All projects">
                          <Folders size={14} />
                        </Button>
                        <Button
                          variant="icon"
                          onClick={() => setEditingProject({ id: '', name: '', created: '', updated: '' })}
                          title="New project (⌘⇧N)"
                        >
                          <FolderPlus size={14} />
                        </Button>
                      </>
                    }
                  />
                  {!sectionShut(FOLD_PROJECTS) && otherProjects.map(renderProjectGroup)}
                </div>
                {(looseChats.length > 0 || draftProjectId === null) && (
                  <div className="mb-1">
                    <SidebarSection label={CONFIG.UI_LABELS.SIDEBAR_CHATS} {...foldProps(FOLD_CHATS)} />
                    {draftProjectId === null && renderDraftRow()}
                    {!sectionShut(FOLD_CHATS) &&
                      (looseExpanded ? looseChats : looseChats.slice(0, SIDEBAR_CHAT_CAP)).map((s) =>
                        renderRow(s, 'loose')
                      )}
                    {!sectionShut(FOLD_CHATS) && query === '' && looseChats.length > SIDEBAR_CHAT_CAP && (
                      <div className="mx-2 pl-[26px]">
                        <SidebarRow
                          label={<span className="text-muted">{looseExpanded ? CONFIG.UI_LABELS.SIDEBAR_SHOW_LESS : CONFIG.UI_LABELS.SIDEBAR_SHOW_MORE}</span>}
                          onClick={() =>
                            setExpandedLists((prev) => ({ ...prev, [UNASSIGNED_SIDEBAR_KEY]: !looseExpanded }))
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
              </>
            )
          })(),
          listSlot
        )}
      {editingProject && (
        <ProjectSettingsModal
          project={editingProject}
          onCancel={() => {
            setPendingProjectFor(null)
            setEditingProject(null)
          }}
          onSave={(p) => void saveProject(p)}
          onPictureChanged={() => void loadProjects()}
          onDelete={
            editingProject.id !== '' ? () => void deleteProject(editingProject.id) : undefined
          }
        />
      )}
      {allProjectsOpen && (
        <AllProjectsModal
          onClose={() => setAllProjectsOpen(false)}
          onChanged={() => {
            void loadProjects()
            void loadSessions()
          }}
        />
      )}
      {nerdMode ? (
        <NerdWorkspace
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          focusedPaneFor={focusedPaneFor}
          actions={workspace}
          onExit={() => onNerdMode(false)}
          renderPane={(t, pane, chrome) => renderPane(t, pane, chrome.focused, {
            slotColor: chrome.slotColor,
            headerAddAction: chrome.headerAddAction,
            headerCloseAction: chrome.headerCloseAction
          })}
        />
      ) : (
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {activeTab && activePane && (
            <div className="h-full w-full overflow-hidden">
              {renderPane(activeTab, activePane, true, { headerCloseAction: <><PaneZoomIndicator /><ZoomIndicator /></> })}
            </div>
          )}
        </div>
      )}

      {showRail && focusedPaneTurns.length > 0 && <div {...railResize.gripProps} />}
      {showRail && focusedPaneTurns.length > 0 && (
        <div className="chat-rail" data-mode={railMode} data-closes={RAIL_PANEL} style={railResize.style}>
          {browsingRail ? (
            <ConversationMediaProvider value={chatMedia}>
              <SideBrowser
                conversationKey={`chat:${railKey}`}
                head={<RailModeSwitch mode={railMode} onMode={setRailMode} />}
                chatAim={railSession ? `chat:${railSession.id}` : undefined}
                takesLinks={visible}
              />
            </ConversationMediaProvider>
          ) : (
            <ContextRail
              head={<RailModeSwitch mode={railMode} onMode={setRailMode} />}
              name={name}
              turns={focusedPaneTurns}
              pendingSources={focusedPendingSources}
              onAddSource={() => focusedAttachPickRef.current?.()}
              details={<ChatDetails name={name} turns={focusedPaneTurns} session={railSession} project={railProject} />}
            />
          )}
        </div>
      )}
    </div>
  )
}

// A single conversation row in the drawer, used both inside a project's group and
// in the Unassigned bucket. The "…" menu offers New project / Move to project /
// Unassigned so a chat can be reassigned without drag-and-drop (fast-follow, see
// the Projects design).
/**
 * A search snippet with the matched span highlighted. Rendered from indices
 * rather than by string-replacing the query: the match may be a TYPO of what's
 * on screen ("gsit" matching "gist"), so there's nothing to search-and-replace.
 */
