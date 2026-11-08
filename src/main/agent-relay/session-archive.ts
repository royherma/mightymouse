import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AgentRelaySessionInfo, SessionMark, SessionMarks } from '../../shared/types'
import type { AgentSession } from './mcp/http-listener'
import {
  importEntries,
  markEntry,
  marksOf,
  mergeSessionArchive,
  parseArchiveEntries,
  rememberSessions,
  type ArchiveEntries,
  type ArchiveEntry
} from '../../shared/session-archive'
import { PATHS } from '../store/paths'
import { sessionsWorthListing } from '../../shared/relay-sessions'

// Every status broadcast carries these rows to each surface, the phone included.
const ENDED_SHOWN = 80
const ENDED_KEPT = 500

let cache: ArchiveEntries | null = null

function entries(): ArchiveEntries {
  if (cache) return cache
  try {
    cache = parseArchiveEntries(JSON.parse(readFileSync(PATHS.AGENT_RELAY_SESSION_ARCHIVE, 'utf8')))
  } catch {
    cache = {}
  }
  return cache
}

function newestFirst(entries: ArchiveEntries): [string, ArchiveEntry][] {
  return Object.entries(entries).sort(([, a], [, b]) => (b.seenAt ?? 0) - (a.seenAt ?? 0))
}

function keepNewest(entries: ArchiveEntries, limit: number): ArchiveEntries {
  let unmarked = 0
  return Object.fromEntries(
    newestFirst(entries).filter(([, e]) => e.archived || e.pinned || unmarked++ < limit)
  )
}

function listable(all: ArchiveEntries): ArchiveEntries {
  const worth = new Set(sessionsWorthListing(Object.values(all).map((e) => e.session), marksOf(all), true))
  return Object.fromEntries(Object.entries(all).filter(([, e]) => worth.has(e.session)))
}

function save(all: ArchiveEntries): void {
  const next = keepNewest(listable(all), ENDED_KEPT)
  cache = next
  const tmp = `${PATHS.AGENT_RELAY_SESSION_ARCHIVE}.tmp`
  writeFileSync(tmp, JSON.stringify(next))
  renameSync(tmp, PATHS.AGENT_RELAY_SESSION_ARCHIVE)
}

export function withRememberedSessions(listed: AgentRelaySessionInfo[]): {
  sessions: AgentRelaySessionInfo[]
  marks: SessionMarks
} {
  const worthKeeping = sessionsWorthListing(listed, marksOf(entries()), true)
  const next = rememberSessions(worthKeeping, entries(), Date.now())
  if (next) save(next)
  const all = entries()
  return { sessions: mergeSessionArchive(listed, keepNewest(listable(all), ENDED_SHOWN)), marks: marksOf(all) }
}

export function rememberedSession(ref: string): AgentSession | undefined {
  const all = Object.values(entries())
  const named = all.filter((e) => e.session.label === ref || e.session.stated === ref)
  const hit = all.find((e) => e.session.sessionId === ref) ?? (named.length === 1 ? named[0] : undefined)
  if (!hit) return undefined
  const { label, stated, cwd, sessionId, agent, since, staleSince } = hit.session
  const ended = staleSince ?? hit.seenAt ?? since ?? 0
  return { label, stated, cwd, sessionId, since: since ?? ended, staleSince: ended, facts: { agent } }
}

export function markSession(session: AgentRelaySessionInfo, change: SessionMark): void {
  save(markEntry(entries(), session, change, Date.now()))
}

export function importSessionArchive(incoming: unknown): void {
  save(importEntries(entries(), parseArchiveEntries(incoming)))
}
