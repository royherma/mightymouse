import { PRIORITY_COPY, priorityWeight, type PriorityLevel, type SessionPriorityRow } from './session-priority'
/**
 * How the Sessions tab is organised: which key the cards are grouped under,
 * which order they sit in, and which of them a filter chip lets through.
 *
 * Pure and side-effect free, in `shared/` for the same reason `relay-status.ts`
 * is: the sort a card claims ("2m") and the sort actually applied have to come
 * from one place, or a list can be ordered by something no card is showing.
 *
 * The organising principle, from the Sessions V2 PRD: a field repeated on every
 * card is not noise to delete, it is the key worth grouping and filtering BY.
 * Repo, agent, and state each stay on the card and each become a control here.
 */

import type { AgentRelaySessionInfo, MightyProject, SessionMarks } from './types'
import { sessionArchiveKey } from './session-archive'
import { senderMatchKey } from './relay-cards'
import type { SessionActivity } from './relay-cards'
import { sessionActiveAt, sessionRow } from './relay-status'
import type { SessionRow } from './relay-status'
import type { RelayRequestWire } from './phone-remote-protocol'

export const SESSION_GROUPS = ['folder', 'branch', 'agent', 'none'] as const
export type SessionGroup = (typeof SESSION_GROUPS)[number]

export const SESSION_SORTS = ['recent', 'waiting', 'age', 'name', 'priority'] as const
export type SessionSort = (typeof SESSION_SORTS)[number]

export const SESSION_DENSITIES = ['grid', 'board', 'list'] as const
export type SessionDensity = (typeof SESSION_DENSITIES)[number]

/** Chips are additive within the set: picking none means "everything", and
 *  picking two means either. `live` and `ended` are the two halves of the
 *  state word the card already prints; `waiting` is a sharper slice of `live`. */
export const SESSION_FILTERS = ['waiting', 'your-turn', 'working', 'live', 'ended'] as const
export type SessionFilter = (typeof SESSION_FILTERS)[number]

export const SESSION_GROUP_LABELS: Record<SessionGroup, string> = {
  folder: 'Folder',
  branch: 'Branch',
  agent: 'App',
  none: 'None'
}

export const SESSION_SORT_LABELS: Record<SessionSort, string> = {
  priority: 'Priority',
  recent: 'Latest first',
  waiting: 'Waiting first',
  age: 'Open longest',
  name: 'Name'
}

export const SESSION_FILTER_LABELS: Record<SessionFilter, string> = {
  waiting: 'Waiting on you',
  'your-turn': 'Handed back',
  working: 'Responding',
  live: 'Still open',
  ended: 'Ended'
}

/** Board columns, left to right. Waiting-on-you is split into the three
 *  blocking verbs; notify's two states fill Running / just-finished. */
export const BOARD_COLUMNS = [
  'approve',
  'ask',
  'show',
  'your-turn',
  'progress',
  'done',
  'live',
  'ended'
] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]

export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = {
  approve: 'Needs the OK',
  ask: 'Question',
  show: 'Look at this',
  'your-turn': 'Handed back',
  progress: 'Still working',
  done: 'All done',
  live: 'Open',
  ended: 'Ended'
}

/** A done notify older than this is "still open", not "just finished". */
export const BOARD_DONE_FRESH_MS = 30 * 60 * 1000

/** Above this many open sessions a grid of cards stops being scannable and the
 *  list wins. Only a default -- an explicit toggle always beats it. */
export const SESSION_LIST_THRESHOLD = 12

/** Cards whose group key is missing (no branch, an older shim that reports no
 *  app) collect here rather than vanishing, and it always sorts last. */
export const UNGROUPED = 'Everything else'

/** Ended sessions are their own group under every key: a dropped socket is not
 *  a peer of a live pane in the same folder, and burying one among eleven
 *  working agents is how a dead one gets answered. */
export const ENDED_GROUP = 'Ended'

export interface SessionEntry {
  priority?: SessionPriorityRow
  rank?: number
  rankOf?: number
  session: AgentRelaySessionInfo
  row: SessionRow
  activity: SessionActivity
}

export interface SessionGroupView {
  /** Stable identity for collapse state and for React's key. */
  key: string
  title: string
  entries: SessionEntry[]
  /** How many of this group's cards want an answer -- the header badge, and the
   *  reason a collapsed group can still say something is waiting inside it. */
  waiting: number
  ended: boolean
}

