import { JSX, ReactNode, RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BarChart3, Check, ChevronDown, ChevronRight, Ellipsis, Orbit, Factory, Headset, Inbox, KeyRound, Layers, LayoutGrid, Rows3, Server, type LucideIcon } from 'lucide-react'
import { Button } from '../components/Button'
import { usePostUpdateNotice } from '../components/UpdateNudge'
import { SidebarNotices } from '../components/SidebarNotices'
import { CONFIG } from '../../../shared/config'
import type { CodeTab } from '../../../shared/types'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { TABS, type Tab } from './mighty-shared'
import appIcon from '../assets/app-icon.png'

export type SidebarMode = 'all' | 'chat' | 'code'

const CHAT_NAV: Tab[] = ['library']
const CODE_MORE: Tab[] = ['jobs', 'library']
const MORE_NAV: Tab[] = ['jobs']
const CODE_MAIN: CodeTab[] = ['needs', 'sessions', 'built']
const CODE_SETUP: CodeTab[] = ['infra', 'keys', 'reports', 'factory']
const L = CONFIG.UI_LABELS
const CODE_VIEWS: Array<{
  id: CodeTab
  label: string
  icon: LucideIcon
  admin?: boolean
  also?: CodeTab
  isNew?: boolean
}> = [
  { id: 'needs', label: L.CODE_TAB_NEEDS, icon: Inbox, also: 'previous' },
  { id: 'sessions', label: L.CODE_TAB_SESSIONS, icon: Rows3, also: 'work' },
  { id: 'factory', label: L.CODE_TAB_FACTORY, icon: Factory, admin: true },
  { id: 'keys', label: L.CODE_TAB_KEYS, icon: KeyRound, admin: true },
  { id: 'infra', label: L.CODE_TAB_INFRA, icon: Server },
  { id: 'reports', label: L.CODE_TAB_REPORTS, icon: BarChart3, isNew: true },
  { id: 'built', label: L.CODE_TAB_MADE, icon: LayoutGrid, isNew: true }
]
const NEEDS_PILL = { background: 'var(--accent-bg-subtle)', color: 'var(--accent)' }
const SEEN_VIEWS_KEY = 'mm.sidebar.seenViews'

function readSeenViews(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEEN_VIEWS_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function useDismiss(open: boolean, inside: Array<RefObject<HTMLElement | null>>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onEvent = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof MouseEvent && inside.some((r) => r.current?.contains(e.target as Node))) return
      close()
    }
    document.addEventListener('mousedown', onEvent)
    document.addEventListener('keydown', onEvent)
    return () => {
      document.removeEventListener('mousedown', onEvent)
      document.removeEventListener('keydown', onEvent)
    }
  }, [open])
}

const SETTINGS = TABS.find((t) => t.id === 'settings')!
const CODE_LABEL = TABS.find((t) => t.id === 'code')!.label

