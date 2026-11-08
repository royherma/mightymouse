// swipe-arming-store.ts — which action this phone armed last time, per card shape.
//
// Phone-local, same reasoning as app-context-cache.ts: which option the user tends to
// pick is a property of the person holding the phone, not Mac state, and it must
// never round-trip over the wire.
//
// Last choice wins, not a tally. A count needs a decay rule and a tie rule, and
// getting either wrong silently arms the wrong action on a card whose swipe is
// the confirm. Most-recent is explainable and self-corrects in one swipe.

const ARMING_KEY = 'mm-remote-swipe-arming'

/** Enough to cover the shapes one person actually meets -- a handful of ask
 *  option sets and the canned idle set. Past it the oldest entries go, because
 *  an unbounded map of every question ever asked is a storage leak that buys
 *  nothing: a shape you have not seen in months is one you will not recognize. */
const MAX_ENTRIES = 60

type ArmingMap = Record<string, string>

function read(): ArmingMap {
  try {
    const raw = localStorage.getItem(ARMING_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: ArmingMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    // A corrupt or quota-blocked store is a missing preference, never an error:
    // the card still opens armed with its first action.
    return {}
  }
}

/** What was armed last time for this card shape, if anything. */
export function recallArming(key: string | undefined): string | undefined {
  if (!key) return undefined
  return read()[key]
}

/** Record what an affirm actually sent. Insertion order carries recency, which
 *  is what the trim reads -- so a re-picked shape is deleted before it is set. */
export function rememberArming(key: string | undefined, value: string | undefined): void {
  if (!key || !value) return
  try {
    const map = read()
    delete map[key]
    map[key] = value
    const keys = Object.keys(map)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
      delete map[stale]
    }
    localStorage.setItem(ARMING_KEY, JSON.stringify(map))
  } catch {
    // Storage full or blocked. The deck works without a memory.
  }
}
