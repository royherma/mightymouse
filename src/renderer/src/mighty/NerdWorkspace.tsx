import { JSX, ReactNode, useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { Button } from '../components/Button'
import { SegmentedControl, type SegmentItem } from '../components/SegmentedControl'
import { ChatTabStrip } from '../components/ChatTabStrip'
import { ZoomIndicator } from '../components/ZoomIndicator'
import { PaneZoomIndicator } from './pane-zoom'
import { PaneGrid } from './PaneGrid'
import { MAX_PANES_PER_TAB } from './pane-layout'
import { planOpenGlobal } from './pane-selection'
import { paneSlotColor, type PaneOpenColorId } from './pane-colors'
import { tabDisplayViewMode } from './tab-view-mode'
import { paneLifecycleLog } from './pane-lifecycle-log'
import { PREFIX_HELP, paneInDirection, usePanePrefixKeys, type PrefixCommand } from './pane-prefix-keys'
import { switchBinding } from './pane-binding'
import { effectiveProjectIdForPane } from './effective-project'
import { CLOSE_PANEL_EVENT } from '../hooks/useRailMode'
import type { ChatPaneRef, ChatWorkspaceTab, MightySession, PaneLayoutState, PaneViewMode } from '../../../shared/types'

const PANE_CHROME_CLASS = 'shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity'

export interface PaneChrome {
  focused: boolean
  slotColor: PaneOpenColorId | null
  headerAddAction: ReactNode
  headerCloseAction: ReactNode
}

const VIEW_MODES: ReadonlyArray<SegmentItem<PaneViewMode>> = [
  { id: 'grid', label: 'Side by side' },
  { id: 'single', label: 'Focus' }
]

type OpenTarget = { sessionId: string } | { agentLabel: string }

export type GridRequest = { nonce: number } & ({ kind: 'agent'; label: string } | { kind: 'six'; cwd: string; count?: number })

const PANE_INPUT_SELECTOR = 'textarea:not([disabled]), [contenteditable="true"], [tabindex="0"]'

function focusPaneInput(root: HTMLElement | null, paneId: string): void {
  requestAnimationFrame(() =>
    root?.querySelector(`[data-grid-pane="${paneId}"]`)?.querySelector<HTMLElement>(PANE_INPUT_SELECTOR)?.focus()
  )
}

function scrollPaneIntoView(paneId: string): void {
  requestAnimationFrame(() =>
    document.querySelector(`[data-pane-id="${paneId}"]`)?.scrollIntoView({ block: 'nearest' })
  )
}

// Ids are minted OUTSIDE the setTabs updaters: StrictMode double-invokes updaters, and a
// second randomUUID would leave activePaneByTab pointing at a pane that never committed.
export function useWorkspaceActions({
  tabsRef,
  setTabs,
  activeTabId,
  setActiveTabId,
  activePaneByTab,
  setActivePaneByTab,
  makeTab,
  sessions
}: {
  tabsRef: MutableRefObject<ChatWorkspaceTab[]>
  setTabs: Dispatch<SetStateAction<ChatWorkspaceTab[]>>
  activeTabId: string | null
  setActiveTabId: Dispatch<SetStateAction<string | null>>
  activePaneByTab: Record<string, string>
  setActivePaneByTab: Dispatch<SetStateAction<Record<string, string>>>
  makeTab: () => ChatWorkspaceTab
  sessions: MightySession[]
}) {
  const focusPane = useCallback(
    (tabId: string, paneId: string) => setActivePaneByTab((prev) => ({ ...prev, [tabId]: paneId })),
    [setActivePaneByTab]
  )

  const revealPane = useCallback(
    (tabId: string, paneId: string) => {
      focusPane(tabId, paneId)
      scrollPaneIntoView(paneId)
    },
    [focusPane]
  )

  const newTab = useCallback(() => {
    const tab = makeTab()
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
    setActivePaneByTab((p) => ({ ...p, [tab.id]: tab.panes[0].id }))
  }, [makeTab, setTabs, setActiveTabId, setActivePaneByTab])

  const renameTab = useCallback(
    (id: string, name: string) => setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t))),
    [setTabs]
  )

  const closeTab = useCallback(
    (id: string) => {
      const rest = tabsRef.current.filter((t) => t.id !== id)
      const fallback = rest.length > 0 ? null : makeTab()
      setTabs(fallback ? [fallback] : rest)
      setActiveTabId((cur) => (cur === id ? (fallback ?? rest[0]).id : cur))
      if (fallback) setActivePaneByTab((p) => ({ ...p, [fallback.id]: fallback.panes[0].id }))
    },
    [tabsRef, makeTab, setTabs, setActiveTabId, setActivePaneByTab]
  )

  const addPanes = useCallback(
    (tabId: string, count: number, afterPaneId?: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (!tab) return
      const room = Math.min(count, MAX_PANES_PER_TAB - tab.panes.length)
      if (room <= 0) return
      const sibling = afterPaneId ? tab.panes.find((p) => p.id === afterPaneId) : undefined
      const pendingProjectId = sibling ? effectiveProjectIdForPane(sibling, sessions) : undefined
      const added: ChatPaneRef[] = Array.from({ length: room }, () => ({
        id: crypto.randomUUID(),
        sessionId: null,
        pendingProjectId
      }))
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== tabId) return t
          const at = afterPaneId ? t.panes.findIndex((p) => p.id === afterPaneId) : -1
          const panes = [...t.panes]
          panes.splice(at < 0 ? panes.length : at + 1, 0, ...added)
          return { ...t, panes, viewMode: 'grid' }
        })
      )
      setActivePaneByTab((p) => ({ ...p, [tabId]: added[0].id }))
    },
    [tabsRef, sessions, setTabs, setActivePaneByTab]
  )

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (!tab || tab.panes.length <= 1) return
      const panes = tab.panes.filter((p) => p.id !== paneId)
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, panes } : t)))
      setActivePaneByTab((p) => (p[tabId] === paneId ? { ...p, [tabId]: panes[0].id } : p))
    },
    [tabsRef, setTabs, setActivePaneByTab]
  )

  const setViewMode = useCallback(
    (tabId: string, viewMode: PaneViewMode, paneId?: string) => {
      if (paneId) focusPane(tabId, paneId)
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, viewMode } : t)))
    },
    [setTabs, focusPane]
  )

  const setTabLayout = useCallback(
    (tabId: string, layout: PaneLayoutState) =>
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, layout } : t))),
    [setTabs]
  )

  const openPlanned = useCallback(
    (target: OpenTarget) => {
      const tabs = tabsRef.current
      const agent = 'agentLabel' in target ? target.agentLabel : null
      const sessionId = 'sessionId' in target ? target.sessionId : null
      const bind = (p: ChatPaneRef): ChatPaneRef =>
        agent !== null ? { ...switchBinding(p, null), agentLabel: agent } : switchBinding(p, sessionId)
      const plan = planOpenGlobal(
        tabs,
        activeTabId,
        activePaneByTab,
        (p) => (agent !== null ? p.agentLabel === agent : p.sessionId === sessionId),
        MAX_PANES_PER_TAB
      )
      const planTabId = plan.kind === 'none' || plan.kind === 'add-tab' ? null : plan.tabId
      paneLifecycleLog.open(agent ?? sessionId ?? '', plan, tabs.find((t) => t.id === planTabId)?.viewMode ?? 'grid')
      if (plan.kind === 'none') return
      if (planTabId && planTabId !== activeTabId) setActiveTabId(planTabId)
      if (plan.kind === 'focus') return revealPane(plan.tabId, plan.paneId)
      if (plan.kind === 'add-pane') {
        const pane = bind({ id: crypto.randomUUID(), sessionId: null })
        setTabs((prev) => prev.map((t) => (t.id === plan.tabId ? { ...t, panes: [...t.panes, pane] } : t)))
        return revealPane(plan.tabId, pane.id)
      }
      if (plan.kind === 'add-tab') {
        const fresh = makeTab()
        const tab = { ...fresh, panes: [bind(fresh.panes[0])] }
        setTabs((prev) => [...prev, tab])
        setActiveTabId(tab.id)
        setActivePaneByTab((p) => ({ ...p, [tab.id]: tab.panes[0].id }))
        return scrollPaneIntoView(tab.panes[0].id)
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.id !== plan.tabId ? t : { ...t, panes: t.panes.map((p) => (p.id === plan.paneId ? bind(p) : p)) }
        )
      )
      revealPane(plan.tabId, plan.paneId)
    },
    [tabsRef, activeTabId, activePaneByTab, makeTab, setTabs, setActiveTabId, setActivePaneByTab, revealPane]
  )

  const openSessionPlanned = useCallback((sessionId: string) => openPlanned({ sessionId }), [openPlanned])
  const openAgentPlanned = useCallback((agentLabel: string) => openPlanned({ agentLabel }), [openPlanned])

  const openSix = useCallback(
    (agentCwd?: string, count = MAX_PANES_PER_TAB) => {
      const active = tabsRef.current.find((t) => t.id === activeTabId)
      const reuse = active && active.panes.length === 1 && !active.panes[0].sessionId && !active.panes[0].agentLabel
      const tab = reuse ? active : makeTab()
      const length = Math.min(Math.max(count, 2), MAX_PANES_PER_TAB)
      const panes: ChatPaneRef[] = Array.from({ length }, (_, i) => ({
        id: i === 0 ? tab.panes[0].id : crypto.randomUUID(),
        sessionId: null,
        ...(agentCwd ? { agentCwd } : {})
      }))
      const filled = { ...tab, panes, viewMode: 'grid' as const }
      setTabs((prev) => (reuse ? prev.map((t) => (t.id === tab.id ? filled : t)) : [...prev, filled]))
      setActiveTabId(tab.id)
      setActivePaneByTab((p) => ({ ...p, [tab.id]: panes[0].id }))
    },
    [tabsRef, activeTabId, makeTab, setTabs, setActiveTabId, setActivePaneByTab]
  )

  const setPaneAgent = useCallback(
    (tabId: string, paneId: string, agentLabel: string | undefined) =>
      setTabs((prev) =>
        prev.map((t) =>
          t.id !== tabId ? t : { ...t, panes: t.panes.map((p) => (p.id === paneId ? { ...p, agentLabel } : p)) }
        )
      ),
    [setTabs]
  )

  return {
    focusPane,
    newTab,
    renameTab,
    closeTab,
    addPanes,
    closePane,
    setViewMode,
    setTabLayout,
    openSessionPlanned,
    openAgentPlanned,
    openSix,
    setPaneAgent
  }
}

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>

