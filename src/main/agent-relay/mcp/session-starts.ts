/**
 * When each agent session actually started, across app restarts.
 *
 * `since` is the terminal's start time, and the in-memory reclaim that carries it
 * over a reconnect expires after GRACE_MS (30s) -- which is right for "was that a
 * blip", and wrong for `since` itself. A `make restart` is offline for longer than
 * the window, so every surviving agent reconnected with `since = Date.now()` and
 * the list claimed a four-hour session had just started. The tell was a row whose
 * "waiting on you" clock was LARGER than its age, because the wait stamp lives in
 * the request store and did survive.
 *
 * So the start time gets a small file of its own, keyed by the same reclaim key
 * the in-memory path uses. It is a cache, not state: a miss just means a session
 * starts its clock now, which is the old behavior.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from '../../store/paths'
import { devLog } from '../../../shared/env'

/** Bounded so an ever-growing file can't outlive the sessions it describes.
 *  Well above the ~35 concurrent sessions seen in practice. */
const MAX_ENTRIES = 500

/** A session nobody has seen for this long is gone for good, not restarting.
 *  Generous because the whole point is surviving a Mac that was off overnight. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

type Row = { since: number; seen: number }

let rows: Map<string, Row> | null = null

function load(): Map<string, Row> {
  if (rows) return rows
  const loaded = new Map<string, Row>()
  try {
    if (existsSync(PATHS.AGENT_RELAY_SESSION_STARTS)) {
      const parsed = JSON.parse(readFileSync(PATHS.AGENT_RELAY_SESSION_STARTS, 'utf8')) as Record<
        string,
        Row
      >
      const cutoff = Date.now() - TTL_MS
      for (const [key, row] of Object.entries(parsed)) {
        // Trust nothing off disk: a hand-edited or truncated file must degrade to
        // "no record", never to a NaN that renders as an Invalid Date.
        if (typeof row?.since !== 'number' || !Number.isFinite(row.since)) continue
        const seen = typeof row.seen === 'number' && Number.isFinite(row.seen) ? row.seen : row.since
        if (seen < cutoff) continue
        loaded.set(key, { since: row.since, seen })
      }
    }
  } catch (err) {
    // A corrupt cache must never block a session from registering -- losing a
    // start time costs an accurate age, which is the status quo it replaced.
    devLog.warn('[agent-relay] could not read session starts, starting empty', err)
  }
  rows = loaded
  return loaded
}

function persist(list: Map<string, Row>): void {
  // Evict oldest-seen first so a burst of short-lived sessions can't push out the
  // long-running ones, which are precisely the sessions this exists for.
  if (list.size > MAX_ENTRIES) {
    const ordered = [...list.entries()].sort((a, b) => a[1].seen - b[1].seen)
    for (const [key] of ordered.slice(0, list.size - MAX_ENTRIES)) list.delete(key)
  }
  try {
    writeFileSync(PATHS.AGENT_RELAY_SESSION_STARTS, JSON.stringify(Object.fromEntries(list)), {
      mode: 0o600
    })
  } catch (err) {
    devLog.warn('[agent-relay] could not persist session starts', err)
  }
}

/**
 * The recorded start for this key, or undefined if there is none.
 *
 * Also refreshes the TTL: a session being looked up is a session still connecting,
 * so the entry is alive regardless of how long ago it started.
 */
export function recallSessionStart(key: string): number | undefined {
  const list = load()
  const row = list.get(key)
  if (!row) return undefined
  row.seen = Date.now()
  persist(list)
  return row.since
}

/**
 * Record where a session's clock started, and mark it seen now.
 *
 * Deliberately last-write-wins: the CALLER decides what `since` means, by
 * recalling before it remembers. Refusing a rewrite here would look like the
 * safer rule and would instead pin a reused key -- a fresh agent in a checkout
 * some earlier session used -- to a start time that is not its own.
 */
export function rememberSessionStart(key: string, since: number): void {
  const list = load()
  list.set(key, { since, seen: Date.now() })
  persist(list)
}

/** Test seam: drop the in-memory copy so the next call re-reads the file. */
export function _resetSessionStarts(): void {
  rows = null
}