export interface BoardLane {
  key: string
  /** Empty when the column has one folder -- a heading over everything names
   *  nothing. */
  title: string
  entries: SessionEntry[]
}

export interface BoardColumnView {
  key: BoardColumn | `rank-${PriorityLevel | 'none'}`
  title: string
  entries: SessionEntry[]
  lanes: BoardLane[]
}

/** What a session is filed under. Empty string means "no value", which
 *  `groupSessions` turns into the UNGROUPED bucket. */
export function groupKeyFor(entry: SessionEntry, group: SessionGroup): string {
  if (group === 'none') return ''
  if (group === 'folder') return entry.row.repo?.trim() ?? ''
  if (group === 'branch') return entry.row.branch?.trim() ?? ''
  return entry.row.agent?.trim() ?? ''
}

/**
 * Sort WITHIN a group. Every option is something a card visibly states, so the
 * order can always be read back off the grid:
 *  - recent  -> the activity age the card prints
 *  - waiting -> the amber state line
 *  - age     -> `row.age`
 *  - name    -> the title
 *
 * `recent` falls back to the open time when an agent has sent nothing at all,
 * so a brand-new silent pane still lands above an hour-old silent one instead
 * of being shuffled by a tiebreak that means nothing.
 */
export function lastEventAt(e: SessionEntry): number {
  return Math.max(e.activity.lastAt ?? 0, sessionActiveAt(e.session))
}

export function sortEntries(entries: SessionEntry[], sort: SessionSort): SessionEntry[] {
  const byRecent = (a: SessionEntry, b: SessionEntry): number => lastEventAt(b) - lastEventAt(a)

  const sorted = [...entries]
  if (sort === 'priority') {
    const waitedSince = (e: SessionEntry): number =>
      e.session.handedBackAt ?? e.activity.lastAt ?? e.session.since ?? Infinity
    return sorted.sort(
      (a, b) =>
        priorityWeight(b.priority) - priorityWeight(a.priority) ||
        (b.priority?.heat ?? -1) - (a.priority?.heat ?? -1) ||
        waitedSince(a) - waitedSince(b)
    )
  }
  if (sort === 'name') {
    return sorted.sort((a, b) =>
      sessionTitle(a).localeCompare(sessionTitle(b), undefined, { sensitivity: 'base' })
    )
  }
  if (sort === 'age') {
    // Oldest first: `since` is when the pane opened, so the smaller number has
    // been running longer.
    return sorted.sort((a, b) => (a.session.since ?? Infinity) - (b.session.since ?? Infinity))
  }
  if (sort === 'waiting') {
    // Same order the card's health enum already claims: waiting (has a button)
    // > your-turn > responding > connected.
    const turn = (e: SessionEntry): number =>
      e.row.health === 'your-turn' ? 2 : e.row.health === 'working' ? 1 : 0
    return sorted.sort(
      (a, b) => b.activity.waiting - a.activity.waiting || turn(b) - turn(a) || byRecent(a, b)
    )
  }
  return sorted.sort(byRecent)
}

/** The card's headline, and the `name` sort's key. Mirrors what SessionCard
 *  renders so sorting by name cannot disagree with what is on screen. */
export function sessionTitle(entry: SessionEntry): string {
  return entry.row.name ?? entry.row.repo ?? ''
}

/** True when this session survives the chip selection. No chips means no
 *  filtering at all rather than nothing shown -- an empty toolbar must never be
 *  a hidden filter. */
export function passesFilters(entry: SessionEntry, filters: readonly SessionFilter[]): boolean {
  if (filters.length === 0) return true
  return filters.some((f) => {
    if (f === 'waiting') return entry.activity.waiting > 0 && entry.row.health !== 'ended'
    if (f === 'your-turn') return entry.row.health === 'your-turn'
    if (f === 'working') return entry.row.health === 'working'
    if (f === 'ended') return entry.row.health === 'ended'
    return entry.row.health !== 'ended'
  })
}

