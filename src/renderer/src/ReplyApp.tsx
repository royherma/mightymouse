import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Ellipsis, LocateFixed, Maximize2, MessageSquare, Plus, X } from 'lucide-react'
import { CONFIG } from '../../shared/config'
import { previousList, senderMatchKey } from '../../shared/relay-cards'
import { sessionIsWorking, sessionRow } from '../../shared/relay-status'
import type { AgentRelaySessionInfo, AgentTranscriptTurn, MightyProject, MightySession, NativeMenuItem, ReplyWindowAim, ReplyWindowApp, ReplyWindowSeeing } from '../../shared/types'
import { Button } from './components/Button'
import { Tooltip, useTooltip } from './components/Tooltip'
import { Row } from './components/Layout'
import { ProjectAvatar } from './components/ProjectIcon'
import { ReplyScreenContext, SessionThread } from './components/session-thread'
import { useAgentRelay } from './hooks/useAgentRelay'
import { droppedImage } from './hooks/useAttachments'
import { CodeAgentPane } from './mighty/CodeAgentPane'
import { ConversationPane } from './mighty/ConversationPane'
import { hasRealExchange, sourceGroupOf } from './mighty/mighty-shared'

export const REPLY_AGENT_KEY = 'reply-window-agent'
const REPLY_PROJECT_KEY = 'reply-window-project'
const REPLY_BOX = '[data-reply-window] textarea'
const CHAT = 'chat:'
const MAX_CHATS = 20

export interface ReplyChats {
  sessions: MightySession[]
  projects: MightyProject[]
  name: string
  reload: () => void
  openBig: (id: string) => void
}

function stored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function store(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    return
  }
}

const refOf = (s: AgentRelaySessionInfo): string => s.sessionId ?? s.label
const nameOf = (s: AgentRelaySessionInfo, now: number): string => s.tldr || sessionRow(s, now).name || 'Unnamed agent'
const projectOf = (s: AgentRelaySessionInfo): string => s.project?.name ?? s.label.split('/')[0]

function ProjectPicture({ project, size }: { project: AgentRelaySessionInfo['project']; size: number }): React.JSX.Element {
  if (!project?.imageBase64) return <ProjectAvatar icon={project?.icon} size={size} />
  return (
    <img
      src={`data:image/png;base64,${project.imageBase64}`}
      alt=""
      aria-hidden
      className="shrink-0 rounded object-cover"
      style={{ width: size, height: size }}
    />
  )
}

type TranscriptState = { ref: string; status: 'loading' | 'failed' | 'ready'; turns: AgentTranscriptTurn[] }

const seenTranscripts = new Map<string, AgentTranscriptTurn[]>()
const MAX_SEEN_TRANSCRIPTS = 12

function sameTurns(a: AgentTranscriptTurn[], b: AgentTranscriptTurn[]): boolean {
  if (a.length !== b.length) return false
  const last = a.length - 1
  return last < 0 || (a[last].at === b[last].at && a[last].text === b[last].text && a[last].role === b[last].role)
}

function remember(ref: string, turns: AgentTranscriptTurn[]): void {
  seenTranscripts.delete(ref)
  seenTranscripts.set(ref, turns)
  if (seenTranscripts.size > MAX_SEEN_TRANSCRIPTS) seenTranscripts.delete(seenTranscripts.keys().next().value as string)
}

function fromSeen(ref: string): TranscriptState {
  const turns = seenTranscripts.get(ref)
  return turns ? { ref, status: 'ready', turns } : { ref, status: 'loading', turns: [] }
}

function useTranscript(ref: string, working: boolean): Omit<TranscriptState, 'ref'> {
  const [state, setState] = useState<TranscriptState>(() => fromSeen(ref))
  useEffect(() => {
    if (!ref) return
    let live = true
    let inFlight = false
    const load = (): void => {
      if (inFlight || document.hidden) return
      inFlight = true
      void window.api.agentRelaySessionTranscript(ref).then(
        (turns) => {
          inFlight = false
          if (!live) return
          remember(ref, turns)
          setState((prev) => (prev.ref === ref && prev.status === 'ready' && sameTurns(prev.turns, turns) ? prev : { ref, status: 'ready', turns }))
        },
        () => {
          inFlight = false
          if (live) setState((prev) => (prev.ref === ref && prev.status === 'ready' ? prev : { ref, status: 'failed', turns: [] }))
        }
      )
    }
    setState((prev) => (prev.ref === ref ? prev : fromSeen(ref)))
    load()
    const poll = setInterval(load, working ? CONFIG.AGENT_RELAY.THREAD_POLL_BUSY_MS : CONFIG.AGENT_RELAY.THREAD_POLL_MS)
    document.addEventListener('visibilitychange', load)
    return () => {
      live = false
      clearInterval(poll)
      document.removeEventListener('visibilitychange', load)
    }
  }, [ref, working])
  return state.ref === ref ? state : fromSeen(ref)
}

