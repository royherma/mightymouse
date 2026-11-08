// Tour hotkey probe — lets the value tour ask "did the user just press the REAL
// global hotkey?" without a second uiohook watcher. capture-hotkey.ts calls
// probeIntercept() at the top of each shortcut's dispatch branch; a hit here
// means the branch returns early and the real handler (open panel / start
// recording / start listening) never runs — see design for why suppression
// is deliberate (a real capture/listen session mid-tour would steal focus and
// leave the user in a state the tour can't explain).
//
// Single nullable armed id, no queue: the tour only ever has one step's probe
// live at a time. First hit per arm wins (latch) — uiohook fires keydown
// repeatedly while a key is held, so without the latch a single physical press
// would emit multiple 'hit' events.
//
// Deliberately no import of tour-window.ts (or 'electron') here: capture-hotkey.ts
// imports this module, and capture-hotkey.ts is a hot, widely-transitively-imported
// leaf (reached from runner.ts via permission-tests.ts). Pulling in BrowserWindow
// there would leak 'electron' into every test that touches the backend/permission
// graph, most of which don't mock it. tour-window.ts pushes its window reference
// in via setTourWindowRef() instead — a one-way registration, not a two-way import.
import { CHANNELS } from '../shared/ipc'
import type { TourProbeEventPayload } from '../shared/tour/types'
import { VC } from '../shared/shortcuts'
import type { ShortcutId } from '../shared/shortcuts'

// Structurally typed to the two members actually used, so this file never needs
// `import type { BrowserWindow } from 'electron'` either — same leak, same fix.
interface TourWindowRef {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: TourProbeEventPayload): void }
}

let tourWindowRef: TourWindowRef | null = null

/** Called by tour-window.ts whenever the live tour window changes (created or
 *  closed). Keeps this module decoupled from 'electron' — see header comment. */
export function setTourWindowRef(win: TourWindowRef | null): void {
  tourWindowRef = win
}

/** The live-demo hooks (tour-demo.ts), injected rather than imported for the
 *  exact reason in this file's header: tour-demo.ts reaches panel-window.ts and
 *  hud-window.ts, both of which import 'electron'. Importing it here would drag
 *  BrowserWindow into every test that transitively touches capture-hotkey.ts —
 *  measured, not theorised: doing so broke 18 backend test files at once.
 *  Defaults to no-ops so an un-wired probe (every unit test) just does nothing. */
interface TourDemoHooks {
  start(shortcutId: ShortcutId): void
  end(): void
}
let demo: TourDemoHooks = { start: () => {}, end: () => {} }

export function setTourDemoHooks(hooks: TourDemoHooks): void {
  demo = hooks
}

let armedShortcutId: ShortcutId | null = null
let latched = false
// Last emitted modifier trio, so 'mods' events only fire on an actual change
// — every keydown/keyup
// while armed would otherwise spam the renderer.
let lastMods: { meta: boolean; alt: boolean; shift: boolean } | null = null

function send(payload: TourProbeEventPayload): void {
  if (!tourWindowRef || tourWindowRef.isDestroyed()) return
  tourWindowRef.webContents.send(CHANNELS.tourProbeEvent, payload)
}

/** Arm the probe for one shortcut, or pass null to disarm. Re-arming (e.g. on
 *  step change) always resets the latch + mods memory, so a stale hit from the
 *  previous step can never leak into the new one. */
export function armProbe(shortcutId: ShortcutId | null): void {
  // Any re-arm means the tour left the previous step, so whatever demo surface
  // that step put on screen is now orphaned — tear it down before the new step
  // can open its own. Same reasoning as resetting the latch: state from the old
  // step must never survive into the new one.
  demo.end()
  armedShortcutId = shortcutId
  latched = false
  lastMods = null
}

export function disarmProbe(): void {
  armProbe(null)
}

export function isProbeArmed(): boolean {
  return armedShortcutId !== null
}

