/**
 * Detect a HUMAN touching the Mac while the lock is suspended, so Away Mode
 * hands back and the lock comes straight back.
 *
 * This is the security half of Away Mode. idle-lock-suppressor.ts holds the lock open;
 * privacy-curtain.ts hides the screen; neither helps if someone sits down
 * at the machine. The rule this enforces: the moment a person is physically
 * present, the remote session's claim on the Mac ends.
 *
 * THE HARD PART — uiohook cannot tell our own synthetic events from real ones.
 * Phone Remote drives the cursor by SYNTHESIZING mouse and key events, and those
 * come back through the same global tap as a human's. A naive "any input ends
 * the session" watcher therefore fires on the phone's very first swipe and the
 * feature never works at all.
 *
 * macOS does expose a real discriminator (CGEventSourceStateID / the event's
 * userData field, which a poster can stamp), but we don't reach the tap at that
 * level: uiohook-napi's JS surface hands us a normalized event with no source
 * field. Threading one through would mean patching the native module.
 *
 * So the discriminator is TEMPORAL: input arriving within QUIET_MS of the app
 * generating some is attributed to the app. `macos/input.ts` is the authority on
 * "we posted one" — it stamps noteAppGeneratedInput itself.
 *
 * A POSITIONAL match was tried first and does not work. It recorded the cursor
 * point when a message arrived, then compared the delivered event against it —
 * but the message is noted BEFORE the handler moves the cursor, so every event
 * landed a full swipe-delta away and read as human. The session tore itself down
 * on the first touch, before the lock guard was even acquired. Do not reintroduce
 * it without a post-move hook on every synthesizing path.
 *
 * Two known blind spots, both accepted:
 *   - Input during a phone burst is missed until the phone pauses for QUIET_MS.
 *   - A drifting cursor never counts (see the listener list) — only a click, a
 *     key or a scroll does.
 * Both are cases where a person is at a machine someone else is visibly driving,
 * with the curtain still up. The alternative — firing on any pointer motion —
 * shipped first and re-locked on a bumped desk, which made the feature unusable.
 * Widen this only with a real report, never on principle.
 */
import { acquire, isAvailable, on, type AnyEvent } from '../capture/uiohook-manager'
import { input, setSyntheticPasteListener } from '../platform'
import { devLog } from '../../shared/env'

/**
 * How long after a message from the phone its synthetic input keeps arriving.
 *
 * 600ms: an inertial scroll or a momentum flick keeps posting events well after
 * the socket goes quiet, and each unattributed one would end the session. Long
 * enough to cover that tail; short enough that setting the phone down and
 * reaching for the keyboard clears it.
 */
const QUIET_MS = 600

/**
 * Cumulative mouse travel (px) that counts as a person, not a nudge.
 *
 * 400: mousemove was originally excluded outright because a bumped desk, a
 * Bluetooth mouse waking, or a sleeve on the trackpad each ended the session —
 * all of which move the cursor tens of px at most. Reaching for a mouse and
 * moving it covers hundreds. Cumulative rather than per-tick so a slow
 * deliberate drag still adds up, matching context-logger's MOVE_FLUSH_DIST_PX.
 */
const MOVE_INTENT_PX = 400

// 400ms: a real scroll arrives as a burst of tens, a lone wheel is our own late
// synthetic tail or a bump. Bridges two deliberate flicks without letting a
// stray wheel pair with a real scroll a second later.
const WHEEL_PAIR_MS = 400

/**
 * Which listener attributed input to a human. Reaches away-mode's journal so a
 * postpone storm names its own cause: `mousemove` dominating means the 400px
 * accumulator is re-tripping, which is a different defect from a chattering
 * key, and a count alone cannot tell them apart.
 */
export type LocalInputKind = 'mousemove' | 'mousedown' | 'wheel' | 'keydown'

let release: (() => void) | null = null
let unsubs: Array<() => void> = []
let onHuman: ((kind: LocalInputKind) => void) | null = null

let lastAppInputAt = 0

// Cursor travel accumulated since the watch armed (or since the phone last
// moved it). Reset on any attributed-to-phone tick so the phone's own cursor
// driving never accumulates toward the human threshold.
let moveAccumPx = 0
let lastMoveX: number | null = null
let lastMoveY: number | null = null

// For inferring auto-repeat: uiohook's events carry no repeat flag, so "same
// keycode again with no keyup in between" is the only observable. One held key
// generated 861 keydowns in a session.
let downKeycode: number | null = null

// When the last unattributed wheel landed, so a second one inside WHEEL_PAIR_MS
// can corroborate it. 0 = none pending.
let lastLoneWheelAt = 0

