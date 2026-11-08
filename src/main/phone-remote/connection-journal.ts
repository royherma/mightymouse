/**
 * A durable, release-build-safe record of what happened between a phone and
 * this Mac.
 *
 * `devLog` answers "what is happening" for whoever is at the keyboard right
 * now. It is `IS_DEV`-only and the dev log is truncated on every restart, so it
 * cannot answer the question a pairing bug actually asks: *what happened on the
 * attempt BEFORE the restart that fixed it*. A failure that a restart clears
 * leaves no evidence at all, which is exactly the shape that is hardest to
 * chase and the shape users report.
 *
 * So this is a small ring buffer on disk, written in packaged builds too. It is
 * deliberately NOT the dev log: no per-frame chatter, no input events -- only
 * the handful of transitions that decide whether a phone can talk to the Mac.
 *
 * Privacy: a credential never lands here, only its `deviceIdFor` hash, on the
 * same reasoning as `listPairedDevices`. The file is a debugging aid the user
 * may well paste into a bug report, so it must stay safe to share.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from '../store/paths'
import { devLog } from '../../shared/env'

/**
 * What happened. A closed set rather than free text so the log can be scanned
 * and counted -- "how many times did this phone get evicted" is the question
 * that distinguishes a kick war from a genuine auth failure.
 */
export type JournalEvent =
  /** A socket authorized and became the active session. */
  | 'connected'
  /** The active session ended. `detail` carries the WS close code. */
  | 'disconnected'
  /** A socket was refused at the handshake. `detail` says which credential and why. */
  | 'rejected'
  /** This socket displaced a previous live session -- the single-socket kick. */
  | 'evicted-previous'
  /** A pairing code was exchanged for a durable device credential. */
  | 'paired'
  /** A device credential was revoked. */
  | 'revoked'
  /** Per-IP limiter refused the attempt before auth ran. */
  | 'rate-limited'
  /** The paired-device file exists but could not be read, so every credential
   *  looked invalid. Distinct from `revoked` on purpose: nobody unpaired
   *  anything, and a phone seeing this must KEEP its credential. */
  | 'cred-load-failed'
  /** Away Mode took the hold: the Mac is deliberately running unlocked. */
  | 'away-held'
  /** Away Mode refused to suspend the lock. `detail` is the AwayModeFailure. */
  | 'away-refused'
  /** The privacy curtain went up. `detail` is the trigger that raised it. */
  | 'covered'
  /** Away Mode handed back. `detail`'s postpone breakdown is the only way to
   *  spot input that isn't a person. */
  | 'away-ended'
  /** The relock lever failed, so the cover is deliberately still up. */
  | 'relock-failed'
  /** The watchdog found a cover with no session behind it and took it down. */
  | 'cover-orphaned'
  /** A second device joined WATCHING instead of evicting the controller. The
   *  one entry that tells a two-device session apart from a kick war. */
  | 'joined-as-viewer'
  /** The mirror picture stopped. `detail` is the named cause.
   *
   *  Here rather than in devLog because this is the question a cursorless host
   *  cannot answer for itself: losing the picture re-arms "See your Mac here?",
   *  so a reload during development and a real ICE failure produce the IDENTICAL
   *  prompt. devLog is IS_DEV-only and truncated by `make restart`, which erases
   *  exactly the attempt you restarted to investigate. */
  | 'mirror-ended'
  /** An attempt that failed on the PHONE. Arrives over POST /connect-log as
   *  soon as the Mac refuses the WS (reachable-but-refused), or over the WS
   *  itself on the next onopen as a fallback. `detail` is the phone's formatted
   *  outcome. */
  | 'phone-attempt'
  /** macOS locked the screen. The ONE row that says whether a lock happened
   *  with a session behind it: `detail` carries the Away Mode state, whether the
   *  curtain was up, and how much of the cover delay was left. Without it a lock
   *  with no session and a curtain that lost the race to the idle lock look
   *  identical in every log we keep, and each incident gets re-derived by hand
   *  from kernel + powerd + loginwindow. */
  | 'screen-locked'
  /** Where a notification tap landed. `detail` is `<outcome>: <request id>`.
   *  Journalled because the Mac sends a push and hears nothing back, so the
   *  phone is the only side that can say which failure it was. */
  | 'relay-tap'

export type JournalEntry = {
  at: number
  event: JournalEvent
  /** Hashed device id when known. Null before a credential is presented. */
  deviceId: string | null
  /** Human-readable device label when known, e.g. "iPhone (PWA)". */
  label: string | null
  /** Short machine-readable cause. Never a secret, never a full UA. */
  detail: string | null
}

/**
 * Enough history to span several reconnect cycles plus the restart that
 * "fixed" it, and small enough to read in one screen and to rewrite on every
 * append without the write cost mattering.
 */
const MAX_ENTRIES = 200

let entries: JournalEntry[] | null = null

function load(): JournalEntry[] {
  if (entries) return entries
  let loaded: JournalEntry[] = []
  try {
    if (existsSync(PATHS.PHONE_REMOTE_JOURNAL)) {
      const parsed = JSON.parse(readFileSync(PATHS.PHONE_REMOTE_JOURNAL, 'utf8')) as JournalEntry[]
      if (Array.isArray(parsed)) loaded = parsed
    }
  } catch (err) {
    // A corrupt journal must never block pairing -- it is a diagnostic, not
    // state anything depends on. Start fresh and keep going.
    devLog.warn('[phone-remote] could not read connection journal, starting empty', err)
  }
  entries = loaded
  return loaded
}

/**
 * Append one transition. Best-effort on purpose: this is called from the WS
 * handshake path, and a disk error here must not be able to refuse a phone
 * that would otherwise have connected.
 */
export function recordJournal(
  event: JournalEvent,
  fields: { deviceId?: string | null; label?: string | null; detail?: string | null } = {}
): void {
  const list = load()
  list.push({
    at: Date.now(),
    event,
    deviceId: fields.deviceId ?? null,
    label: fields.label ?? null,
    detail: fields.detail ?? null
  })
  // Trim in place so the in-memory copy and the file never disagree about
  // which entries survived.
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  try {
    writeFileSync(PATHS.PHONE_REMOTE_JOURNAL, JSON.stringify(list), { mode: 0o600 })
  } catch (err) {
    devLog.warn('[phone-remote] could not persist connection journal', err)
  }
}

/** Newest last, ready to print. Used by the IPC handler behind `make phone-log`. */
export function readJournal(): JournalEntry[] {
  return [...load()]
}
