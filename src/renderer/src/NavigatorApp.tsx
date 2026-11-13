import { JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Bot,
  Bug,
  Camera,
  Clock,
  Code,
  Command,
  Folder,
  CreditCard,
  GraduationCap,
  Images,
  Keyboard,
  Layers,
  Lightbulb,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  OctagonX,
  Pencil,
  Plug,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Type,
  Zap
} from 'lucide-react'
import { Kbd } from './components/Kbd'
import { ProjectAvatar } from './components/ProjectIcon'
import { useIsAdmin } from './hooks/useIsAdmin'
import { readLastTab } from './mighty/mighty-shared'
import { CONFIG } from '../../shared/config'
import { sessionRow } from '../../shared/relay-status'
import { mightyProjectForCwd } from '../../shared/relay-sessions'
import type { AgentRelaySessionInfo, MightyProject } from '../../shared/types'
import {
  SCREEN_TARGETS,
  matchesTarget,
  shortcutTargets,
  type NavigatorCategory,
  type NavigatorContentHit,
  type NavigatorSearchRef,
  type NavigatorTarget
} from '../../shared/navigator-targets'
import { Button } from './components/Button'
import { SnippetLine } from './mighty/MightySessionNavigation'
import { fuzzyMatch, type Snippet } from '../../shared/fuzzy'

const ICONS: Record<string, typeof Command> = {
  BarChart3,
  Bot,
  Bug,
  Camera,
  Clock,
  Code,
  Command,
  CreditCard,
  Folder,
  GraduationCap,
  Images,
  Keyboard,
  Layers,
  Lightbulb,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  OctagonX,
  Pencil,
  Plug,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Type,
  Zap
}

const GROUP_LABEL: Record<NavigatorCategory, string> = {
  shortcut: 'Do something',
  screen: 'Open a screen',
  project: 'Projects',
  session: 'Code sessions',
  chat: 'Recent chats'
}

function labelMatch(label: string, query: string): Snippet {
  const word = query.trim().split(/\s+/)[0] ?? ''
  const m = word ? fuzzyMatch(label, word) : null
  return { text: label, index: m?.index ?? -1, length: m?.length ?? 0 }
}

function groupRows(rows: NavigatorTarget[]): { cat: NavigatorCategory; rows: NavigatorTarget[] }[] {
  return [...new Set(rows.map((t) => t.category))].map((cat) => ({ cat, rows: rows.filter((t) => t.category === cat) }))
}
const IDLE_SESSIONS = 10
const SEARCH_DEBOUNCE_MS = 120
const MARKER = 'bg-yellow/50 text-on-surface font-semibold rounded-[3px] px-0.5'
const NEW_CHAT_ID = 'screen:newChat'
const QUICK_PICKS = 9
const NEW_CODE_SESSION: NavigatorTarget = {
  id: 'screen:newCodeSession',
  category: 'screen',
  label: 'New code session',
  detail: 'Start a new coding session in your current project.',
  icon: 'SquareTerminal',
  keywords: 'new chat start fresh blank begin conversation session code agent'
}

