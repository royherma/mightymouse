import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { TranscriptSession } from '../agent-relay/session-transcript'

const h = vi.hoisted(() => ({ home: '' }))
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => h.home }))
vi.mock('../store/mighty', () => ({ MIGHTY: { readSessions: () => [] } }))

h.home = mkdtempSync(join(tmpdir(), 'mm-nav-sessions-'))
afterAll(() => rmSync(h.home, { recursive: true, force: true }))

const { searchConversations } = await import('../navigator-search')

const SINCE = 1_800_000_000_000
const OC_CWD = '/Users/dev/garden'
const CLAUDE_CWD = '/Users/dev/kitchen'
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'

const dir = join(h.home, '.local', 'share', 'opencode')
mkdirSync(dir, { recursive: true })
const db = new Database(join(dir, 'opencode.db'))
db.exec(`create table session (id text, directory text, parent_id text, time_created integer);
  create table message (id text, session_id text, time_created integer, data text);
  create table part (id text, message_id text, session_id text, time_created integer, data text);`)
db.prepare('insert into session values (?, ?, ?, ?)').run('oc', OC_CWD, null, SINCE)
const ocSay = (id: string, role: string, part: object): void => {
  db.prepare('insert into message values (?, ?, ?, ?)').run(id, 'oc', SINCE + Number(id.slice(1)), JSON.stringify({ role }))
  db.prepare('insert into part values (?, ?, ?, ?, ?)').run(`${id}p`, id, 'oc', SINCE, JSON.stringify(part))
}
ocSay('m1', 'user', { type: 'text', text: 'Water the tomatoes every morning' })
ocSay('m2', 'assistant', { type: 'text', text: 'Added a sprinkler schedule.' })
ocSay('m3', 'assistant', { type: 'tool', tool: 'bash', state: { input: { command: 'crontab -l | grep marigoldvault' } } })
db.close()

const claudeDir = join(h.home, '.claude', 'projects', CLAUDE_CWD.replace(/[/_.]/g, '-'))
mkdirSync(claudeDir, { recursive: true })
const line = (type: string, text: string): string => JSON.stringify({ type, timestamp: '2026-11-20T10:00:00.000Z', message: { role: type, content: [{ type: 'text', text }] } })
writeFileSync(
  join(claudeDir, `${CLAUDE_ID}.jsonl`),
  [line('user', 'Bake sourdough with rye flour'), line('assistant', 'Proof it in a banneton basket'), ...Array.from({ length: 80 }, (_, i) => line(i % 2 ? 'assistant' : 'user', `step ${i}`))].join('\n') + '\n'
)

const sessions: Record<string, TranscriptSession> = {
  '%5': { cwd: OC_CWD, since: SINCE, facts: { agent: 'OpenCode' } },
  [CLAUDE_ID]: { cwd: CLAUDE_CWD, sessionId: CLAUDE_ID, facts: { agent: 'Claude Code' } },
  '%6': { cwd: '/Users/dev/empty', since: SINCE, facts: { agent: 'OpenCode' } }
}
const resolve = (ref: string): TranscriptSession | undefined => sessions[ref]
const refs = [
  { id: 'session:%5', sessionId: '%5', cwd: OC_CWD },
  { id: `session:${CLAUDE_ID}`, sessionId: CLAUDE_ID, cwd: CLAUDE_CWD },
  { id: 'session:%6', sessionId: '%6', cwd: '/Users/dev/empty' }
]

describe('navigator search over agent sessions', () => {
  it('with no query, names each session by its first message, skipping sessions with none', async () => {
    expect(await searchConversations('', refs, resolve)).toEqual([
      { id: 'session:%5', title: 'Water the tomatoes every morning', snippet: null },
      { id: `session:${CLAUDE_ID}`, title: 'Bake sourdough with rye flour', snippet: null }
    ])
  })

  it('finds a session with no id (OpenCode, by its pane) by what was said, under its first-message title', async () => {
    const hits = await searchConversations('sprinkler', refs, resolve)
    expect(hits.map((x) => [x.id, x.title])).toEqual([['session:%5', 'Water the tomatoes every morning']])
    expect(hits[0].snippet?.text).toContain('sprinkler schedule')
  })

  it('does not match words that only appear in a tool call', async () => {
    expect(await searchConversations('marigoldvault', refs, resolve)).toEqual([])
  })

  it('searches the whole Claude transcript, past the 60 turns the chat view keeps', async () => {
    const hits = await searchConversations('banneton', refs, resolve)
    expect(hits.map((x) => x.id)).toEqual([`session:${CLAUDE_ID}`])
  })

  it('without a resolver, an id-less session is simply not searched', async () => {
    expect(await searchConversations('sprinkler', refs)).toEqual([])
  })
})