/** The app is generating input, so anything landing in the next QUIET_MS is ours.
 *  A phone message is NOT sufficient evidence — the Mac also synthesizes long
 *  after one. `make why Q="dictation relock"`. */
export function noteAppGeneratedInput(): void {
  lastAppInputAt = Date.now()
}

/**
 * When the event loop last turned, so a delivery that arrived after a stall can
 * be recognised as one.
 *
 * `sinceStamp` is measured with `Date.now()` read INSIDE the uiohook callback —
 * i.e. at delivery, not when the OS posted the event. uiohook taps on its own
 * pthread but hands events to JS through `napi_call_function` on the main loop,
 * so a blocked main thread defers delivery and inflates `sinceStamp` by the
 * whole stall. That is how a correctly-stamped `ctrl+b` from the phone read as a
 * human 5.4s later and locked the user out. The blocking spawnSync in
 * app-context (3s) and app-switcher-list (2s) are the usual culprits.
 */
let lastLoopTurnAt = Date.now()
let loopTicker: NodeJS.Timeout | null = null

// 250ms: well under QUIET_MS, so an ordinary turn never looks like a stall,
// while any block long enough to break attribution shows up on the next tick.
const LOOP_TICK_MS = 250

/**
 * True when the loop was blocked long enough that timing tells us nothing.
 *
 * A stall is positive evidence the discriminator is broken, NOT evidence of a
 * person: our own event and a stranger's are equally delayed by it, and only one
 * of those two readings locks the user out of the machine the phone is the only
 * way into. So a stalled window attributes to the app.
 */
function loopStalled(): boolean {
  return Date.now() - lastLoopTurnAt > QUIET_MS
}

function looksSynthetic(): boolean {
  return Date.now() - lastAppInputAt < QUIET_MS
}

/**
 * The numbers behind the last `human` verdict, for the journal.
 *
 * The 2026-09-08 incident took four wrong answers to diagnose because the
 * journal recorded only `ended by human` — a real person and a late-delivered
 * synthetic keystroke wrote the identical line. `sinceStamp` is what separates
 * them: just over QUIET_MS is ours arriving late, seconds is a person.
 */
let lastVerdict: { kind: LocalInputKind; detail: string; sinceStampMs: number } | null = null

export function lastHumanVerdict(): { kind: LocalInputKind; detail: string; sinceStampMs: number } | null {
  return lastVerdict
}

function resetMoveAccum(): void {
  moveAccumPx = 0
  lastMoveX = null
  lastMoveY = null
}

/**
 * Start watching. `cb` fires AT MOST ONCE per watch — the first human input ends
 * the session, and everything after it is the user's own machine again. Firing
 * repeatedly would re-trigger the teardown on every subsequent keystroke.
 */