export default function NavigatorApp(): JSX.Element {
  const [query, setQuery] = useState('')
  const [lastQuery, setLastQuery] = useState('')
  const [opens, setOpens] = useState(0)
  const queryRef = useRef('')
  const [rawPos, setPos] = useState<{ col: 0 | 1; i: number }>({ col: 0, i: 0 })
  const [chats, setChats] = useState<NavigatorTarget[]>([])
  const [projectList, setProjectList] = useState<MightyProject[]>([])
  const [agentSessions, setAgentSessions] = useState<AgentRelaySessionInfo[]>([])
  const [hits, setHits] = useState<{ query: string; found: NavigatorContentHit[] }>({ query: '', found: [] })
  const isAdmin = useIsAdmin()
  const [mode, setMode] = useState(readLastTab)
  const inputRef = useRef<HTMLInputElement>(null)
  const colRefs = useRef<(HTMLDivElement | null)[]>([null, null])

  // Shortcuts and screens are static, so the overlay paints instantly and the
  // chat rows drop in when the store answers -- never a spinner over the field.
  useEffect(() => {
    let alive = true
    void window.api.mighty
      .listSessions()
      .then((sessions) => {
        if (!alive) return
        setChats(
          sessions.slice(0, 8).map((s) => ({
            id: `chat:${s.id}`,
            category: 'chat' as const,
            label: s.title || CONFIG.UI_LABELS.UNTITLED_CHAT,
            icon: 'MessageSquare'
          }))
        )
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [opens])

  useEffect(() => {
    let alive = true
    void window.api.mighty
      .listProjects()
      .then((list) => {
        if (alive) setProjectList(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [opens])

  useEffect(() => {
    let alive = true
    void window.api
      .agentRelayGetStatus()
      .then((status) => {
        if (alive) setAgentSessions(status.agentSessions ?? [])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [opens])

  useEffect(() => {
    inputRef.current?.focus()
    const clear = (): void => {
      if (queryRef.current.trim()) setLastQuery(queryRef.current.trim())
      queryRef.current = ''
      setQuery('')
      setPos({ col: 0, i: 0 })
    }
    const onFocus = (): void => {
      clear()
      setMode(readLastTab())
      setOpens((n) => n + 1)
      inputRef.current?.focus()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', clear)
    }
  }, [])

  const projects = useMemo<NavigatorTarget[]>(
    () =>
      projectList.map((p) => {
        const code = mode === 'code' && p.repoFolder !== undefined
        return {
          id: `${code ? 'codeProject' : 'project'}:${p.id}`,
          category: 'project' as const,
          label: p.name,
          detail: code ? 'Start a code session in this project.' : 'Start a chat in this project.',
          icon: 'Folder',
          avatar: { icon: p.icon, imagePath: p.imagePath }
        }
      }),
    [projectList, mode]
  )

  const sessions = useMemo<NavigatorTarget[]>(() => {
    const now = Date.now()
    const recent = [...agentSessions].sort(
      (a, b) => (b.lastActivityAt ?? b.since ?? 0) - (a.lastActivityAt ?? a.since ?? 0)
    )
    return recent.flatMap((s) => {
      const row = sessionRow(s, now)
      const label = row.name ?? row.tldr ?? row.agent ?? row.repo
      if (!label || row.unnamed) return []
      const project = mightyProjectForCwd(s.cwd, projectList)
      return [{
        id: `session:${s.sessionId ?? s.stated ?? s.label}`,
        category: 'session' as const,
        label,
        detail: project?.name ?? row.repo,
        keywords: row.tldr,
        icon: 'SquareTerminal',
        avatar: { icon: project?.icon, imagePath: project?.imagePath }
      }]
    })
  }, [agentSessions, projectList])

  const searchRefs = useMemo<NavigatorSearchRef[]>(
    () =>
      agentSessions.flatMap((s) =>
        s.sessionId && s.cwd ? [{ id: `session:${s.sessionId}`, sessionId: s.sessionId, cwd: s.cwd }] : []
      ),
    [agentSessions]
  )

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      void window.api.navigator.search('', searchRefs).catch(() => {})
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void window.api.navigator
        .search(q, searchRefs)
        .then((found) => {
          if (alive) setHits({ query: q, found })
        })
        .catch(() => {})
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, searchRefs])
  const searching = query.trim() !== '' && hits.query !== query.trim()

  const actions = useMemo(
    () =>
      [
        ...shortcutTargets(),
        ...SCREEN_TARGETS.filter((t) => isAdmin || !t.adminOnly).map((t) =>
          mode === 'code' && t.id === NEW_CHAT_ID ? NEW_CODE_SESSION : t
        ),
        ...projects
      ].filter((t) => matchesTarget(t, query)),
    [projects, isAdmin, mode, query]
  )
  const recent = useMemo(() => {
    const shownSessions = query.trim() ? sessions : sessions.slice(0, IDLE_SESSIONS)
    const both = mode === 'code' ? [...shownSessions, ...chats] : [...chats, ...shownSessions]
    const byTitle = both.filter((t) => matchesTarget(t, query))
    if (hits.query !== query.trim()) return byTitle
    const shown = new Set(byTitle.map((t) => t.id))
    const sessionById = new Map(sessions.map((t) => [t.id, t]))
    const inside = hits.found.flatMap<NavigatorTarget>((h) => {
      if (shown.has(h.id)) return []
      const session = sessionById.get(h.id)
      if (session) return [{ ...session, detail: h.snippet?.text || session.detail }]
      if (!h.id.startsWith('chat:')) return []
      return [{ id: h.id, category: 'chat', label: h.title, detail: h.snippet?.text, icon: 'MessageSquare' }]
    })
    const first = mode === 'code' ? 'session' : 'chat'
    return [...byTitle, ...inside].sort((a, b) => Number(b.category === first) - Number(a.category === first))
  }, [sessions, chats, mode, query, hits])

  const snippetById = useMemo(
    () => new Map(hits.found.flatMap((h) => (h.snippet ? [[h.id, h.snippet] as const] : []))),
    [hits]
  )

  const columns = useMemo(() => [groupRows(actions), groupRows(recent)], [actions, recent])
  const lists = useMemo(() => columns.map((c) => c.flatMap((g) => g.rows)), [columns])

  const col = lists[rawPos.col].length > 0 ? rawPos.col : rawPos.col === 0 ? 1 : 0
  const active = Math.min(col === rawPos.col ? rawPos.i : 0, Math.max(lists[col].length - 1, 0))
  useEffect(() => {
    colRefs.current[col]?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [col, active, lists])

  const run = useCallback((t: NavigatorTarget) => {
    void window.api.navigator.run(t.id)
  }, [])

  const switchColumn = (): void => {
    const other = col === 0 ? 1 : 0
    if (lists[other].length > 0) setPos({ col: other, i: 0 })
  }

  const type = (next: string): void => {
    queryRef.current = next
    setQuery(next)
    setPos({ col: 0, i: 0 })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const pick = e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key)
      ? lists[1][Number(e.key) - 1]
      : undefined
    if (pick) {
      e.preventDefault()
      run(pick)
    } else if (e.key === 'Tab' && !query && lastQuery) {
      e.preventDefault()
      type(lastQuery)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setPos({ col, i: Math.min(active + 1, lists[col].length - 1) })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setPos({ col, i: Math.max(active - 1, 0) })
    } else if (e.key === 'Tab' || (!query && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
      e.preventDefault()
      switchColumn()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const t = lists[col][active]
      if (t) run(t)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void window.api.navigator.close()
    }
  }

  const renderColumn = (c: 0 | 1): JSX.Element => (
    <div
      ref={(el) => {
        colRefs.current[c] = el
      }}
      className={`overflow-y-auto py-1.5 flex-1 basis-0 min-w-0 ${c === 1 ? 'border-l border-surface3' : ''}`}
    >
      {lists[c].length === 0 && (
        <div className="px-4 py-10 text-center text-sm text-muted">
          {query
            ? c === 1 && searching
              ? 'Looking inside your conversations…'
              : 'Nothing matches that.'
            : c === 1
              ? 'Nothing recent yet.'
              : ''}
        </div>
      )}
      {columns[c].map((g) => (
        <div key={g.cat} className="pb-2">
          <div className="sticky top-0 z-10 bg-surface1 px-4 pt-2.5 pb-1.5 text-[11px] uppercase tracking-wide text-muted">
            {GROUP_LABEL[g.cat]}
          </div>
          {g.rows.map((t) => {
            const i = lists[c].indexOf(t)
            const on = c === col && i === active
            const Icon = ICONS[t.icon] ?? Command
            const found = snippetById.get(t.id)
            const snippet = found && found.text === t.detail ? found : null
            return (
              <Button
                variant="bare"
                key={t.id}
                data-active={on}
                onMouseMove={() => setPos({ col: c, i })}
                onClick={() => run(t)}
                className={`w-full flex gap-3 px-4 text-left ${snippet ? 'items-start py-2.5' : 'items-center min-h-11 py-1.5'} ${on ? 'bg-surface2' : ''}`}
              >
                {t.avatar ? (
                  <ProjectAvatar
                    icon={t.avatar.icon}
                    imagePath={t.avatar.imagePath}
                    size={18}
                    className="rounded-sm"
                  />
                ) : (
                  <Icon size={17} className="text-muted shrink-0" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate">
                    {query.trim() ? <SnippetLine snippet={labelMatch(t.label, query)} markClassName={MARKER} /> : t.label}
                  </span>
                  {snippet ? (
                    <span className="mt-1 text-xs leading-snug text-muted line-clamp-2">
                      <SnippetLine snippet={snippet} markClassName={MARKER} />
                    </span>
                  ) : (
                    t.detail && <span className="block text-[11px] text-muted truncate">{t.detail}</span>
                  )}
                </span>
                {t.keys && <Kbd glyphs={t.keys} />}
                {c === 1 && i < QUICK_PICKS && <Kbd glyphs={['Cmd', String(i + 1)]} />}
              </Button>
            )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <div className="h-screen w-screen flex flex-col bg-surface1 text-on-surface rounded-xl overflow-hidden border border-surface3">
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-surface3 shrink-0">
        <Search size={18} className="text-muted shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => type(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What do you want to do?"
          className="flex-1 bg-transparent text-lg outline-none placeholder:text-muted"
        />
        {!query && lastQuery && (
          <span className="flex items-center gap-1.5 min-w-0 max-w-[260px] text-xs text-muted">
            <span className="truncate">{lastQuery}</span>
            <Kbd glyphs={['tab']} />
          </span>
        )}
        <Kbd glyphs={['esc']} />
      </div>

      <div className="flex-1 flex min-h-0">
        {renderColumn(0)}
        {renderColumn(1)}
      </div>
    </div>
  )
}
