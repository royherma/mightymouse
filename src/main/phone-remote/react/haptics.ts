import { nativeBridge } from './native-bridge'

// Haptic feedback for gesture confirmations, best-effort per platform.
//
// Three engines, tried in order:
//   1. Native bridge — real system haptics, including during a drag.
//   2. navigator.vibrate — Android Chrome etc. Historically absent on iOS,
//      but there are 2026 reports of it appearing in Safari (unconfirmed,
//      mdn/browser-compat-data#29166) — trying it first means we pick that
//      up for free the moment it's real.
//   3. iOS Safari 17.4+ fires a real system haptic when an
//      <input type="checkbox" switch> is toggled. Programmatically, the
//      click must go through the wrapping LABEL — clicking the input
//      directly does NOT fire the haptic (WebKit quirk; same finding as the
//      ios-haptics library). Works on iOS 17.4–26.4; Apple patched the
//      programmatic path in iOS 26.5, where only a real finger tap directly
//      on a switch still haptics. On patched versions this degrades to a
//      silent no-op, never throws.
//
// iOS rule that shapes every caller below, and it applies to the SWITCH-CLICK
// ENGINE ONLY: that engine fires only from inside a USER-ACTIVATION window.
// touchstart/touchend/click grant one; touchmove does not, and a bare timer has
// none at all. A tick without activation is dropped, with no error and no retry
// that helps. So on plain Safari, taps haptic reliably while mid-drag ticks
// cannot — see hapticDragRelease.
//
// The NATIVE bridge is not subject to any of this. UIImpactFeedbackGenerator
// has no activation concept, so inside the iOS shell mid-drag detents do fire.
// Every deferral below is therefore gated on `nativeBridge.available` and takes
// the immediate path when it is present — a delay that exists to dodge a
// WebKit rule is pure lag once the rule doesn't apply.
//
// Measured on-device 2026-07-26, not inferred (four rounds, HUD + Mac log):
//   - one tick in touchstart            -> FELT
//   - 5s setInterval, hand off the glass -> ran, logged, never felt
// The second case is the decisive one: no finger anywhere near the screen and
// still silent, which rules out "a live touch blocks it" (the previous theory
// in this header) and leaves activation as the gate. Corollary worth knowing
// before optimising: firing ~26 ticks across one drag was also never felt, so
// bursts are additionally rate-limited/toggle-cancelled on top of this.
//
// The pref is phone-local (localStorage), NOT a Mac-side PREFS round-trip
// like layout/showCursor: whether haptics feel good is a property of the
// device in your hand, so it shouldn't follow the Mac across phones.

const HAPTICS_PREF_KEY = 'mm-remote-haptics'

/** Drag haptics are a SEPARATE pref, not a sub-setting of the one above.
 *  Taps and drags are different sensations at very different rates — a tick
 *  confirming a button is welcome to people who find a continuous stream of
 *  detents down a drag distracting — so one switch cannot serve both. Only
 *  offered where `capabilities.continuousHaptics` is true; elsewhere the
 *  engine physically cannot fire mid-drag and a toggle would promise
 *  something the host can't deliver. */
const DRAG_HAPTICS_PREF_KEY = 'mm-remote-haptics-drag'

function readPref(key: string): boolean {
  try {
    // Default ON — absence of the key means "never turned off".
    return localStorage.getItem(key) !== 'off'
  } catch {
    return true
  }
}

function writePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? 'on' : 'off')
  } catch {
    // Private-mode storage failure: the in-memory flag still applies for
    // this session, which is the best available behavior.
  }
}

let enabled = readPref(HAPTICS_PREF_KEY)
let dragEnabled = readPref(DRAG_HAPTICS_PREF_KEY)

export function getHapticsEnabled(): boolean {
  return enabled
}

export function setHapticsEnabled(value: boolean): void {
  enabled = value
  writePref(HAPTICS_PREF_KEY, value)
}

export function getDragHapticsEnabled(): boolean {
  return dragEnabled
}

export function setDragHapticsEnabled(value: boolean): void {
  dragEnabled = value
  writePref(DRAG_HAPTICS_PREF_KEY, value)
}

/** The master switch still wins: turning haptics off silences drags too, so a
 *  caller never has to check both. Keeping that precedence HERE rather than at
 *  each callsite is what stops the two prefs drifting into a state where the
 *  master is off and something still buzzes. */
