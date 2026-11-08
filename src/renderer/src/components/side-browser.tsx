import { CONFIG } from '@shared/config'
import { BUSINESS_LABELS } from '@shared/infra'
import { sendTextToComposer, sendToComposer } from '../hooks/useAttachments'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code,
  ExternalLink,
  FileSearch,
  FolderTree,
  FileText,
  Globe,
  KeyRound,
  ListChecks,
  MessageCircle,
  Columns2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelsTopLeft,
  Pause,
  Play,
  Plus,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Square,
  SquareDashedMousePointer,
  X
} from 'lucide-react'
import { Button } from './Button'
import { SideBrowserImport } from './side-browser-import'
import { SideBrowserTask } from './side-browser-task'
import { BrowserPageContext, type BrowserPage } from './session-thread'
import ReplyApp, { useReplyChats, type ReplyAim } from '../ReplyApp'
import { BrokenModBar, ModOffers, ModsMenu, type ModEdit } from './side-browser-mods'
import { FileView } from './file-view'
import { FilePicker } from './file-picker'
import {
  confirmCloseFile,
  defaultFileMode,
  fileKind,
  fileName,
  filePathOf,
  type FileMode
} from './file-kinds'
import type {
  SideBrowserPermission,
  SideBrowserShortcut,
  SideBrowserSuggestion,
  SideBrowserTabState,
  SharedMod,
  SiteModState
} from '../../../shared/types'
import {
  CLOSE_PANEL_EVENT,
  RAIL_PANEL,
  RAIL_BROWSER_EVENT,
  fileUrl,
  takeRailTabRequest,
  takeRailUrl,
  type RailMode,
  UNSAVED_PREFIX
} from '../hooks/useRailMode'
import './side-browser.css'

interface BrowserTab {
  key: string
  viewId?: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  error?: string
  findOpen?: boolean
  found?: { active: number; matches: number }
  ask?: SideBrowserPermission
  sitePermissions?: SideBrowserPermission[]
  fileMode?: FileMode
  dirty?: boolean
  agentDoing?: string
  agentPaused?: boolean
  mods?: SiteModState[]
  modSuggestion?: string
  sharedMods?: SharedMod[]
  modLink?: SharedMod
}

interface BrowserStore {
  tabs: BrowserTab[]
  active: string | null
  split?: string | null
}

const STORAGE_PREFIX = 'mm.sideBrowser.'
const TOOLS = CONFIG.SIDE_BROWSER_TOOLS.filter((tool) => tool.shown)
const PLACE_POLL_MS = 150
const COVERING_SELECTOR =
  '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'

const stores = new Map<string, BrowserStore>()
const closedUrls = new Map<string, string[]>()

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: tabs still live for this run, they just won't come back after a restart.
  }
}