const MENU_ROW = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface2'
const MENU_BOX =
  'absolute top-full z-50 mt-1 rounded-lg border border-surface3 bg-[var(--window-bg)] p-1 shadow-[var(--shadow-popover)]'
const MAX_NUMBERED = 9
const MENU_FITS_HEIGHT = 440
const AUTO_ON_TIP = 'Auto-switch is on: when you change browser tabs, this jumps to the agent working on that page. Click to turn it off.'
const AUTO_OFF_TIP = 'Auto-switch is off: this stays on the agent you picked. Click to have it jump to the agent behind each browser tab.'
const NATIVE_AGENTS = 8
const NATIVE_CHATS = 3
const TICK_BUSY_MS = 1_000
const TICK_IDLE_MS = 15_000
const MAX_RECENT = 50
const REPLY_RECENT_KEY = 'reply-window-recent'
const REPLY_SORT_KEY = 'reply-window-sort'

function storedRecent(): string[] {
  try {
    const list: unknown = JSON.parse(stored(REPLY_RECENT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((r): r is string => typeof r === 'string') : []
  } catch {
    return []
  }
}

export type ReplyAim = string | { cwd: string }

let seenHomeCwd = ''

export default function ReplyApp({
  chat,
  onHide,
  onOpenBig,
  aim,
  focusOrder,
  seeing,
  embedded = false,
  minimized = false,
  onMinimize
}: {
  chat?: ReplyChats
  onHide: () => void
  onOpenBig?: (ref: string) => void
  aim?: ReplyAim
  focusOrder?: string[]
  seeing?: ReplyWindowSeeing
  embedded?: boolean
  minimized?: boolean
  onMinimize?: (minimized: boolean) => void
}): React.JSX.Element {
  const relay = useAgentRelay()
  const rootRef = useRef<HTMLDivElement>(null)
  const replyBox = (): HTMLTextAreaElement | null =>
    (rootRef.current ?? document).querySelector<HTMLTextAreaElement>(REPLY_BOX)
  const ownsFocus = (): boolean =>
    !embedded || document.activeElement === document.body || Boolean(rootRef.current?.contains(document.activeElement))
  const sessions = useMemo(
    () => [...(relay.status.agentSessions ?? [])].sort((a, b) => Number(Boolean(a.stale)) - Number(Boolean(b.stale))),
    [relay.status.agentSessions]
  )
  const [picked, setPickedState] = useState<string | undefined>(() => stored(REPLY_AGENT_KEY))
  const setPicked = (ref: string | undefined): void => {
    store(REPLY_AGENT_KEY, ref)
    setPickedState(ref)
  }
  const [draft, setDraft] = useState<'chat' | { cwd: string } | null>(null)
  const [opened, setOpened] = useState<{ ref: string; text: string; files: string[] } | null>(null)
  const [paneKey, setPaneKey] = useState(0)
  const [project, setProjectState] = useState<string | undefined>(() => stored(REPLY_PROJECT_KEY))
  const setProject = (name: string | undefined): void => {
    store(REPLY_PROJECT_KEY, name)
    setProjectState(name)
  }
  const projects = useMemo(() => {
    const byName = new Map<string, { name: string; picture: AgentRelaySessionInfo['project']; count: number }>()
    for (const s of sessions) {
      const name = projectOf(s)
      const seen = byName.get(name)
      if (seen) seen.count += 1
      else byName.set(name, { name, picture: s.project, count: 1 })
    }
    return [...byName.values()]
  }, [sessions])
  const [recent, setRecent] = useState(storedRecent)
  const [sort, setSortState] = useState<'recent' | 'active'>(() => (stored(REPLY_SORT_KEY) === 'active' ? 'active' : 'recent'))
  const rank = useMemo(
    () => new Map(sort === 'recent' ? [...new Set([...(focusOrder ?? []), ...recent])].map((r, i) => [r, i]) : []),
    [focusOrder, recent, sort]
  )
  const rankOf = (r: string): number => rank.get(r) ?? MAX_RECENT
  const inProject = useMemo(() => {
    const own = project ? sessions.filter((s) => projectOf(s) === project) : []
    return [...(own.length > 0 ? own : sessions)].sort((a, b) => rankOf(refOf(a)) - rankOf(refOf(b)))
  }, [sessions, project, rank])
  const chatId = chat && !draft && picked?.startsWith(CHAT) ? picked.slice(CHAT.length) : undefined
  const chatting = chat !== undefined && (draft === 'chat' || chatId !== undefined)
  const openChat = chat?.sessions.find((c) => c.id === chatId)
  const chatProject = (c: MightySession): string | undefined => chat?.projects.find((p) => p.id === c.projectId)?.name
  const aimGone =
    relay.known && !draft && !chatting && typeof aim === 'string' && picked === aim && !sessions.some((s) => refOf(s) === aim)
  const session = draft || chatting || aimGone ? undefined : (sessions.find((s) => refOf(s) === picked) ?? inProject[0])
  const [homeCwd, setHomeCwd] = useState(seenHomeCwd)
  useEffect(() => {
    if (seenHomeCwd) return
    void window.api.codeNoProjectFolder().then((cwd) => {
      seenHomeCwd = cwd ?? ''
      setHomeCwd(seenHomeCwd)
    })
  }, [])
  const agentFolder =
    chat?.projects.find((p) => p.name === project)?.repoFolder ??
    (sessions.find((s) => refOf(s) === picked) ?? inProject[0])?.cwd ??
    chat?.projects.find((p) => p.repoFolder)?.repoFolder ??
    (homeCwd || undefined)
  const folderName = (cwd: string): string =>
    cwd === homeCwd ? CONFIG.UI_LABELS.CODE_NO_PROJECT : (cwd.split('/').pop() ?? cwd)

  const [menu, setMenu] = useState<'agents' | 'projects' | 'more' | null>(null)
  const [query, setQuery] = useState('')
  const closeMenu = (): void => {
    setMenu(null)
    setQuery('')
  }
  const open = (ref: string): void => {
    setPicked(ref)
    const next = [ref, ...recent.filter((r) => r !== ref)].slice(0, MAX_RECENT)
    setRecent(next)
    store(REPLY_RECENT_KEY, JSON.stringify(next))
  }
  const show = (ref: string | undefined, starting: typeof draft = null): void => {
    if (ref) open(ref)
    setDraft(starting)
    setPaneKey((k) => k + 1)
    closeMenu()
  }
  const switchTo = (ref: string): void => show(ref)
  const aimKey = typeof aim === 'string' ? aim : aim ? `cwd:${aim.cwd}` : ''
  const followedAim = useRef<string | null>(null)
  const leftAim = useRef(false)
  useEffect(() => {
    const here = draft === 'chat' ? '' : draft ? `cwd:${draft.cwd}` : (picked ?? '')
    if (followedAim.current !== null && here !== followedAim.current) leftAim.current = true
    followedAim.current = aimKey
    if (leftAim.current || !aim) return
    if (typeof aim === 'string') show(aim)
    else show(undefined, { cwd: aim.cwd })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aimKey])
  const chooseProject = (name: string | undefined): void => {
    setProject(name)
    const first = sessions.find((s) => projectOf(s) === name)
    if (first && session && projectOf(session) !== name) show(refOf(first))
    else closeMenu()
  }
  const [now, setNow] = useState(() => Date.now())
  const anyWorking = sessions.some((s) => s.busySince !== undefined)
  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, anyWorking ? TICK_BUSY_MS : TICK_IDLE_MS)
    return () => clearInterval(tick)
  }, [anyWorking])

  const ref = session ? refOf(session) : ''
  const openBig = (): void => {
    if (ref) onOpenBig?.(ref)
    else if (chatId) chat?.openBig(chatId)
    closeMenu()
  }
  const minimize = (): void => {
    closeMenu()
    onMinimize?.(true)
  }
  const popOut = (): void => {
    const target = ref || (chatId ? `${CHAT}${chatId}` : '')
    if (!target) return
    store(REPLY_AGENT_KEY, target)
    window.api.replyWindowShow(target)
    closeMenu()
    onHide()
  }
  const openTerminal = (): void => {
    if (ref) void window.api.agentRelayRevealSession(ref)
    closeMenu()
  }
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    return inProject
      .map((s, i) => ({ s, number: i < MAX_NUMBERED ? i + 1 : undefined }))
      .filter(({ s }) => !q || `${nameOf(s, now)} ${projectOf(s)}`.toLowerCase().includes(q))
  }, [inProject, query, menu])
  const foundChats = useMemo(() => {
    const q = query.trim().toLowerCase()
    const own = (chat?.sessions ?? [])
      .filter((c) => !project || !c.projectId || chatProject(c) === project)
      .sort((a, b) => rankOf(`${CHAT}${a.id}`) - rankOf(`${CHAT}${b.id}`))
    return q ? own.filter((c) => `${c.title} ${chatProject(c) ?? ''}`.toLowerCase().includes(q)) : own.slice(0, MAX_CHATS)
  }, [chat, project, query, rank])
  const firstFound = found[0] ? refOf(found[0].s) : foundChats[0] ? `${CHAT}${foundChats[0].id}` : undefined

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (embedded && !rootRef.current?.contains(document.activeElement)) return
      const letter = e.key.toLowerCase()
      const numbered = e.metaKey && /^[1-9]$/.test(e.key) ? inProject[Number(e.key) - 1] : undefined
      const toggleAgents = (): void => (menu === 'agents' ? closeMenu() : setMenu('agents'))
      const run = numbered
        ? refOf(numbered) === ref
          ? toggleAgents
          : () => switchTo(refOf(numbered))
        : e.metaKey && letter === 'k'
          ? toggleAgents
          : e.metaKey && letter === 'o'
            ? openBig
            : e.key === 'Escape' && !e.defaultPrevented
              ? menu
                ? closeMenu
                : onHide
              : undefined
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onHide, menu, inProject, ref, chatId, embedded])

  const working = session ? sessionIsWorking(session, now) : false
  const transcript = useTranscript(ref, working)
  const key = session ? senderMatchKey(session.stated ?? session.label) : ''
  const history = useMemo(
    () =>
      [...relay.pending, ...previousList(relay.resolved, relay.dismissed ?? [])]
        .filter((r) => senderMatchKey(r.params.from) === key)
        .sort((a, b) => b.createdAt - a.createdAt),
    [relay.pending, relay.resolved, relay.dismissed, key]
  )
  const row = session ? sessionRow(session, now) : undefined
  useEffect(() => {
    if (document.hasFocus() && menu === null && ownsFocus()) replyBox()?.focus()
  }, [ref, transcript.status, menu, paneKey])

  const dropText = (e: React.DragEvent): void => {
    e.preventDefault()
    const data = e.dataTransfer
    if (Array.from(data.files).some((f) => window.api.pathForFile(f)) || droppedImage(data)) return
    const link = data.getData('text/uri-list').split('\n').find((line) => line.trim() && !line.startsWith('#'))
    const text = (link ?? data.getData('text/plain')).trim()
    const box = replyBox()
    if (!text || !box) return
    box.focus()
    document.execCommand('insertText', false, `${text} `)
  }

  const { tip, hoverProps } = useTooltip()
  const [autoSwitch, setAutoSwitch] = useState<boolean | null>(null)
  useEffect(() => {
    if (!embedded) void window.api.replyWindowAuto().then(setAutoSwitch)
  }, [embedded])
  const [behind, setBehind] = useState<ReplyWindowApp | null>(null)
  useEffect(() => {
    if (menu !== 'more' || embedded) return
    void window.api.replyWindowApp().then(setBehind)
  }, [menu, embedded])
  const toggleShowOver = (app: ReplyWindowApp | null): void => {
    if (app) window.api.replyWindowShowOver(app.bundleId, !app.shows)
    closeMenu()
  }
  const moreFor = (app: ReplyWindowApp | null): { label: string; keys: string; run: () => void; show: boolean }[] => [
    { label: 'Minimize', keys: '', run: minimize, show: Boolean(onMinimize) },
    { label: 'Pop out', keys: '', run: popOut, show: embedded && Boolean(ref || chatId) },
    { label: 'Open in the main window', keys: '⌘O', run: openBig, show: Boolean(ref ? onOpenBig : chatId) },
    { label: 'Open terminal', keys: '', run: openTerminal, show: Boolean(ref) && row?.health !== 'ended' },
    {
      label: app?.shows ? `Hide when I'm in ${app.name}` : `Show when I'm in ${app?.name ?? ''}`,
      keys: '',
      run: () => toggleShowOver(app),
      show: Boolean(app)
    },
    { label: embedded ? 'Close' : 'Hide', keys: embedded ? '' : '⌘W', run: onHide, show: true }
  ]
  const more = moreFor(behind)
  const sorts: { id: typeof sort; label: string }[] = [
    { id: 'recent', label: 'Last focused' },
    { id: 'active', label: 'Active first' }
  ]
  const nativeMenu = async (kind: 'agents' | 'projects' | 'more'): Promise<void> => {
    const picks = new Map<string, () => void>()
    const item = (id: string, label: string, run: () => void, extra: Partial<Extract<NativeMenuItem, { id: string }>> = {}): NativeMenuItem => {
      picks.set(id, run)
      return { id, label, ...extra }
    }
    const line: NativeMenuItem = { type: 'separator' }
    let items: NativeMenuItem[] = []
    if (kind === 'agents') {
      items = [
        ...found.filter(({ s }) => !s.stale).slice(0, NATIVE_AGENTS).map(({ s }) =>
          item(`a:${refOf(s)}`, nameOf(s, now), () => switchTo(refOf(s)), {
            sublabel: `${projectOf(s)} · ${sessionRow(s, now).state_text}`,
            checked: refOf(s) === ref
          })
        ),
        ...foundChats.slice(0, NATIVE_CHATS).map((c) =>
          item(`c:${c.id}`, c.title || 'New chat', () => switchTo(`${CHAT}${c.id}`), { sublabel: 'Chat', checked: c.id === chatId })
        ),
        line,
        item('all', 'All agents…', () => {
          window.api.replyWindowExpand()
          setMenu('agents')
        }),
        ...(chat
          ? [
              item('new-chat', 'New chat', () => show(undefined, 'chat')),
              item('new-agent', `New agent${agentFolder && agentFolder !== homeCwd ? ` in ${folderName(agentFolder)}` : ''}`, () => agentFolder && show(undefined, { cwd: agentFolder }), { enabled: Boolean(agentFolder) })
            ]
          : [])
      ]
    } else if (kind === 'projects') {
      items = [
        item('p:', `All projects (${sessions.length})`, () => chooseProject(undefined), { checked: !project }),
        ...projects.map((p) => item(`p:${p.name}`, `${p.name} (${p.count})`, () => chooseProject(p.name), { checked: project === p.name }))
      ]
    } else {
      const app = await window.api.replyWindowApp()
      items = [
        ...moreFor(app).filter((m) => m.show).map((m, i) => item(`m:${i}`, m.label, m.run)),
        line,
        { id: 'sort-title', label: 'Sort the list by', enabled: false },
        ...sorts.map((o) => item(`s:${o.id}`, o.label, () => chooseSort(o.id), { checked: sort === o.id }))
      ]
    }
    const picked = await window.api.nativeMenu(items)
    if (picked) picks.get(picked)?.()
  }
  const openMenu = (kind: 'agents' | 'projects' | 'more'): void => {
    if (menu === kind) return closeMenu()
    if (embedded || window.innerHeight >= MENU_FITS_HEIGHT) return setMenu(kind)
    closeMenu()
    void nativeMenu(kind)
  }
  const chooseSort = (id: typeof sort): void => {
    store(REPLY_SORT_KEY, id)
    setSortState(id)
    closeMenu()
  }

  return (
    <div
      ref={rootRef}
      className={`code-detail session-detail ${embedded ? 'h-full min-h-0' : 'h-screen'} bg-surface1 text-fg`}
      data-reply-window
      data-floating={embedded ? undefined : ''}
      onDragOver={(e) => e.preventDefault()}
      onDrop={dropText}
    >
      {menu && <div className="fixed inset-0 z-40" onClick={closeMenu} />}
      <Tooltip tip={tip} />
      <Row className={`relative shrink-0 px-3 py-2 border-b border-surface2 ${embedded ? '' : '[-webkit-app-region:drag]'}`}>
        <Button
          variant="bare"
          disabled={projects.length < 2}
          onClick={() => openMenu('projects')}
          aria-haspopup="menu"
          aria-expanded={menu === 'projects'}
          title="Choose a project"
          aria-label="Choose a project"
          className="shrink-0 rounded-md p-1 hover:bg-surface2 [-webkit-app-region:no-drag]"
        >
          <ProjectPicture project={session?.project} size={18} />
        </Button>
        <div className="flex-1 min-w-0 [-webkit-app-region:no-drag]">
          <Button
            variant="bare"
            disabled={sessions.length === 0 && !chat}
            onClick={() => (minimized ? onMinimize?.(false) : openMenu('agents'))}
            aria-haspopup="menu"
            aria-expanded={menu === 'agents'}
            aria-label="Which agent gets this"
            className="flex w-full min-w-0 flex-col rounded-md px-1.5 py-0.5 text-left hover:bg-surface2"
          >
            <span className="flex w-full min-w-0 items-center gap-1 text-sm font-medium text-fg">
              <span className="truncate">
                {session
                  ? nameOf(session, now)
                  : chatting
                    ? openChat?.title || 'New chat'
                    : draft
                      ? 'New agent'
                      : !relay.known
                        ? 'Loading…'
                        : aimGone
                          ? CONFIG.UI_LABELS.CODE_AGENT_PANE_GONE
                          : 'No agents running'}
              </span>
              {(sessions.length > 1 || chat) && <ChevronDown size={13} className="shrink-0 text-muted" />}
            </span>
            {chatting && (
              <span className="w-full truncate text-xs text-muted">
                {[openChat && chatProject(openChat), 'Chat'].filter(Boolean).join(' · ')}
              </span>
            )}
            {draft && draft !== 'chat' && (
              <span className="w-full truncate text-xs text-muted">{folderName(draft.cwd)}</span>
            )}
            {session && row && (
              <span className="w-full truncate text-xs text-muted" data-health={row.health}>
                {projectOf(session)} · {row.state_text}
              </span>
            )}
          </Button>
        </div>
        {minimized && onMinimize && (
          <Button
            variant="icon"
            onClick={() => onMinimize(false)}
            title="Open the chat"
            aria-label="Open the chat"
          >
            <Maximize2 size={14} strokeWidth={2} />
          </Button>
        )}
        {!embedded && !minimized && autoSwitch !== null && (
          <Button
            variant="icon"
            className={`[-webkit-app-region:no-drag] ${autoSwitch ? '!border-accent !bg-accent-wash !text-accent-text' : ''}`}
            onClick={() => void window.api.replyWindowAuto(!autoSwitch).then(setAutoSwitch)}
            aria-pressed={autoSwitch}
            aria-label="Auto-switch agent"
            {...hoverProps(autoSwitch ? AUTO_ON_TIP : AUTO_OFF_TIP)}
          >
            <LocateFixed size={14} strokeWidth={2} />
          </Button>
        )}
        {(session || chatting || draft) && !minimized && (
          <Button
            variant="icon"
            className="[-webkit-app-region:no-drag]"
            onClick={() => openMenu('more')}
            aria-haspopup="menu"
            aria-expanded={menu === 'more'}
            title="More"
            aria-label="More"
          >
            <Ellipsis size={15} strokeWidth={2} />
          </Button>
        )}
        <Button
          variant="icon"
          className="[-webkit-app-region:no-drag]"
          onClick={onHide}
          title={CONFIG.UI_LABELS.REPLY_CLOSE}
          aria-label={CONFIG.UI_LABELS.REPLY_CLOSE}
        >
          <X size={15} strokeWidth={2} />
        </Button>
        {menu === 'agents' && (
          <div role="menu" className={`${MENU_BOX} left-3 right-3 [-webkit-app-region:no-drag]`}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && firstFound) switchTo(firstFound)
              }}
              placeholder="Find an agent"
              aria-label="Find an agent"
              className="mb-1 w-full rounded-md bg-surface2 px-2 py-1.5 text-[13px] text-fg outline-none placeholder:text-muted"
            />
            <div className="max-h-[320px] overflow-y-auto">
              {found.map(({ s, number }) => (
                <Button
                  key={refOf(s)}
                  variant="bare"
                  role="menuitemradio"
                  aria-checked={refOf(s) === ref}
                  onClick={() => switchTo(refOf(s))}
                  className={MENU_ROW}
                >
                  <ProjectPicture project={s.project} size={16} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] text-on-surface">{nameOf(s, now)}</span>
                    <span className="truncate text-[11px] text-muted">
                      {projectOf(s)} · {sessionRow(s, now).state_text}
                    </span>
                  </span>
                  {refOf(s) === ref && <Check size={13} className="shrink-0 text-accent-text" />}
                  {number !== undefined && <span className="shrink-0 text-[11px] text-muted">⌘{number}</span>}
                </Button>
              ))}
              {foundChats.map((c) => (
                <Button
                  key={c.id}
                  variant="bare"
                  role="menuitemradio"
                  aria-checked={c.id === chatId}
                  onClick={() => switchTo(`${CHAT}${c.id}`)}
                  className={MENU_ROW}
                >
                  <MessageSquare size={14} className="mx-px shrink-0 text-muted" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] text-on-surface">{c.title || 'New chat'}</span>
                    <span className="truncate text-[11px] text-muted">
                      {[chatProject(c), 'Chat'].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {c.id === chatId && <Check size={13} className="shrink-0 text-accent-text" />}
                </Button>
              ))}
              {found.length + foundChats.length === 0 && (
                <p className="px-2 py-3 text-center text-xs text-muted">Nothing matches “{query}”</p>
              )}
            </div>
            {chat && (
              <div className="mt-1 flex gap-1 border-t border-surface2 pt-1">
                <Button variant="bare" role="menuitem" onClick={() => show(undefined, 'chat')} className={MENU_ROW}>
                  <Plus size={14} className="shrink-0 text-muted" />
                  <span className="text-[13px] text-on-surface">New chat</span>
                </Button>
                <Button
                  variant="bare"
                  role="menuitem"
                  disabled={!agentFolder}
                  onClick={() => agentFolder && show(undefined, { cwd: agentFolder })}
                  className={MENU_ROW}
                >
                  <Plus size={14} className="shrink-0 text-muted" />
                  <span className="truncate text-[13px] text-on-surface">
                    New agent{agentFolder && agentFolder !== homeCwd ? ` in ${folderName(agentFolder)}` : ''}
                  </span>
                </Button>
              </div>
            )}
          </div>
        )}
        {menu === 'projects' && (
          <div role="menu" className={`${MENU_BOX} left-3 w-60 [-webkit-app-region:no-drag]`}>
            <Button
              variant="bare"
              role="menuitemradio"
              aria-checked={!project}
              onClick={() => chooseProject(undefined)}
              className={MENU_ROW}
            >
              <span className="flex-1 truncate text-[13px] text-on-surface">All projects</span>
              {!project && <Check size={13} className="shrink-0 text-accent-text" />}
              <span className="shrink-0 text-[11px] text-muted">{sessions.length}</span>
            </Button>
            {projects.map((p) => (
              <Button
                key={p.name}
                variant="bare"
                role="menuitemradio"
                aria-checked={project === p.name}
                onClick={() => chooseProject(p.name)}
                className={MENU_ROW}
              >
                <ProjectPicture project={p.picture} size={16} />
                <span className="flex-1 truncate text-[13px] text-on-surface">{p.name}</span>
                {project === p.name && <Check size={13} className="shrink-0 text-accent-text" />}
                <span className="shrink-0 text-[11px] text-muted">{p.count}</span>
              </Button>
            ))}
          </div>
        )}
        {menu === 'more' && (
          <div role="menu" className={`${MENU_BOX} right-3 w-56 [-webkit-app-region:no-drag]`}>
            {more
              .filter((item) => item.show)
              .map((item) => (
                <Button key={item.label} variant="bare" role="menuitem" onClick={item.run} className={MENU_ROW}>
                  <span className="flex-1 truncate text-[13px] text-on-surface">{item.label}</span>
                  <span className="shrink-0 text-[11px] text-muted">{item.keys}</span>
                </Button>
              ))}
            <p className="mt-1 border-t border-surface2 px-2 pb-0.5 pt-2 text-[11px] text-muted">Sort the list by</p>
            {sorts.map((option) => (
              <Button
                key={option.id}
                variant="bare"
                role="menuitemradio"
                aria-checked={sort === option.id}
                onClick={() => chooseSort(option.id)}
                className={MENU_ROW}
              >
                <span className="flex-1 truncate text-[13px] text-on-surface">{option.label}</span>
                {sort === option.id && <Check size={13} className="shrink-0 text-accent-text" />}
              </Button>
            ))}
          </div>
        )}
      </Row>
      {!embedded && !minimized && autoSwitch && seeing && (!seeing.ref || seeing.ref === ref) && (
        <p className="flex shrink-0 items-center gap-1.5 truncate border-b border-surface2 px-4 py-1 text-[11px] text-muted">
          <LocateFixed size={11} className="shrink-0 text-accent-text" />
          {seeing.ref ? (
            <span className="truncate">
              Opened from{' '}
              <Button variant="bare" className="underline-offset-2 hover:underline" onClick={() => void window.api.openExternal(seeing.url)}>
                {seeing.page}
              </Button>
            </span>
          ) : (
            <span className="truncate">No agent for this tab</span>
          )}
        </p>
      )}
      {minimized ? null : session ? (
        <div className="code-detail-scroll px-3 py-2">
          <SessionThread
            key={ref}
            session={session}
            sessionRef={ref}
            history={history}
            ended={row?.health === 'ended'}
            now={now}
            spoken={transcript.turns}
            transcriptStatus={transcript.status}
            working={working}
            showSteps={false}
            opening={opened?.ref === ref ? opened : undefined}
            onRespond={relay.respond}
          />
        </div>
      ) : chat && chatting ? (
        <div className="flex-1 min-h-0">
          <ConversationPane
            key={paneKey}
            paneId="reply"
            sessionId={chatId ?? null}
            name={chat.name}
            projects={chat.projects}
            onSessionCreated={(id) => {
              open(`${CHAT}${id}`)
              setDraft(null)
              chat.reload()
            }}
            onSessionMissing={() => setPicked(undefined)}
            onSessionsChanged={chat.reload}
          />
        </div>
      ) : draft && draft !== 'chat' ? (
        <div className="flex-1 min-h-0">
          <CodeAgentPane
            key={paneKey}
            cwd={draft.cwd}
            relay={relay}
            projects={chat?.projects ?? []}
            slotColor={null}
            bare
            onStart={(opening) => setOpened({ ref: '', ...opening })}
            onAgent={(label) => {
              if (!label) return
              setOpened((prev) => (prev && !prev.ref ? { ...prev, ref: label } : prev))
              show(label)
            }}
            onClose={() => setDraft(null)}
            onProjectChange={(id) => {
              const cwd = id ? chat?.projects.find((p) => p.id === id)?.repoFolder : homeCwd
              if (cwd) show(undefined, { cwd })
            }}
          />
        </div>
      ) : aimGone ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
          <p>{CONFIG.UI_LABELS.CODE_AGENT_PANE_GONE}</p>
          {agentFolder && (
            <Button variant="ghost" onClick={() => show(undefined, { cwd: agentFolder })}>
              {CONFIG.UI_LABELS.CODE_AGENT_PANE_NEW}
            </Button>
          )}
        </div>
      ) : (
        <p className="flex-1 flex items-center justify-center px-6 text-center text-sm text-muted">
          {relay.known ? CONFIG.UI_LABELS.REPLY_EMPTY : 'Loading…'}
        </p>
      )}
    </div>
  )
}