function dragHapticsActive(): boolean {
  return enabled && dragEnabled
}

/** Set by App so haptics can report to the Mac's dev log -- the phone has no
 *  console readable from the Mac, so on-device behavior rides the open WS.
 *  Declared here (above its first use in hapticTick) rather than beside the
 *  detent code, so there's no temporal-dead-zone crash on an early tick. */
let debugLogSink: ((message: string) => void) | null = null

export function setHapticDebugLogSink(sink: (message: string) => void): void {
  debugLogSink = sink
}

let switchLabel: HTMLLabelElement | null = null

function ensureSwitchLabel(): HTMLLabelElement {
  if (switchLabel && document.body.contains(switchLabel)) return switchLabel
  const label = document.createElement('label')
  // Visually hidden but NOT display:none — iOS skips the haptic for elements
  // that don't render at all.
  label.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden'
  label.setAttribute('aria-hidden', 'true')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('switch', '')
  input.tabIndex = -1
  label.appendChild(input)
  document.body.appendChild(label)
  switchLabel = label
  return label
}

/** One short confirmation tick. Call from inside a user gesture handler —
 *  both engines require (or work best within) a real interaction context. */
export function hapticTick(): void {
  if (!enabled) return
  try {
    if (nativeBridge.available) {
      nativeBridge.haptic('light')
      debugLogSink?.('haptic-tick engine=native')
      return
    }
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(10)
      debugLogSink?.('haptic-tick engine=vibrate')
      return
    }
    debugLogSink?.('haptic-tick engine=switch-click')
    // The LABEL, not the input: WebKit only fires the switch haptic when the
    // programmatic click propagates through an associated label.
    ensureSwitchLabel().click()
  } catch {
    // Haptics are decoration — never let them break a gesture.
  }
}

/** Short enough to still read as caused by the tap, long enough for the touch
 *  sequence to tear down (a tap's touchend follows pointerdown almost
 *  immediately; the 180ms drag figure is tuned for a finger that lingers). */
const KEY_PRESS_DELAY_MS = 60

/** Key-press tick, for handlers that fire on POINTERDOWN (the virtual
 *  keyboard: keys must fire on press, not release, or the keyboard feels
 *  laggy). Same swallowing problem as drag-engage -- a tick requested with the
 *  finger still on the glass is dropped by the switch-click engine -- but
 *  unlike a drag, a tap's teardown is milliseconds away, so deferring past it
 *  lands reliably instead of never firing.
 *
 *  Fires immediately on Android/Chrome, where navigator.vibrate works mid-touch
 *  and the delay would only add lag. */
export function hapticKeyPress(): void {
  if (!enabled) return
  if (nativeBridge.available || typeof navigator.vibrate === 'function') {
    hapticTick()
    return
  }
  window.setTimeout(hapticTick, KEY_PRESS_DELAY_MS)
}

/** Drag-release tick. Deliberately DEFERRED past the touchend dispatch:
 *  ticking synchronously inside the touchend handler is still "during the
 *  touch" to WebKit and gets swallowed (confirmed on-device), while the
 *  plain tap tick — which fires 300ms after touchend from a timer — lands
 *  reliably. 80ms proved too close to teardown on iOS; 180ms sits in the
 *  same post-touch window the tap tick already uses successfully, and stays
 *  well under the ~250ms where a confirmation stops feeling causal.
 *
 *  On plain Safari there is still no reachable drag-ENGAGE tick and no
 *  per-distance detent. Neither can reach a user-activation window: engage
 *  fires from a timer and a detent from touchmove, and iOS grants activation
 *  to neither. Both DO fire inside the native shell — see hapticDragEngage.
 *  navigator.vibrate does not exist in Safari (any version), so the switch
 *  click is the only engine and it needs that window. A double-pulse retry on
 *  engage was tried on-device; both pulses were swallowed. This is an API
 *  absence, not a timing bug — no delay or retry value fixes it. See memory
 *  ios-safari-no-mid-drag-haptics before re-litigating that ceiling — it is a
 *  statement about SAFARI, and the native shell is the sanctioned way past it,
 *  not a counter-example to it. On Safari, release remains the only
 *  drag-related tick that can land, which makes its timing load-bearing
 *  rather than cosmetic. */
