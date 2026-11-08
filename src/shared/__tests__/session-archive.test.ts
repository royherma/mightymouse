import { describe, it, expect } from 'vitest'
import type { AgentRelaySessionInfo } from '../types'
import {
  importEntries,
  markEntry,
  marksOf,
  mergeSessionArchive,
  parseArchiveEntries,
  rememberSessions,
  sessionArchiveKey,
  type ArchiveEntries
} from '../session-archive'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const s = (id: string, extra: Partial<AgentRelaySessionInfo> = {}): AgentRelaySessionInfo =>
  ({ label: `task ${id}`, agent: 'claude', sessionId: id, ...extra }) as AgentRelaySessionInfo

const entry = (session: AgentRelaySessionInfo, extra: Partial<ArchiveEntries[string]> = {}) => ({
  [sessionArchiveKey(session)]: { archived: false, session, seenAt: NOW, ...extra }
})

describe('sessionArchiveKey', () => {
  it('uses agent + sessionId when present, so a relabelled session keeps its marks', () => {
    expect(sessionArchiveKey(s('a', { label: 'one' }))).toBe(sessionArchiveKey(s('a', { label: 'two' })))
    expect(sessionArchiveKey(s('a'))).not.toBe(sessionArchiveKey(s('a', { agent: 'codex' })))
  })
})

describe('markEntry', () => {
  it('pinning keeps archived state and first-seen time; unpinning clears the pin', () => {
    const a = s('a')
    const start = entry(a, { archived: true, seenAt: NOW - DAY })
    const pinned = markEntry(start, a, { pinned: true }, NOW)
    expect(pinned[sessionArchiveKey(a)]).toMatchObject({ archived: true, pinned: true, seenAt: NOW - DAY })
    const unpinned = markEntry(pinned, a, { pinned: false }, NOW)
    expect(unpinned[sessionArchiveKey(a)].pinned).toBeUndefined()
    expect(unpinned[sessionArchiveKey(a)].archived).toBe(true)
  })

  it('never stores the host app icon or the project image', () => {
    const a = s('a', { hostAppIconPngBase64: 'AAAA', project: { name: 'mm', icon: 'x', imageBase64: 'BBBB' } })
    const stored = markEntry({}, a, { archived: true }, NOW)[sessionArchiveKey(a)].session
    expect(stored.hostAppIconPngBase64).toBeUndefined()
    expect(stored.project).toEqual({ name: 'mm', icon: 'x' })
  })
})

describe('importEntries', () => {
  it('an import can add marks but never removes a local archive or pin', () => {
    const a = s('a')
    const b = s('b')
    const local = entry(a, { archived: true, pinned: true })
    const incoming = { ...entry(a, { archived: false, pinned: false }), ...entry(b, { archived: true }) }
    const merged = importEntries(local, incoming)
    expect(merged[sessionArchiveKey(a)]).toMatchObject({ archived: true, pinned: true })
    expect(merged[sessionArchiveKey(b)].archived).toBe(true)
  })
})

describe('rememberSessions', () => {
  it('forgets unmarked sessions older than 14 days but keeps archived and pinned ones', () => {
    const old = NOW - 15 * DAY
    const entries = {
      ...entry(s('plain'), { seenAt: old }),
      ...entry(s('arch'), { seenAt: old, archived: true }),
      ...entry(s('pin'), { seenAt: old, pinned: true }),
      ...entry(s('recent'), { seenAt: NOW - 13 * DAY })
    }
    const next = rememberSessions([], entries, NOW)!
    expect(Object.keys(next).map((k) => JSON.parse(k)[1]).sort()).toEqual(['arch', 'pin', 'recent'])
  })

  it('returns null (no write) when a live session is unchanged and was seen within the hour', () => {
    const a = s('a', { lastActivityAt: NOW - 1000 })
    expect(rememberSessions([a], entry(a, { seenAt: NOW - 30 * 60 * 1000 }), NOW)).toBeNull()
  })

  it('rewrites when activity moved by a minute or more', () => {
    const before = s('a', { lastActivityAt: NOW - 120_000 })
    const after = s('a', { lastActivityAt: NOW - 30_000 })
    const next = rememberSessions([after], entry(before, { seenAt: NOW - 60_000, pinned: true }), NOW)!
    expect(next[sessionArchiveKey(after)]).toMatchObject({ seenAt: NOW, pinned: true, session: { lastActivityAt: NOW - 30_000 } })
  })

  it('does not record stale rows or sessions with no id', () => {
    const noId = { label: 'x', agent: 'claude', cwd: '/tmp' } as AgentRelaySessionInfo
    expect(rememberSessions([s('a', { stale: true }), noId], {}, NOW)).toBeNull()
  })

  it('strips a project image left in an older archive', () => {
    const a = s('a', { project: { name: 'mm', imageBase64: 'BIG' } })
    const next = rememberSessions([], entry(a), NOW)!
    expect(next[sessionArchiveKey(a)].session.project).toEqual({ name: 'mm', icon: undefined })
  })
})

describe('mergeSessionArchive / marksOf', () => {
  it('live rows win; remembered-only rows come back ended and cannot be wrapped up', () => {
    const live = s('a', { label: 'live label' })
    const gone = s('b')
    const out = mergeSessionArchive([live], { ...entry(s('a', { label: 'old label' })), ...entry(gone) })
    expect(out).toEqual([live, { ...gone, stale: true, canWrapUp: false }])
  })

  it('marksOf lists only archived or pinned entries', () => {
    const marks = marksOf({ ...entry(s('a')), ...entry(s('b'), { pinned: true }), ...entry(s('c'), { archived: true }) })
    expect(marks).toEqual({
      [sessionArchiveKey(s('b'))]: { archived: undefined, pinned: true },
      [sessionArchiveKey(s('c'))]: { archived: true, pinned: undefined }
    })
  })
})

describe('parseArchiveEntries', () => {
  it('rejects arrays and malformed entries so a bad import file cannot wipe the archive', () => {
    expect(() => parseArchiveEntries([])).toThrow()
    expect(() => parseArchiveEntries(null)).toThrow()
    expect(() => parseArchiveEntries({ k: { archived: 'yes', session: { label: 'x' } } })).toThrow()
    expect(() => parseArchiveEntries({ k: { archived: false, session: {} } })).toThrow()
    expect(parseArchiveEntries(entry(s('a')))).toEqual(entry(s('a')))
  })
})
