// referral-cache.ts — the invite link, code, and joined count, remembered
// across page loads.
//
// The referral payload only ever arrives over the socket, and only once the
// sheet is opened: the Mac has to hit an Edge Function, so opening the sheet
// spends a network round trip staring at "Loading your invite link…" every
// single time. Nothing about that link changes between openings — it is the
// same code for the life of the account — which makes it the clearest possible
// case for showing the remembered copy instantly and refreshing behind it.
//
// Everything cached here is INERT: a link you scan or copy, a code you read, a
// count you look at. Same rule as app-context-cache.ts — cache what you can only
// look at, never what you can act on. The one live thing on this sheet, the
// email invite, is not cached and still round-trips every send.
//
// A stale link is a non-issue in a way a stale app chip is not: referral codes
// are stable, so the refresh almost always confirms what was already drawn. The
// TTL exists for the account that genuinely changed underneath it (signed out
// on the Mac, switched users), not because the link rots.
//
// Phone-local (localStorage), same reasoning as keyboard-dock-pref.ts: which
// account this phone last paired with is a property of the phone in your hand.

const REFERRAL_CACHE_KEY = 'mm-remote-referral'

/**
 * How stale a remembered link may be before it is worse than nothing.
 *
 * Seven days. Long enough that the sheet is effectively always instant for
 * someone who shares more than once a week, short enough that a phone paired to
 * an account months ago does not open showing a code that account no longer
 * owns. The revalidate-on-open below means a wrong link is corrected within one
 * round trip anyway; this bound only covers the case where the refresh FAILS.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A link long past any plausible share URL is not one -- refuse to render it
 *  rather than hand a garbage string to the QR encoder, which would draw an
 *  unscannably dense code. */
const MAX_LINK_LENGTH = 512

export interface CachedReferral {
  link: string
  code: string
  referredCount: number
  /** When it was written, for the TTL. */
  at: number
}

function isCachedReferral(v: unknown): v is CachedReferral {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.link === 'string' &&
    c.link !== '' &&
    c.link.length <= MAX_LINK_LENGTH &&
    typeof c.code === 'string' &&
    typeof c.referredCount === 'number' &&
    Number.isFinite(c.referredCount) &&
    typeof c.at === 'number'
  )
}

/**
 * The remembered referral payload, or null if there is nothing fresh to draw.
 *
 * Null is the pre-cache behavior exactly: the sheet shows its loading line until
 * the Mac answers. So every failure path here — no entry, expired, malformed,
 * storage disabled — degrades to what this file was written to improve, never
 * to something worse.
 */
export function readCachedReferral(now: number): CachedReferral | null {
  try {
    const raw = localStorage.getItem(REFERRAL_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isCachedReferral(parsed)) return null
    // A clock that moved backwards (timezone change, NTP correction) would make
    // `now - at` negative and pass a naive `< TTL` check forever. Compare the
    // magnitude so a nonsense age fails closed.
    if (Math.abs(now - parsed.at) > CACHE_TTL_MS) return null
    return parsed
  } catch {
    // Unparseable, or storage disabled (private mode). No cache is the same
    // behavior as before this file existed, which is a fine floor.
    return null
  }
}

/** Remember a freshly-fetched payload. A response with no link is NOT written:
 *  that means the Mac could not answer this time (signed out, fetch failed), and
 *  persisting it would erase a perfectly good link over a transient failure. */
export function writeCachedReferral(
  value: { link?: string; code?: string; referredCount?: number },
  now: number
): void {
  if (!value.link) return
  try {
    const entry: CachedReferral = {
      link: value.link,
      code: value.code ?? '',
      referredCount: value.referredCount ?? 0,
      at: now
    }
    localStorage.setItem(REFERRAL_CACHE_KEY, JSON.stringify(entry))
  } catch {
    // Quota exceeded or storage disabled — the in-memory state is unaffected,
    // so this session behaves exactly as it did before.
  }
}

/** Forget the remembered payload. Called when the Mac answers 'signed_out': the
 *  link belonged to an account this phone can no longer prove it is on, so
 *  keeping it would show the next person to open the sheet someone else's code. */
export function clearCachedReferral(): void {
  try {
    localStorage.removeItem(REFERRAL_CACHE_KEY)
  } catch {
    // Storage disabled — there was nothing cached to clear either.
  }
}