const DRAG_RELEASE_DELAY_MS = 180

/** Deliberately on the MASTER switch, not the drag pref. This is a single
 *  confirmation that the drag let go — the same "an action completed" tick as
 *  a button press — whereas the drag pref governs the continuous stream of
 *  detents DURING the drag. Someone who turns detents off still wants to know
 *  their drag landed. */
export function hapticDragRelease(): void {
  if (!enabled) return
  if (nativeBridge.available) {
    hapticTick()
    return
  }
  window.setTimeout(hapticTick, DRAG_RELEASE_DELAY_MS)
}

// Per-distance drag detents are real system ticks inside the native shell and
// on Android. Safari still no-ops because touchmove cannot grant the web
// user-activation window required by its fallback engine.
//
// Distance alone is not enough to feel fluid, which is why there are two
// constants rather than one. A flick covers several detents' worth of travel
// between two touchmove frames, so distance-only firing bunches ticks a few
// milliseconds apart and the Taptic Engine coalesces them into one buzz; a
// slow precise drag, meanwhile, wants every detent it earns. The time floor
// spaces the fast case out without thinning the slow one.
// 40 -> 28 -> 14: roughly double the ticks per drag, on top of the earlier
// bump. The interval floor is what makes this safe to keep lowering — extra
// detents on a fast flick collapse into the floor instead of turning to mush,
// so the added density lands almost entirely on slow, deliberate drags, which
// is where the hand can actually resolve individual ticks.
const DETENT_DISTANCE_PX = 14

/** Mirrors the native-side floor (Haptics.minIntervalMs). Enforced here too so
 *  Android — which has no such guard — gets the same spacing, and so a burst
 *  never leaves the webview at all.
 *
 *  Lowered with the distance: at 32ms this was the binding constraint on a
 *  medium-speed drag and would have eaten most of the density above. 22ms is
 *  still clear of the ~15-20ms where the Taptic Engine stops resolving separate
 *  impacts, so ticks stay distinct rather than blurring into a hum. */
const DETENT_MIN_INTERVAL_MS = 22

let detentTravel = 0
let lastDetentAt = 0

/** Feed every touchmove delta in. Fires a tick each DETENT_DISTANCE_PX of
 *  accumulated travel, subject to the interval floor above. */
export function hapticDragDetent(dx: number, dy: number): void {
  if (!dragHapticsActive()) return
  detentTravel += Math.hypot(dx, dy)
  if (detentTravel < DETENT_DISTANCE_PX) return

  const now = Date.now()
  if (now - lastDetentAt < DETENT_MIN_INTERVAL_MS) {
    // Hold the travel rather than zeroing it: a flick that outruns the floor
    // should still tick as soon as the floor clears, not forfeit the distance
    // it covered. Capping stops a long fast swipe banking a machine-gun burst
    // for when the finger slows down.
    detentTravel = Math.min(detentTravel, DETENT_DISTANCE_PX * 2)
    return
  }

  detentTravel = 0
  lastDetentAt = now
  hapticTick()
}

/** Zero the accumulator so each drag starts fresh rather than inheriting
 *  leftover travel from the previous one, and warm the engine so the first
 *  detent is as crisp as the rest. */
export function resetDragDetent(): void {
  detentTravel = 0
  lastDetentAt = 0
  if (dragHapticsActive() && nativeBridge.available) nativeBridge.hapticWarm('light')
}

/** Drag-ENGAGE tick: the moment hold-to-drag arms. This is the tick the
 *  gesture most wants — until it fires, the only affordance that the drag
 *  latched is the touch dot — and on plain Safari it is unreachable, because
 *  engage fires from a timer with the finger still down and so has no
 *  user-activation window. The native bridge has no such constraint, so inside
 *  the shell it fires for real. `medium` deliberately outweighs the `light`
 *  detents that follow: engage is a state change, detents are progress.
 *
 *  Silent rather than deferred on Safari — a deferred engage tick would land
 *  mid-drag and read as a spurious detent, not as the latch. */
export function hapticDragEngage(): void {
  if (!dragHapticsActive()) return
  if (!nativeBridge.available) return
  try {
    nativeBridge.haptic('medium')
  } catch {
    // Haptics are decoration — never let them break a gesture.
  }
}
