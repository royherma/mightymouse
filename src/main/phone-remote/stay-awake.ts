/**
 * Keep the Mac's display awake while Phone Remote is in use.
 *
 * Why this exists: Phone Remote drives the cursor from an iPhone over the LAN.
 * If the display sleeps mid-session the remote looks broken — input still lands,
 * but the user can't see what they're steering. macOS gives no signal that a
 * *remote* input source is active (uiohook synthesizes events rather than
 * generating real HID activity), so nothing resets the idle timer on its own.
 *
 * Why powerSaveBlocker and not `caffeinate` / `pmset`: it's built into Electron
 * (no subprocess, no sudo), and the OS releases the block automatically if the
 * app dies. `sudo pmset disablesleep 1` would also survive a lid close, but it's
 * a machine-wide setting that OUTLIVES a crash — leave it set and the Mac never
 * sleeps again, hot in a bag. That tradeoff isn't worth it for display-sleep.
 *
 * Leak-safety is the whole design here. A blocker that's started and never
 * stopped means the display never sleeps until the app quits, which is a battery
 * bug the user would blame on macOS, not on us. Three guarantees:
 *   1. Single owner — the module holds at most ONE blocker id, ever. start() is
 *      idempotent, so a double-start can't orphan the first id (the leak you get
 *      from tracking blockers in a list).
 *   2. Tied to the server lifecycle — start() runs where the phone-remote server
 *      starts, stop() where it stops (including app quit). Server off ⇒ blocker
 *      off, with no third state to get stuck in.
 *   3. No-phone watchdog — the server lifecycle alone is NOT enough, because
 *      the blocker is held from the moment Phone Remote is enabled (measured
 *      twice: 7m48s, then 1h11m on 2026-08-14, `pmset -g assertions`).
 *      armIdleLockRearm() must be armed from BOTH edges: the disconnect one
 *      alone covers only phones that once connected, never a server nobody
 *      paired with. cancelIdleLockRearm() stands it down when a phone arrives.
 *
 * Why a grace window and not a hard stop on disconnect: phones drop off Wi-Fi
 * constantly (screen lock, pocket). Releasing on the first blip would sleep the
 * display mid-session, which is the exact failure this module exists to prevent.
 *
 * ONCE A DEVICE IS PAIRED, THE WATCHDOG DOES NOT ARM AT ALL. No window is
 * correct here, because nothing about elapsed time says whether the user still
 * wants in: a phone in a pocket is disconnected (WebKit drops the socket on
 * visibilitychange), and so is a phone in another country a week later. Both
 * look identical at the socket, and guessing wrong costs the user their Mac --
 * the display sleeps, macOS's idle lock arms, and the phone can no longer get
 * in. So the block is released by STATE, never by a clock: the stay-awake
 * toggle going off, the server stopping, or the app quitting. All three are
 * explicit user acts, and all three already call stopStayAwake().
 *
 * The watchdog survives for the one case it was written for: stay-awake on with
 * NOTHING EVER PAIRED -- a server holding the display awake for a phone that
 * does not exist. There is no session to strand there, so the 10m window caps
 * the battery leak (measured 7m48s, then 1h11m on 2026-08-14).
 *
 * NEVER ARM THE WATCHDOG WHILE AWAY MODE IS HELD. Releasing the blocker lets the
 * display sleep, which re-arms macOS's idle lock, which locks out the very phone
 * Away Mode exists to serve. away-mode.ts owns the phone-gone reaction there.
 */
import { powerSaveBlocker } from 'electron'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'

// electron's powerSaveBlocker ids are non-negative ints; -1 = "none held".
const NO_BLOCKER = -1

let blockerId = NO_BLOCKER
let graceReleaseTimer: NodeJS.Timeout | null = null

// Defaults to 0 so an unwired process behaves like the old unpaired path (the
// watchdog still caps the battery leak) rather than silently never releasing.
let pairedCountSource: () => number = () => 0

/** Wire the paired-device count in. Called once from the phone-remote startup. */
export function setPairedDeviceCountSource(fn: () => number): void {
  pairedCountSource = fn
}