/**
 * Call at the TOP of a shortcut's dispatch branch in capture-hotkey.ts. Returns
 * true when this press was consumed by the probe — the caller must return
 * immediately without running the real handler.
 *
 * - Armed id matches → emit 'hit' (first press only; latch swallows repeats).
 * - A DIFFERENT tour shortcut fires while armed → emit 'wrong' with the
 *   expected id, and still consume it (a wrong-key press during the tour
 *   shouldn't open the panel/start recording either).
 */
export function probeIntercept(id: ShortcutId): boolean {
  if (armedShortcutId === null) return false
  if (id !== armedShortcutId) return probeWrongKey()
  if (!latched) {
    latched = true
    send({ kind: 'hit' })
    // The payoff: show the real surface this hotkey drives. The real action is
    // still suppressed (we return true) — this is the same window/card with
    // nothing behind it. See tour-demo.ts's header for why that split matters.
    demo.start(id)
  }
  return true
}

/**
 * Consume ANY other Cmd+Opt+Shift chord while armed (H/S/J/D/K/;/digits — every
 * registered shortcut besides the three tour steps). These aren't one of the
 * armed step's own aliases, but a wrong-key press during the tour still
 * shouldn't fall through to its real action (design mandated-simplification
 * bullet: "keycode matches ANY other registered tour shortcut OR any ⌘⌥⇧
 * chord branch"). Returns true (always consumes) when armed; false when not.
 */
export function probeWrongKey(): boolean {
  if (armedShortcutId === null) return false
  send({ kind: 'wrong', expected: armedShortcutId })
  return true
}

// Which physical modifier a keycode is, if any. uiohook's flag bits
// (e.metaKey etc.) lag one event behind the modifier's OWN transition: on
// Opt's keydown, e.altKey is still false, and on its keyup it's still true.
// Symptom before this fix: the last-pressed modifier cap never lit while held
// (and never dimmed on release). So we track the six modifier keycodes
// physically and merge with the flags — flags catch mods that were already
// down before tracking saw them; physical state catches the lagging edge.
type ModName = 'meta' | 'alt' | 'shift'
const MOD_KEYCODE: Record<number, ModName> = {
  [VC.META_L]: 'meta',
  [VC.META_R]: 'meta',
  [VC.ALT_L]: 'alt',
  [VC.ALT_R]: 'alt',
  [VC.SHIFT_L]: 'shift',
  [VC.SHIFT_R]: 'shift'
}
/** True when this keycode IS one of ⌘/⌥/⇧ itself. The wrong-key gate needs it:
 *  the third modifier's own keydown already satisfies `hasMods`, so without
 *  this the chord shook the caps amber before the letter was ever pressed. */
export function isModifierKeycode(keycode: number): boolean {
  return MOD_KEYCODE[keycode] !== undefined
}

// Tracked unconditionally (armed or not, ~nothing of cost) so arming mid-hold
// still starts from an accurate picture of what's physically down.
const physicalMods: Record<ModName, boolean> = { meta: false, alt: false, shift: false }

/** Modifier held-state feedback (the `held` cap animation). Call at the TOP of
 * BOTH the keydown and keyup uiohook handlers, for every event. Throttled to
 * only emit on an actual trio change. */
export function probeObserveKey(
  keycode: number,
  flags: { meta: boolean; alt: boolean; shift: boolean },
  down: boolean
): void {
  const own = MOD_KEYCODE[keycode]
  if (own) physicalMods[own] = down
  if (armedShortcutId === null) return
  const mods: Record<ModName, boolean> = {
    meta: physicalMods.meta || flags.meta,
    alt: physicalMods.alt || flags.alt,
    shift: physicalMods.shift || flags.shift
  }
  // This event IS a modifier's own transition — its new state wins over the
  // (lagging) flag bit, in both directions.
  if (own) mods[own] = down
  if (
    lastMods &&
    lastMods.meta === mods.meta &&
    lastMods.alt === mods.alt &&
    lastMods.shift === mods.shift
  ) {
    return
  }
  lastMods = mods
  send({ kind: 'mods', ...mods })
}