export function NerdWorkspace({
  tabs,
  activeTabId,
  onSelectTab,
  focusedPaneFor,
  actions,
  onExit,
  renderPane
}: {
  tabs: ChatWorkspaceTab[]
  activeTabId: string | null
  onSelectTab: (id: string) => void
  focusedPaneFor: (tab: ChatWorkspaceTab) => string | null
  actions: WorkspaceActions
  onExit: () => void
  renderPane: (tab: ChatWorkspaceTab, pane: ChatPaneRef, chrome: PaneChrome) => JSX.Element
}): JSX.Element {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const focusMode = activeTab !== null && tabDisplayViewMode(activeTab) === 'single' && activeTab.panes.length > 1
  const rootRef = useRef<HTMLDivElement>(null)
  const runPrefix = (cmd: PrefixCommand): void => {
    if (cmd.kind === 'new-tab') return actions.newTab()
    if (cmd.kind === 'tab') {
      const at = tabs.findIndex((t) => t.id === activeTabId)
      return onSelectTab(tabs[(at + cmd.step + tabs.length) % tabs.length].id)
    }
    if (!activeTab) return
    const focusedId = focusedPaneFor(activeTab) ?? activeTab.panes[0].id
    const at = activeTab.panes.findIndex((p) => p.id === focusedId)
    const goTo = (paneId: string | undefined | null): void => {
      if (!paneId) return
      actions.focusPane(activeTab.id, paneId)
      focusPaneInput(rootRef.current, paneId)
    }
    if (cmd.kind === 'jump') return goTo(activeTab.panes[cmd.index]?.id)
    if (cmd.kind === 'next-pane') return goTo(activeTab.panes[(at + 1) % activeTab.panes.length].id)
    if (cmd.kind === 'split') return actions.addPanes(activeTab.id, 1, focusedId)
    if (cmd.kind === 'close') return actions.closePane(activeTab.id, focusedId)
    if (cmd.kind === 'zoom') {
      if (activeTab.panes.length < 2) return
      return actions.setViewMode(activeTab.id, focusMode ? 'grid' : 'single', focusedId)
    }
    if (cmd.kind === 'move' && !focusMode) {
      const boxes = activeTab.panes.flatMap((p) => {
        const el = rootRef.current?.querySelector(`[data-grid-pane="${p.id}"]`)
        return el ? [{ id: p.id, box: el.getBoundingClientRect() }] : []
      })
      goTo(paneInDirection(boxes, focusedId, cmd.dir))
    }
  }
  const prefix = usePanePrefixKeys(rootRef, runPrefix)
  const tabCount = tabs.length
  useEffect(() => {
    const root = rootRef.current
    const onClosePanel = (e: Event): void => {
      const paneId = (e.target as HTMLElement).dataset.gridPane
      if (!paneId || !activeTab) return
      if (activeTab.panes.length > 1) actions.closePane(activeTab.id, paneId)
      else if (tabCount > 1) actions.closeTab(activeTab.id)
    }
    root?.addEventListener(CLOSE_PANEL_EVENT, onClosePanel)
    return () => root?.removeEventListener(CLOSE_PANEL_EVENT, onClosePanel)
  }, [activeTab, tabCount, actions])
  return (
    <div ref={rootRef} className="relative flex-1 flex flex-col min-w-0 min-h-0">
      <div className={`flex items-center px-2 pt-1 ${focusMode ? 'hidden' : ''}`}>
        <div className="flex-1 min-w-0">
          <ChatTabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={onSelectTab}
            onClose={(id) => {
              actions.closeTab(id)
              if (tabs.length <= 1) onExit()
            }}
            onNew={actions.newTab}
            onRename={actions.renameTab}
          />
        </div>
        {activeTab && activeTab.panes.length > 1 ? (
          <SegmentedControl
            items={VIEW_MODES}
            active={tabDisplayViewMode(activeTab)}
            onChange={(mode) => actions.setViewMode(activeTab.id, mode)}
            textSize="text-xs"
            className="shrink-0 mr-1"
          />
        ) : (
          <Button
            variant="ghost"
            onClick={onExit}
            title="One chat at a time (Esc)"
            className="inline-flex items-center gap-1 px-1.5 text-xs shrink-0 mr-1"
          >
            <Minimize2 size={12} strokeWidth={2.5} /> One chat
          </Button>
        )}
        <PaneZoomIndicator />
        <ZoomIndicator />
      </div>
      {tabs.map((t) => {
        const focusedId = focusedPaneFor(t)
        const viewMode = tabDisplayViewMode(t)
        const many = t.panes.length > 1
        const solo = viewMode === 'single' && many
        const renderCell = (paneId: string): JSX.Element => {
          const index = t.panes.findIndex((p) => p.id === paneId)
          const pane = t.panes[index]
          if (!pane) return <></>
          const focused = t.id === activeTabId && paneId === focusedId
          return (
            <div
              data-grid-pane={paneId}
              data-closes=""
              data-focused={focused}
              className="relative h-full w-full rounded-lg overflow-hidden"
              onClick={() => actions.focusPane(t.id, paneId)}
              onFocus={() => actions.focusPane(t.id, paneId)}
            >
              {focused && many && !solo && (
                <div className="absolute inset-0 z-10 rounded-lg ring-2 ring-inset ring-accent/60 pointer-events-none" />
              )}
              {prefix.phase === 'numbers' && t.id === activeTabId && (
                <div
                  className={`absolute inset-0 z-20 flex items-center justify-center pointer-events-none text-6xl font-semibold ${focused ? 'text-accent' : 'text-on-surface'} bg-surface1/70`}
                >
                  {index + 1}
                </div>
              )}
              {renderPane(t, pane, {
                focused,
                slotColor: many && !solo ? paneSlotColor(index) : null,
                headerAddAction: !solo && t.panes.length < MAX_PANES_PER_TAB && (
                  <Button
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      actions.addPanes(t.id, 1, paneId)
                    }}
                    title="New chat beside this one"
                    aria-label="New chat beside this one"
                    className={`inline-flex items-center gap-1 h-6 px-1.5 text-xs ${PANE_CHROME_CLASS}`}
                  >
                    <Plus size={12} strokeWidth={2.5} /> Chat
                  </Button>
                ),
                headerCloseAction: solo ? (
                  <Button
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      actions.setViewMode(t.id, 'grid')
                    }}
                    title={`Show all ${t.panes.length} side by side`}
                    className="inline-flex items-center gap-1 h-6 px-1.5 text-xs shrink-0"
                  >
                    <Minimize2 size={12} strokeWidth={2.5} /> All {t.panes.length}
                  </Button>
                ) : many && (
                  <>
                    <Button
                      variant="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        actions.setViewMode(t.id, 'single', paneId)
                      }}
                      title="Focus on this one"
                      aria-label="Focus on this one"
                      className={`w-6 h-6 ${PANE_CHROME_CLASS}`}
                    >
                      <Maximize2 size={12} strokeWidth={2.5} />
                    </Button>
                    <Button
                      variant="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        actions.closePane(t.id, paneId)
                      }}
                      title="Close pane"
                      aria-label="Close pane"
                      className={`w-6 h-6 ${PANE_CHROME_CLASS}`}
                    >
                      <X size={12} strokeWidth={2.5} />
                    </Button>
                  </>
                )
              })}
            </div>
          )
        }
        return (
          <div
            key={t.id}
            className={`flex-1 min-h-0 ${viewMode !== 'single' && many ? 'p-2' : ''} ${t.id === activeTabId ? '' : 'hidden'}`}
          >
            <div className="h-full flex flex-col gap-1.5">
              <div className="flex-1 min-h-0">
                <PaneGrid
                  paneIds={t.panes.map((p) => p.id)}
                  layout={t.layout}
                  viewMode={viewMode}
                  soloPaneId={focusedId}
                  observeLayout={t.id === activeTabId}
                  onLayoutChange={(layout) => actions.setTabLayout(t.id, layout)}
                  renderPane={renderCell}
                />
              </div>
            </div>
          </div>
        )
      })}
      {prefix.phase === 'armed' && <div className="absolute bottom-3 right-3 z-50 rounded-md border border-accent bg-surface2 px-2 py-1 text-xs text-accent-text pointer-events-none">Ctrl-B</div>}
      {prefix.phase === 'help' && (
        <div
          className="absolute bottom-3 right-3 z-50 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-surface3 bg-surface2 p-4 text-xs text-on-surface shadow-lg"
          onClick={prefix.dismiss}
        >
          {PREFIX_HELP.map(([keys, what]) => (
            <div key={keys} className="contents">
              <kbd className="font-mono text-accent-text">{keys}</kbd>
              <span className="text-muted">{what}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