function readPairedCount(): number {
  try {
    return pairedCountSource()
  } catch {
    // A credential store that cannot be read is not proof of "nothing paired".
    // Fail toward holding the block: the cost is battery, the alternative is
    // locking the user out of the Mac their phone is the only way into.
    return 1
  }
}

/**
 * Block display sleep. Idempotent: calling it while a blocker is already held
 * is a no-op rather than a second (orphaned) blocker.
 *
 * 'prevent-display-sleep' keeps the screen on; it implies system sleep is
 * blocked too. The weaker 'prevent-app-suspension' is deliberately NOT used —
 * it lets the display sleep, which is the exact failure we're fixing.
 *
 * `phoneConnected` is REQUIRED because every caller fires on a server or pref
 * event, never a phone one — so false arms guarantee 3's countdown.
 */
export function startStayAwake(phoneConnected: boolean): void {
  if (blockerId !== NO_BLOCKER && powerSaveBlocker.isStarted(blockerId)) return

  try {
    blockerId = powerSaveBlocker.start('prevent-display-sleep')
    devLog.log('Phone Remote: display sleep blocked', blockerId)
  } catch (err) {
    // Non-fatal: the remote still works, the screen just sleeps on idle. Never
    // let a power-management failure take down the server that depends on it.
    devLog.error('Phone Remote: failed to block display sleep', err)
    blockerId = NO_BLOCKER
  }

  // After the start: armIdleLockRearm() no-ops without a live blocker.
  if (!phoneConnected) armIdleLockRearm()
}

/**
 * Release the block and let macOS resume normal power behavior. Safe to call
 * when nothing is held (the common case on app quit with the remote off), so
 * callers never have to guard it.
 */
export function stopStayAwake(): void {
  // Always clear the watchdog, even with nothing held: an armed timer that
  // outlives its blocker would fire into a later session and release a block
  // the user had just legitimately re-acquired.
  cancelIdleLockRearm()
  if (blockerId === NO_BLOCKER) return

  try {
    // isStarted() guards the case where the OS already tore the blocker down
    // (e.g. after a forced sleep) — stopping a dead id throws on some versions.
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    devLog.log('Phone Remote: display sleep released', blockerId)
  } catch (err) {
    devLog.error('Phone Remote: failed to release display sleep', err)
  } finally {
    // Cleared even if stop() threw: a stale id would make the idempotence check
    // in startStayAwake() skip a real start, silently disabling the feature.
    blockerId = NO_BLOCKER
  }
}

/**
 * Phone dropped — start the countdown to releasing the display block.
 *
 * No-op unless a blocker is actually held, so an ordinary disconnect with
 * stay-awake off costs nothing. Callers must not arm this while Away Mode is
 * held — see the module comment.
 */
export function armIdleLockRearm(): void {
  if (blockerId === NO_BLOCKER || graceReleaseTimer) return

  // A paired device means a real session to protect, and no elapsed time tells
  // us it ended -- a pocketed phone and an abandoned one are the same socket
  // state. Releasing on any window hands the Mac to macOS's idle lock, which
  // the phone cannot undo (SecurityAgent refuses third-party code, see
  // idle-lock-suppressor.ts). The toggle, the server and app quit release it instead.
  //
  // The count is INJECTED, not imported: device-credentials reaches
  // server-runtime, whose module graph runs `join(PATHS.BIN, …)` at load, so a
  // static import here breaks any suite that loads stay-awake without mocking
  // half the server. setPairedDeviceCountSource() is wired once at startup.
  if (readPairedCount() > 0) return

  graceReleaseTimer = setTimeout(() => {
    graceReleaseTimer = null
    devLog.warn('Phone Remote: nothing paired — releasing display sleep block')
    stopStayAwake()
  }, CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS)
}

/** Phone came back (or the block was released) — stand the watchdog down. */
export function cancelIdleLockRearm(): void {
  if (!graceReleaseTimer) return
  clearTimeout(graceReleaseTimer)
  graceReleaseTimer = null
}

/** True while a display-sleep block is held. Exposed for tests + Settings. */
export function isStayAwakeActive(): boolean {
  return blockerId !== NO_BLOCKER && powerSaveBlocker.isStarted(blockerId)
}
