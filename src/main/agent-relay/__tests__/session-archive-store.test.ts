import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AgentRelaySessionInfo } from '../../../shared/types'
import { sessionArchiveKey } from '../../../shared/session-archive'

const dir = mkdtempSync(join(tmpdir(), 'mm-session-archive-'))
const file = join(dir, 'archive.json')
vi.mock('../../store/paths', () => ({ PATHS: { AGENT_RELAY_SESSION_ARCHIVE: file } }))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const HOUR = 60 * 60 * 1000
const named = (id: string, stated: string, extra: Partial<AgentRelaySessionInfo> = {}): AgentRelaySessionInfo =>
  ({ label: `proj - ${id}`, stated, agent: 'claude', sessionId: id, cwd: '/w/proj', since: Date.now() - HOUR, ...extra }) as AgentRelaySessionInfo
const unnamed = (id: string): AgentRelaySessionInfo =>
  ({ label: 'proj', agent: 'claude', sessionId: id, cwd: '/w/proj', since: Date.now() - HOUR }) as AgentRelaySessionInfo

async function freshStore(seed: AgentRelaySessionInfo[], seenAt = Date.now()) {
  const entries = Object.fromEntries(seed.map((session) => [sessionArchiveKey(session), { archived: false, session, seenAt }]))
  writeFileSync(file, JSON.stringify(entries))
  vi.resetModules()
  return import('../session-archive')
}

const savedIds = (): string[] =>
  Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, { session: { sessionId: string } }>).map((e) => e.session.sessionId).sort()

describe('the saved list of ended agents', () => {
  it('saves named agents and leaves unnamed background runs out', async () => {
    const store = await freshStore([])
    store.withRememberedSessions([named('real', 'Fix login'), unnamed('bg-1'), unnamed('bg-2')])
    expect(savedIds()).toEqual(['real'])
  })

  it('drops unnamed runs an older version already saved, on the next save', async () => {
    const store = await freshStore([named('kept', 'Fix login'), unnamed('old-bg-1'), unnamed('old-bg-2')])
    store.withRememberedSessions([named('new', 'New work')])
    expect(savedIds()).toEqual(['kept', 'new'])
  })

  it('keeps an unnamed agent the user pinned', async () => {
    const store = await freshStore([])
    store.withRememberedSessions([unnamed('bg-pinned')])
    store.markSession(unnamed('bg-pinned'), { pinned: true })
    store.withRememberedSessions([named('other', 'Other work')])
    expect(savedIds()).toEqual(['bg-pinned', 'other'])
  })
})

describe('rememberedSession', () => {
  it('finds an ended agent by its session id, ended at the time it was last seen', async () => {
    const seenAt = Date.now() - 2 * HOUR
    const store = await freshStore([named('s-1', 'Fix login')], seenAt)
    expect(store.rememberedSession('s-1')).toMatchObject({ sessionId: 's-1', cwd: '/w/proj', staleSince: seenAt, facts: { agent: 'claude' } })
  })

  it('finds one by name only when exactly one agent carries it', async () => {
    const store = await freshStore([named('s-1', 'Fix login'), named('s-2', 'Fix signup'), named('s-3', 'Fix signup')])
    expect(store.rememberedSession('Fix login')?.sessionId).toBe('s-1')
    expect(store.rememberedSession('proj - s-2')?.sessionId).toBe('s-2')
    expect(store.rememberedSession('Fix signup')).toBeUndefined()
    expect(store.rememberedSession('nobody')).toBeUndefined()
  })
})