export function SidebarRow({
  icon,
  label,
  active = false,
  card = false,
  trailing,
  onClick,
  title
}: {
  icon?: ReactNode
  label: ReactNode
  active?: boolean
  card?: boolean
  trailing?: ReactNode
  onClick: () => void
  title?: string
}): JSX.Element {
  const look = card
    ? 'h-[34px] rounded-[9px] bg-[var(--surface-solid)] font-[560] text-on-surface shadow-[0_0_0_1px_rgba(var(--shadow-rgb),0.07),0_1px_2px_rgba(var(--shadow-rgb),0.06)]'
    : active
      ? 'h-[30px] rounded-[7px] bg-[rgba(var(--shadow-rgb),0.065)] font-[560] text-on-surface'
      : 'h-[30px] rounded-[7px] font-[480] text-[var(--text-muted-dark)] hover:bg-[rgba(var(--shadow-rgb),0.04)]'
  return (
    <Button
      variant="bare"
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={`sidebar-row flex w-full min-w-0 items-center gap-[9px] px-2.5 text-left text-[14px] ${look}`}
    >
      {icon && (
        <span className={`grid w-4 shrink-0 place-items-center ${active || card ? 'text-on-surface' : 'text-muted'}`}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Button>
  )
}

export function FoldChevron({ shut }: { shut: boolean }): JSX.Element {
  return shut ? (
    <ChevronRight size={12} />
  ) : (
    <ChevronDown
      size={12}
      className="opacity-0 transition-opacity group-hover:opacity-100 group-hover/head:opacity-100 group-focus-within:opacity-100 group-focus-within/head:opacity-100"
    />
  )
}

export function SidebarSection({
  label,
  actions,
  nested = false,
  collapsed = false,
  onToggle
}: {
  label: string
  actions?: ReactNode
  nested?: boolean
  collapsed?: boolean
  onToggle?: () => void
}): JSX.Element {
  return (
    <div className={`group flex ${nested ? '' : 'ml-3 mr-2.5'} items-center justify-between px-2.5 pb-[5px] pt-4 text-[11.5px] font-semibold text-muted`}>
      {onToggle ? (
        <Button
          variant="bare"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? L.SIDEBAR_EXPAND : L.SIDEBAR_COLLAPSE}
          className="flex items-center gap-1 rounded-md text-[11.5px] font-semibold hover:text-on-surface"
        >
          {label}
          <FoldChevron shut={collapsed} />
        </Button>
      ) : (
        <span>{label}</span>
      )}
      {actions && <span className="flex items-center gap-0.5">{actions}</span>}
    </div>
  )
}

export function MightySidebar({
  tab,
  mode,
  codeAvailable,
  codePending,
  codeView,
  onSelect,
  onCodeView,
  openSessions,
  onActionsSlot,
  onListSlot,
  onAll,
  onAgentsSlot
}: {
  tab: Tab
  mode: SidebarMode
  codeAvailable: boolean
  codePending: number
  codeView: CodeTab | undefined
  openSessions: number
  onSelect: (tab: Tab) => void
  onCodeView: (view: CodeTab) => void
  onActionsSlot: (el: HTMLDivElement | null) => void
  onListSlot: (el: HTMLDivElement | null) => void
  onAll: () => void
  onAgentsSlot: (el: HTMLDivElement | null) => void
}): JSX.Element {
  usePostUpdateNotice()
  const [width, setWidth] = useState<number>(CONFIG.MIGHTY.SIDEBAR.DEFAULT_WIDTH)
  const [dragging, setDragging] = useState(false)
  const isAdmin = useIsAdmin()
  const [seenViews, setSeenViews] = useState<string[]>(readSeenViews)
  const markSeen = (id: CodeTab): void => {
    if (seenViews.includes(id)) return
    const next = [...seenViews, id]
    setSeenViews(next)
    try {
      localStorage.setItem(SEEN_VIEWS_KEY, JSON.stringify(next))
    } catch {
      return
    }
  }
  const [morePos, setMorePos] = useState<{ top: number; left: number } | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  useDismiss(morePos !== null, [moreRef, moreMenuRef], () => setMorePos(null))
  const [modeOpen, setModeOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const setActionsEl = useCallback(
    (el: HTMLDivElement | null) => {
      actionsRef.current = el
      onActionsSlot(el)
    },
    [onActionsSlot]
  )
  const modeRef = useRef<HTMLDivElement>(null)
  useDismiss(modeOpen, [modeRef], () => setModeOpen(false))

  const toggleMore = (): void => {
    const r = moreRef.current?.getBoundingClientRect()
    setMorePos((cur) => (cur || !r ? null : { top: r.top, left: r.right + 6 }))
  }

  useEffect(() => {
    void window.api.mighty.getSidebarWidth().then(setWidth)
  }, [])

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    const { MIN_WIDTH, MAX_WIDTH } = CONFIG.MIGHTY.SIDEBAR
    const room = window.innerWidth - CONFIG.MIGHTY.CHAT_MIN_WIDTH - CONFIG.MIGHTY.RAIL.MIN_WIDTH
    const clamp = (x: number): number => Math.min(Math.max(x, MIN_WIDTH), MAX_WIDTH, Math.max(MIN_WIDTH, room))
    const onMove = (ev: MouseEvent): void => setWidth(clamp(ev.clientX))
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDragging(false)
      void window.api.mighty.setSidebarWidth(clamp(ev.clientX))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const resetWidth = useCallback(() => {
    const w = CONFIG.MIGHTY.SIDEBAR.DEFAULT_WIDTH
    setWidth(w)
    void window.api.mighty.setSidebarWidth(w)
  }, [])

  const modes: Array<{ id: SidebarMode; label: string; icon: LucideIcon }> = [
    ...(codeAvailable ? [{ id: 'all' as const, label: L.SIDEBAR_MODE_ALL, icon: Layers }] : []),
    ...TABS.flatMap((t) =>
      t.id === 'chat' || (codeAvailable && t.id === 'code') ? [{ id: t.id, label: t.label, icon: t.icon }] : []
    )
  ]
  const currentMode = modes.find((m) => m.id === mode) ?? modes[0]
  const pendingPill = codePending > 0 && <span className="code-tab-count" style={NEEDS_PILL}>{codePending}</span>
  const moreNav = mode === 'code' ? CODE_MORE : MORE_NAV
  const allCode = mode === 'all' ? [...CODE_MAIN, ...CODE_SETUP] : []
  const [account, setAccount] = useState<{ email: string } | null>(null)
  useEffect(() => {
    void window.api.auth.getSession().then(setAccount)
    return window.api.auth.onChange(setAccount)
  }, [])
  const userName = account?.email.split('@')[0] ?? ''

  const onCodeRow = (id: CodeTab): boolean =>
    tab === 'code' && (codeView === id || codeView === CODE_VIEWS.find((v) => v.id === id)?.also)
  const codeRow = (id: CodeTab): JSX.Element | null => {
    const view = CODE_VIEWS.find((v) => v.id === id)
    if (!view || (view.admin && !isAdmin)) return null
    const { label, icon: Icon, isNew } = view
    return (
      <SidebarRow
        key={id}
        icon={<Icon size={16} />}
        label={label}
        active={onCodeRow(id)}
        trailing={
          id === 'needs' && codePending > 0 ? (
            <span className="code-tab-count" style={NEEDS_PILL}>{codePending}</span>
          ) : id === 'sessions' && openSessions > 0 ? (
            <span className="text-xs tabular-nums text-muted">{openSessions} {L.SIDEBAR_OPEN}</span>
          ) : isNew && !seenViews.includes(id) ? (
            <span className="rounded-full bg-surface3 px-1.5 text-[10px] font-bold text-on-surface">NEW</span>
          ) : undefined
        }
        onClick={() => {
          if (isNew) markSeen(id)
          onCodeView(id)
        }}
      />
    )
  }
  const tabRow = (id: Tab): JSX.Element | null => {
    const t = TABS.find((x) => x.id === id)
    if (!t) return null
    return (
      <SidebarRow
        key={id}
        icon={<t.icon size={16} />}
        label={t.label}
        active={tab === id}
        onClick={() => onSelect(id)}
      />
    )
  }
  const bubbaRow = isAdmin && (
    <SidebarRow
      icon={<Orbit size={16} />}
      label={L.BUBBA}
      active={tab === 'bubba'}
      trailing={<span className="text-xs text-muted">⌘B</span>}
      onClick={() => onSelect('bubba')}
    />
  )
  const moreRow = (
    <div ref={moreRef}>
      <SidebarRow
        icon={<Ellipsis size={16} />}
        label={L.SIDEBAR_MORE}
        active={morePos !== null || moreNav.includes(tab) || allCode.some(onCodeRow)}
        onClick={toggleMore}
      />
    </div>
  )

  return (
    <aside
      className="mighty-chat-sidebar mighty-sidebar relative flex shrink-0 flex-col"
      style={{ width }}
    >
      <div className="flex shrink-0 flex-col gap-px pb-1 pl-3 pr-2.5 pt-3.5">
        <div className="flex items-center gap-2 pb-3.5 pl-1.5 pr-1 pt-0.5">
          <Button
            variant="bare"
            onClick={() => actionsRef.current?.querySelector('button')?.click()}
            title={mode === 'code' ? L.CODE_SIDEBAR_NEW_SESSION : L.SIDEBAR_NEW_CHAT}
            className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-[8px] py-0.5 pl-1 pr-1.5 transition-colors hover:bg-[rgba(var(--shadow-rgb),0.05)] active:bg-[rgba(var(--shadow-rgb),0.08)]"
          >
            <img
              src={appIcon}
              alt=""
              width={24}
              height={24}
              className="shrink-0 rounded-[7px] shadow-[0_0_0_1px_rgba(var(--shadow-rgb),0.08)]"
            />
            <span className="min-w-0 flex-1 truncate text-left text-[14px] font-[650] tracking-[-0.01em] text-on-surface">
              {CONFIG.BRAND_NAME}
            </span>
          </Button>
          {modes.length > 1 && (
            <div ref={modeRef} className="relative shrink-0">
              <Button
                variant="bare"
                aria-haspopup="menu"
                aria-expanded={modeOpen}
                onClick={() => setModeOpen((v) => !v)}
                className={`flex h-[26px] items-center gap-1.5 rounded-[7px] pl-2 pr-1.5 text-[12.5px] font-[560] text-on-surface shadow-[0_0_0_1px_rgba(var(--shadow-rgb),0.09)] transition-colors hover:bg-[rgba(var(--shadow-rgb),0.05)] ${
                  modeOpen ? 'bg-[rgba(var(--shadow-rgb),0.06)]' : 'bg-[var(--surface-solid)]'
                }`}
              >
                <currentMode.icon size={13} className="text-muted" />
                {currentMode.label}
                {mode !== 'code' && pendingPill}
                <ChevronDown size={12} className={`text-muted transition-transform duration-150 ${modeOpen ? 'rotate-180' : ''}`} />
              </Button>
              {modeOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-1.5 min-w-[176px] rounded-lg border border-surface3 bg-bg p-1 shadow-[var(--shadow-popover)]"
                >
                  {modes.map((m) => (
                    <Button
                      key={m.id}
                      variant="bare"
                      role="menuitemradio"
                      aria-checked={mode === m.id}
                      onClick={() => {
                        setModeOpen(false)
                        if (m.id === 'all') onAll()
                        else onSelect(m.id)
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-on-surface hover:bg-surface2 ${
                        mode === m.id ? 'font-[560]' : ''
                      }`}
                    >
                      <m.icon size={14} className="text-muted" />
                      <span className="flex-1">{m.label}</span>
                      {m.id === 'code' && pendingPill}
                      <Check size={13} className={mode === m.id ? 'text-accent-text' : 'invisible'} />
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div
          ref={setActionsEl}
          className="flex flex-col gap-px"
        />
        {mode === 'code' && (
          <>
            {CODE_MAIN.map(codeRow)}
            {bubbaRow}
            {moreRow}
            <SidebarSection nested label={L.SIDEBAR_SETUP} />
            {CODE_SETUP.map(codeRow)}
          </>
        )}
        {mode !== 'code' && CHAT_NAV.map(tabRow)}
        {mode !== 'code' && bubbaRow}
        {mode !== 'code' && moreRow}
        {morePos &&
          createPortal(
            <div
              ref={moreMenuRef}
              className={`fixed z-50 flex flex-col gap-0.5 rounded-lg border border-surface3 bg-surface1 p-1 shadow-lg ${mode === 'all' ? 'w-52' : 'w-44'}`}
              style={morePos}
              onClick={() => setMorePos(null)}
            >
              {moreNav.map(tabRow)}
              {mode === 'all' && (
                <>
                  <SidebarSection nested label={CODE_LABEL} />
                  {CODE_MAIN.map(codeRow)}
                  <SidebarSection nested label={L.SIDEBAR_SETUP} />
                  {CODE_SETUP.map(codeRow)}
                </>
              )}
            </div>,
            document.body
          )}
      </div>
      {mode === 'all' && (
        <div ref={onAgentsSlot} className="flex max-h-[45%] min-h-0 shrink-0 flex-col overflow-hidden" />
      )}
      <div ref={onListSlot} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-0 py-1" />
      <div className="mighty-sidebar-foot mb-1 ml-3 mr-2.5 mt-1.5 shrink-0 border-t border-[rgba(var(--shadow-rgb),0.07)] pt-2.5">
        <SidebarNotices />
        <Button
          variant="bare"
          onClick={() => window.api.specialistOpen()}
          className="flex h-[34px] w-full min-w-0 items-center gap-[9px] rounded-[7px] px-2.5 text-left text-[14px] text-[var(--text-muted-dark)] hover:bg-[rgba(var(--shadow-rgb),0.04)]"
        >
          <Headset size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">Ask a Specialist</span>
        </Button>
        <Button
          variant="bare"
          onClick={() => onSelect('settings')}
          title={SETTINGS.label}
          aria-current={tab === 'settings' ? 'page' : undefined}
          className={`flex h-[34px] w-full min-w-0 items-center gap-[9px] rounded-[7px] px-2.5 text-left text-[14px] text-[var(--text-muted-dark)] hover:bg-[rgba(var(--shadow-rgb),0.04)] ${
            tab === 'settings' ? 'bg-[rgba(var(--shadow-rgb),0.065)] text-on-surface' : ''
          }`}
        >
          {account ? (
            <>
              <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-surface3 text-[10px] font-[650]">
                {userName.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">{userName}</span>
              <SETTINGS.icon size={16} className="shrink-0 text-muted" />
            </>
          ) : (
            <>
              <SETTINGS.icon size={16} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{SETTINGS.label}</span>
            </>
          )}
        </Button>
      </div>
      <div
        onMouseDown={startResize}
        onDoubleClick={resetWidth}
        title="Drag to resize · double-click to reset"
        className={`absolute right-0 top-0 z-20 h-full w-1.5 translate-x-1/2 cursor-col-resize ${
          dragging ? 'bg-blue/60' : 'hover:bg-blue/40'
        }`}
      />
    </aside>
  )
}
