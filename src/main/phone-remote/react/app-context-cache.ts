// app-context-cache.ts — the app chip, remembered across page loads.
//
// `appContext` only ever arrives over the socket, so a fresh load renders no
// bar at all until the Mac answers. AppContextBar's `lastGoodRef` already
// covers the WITHIN-session gap (a null poll landing mid-tap); this covers the
// cold one — closing the keyboard and reopening it, or Safari discarding the
// tab in the background and reloading it, both start from a null context and
// flash an empty bar for the round trip.
//
// Only the CHIP is cached: app name, bundle id, icon. The dropdowns are not,
// deliberately — a stale tab list is a list you can TAP, and tapping a tab that
// closed five minutes ago activates the wrong thing (or nothing). The chip is
// inert, so the worst a stale one does is name the app you were last in for the
// ~100ms until the live answer lands. That asymmetry is the whole rule here:
// cache what you can only look at, never what you can act on.
//
// Phone-local (localStorage), same reasoning as keyboard-dock-pref.ts: which
// Mac app this phone was last typing into is a property of the phone in your
// hand, not state worth round-tripping.

import type { AppContext } from '@shared/app-context'
import { EMPTY_READING } from '@shared/app-context'

const APP_CONTEXT_CACHE_KEY = 'mm-remote-app-chip'

/**
 * How stale a remembered chip may be before it is worse than nothing.
 *
 * Long enough to cover the case this exists for (close the keyboard, reopen it
 * seconds later), short enough that yesterday's session does not open naming an
 * app you have since quit. A wrong chip that corrects itself in 100ms is a
 * non-event; one that greets you at the start of a new day is a lie.
 */
const CACHE_TTL_MS = 30 * 60 * 1000

/** Guard against a huge icon filling the origin's storage quota. App icons run
 *  ~4-8KB as base64; anything past this is not one, so drop it and keep the
 *  name — a chip with a blank icon still answers "what am I typing into?". */
const MAX_ICON_BASE64 = 32 * 1024

interface CachedChip {
  appName: string
  bundleId: string
  appIconPngBase64: string
  /** When it was written, for the TTL. */
  at: number
}

function isCachedChip(v: unknown): v is CachedChip {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.appName === 'string' &&
    c.appName !== '' &&
    typeof c.bundleId === 'string' &&
    typeof c.appIconPngBase64 === 'string' &&
    typeof c.at === 'number'
  )
}

/**
 * The remembered chip as a drawable context, or null if there is nothing fresh.
 *
 * Rehydrates with EMPTY_READING, so the bar draws the chip and NO dropdowns —
 * which is exactly the `adapterId: null` shape it already knows how to render.
 * The first live push replaces the whole thing, dropdowns included.
 */
export function readCachedAppContext(now: number): AppContext | null {
  try {
    const raw = localStorage.getItem(APP_CONTEXT_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isCachedChip(parsed)) return null
    // A clock that moved backwards (timezone change, NTP correction) would make
    // `now - at` negative and pass a naive `< TTL` check forever. Compare the
    // magnitude so a nonsense age fails closed.
    if (Math.abs(now - parsed.at) > CACHE_TTL_MS) return null
    return {
      ...EMPTY_READING,
      adapterId: null,
      appName: parsed.appName,
      bundleId: parsed.bundleId,
      appIconPngBase64: parsed.appIconPngBase64
    }
  } catch {
    // Unparseable, or storage disabled (private mode). No chip is the same
    // behavior as before this file existed, which is a fine floor.
    return null
  }
}

/** Remember the chip from a live context. A context with no readable app name
 *  is NOT written: null means "the Mac could not read it this poll", never "no
 *  app", and persisting that would erase a perfectly good chip. */
export function writeCachedAppContext(context: AppContext, now: number): void {
  if (!context.appName) return
  try {
    const chip: CachedChip = {
      appName: context.appName,
      bundleId: context.bundleId,
      appIconPngBase64:
        context.appIconPngBase64.length > MAX_ICON_BASE64 ? '' : context.appIconPngBase64,
      at: now
    }
    localStorage.setItem(APP_CONTEXT_CACHE_KEY, JSON.stringify(chip))
  } catch {
    // Quota exceeded or storage disabled — the in-memory context is unaffected,
    // so this session behaves exactly as it did before.
  }
}

const APP_LIST_CACHE_KEY = 'mm-remote-app-ring'

type CachedApp = { name: string; bundleId: string; iconPngBase64: string }

export function readCachedAppList(): CachedApp[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(APP_LIST_CACHE_KEY) ?? 'null')
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const ok = parsed.every(
      (a) =>
        typeof a?.name === 'string' &&
        typeof a?.bundleId === 'string' &&
        typeof a?.iconPngBase64 === 'string'
    )
    return ok ? (parsed as CachedApp[]) : null
  } catch {
    return null
  }
}

export function writeCachedAppList(apps: CachedApp[], maxSlots: number): void {
  try {
    const kept = apps
      .slice(0, maxSlots)
      .map((a) => ({ ...a, iconPngBase64: a.iconPngBase64.length > MAX_ICON_BASE64 ? '' : a.iconPngBase64 }))
    localStorage.setItem(APP_LIST_CACHE_KEY, JSON.stringify(kept))
  } catch {
    return
  }
}
