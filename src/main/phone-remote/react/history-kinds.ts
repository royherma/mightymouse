import { KIND_HUES, isRunKind } from '@shared/mode'
import type { RunKind } from '@shared/types'

/** Kinds, labels and hues all derive from @shared/mode.ts's KIND_HUES — ONE
 *  declaration the Mac renderer and this bundle both read, so a kind can never
 *  show up as two different colors (or go missing from the filter) on one
 *  surface but not the other. The old local copies of all three drifted apart by
 *  construction; renderer/mode-colors.ts is still off-limits to import here (it
 *  resolves through the Electron window), but the MAPPING it used now lives in
 *  shared, which this bundle is allowed to reach.
 *
 *  Hue names resolve on the phone because injectTheme() turns every
 *  CONFIG.THEME_TOKENS key into a CSS var, so `rose` reaches the stylesheet as
 *  --rose / --rose-bg-subtle exactly as it does in the Electron window. */
export { KIND_HUES, kindHue } from '@shared/mode'

export const HISTORY_KINDS = Object.keys(KIND_HUES) as readonly RunKind[]

export type HistoryKind = RunKind

/** Title-case for display. Derived rather than listed: every kind is one word,
 *  so a table would be seven more strings to keep in sync for no added meaning. */
export function titleCase(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

const isKnownKind = isRunKind

/**
 * Which kinds to offer, given what's actually on screen. A phone sheet has room
 * for a handful of rows, so listing all 7 when the user has only ever dictated
 * would be six dead toggles -- and an unknown kind off the wire still gets an
 * entry rather than becoming unfilterable.
 */
export function availableKinds(entries: ReadonlyArray<{ kind: string }>): string[] {
  const seen = new Set(entries.map((e) => e.kind))
  const known = HISTORY_KINDS.filter((k) => seen.has(k)) as string[]
  const unknown = [...seen].filter((k) => !isKnownKind(k)).sort()
  return [...known, ...unknown]
}

export function kindLabel(kind: string): string {
  return isKnownKind(kind) ? titleCase(kind) : kind
}

/**
 * `hidden` is the set of DESELECTED kinds, so the default (empty) shows
 * everything and a kind arriving on a later page is visible without having to
 * be pre-registered -- the inverse (a set of selected kinds) silently hides
 * anything new, which is the bug this shape avoids.
 */
export function filterEntries<T extends { kind: string }>(
  entries: readonly T[],
  hidden: ReadonlySet<string>
): T[] {
  if (hidden.size === 0) return entries as T[]
  return entries.filter((e) => !hidden.has(e.kind))
}

// Phone-local, same reasoning as keyboard-dock-pref.ts: which kinds YOU want to
// see is a property of the phone in your hand, not config worth round-tripping
// to the Mac (whose own history filter is a separate, durable pref).
const HISTORY_FILTER_KEY = 'mm-remote-history-hidden'

export function getHiddenKinds(): Set<string> {
  try {
    const raw = localStorage.getItem(HISTORY_FILTER_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    // Anything but an array of strings is a corrupt/old value -- show everything
    // rather than let it hide rows the user can't explain.
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((k): k is string => typeof k === 'string'))
  } catch {
    return new Set()
  }
}

export function setHiddenKinds(hidden: ReadonlySet<string>): void {
  try {
    if (hidden.size === 0) localStorage.removeItem(HISTORY_FILTER_KEY)
    else localStorage.setItem(HISTORY_FILTER_KEY, JSON.stringify([...hidden]))
  } catch {
    // Private mode / storage disabled -- the in-memory filter still applies
    // for this session, which is the best available behavior.
  }
}
