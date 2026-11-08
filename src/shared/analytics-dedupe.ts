// Burst coalescing for analytics events — the structural guard against
// re-render storms, shared by the desktop app and the portal.
//
// WHY THIS EXISTS
// Measured against the whole prod events table (1845 rows, every user to date):
// 19.8% of every event ever recorded was an exact duplicate — same name AND same
// props — of the event before it, fired within 5 seconds. One polled React effect
// logged a single onboarding step 94 times; one Supabase auth listener logged a
// single sign-in 13 times. At that cadence it is always a re-render, a polled
// dependency, or a double-bound handler. Never a person.
//
// Fixing the three known call sites left 168 others able to reintroduce it, so the
// guard lives at the emit chokepoint instead: every event in both surfaces flows
// through one `track()`, and a new call site inherits the protection for free.
//
// WHY THE WINDOW IS SHORT
// The same event names ALSO repeat legitimately at long gaps — 165 sign-in and 15
// onboarding-step repeats in that same table sat more than 60s apart, which are
// real revisits. A window wide enough to catch those would delete real behavior.
// So the rule is "identical within a blink", not "identical". 5s comfortably
// covers a 3s poll (the observed storm cadence) while leaving genuine repeats
// untouched: the two populations are three orders of magnitude apart, so this
// threshold is not finely balanced.
//
// WHY IT IS KEYED, NOT A SINGLE SLOT
// Remembering only the previous event fails on interleaved storms: two effects
// polling A,B,A,B each see the *other* as "last", so neither ever matches and
// nothing is suppressed. The tracker keys by event+props and evicts by age.

/** Identical event+props inside this window is treated as one emission. */
export const DEDUPE_WINDOW_MS = 5_000

/** Cap on tracked keys, so a high-cardinality props field (a timestamp, a cursor
 *  position) can't grow this map without bound in a long-running main process.
 *  Well above the ~40-name event taxonomy; eviction is oldest-first by last-seen. */
const MAX_KEYS = 256

export interface DedupeTracker {
  /** True if this exact event+props already fired inside the window. Calling this
   *  RECORDS the event, so it is not a pure predicate — call it once per emit. */
  isDuplicate(event: string, props?: Record<string, unknown>): boolean
}

/** Stable key for an event and its props. Props are included because consecutive
 *  steps of one wizard share a name and differ only in props — those are real,
 *  distinct views. Key order is normalized so `{a,b}` and `{b,a}` collapse. */
function dedupeKey(event: string, props: Record<string, unknown>): string {
  const keys = Object.keys(props).sort()
  if (keys.length === 0) return event
  // Hand-rolled rather than JSON.stringify(props) because that is key-ORDER
  // sensitive: the same logical event built by two code paths would hash
  // differently and slip past the guard.
  let out = event
  for (const k of keys) out += `${k}${JSON.stringify(props[k])}`
  return out
}

/**
 * Create an independent burst tracker. One per surface (the desktop main process
 * and the portal bundle each own one); instances share no state, which is what
 * makes this unit-testable without touching module globals.
 *
 * @param now Clock injection point — tests drive it instead of sleeping.
 */
export function createDedupeTracker(now: () => number = Date.now): DedupeTracker {
  const lastSeen = new Map<string, number>()

  return {
    isDuplicate(event: string, props: Record<string, unknown> = {}): boolean {
      const key = dedupeKey(event, props)
      const t = now()
      const prev = lastSeen.get(key)

      // A suppressed event deliberately does NOT refresh the timestamp. Otherwise a
      // 3s poll would keep pushing the deadline forward and the event would be
      // silenced forever; instead the storm still reports once per window, which
      // preserves "this screen was on for 10 minutes" as a countable signal.
      if (prev !== undefined && t - prev < DEDUPE_WINDOW_MS) return true

      lastSeen.set(key, t)

      // Drop keys that can no longer suppress anything, then bound the map.
      if (lastSeen.size > MAX_KEYS) {
        for (const [k, seen] of lastSeen) {
          if (t - seen >= DEDUPE_WINDOW_MS) lastSeen.delete(k)
        }
        while (lastSeen.size > MAX_KEYS) {
          // Map preserves insertion order and every entry here is within the
          // window, so the first key is the least recently added.
          const oldest = lastSeen.keys().next()
          if (oldest.done) break
          lastSeen.delete(oldest.value)
        }
      }
      return false
    }
  }
}
