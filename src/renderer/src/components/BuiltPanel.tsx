import { JSX, useEffect, useMemo, useState } from 'react'
import * as Select from '@radix-ui/react-select'
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, Globe, LayoutGrid, List, MessageSquare, Monitor, Search, Server, Star, X } from 'lucide-react'
import { Button } from './Button'
import { CopyButton, ICON_SIZE } from './CopyButton'
import { ProjectAvatar } from './ProjectIcon'
import { ProviderIcon, type ProviderIconId } from './ProviderIcon'
import type { MightyProject } from '../../../shared/types'
import {
  BUILT_FILTERS,
  BUILT_KIND_LABELS,
  builtAge,
  builtByDay,
  builtCounts,
  builtMatches,
  builtByTag,
  builtTagCounts,
  type BuiltFilter,
  type BuiltItem,
  type BuiltKind,
  type BuiltRunResult
} from '../../../shared/built'
import './KeysPanel.css'
import './BuiltPanel.css'

const ALL = 'all'
const REFRESH_MS = 30_000
const LAYOUT_KEY = 'mm.made.layout'
const GROUP_KEY = 'mm.made.groupBy'
const DETAIL_KEY = 'mm.made.detailWidth'
const DETAIL_WIDTH = { min: 300, default: 340, max: 640 }
const COLS_KEY = 'mm.made.columns'
const COL_MIN = 64
const KIND_ICON: Record<BuiltKind, typeof Globe> = { online: Globe, file: Monitor, running: Server, stopped: Server }
const MAKER: Record<BuiltItem['madeBy'], { icon: ProviderIconId; company: string }> = {
  Claude: { icon: 'claude', company: 'Anthropic' },
  Codex: { icon: 'codex', company: 'OpenAI' }
}
const KIND_ORDER: Record<BuiltKind, number> = { running: 0, online: 1, file: 2, stopped: 3 }

type Layout = 'grid' | 'table'
type GroupBy = 'tag' | 'day'
type SortKey = 'title' | 'kind' | 'project' | 'firstSeen' | 'lastSeen'
type ColWidths = Record<string, number>

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'table' ? 'table' : 'grid'
  } catch {
    return 'grid'
  }
}

function readGroupBy(): GroupBy {
  try {
    return localStorage.getItem(GROUP_KEY) === 'day' ? 'day' : 'tag'
  } catch {
    return 'tag'
  }
}