const seenChats: { sessions: MightySession[]; projects: MightyProject[]; name: string } = {
  sessions: [],
  projects: [],
  name: CONFIG.MIGHTY.NAME
}
const CHATS_RELOAD_MS = 300
const chatsKey = (list: MightySession[]): string => list.map((c) => `${c.id}:${c.updated}:${c.title}`).join('|')

export function useReplyChats(openBig: (id: string) => void, refocus = false): ReplyChats {
  const [sessions, setSessions] = useState<MightySession[]>(seenChats.sessions)
  const [projects, setProjects] = useState<MightyProject[]>(seenChats.projects)
  const [name, setName] = useState<string>(seenChats.name)
  const reload = useCallback(() => {
    void Promise.all([window.api.mighty.listSessions(), window.api.settingsGetPrefs()]).then(([all, prefs]) => {
      const hidden = prefs.mightySourceFilterHidden ?? []
      const next = all.filter((c) => !c.archived && hasRealExchange(c) && !hidden.includes(sourceGroupOf(c)))
      if (chatsKey(next) === chatsKey(seenChats.sessions)) return setSessions(seenChats.sessions)
      seenChats.sessions = next
      setSessions(next)
    })
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = (): void => {
      clearTimeout(timer)
      timer = setTimeout(reload, CHATS_RELOAD_MS)
    }
    const loadProjects = (): void =>
      void window.api.mighty.listProjects().then((list) => {
        if (JSON.stringify(list) === JSON.stringify(seenChats.projects)) return setProjects(seenChats.projects)
        seenChats.projects = list
        setProjects(list)
      })
    reload()
    loadProjects()
    void window.api.mighty.getSettings().then((settings) => {
      seenChats.name = settings.name || CONFIG.MIGHTY.NAME
      setName(seenChats.name)
    })
    const offTurn = window.api.mighty.onTurnAppended(soon)
    const offProjects = window.api.mighty.onProjectsChanged(() => loadProjects())
    const focusBox = (): void => document.querySelector<HTMLTextAreaElement>(REPLY_BOX)?.focus()
    if (refocus) window.addEventListener('focus', focusBox)
    return () => {
      clearTimeout(timer)
      offTurn()
      offProjects()
      window.removeEventListener('focus', focusBox)
    }
  }, [reload, refocus])
  return useMemo(() => ({ sessions, projects, name, reload, openBig }), [sessions, projects, name, reload, openBig])
}