function useSuggestions(draft: string | null): SideBrowserSuggestion[] {
  const [items, setItems] = useState<SideBrowserSuggestion[]>([])
  useEffect(() => {
    const q = draft?.trim() ?? ''
    if (!q || /^https?:\/\//i.test(q)) {
      setItems([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void window.api.sideBrowser.suggest(q).then((r) => live && setItems(r))
    }, 90)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [draft])
  return draft === null ? [] : items
}

interface Places {
  top: SideBrowserSuggestion[]
  recent: SideBrowserSuggestion[]
  loaded: boolean
}

function loadPlaces(): Promise<Places> {
  return Promise.all([window.api.sideBrowser.topSites(), window.api.sideBrowser.recent()]).then(([top, recent]) => ({
    top,
    recent,
    loaded: true
  }))
}

function usePlaces(show: boolean): Places & { forget: (list: 'top' | 'recent', url: string) => void } {
  const [places, setPlaces] = useState<Places>({ top: [], recent: [], loaded: false })
  const latest = useRef(0)
  useEffect(() => {
    if (!show) return
    const mine = ++latest.current
    void loadPlaces().then((next) => mine === latest.current && setPlaces(next))
  }, [show])
  const forget = (list: 'top' | 'recent', url: string): void => {
    const mine = ++latest.current
    setPlaces((p) => ({ ...p, [list]: p[list].filter((s) => s.url !== url) }))
    const { forgetTopSite, forgetRecent } = window.api.sideBrowser
    void (list === 'top' ? forgetTopSite(url) : forgetRecent(url))
      .then(loadPlaces)
      .then((next) => mine === latest.current && setPlaces(next))
  }
  return { ...places, forget }
}

function SuggestionFavicon({ src }: { src?: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  return src && !failed ? (
    <img src={src} alt="" className="side-browser-favicon" onError={() => setFailed(true)} />
  ) : (
    <Globe size={13} className="side-browser-favicon" />
  )
}

function coldTab(url: string, title = ''): BrowserTab {
  return {
    key: crypto.randomUUID(),
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false
  }
}

function loadStore(conversationKey: string): BrowserStore {
  const live = stores.get(conversationKey)
  if (live) return live
  let restored: BrowserStore = { tabs: [], active: null }
  if (conversationKey.startsWith(UNSAVED_PREFIX)) {
    stores.set(conversationKey, restored)
    return restored
  }
  try {
    const saved = JSON.parse(readStorage(STORAGE_PREFIX + conversationKey) ?? 'null') as {
      urls: { url: string; title: string }[]
      active: number
    } | null
    if (saved?.urls?.length) {
      const tabs = saved.urls.map((t) => coldTab(t.url, t.title))
      restored = { tabs, active: tabs[Math.min(saved.active, tabs.length - 1)]?.key ?? null }
    }
  } catch {
    restored = { tabs: [], active: null }
  }
  stores.set(conversationKey, restored)
  return restored
}

function saveStore(conversationKey: string, store: BrowserStore): void {
  stores.set(conversationKey, store)
  if (conversationKey.startsWith(UNSAVED_PREFIX)) return
  const urls = store.tabs
    .filter((t) => t.url && t.url !== 'about:blank')
    .map((t) => ({ url: t.url, title: t.title }))
  const active = Math.max(
    0,
    store.tabs.findIndex((t) => t.key === store.active)
  )
  writeStorage(STORAGE_PREFIX + conversationKey, JSON.stringify({ urls, active }))
}

export function RailModeSwitch({
  mode,
  onMode
}: {
  mode: RailMode
  onMode: (mode: RailMode) => void
}): JSX.Element {
  return (
    <div className="side-rail-switch" role="tablist">
      {(['details', 'browser'] as const).map((m) => (
        <Button
          key={m}
          variant="bare"
          role="tab"
          aria-selected={mode === m}
          title={m === 'details' ? 'Details' : 'Browser'}
          data-on={mode === m ? '' : undefined}
          className="side-rail-switch-btn"
          onClick={() => onMode(m)}
        >
          {m === 'details' ? <PanelsTopLeft size={14} strokeWidth={2.25} /> : <Globe size={14} strokeWidth={2.25} />}
          <span className="side-rail-switch-label">{m === 'details' ? 'Details' : 'Browser'}</span>
        </Button>
      ))}
    </div>
  )
}

export function RailEdgeToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): JSX.Element {
  const label = open ? 'Hide side panel' : 'Show side panel'
  return (
    <div className="rail-edge-toggle" data-open={open ? '' : undefined}>
      <Button
        variant="bare"
        className="rail-edge-toggle-btn"
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={onToggle}
        title={label}
        aria-label={label}
      >
        {open ? <ChevronRight size={13} strokeWidth={2.5} /> : <ChevronLeft size={13} strokeWidth={2.5} />}
      </Button>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
}

function shortPath(url: string): string {
  return prettyUrl(url.replace(/[?#].*$/, ''))
}

function tabLabel(tab: BrowserTab): string {
  const path = filePathOf(tab.url)
  if (path) return fileName(path)
  return tab.title || (tab.url && tab.url !== 'about:blank' ? hostOf(tab.url) : 'New tab')
}

function needsView(tab: BrowserTab): boolean {
  const path = filePathOf(tab.url)
  return !path || fileKind(path) === 'html'
}

function pageHidden(tab: BrowserTab | null): boolean {
  const path = filePathOf(tab?.url)
  return (
    Boolean(tab?.error) || (path !== null && (tab?.fileMode ?? defaultFileMode(path)) !== 'preview')
  )
}

function isCovered(rect: DOMRect): boolean {
  for (const el of document.querySelectorAll(COVERING_SELECTOR)) {
    const r = el.getBoundingClientRect()
    if (r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom)
      return true
  }
  return false
}

function usePlacement(
  viewId: string | undefined,
  hidden: boolean
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!viewId || !el || hidden) return
    let last = ''
    const sync = (): void => {
      const rect = el.getBoundingClientRect()
      const covered = isCovered(rect)
      const bounds =
        rect.width < 1 || rect.height < 1 || covered
          ? null
          : { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      const sig = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : 'hidden'
      if (sig === last) return
      last = sig
      if (!covered) {
        void window.api.sideBrowser.place(viewId, bounds).then(() => {
          if (bounds && last === sig) el.style.backgroundImage = ''
        })
        return
      }
      void window.api.sideBrowser
        .still(viewId)
        .catch(() => null)
        .then(async (shot) => {
          if (shot) {
            const img = new Image()
            img.src = shot
            await img.decode().catch(() => undefined)
          }
          if (last !== sig) return
          if (shot) el.style.backgroundImage = `url(${shot})`
          requestAnimationFrame(() => {
            if (last === sig) void window.api.sideBrowser.place(viewId, null)
          })
        })
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    window.addEventListener('resize', sync)
    const poll = setInterval(sync, PLACE_POLL_MS)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      clearInterval(poll)
      last = 'unmounted'
      el.style.backgroundImage = ''
      void window.api.sideBrowser.place(viewId, null)
    }
  }, [viewId, hidden])
  return ref
}

function PermissionBar({
  viewId,
  ask,
  site,
  onClose
}: {
  viewId: string
  ask?: SideBrowserPermission
  site: SideBrowserPermission[]
  onClose: () => void
}): JSX.Element {
  const decide = (kind: string, decision: 'allow' | 'block' | 'reset'): void =>
    void window.api.sideBrowser.permission(viewId, kind, decision)
  if (ask)
    return (
      <div className="side-browser-permission">
        <span>
          <b>{hostOf(ask.origin)}</b> wants {ask.label}
        </span>
        <Button variant="ghost" onClick={() => decide(ask.kind, 'block')}>
          Block
        </Button>
        <Button variant="primary" onClick={() => decide(ask.kind, 'allow')}>
          Allow
        </Button>
      </div>
    )
  return (
    <div className="side-browser-permission side-browser-permission-list">
      {site.map((p) => (
        <div key={p.kind} className="side-browser-permission">
          <span>
            {p.allowed ? 'Allowed' : 'Blocked'}: {p.label}
          </span>
          <Button variant="ghost" onClick={() => decide(p.kind, p.allowed ? 'block' : 'allow')}>
            {p.allowed ? 'Block' : 'Allow'}
          </Button>
          <Button variant="ghost" onClick={() => decide(p.kind, 'reset')}>
            Ask next time
          </Button>
        </div>
      ))}
      <Button variant="bare" className="side-browser-nav" aria-label="Close" onClick={onClose}>
        <X size={13} />
      </Button>
    </div>
  )
}

function FindBar({
  viewId,
  found
}: {
  viewId: string
  found?: { active: number; matches: number }
}): JSX.Element {
  const [text, setText] = useState('')
  const find = (value: string, forward = true): void =>
    void window.api.sideBrowser.find(viewId, value, forward)
  const close = (): void => void window.api.sideBrowser.find(viewId, null)
  return (
    <div className="side-browser-find">
      <input
        autoFocus
        value={text}
        placeholder="Find in page"
        spellCheck={false}
        onChange={(e) => {
          setText(e.currentTarget.value)
          find(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          else if (e.key === 'Enter' && text) find(text, !e.shiftKey)
        }}
      />
      <span className="side-browser-find-count">
        {text && found ? (found.matches ? `${found.active} of ${found.matches}` : 'No matches') : ''}
      </span>
      <Button
        variant="bare"
        className="side-browser-nav"
        aria-label="Previous match"
        title="Previous match (⇧↩)"
        disabled={!found?.matches}
        onClick={() => find(text, false)}
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        variant="bare"
        className="side-browser-nav"
        aria-label="Next match"
        title="Next match (↩)"
        disabled={!found?.matches}
        onClick={() => find(text)}
      >
        <ChevronDown size={14} />
      </Button>
      <Button
        variant="bare"
        className="side-browser-nav"
        aria-label="Close find"
        title="Close (Esc)"
        onClick={close}
      >
        <X size={13} />
      </Button>
    </div>
  )
}

function AgentBar({ viewId, doing, paused }: { viewId: string; doing: string; paused: boolean }): JSX.Element {
  return (
    <div className="side-browser-agent" data-paused={paused || undefined}>
      <span className="side-browser-agent-dot" />
      <span className="side-browser-agent-doing">{paused ? 'Paused - your turn' : `MightyMouse: ${doing}`}</span>
      <Button variant="ghost" onClick={() => void window.api.sideBrowser.pauseAgent(viewId, !paused)}>
        {paused ? <Play size={12} /> : <Pause size={12} />}
        {paused ? 'Resume' : 'Pause'}
      </Button>
      <Button variant="ghost" onClick={() => void window.api.sideBrowser.stopAgent(viewId)}>
        <Square size={11} />
        Stop
      </Button>
    </div>
  )
}

interface BarTool {
  key: string
  label: string
  icon: ReactNode
  keep?: boolean
  on?: boolean
  disabled?: boolean
  run: () => void
}

function MoreMenu({ tools }: { tools: BarTool[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div ref={ref} className="side-browser-more">
      <Button
        variant="bare"
        className="side-browser-nav"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        data-on={open || tools.some((t) => t.on) ? '' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={14} />
      </Button>
      {open && (
        <div className="side-browser-menu" role="menu">
          {tools.map((t) => (
            <Button
              key={t.key}
              variant="bare"
              role="menuitemcheckbox"
              aria-checked={Boolean(t.on)}
              className="side-browser-menu-row"
              data-keep={t.keep ? '' : undefined}
              data-on={t.on ? '' : undefined}
              disabled={t.disabled}
              onClick={() => {
                setOpen(false)
                t.run()
              }}
            >
              {t.icon}
              {t.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

const openChatBig = (id: string): void => void window.api.mighty.open(false, id)

type BrowserChatProps = {
  aim?: ReplyAim
  page: () => BrowserPage | undefined
  onClose: () => void
  minimized: boolean
  onMinimize: (minimized: boolean) => void
}
const aimKeyOf = (aim?: ReplyAim): string => (typeof aim === 'object' ? `cwd:${aim.cwd}` : (aim ?? ''))

const BrowserChat = memo(function BrowserChat({ aim, page, onClose, minimized, onMinimize }: BrowserChatProps): JSX.Element {
  const chat = useReplyChats(openChatBig)
  return (
    <BrowserPageContext.Provider value={page}>
      <div className="side-browser-chat" data-grid-pane data-min={minimized ? '' : undefined}>
        <ReplyApp
          embedded
          aim={aim}
          chat={chat}
          onHide={onClose}
          onOpenBig={(ref) => window.api.replyWindowOpenBig(ref)}
          minimized={minimized}
          onMinimize={onMinimize}
        />
      </div>
    </BrowserPageContext.Provider>
  )
},
(a, b) =>
  aimKeyOf(a.aim) === aimKeyOf(b.aim) &&
  a.page === b.page &&
  a.onClose === b.onClose &&
  a.minimized === b.minimized &&
  a.onMinimize === b.onMinimize)

export function SideBrowser({
  conversationKey,
  head,
  cwd,
  chatAim,
  className = '',
  takesLinks = true
}: {
  conversationKey: string
  head?: ReactNode
  cwd?: string
  chatAim?: ReplyAim
  className?: string
  takesLinks?: boolean
}): JSX.Element {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const store = loadStore(conversationKey)
  const [typed, setTyped] = useState<{ key: string; text: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [tasking, setTasking] = useState(false)
  const [chatting, setChatting] = useState(false)
  const [chatMin, setChatMin] = useState(false)
  const pageRef = useRef<BrowserPage | undefined>(undefined)
  const pageNow = useCallback(() => pageRef.current, [])
  const closeChat = useCallback(() => {
    setChatting(false)
    setChatMin(false)
  }, [])
  const [permsOpen, setPermsOpen] = useState(false)
  const [modEdit, setModEdit] = useState<ModEdit | null>(null)
  const editMod = (edit: Omit<ModEdit, 'key'>): void => {
    setModEdit({ ...edit, key: Date.now() })
    setTasking(true)
  }
  const [finding, setFinding] = useState(false)
  const [focus, setFocus] = useState(false)
  const draft = typed?.key === conversationKey ? typed.text : null
  const setDraft = (text: string | null): void =>
    setTyped(text === null ? null : { key: conversationKey, text })
  const opening = useRef(new Set<string>())
  const keyRef = useRef(conversationKey)
  const [projectKind, setProjectKind] = useState<string>()
  const projectRef = useRef<{ id: string; kinds: string[] } | undefined>(undefined)

  useEffect(() => {
    keyRef.current = conversationKey
  }, [conversationKey])

  useEffect(() => {
    setProjectKind(undefined)
    projectRef.current = undefined
    if (!cwd) return
    let live = true
    void window.api.infra.list().then((all) => {
      const mine = all.find((i) => i.repoFolder === cwd)
      if (!live || !mine) return
      projectRef.current = { id: mine.projectId, kinds: mine.record?.business ?? [] }
      setProjectKind(projectRef.current.kinds[0])
    })
    const off = window.api.infra.onChanged((next) => {
      if (next.repoFolder !== cwd) return
      projectRef.current = { id: next.projectId, kinds: next.record?.business ?? [] }
      setProjectKind(projectRef.current.kinds[0])
    })
    return () => {
      live = false
      off()
    }
  }, [cwd])

  const update = useCallback((fn: (prev: BrowserStore) => BrowserStore) => {
    const key = keyRef.current
    const next = fn(stores.get(key) ?? loadStore(key))
    saveStore(key, next)
    rerender()
  }, [])

  useEffect(() => {
    const offState = window.api.sideBrowser.onState((state: SideBrowserTabState) => {
      for (const [key, s] of stores) {
        if (!s.tabs.some((t) => t.viewId === state.id)) continue
        const next = {
          ...s,
          tabs: s.tabs.map((t) =>
            t.viewId === state.id
              ? { ...t, ...state, key: t.key, viewId: t.viewId, url: state.url || t.url }
              : t
          )
        }
        saveStore(key, next)
        if (key === keyRef.current) rerender()
      }
    })
    const offStyle = window.api.sideBrowser.onPageAction(({ viewId, url, action }) => {
      const answer = (word: 'saved' | 'failed' | 'chat'): void => {
        const page = stores.get(keyRef.current)?.tabs.find((t) => t.viewId === viewId)?.url
        if (page) void window.api.sideBrowser.navigate(viewId, `${page.split('#')[0]}#app-${word}`)
      }
      if (action.do === 'compose') {
        if (sendTextToComposer(action.text)) answer('chat')
        else void window.api.sideBrowser.navigate(viewId, url)
        return
      }
      const project = projectRef.current
      if (!project || !Object.hasOwn(BUSINESS_LABELS, action.kind)) return answer('failed')
      void window.api.infra
        .setTags(project.id, 'business', [action.kind, ...project.kinds.filter((kind) => kind !== action.kind)])
        .then((saved) => answer(saved.record?.business?.[0] === action.kind ? 'saved' : 'failed'))
        .catch(() => answer('failed'))
    })
    const offPopup = window.api.sideBrowser.onPopup(({ openerId, url }) => {
      const s = stores.get(keyRef.current)
      const at = s?.tabs.findIndex((t) => t.viewId === openerId) ?? -1
      if (at < 0) return
      const tab = coldTab(url)
      update((prev) => ({
        tabs: [...prev.tabs.slice(0, at + 1), tab, ...prev.tabs.slice(at + 1)],
        active: tab.key
      }))
    })
    return () => {
      offState()
      offStyle()
      offPopup()
    }
  }, [update])

  const active = store.tabs.find((t) => t.key === store.active) ?? null
  const splitTab =
    (store.split !== store.active && store.tabs.find((t) => t.key === store.split)) || null

  useEffect(() => {
    for (const tab of [active, splitTab]) {
      if (!tab || tab.viewId || !needsView(tab) || opening.current.has(tab.key)) continue
      const key = tab.key
      opening.current.add(key)
      void window.api.sideBrowser.open(tab.url).then((state) => {
        opening.current.delete(key)
        if (!state) return
        const owner = [...stores.entries()].find(([, s]) => s.tabs.some((t) => t.key === key))
        if (!owner) {
          void window.api.sideBrowser.close(state.id)
          return
        }
        const [ownerKey, s] = owner
        const next = {
          ...s,
          tabs: s.tabs.map((t) => (t.key === key ? { ...t, viewId: state.id } : t))
        }
        saveStore(ownerKey, next)
        if (ownerKey === keyRef.current) rerender()
      })
    }
  }, [active, splitTab])

  const placeholder = usePlacement(active?.viewId, pageHidden(active) || importing || finding)
  const splitPlaceholder = usePlacement(
    splitTab?.viewId,
    !splitTab || pageHidden(splitTab) || importing || finding
  )
  const activePath = filePathOf(active?.url)
  const patchTab = useCallback(
    (key: string, patch: Partial<BrowserTab>) => {
      const tab = stores.get(keyRef.current)?.tabs.find((t) => t.key === key)
      if (!tab || Object.entries(patch).every(([k, v]) => tab[k as keyof BrowserTab] === v)) return
      update((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t))
      }))
    },
    [update]
  )
  const showBeside = useCallback(
    (viewId: string) => {
      update((prev) => {
        const tab = prev.tabs.find((t) => t.viewId === viewId)
        return tab && tab.key !== prev.active ? { ...prev, split: tab.key } : prev
      })
    },
    [update]
  )
  const toggleSplit = (): void =>
    update((prev) => {
      if (prev.split && prev.split !== prev.active) return { ...prev, split: null }
      const at = prev.tabs.findIndex((t) => t.key === prev.active)
      const other = prev.tabs[at + 1] ?? prev.tabs[at - 1]
      return other ? { ...prev, split: other.key } : prev
    })

  const newTab = useCallback(
    (url = 'about:blank') => {
      const tab = coldTab(url)
      setFinding(false)
      update((prev) => ({ tabs: [...prev.tabs, tab], active: tab.key }))
      setDraft(url === 'about:blank' ? '' : null)
    },
    [update]
  )

  const openFile = useCallback(
    (path: string) => {
      const open = stores.get(keyRef.current)?.tabs.find((t) => filePathOf(t.url) === path)
      if (open) update((prev) => ({ ...prev, active: open.key }))
      else newTab(fileUrl(path))
    },
    [newTab, update]
  )

  useEffect(() => {
    if (!takesLinks) return
    const take = (): void => {
      const url = takeRailUrl()
      const path = filePathOf(url ?? undefined)
      const open = path && stores.get(keyRef.current)?.tabs.find((t) => filePathOf(t.url) === path)
      if (open) update((prev) => ({ ...prev, active: open.key }))
      else if (url) newTab(url)
      else if (takeRailTabRequest()) newTab()
    }
    take()
    window.addEventListener(RAIL_BROWSER_EVENT, take)
    return () => window.removeEventListener(RAIL_BROWSER_EVENT, take)
  }, [newTab, update, takesLinks])

  const closeTab = useCallback(
    (key: string) => {
      const tab = stores.get(keyRef.current)?.tabs.find((t) => t.key === key)
      const path = filePathOf(tab?.url)
      if (path && !confirmCloseFile(key, path)) return
      update((prev) => {
        const at = prev.tabs.findIndex((t) => t.key === key)
        const gone = prev.tabs[at]
        if (gone?.viewId) void window.api.sideBrowser.close(gone.viewId)
        if (gone?.url && gone.url !== 'about:blank')
          closedUrls.set(keyRef.current, [...(closedUrls.get(keyRef.current) ?? []), gone.url])
        const tabs = prev.tabs.filter((t) => t.key !== key)
        const active =
          prev.active === key ? (tabs[Math.min(at, tabs.length - 1)]?.key ?? null) : prev.active
        return { tabs, active }
      })
    },
    [update]
  )

  const asideRef = useRef<HTMLElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [annotating, setAnnotating] = useState(false)
  const annotatingIn = useRef<string | null>(null)
  const stopAnnotate = useCallback(() => {
    const id = annotatingIn.current
    annotatingIn.current = null
    setAnnotating(false)
    if (id) void window.api.sideBrowser.annotateEnd(id, null)
  }, [])
  const startAnnotate = useCallback(
    async (viewId: string) => {
      annotatingIn.current = viewId
      setAnnotating(true)
      while (annotatingIn.current === viewId) {
        const hit = await window.api.sideBrowser.annotate(viewId)
        if (annotatingIn.current !== viewId) return
        if (!hit) return stopAnnotate()
        const sent = sendToComposer(hit.path) && sendTextToComposer(hit.note, true)
        const copied =
          sent || (await navigator.clipboard.writeText(`${hit.note}\n${hit.path}`).then(() => true, () => false))
        const note = sent ? 'Added to chat' : copied ? 'Copied - paste it into a chat' : 'Open a chat to send this'
        await window.api.sideBrowser.annotateEnd(viewId, note)
      }
    },
    [stopAnnotate]
  )
  useEffect(() => {
    if (annotatingIn.current && annotatingIn.current !== active?.viewId) stopAnnotate()
  }, [active?.viewId, stopAnnotate])
  useEffect(() => stopAnnotate, [stopAnnotate])

  const shortcut = useCallback(
    (cmd: SideBrowserShortcut): boolean => {
      const s = stores.get(keyRef.current)
      if (!s) return false
      const at = s.tabs.findIndex((t) => t.key === s.active)
      if (cmd === 'newTab') newTab()
      else if (cmd === 'focusAddress') addressRef.current?.focus()
      else if (cmd === 'files') {
        if (!cwd) return false
        setFinding(true)
      } else if (cmd === 'reopenTab') {
        const url = closedUrls.get(keyRef.current)?.pop()
        if (!url) return false
        newTab(url)
      } else if (at < 0) return false
      else if (cmd === 'closeTab') closeTab(s.tabs[at].key)
      else if (cmd === 'annotate') {
        const viewId = s.tabs[at].viewId
        if (annotatingIn.current) stopAnnotate()
        else if (viewId) void startAnnotate(viewId)
        else return false
      }
      else {
        const step = cmd === 'nextTab' ? 1 : -1
        const next = s.tabs[(at + step + s.tabs.length) % s.tabs.length]
        update((prev) => ({ ...prev, active: next.key }))
      }
      return true
    },
    [newTab, closeTab, update, setFinding, cwd, startAnnotate, stopAnnotate]
  )

  const inUse = useRef(false)
  useEffect(() => {
    const live = (): boolean => inUse.current && Boolean(asideRef.current?.getClientRects().length)
    const track = (e: Event): void => {
      inUse.current = Boolean(asideRef.current?.contains(e.target as Node))
    }
    const off = window.api.sideBrowser.onShortcut(({ viewId, shortcut: cmd }) => {
      if (!stores.get(keyRef.current)?.tabs.some((t) => t.viewId === viewId)) return
      inUse.current = true
      shortcut(cmd)
    })
    const aside = asideRef.current
    const onClosePanel = (e: Event): void => {
      if (stores.get(keyRef.current)?.tabs.some((t) => t.url) && shortcut('closeTab')) e.preventDefault()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey || !live()) return
      const cmd: SideBrowserShortcut | null = e.shiftKey
        ? e.code === 'BracketLeft'
          ? 'prevTab'
          : e.code === 'BracketRight'
            ? 'nextTab'
            : e.code === 'KeyT'
              ? 'reopenTab'
              : e.code === 'Period'
                ? 'annotate'
                : null
        : e.code === 'KeyL'
          ? 'focusAddress'
          : e.code === 'KeyP'
            ? 'files'
            : null
      if (cmd && shortcut(cmd)) e.preventDefault()
    }
    window.addEventListener('pointerdown', track, true)
    window.addEventListener('focusin', track, true)
    aside?.addEventListener(CLOSE_PANEL_EVENT, onClosePanel)
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('pointerdown', track, true)
      window.removeEventListener('focusin', track, true)
      aside?.removeEventListener(CLOSE_PANEL_EVENT, onClosePanel)
      window.removeEventListener('keydown', onKey)
    }
  }, [shortcut])

  const go = useCallback(
    (address: string) => {
      setDraft(null)
      if (!address.trim()) return
      const path = address.trim().startsWith('/') ? address.trim() : filePathOf(address.trim())
      if (path) return openFile(path)
      if (active?.viewId) void window.api.sideBrowser.navigate(active.viewId, address)
      else newTab(address)
    },
    [active, newTab, openFile]
  )

  const pane = (tab: BrowserTab, ref: React.RefObject<HTMLDivElement | null>): ReactNode => {
    const page = <div ref={ref} className="side-browser-page" title={tabLabel(tab)} />
    const path = filePathOf(tab.url)
    if (!path) return page
    return (
      <FileView
        key={tab.key}
        tabKey={tab.key}
        path={path}
        mode={tab.fileMode ?? defaultFileMode(path)}
        onMode={(fileMode) => patchTab(tab.key, { fileMode })}
        onDirty={(dirty) => patchTab(tab.key, { dirty })}
        page={page}
        pageViewId={tab.viewId}
        onPath={(next) => patchTab(tab.key, { url: fileUrl(next), title: fileName(next) })}
      />
    )
  }

  const run = (cmd: 'back' | 'forward' | 'reload' | 'stop' | 'devtools' | 'external'): void => {
    if (active?.viewId) void window.api.sideBrowser.command(active.viewId, cmd)
  }

  const shownUrl = active?.url && active.url !== 'about:blank' ? active.url : ''
  const tools: BarTool[] = [
    {
      key: 'external',
      label: 'Open in your browser',
      icon: <ExternalLink size={13} />,
      disabled: !shownUrl.startsWith('http'),
      run: () => run('external')
    },
    {
      key: 'devtools',
      label: 'Inspect page',
      icon: <Code size={13} />,
      disabled: !active?.viewId,
      run: () => run('devtools')
    },
    {
      key: 'import',
      label: 'Bring sign-ins from your browser',
      icon: <KeyRound size={13} />,
      on: importing,
      run: () => setImporting((v) => !v)
    },
    {
      key: 'split',
      label: splitTab ? 'Close split view' : 'Show two tabs side by side',
      icon: <Columns2 size={13} />,
      on: Boolean(splitTab),
      disabled: store.tabs.length < 2,
      run: toggleSplit
    },
    {
      key: 'annotate',
      label: annotating ? 'Stop pointing (Esc)' : 'Point at something to change it (⇧⌘.)',
      icon: <SquareDashedMousePointer size={13} />,
      keep: true,
      on: annotating,
      disabled: !active?.viewId || !shownUrl.startsWith('http'),
      run: () => (annotating ? stopAnnotate() : active?.viewId && void startAnnotate(active.viewId))
    },
    {
      key: 'chat',
      label: chatMin ? 'Open the chat' : chatting ? 'Close the chat' : 'Chat about this page',
      icon: <MessageCircle size={13} />,
      keep: true,
      on: chatting,
      run: () => (chatMin ? setChatMin(false) : chatting ? closeChat() : setChatting(true))
    }
  ]
  pageRef.current =
    active && shownUrl.startsWith('http') ? { url: shownUrl, title: active.title ?? '' } : undefined
  const brokenMod = active?.mods?.find((m) => m.on && m.broken)
  const [focused, setFocused] = useState(false)
  const [sel, setSel] = useState(-1)
  const suggestions = useSuggestions(focused ? draft : null)
  const emptyTab = Boolean(active) && !active?.error && !shownUrl && !importing
  const places = usePlaces(emptyTab || (!active && !importing))
  const hasPlaces = places.top.length > 0 || places.recent.length > 0

  return (
    <aside
      ref={asideRef}
      className={`side-browser ${className}`.trim()}
      data-closes={RAIL_PANEL}
      data-focus={focus ? '' : undefined}
    >
      <div className="side-browser-head">
        {head}
        <Button
          variant="bare"
          className="side-browser-nav"
          aria-label={focus ? 'Make the browser smaller' : 'Make the browser bigger'}
          aria-pressed={focus}
          title={focus ? 'Make the browser smaller' : 'Make the browser bigger'}
          data-on={focus ? '' : undefined}
          onClick={() => setFocus((v) => !v)}
        >
          {focus ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
      </div>
      {store.tabs.some((tab) => tab.url) && (
        <div className="side-browser-tabs" role="tablist">
          {cwd && (
            <Button
              variant="bare"
              className="side-browser-tab-new"
              aria-label="Files"
              title="Files (⌘P)"
              data-on={finding ? '' : undefined}
              onClick={() => setFinding((v) => !v)}
            >
              <FolderTree size={13} />
            </Button>
          )}
          {store.tabs.map((tab) => (
            <div
              key={tab.key}
              className="side-browser-tab"
              data-on={tab.key === store.active && !finding ? '' : undefined}
              data-split={tab.key === splitTab?.key ? '' : undefined}
              data-dirty={tab.dirty ? '' : undefined}
            >
              <Button
                variant="bare"
                role="tab"
                aria-selected={tab.key === store.active}
                className="side-browser-tab-main"
                title={tab.url}
                onClick={() => {
                  setFinding(false)
                  update((prev) => ({ ...prev, active: tab.key }))
                }}
              >
                {filePathOf(tab.url) ? (
                  <FileText size={12} className="side-browser-favicon" />
                ) : tab.favicon ? (
                  <img src={tab.favicon} alt="" className="side-browser-favicon" />
                ) : (
                  <Globe size={12} className="side-browser-favicon" />
                )}
                <span className="side-browser-tab-title">{tabLabel(tab)}</span>
              </Button>
              <Button
                variant="bare"
                className="side-browser-tab-close"
                aria-label={`Close ${tabLabel(tab)}`}
                title="Close tab (⌘W)"
                onClick={() => closeTab(tab.key)}
              >
                <X size={11} />
              </Button>
            </div>
          ))}
          <Button
            variant="bare"
            className="side-browser-tab-new"
            aria-label="New tab"
            title="New tab (⌘T)"
            onClick={() => newTab()}
          >
            <Plus size={13} />
          </Button>
        </div>
      )}
      {!activePath && !finding && (
        <div className="side-browser-bar">
          <Button
            variant="bare"
            className="side-browser-nav"
            aria-label="Back"
            title="Back (⌘[)"
            disabled={!active?.canGoBack}
            onClick={() => run('back')}
          >
            <ArrowLeft size={14} />
          </Button>
          <Button
            variant="bare"
            className="side-browser-nav side-browser-fwd"
            aria-label="Forward"
            title="Forward (⌘])"
            disabled={!active?.canGoForward}
            onClick={() => run('forward')}
          >
            <ArrowRight size={14} />
          </Button>
          <Button
            variant="bare"
            className="side-browser-nav"
            aria-label={active?.loading ? 'Stop' : 'Reload'}
            title={active?.loading ? 'Stop' : 'Reload (⌘R)'}
            disabled={!active?.viewId}
            onClick={() => run(active?.loading ? 'stop' : 'reload')}
          >
            {active?.loading ? <X size={14} /> : <RotateCw size={13} />}
          </Button>
          <form
            className="side-browser-address"
            onSubmit={(e) => {
              e.preventDefault()
              const pick = sel >= 0 ? suggestions[sel]?.url : undefined
              go(pick ?? draft ?? shownUrl)
            }}
          >
            <input
              ref={addressRef}
              value={draft ?? shownUrl}
              placeholder="Search or type a URL"
              spellCheck={false}
              autoFocus={draft === ''}
              onFocus={(e) => {
                setFocused(true)
                setSel(-1)
                setDraft(e.currentTarget.value)
                e.currentTarget.select()
              }}
              onChange={(e) => {
                setSel(-1)
                setDraft(e.currentTarget.value)
              }}
              onBlur={() => {
                setFocused(false)
                setDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.currentTarget.blur()
                else if (e.key === 'ArrowDown' && suggestions.length) {
                  e.preventDefault()
                  setSel((n) => (n + 1) % suggestions.length)
                } else if (e.key === 'ArrowUp' && suggestions.length) {
                  e.preventDefault()
                  setSel((n) => (n <= 0 ? suggestions.length - 1 : n - 1))
                }
              }}
            />
            {active?.loading && <span className="side-browser-loading" />}
            {focused && suggestions.length > 0 && (
              <ul className="side-browser-suggest" role="listbox">
                {suggestions.map((s, i) => (
                  <li key={s.url} role="option" aria-selected={i === sel}>
                    <Button
                      variant="bare"
                      className="side-browser-suggest-row"
                      data-on={i === sel ? '' : undefined}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        go(s.url)
                      }}
                      onMouseEnter={() => setSel(i)}
                    >
                      <SuggestionFavicon src={s.favicon} />
                      <span className="side-browser-suggest-title">{s.title || hostOf(s.url)}</span>
                      <span className="side-browser-suggest-url">{prettyUrl(s.url)}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </form>
          {(active?.sitePermissions?.length ?? 0) > 0 && (
            <Button
              variant="bare"
              className="side-browser-nav"
              aria-label="Site permissions"
              title="Location, camera and other permissions for this site"
              data-on={permsOpen ? '' : undefined}
              onClick={() => setPermsOpen((v) => !v)}
            >
              <ShieldCheck size={13} />
            </Button>
          )}
          {tools.map((t) => (
            <Button
              key={t.key}
              variant="bare"
              className={`side-browser-nav ${t.keep ? 'side-browser-keep' : 'side-browser-wide'}`}
              aria-label={t.label}
              title={t.label}
              data-on={t.on ? '' : undefined}
              disabled={t.disabled}
              onClick={t.run}
            >
              {t.icon}
            </Button>
          ))}
          <ModsMenu
            viewId={active?.viewId}
            here={active?.mods}
            suggestion={active?.modSuggestion}
            shared={active?.sharedMods}
            onEdit={editMod}
          />
          <MoreMenu tools={tools} />
        </div>
      )}
      {active?.viewId &&
        !activePath &&
        !importing &&
        (active.ask || (permsOpen && active.sitePermissions?.length)) && (
          <PermissionBar
            viewId={active.viewId}
            ask={active.ask}
            site={active.sitePermissions ?? []}
            onClose={() => setPermsOpen(false)}
          />
        )}
      {active?.viewId && !tasking && !activePath && !importing && brokenMod && (
        <BrokenModBar viewId={active.viewId} mod={brokenMod} onFix={editMod} />
      )}
      {active?.viewId && !tasking && !activePath && !importing && (
        <ModOffers
          viewId={active.viewId}
          link={active.modLink}
          shared={active.sharedMods}
          suggestion={active.modSuggestion}
          onTry={editMod}
        />
      )}
      {active?.viewId && active.agentDoing && !activePath && !importing && (
        <AgentBar viewId={active.viewId} doing={active.agentDoing} paused={!!active.agentPaused} />
      )}
      {active?.findOpen && active.viewId && !activePath && !importing && (
        <FindBar key={active.viewId} viewId={active.viewId} found={active.found} />
      )}
      {tasking && shownUrl.startsWith('http') && !importing && (
        <SideBrowserTask
          viewId={active?.viewId}
          onClose={() => setTasking(false)}
          tabIds={store.tabs.flatMap((t) => (t.viewId ? [t.viewId] : []))}
          suggestion={active?.modSuggestion}
          edit={modEdit}
          onShowTab={showBeside}
        />
      )}
      <div className="side-browser-body">
      {importing ? (
        <SideBrowserImport onClose={() => setImporting(false)} />
      ) : finding && cwd ? (
        <FilePicker
          root={cwd}
          current={activePath ?? undefined}
          onClose={() => setFinding(false)}
          onPick={(path) => {
            setFinding(false)
            openFile(path)
          }}
        />
      ) : !active && !places.loaded ? (
        <div className="side-browser-empty" />
      ) : !active && !hasPlaces && !cwd ? (
        <div className="side-browser-empty">
          <Globe size={22} />
          <p>Open a page next to your chat - your dev server, the docs, anything.</p>
          <Button variant="ghost" onClick={() => newTab()}>
            New tab
          </Button>
          <Button variant="ghost" onClick={() => setImporting(true)}>
            <KeyRound size={13} />
            Use my logins from Chrome
          </Button>
        </div>
      ) : !active || (emptyTab && (hasPlaces || cwd || TOOLS.length > 0)) ? (
        <div className="side-browser-top">
          {(cwd || TOOLS.length > 0) && (
            <>
              <p className="side-browser-top-label">Tools</p>
              <div className="side-browser-top-grid">
                {cwd && (
                  <Button
                    variant="bare"
                    className="side-browser-top-tile"
                    title="Find a file in this project"
                    onClick={() => setFinding(true)}
                  >
                    <FileSearch size={22} className="side-browser-top-icon" />
                    <span className="side-browser-top-name">Files</span>
                    <kbd className="side-browser-top-key">⌘P</kbd>
                  </Button>
                )}
                {TOOLS.map((tool) => (
                  <Button
                    key={tool.id}
                    variant="bare"
                    className="side-browser-top-tile"
                    title={tool.hint}
                    onClick={() =>
                      go(tool.id === 'playbooks' && cwd ? `${tool.url}?${new URLSearchParams({ project: cwd.split('/').pop() ?? '', ...(projectKind && { kind: projectKind }) })}` : tool.url)
                    }
                  >
                    {tool.id === 'playbooks' ? (
                      <ListChecks size={22} className="side-browser-top-icon" />
                    ) : (
                      <Sparkles size={22} className="side-browser-top-icon" />
                    )}
                    <span className="side-browser-top-name">{tool.label}</span>
                  </Button>
                ))}
              </div>
            </>
          )}
          {places.recent.length > 0 && (
            <>
              <p className="side-browser-top-label">Recent</p>
              <div className="side-browser-recent">
                {places.recent.map((s) => (
                  <div key={s.url} className="side-browser-place">
                    <Button
                      variant="bare"
                      className="side-browser-suggest-row side-browser-recent-row"
                      title={s.url}
                      onClick={() => go(s.url)}
                    >
                      <SuggestionFavicon src={s.favicon} />
                      <span className="side-browser-suggest-title">
                        {s.title || shortPath(s.url)}
                      </span>
                      <span className="side-browser-suggest-url">{hostOf(s.url)}</span>
                    </Button>
                    <Button
                      variant="bare"
                      className="side-browser-place-remove"
                      aria-label={`Remove ${s.title || shortPath(s.url)} from Recent`}
                      title="Remove from Recent"
                      onClick={() => places.forget('recent', s.url)}
                    >
                      <X size={11} />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
          {places.top.length > 0 && (
            <>
              <p className="side-browser-top-label">Frequently visited</p>
              <div className="side-browser-top-grid">
                {places.top.map((s) => (
                  <div key={s.url} className="side-browser-place">
                    <Button
                      variant="bare"
                      className="side-browser-top-tile"
                      title={s.url}
                      onClick={() => go(s.url)}
                    >
                      <SuggestionFavicon src={s.favicon} />
                      <span className="side-browser-top-name">{hostOf(s.url)}</span>
                    </Button>
                    <Button
                      variant="bare"
                      className="side-browser-place-remove"
                      data-corner
                      aria-label={`Remove ${hostOf(s.url)} from Frequently visited`}
                      title="Remove from Frequently visited"
                      onClick={() => places.forget('top', s.url)}
                    >
                      <X size={11} />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
          {!active && (
            <Button variant="ghost" className="side-browser-top-new" onClick={() => newTab()}>
              <Plus size={13} />
              New tab
            </Button>
          )}
        </div>
      ) : active.error && !activePath ? (
        <div className="side-browser-empty">
          <p>
            Couldn&apos;t open <strong>{hostOf(active.url)}</strong>
          </p>
          <p className="side-browser-error">{active.error}</p>
          <Button
            variant="ghost"
            onClick={() =>
              active.viewId && void window.api.sideBrowser.navigate(active.viewId, active.url)
            }
          >
            Try again
          </Button>
        </div>
      ) : (
        <div className="side-browser-panes">
          {pane(active, placeholder)}
          {splitTab && pane(splitTab, splitPlaceholder)}
        </div>
      )}
      {chatting && (
        <BrowserChat aim={chatAim} page={pageNow} onClose={closeChat} minimized={chatMin} onMinimize={setChatMin} />
      )}
      </div>
    </aside>
  )
}
