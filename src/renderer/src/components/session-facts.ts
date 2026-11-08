import type { AgentTranscriptTurn } from '../../../shared/types'

/** The session sheet's time strings, in their own file so the rail and the
 *  thread can both read them without importing each other. */

/** Exact rather than the card's coarse "5m": the card answers "new or
 *  long-running", this answers "how long exactly", which is the reason someone
 *  opened it. */
export function exactUptime(since: number | undefined, now: number): string | undefined {
  if (!since) return undefined
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  const mins = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)
  if (secs < 60) return `${secs}s`
  if (mins < 60) return `${mins}m ${secs % 60}s`
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The wall-clock birth of the session, to the second. Locale-formatted rather
 *  than ISO: this row is read by a person placing the session against their own
 *  afternoon, not parsed by anything. */
export function startedAt(since: number | undefined): string | undefined {
  if (!since) return undefined
  return new Date(since).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** Coarse and short, because it sits at the end of a line it must not wrap. */
export function shortWhen(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export function lastMessageAt(
  turns: readonly AgentTranscriptTurn[],
  role: 'you' | 'agent'
): number | undefined {
  let latest: number | undefined
  for (const turn of turns) {
    if (turn.role !== role || !turn.text.trim() || !Number.isFinite(turn.at) || turn.at <= 0) continue
    if (latest === undefined || turn.at > latest) latest = turn.at
  }
  return latest
}
