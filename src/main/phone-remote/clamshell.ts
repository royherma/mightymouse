/**
 * Clamshell mode — keep the Mac awake with the LID CLOSED, so Phone Remote
 * still reaches it after you shut the laptop.
 *
 * Thing #4 of the five "locks" (the list is in idle-lock-suppressor.ts), and
 * the odd one out: it is about SLEEP, not the password screen. Nothing here
 * locks or unlocks anything.
 *
 * This is the escalated sibling of stay-awake.ts. That module holds an Electron
 * powerSaveBlocker, which stops IDLE sleep but is powerless against a lid close:
 * macOS sleeps on clamshell regardless of any userspace assertion. The only
 * lever that actually survives a lid close is:
 *
 *     sudo pmset -a disablesleep 1
 *
 * ...and that is a MACHINE-WIDE setting that OUTLIVES THIS PROCESS. If we set it
 * and crash, the Mac never sleeps again -- lid shut, in a bag, cooking. The user
 * consented to "stay awake while I'm using the remote", not "stay awake
 * forever": their consent is scoped to a process that can die without warning.
 *
 * So the entire design here is REVERT, in three independent layers. Any ONE of
 * them is sufficient; all three exist because they fail in different ways:
 *
 *   1. Explicit revert  — toggle-off, remote stop, sign-out, app quit.
 *                         Covers every ORDERLY exit.
 *   2. Launch revert    — clearReleasedFlagOnLaunch() runs unconditionally at
 *                         startup, BEFORE anything can set the flag again. If we
 *                         crashed while holding it, reopening the app heals the
 *                         machine. This is the layer that covers SIGKILL.
 *   3. Disconnect watchdog — if the phone goes away and doesn't come back within
 *                         CLAMSHELL_REVERT_MS, drop the flag. Covers "user
 *                         walked away and never reopened the app", which layer 2
 *                         alone would miss until the next launch.
 *
 * Layer 2 is the load-bearing one and the reason this is shippable at all.
 *
 * sudo: Electron can't prompt for a password, so the escalation goes through
 * osascript's `with administrator privileges`, which shows the standard macOS
 * auth dialog. The user sees a system-signed prompt naming the command. If they
 * cancel, we treat it as a clean "no" and leave the pref off -- never a retry
 * loop, never a silent failure.
 */
