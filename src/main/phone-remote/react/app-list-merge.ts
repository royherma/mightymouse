// app-list-merge.ts — decide whether an incoming app list may be shown NOW or
// has to wait for the ring to go idle.
//
// The ring reorders by MRU, so applying every list the instant it arrives moves
// slots under a finger that is mid-gesture -- that is what the idle debounce in
// App.tsx exists to stop. But holding EVERY change for that window also hides an
// app the user just launched, for 15s+ (the timer is pushed back by each new ring
// touch, so during an active run it can never land). A new app and a reshuffle
// were being treated as the same event; they are not.
//
// The split: a change to the SET of apps is applied immediately; a change to the
// ORDER alone still waits for the idle window.
//
// A newcomer goes at the FRONT, not the end. Appending looks safer -- it cannot
// shift a slot under a finger -- but the ring only draws the first
// APP_RING_MAX_SLOTS (9) apps, so on a machine with more than that the appended
// app lands outside the window and is invisible, which is the exact bug this
// file exists to fix. Front is also where the Mac already puts it: the list is
// MRU-ordered and an app you just launched IS the most recent.
//
// So existing slots DO shift by one when an app appears. That is the honest
// trade: the debounce protects against a full MRU reshuffle during a gesture,
// and a launch is both rare mid-gesture and something the user just caused
// deliberately, unlike a background reorder they never asked for.

/** One app in the ring / switcher grid. Structurally identical to the wire row
 *  in `appSwitchList`; the layouts each declare their own copy for props. */
export type AppSwitchItem = { name: string; bundleId: string; iconPngBase64: string }

export interface AppListMerge {
  /** The list to show now, or null if this update has nothing urgent in it. */
  immediate: AppSwitchItem[] | null
  /** The full incoming list, to apply once the ring goes idle. Null when
   *  `immediate` already IS the incoming list, so nothing is left owed. */
  deferred: AppSwitchItem[] | null
}

/**
 * Merge an incoming app list against what the ring currently shows.
 *
 * `current` is null before the first list has landed (nothing is drawn, so
 * nothing can shift) — the incoming list is shown as-is.
 */
export function mergeAppList(
  current: AppSwitchItem[] | null,
  incoming: AppSwitchItem[]
): AppListMerge {
  if (current === null) return { immediate: incoming, deferred: null }

  const incomingIds = new Set(incoming.map((a) => a.bundleId))
  const currentIds = new Set(current.map((a) => a.bundleId))

  // Quit apps leave immediately: a slot that activates a dead app is the same
  // class of bug as a stale tab in the context bar, and removing one cannot
  // move the apps BEFORE it. Apps after it do shift inward -- accepted, because
  // the alternative is a tappable slot that does nothing.
  const survivors = current.filter((a) => incomingIds.has(a.bundleId))
  const departed = survivors.length !== current.length

  // Order is read from `incoming`, not `current`, so a newcomer lands where the
  // Mac put it relative to other newcomers rather than in socket-arrival order.
  const arrived = incoming.filter((a) => !currentIds.has(a.bundleId))

  if (!departed && arrived.length === 0) {
    // Same set, different order (or identical). Nothing urgent -- let the idle
    // debounce decide when the reshuffle is safe to paint.
    return { immediate: null, deferred: incoming }
  }

  // Newcomers first (see the header: the ring windows to 9, so the end is
  // off-screen), then the survivors in the order they already occupy. The true
  // MRU order still arrives via `deferred`, once no finger is on the ring.
  return { immediate: [...arrived, ...survivors], deferred: incoming }
}