/** Has this session ever said anything? False for one that would render as its
 *  own name and nothing else -- the rows the phone list hides by default, which
 *  were 36 of 43 open sessions when this was measured (2026-09-10).
 *
 *  Deliberately NOT `activity.total === 0`. The resolved tail is capped at
 *  RELAY_RESOLVED_TAIL and measured full, so a long session's cards age out of
 *  the snapshot and it would read as silent after a day of real work. A
 *  declared `tldr` never expires, and a session waiting on you or handed back
 *  has spoken by definition, so any of those keeps the row once its cards fall
 *  off the end. */
const NO_ACTIVITY: SessionActivity = { total: 0, waiting: 0, medianReplyMs: null }

/** Drops silent rows nobody pinned or archived, and archived ones too unless `keepArchived`. */
export function sessionsWorthListing(
  sessions: AgentRelaySessionInfo[],
  marks: SessionMarks | undefined,
  keepArchived = false
): AgentRelaySessionInfo[] {
  const now = Date.now()
  return sessions.filter((session) => {
    const mark = marks?.[sessionArchiveKey(session)]
    if (mark?.archived) return keepArchived
    return mark?.pinned === true || sessionSpoke({ session, row: sessionRow(session, now), activity: NO_ACTIVITY })
  })
}

export function sessionSpoke(entry: SessionEntry): boolean {
  return (
    entry.activity.total > 0 ||
    entry.row.health === 'your-turn' ||
    entry.row.health === 'waiting' ||
    entry.row.health === 'working' ||
    Boolean(entry.row.name) ||
    Boolean(entry.row.tldr) ||
    Boolean(entry.activity.derivedSubject)
  )
}

/**
 * The whole pane in one call: filter, split ended off, group, sort inside each
 * group, then order the groups themselves.
 *
 * Group order is by what needs attention, not alphabetically: groups holding a
 * waiting card first, then by their most recent activity. A folder you are
 * actively being asked about should not sit below one that has been quiet for
 * an hour because its name starts with a Z.
 */
export function groupSessions(
  entries: SessionEntry[],
  group: SessionGroup,
  sort: SessionSort,
  filters: readonly SessionFilter[] = []
): SessionGroupView[] {
  const kept = entries.filter((e) => passesFilters(e, filters))

  const live = kept.filter((e) => e.row.health !== 'ended')
  const ended = kept.filter((e) => e.row.health === 'ended')

  const buckets = new Map<string, SessionEntry[]>()
  for (const entry of live) {
    const key = group === 'none' ? '' : groupKeyFor(entry, group) || UNGROUPED
    const list = buckets.get(key)
    if (list) list.push(entry)
    else buckets.set(key, [entry])
  }

  const views: SessionGroupView[] = [...buckets.entries()].map(([key, list]) => ({
    key: key || 'all',
    title: key,
    entries: sortEntries(list, sort),
    waiting: list.reduce((n, e) => n + e.activity.waiting, 0),
    ended: false
  }))

  const lastAt = (view: SessionGroupView): number =>
    view.entries.reduce((max, e) => Math.max(max, lastEventAt(e)), 0)

  views.sort((a, b) => {
    if (sort === 'priority') return Math.max(...b.entries.map((e) => priorityWeight(e.priority))) - Math.max(...a.entries.map((e) => priorityWeight(e.priority)))
    // The catch-all sits under the named groups whatever its activity: it is a
    // remainder, not a place.
    if (a.title === UNGROUPED !== (b.title === UNGROUPED)) return a.title === UNGROUPED ? 1 : -1
    if ((b.waiting > 0 ? 1 : 0) !== (a.waiting > 0 ? 1 : 0)) return b.waiting - a.waiting
    return lastAt(b) - lastAt(a)
  })

  if (ended.length > 0) {
    views.push({
      key: ENDED_GROUP,
      title: ENDED_GROUP,
      entries: sortEntries(ended, sort),
      waiting: 0,
      ended: true
    })
  }

  return views
}

/** Build the entry a grouping acts on. Kept here so a caller cannot pair a row
 *  with another session's activity. */
export function sessionEntry(
  session: AgentRelaySessionInfo,
  activity: SessionActivity,
  now: number
): SessionEntry {
  return { session, row: sessionRow(session, now), activity }
}

function senderKey(session: AgentRelaySessionInfo): string {
  return session.stated ?? session.label
}

function latestRequest(
  mine: readonly RelayRequestWire[]
): RelayRequestWire | undefined {
  let latest: RelayRequestWire | undefined
  for (const request of mine) {
    if (!latest || request.createdAt > latest.createdAt) latest = request
  }
  return latest
}