export function startLocalInputWatch(cb: (kind: LocalInputKind) => void): void {
  if (release) return
  if (!isAvailable()) {
    // No tap ⇒ no way to notice a human. The caller must treat this as a reason
    // NOT to suspend the lock: an unlocked Mac with no re-lock trigger is
    // precisely the state this feature must never leave behind.
    devLog.warn('Local input watch: uiohook unavailable — cannot arm')
    return
  }

  onHuman = cb
  resetMoveAccum()
  downKeycode = null
  lastLoneWheelAt = 0

  // NOT zeroed: the phone is mid-session and already streaming when the watch
  // arms, so starting from "no phone activity" attributes its next event to a
  // human and kills the session it was just asked to protect.
  lastAppInputAt = Date.now()

  // Only turns while the watch is armed — a free-running timer would keep the
  // process awake for a guard nobody is consulting.
  lastLoopTurnAt = Date.now()
  loopTicker = setInterval(() => {
    lastLoopTurnAt = Date.now()
  }, LOOP_TICK_MS)
  loopTicker.unref?.()

  // `detail` carries the keycode for the dev log; `kind` is the typed value the
  // journal counts, so a postpone storm can name which listener produced it.
  const fire = (kind: LocalInputKind, detail?: string): void => {
    if (!onHuman) return
    if (looksSynthetic()) return

    // The stall check sits AFTER looksSynthetic so an ordinary attributed event
    // costs nothing, and BEFORE the callback because a relock is a one-way door:
    // the phone cannot dismiss a login window, so the ambiguous case must resolve
    // toward keeping the session alive. A real person is still caught — they keep
    // typing, and the next event arrives on a loop that has since caught up.
    if (loopStalled()) {
      devLog.warn(
        'Local input watch: ignoring',
        detail ?? kind,
        `— event loop stalled ${Date.now() - lastLoopTurnAt}ms, attribution unreliable`
      )
      return
    }

    // sinceStamp decides a disputed relock: just over QUIET_MS means our own
    // event landed late, seconds means a real person.
    const sinceStampMs = Date.now() - lastAppInputAt
    lastVerdict = { kind, detail: detail ?? kind, sinceStampMs }
    devLog.warn(
      'Local input watch: human input detected —',
      detail ?? kind,
      `sinceStamp=${sinceStampMs}ms`
    )
    const cbOnce = onHuman
    onHuman = null
    cbOnce(kind)
  }

  // mousemove counts only past a DISTANCE, never per-tick: firing on any motion
  // ended sessions on a bumped desk, ignoring it entirely left a walked-up-to
  // Mac covered and unlocked. A jolt is tens of px, a person is hundreds.
  const onMove = (e: AnyEvent): void => {
    if (!onHuman) return
    if (looksSynthetic()) {
      // The phone is driving the cursor. Reset rather than accumulate, or a long
      // remote drag would trip the threshold and end the session it belongs to.
      resetMoveAccum()
      return
    }

    if (lastMoveX !== null && lastMoveY !== null) {
      moveAccumPx += Math.hypot(e.x - lastMoveX, e.y - lastMoveY)
    }
    lastMoveX = e.x
    lastMoveY = e.y

    if (moveAccumPx >= MOVE_INTENT_PX) fire('mousemove')
  }

  // Gated here rather than in `fire` so the timestamp only advances on events
  // already judged unattributed.
  const onWheel = (): void => {
    if (!onHuman) return
    if (looksSynthetic()) return

    const now = Date.now()
    const corroborated = lastLoneWheelAt !== 0 && now - lastLoneWheelAt < WHEEL_PAIR_MS
    lastLoneWheelAt = now
    if (!corroborated) {
      // The near-miss line: a lone wheel a few hundred ms past the stamp, during
      // a live phone session, IS the relock mechanism caught before it fires.
      devLog.log(
        'Local input watch: lone wheel ignored —',
        `sinceStamp=${now - lastAppInputAt}ms`
      )
      return
    }
    fire('wheel')
  }

  // Auto-repeat is one human decision, not a stream of them: repeats are
  // dropped so the OS's repeat rate can't postpone 60×/s. A different key while
  // one is held still counts — that IS a second decision.
  const onKeydown = (e: AnyEvent): void => {
    const isRepeat = downKeycode === e.keycode
    downKeycode = e.keycode
    if (isRepeat) return
    fire('keydown', `keydown keycode=${e.keycode}`)
  }
  const onKeyup = (e: AnyEvent): void => {
    if (downKeycode === e.keycode) downKeycode = null
  }

  unsubs = [
    on('keydown', onKeydown),
    on('keyup', onKeyup),
    on('mousedown', () => fire('mousedown')),
    on('wheel', onWheel),
    on('mousemove', onMove)
  ]
  input.setSyntheticInputListener(noteAppGeneratedInput)
  // Cmd+V from a dictation/auto-paste goes through System Events, not mm-input,
  // so it needs its own stamp or it reads as a human and relocks the Mac.
  setSyntheticPasteListener(noteAppGeneratedInput)
  release = acquire()
  devLog.log('Local input watch: armed')
}

/**
 * Re-arm the callback after a fire, WITHOUT touching the OS tap.
 *
 * `fire` nulls `onHuman` so a watch reports a human at most once — right when
 * the callback means "end the session", wrong when it means "the user is still
 * here, postpone". away-mode.ts needs the second reading until its cover
 * is up, and it re-arms through here rather than stop-then-start: `release()` is
 * refcounted down to `hook.stop()`, so cycling the watch per keystroke tears the
 * global event tap down and back up on every key — the degraded-tap state that
 * throttles system-wide typing. Only the JS callback is restored here.
 *
 * No-op when the watch was never armed: without a tap there is nothing to arm.
 */
export function rearmLocalInputWatch(cb: (kind: LocalInputKind) => void): void {
  if (!release) return
  onHuman = cb
  // Travel banked before the re-arm already did its job (it postponed the
  // curtain); carrying it over would trip the threshold on the next twitch.
  resetMoveAccum()
  lastLoneWheelAt = 0
}

/** Stop watching. Safe to call when not watching. */
export function stopLocalInputWatch(): void {
  onHuman = null
  if (loopTicker) {
    clearInterval(loopTicker)
    loopTicker = null
  }
  input.setSyntheticInputListener(null)
  setSyntheticPasteListener(null)
  for (const u of unsubs) u()
  unsubs = []
  if (release) {
    release()
    release = null
  }
  devLog.log('Local input watch: disarmed')
}

/** True while armed. Exposed for tests + the guard's reconcile. */
export function isLocalInputWatchActive(): boolean {
  return release !== null
}