const openBigAndHide = (id: string): void => {
  void window.api.mighty.open(false, id)
  window.api.replyWindowHide()
}

export function ReplyWindowApp(): React.JSX.Element {
  const chat = useReplyChats(openBigAndHide, true)
  const [aimed, setAimed] = useState<(ReplyWindowAim & { n: number }) | null>(null)
  const [shot, setShot] = useState<{ path?: string; on: boolean }>({ on: true })
  const [seeing, setSeeing] = useState<ReplyWindowSeeing>()
  useEffect(() => window.api.onReplyWindowSeeing(setSeeing), [])
  useEffect(() => window.api.onReplyWindowAim((aim) => setAimed((prev) => ({ ...aim, n: (prev?.n ?? 0) + 1 }))), [])
  useEffect(() => window.api.onReplyWindowScreen((path) => setShot({ path, on: true })), [])
  const screen = useMemo(() => ({ ...shot, setOn: (on: boolean) => setShot((prev) => ({ ...prev, on })) }), [shot])
  return (
    <ReplyScreenContext.Provider value={screen}>
      <ReplyApp
        key={aimed?.n}
        aim={aimed?.ref}
        focusOrder={aimed?.order}
        seeing={seeing}
        chat={chat}
        onHide={() => window.api.replyWindowHide()}
        onOpenBig={(ref) => window.api.replyWindowOpenBig(ref)}
      />
    </ReplyScreenContext.Provider>
  )
}
