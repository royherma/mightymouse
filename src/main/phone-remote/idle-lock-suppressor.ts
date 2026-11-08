/**
 * Idle-lock suppressor — owns TWO of the five different things this feature
 * calls a "lock". Naming them apart is not cosmetic: sharing the word "lock"
 * is how a reversible one got tuned like a one-way one and locked the user out of
 * his own Mac. The five, and who owns each:
 *
 *   1. THE MACOS IDLE LOCK — the password screen macOS arms after the screen
 *      saver. THIS MODULE suppresses it. Nothing is written to the system:
 *      stay-awake.ts's display-sleep blocker means the screen saver never
 *      starts, so the lock never arms. suppressIdleLock() only records that we
 *      are responsible for it. We PREVENT the lock arming; we cannot defeat one
 *      already engaged (SecurityAgent refuses third-party code) — which is
 *      exactly why letting it arm is unrecoverable from the phone.
 *   2. LOCKING THE MAC ON PURPOSE — endSessionAndLockMac() below, via
 *      SACLockScreenImmediate. A ONE-WAY DOOR: the phone can never undo it.
 *      Nothing here fires on a timer; away-mode.ts decides when, this module
 *      only knows how.
 *   3. THE PRIVACY CURTAIN — privacy-curtain.ts. A black overlay. The Mac stays
 *      unlocked underneath and the phone keeps working through it. Reversible,
 *      and therefore the SAFE reaction to a phone that went away.
 *   4. LID CLOSED — clamshell.ts, `pmset disablesleep`. Machine-wide, survives
 *      this process, nothing to do with the password screen.
 *   5. "IS THE MAC LOCKED RIGHT NOW" — host-status.ts's macAtPasswordScreen.
 *      Read-only observation from powerMonitor, pushed to the phone so it can
 *      show "type your password on the Mac". Reports state, never changes it.
 */
import { exec } from 'child_process'
import { devLog } from '../../shared/env'
import { isStayAwakeActive } from './stay-awake'

const EXEC_TIMEOUT_MS = 15_000

// SACLockScreenImmediate is a private login.framework symbol. A renamed symbol
// exits 3 — loud failure is correct here, better than silently not relocking.
const RELOCK_SWIFT =
  'import Foundation;' +
  'let h=dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/A/login",RTLD_NOW);' +
  'typealias F=@convention(c)()->Void;' +
  'guard let h=h,let s=dlsym(h,"SACLockScreenImmediate") else{exit(3)};' +
  'unsafeBitCast(s,to:F.self)()'

// A cache of what THIS process believes, never the source of truth about the OS.
let held = false

function run(cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

// False means the lever failed — the caller must keep the cover up rather than
// expose an unlocked desktop.
async function lockScreenNow(): Promise<boolean> {
  const res = await run(`swift -e '${RELOCK_SWIFT}'`)
  if (!res.ok) devLog.error('Lock hold: SACLockScreenImmediate failed', res.stderr.trim())
  return res.ok
}

// Nothing to reconcile at launch — a crash left only a dead blocker, so the idle
// lock re-armed itself. Kept exported so every revert layer has a launch story.
export async function clearIdleLockSuppressionOnLaunch(): Promise<void> {
  held = false
}

// Refuses without stay-awake: that blocker IS the hold, so claiming one without
// it would let the Mac lock mid-session while the phone believes it's protected.
export async function suppressIdleLock(): Promise<{
  ok: boolean
  cancelled?: boolean
  error?: string
}> {
  if (!isStayAwakeActive()) {
    held = false
    return { ok: false, error: 'display-sleep hold not active — cannot keep the Mac unlocked' }
  }

  held = true
  devLog.log(
    'Idle-lock suppressor: holding the Mac unlocked for a phone session (the display-sleep blocker keeps macOS from arming its idle lock)'
  )
  return { ok: true }
}

/**
 * End the session and LOCK THE MAC. This is thing #2 above: a one-way door the
 * phone cannot reopen, so it is only ever called from away-mode.ts's handback.
 * Safe to call when nothing is suppressed. `relock: false` is the quit path --
 * stop suppressing WITHOUT locking, because a user sitting at their own Mac
 * must not have it locked out from under them on app exit.
 */
export async function endSessionAndLockMac(opts?: {
  relock?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  if (!held) return { ok: true }

  if (opts?.relock === false) {
    held = false
    devLog.log('Idle-lock suppressor: released without locking the Mac')
    return { ok: true }
  }

  const locked = await lockScreenNow()
  if (!locked) {
    // The lock did NOT engage. Keep `held` true so the cover stays up and a
    // retry stays possible rather than exposing an unlocked desktop.
    return { ok: false, error: 'relock lever failed' }
  }

  held = false
  devLog.log('Idle-lock suppressor: Mac locked, suppression released')
  return { ok: true }
}

/**
 * True while THIS process is suppressing the macOS idle lock (thing #1). Note
 * the direction: true means the Mac is being kept UNLOCKED, not that it is
 * locked. A process-local cache, never the source of truth about the OS -- the
 * live display-sleep blocker is (see away-mode.ts's re-entry check).
 */
export function isIdleLockSuppressed(): boolean {
  return held
}
