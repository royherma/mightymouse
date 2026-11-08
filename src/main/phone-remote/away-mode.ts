/**
 * Away Mode — the ONE owner of "the Mac is deliberately running unlocked for a
 * phone". Composes idle-lock-suppressor, privacy-curtain and local-input-watch; never wire
 * those from a call site. Four rules, each paid for:
 *
 * 1. THE LOCK IS NEVER SUSPENDED WITHOUT A WORKING WAY TO RESTORE IT — hence the
 *    ordering: watch armed first, and on the way out lock back before uncover.
 * 2. THE STATE IS ONE VALUE, written only by transition() below.
 * 3. THE GRACE WINDOW NEVER LOCKS. A relock is a one-way door, so the phone
 *    going away means COVER. handback() is the only relock, ever.
 * 4. THE COVER IS DEFERRED, which makes local input mean two things — postpone
 *    before it is up, handback after (onLocalInput, and nowhere else).
 */
import { exec } from 'child_process'
import { powerMonitor } from 'electron'
import { devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
import { formatDuration } from '../../shared/relay-cards'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { recordJournal } from './connection-journal'
import { suppressIdleLock, endSessionAndLockMac, isIdleLockSuppressed } from './idle-lock-suppressor'
import { startStayAwake, stopStayAwake, armIdleLockRearm, isStayAwakeActive } from './stay-awake'
import { showCurtain, hideCurtain, isCurtainVisible } from './privacy-curtain'
import {
  startLocalInputWatch,
  stopLocalInputWatch,
  isLocalInputWatchActive,
  rearmLocalInputWatch,
  lastHumanVerdict,
  type LocalInputKind
} from './local-input-watch'

export type AwayModeState = 'off' | 'held' | 'covered'
export type AwayModeFailure = 'no-input-watch' | 'cancelled' | 'failed'

type AwayModeEvent = 'hold' | 'cover' | 'uncover' | 'handback'

// A missing entry IS the rejection — `covered` is a strict sub-state of `held`,
// so 'cover' deliberately has no edge from 'off'.
const EDGES: Record<AwayModeState, Partial<Record<AwayModeEvent, AwayModeState>>> = {
  off: { hold: 'held' },
  held: { cover: 'covered', handback: 'off' },
  covered: { uncover: 'held', handback: 'off' }
}

let state: AwayModeState = 'off'

// The only writer of `state`. Illegal edges leave it unchanged and log.
function transition(event: AwayModeEvent): boolean {
  const next = EDGES[state][event]
  if (next === undefined) {
    devLog.warn(`Away Mode: illegal transition '${event}' from '${state}' — ignored`)
    return false
  }
  devLog.log(`Away Mode: ${state} → ${next} (${event})`)
  state = next
  return true
}

/** The current state, for tests and Settings. Never write around transition(). */
export function getAwayModeState(): AwayModeState {
  return state
}

/** True while the Mac is deliberately running unlocked for a phone. */
export function isAwayModeHeld(): boolean {
  return state !== 'off'
}

// Not a fourth state — it marks handback()'s in-flight ~2s relock await. Input
// arriving inside it used to raise a cover nobody was left to take down.
let ending = false

/** Fired when a human ends Away Mode, so the caller can tell the phone. */
let onEndedByHuman: (() => void) | null = null
/** Fired whenever the cover goes up, so the caller can tell the phone. */
let onCovered: (() => void) | null = null

let coverTimer: NodeJS.Timeout | null = null

// The ONE reaction to "the phone is gone". Must never call endSessionAndLockMac or
// stopStayAwake: letting the display sleep re-arms macOS's idle lock.
let graceTimer: NodeJS.Timeout | null = null

// Outlives the timer on purpose: after the grace fires the phone is STILL gone,
// and handback reads this to hand the blocker to stay-awake's own countdown.
let phoneGone = false

/** Postpone ceiling bookkeeping — see onLocalInput. */
let postponeCount = 0
let heldSince = 0

// Which listeners drove the postpones: a chattering key and the move
// accumulator re-tripping look identical in the count alone.
let postponeKinds: Partial<Record<LocalInputKind, number>> = {}

// Sorted so the dominant kind reads first — that is the one to act on.
function postponeKindSummary(): string {
  const parts = Object.entries(postponeKinds).sort((a, b) => b[1] - a[1])
  return parts.map(([kind, n]) => `${kind} ${n}`).join(', ')
}

// `coveredAt` must be reset on BEGIN, not just handback — a session that never
// covered would inherit the last one's stamp and report a huge covered_s.
let sessionStartedAt = 0
let coveredAt: number | null = null

// Clears the clock as it reads it, so an idempotent double teardown can't
// double-count a session.
function trackAwaySession(endedBy: 'human' | 'disconnect'): void {
  if (sessionStartedAt === 0) return
  const now = Date.now()
  track(ANALYTICS_EVENT.away_mode_session, {
    covered: coveredAt !== null,
    duration_s: Math.round((now - sessionStartedAt) / 1000),
    covered_s: coveredAt === null ? 0 : Math.round((now - coveredAt) / 1000),
    ended_by: endedBy
  })
  sessionStartedAt = 0
  coveredAt = null
}

// The user's own display-sleep delay is when THEY consider themselves away, so
// the cover reuses it rather than a number we invented. `pmset -g` still prints
// the configured value while our blocker suppresses it, so this holds mid-session.
export function parseDisplaySleepMs(pmsetOutput: string): number | null {
  const m = /^\s*displaysleep\s+(\d+)/m.exec(pmsetOutput)
  if (!m) return null
  const minutes = Number(m[1])
  // 0 means "never" in pmset, which is not a delay we can wait for.
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return minutes * 60 * 1000
}

// No upper bound on purpose: the user's own display-sleep delay IS the answer to
// "when am I away", so capping it covers the screen on someone using the phone
// as a trackpad at their desk.
function clampCoverDelay(ms: number | null): number {
  const { AWAY_COVER_DELAY_MIN_MS: min, AWAY_COVER_DELAY_FALLBACK_MS: fallback } =
    CONFIG.PHONE_REMOTE
  if (ms === null) return fallback
  return Math.max(ms, min)
}

async function readCoverDelayMs(): Promise<number> {
  const out = await new Promise<string>((resolve) => {
    exec('pmset -g', { timeout: 5_000 }, (err, stdout) => resolve(err ? '' : String(stdout ?? '')))
  })
  const delay = clampCoverDelay(parseDisplaySleepMs(out))
  devLog.log(`Away Mode: cover delay ${formatDuration(delay)} (from displaysleep)`)
  return delay
}

function cancelCoverTimer(): void {
  if (!coverTimer) return
  clearTimeout(coverTimer)
  coverTimer = null
}

// Resolved once per session: `pmset` is a spawn, and the timer re-arms on every
// keystroke while the user is still at the desk.
let coverDelayMs = CONFIG.PHONE_REMOTE.AWAY_COVER_DELAY_FALLBACK_MS

// Capture-hidden (setContentProtection): the Mac shows black while the phone's
// stream still sees the live desktop underneath.
function coverNow(why: string, opts?: { arm?: boolean }): void {
  if (!transition('cover')) return
  cancelCoverTimer()
  showCurtain()
  coveredAt = Date.now()
  startCoverWatchdog()
  if (opts?.arm) coverArmUntil = Date.now() + CONFIG.PHONE_REMOTE.AWAY_COVER_ARM_MS
  devLog.log('Away Mode: covered —', why)
  recordJournal('covered', { detail: why })
  const cb = onCovered
  if (cb) cb()
}

// Cancels first, so input pushes the cover out by the full delay instead of
// stacking timers.
// When the armed cover timer is due, so the postpone log can print time left.
// Wall-clock, not a tick: nothing here is worth a 1s interval per session.
let coverDueAt = 0

// Wall-clock of the previous postpone, so the log can state the real idle gap
// rather than re-deriving it from a timer that this same input is about to reset.
let lastInputAt = 0

// Protect covers under the mouse. Input before this stamp is that click, not a
// walk-up, so it must not lock. 0 = none armed.
let coverArmUntil = 0

function armCoverTimer(): void {
  cancelCoverTimer()
  // A cover outlives its session only if one gets armed while it is ending.
  if (ending) return
  coverDueAt = Date.now() + coverDelayMs
  coverTimer = setTimeout(() => {
    coverTimer = null
    // Last line of defence: never cover a screen with no session behind it.
    if (ending || state !== 'held') return
    coverNow('Mac untouched for the delay')
  }, coverDelayMs)
}

/**
 * The one place local input is interpreted: postpone before the cover is up,
 * hand back after.
 *
 * NO POSTPONE CEILING, deliberately — a count cannot tell typing from a held key.
 * The bound is `coverDelayMs` of NO input; a stuck key is the watch's repeat
 * filter. `make why Q="postpone ceiling"`.
 *
 * RE-ARM: the watch reports a human AT MOST ONCE, so without it this goes deaf
 * after one keystroke and covers a user mid-type.
 */
function onLocalInput(kind: LocalInputKind): void {
  // Input landing inside the teardown's relock await: the session is already
  // going, so there is nothing to postpone and nothing left to end.
  if (ending) return
  // The click that asked for the cover. Rearm or the watch stays deaf.
  if (coverArmUntil && Date.now() < coverArmUntil) {
    rearmLocalInputWatch(onLocalInput)
    return
  }

  if (!isCurtainVisible()) {
    // Kept with no ceiling to trip: this is the regression detector for the
    // filter above. A kind breakdown dominated by one keycode's worth of input
    // is the never-yet-observed non-human streamer, and it names itself here.
    postponeCount++
    postponeKinds[kind] = (postponeKinds[kind] ?? 0) + 1
    // Postponing is the norm and logs on every keystroke, so it carries what the
    // bare line could not answer: how long the Mac actually sat idle, and how
    // close that got the curtain. Seconds, not formatDuration -- it rounds to
    // whole minutes, which turns "9m30s idle" back into a flat "10m" and hides
    // the one number this log exists to show.
    const now = Date.now()
    const idleMs = lastInputAt ? now - lastInputAt : 0
    lastInputAt = now
    const left = coverDueAt ? Math.max(0, coverDueAt - now) : coverDelayMs
    devLog.log(
      `Away Mode: input at ${new Date(now).toLocaleTimeString()} (${kind}) — idle ` +
        `${Math.round(idleMs / 1000)}s, curtain was ${Math.round(left / 1000)}s away ` +
        `(needs ${Math.round(coverDelayMs / 1000)}s), #${postponeCount}`
    )
    armCoverTimer()
    // BOTH timers, or the grace window covers a Mac someone is working at: it
    // asks "is this Mac unattended", and a human here has just answered no.
    stopGraceTimer()
    rearmLocalInputWatch(onLocalInput)
    return
  }

  devLog.warn('Away Mode: human at the Mac — handing back and restoring the lock')
  void handback('human')
  const cb = onEndedByHuman
  onEndedByHuman = null
  if (cb) cb()
}

// Should never fire — every known path is guarded. It exists because the
// failure it catches is a black screen whose only exit is force-quit.
function reconcileCover(): void {
  if (state !== 'off' || ending) return
  if (isCurtainVisible()) {
    devLog.warn('Away Mode: cover up with no session — taking it down')
    recordJournal('cover-orphaned', { detail: 'watchdog took down a cover with no session' })
    hideCurtain()
    return
  }
  // Nothing left to guard: no session, no cover. Re-armed by the next one.
  stopCoverWatchdog()
}

// 2s: a user decides a black screen is a broken machine within a few seconds.
const COVER_WATCHDOG_MS = 2_000
let coverWatchdog: NodeJS.Timeout | null = null

function startCoverWatchdog(): void {
  if (coverWatchdog) return
  coverWatchdog = setInterval(reconcileCover, COVER_WATCHDOG_MS)
  coverWatchdog.unref?.()
}

function stopCoverWatchdog(): void {
  if (!coverWatchdog) return
  clearInterval(coverWatchdog)
  coverWatchdog = null
}

// The lock is the one event Away Mode never recorded, which is why every
// incident had to be re-derived by hand from kernel + powerd + loginwindow. Two
// causes produce the identical user report — "I came back to the Apple lock
// screen" — and this row is the only thing that tells them apart: `state=off`
// means no session was running and nothing here failed, while `state=held` with
// time still on the cover timer means the curtain genuinely lost the race.
//
// Armed at launch, NOT on a phone connect: a lock with no session behind it is
// exactly the case we cannot currently prove, so it has to be recorded too.
let lockWatchArmed = false

export function startAwayModeLockWatch(): void {
  if (lockWatchArmed) return
  lockWatchArmed = true
  powerMonitor.on('lock-screen', () => {
    const left = state === 'held' && coverDueAt ? Math.max(0, coverDueAt - Date.now()) : 0
    const detail =
      `state=${state} curtain=${isCurtainVisible() ? 'up' : 'down'} ` +
      `cover-due-in=${state === 'held' ? Math.round(left / 1000) + 's' : 'n/a'}`
    devLog.warn('Away Mode: macOS locked the screen —', detail)
    recordJournal('screen-locked', { detail })
  })
}

// Idempotent. `onEndedByHuman` fires ONLY for a human-ended session, not an
// ordinary teardown where the caller already knows.
export async function beginAwayMode(opts?: {
  onEndedByHuman?: () => void
  onCovered?: () => void
  /** Dev-only: skip the wait and cover now, so the covered state is testable
   *  without sitting idle for the user's real display-sleep delay. */
  coverDelayOverrideMs?: number
  /** Cover on this call instead of arming the timer. The deferred path treats
   *  local input as "postpone", so a user still at the keyboard pushes the
   *  cover out indefinitely — correct when the Mac decided to cover, wrong when
   *  the user pressed a button asking for it now. */
  coverImmediately?: boolean
}): Promise<{ ok: boolean; reason?: AwayModeFailure; error?: string }> {
  // Idempotent only while the state and the world agree: a session whose lock
  // came back underneath it is NOT held, and returning ok here hands the phone
  // a login window it cannot dismiss.
  // isIdleLockSuppressed() alone is a process-local cache; the blocker is the thing
  // that actually keeps the idle lock disarmed, and macOS can take it away.
  if (state !== 'off' && isIdleLockSuppressed() && isStayAwakeActive()) return { ok: true }
  if (state !== 'off') {
    devLog.warn('Away Mode: state said held but the lock is back — re-acquiring')
    await handback()
  }

  // 1. The way back, FIRST. Everything below depends on this working.
  startLocalInputWatch(onLocalInput)

  if (!isLocalInputWatchActive()) {
    // Refusing is the safe branch — see the invariant above. Surfaced to the
    // user as a real reason rather than a generic failure, because the fix
    // (grant Accessibility) is theirs to make and is actionable.
    devLog.warn('Away Mode: refusing to suspend the lock with no input watch')
    recordJournal('away-refused', { detail: 'no-input-watch — Accessibility not granted' })
    stopLocalInputWatch()
    return { ok: false, reason: 'no-input-watch' }
  }

  // 2. The capability. Unconditional, independent of the stay-awake pref the
  // user may have left off — this blocker IS what keeps the idle lock disarmed.
  // `true`: Away Mode begins from a connected phone, and a release armed here
  // would sleep the display and re-arm the very idle lock this holds off.
  startStayAwake(true)
  const hold = await suppressIdleLock()
  if (!hold.ok) {
    stopLocalInputWatch()
    // Reverse order of begin: nothing below reached handback(), which is the
    // only other release, so a blocker left here is held until the app quits.
    stopStayAwake()
    recordJournal('away-refused', {
      detail: `${hold.cancelled ? 'cancelled' : 'failed'}${hold.error ? ` — ${hold.error}` : ''}`
    })
    return {
      ok: false,
      reason: hold.cancelled ? 'cancelled' : 'failed',
      error: hold.error
    }
  }

  // 3. The room. Deferred by default because the user is very likely still
  // sitting here; immediate when they asked for it outright. Brightness is
  // deliberately left alone.
  const immediate = opts?.coverImmediately === true
  coverDelayMs = opts?.coverDelayOverrideMs ?? (await readCoverDelayMs())
  if (!immediate) armCoverTimer()

  // From begin, not from cover-up: the cover this catches is one raised by a
  // path we didn't anticipate, which by definition includes after a teardown.
  startCoverWatchdog()
  sessionStartedAt = Date.now()
  coveredAt = null
  postponeCount = 0
  postponeKinds = {}
  heldSince = Date.now()
  coverArmUntil = 0
  onEndedByHuman = opts?.onEndedByHuman ?? null
  onCovered = opts?.onCovered ?? null
  transition('hold')
  // After transition('hold'): 'cover' has no edge from 'off', and coverNow()
  // fires onCovered, which must not run before the session is on the books.
  if (immediate) {
    devLog.log('Away Mode: held — covering now, the user asked for it')
    recordJournal('away-held', { detail: 'covering immediately' })
    coverNow('user pressed Protect', { arm: true })
    return { ok: true }
  }
  devLog.log(
    `Away Mode: held — Mac unlocked for the phone, covering in ${formatDuration(coverDelayMs)}`
  )
  recordJournal('away-held', { detail: `covering in ${formatDuration(coverDelayMs)}` })
  return { ok: true }
}

/** Cover now. Never a toggle, never a lock — the Away Mode switch is the way out. */
export async function requestCoverNow(opts?: {
  onEndedByHuman?: () => void
  onCovered?: () => void
}): Promise<{ ok: boolean; reason?: AwayModeFailure; error?: string }> {
  if (state === 'covered') return { ok: true }
  if (state === 'held') {
    coverNow('user pressed Protect', { arm: true })
    return { ok: true }
  }
  return beginAwayMode({
    onEndedByHuman: opts?.onEndedByHuman,
    onCovered: opts?.onCovered,
    coverImmediately: true
  })
}

/**
 * THE ONLY RELOCK in the whole feature. Safe to call when off, so every
 * teardown path can call it unconditionally. Order is the reverse of begin on
 * purpose: NEVER uncover before the lock is back. `relock: false` skips the
 * lock — quit is a local action, not a return to a covered Mac.
 */
export async function handback(
  endedBy: 'human' | 'disconnect' = 'disconnect',
  opts?: { relock?: boolean }
): Promise<void> {
  // Not gated on state: a partially-begun session must still be cleanable, and
  // every call below is individually idempotent.
  ending = true
  // Read before cancelCurtainOnPhoneGone(), which resets it — the fact "the phone is
  // gone" has to survive to the armIdleLockRearm decision at the bottom.
  const phoneWasGone = phoneGone
  cancelCurtainOnPhoneGone()
  // Before the lock work, not after: a pending timer that fires during the
  // await below would raise a cover onto a session that is already tearing
  // down, and hideCurtain() has already run by then.
  cancelCoverTimer()

  const res = await endSessionAndLockMac(opts)
  if (!res.ok) {
    // Still a live session — the cover is deliberately up and the watch is
    // still armed, so local input must mean something again.
    ending = false
    phoneGone = phoneWasGone
    // The lock did NOT come back. Keep the cover up rather than exposing a
    // desktop on a machine that still will not lock, and leave the watch armed.
    // clearIdleLockSuppressionOnLaunch is the backstop, and Settings re-reads real state.
    devLog.error('Away Mode: lock did not restore — holding the cover up', res.error)
    recordJournal('relock-failed', { detail: res.error ?? 'relock lever failed' })
    return
  }

  hideCurtain()
  coverArmUntil = 0
  stopLocalInputWatch()
  // After hideCurtain(), so covered_s measures to the moment the screen
  // actually came back rather than to the start of the lock-restore await.
  trackAwaySession(endedBy)
  // Gated on a real session: every teardown path calls handback()
  // unconditionally, and an `away-ended` per quit would bury the real ones.
  if (state !== 'off') {
    const held = heldSince === 0 ? 0 : Math.round((Date.now() - heldSince) / 1000)
    const postponed =
      postponeCount === 0
        ? 'no postpones'
        : `${postponeCount} postpones (${postponeKindSummary()})`
    // The verdict's numbers, not just its name: `ended by human` alone cannot
    // tell a person at the keyboard from our own keystroke delivered late, and
    // that ambiguity is what made the 2026-09-08 relock take four wrong answers.
    const v = endedBy === 'human' ? lastHumanVerdict() : null
    const why = v ? ` — via ${v.detail} sinceStamp=${v.sinceStampMs}ms` : ''
    recordJournal('away-ended', {
      detail: `ended by ${endedBy} after ${held}s — ${postponed}${why}`
    })
  }
  onEndedByHuman = null
  onCovered = null
  if (state !== 'off') transition('handback')
  ending = false
  // The phone is still gone and this module no longer wants the display-sleep
  // hold — hand the blocker to stay-awake's own release countdown, or a Mac
  // handed back by a keystroke keeps its panel lit at the lock screen forever.
  if (phoneWasGone) armIdleLockRearm()
  devLog.log(
    opts?.relock === false ? 'Away Mode: handed back (no relock)' : 'Away Mode: handed back — lock restored'
  )
}

/**
 * ON EXPIRY: COVER, NEVER LOCK. A relocked Mac gives the returning phone
 * nothing, permanently. Accepted cost, the user's call: a cafe Mac stays unlocked
 * (screen black) indefinitely — a human touching it relocks instantly.
 */
export function armCurtainOnPhoneGone(): void {
  if (state === 'off') return
  phoneGone = true
  if (graceTimer) return
  graceTimer = setTimeout(() => {
    graceTimer = null
    if (ending || state !== 'held') return
    coverNow('phone gone for the grace window')
  }, CONFIG.PHONE_REMOTE.CURTAIN_ON_PHONE_GONE_MS)
}

/** Phone came back inside (or after) the grace window — stand it down. */
export function cancelCurtainOnPhoneGone(): void {
  phoneGone = false
  stopGraceTimer()
}

// Timer only, `phoneGone` untouched: a human at the Mac says nothing about
// whether the phone came back, and clearing the flag would let the next
// armCurtainOnPhoneGone() no-op on its `if (graceTimer) return` guard.
function stopGraceTimer(): void {
  if (!graceTimer) return
  clearTimeout(graceTimer)
  graceTimer = null
}