import { exec } from 'child_process'
import { devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'

/**
 * Shell-level truth for the flag.
 *
 * MUST be `pmset -g`, NOT `pmset -g custom`. This bit us for real: `-g custom`
 * prints the SAVED power PROFILE, where `disablesleep` never appears — while the
 * flag itself is LIVE RUNTIME state that surfaces only in plain `pmset -g`, and
 * under a different name: `SleepDisabled`. Reading `-g custom` therefore reports
 * "off" on a machine that genuinely has sleep disabled, which silently breaks
 * the revert: disableClamshell() sees nothing held, no-ops, and leaves the Mac
 * permanently awake. Exactly the failure every layer here exists to prevent.
 */
const PMSET_READ = 'pmset -g'
// The WRITE verb is `disablesleep`; the READ key is `SleepDisabled`. Same flag,
// two different spellings in pmset's own interface.
const DISABLESLEEP_KEY = 'SleepDisabled'

// `-a` = all power sources. Deliberate: a laptop that sleeps the moment it's
// unplugged would make the feature feel broken exactly when it's most useful
// (lid shut, on battery, remote-controlled).
const PMSET_SET = 'pmset -a disablesleep 1'
const PMSET_UNSET = 'pmset -a disablesleep 0'

const EXEC_TIMEOUT_MS = 15_000

// In-process mirror of the flag. Only ever a CACHE -- every decision that
// matters re-reads the real state via isSystemSleepDisabled(), because another
// app (or the user in Terminal) can change it behind our back.
let held = false

/** Watchdog timer armed while the phone is disconnected but the flag is held. */
let idleRevertTimer: NodeJS.Timeout | null = null

function run(cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * Run one command as root via the macOS auth dialog. Returns `cancelled` so the
 * caller can distinguish "user said no" (leave the pref off, say nothing) from
 * "it broke" (surface a reason) -- conflating them produces either a nag loop or
 * a silent no-op, and both read as a bug.
 */
async function runAsRoot(cmd: string): Promise<{ ok: boolean; cancelled: boolean; error?: string }> {
  // Single-quote the inner command for AppleScript. The command strings here are
  // module constants (never user input), so this is escaping for correctness,
  // not a sanitization boundary.
  const script = `do shell script "${cmd}" with administrator privileges`
  const res = await run(`osascript -e '${script}'`)
  if (res.ok) return { ok: true, cancelled: false }

  // osascript reports a user-cancelled auth dialog as -128.
  const cancelled = /User cancell?ed|-128/i.test(res.stderr)
  return { ok: false, cancelled, error: res.stderr.trim() || 'pmset failed' }
}

/** True if the machine currently has sleep disabled, read from pmset itself. */
export async function isSystemSleepDisabled(): Promise<boolean> {
  const res = await run(PMSET_READ)
  if (!res.ok) return false
  // Absent ⇒ off. Present ⇒ parse the trailing 0/1 rather than assuming that
  // merely appearing means enabled.
  const line = res.stdout.split('\n').find((l) => l.includes(DISABLESLEEP_KEY))
  if (!line) return false
  // `pmset -g` prints ` SleepDisabled\t\t1`. Match the value AFTER the key
  // rather than testing the whole line for a "1" — the neighbouring
  // `Sleep On Power Button 1` line would otherwise read as a false positive.
  return /SleepDisabled\s+1\b/.test(line)
}

/**
 * LAYER 2 -- the crash guard. Called unconditionally at app launch, before any
 * code path can turn clamshell back on.
 *
 * Rationale: if the flag is set at startup, this process did not release it,
 * because a fresh process holds nothing. Either we crashed while holding it, or
 * something else set it. Both cases resolve the same safe way: clear it and let
 * the user opt back in deliberately. We never silently RESTORE clamshell on
 * launch -- that would recreate the exact "consent outlived the session" problem
 * this module exists to prevent.
 *
 * Silent when there's nothing to clear (the overwhelmingly common case), and it
 * never prompts for a password unless a stale flag is actually found.
 */
export async function revertClamshellOnLaunch(): Promise<void> {
  held = false
  if (!(await isSystemSleepDisabled())) return

  devLog.warn('Clamshell: stale disablesleep found at launch — reverting')
  const res = await runAsRoot(PMSET_UNSET)
  if (!res.ok) {
    // Don't nag: one warning, and Settings will show the true state on open.
    devLog.error('Clamshell: failed to revert stale flag', res.error)
  }
}

/**
 * Enable clamshell. Prompts for admin once. Idempotent: if the flag is already
 * set (e.g. the user set it by hand) we adopt it rather than prompting again.
 */
export async function enableClamshell(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  cancelIdleRevert()

  if (await isSystemSleepDisabled()) {
    held = true
    return { ok: true }
  }

  const res = await runAsRoot(PMSET_SET)
  if (!res.ok) {
    held = false
    return { ok: false, cancelled: res.cancelled, error: res.error }
  }

  // Trust pmset's own report over the exit code -- a 0 exit with the flag unset
  // would otherwise leave us believing the lid is safe when it isn't.
  held = await isSystemSleepDisabled()
  if (!held) return { ok: false, error: 'pmset reported success but the flag is not set' }

  devLog.log('Clamshell: system sleep disabled')
  return { ok: true }
}

/**
 * LAYER 1 -- explicit revert. Safe to call when nothing is held (the usual case
 * on quit), so callers never have to guard it.
 *
 * Re-reads real state first so a no-op stays silent: without that check, every
 * quit would fire an admin prompt for a flag we never set.
 */
export async function disableClamshell(): Promise<{ ok: boolean; error?: string }> {
  cancelIdleRevert()

  if (!(await isSystemSleepDisabled())) {
    held = false
    return { ok: true }
  }

  const res = await runAsRoot(PMSET_UNSET)
  held = res.ok ? false : await isSystemSleepDisabled()
  if (!res.ok) {
    devLog.error('Clamshell: failed to re-enable system sleep', res.error)
    return { ok: false, error: res.error }
  }

  devLog.log('Clamshell: system sleep restored')
  return { ok: true }
}

/**
 * LAYER 3 -- the disconnect watchdog. Armed when the phone drops while clamshell
 * is held: if it doesn't return within the grace window, revert.
 *
 * The grace window matters -- phones drop off Wi-Fi constantly (screen lock, a
 * lift out of a pocket). Reverting on the first disconnect would make the
 * feature useless; never reverting would strand a closed laptop awake forever.
 */
let agentsWorking: () => boolean = () => false

export function setClamshellAgentProbe(fn: () => boolean): void {
  agentsWorking = fn
}

export function armIdleRevert(): void {
  if (!held || idleRevertTimer) return
  idleRevertTimer = setTimeout(function revertWhenIdle() {
    if (agentsWorking()) {
      idleRevertTimer = setTimeout(revertWhenIdle, CONFIG.PHONE_REMOTE.CLAMSHELL_AGENT_RECHECK_MS)
      return
    }
    idleRevertTimer = null
    devLog.warn('Clamshell: phone gone too long — reverting system sleep')
    void disableClamshell()
  }, CONFIG.PHONE_REMOTE.CLAMSHELL_REVERT_MS)
}

/** Phone came back (or clamshell was turned off) — stand the watchdog down. */
export function cancelIdleRevert(): void {
  if (!idleRevertTimer) return
  clearTimeout(idleRevertTimer)
  idleRevertTimer = null
}

/** Cached view of whether THIS process believes it holds the flag. */
export function isClamshellHeld(): boolean {
  return held
}
