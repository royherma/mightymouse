import type { AgentRelaySessionInfo, SessionMark, SessionMarks } from './types'

export const LEGACY_ARCHIVE_STORAGE_KEY = 'mm.relay.sessions.archive.v1'
const REMEMBER_MS = 14 * 24 * 60 * 60 * 1000
const SEEN_REFRESH_MS = 60 * 60 * 1000
const ACTIVITY_REFRESH_MS = 60 * 1000

export type ArchiveEntry = {
  archived: boolean
  pinned?: boolean
  session: AgentRelaySessionInfo
  seenAt?: number
}
export type ArchiveEntries = Record<string, ArchiveEntry>

export function sessionArchiveKey(session: AgentRelaySessionInfo): string {
  return JSON.stringify(
    session.sessionId
      ? [session.agent, session.sessionId]
      : [session.agent, session.cwd, session.stated ?? session.label, session.since]
  )
}

export function parseArchiveEntries(value: unknown): ArchiveEntries {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archive')
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry.archived !== 'boolean' || typeof entry.session?.label !== 'string') {
      throw new Error('Invalid archive entry')
    }
  }
  return value as ArchiveEntries
}

function stored(session: AgentRelaySessionInfo): AgentRelaySessionInfo {
  const project = session.project && { name: session.project.name, icon: session.project.icon }
  return { ...session, project, hostAppIconPngBase64: undefined }
}

export function markEntry(
  entries: ArchiveEntries,
  session: AgentRelaySessionInfo,
  change: SessionMark,
  now: number
): ArchiveEntries {
  const key = sessionArchiveKey(session)
  const previous = entries[key]
  return {
    ...entries,
    [key]: {
      archived: change.archived ?? previous?.archived ?? false,
      pinned: (change.pinned ?? previous?.pinned) || undefined,
      session: stored(session),
      seenAt: previous?.seenAt ?? now
    }
  }
}

export function importEntries(current: ArchiveEntries, incoming: ArchiveEntries): ArchiveEntries {
  const next = { ...current }
  for (const [key, entry] of Object.entries(incoming)) {
    const mine = next[key]
    next[key] = mine
      ? { ...mine, archived: mine.archived || entry.archived, pinned: mine.pinned || entry.pinned || undefined }
      : { ...entry, session: stored(entry.session) }
  }
  return next
}

function sameSnapshot(previous: AgentRelaySessionInfo, snapshot: AgentRelaySessionInfo): boolean {
  const activityDrift = (snapshot.lastActivityAt ?? 0) - (previous.lastActivityAt ?? 0)
  if (Math.abs(activityDrift) >= ACTIVITY_REFRESH_MS) return false
  return (
    JSON.stringify({ ...previous, lastActivityAt: undefined }) ===
    JSON.stringify({ ...snapshot, lastActivityAt: undefined })
  )
}

export function rememberSessions(
  live: AgentRelaySessionInfo[],
  entries: ArchiveEntries,
  now: number
): ArchiveEntries | null {
  let changed = false
  const next: ArchiveEntries = {}
  for (const [key, entry] of Object.entries(entries)) {
    if (
      !entry.archived &&
      !entry.pinned &&
      entry.seenAt !== undefined &&
      now - entry.seenAt > REMEMBER_MS
    )
      changed = true
    else if (entry.session.project?.imageBase64) {
      next[key] = { ...entry, session: stored(entry.session) }
      changed = true
    } else next[key] = entry
  }
  for (const session of live) {
    if (!session.sessionId || session.stale) continue
    const key = sessionArchiveKey(session)
    const previous = next[key]
    const snapshot = stored(session)
    const same = previous && sameSnapshot(previous.session, snapshot)
    if (same && previous.seenAt !== undefined && now - previous.seenAt < SEEN_REFRESH_MS) continue
    next[key] = {
      archived: previous?.archived ?? false,
      pinned: previous?.pinned,
      session: snapshot,
      seenAt: now
    }
    changed = true
  }
  return changed ? next : null
}

export function mergeSessionArchive(
  live: AgentRelaySessionInfo[],
  entries: ArchiveEntries
): AgentRelaySessionInfo[] {
  const known = new Map(live.map((session) => [sessionArchiveKey(session), session]))
  for (const [key, entry] of Object.entries(entries)) {
    if (!known.has(key)) known.set(key, { ...entry.session, stale: true, canWrapUp: false })
  }
  return [...known.values()]
}

export function marksOf(entries: ArchiveEntries): SessionMarks {
  const marks: SessionMarks = {}
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.archived || entry.pinned) marks[key] = { archived: entry.archived || undefined, pinned: entry.pinned }
  }
  return marks
}
