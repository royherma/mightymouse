/**
 * How each Code surface is currently sorted and filtered, kept in the surface's
 * own localStorage.
 *
 * Deliberately NOT a Mac-side PREF pushed over the wire: this is a view choice,
 * not a setting. The phone and the Mac are two different reading positions --
 * filtering the phone down to approvals while walking around must not silently
 * hide questions from whoever is at the keyboard.
 */

import { RELAY_SORTS, RELAY_FILTERS } from './relay-cards'
import type { RelaySort, RelayFilter } from './relay-cards'
import { SESSION_GROUPS, SESSION_SORTS, SESSION_DENSITIES } from './relay-sessions'
import type { SessionGroup, SessionSort, SessionDensity } from './relay-sessions'

const SORT_KEY = 'mm.relay.sort.v1'
const FILTER_KEY = 'mm.relay.filter.v1'
const SESSION_GROUP_KEY = 'mm.relay.sessions.group.v1'
const SESSION_SORT_KEY = 'mm.relay.sessions.sort.v1'
const SESSION_DENSITY_KEY = 'mm.relay.sessions.density.v1'
const SESSION_BOARD_COMPACT_KEY = 'mm.relay.sessions.boardCompact.v1'
const SESSION_COLLAPSED_KEY = 'mm.relay.sessions.collapsed.v1'
const SESSION_PROJECT_KEY = 'mm.relay.sessions.project.v1'
const PLACE_KEY = 'mm.relay.place.v1'

export const DEFAULT_SORT: RelaySort = 'priority'
export const DEFAULT_FILTER: RelayFilter = 'all'

/** Same shape as relay-drafts: Safari in private mode throws on ACCESS, not on
 *  write, so the whole thing has to sit behind a try. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Validated against the live union rather than cast. A stale value from an
 *  older build must fall back to the default, never render a control with no
 *  matching option and no way to get out of it. */
export function readSort(): RelaySort {
  const raw = storage()?.getItem(SORT_KEY)
  return RELAY_SORTS.includes(raw as RelaySort) ? (raw as RelaySort) : DEFAULT_SORT
}

export function readFilter(): RelayFilter {
  const raw = storage()?.getItem(FILTER_KEY)
  return RELAY_FILTERS.includes(raw as RelayFilter) ? (raw as RelayFilter) : DEFAULT_FILTER
}

export function writeSort(sort: RelaySort): void {
  try {
    storage()?.setItem(SORT_KEY, sort)
  } catch {
    // Quota or private mode. The choice still applies this session.
  }
}

export function writeFilter(filter: RelayFilter): void {
  try {
    storage()?.setItem(FILTER_KEY, filter)
  } catch {
    // As above.
  }
}

/* ---- Sessions tab ---------------------------------------------------------
   Its own keys, not the card keys above: the two panes answer different
   questions ("which agent is this?" vs "what do I owe an answer to"), and
   sharing a sort would silently re-order one when you changed the other. */

export function readSessionProject(): string {
  return storage()?.getItem(SESSION_PROJECT_KEY) ?? ''
}

export function writeSessionProject(project: string): void {
  try {
    storage()?.setItem(SESSION_PROJECT_KEY, project)
  } catch {
    // Quota or private mode. The choice still applies this session.
  }
}

export function readSessionGroup(): SessionGroup {
  const raw = storage()?.getItem(SESSION_GROUP_KEY)
  return SESSION_GROUPS.includes(raw as SessionGroup) ? (raw as SessionGroup) : 'folder'
}

export function writeSessionGroup(group: SessionGroup): void {
  try {
    storage()?.setItem(SESSION_GROUP_KEY, group)
  } catch {
    // Quota or private mode. The choice still applies this session.
  }
}

export function readSessionSort(): SessionSort {
  const raw = storage()?.getItem(SESSION_SORT_KEY)
  return SESSION_SORTS.includes(raw as SessionSort) ? (raw as SessionSort) : 'recent'
}

export function writeSessionSort(sort: SessionSort): void {
  try {
    storage()?.setItem(SESSION_SORT_KEY, sort)
  } catch {
    // As above.
  }
}

/** Null means "never chosen", which is what lets the grid auto-pick list at a
 *  size where a grid stops helping. A stored value is an explicit choice and
 *  always wins over that. */
export function readSessionDensity(): SessionDensity | null {
  const raw = storage()?.getItem(SESSION_DENSITY_KEY)
  return SESSION_DENSITIES.includes(raw as SessionDensity) ? (raw as SessionDensity) : null
}

export function writeSessionDensity(density: SessionDensity): void {
  try {
    storage()?.setItem(SESSION_DENSITY_KEY, density)
  } catch {
    // As above.
  }
}

/** Packed one-liners on the board. Default on: a fat Open column is the usual
 *  case, and full cards there are what you scroll past to count them. */
export function readBoardCompact(): boolean {
  return storage()?.getItem(SESSION_BOARD_COMPACT_KEY) !== '0'
}

export function writeBoardCompact(on: boolean): void {
  try {
    storage()?.setItem(SESSION_BOARD_COMPACT_KEY, on ? '1' : '0')
  } catch {
    // As above.
  }
}

/** Which group headers are collapsed, by their key. Stored as a list because a
 *  group only exists while an agent is open in it -- a map of every folder ever
 *  seen would grow without bound and never be read again. */
export function readCollapsedGroups(): string[] {
  const raw = storage()?.getItem(SESSION_COLLAPSED_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    // Hand-edited or written by an older build. An unreadable list means
    // "nothing collapsed", never a crash on a pane that has to render.
    return []
  }
}

export function writeCollapsedGroups(keys: string[]): void {
  try {
    storage()?.setItem(SESSION_COLLAPSED_KEY, JSON.stringify(keys))
  } catch {
    // As above.
  }
}

/* ---- Last place -----------------------------------------------------------
   Where the user was when the sheet closed, so reopening lands there instead
   of back on Needs you. Ids and labels are stored raw and re-resolved against
   the live lists on restore -- a card answered elsewhere or an agent that quit
   while the sheet was shut resolves to nothing and falls back to its list. */

export const RELAY_TABS = ['needs', 'previous', 'sessions'] as const
export type RelayTab = (typeof RELAY_TABS)[number]

export type RelayPlace = {
  tab: RelayTab
  /** Card open full-screen on `needs`/`previous`. */
  detailId?: string
  /** Agent sheet open on `sessions`. */
  sessionLabel?: string
}

export const DEFAULT_PLACE: RelayPlace = { tab: 'needs' }

export function readPlace(): RelayPlace {
  const raw = storage()?.getItem(PLACE_KEY)
  if (!raw) return DEFAULT_PLACE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PLACE
    const { tab, detailId, sessionLabel } = parsed as Record<string, unknown>
    if (!RELAY_TABS.includes(tab as RelayTab)) return DEFAULT_PLACE
    return {
      tab: tab as RelayTab,
      detailId: typeof detailId === 'string' ? detailId : undefined,
      sessionLabel: typeof sessionLabel === 'string' ? sessionLabel : undefined
    }
  } catch {
    // Hand-edited or written by an older build.
    return DEFAULT_PLACE
  }
}

export function writePlace(place: RelayPlace): void {
  try {
    storage()?.setItem(PLACE_KEY, JSON.stringify(place))
  } catch {
    // As above.
  }
}