/** Which board column this session belongs in. First match wins; ended
 *  outranks a pending card -- a dropped socket is not waiting. */
export function sessionBoardColumn(
  entry: SessionEntry,
  requests: readonly RelayRequestWire[],
  now: number
): BoardColumn {
  if (entry.row.health === 'ended') return 'ended'

  const from = senderKey(entry.session)
  const mine = requests.filter((r) => senderMatchKey(r.params.from) === senderMatchKey(from))
  const pending = mine.filter((r) => r.status === 'pending')
  if (pending.some((r) => r.verb === 'approve')) return 'approve'
  if (pending.some((r) => r.verb === 'ask')) return 'ask'
  if (pending.some((r) => r.verb === 'show')) return 'show'

  // From main's idleSince (already seen-filtered by the surface), not from the
  // request list — the capped resolved tail can drop the idle ping.
  if (entry.row.health === 'your-turn') return 'your-turn'

  const latest = latestRequest(mine)
  if (latest?.verb === 'notify') {
    const state = latest.params.state ?? 'done'
    if (state === 'progress') return 'progress'
    if (now - latest.createdAt < BOARD_DONE_FRESH_MS) return 'done'
  }
  return 'live'
}

/** Folder/branch/agent headers inside one column. A single bucket is unheaded
 *  -- the column already named the status. */
export function groupsInsideColumn(
  entries: SessionEntry[],
  group: SessionGroup,
  sort: SessionSort
): BoardLane[] {
  const sorted = sortEntries(entries, sort)
  if (group === 'none' || sorted.length === 0) {
    return [{ key: 'all', title: '', entries: sorted }]
  }

  const buckets = new Map<string, SessionEntry[]>()
  for (const entry of sorted) {
    const key = groupKeyFor(entry, group) || UNGROUPED
    const list = buckets.get(key)
    if (list) list.push(entry)
    else buckets.set(key, [entry])
  }

  if (buckets.size <= 1) {
    return [{ key: 'all', title: '', entries: sorted }]
  }

  return [...buckets.entries()].map(([key, list]) => ({
    key,
    title: key,
    entries: sortEntries(list, sort)
  }))
}

/** Always seven columns, empty ones included. `requests` is pending+resolved
 *  (notify included) -- Previous drops notify. */
export function boardColumns(
  entries: SessionEntry[],
  requests: readonly RelayRequestWire[],
  now: number,
  sort: SessionSort,
  group: SessionGroup = 'none'
): BoardColumnView[] {
  const buckets = new Map<BoardColumn, SessionEntry[]>()
  for (const column of BOARD_COLUMNS) buckets.set(column, [])
  for (const entry of entries) {
    buckets.get(sessionBoardColumn(entry, requests, now))!.push(entry)
  }

  return BOARD_COLUMNS.map((key) => {
    const list = buckets.get(key) ?? []
    const sorted = sortEntries(list, sort)
    return {
      key,
      title: BOARD_COLUMN_LABELS[key],
      entries: sorted,
      lanes: groupsInsideColumn(sorted, group, sort)
    }
  })
}

export function rankColumns(
  entries: SessionEntry[],
  group: SessionGroup = 'none',
  sort: SessionSort = 'priority'
): BoardColumnView[] {
  return ([4, 3, 2, 1, 0, null] as const).map((level) => {
    const list = entries.filter((entry) => (entry.priority?.level ?? null) === level)
    return {
      key: `rank-${level ?? 'none'}`,
      title: level === null ? PRIORITY_COPY.unknown : PRIORITY_COPY.labels[level],
      entries: list,
      lanes: groupsInsideColumn(list, group, sort)
    }
  })
}

/** A session belongs to a project when it runs inside that project's folder — a
 *  worktree under it counts, which is how one repo's agents stay together. */
export function mightyProjectForCwd(
  cwd: string | undefined,
  projects: MightyProject[]
): MightyProject | null {
  if (cwd === undefined || cwd === '') return null
  let best: MightyProject | null = null
  for (const p of projects) {
    if (p.repoFolder === undefined) continue
    if (cwd !== p.repoFolder && !cwd.startsWith(`${p.repoFolder}/`)) continue
    if (best?.repoFolder === undefined || p.repoFolder.length > best.repoFolder.length) best = p
  }
  return best
}
