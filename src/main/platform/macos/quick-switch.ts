// quick-switch.ts — "tap to bounce to the previous app" for Phone Remote.
//
// Direct-activates the target app by bundle id (activate-app.ts's plain
// NSRunningApplication.activate() call) instead of faking a real Cmd+Tab HUD
// cycle. This replaces an approach (native `mm-input apptab N`, synthesizing
// held-Cmd + N Tab presses) that fought the real switcher HUD's own timing --
// wake-up delay, per-Tab settle, pre-release commit delay -- and after three
// rounds of tuning still landed one app off (or on the SAME app) as soon as
// the Mac was under any real load. Once the list-based switcher already
// proved that the phone can show a correctly-ordered MRU list and activate
// any entry in it with zero ambiguity (see app-switcher-list.ts +
// activate-app.ts), there was no reason for the "quick tap" button to go
// through a keystroke-simulation illusion for the exact same outcome --
// "bring app N-back to the front" is just an index into that same list.

import { activateApp } from './activate-app'
import { listSwitchableApps, type SwitchableApp } from './app-switcher-list'
import { devLog } from '../../../shared/env'

/**
 * Upper bound on steps per tap. Nobody meaningfully taps past a handful, and
 * this only guards against a runaway/bad value from the phone.
 */
export const QUICK_SWITCH_MAX_STEPS = 9

/** Serializes taps so two rapid ones can't race on the same MRU snapshot. */
let inFlight: Promise<void> = Promise.resolve()

/**
 * The app the LAST tap activated -- our anchor for "where am I now".
 *
 * We can't derive that from the list itself: listSwitchableApps() orders by
 * CGWindowList's on-screen z-order, which does NOT reliably reorder after an
 * activate (a just-left app's window can still sort above the one we switched
 * to). Diagnosed 2026-07-20 from a real device session -- across nine taps
 * mru[0]/mru[1] stayed pinned to the same two apps while the frontmost app
 * genuinely changed every tap. Indexing from the top of that list therefore
 * resolved steps=1 to the SAME app forever, ping-ponging between two and
 * silently no-op'ing whenever the target was already frontmost (the "I tap
 * and nothing happens" bug).
 *
 * Tracking what WE activated sidesteps the unreliable ordering entirely: the
 * activate is the thing that made the app frontmost, so it's the ground truth.
 * Cleared when the app we think we're on is no longer in the list (it quit),
 * and harmlessly wrong if the user switches apps by other means -- the next
 * tap just starts walking from wherever the list says instead.
 */
let lastActivatedBundleId: string | null = null

/** Test seam: reset the walk anchor between cases. */
export function resetQuickSwitchAnchor(): void {
  lastActivatedBundleId = null
}

/**
 * The app the last quick-switch landed on, or null before the first tap of a
 * session. Sent to the phone alongside the MRU list so its preview overlay can
 * anchor on the SAME app this module walks from.
 *
 * Without this the phone has to guess, and its only available guess -- "index
 * 0 of the list is the current app" -- is exactly the assumption that doesn't
 * hold (see lastActivatedBundleId): the list never reorders after an activate,
 * so the preview highlights the same tile every burst while the Mac correctly
 * walks forward. Publishing the real anchor keeps both sides on one contract.
 */
export function getQuickSwitchAnchor(): string | null {
  return lastActivatedBundleId
}

/**
 * Record an app activated OUTSIDE this module (the phone's grid popup, or a
 * quick-switch tap that now sends a bundle id rather than a step count) as the
 * new walk origin.
 *
 * Without this the anchor only moves when quickSwitchApps() runs, so any other
 * activation path leaves it pointing at a stale app and the next burst counts
 * forward from the wrong place.
 */
export function setQuickSwitchAnchor(bundleId: string): void {
  lastActivatedBundleId = bundleId
}

/**
 * Walk `steps` apps forward from the one we're currently on, wrapping at the
 * end of the list -- no keystroke simulation, no HUD timing involved.
 *
 * Position is RELATIVE to the current app, not an index from the top of the
 * list: we find where we are, then step forward from there. That's what makes
 * repeated taps advance (A -> B -> C -> D) instead of bouncing between the
 * same two apps, and it's self-correcting -- it holds even though the
 * underlying list ordering is unreliable (see lastActivatedBundleId).
 *
 * Wraps past the end so the button is never a dead no-op, matching the Mac's
 * own switcher. Since we always step OFF our own index, the target can never
 * be the app we're already on (given 2+ apps) -- which is the dead-tap bug
 * this replaced.
 *
 * `steps` is clamped to [1, QUICK_SWITCH_MAX_STEPS]; a non-finite value
 * degrades to 1 rather than throwing, since this is driven by a phone over a
 * socket.
 *
 * Resolves with the app that was activated (or undefined if the list was
 * empty / activation failed). Never throws.
 *
 * Does NOT serialize itself — callers run this via afterQuickSwitchQueue().
 */
export async function quickSwitchApps(steps: number): Promise<SwitchableApp | undefined> {
  const safeSteps = Number.isFinite(steps)
    ? Math.min(QUICK_SWITCH_MAX_STEPS, Math.max(1, Math.floor(steps)))
    : 1

  const apps = listSwitchableApps()
  if (apps.length === 0) {
    devLog.warn('[quick-switch] no switchable apps found')
    return undefined
  }

  // Where we are now. -1 (not found) covers both the first tap of a session
  // and the app we were on having quit; index 0 is the right starting point
  // for both, so a plain `indexOf` result feeds the same arithmetic.
  const currentIndex = lastActivatedBundleId
    ? apps.findIndex((a) => a.bundleId === lastActivatedBundleId)
    : -1
  const from = currentIndex === -1 ? 0 : currentIndex

  // Modulo AFTER adding, so a steps value larger than the list simply laps it
  // rather than clamping to the end (the old behavior, which made every step
  // past the list length land on the same final app).
  const target = apps[(from + safeSteps) % apps.length]

  devLog.log(
    `[quick-switch] steps=${safeSteps} from="${apps[from]?.name ?? '?'}"[${from}] ` +
      `-> "${target.name}" of ${apps.length}`
  )

  if (!activateApp(target.bundleId)) return undefined
  lastActivatedBundleId = target.bundleId
  return target
}

/**
 * Runs `work` strictly after every quick-switch queued so far has settled, so
 * two rapid taps can't read/act on the app list out of order.
 */
export function afterQuickSwitchQueue<T>(work: () => Promise<T>): Promise<T> {
  const result = inFlight.then(work)
  inFlight = result.then(
    () => undefined,
    () => undefined
  )
  return result
}
