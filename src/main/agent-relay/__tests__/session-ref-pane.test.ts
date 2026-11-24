import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSession } from '../mcp/http-listener'
import { isPaneOf, nameFromMessage, sessionRef } from '../../../shared/relay-status'

const h = vi.hoisted(() => ({ sessions: [] as AgentSession[] }))
vi.mock('../mcp/http-listener', () => ({
  listedAgentSessions: () => h.sessions,
  resolveSessionId: (ref: string) => h.sessions.find((s) => s.sessionId === ref)?.sessionId,
  forgetAgentSession: () => {}
}))
vi.mock('../picker-keys', () => ({ sendPaneText: async () => 'skipped' }))
vi.mock('../../analytics', () => ({ track: () => {} }))

const { resolveSessionRef } = await import('../session-control')

const agent = (label: string, pane: string, extra: Partial<AgentSession> = {}): AgentSession =>
  ({ label, since: 1, cwd: '/w/app', origin: { tmuxPane: pane }, facts: {}, ...extra }) as unknown as AgentSession

beforeEach(() => {
  h.sessions = []
})

describe('resolveSessionRef by terminal pane', () => {
  it('picks the one live agent in that pane among six sharing a label', () => {
    h.sessions = ['%1', '%2', '%3', '%4', '%5', '%6'].map((p) => agent('app/main', p))
    expect(resolveSessionRef('%4')?.origin?.tmuxPane).toBe('%4')
    expect(resolveSessionRef('app/main')).toBeUndefined()
  })

  it('ignores an ended agent that used to own the pane', () => {
    h.sessions = [agent('app/main', '%7', { staleSince: 5 }), agent('app/main', '%7', { since: 9 })]
    expect(resolveSessionRef('%7')?.since).toBe(9)
  })

  it('refuses when two live agents claim the same pane', () => {
    h.sessions = [agent('a', '%8'), agent('b', '%8')]
    expect(resolveSessionRef('%8')).toBeUndefined()
  })

  it('a pane ref never falls through to a label that happens to look like one', () => {
    h.sessions = [agent('%9', '%10')]
    expect(resolveSessionRef('%9')).toBeUndefined()
  })

  it('a session id still wins over everything', () => {
    h.sessions = [agent('a', '%11', { sessionId: 'abc-123' }), agent('b', '%12')]
    expect(resolveSessionRef('abc-123')?.label).toBe('a')
  })
})

describe('sessionRef / isPaneOf', () => {
  const info = (o: Record<string, unknown>) => ({ label: 'app/main', stale: false, ...o }) as Parameters<typeof sessionRef>[0]

  it('id, then stated name, then live pane, then label', () => {
    expect(sessionRef(info({ sessionId: 'id1', stated: 'fix', origin: { tmuxPane: '%1' } }))).toBe('id1')
    expect(sessionRef(info({ stated: 'fix', origin: { tmuxPane: '%1' } }))).toBe('fix')
    expect(sessionRef(info({ origin: { tmuxPane: '%1' } }))).toBe('%1')
    expect(sessionRef(info({ stale: true, origin: { tmuxPane: '%1' } }))).toBe('app/main')
    expect(sessionRef(info({ origin: { tmuxPane: '' } }))).toBe('app/main')
  })

  it('matches only a live session on exactly that pane', () => {
    expect(isPaneOf(info({ origin: { tmuxPane: '%3' } }), '%3')).toBe(true)
    expect(isPaneOf(info({ origin: { tmuxPane: '%3' } }), '%30')).toBe(false)
    expect(isPaneOf(info({ stale: true, origin: { tmuxPane: '%3' } }), '%3')).toBe(false)
    expect(isPaneOf(info({ label: 'x', origin: { tmuxPane: 'x' } }), 'x')).toBe(false)
    expect(isPaneOf(info({ origin: { tmuxPane: '%3' } }), null)).toBe(false)
  })
})

describe('nameFromMessage skips harness tags', () => {
  it.each([
    '<command-name>/clear</command-name>',
    '<local-command-stdout></local-command-stdout>',
    '<task-notification><task-id>b1</task-id></task-notification>',
    '<system-reminder>rules</system-reminder>'
  ])('%s is not a title', (text) => {
    expect(nameFromMessage(text)).toBeUndefined()
  })

  it('a message that mentions a tag later is still a title', () => {
    expect(nameFromMessage('why does <command-name> leak')).toBe('why does <command-name> leak')
  })
})