function TagEditor({
  item,
  known,
  onChange
}: {
  item: BuiltItem
  known: string[]
  onChange: (items: BuiltItem[]) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const tags = item.tags ?? []
  const save = (next: string[]): void => void window.api.built.tag(item.id, next).then(onChange)
  const add = (): void => {
    if (draft.trim()) save([...tags, draft])
    setDraft('')
  }
  return (
    <div className="built-tag-edit">
      {tags.map((tag) => (
        <span key={tag} className="built-tag">
          {tag}
          <Button variant="bare" title={`Remove ${tag}`} aria-label={`Remove ${tag}`} onClick={() => save(tags.filter((t) => t !== tag))}>
            <X size={11} />
          </Button>
        </span>
      ))}
      <input
        value={draft}
        list="built-known-tags"
        placeholder="Add a tag"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
        onBlur={add}
      />
      <datalist id="built-known-tags">
        {known.filter((t) => !tags.includes(t)).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  )
}

function readCols(): ColWidths {
  try {
    return JSON.parse(localStorage.getItem(COLS_KEY) ?? '{}') as ColWidths
  } catch {
    return {}
  }
}

function saveCols(widths: ColWidths | null): void {
  try {
    if (widths) localStorage.setItem(COLS_KEY, JSON.stringify(widths))
    else localStorage.removeItem(COLS_KEY)
  } catch {
    return
  }
}

function readDetailWidth(): number {
  try {
    const saved = Number(localStorage.getItem(DETAIL_KEY))
    return saved >= DETAIL_WIDTH.min && saved <= DETAIL_WIDTH.max ? saved : DETAIL_WIDTH.default
  } catch {
    return DETAIL_WIDTH.default
  }
}

function badge(item: BuiltItem): string {
  const label = BUILT_KIND_LABELS[item.kind]
  return item.port ? `${label} · :${item.port}` : label
}

function where(item: BuiltItem): string {
  if (item.kind === 'online') return (item.url ?? '').replace(/^https:\/\//, '')
  if (item.file) return item.file.split('/').slice(-3).join('/')
  return item.url?.replace(/^https?:\/\//, '') ?? ''
}

function historyRows(item: BuiltItem): Array<[string, string]> {
  const verb = item.kind === 'online' ? 'Published' : 'Saved'
  return (item.history ?? [])
    .map((t, i): [string, string] => [i === 0 ? `First ${verb.toLowerCase()}` : `${verb} v${i + 1}`, builtAge(t)])
    .reverse()
}

function open(item: BuiltItem): void {
  if (item.kind !== 'stopped') void window.api.built.open(item.id, 'open')
}

function FavoriteButton({
  item,
  onChange,
  className
}: {
  item: BuiltItem
  onChange: (items: BuiltItem[]) => void
  className?: string
}): JSX.Element {
  const label = item.favorite ? 'Remove from favorites' : 'Add to favorites'
  return (
    <Button
      variant="icon"
      className={className}
      title={label}
      aria-label={label}
      aria-pressed={Boolean(item.favorite)}
      data-on={item.favorite || undefined}
      onClick={(e) => {
        e.stopPropagation()
        void window.api.built.favorite(item.id, !item.favorite).then(onChange)
      }}
    >
      <Star size={14} fill={item.favorite ? 'currentColor' : 'none'} />
    </Button>
  )
}

function Maker({ item, size = 13 }: { item: BuiltItem; size?: number }): JSX.Element {
  const maker = MAKER[item.madeBy]
  return (
    <span className="built-maker" title={`${item.madeBy} by ${maker.company}`}>
      <ProviderIcon id={maker.icon} size={size} />
      {item.madeBy}
    </span>
  )
}

function Byline({ item }: { item: BuiltItem }): JSX.Element {
  return (
    <span className="built-byline">
      <Maker item={item} />
      {item.chat && <span className="built-byline-chat">&quot;{item.chat}&quot;</span>}
      <span className="built-byline-age">{builtAge(item.lastSeen)}</span>
    </span>
  )
}

function CardMeta({ item, project }: { item: BuiltItem; project?: MightyProject }): JSX.Element {
  return (
    <span className="built-card-meta">
      <ProjectAvatar
        icon={project?.icon}
        imagePath={project?.imagePath}
        size={13}
        className="built-card-meta-pic"
      />
      <span className="built-card-meta-name">{project?.name ?? ''}</span>
      <span className="built-card-meta-sep">·</span>
      <span className="built-card-meta-age">{builtAge(item.lastSeen)}</span>
      {item.kind === 'running' && <span className="built-live" title="Running" />}
    </span>
  )
}

function Thumb({
  item,
  large = false,
  hideBadge = false
}: {
  item: BuiltItem
  large?: boolean
  hideBadge?: boolean
}): JSX.Element {
  const Icon = KIND_ICON[item.kind]
  return (
    <div className="built-thumb" data-kind={item.kind} data-large={large || undefined}>
      <div className="built-thumb-page">
        {item.thumb ? (
          <img src={window.api.mediaUrl(item.thumb)} alt="" />
        ) : (
          <Icon size={large ? 36 : 26} strokeWidth={1.4} />
        )}
      </div>
      {!hideBadge && (
        <span className="built-badge" data-kind={item.kind}>
          <span className="built-dot" />
          {badge(item)}
        </span>
      )}
    </div>
  )
}

function KindPill({ item }: { item: BuiltItem }): JSX.Element {
  return (
    <span className="built-pill" data-kind={item.kind}>
      <span className="built-dot" />
      {badge(item)}
    </span>
  )
}

function Detail({
  item,
  projectName,
  width,
  onResize,
  onOpenSession,
  onHidden,
  onFavorite,
  knownTags
}: {
  item: BuiltItem
  knownTags: string[]
  projectName: string
  width: number
  onResize: (width: number, done: boolean) => void
  onOpenSession: (sessionId: string) => void
  onHidden: (items: BuiltItem[]) => void
  onFavorite: (items: BuiltItem[]) => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
  const [outcome, setOutcome] = useState<{ what: 'start' | 'stop'; result: BuiltRunResult } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    setCopied(false)
    setBusy(null)
    setOutcome(null)
  }, [item.id])
  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const started = Date.now()
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500)
    return () => clearInterval(tick)
  }, [busy])
  const act = (what: 'start' | 'stop'): void => {
    setBusy(what)
    setOutcome(null)
    void window.api.built[what](item.id)
      .catch((): BuiltRunResult => 'failed')
      .then((result) => {
        setBusy(null)
        setOutcome({ what, result })
      })
  }
  const waited = elapsed > 0 ? ` ${elapsed}s` : ''
  const note = outcome && OUTCOME_NOTE[outcome.what][outcome.result]
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const right = e.currentTarget.parentElement!.getBoundingClientRect().right
    const at = (x: number): number => Math.min(DETAIL_WIDTH.max, Math.max(DETAIL_WIDTH.min, right - x))
    const move = (ev: MouseEvent): void => onResize(at(ev.clientX), false)
    const up = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      onResize(at(ev.clientX), true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const copyText = item.url ?? item.file
  const copy = (): void => {
    if (!copyText) return
    void navigator.clipboard.writeText(copyText).then(() => setCopied(true))
  }
  const openLabel = item.kind === 'online' ? 'Open link' : item.kind === 'file' ? 'Open file' : 'Open'
  const maker = MAKER[item.madeBy]
  const facts: Array<[string, string | undefined, boolean]> = [
    ['Link', item.url, true],
    ['File', item.file, true],
    ['Runs', item.command, true],
    ['Project', projectName, false]
  ]
  const history = historyRows(item)
  return (
    <aside className="built-detail" style={{ width }}>
      <div
        className="built-detail-grip"
        title="Drag to resize · double-click to reset"
        onMouseDown={startResize}
        onDoubleClick={() => onResize(DETAIL_WIDTH.default, true)}
      />
      <Thumb item={item} large />
      <div className="built-detail-head">
        <div>
          <h3 className="built-detail-title">{item.title}</h3>
          <Byline item={item} />
        </div>
        <FavoriteButton item={item} onChange={onFavorite} className="built-star" />
      </div>
      <div className="built-actions">
        {item.kind === 'stopped' ? (
          <Button disabled={!item.canStart || busy === 'start'} onClick={() => act('start')}>
            {busy === 'start' ? `Starting…${waited}` : 'Start'}
          </Button>
        ) : (
          <Button onClick={() => open(item)}>{openLabel}</Button>
        )}
        <Button variant="ghost" disabled={!item.sessionId} onClick={() => item.sessionId && onOpenSession(item.sessionId)}>
          Go to chat
        </Button>
        {item.kind === 'running' ? (
          <Button variant="ghost" disabled={!item.pid || busy === 'stop'} onClick={() => act('stop')}>
            {busy === 'stop' ? `Stopping…${waited}` : 'Stop'}
          </Button>
        ) : item.kind === 'online' || !item.file ? (
          <Button variant="ghost" disabled={!copyText} onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => void window.api.built.open(item.id, 'reveal')}>
            Show in Finder
          </Button>
        )}
        <Button variant="ghost" onClick={() => void window.api.built.hide(item.id).then(onHidden)}>
          Archive
        </Button>
      </div>
      {busy && (
        <p className="built-note">
          {busy === 'stop' ? 'Closing it and checking the port is free…' : 'Running it and waiting for it to answer…'}
        </p>
      )}
      {note && !busy && (
        <p className="built-note" data-failed={note.bad ? '' : undefined}>
          {note.text}
        </p>
      )}
      {item.kind === 'stopped' && !busy && !note && (
        <p className="built-note">
          {item.canStart ? 'Not running. Start runs it again the same way it ran last time.' : 'Not running anymore. Ask the agent to start it again.'}
        </p>
      )}
      <section>
        <h4 className="built-section">Tags</h4>
        <TagEditor item={item} known={knownTags} onChange={onFavorite} />
      </section>
      <dl className="built-facts">
        {facts
          .filter(([, v]) => v)
          .map(([k, v, mono]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd title={v} data-mono={mono || undefined}>
                {v}
              </dd>
            </div>
          ))}
        <div>
          <dt>Made by</dt>
          <dd className="built-maker-full">
            <ProviderIcon id={maker.icon} size={14} />
            {item.madeBy}
            <span className="built-count">by {maker.company}</span>
          </dd>
        </div>
      </dl>
      {history.length > 0 && (
        <section>
          <h4 className="built-section">History</h4>
          <ul className="built-history">
            {history.map(([what, when]) => (
              <li key={what}>
                <span>{what}</span>
                <span className="built-count">{when}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}

function Table({
  items,
  selectedId,
  showProject,
  nameOf,
  onSelect,
  onOpenSession,
  onFavorite
}: {
  items: BuiltItem[]
  selectedId: string | null
  showProject: boolean
  nameOf: (id: string) => string
  onSelect: (id: string) => void
  onOpenSession: (sessionId: string) => void
  onFavorite: (items: BuiltItem[]) => void
}): JSX.Element {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'lastSeen', desc: true })
  const sorted = useMemo(() => {
    const value = (i: BuiltItem): string | number =>
      sort.key === 'kind' ? KIND_ORDER[i.kind] : sort.key === 'project' ? nameOf(i.projectId) : sort.key === 'title' ? i.title.toLowerCase() : sort.key === 'firstSeen' ? i.firstSeen : i.lastSeen
    return [...items].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
      const x = value(a)
      const y = value(b)
      const cmp = x < y ? -1 : x > y ? 1 : 0
      return sort.desc ? -cmp : cmp
    })
  }, [items, sort, nameOf])
  const [widths, setWidths] = useState<ColWidths>(readCols)
  const startColResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const right = e.currentTarget.parentElement as HTMLElement
    const left = right.previousElementSibling as HTMLElement
    const [l, r] = [left.dataset.col!, right.dataset.col!]
    const [lw, rw, x0] = [left.offsetWidth, right.offsetWidth, e.clientX]
    const at = (x: number): ColWidths => {
      const dx = Math.min(rw - COL_MIN, Math.max(COL_MIN - lw, x - x0))
      return { ...widths, ...(l === 'title' ? {} : { [l]: lw + dx }), [r]: rw - dx }
    }
    const move = (ev: MouseEvent): void => setWidths(at(ev.clientX))
    const up = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      saveCols(at(ev.clientX))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const resetCols = (): void => {
    setWidths({})
    saveCols(null)
  }
  const head = (key: string, label: string, sortKey?: SortKey): JSX.Element => (
    <th data-col={key} style={{ width: widths[key] }}>
      {key !== 'title' && (
        <span
          className="built-col-grip"
          title="Drag to resize · double-click to reset"
          onMouseDown={startColResize}
          onDoubleClick={resetCols}
        />
      )}
      {sortKey ? (
        <Button
          variant="bare"
          className="built-th"
          data-active={sort.key === sortKey || undefined}
          onClick={() => setSort((s) => ({ key: sortKey, desc: s.key === sortKey ? !s.desc : sortKey === 'lastSeen' || sortKey === 'firstSeen' }))}
        >
          {label}
          {sort.key === sortKey && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
        </Button>
      ) : (
        label
      )}
    </th>
  )
  return (
    <table className="built-table">
      <thead>
        <tr>
          {head('title', 'Name', 'title')}
          {head('kind', 'Kind', 'kind')}
          {showProject && head('project', 'Project', 'project')}
          {head('maker', 'Made by')}
          {head('where', 'Where')}
          {head('firstSeen', 'Created', 'firstSeen')}
          {head('lastSeen', 'Changed', 'lastSeen')}
          <th data-col="actions" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((item) => (
          <tr
            key={item.id}
            data-active={item.id === selectedId || undefined}
            onClick={() => onSelect(item.id)}
            onDoubleClick={() => open(item)}
          >
            <td>
              <div className="built-td-name">
                <span className="built-mini" data-kind={item.kind}>
                  {item.thumb ? <img src={window.api.mediaUrl(item.thumb)} alt="" /> : null}
                </span>
                <span className="built-td-title">
                  <span>{item.title}</span>
                  {item.chat && <span className="built-count">&quot;{item.chat}&quot;</span>}
                </span>
              </div>
            </td>
            <td>
              <KindPill item={item} />
            </td>
            {showProject && <td className="built-td-muted">{nameOf(item.projectId)}</td>}
            <td>
              <Maker item={item} />
            </td>
            <td className="built-td-where" title={item.url ?? item.file}>
              {where(item)}
            </td>
            <td className="built-td-muted" title={new Date(item.firstSeen).toLocaleString()}>
              {builtAge(item.firstSeen)}
            </td>
            <td className="built-td-muted">{builtAge(item.lastSeen)}</td>
            <td className="built-td-actions" onClick={(e) => e.stopPropagation()}>
              <FavoriteButton item={item} onChange={onFavorite} className="built-star" />
              <Button variant="quiet" title="Open" disabled={item.kind === 'stopped'} onClick={() => open(item)}>
                <ExternalLink size={ICON_SIZE} />
              </Button>
              <CopyButton
                label={item.url ? 'Copy link' : 'Copy path'}
                disabled={!(item.url ?? item.file)}
                text={item.url ?? item.file ?? ''}
              />
              <Button
                variant="quiet"
                title="Go to chat"
                disabled={!item.sessionId}
                onClick={() => item.sessionId && onOpenSession(item.sessionId)}
              >
                <MessageSquare size={ICON_SIZE} />
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const OUTCOME_NOTE: Record<'start' | 'stop', Partial<Record<BuiltRunResult, { text: string; bad?: boolean }>>> = {
  stop: {
    stopped: { text: 'Stopped. The port is free.' },
    restarted: { text: 'It closed, then came straight back. Something keeps restarting it - ask the agent from Go to chat.', bad: true },
    failed: { text: "Couldn't stop it. It may have already stopped - try again in a moment.", bad: true }
  },
  start: {
    started: { text: 'Running again.' },
    failed: { text: "It didn't come up within 15 seconds. Ask the agent from Go to chat.", bad: true }
  }
}

const ALL_TAGS = '__all'

export function BuiltPanel({
  onOpenSession
}: {
  onOpenSession: (sessionId: string) => void
}): JSX.Element {
  const [items, setItems] = useState<BuiltItem[] | null>(null)
  const [projects, setProjects] = useState<MightyProject[]>([])
  const [project, setProject] = useState<string>(ALL)
  const [filter, setFilter] = useState<BuiltFilter>('all')
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [groupBy, setGroupByState] = useState<GroupBy>(readGroupBy)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  const [detailWidth, setDetailWidth] = useState(readDetailWidth)
  const resizeDetail = (width: number, done: boolean): void => {
    setDetailWidth(width)
    if (!done) return
    try {
      localStorage.setItem(DETAIL_KEY, String(width))
    } catch {
      return
    }
  }

  const setGroupBy = (next: GroupBy): void => {
    setGroupByState(next)
    try {
      localStorage.setItem(GROUP_KEY, next)
    } catch {
      return
    }
  }

  const setLayout = (next: Layout): void => {
    setLayoutState(next)
    try {
      localStorage.setItem(LAYOUT_KEY, next)
    } catch {
      return
    }
  }

  useEffect(() => {
    void window.api.mighty
      .listProjects()
      .then((list) => setProjects(list.filter((p) => !p.archived)))
      .catch(() => setProjects([]))
    const load = (): void => void window.api.built.list().then((next) => next && setItems(next))
    load()
    const timer = setInterval(load, REFRESH_MS)
    const off = window.api.built.onChanged(setItems)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [])

  const inProject = useMemo(
    () => (items ?? []).filter((i) => project === ALL || i.projectId === project),
    [items, project]
  )
  const counts = builtCounts(inProject)
  const tagCounts = builtTagCounts(inProject)
  const activeTag = tag && tagCounts.some(([t]) => t === tag) ? tag : null
  const shown = inProject.filter((i) => builtMatches(i, filter, query) && (!activeTag || i.tags?.includes(activeTag)))
  const byTag = groupBy === 'tag' && tagCounts.length > 0 && !activeTag
  const groups = byTag ? builtByTag(shown) : builtByDay(shown)
  const selected = shown.find((i) => i.id === selectedId) ?? null
  const perProject = (id: string): number => (items ?? []).filter((i) => i.projectId === id).length
  const nameOf = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]))
    return (id: string): string => names.get(id) ?? ''
  }, [projects])
  const projectOf = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    return (id: string): MightyProject | undefined => byId.get(id)
  }, [projects])
  const toggle = (id: string): void => setSelectedId((cur) => (cur === id ? null : id))

  const scopeProject = project === ALL ? undefined : projectOf(project)

  return (
    <div className="built-panel">
      <nav className="keys-rail">
        <Button variant="bare" className="keys-rail-row" data-active={project === ALL || undefined} onClick={() => setProject(ALL)}>
          <span className="keys-rail-name">All projects</span>
          <span className="built-count">{items?.length ?? ''}</span>
        </Button>
        {projects
          .filter((p) => perProject(p.id) > 0)
          .sort((a, b) => perProject(b.id) - perProject(a.id))
          .map((p) => (
            <Button
              key={p.id}
              variant="bare"
              className="keys-rail-row"
              data-active={project === p.id || undefined}
              onClick={() => setProject(p.id)}
            >
              <ProjectAvatar icon={p.icon} imagePath={p.imagePath} size={16} className="rounded-sm" />
              <span className="keys-rail-name">{p.name}</span>
              <span className="built-count">{perProject(p.id)}</span>
            </Button>
          ))}
      </nav>
      <section className="built-main">
        <header className="built-head">
          <h2 className="built-heading">
            {scopeProject && (
              <ProjectAvatar icon={scopeProject.icon} imagePath={scopeProject.imagePath} size={20} className="rounded-sm" />
            )}
            {scopeProject?.name ?? 'All projects'}
          </h2>
          <label className="built-search">
            <Search size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
          </label>
          <div className="built-layout" role="group">
            <Button variant="bare" title="Grid" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}>
              <LayoutGrid size={14} />
            </Button>
            <Button variant="bare" title="Table" aria-pressed={layout === 'table'} onClick={() => setLayout('table')}>
              <List size={14} />
            </Button>
          </div>
        </header>
        <div className="built-chips">
          <div className="built-seg" role="group">
            {BUILT_FILTERS.filter((f) => f.id === 'all' || f.id === 'online' || f.id === 'file').map((f) => (
              <Button
                key={f.id}
                variant="bare"
                className="built-seg-btn"
                data-active={filter === f.id || undefined}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span className="built-chip-count">{counts[f.id]}</span>
              </Button>
            ))}
          </div>
          <Button
            variant="bare"
            className="built-toggle"
            data-active={filter === 'running' || undefined}
            onClick={() => setFilter((cur) => (cur === 'running' ? 'all' : 'running'))}
          >
            <span className="built-live" />
            Running now <span className="built-chip-count">{counts.running}</span>
          </Button>
          {counts.favorites > 0 && (
            <Button
              variant="bare"
              className="built-toggle"
              data-active={filter === 'favorites' || undefined}
              onClick={() => setFilter((cur) => (cur === 'favorites' ? 'all' : 'favorites'))}
            >
              Favorites <span className="built-chip-count">{counts.favorites}</span>
            </Button>
          )}
          {tagCounts.length > 0 && (
            <Select.Root value={activeTag ?? ALL_TAGS} onValueChange={(v) => setTag(v === ALL_TAGS ? null : v)}>
              <Select.Trigger className="built-toggle built-tag-select" data-active={activeTag ? true : undefined} aria-label="Type">
                <Select.Value>{activeTag ?? 'All types'}</Select.Value>
                <Select.Icon>
                  <ChevronDown size={13} />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content position="popper" sideOffset={4} className="built-tag-menu">
                  <Select.Viewport>
                    {[[ALL_TAGS, inProject.length] as const, ...tagCounts].map(([t, n]) => (
                      <Select.Item key={t} value={t} className="built-tag-item">
                        <Select.ItemText>{t === ALL_TAGS ? 'All types' : t}</Select.ItemText>
                        <span className="built-chip-count">{n}</span>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          )}
          {layout === 'grid' && tagCounts.length > 0 && (
            <div className="built-seg built-group-by" role="group" aria-label="Group">
              {(['tag', 'day'] as const).map((g) => (
                <Button
                  key={g}
                  variant="bare"
                  className="built-seg-btn"
                  data-active={groupBy === g || undefined}
                  onClick={() => setGroupBy(g)}
                >
                  {g === 'tag' ? 'By tag' : 'By day'}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="built-scroll">
          {items === null ? (
            <div className="built-grid built-loading" aria-label="Looking through what your agents made">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="built-card built-skeleton skeleton" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <p className="built-empty">
              {items.length === 0
                ? 'Nothing yet. Pages, links and apps your agents make will show up here.'
                : 'Nothing matches.'}
            </p>
          ) : layout === 'table' ? (
            <Table
              items={shown}
              selectedId={selectedId}
              showProject={project === ALL}
              nameOf={nameOf}
              onSelect={toggle}
              onOpenSession={onOpenSession}
              onFavorite={setItems}
            />
          ) : (
            groups.map(([day, list]) => (
              <div key={day}>
                <h4 className="built-day">{day}</h4>
                <div className="built-grid">
                  {list.map((item) => (
                    <div key={item.id} className="built-card-wrap">
                      <Button
                        variant="bare"
                        className="built-card"
                        data-active={item.id === selectedId || undefined}
                        onClick={() => toggle(item.id)}
                        onDoubleClick={() => open(item)}
                      >
                        <Thumb item={item} hideBadge />
                        <span className="built-card-body">
                          <span className="built-card-title">{item.title}</span>
                          <CardMeta item={item} project={projectOf(item.projectId)} />
                        </span>
                      </Button>
                      <FavoriteButton item={item} onChange={setItems} className="built-star built-card-star" />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
      {selected && (
        <Detail
          item={selected}
          projectName={nameOf(selected.projectId)}
          width={detailWidth}
          onResize={resizeDetail}
          onOpenSession={onOpenSession}
          onHidden={(next) => {
            setItems(next)
            setSelectedId(null)
          }}
          onFavorite={setItems}
          knownTags={tagCounts.map(([t]) => t)}
        />
      )}
    </div>
  )
}
