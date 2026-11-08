/**
 * How long an app switch takes to actually appear on the glasses.
 *
 * The symptom this exists to measure: settled quality is good, but switching
 * apps at the Mac is slow to paint. Every knob in the mirror was previously
 * judged by how it FELT in the seconds after a change, which is how a jitter
 * target got raised on reasoning rather than numbers and had to be reverted.
 * So the fix direction gets a number first, and every change after is judged
 * against it.
 *
 * WHY THE MAC TIMES BOTH ENDS. The obvious design -- phone stamps the frame,
 * Mac stamps the onset, subtract -- measures clock skew as much as latency: the
 * two devices' clocks are unrelated and neither is disciplined against the
 * other. Instead the Mac sends a probe id, the viewer echoes that id back on its
 * next PAINTED frame, and the subtraction happens against one clock that never
 * left the Mac. The cost is one network hop of the echo, which is bounded by rtt
 * and reported alongside rather than hidden.
 *
 * What the number therefore means: onset -> the frame was painted on the glasses
 * -> the echo got back. It OVERSTATES paint latency by roughly half an rtt. That
 * is the honest direction to be wrong in for a target of "well under 1s", and
 * the rtt is already in the BENCH line next to it.
 *
 * Diagnostic only, and dev-only at the call site. Nothing reads it back at
 * runtime.
 */

import { devLog } from '../../shared/env'
import { recordMirrorSwitch } from './mirror-tuning-ledger'
import type { UserInputSource } from '../../shared/types'

/** A probe older than this is abandoned unanswered rather than matched.
 *
 *  8s because the symptom being measured is multi-second: a 2s window would
 *  silently drop exactly the worst switches, which are the ones the number
 *  exists to catch. Only bounds memory -- a slow switch is still reported. */
const PROBE_TIMEOUT_MS = 8_000

/** Ignore a second onset within this window of a live probe.
 *
 *  An app switch fires one activation, but a switch INTO a busy app (Chrome on a
 *  feed) keeps changing the screen afterwards, and each of those would otherwise
 *  open a probe that measures a repaint already in flight rather than the
 *  switch. First one wins until it is answered or times out. */
const PROBE_COALESCE_MS = 1_000

interface Probe {
  id: number
  at: number
  source: UserInputSource
}

let nextId = 1
let pending: Probe | null = null

/** Cleared on mirror stop: a probe outliving its session would match an echo
 *  from the NEXT one and report a latency across a reconnect. */
export function resetSwitchLatency(): void {
  pending = null
}

/** Called at motion onset. Returns the probe id to send to the viewer, or null
 *  when this onset should not be measured. */
export function beginSwitchProbe(source: UserInputSource, now: number = Date.now()): number | null {
  if (pending && now - pending.at < PROBE_COALESCE_MS) return null
  // A probe that timed out is abandoned rather than answered late -- otherwise
  // the next switch's echo would match it and report the gap between two
  // unrelated switches as one enormous latency.
  if (pending && now - pending.at >= PROBE_TIMEOUT_MS) {
    devLog.log(`[mirror] SWITCH probe=${pending.id} unanswered after ${PROBE_TIMEOUT_MS}ms`)
    pending = null
  }
  if (pending) return null
  const id = nextId++
  pending = { id, at: now, source }
  return id
}

/** The viewer painted a frame carrying this probe id. Returns the measured ms,
 *  or null if the id is stale/unknown (a late echo after a timeout, or an echo
 *  from a previous mirror session). */
export function completeSwitchProbe(id: number, now: number = Date.now()): number | null {
  if (!pending || pending.id !== id) return null
  const ms = now - pending.at
  const source = pending.source
  pending = null
  if (ms > PROBE_TIMEOUT_MS) return null
  const line = `SWITCH ${source} onset->first-paint = ${ms}ms`
  devLog.log(`[mirror] ${line}`)
  // Outlives the dev log, which `make restart` truncates -- the whole point is
  // comparing this build's number against the last one's.
  recordMirrorSwitch(line, ms, source)
  return ms
}
