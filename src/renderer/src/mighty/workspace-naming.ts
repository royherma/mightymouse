// Pure tab-auto-naming algorithm. Renders one of three schemes (ChatTabNameFormat):
// "Jul 24 · 2" (pretty, default) / "Jul 24 (2)" (compact) / "jul-24-s-b" (slug), each
// numbered sequentially per calendar day and restarting each new day. No React, no
// IPC — takes the existing tabs list, the chosen format and "now" as plain args so
// it's unit-testable in isolation, and lives in the renderer (not main) since
// PREFS/IPC access happens one layer up in ChatWorkspacesTab, not inside here.
import { CONFIG } from '../../../shared/config'
import type { ChatTabNameFormat, ChatWorkspaceTab } from '../../../shared/types'

const MONTH_ABBREVS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

/** Literal tab-name separator segment for the 'slug' format. Named so 'jul-18-s-b' is
 *  never hand-typed twice (once to generate, once to parse back out) with a risk of
 *  the two drifting. */
const SESSION_MARKER = 's'

/**
 * The day part of a tab name, in the LOCAL system timezone — this is a user-facing
 * label meant to match their wall-clock day, unlike most persisted timestamps in this
 * codebase (UTC ISO) which are storage-facing, not display-facing.
 *
 * 'pretty'/'compact' render "Jul 24" (no zero-pad: a padded "Jul 04" reads like a
 * serial number, and the tab strip is narrow enough that one char matters); 'slug'
 * keeps the original zero-padded lowercase "jul-24" so slug names still sort as text.
 */
export function dayKeyFor(now: Date, format: ChatTabNameFormat): string {
  const mon = MONTH_ABBREVS[now.getMonth()]
  const day = now.getDate()
  if (format === 'slug') return `${mon.toLowerCase()}-${String(day).padStart(2, '0')}`
  return `${mon} ${day}`
}

/** Base-26 letter sequence: 0->a, 1->b, ... 25->z, 26->aa, 27->ab, ... Never reuses
 *  'a' once a day's count exceeds 25 — genuinely unlikely at 6-panes-per-tab usage,
 *  but wrapping correctly costs nothing and avoids a silent collision if it happens. */
export function letterForIndex(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Renders one tab name from its day part and its 0-based index within that day.
 * Exported for tests — callers want nextWorkspaceName, which derives the index.
 */
export function formatTabName(dayKey: string, index: number, format: ChatTabNameFormat): string {
  switch (format) {
    case 'slug':
      return `${dayKey}-${SESSION_MARKER}-${letterForIndex(index)}`
    // The day's FIRST tab is just the date in 'compact' — a lone "(1)" is noise when
    // there's nothing to disambiguate it from. 'pretty' always shows the number so
    // every tab in the strip has the same shape and the count is readable at a glance.
    case 'compact':
      return index === 0 ? dayKey : `${dayKey} (${index + 1})`
    case 'pretty':
      return `${dayKey} ${CONFIG.MIGHTY.TAB_NAME_SEPARATOR} ${index + 1}`
  }
}

/**
 * The lowest index whose rendered name isn't already on screen. Probing actual names
 * rather than counting tabs is what makes this collision-proof: tabs are renameable,
 * so a count would hand out a number a surviving tab still holds (rename "Jul 24 · 1"
 * and a plain count of 1 yields "Jul 24 · 2" — which already exists).
 *
 * Checks EVERY format's rendering, not just the active one, since the setting is
 * switchable and a day can hold a mix of "Jul 24 · 1" and "jul-24-s-a".
 */
function firstFreeIndex(existingTabs: ChatWorkspaceTab[], now: Date): number {
  const taken = new Set(existingTabs.map((t) => t.name))
  const collides = (i: number): boolean =>
    CONFIG.MIGHTY.TAB_NAME_FORMATS.some((f) => taken.has(formatTabName(dayKeyFor(now, f), i, f)))
  let i = 0
  while (collides(i)) i++
  return i
}

export function nextWorkspaceName(
  existingTabs: ChatWorkspaceTab[],
  format: ChatTabNameFormat = CONFIG.MIGHTY.DEFAULT_TAB_NAME_FORMAT,
  now: Date = new Date()
): string {
  return formatTabName(dayKeyFor(now, format), firstFreeIndex(existingTabs, now), format)
}
