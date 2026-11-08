import { JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WindowFrame } from './WindowFrame'
import { Row } from './components/Layout'
import { Button } from './components/Button'
import { UpdateNudge } from './components/UpdateNudge'
import { ViewModeMenu } from './components/ViewModeMenu'
import { CodePanel, codeViewTitle } from './components/CodePanel'
import { useAgentRelay } from './hooks/useAgentRelay'
import { RAIL_BROWSER_EVENT, requestRailTab, useCloseKey, useRailHost } from './hooks/useRailMode'
import type { HistoryHandoff } from './mighty/mighty-shared'
import { useIsAdmin } from './hooks/useIsAdmin'
import type { GridRequest } from './mighty/NerdWorkspace'
import { CONFIG } from '../../shared/config'
import { MediaLibraryBody } from './MediaLibraryApp'
import CanvasApp from './CanvasApp'
import { SideBrowser } from './components/side-browser'
import { useRailResize } from './hooks/useRailResize'
import { isCodeTab } from '../../shared/types'
import type { ChatTabNameFormat, CodeTab, MightyProject } from '../../shared/types'
import { ProjectAvatar } from './components/ProjectIcon'

import {
  type Tab,
  TABS,
  visibleTabs,
  isTypingTarget,
  readAllMode,
  readLastTab,
  readNerdMode,
  rememberAllMode,
  rememberNerdMode,
  rememberTab,
  tabLabel,
  useTabHistory
} from './mighty/mighty-shared'
import { ChevronLeft } from 'lucide-react'
import { JobsTab, MadeTab } from './mighty/MightySecondaryTabs'
import SettingsApp from './SettingsApp'
import { PaneToggleGroup } from './mighty/MightyConversationView'
import { ChatTab } from './mighty/MightyChatTab'
import { MightySidebar, type SidebarMode } from './mighty/MightySidebar'
import { RecoveredRecordingSheet } from './mighty/RecoveredRecordingSheet'
import { usePaneZoomKeys } from './mighty/pane-zoom'
import './mighty/desktop-comfort.css'
export default function MightyApp(): JSX.Element {
  const [tab, setTab] = useState<Tab>(readLastTab)
  useEffect(() => rememberTab(tab), [tab])
  usePaneZoomKeys()
  const [mode, setMode] = useState<'chat' | 'code'>(() => (readLastTab() === 'code' ? 'code' : 'chat'))
  if ((tab === 'chat' || tab === 'code') && mode !== tab) setMode(tab)
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null)
  const [openSessions, setOpenSessions] = useState(0)
  const [listSlot, setListSlot] = useState<HTMLDivElement | null>(null)
  const [agentsSlot, setAgentsSlot] = useState<HTMLDivElement | null>(null)
  const [allMode, setAllModeState] = useState(readAllMode)
  const setAllMode = useCallback((on: boolean) => {
    rememberAllMode(on)
    setAllModeState(on)
  }, [])
  const [codeTab, setCodeTab] = useState<CodeTab | undefined>(undefined)
  const [chatProject, setChatProject] = useState<MightyProject | undefined>(undefined)
  const [codeProject, setCodeProject] = useState<MightyProject | undefined>(undefined)
  const [codeOpened, setCodeOpened] = useState(tab === 'code')
  if (tab === 'code' && !codeOpened) setCodeOpened(true)
  const isAdmin = useIsAdmin()
  const [bubbaOpened, setBubbaOpened] = useState(false)
  if (tab === 'bubba' && !bubbaOpened) setBubbaOpened(true)
  const relay = useAgentRelay()
  const inAll = allMode && (relay.enabled || !relay.known)
  if (inAll && !codeOpened) setCodeOpened(true)
  const sidebarMode: SidebarMode = inAll ? 'all' : mode
  const pickedMode: SidebarMode = allMode ? 'all' : mode
  useEffect(() => void window.api.mighty.setLastMode(pickedMode), [pickedMode])
  const chatOwnsSidebar = inAll || mode === 'chat'
  // Keep Code in the bar while it's the open tab even if the relay reports off,
  // so the bounce below is what moves the user — never a tab vanishing from
  // under the pane they're reading.
  const [simple, setSimple] = useState(() => new URLSearchParams(window.location.search).has('simple'))
  const tabs = useMemo(() => visibleTabs(relay.enabled || tab === 'code', simple), [relay.enabled, tab, simple])
  // Turning the relay off in Settings while standing on Code would otherwise
  // leave the body rendering under a bar that no longer has that tab. Waits for
  // `known` — at startup `enabled` is false only because nothing has answered yet.
  useEffect(() => {
    if (tab === 'code' && relay.known && !relay.enabled) setTab('chat')
  }, [tab, relay.known, relay.enabled])
  // Capture folder the Library tab should select. Bumped with a fresh object on each
  // request so re-opening the SAME capture still re-selects it (a bare string would
  // compare equal and the prop-effect wouldn't fire).
  const [libraryFocusReq, setLibraryFocusReq] = useState<{ folder: string } | null>(null)
  const bodyHeight = 'calc(100vh - 2.75rem)'
  const [showMade, setShowMade] = useState(false)
  // Resolved persona name (user override or CONFIG default). Loaded once; the
  // Settings tab updates it via onNameChange so the whole window stays in sync.
  const [name, setName] = useState<string>(CONFIG.MIGHTY.NAME)
  // Null until the Settings tab changes it — ChatTab seeds its own value from PREFS on
  // mount, so this only exists to push a mid-session change down to it.
  const [tabNameFormat, setTabNameFormat] = useState<ChatTabNameFormat | null>(null)
  const [projectsRevision, setProjectsRevision] = useState(0)
  const settingsHooks = useMemo(
    () => ({
      onNameChange: (n: string) => setName(n.trim() !== '' ? n.trim() : CONFIG.MIGHTY.NAME),
      onTabNameFormatChange: setTabNameFormat,
      onProjectsChanged: () => setProjectsRevision((n) => n + 1),
      onAdvancedModeChange: (on: boolean) => setSimple(!on)
    }),
    []
  )
  // Set by the History tab's Reuse/Continue buttons, consumed by ChatTab (which
  // stays mounted across tab switches so its own state survives), then switches
  // the visible tab back to Chat so the user lands on the live result.
  const [historyHandoff, setHistoryHandoff] = useState<HistoryHandoff | null>(null)
  // Pane visibility lives here (not in ChatTab) so the grouped toggle can sit in the
  // window title bar next to the minimize button, while ChatTab still owns the rails
  // it renders. Both persisted via PREFS so the layout survives reopening.
  const [showList, setShowList] = useState(true)
  const [showRail, setShowRail] = useState(true)
  const [showAgentRail, setShowAgentRail] = useState(true)

  useEffect(() => {
    void window.api.mighty.getSidebarShown().then(setShowList)
    void window.api.mighty.getContextRailShown().then(setShowRail)
  }, [])

  const tabRef = useRef(tab)
  tabRef.current = tab
  const nav = useTabHistory(tab, setTab)
  const [bubbaRail, setBubbaRail] = useState(false)
  const showBrowserRail = useCallback(() => {
    if (tabRef.current === 'bubba') setBubbaRail(true)
    else {
      setShowRail(true)
      void window.api.mighty.setContextRailShown(true)
    }
    requestAnimationFrame(() => window.dispatchEvent(new Event(RAIL_BROWSER_EVENT)))
  }, [])
  useRailHost(showBrowserRail)

  // Library routing — both entry points land here because this component owns `tab`.
  // Cold open reads ?focus= (main appends it in showMightyWindow); an already-open
  // window gets the same value over IPC. Empty string = the tray's "show the tab"
  // with nothing selected; a folder = a capture's HUD card, which also selects it.
  useEffect(() => {
    const focus = new URLSearchParams(window.location.search).get('focus')
    if (focus === null) return
    setTab('library')
    if (focus !== '') setLibraryFocusReq({ folder: focus })
  }, [])

  useEffect(() => {
    return window.api.onMediaFocusFolder((folder) => {
      setTab('library')
      if (folder !== '') setLibraryFocusReq({ folder })
    })
  }, [])

  // Code routing — the same two entry points as Library (cold-open query param,
  // live IPC event), both from the panel's Code button.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('tab') !== 'code') return
    setTab('code')
    const asked = q.get('codeTab')
    if (isCodeTab(asked)) setCodeTab(asked)
  }, [])

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'settings') setTab('settings')
    return window.api.onSettingsFocusSection(() => setTab('settings'))
  }, [])

  useEffect(() => {
    return window.api.onMightyFocusCode((codeTab) => {
      setTab('code')
      if (codeTab) setCodeTab(codeTab)
    })
  }, [])

  const showChat = useCallback(() => setTab('chat'), [])
  const openCapture = useCallback((folder: string) => {
    setTab('library')
    setLibraryFocusReq({ folder })
  }, [])

  const [nerdMode, setNerdModeState] = useState(readNerdMode)
  const [agentsOnScreen, setAgentsOnScreen] = useState<string[]>([])
  const setNerdMode = useCallback((on: boolean) => {
    rememberNerdMode(on)
    setNerdModeState(on)
  }, [])
  const [codeGrid, setCodeGrid] = useState(false)
  const [gridRequest, setGridRequest] = useState<GridRequest | null>(null)
  const gridOnCode = nerdMode && codeGrid && tab === 'code'
  useCloseKey(() => {
    if (tab === 'chat' || gridOnCode) {
      setShowRail(false)
      void window.api.mighty.setContextRailShown(false)
    } else if (tab === 'code') setShowAgentRail(false)
    else if (tab === 'bubba') setBubbaRail(false)
  })
  const openAgentInGrid = useCallback((label: string) => {
    setCodeGrid(true)
    setGridRequest({ kind: 'agent', label, nonce: Date.now() })
  }, [])
  const openSixOnCode = useCallback(
    (cwd: string, count?: number) => {
      setNerdMode(true)
      setCodeGrid(true)
      setGridRequest({ kind: 'six', cwd, count, nonce: Date.now() })
    },
    [setNerdMode]
  )
  const openAgentInChat = useCallback((label: string) => {
    setTab('chat')
    setGridRequest({ kind: 'agent', label, nonce: Date.now() })
  }, [])
  const showCode = useCallback(() => {
    setCodeGrid(false)
    setTab('code')
  }, [])

  const toggleSidebar = useCallback(() => {
    setShowList((prev) => {
      const next = !prev
      void window.api.mighty.setSidebarShown(next)
      return next
    })
  }, [])

  const toggleRail = useCallback(() => {
    setShowRail((prev) => {
      const next = !prev
      void window.api.mighty.setContextRailShown(next)
      return next
    })
  }, [])

  useEffect(() => {
    void (async () => {
      const s = await window.api.mighty.getSettings()
      setName(s.name.trim() !== '' ? s.name.trim() : CONFIG.MIGHTY.NAME)
    })()
  }, [])

  // ⌘1..⌘n jump straight to a tab (order mirrors the visible bar, so the numbers
  // shift when Code appears — what you see is what you press). Skipped while a
  // text field is focused so typing "1" in the composer never teleports tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        setNerdMode(!nerdMode)
        return
      }
      if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.code === 'KeyB' && isAdmin) {
        e.preventDefault()
        setTab(tab === 'bubba' ? mode : 'bubba')
        return
      }
      if (e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey && e.code === 'KeyB') {
        e.preventDefault()
        if (tab === 'chat' || gridOnCode) toggleRail()
        else if (tab === 'code') setShowAgentRail((v) => !v)
        else if (tab === 'bubba') setBubbaRail((v) => !v)
        return
      }
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        if (e.defaultPrevented) return
        e.preventDefault()
        if (e.code === 'BracketLeft') nav.goBack()
        else nav.goForward()
        return
      }
      if (e.key.toLowerCase() === 't') {
        e.preventDefault()
        requestRailTab()
        showBrowserRail()
        return
      }
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > tabs.length) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      setTab(tabs[n - 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabs, nerdMode, setNerdMode, tab, mode, isAdmin, gridOnCode, toggleRail, nav])

  const titleProject =
    tab === 'chat' ? chatProject : tab === 'code' && (codeTab ?? 'agents') === 'agents' ? codeProject : undefined

  return (
    <>
      <UpdateNudge readyInSidebar={showList && tab !== 'settings'} />
      <RecoveredRecordingSheet onOpen={openCapture} />
      <WindowFrame
        className="mighty-desktop"
        leading={
          nav.back && (
            <Button
              variant="bare"
              onClick={nav.goBack}
              title="Back (⌘[)"
              aria-label={`Back to ${tabLabel(nav.back)}`}
              className="inline-flex h-7 items-center gap-0.5 rounded-md pl-1 pr-2 text-sm font-medium text-muted transition-colors hover:bg-surface2/60 hover:text-on-surface"
            >
              <ChevronLeft size={14} />
              {tabLabel(nav.back)}
            </Button>
          )
        }
        icon={titleProject && <ProjectAvatar icon={titleProject.icon} imagePath={titleProject.imagePath} size={20} />}
        title={
          titleProject
            ? titleProject.name
            : tab === 'chat'
            ? CONFIG.MIGHTY.WINDOW_TITLE
            : tab === 'code'
              ? codeViewTitle(codeTab)
              : tab === 'bubba'
                ? CONFIG.UI_LABELS.BUBBA
                : (TABS.find((t) => t.id === tab)?.label ?? CONFIG.MIGHTY.WINDOW_TITLE)
        }
        action={
          <Row>
            {(tab === 'chat' || tab === 'code') && (
              <ViewModeMenu nerdMode={nerdMode} setNerdMode={setNerdMode} withTerminal={tab === 'code'} />
            )}
            {(tab === 'chat' || gridOnCode) && (
              <PaneToggleGroup
                leftOn={showList}
                rightOn={showRail}
                onToggleLeft={toggleSidebar}
                onToggleRight={toggleRail}
              />
            )}
            {tab === 'bubba' && (
              <PaneToggleGroup
                leftOn={showList}
                rightOn={bubbaRail}
                onToggleLeft={toggleSidebar}
                onToggleRight={() => setBubbaRail((v) => !v)}
                rightLabel="the browser"
              />
            )}
            {tab === 'code' && !gridOnCode && (
              <PaneToggleGroup
                leftOn={showList}
                rightOn={showAgentRail}
                onToggleLeft={toggleSidebar}
                onToggleRight={() => setShowAgentRail((v) => !v)}
                leftLabel="the list"
                rightLabel="the details"
              />
            )}
          </Row>
        }
      >
        <div className="flex min-h-0 flex-1">
          {showList && tab !== 'settings' && !simple && (
            <MightySidebar
              tab={tab}
              mode={sidebarMode}
              codeAvailable={relay.enabled || tab === 'code'}
              codePending={relay.pending.length}
              codeView={codeTab}
              openSessions={openSessions}
              onSelect={(next) => {
                if (next === 'code' && tab === 'code') setCodeTab('agents')
                if (next === 'chat' || next === 'code') setAllMode(false)
                setTab(next)
              }}
              onAll={() => {
                setAllMode(true)
                setTab('chat')
              }}
              onAgentsSlot={setAgentsSlot}
              onCodeView={(view) => {
                setCodeTab(tab === 'code' && codeTab === view ? 'agents' : view)
                showCode()
              }}
              onActionsSlot={setActionsSlot}
              onListSlot={setListSlot}
            />
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* ChatTab stays mounted across tab switches (just hidden) so a live
          conversation and its own state survive a trip through History/Jobs/Made —
          switching tabs shouldn't reset an in-progress chat. */}
            <div className={tab === 'chat' || gridOnCode ? 'mighty-chat-host' : 'hidden'}>
              <ChatTab
                name={name}
                nameFormat={tabNameFormat}
                handoff={historyHandoff}
                onHandoffConsumed={() => setHistoryHandoff(null)}
                showRail={showRail}
                toggleSidebar={toggleSidebar}
                setShowList={setShowList}
                projectsRevision={projectsRevision}
                actionsSlot={chatOwnsSidebar ? actionsSlot : null}
                listSlot={chatOwnsSidebar ? listSlot : null}
                onShowChat={showChat}
                visible={tab === 'chat'}
                chatMode={chatOwnsSidebar && tab !== 'settings' && tab !== 'bubba'}
                allMode={inAll}
                nerdMode={nerdMode}
                onNerdMode={setNerdMode}
                relay={relay}
                gridRequest={gridRequest}
                onAgentsOnScreen={setAgentsOnScreen}
                onProjectInView={setChatProject}
              />
            </div>
            {codeOpened && (
              <div className={tab === 'code' && !gridOnCode ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} style={{ height: bodyHeight }}>
                <CodePanel
                  showAgentList={showList}
                  listSlot={inAll ? agentsSlot : mode === 'code' ? listSlot : null}
                  listHeading={inAll ? CONFIG.UI_LABELS.SIDEBAR_AGENTS : undefined}
                  actionsSlot={!inAll && mode === 'code' ? actionsSlot : null}
                  onOpenCount={setOpenSessions}
                  onProjectInView={setCodeProject}
                  active={tab === 'code'}
                  showAgentRail={showAgentRail}
                  onToggleAgentRail={() => setShowAgentRail((v) => !v)}
                  initialTab={codeTab}
                  tabsInSidebar
                  onTabChange={setCodeTab}
                  onShow={showCode}
                  onOpenAgent={inAll ? openAgentInChat : nerdMode ? (label) => {
                    setTab('code')
                    openAgentInGrid(label)
                  } : undefined}
                  onOpenSix={openSixOnCode}
                  agentsOnScreen={nerdMode ? agentsOnScreen : undefined}
                  known={relay.known}
                  pending={relay.pending}
                  resolved={relay.resolved}
                  dismissed={relay.dismissed}
                  onRespond={relay.respond}
                  onUndismiss={relay.undismiss}
                  variant="tab"
                  status={relay.status}
                  clients={relay.clients}
                  refusal={relay.refusal}
                  onClearRefusal={relay.clearRefusal}
                />
              </div>
            )}
            {bubbaOpened && (
              <div className={tab === 'bubba' ? 'flex min-h-0 flex-1' : 'hidden'} style={{ height: bodyHeight }}>
                <BubbaTab active={tab === 'bubba'} showBrowser={bubbaRail} />
              </div>
            )}
            {tab === 'jobs' && <JobsTab name={name} />}
            {tab === 'made' && <MadeTab name={name} />}
            {tab === 'library' && (
              <div className="flex flex-col" style={{ height: bodyHeight }}>
                <div className="flex gap-1 px-5 pt-3">
                  <Button variant={showMade ? 'ghost' : 'secondary'} onClick={() => setShowMade(false)}>
                    {CONFIG.UI_LABELS.LIBRARY_VIEW_MEDIA}
                  </Button>
                  <Button variant={showMade ? 'secondary' : 'ghost'} onClick={() => setShowMade(true)}>
                    {CONFIG.UI_LABELS.LIBRARY_VIEW_MADE}
                  </Button>
                </div>
                {showMade ? (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <MadeTab name={name} />
                  </div>
                ) : (
                  <MediaLibraryBody focusRequest={libraryFocusReq} style={{ flex: 1, minHeight: 0 }} />
                )}
              </div>
            )}
            {tab === 'settings' && (
              <SettingsApp
                onBack={simple ? undefined : () => setTab(mode)}
                chat={settingsHooks}
              />
            )}
          </div>
        </div>
      </WindowFrame>
    </>
  )
}

function BubbaTab({
  active,
  showBrowser
}: {
  active: boolean
  showBrowser: boolean
}): JSX.Element {
  const layoutRef = useRef<HTMLDivElement>(null)
  const railResize = useRailResize(layoutRef)
  return (
    <div ref={layoutRef} className="mighty-chat-layout flex min-h-0 min-w-0 flex-1">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" style={{ transform: 'translateZ(0)' }}>
        <CanvasApp active={active} />
      </div>
      {showBrowser && <div {...railResize.gripProps} />}
      {showBrowser && (
        <div className="chat-rail" data-mode="browser" style={railResize.style}>
          <SideBrowser conversationKey="bubba" takesLinks={active} />
        </div>
      )}
    </div>
  )
}
