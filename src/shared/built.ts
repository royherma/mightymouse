export type BuiltKind = 'online' | 'file' | 'running' | 'stopped'

export interface BuiltItem {
  id: string
  kind: BuiltKind
  title: string
  projectId: string
  /** Online link, or http://localhost:<port> for a local server. */
  url?: string
  file?: string
  port?: number
  pid?: number
  canStart?: boolean
  command?: string
  sessionId?: string
  chat?: string
  cwd?: string
  madeBy: 'Claude' | 'Codex'
  firstSeen: string
  lastSeen: string
  versions: number
  history?: string[]
  thumb?: string
  favorite?: boolean
  tags?: string[]
}

export type BuiltFilter = 'all' | 'favorites' | 'online' | 'file' | 'running'

export const BUILT_FILTERS: Array<{ id: BuiltFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'On the web' },
  { id: 'file', label: 'On this Mac' },
  { id: 'running', label: 'Running now' },
  { id: 'favorites', label: 'Favorites' }
]

export const BUILT_KIND_LABELS: Record<BuiltKind, string> = {
  online: 'Online',
  file: 'On this Mac',
  running: 'Running',
  stopped: 'Stopped'
}

export function builtMatches(item: BuiltItem, filter: BuiltFilter, query: string): boolean {
  if (filter === 'favorites' && !item.favorite) return false
  if (filter === 'running' && item.kind !== 'running' && item.kind !== 'stopped') return false
  if ((filter === 'online' || filter === 'file') && item.kind !== filter) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [item.title, item.url, item.file, item.command, ...(item.tags ?? [])].some((s) => s?.toLowerCase().includes(q))
}

export function builtCounts(items: BuiltItem[]): Record<BuiltFilter, number> {
  return {
    all: items.length,
    favorites: items.filter((i) => i.favorite).length,
    online: items.filter((i) => i.kind === 'online').length,
    file: items.filter((i) => i.kind === 'file').length,
    running: items.filter((i) => i.kind === 'running' || i.kind === 'stopped').length
  }
}

export const UNTAGGED = 'Other'

export function builtTagCounts(items: BuiltItem[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const item of items) for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
}

export function builtByTag(items: BuiltItem[]): Array<[string, BuiltItem[]]> {
  const order = builtTagCounts(items).map(([tag]) => tag)
  const groups = new Map<string, BuiltItem[]>()
  const sorted = [...items].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.lastSeen.localeCompare(a.lastSeen))
  for (const item of sorted) {
    const tag = order.find((t) => item.tags?.includes(t)) ?? UNTAGGED
    groups.set(tag, [...(groups.get(tag) ?? []), item])
  }
  return [...groups.entries()].sort(([a], [b]) => Number(a === UNTAGGED) - Number(b === UNTAGGED) || order.indexOf(a) - order.indexOf(b))
}

export function cleanTag(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, 24)
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

export type BuiltDay = string

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayIndex(iso: string, now: number): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000))
}

export function builtDay(iso: string, now = Date.now()): BuiltDay {
  const idx = dayIndex(iso, now)
  if (idx === 0) return 'Today'
  if (idx === 1) return 'Yesterday'
  const t = Date.parse(iso)
  return new Date(Number.isNaN(t) ? now : t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function builtByDay(items: BuiltItem[], now = Date.now()): Array<[BuiltDay, BuiltItem[]]> {
  const sorted = [...items].sort(
    (a, b) => Number(b.kind === 'running') - Number(a.kind === 'running') || b.lastSeen.localeCompare(a.lastSeen)
  )
  const groups = new Map<number, { label: BuiltDay; list: BuiltItem[] }>()
  for (const item of sorted) {
    const idx = dayIndex(item.lastSeen, now)
    const g = groups.get(idx) ?? { label: builtDay(item.lastSeen, now), list: [] }
    g.list.push(item)
    groups.set(idx, g)
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, g]): [BuiltDay, BuiltItem[]] => [g.label, g.list])
}

export function builtAge(iso: string, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000)
  if (!(min >= 1)) return 'just now'
  if (min < 60) return `${min}m ago`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ago`
  const days = Math.floor(min / (24 * 60))
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export type BuiltRunResult = 'stopped' | 'restarted' | 'started' | 'failed'
