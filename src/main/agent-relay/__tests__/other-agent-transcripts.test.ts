import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { readOpencodeTranscript } from '../opencode-transcript'
import { readCursorTranscript } from '../cursor-transcript'
import { readSessionTranscript } from '../session-transcript'

const roots: string[] = []
const newHome = (): string => {
  const h = mkdtempSync(join(tmpdir(), 'mm-other-tx-'))
  roots.push(h)
  return h
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

const CWD = '/Users/dev/shop'
const SINCE = 1_800_000_000_000

function opencodeDb(home: string): Database.Database {
  const dir = join(home, '.local', 'share', 'opencode')
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'opencode.db'))
  db.exec(`create table session (id text, directory text, parent_id text, time_created integer);
    create table message (id text, session_id text, time_created integer, data text);
    create table part (id text, message_id text, session_id text, time_created integer, data text);`)
  return db
}
const say = (db: Database.Database, session: string, id: string, at: number, info: object, parts: object[]): void => {
  db.prepare('insert into message values (?, ?, ?, ?)').run(id, session, at, JSON.stringify(info))
  parts.forEach((p, i) => db.prepare('insert into part values (?, ?, ?, ?, ?)').run(`${id}-p${i}`, id, session, at + i, JSON.stringify(p)))
}
const opencode = (since = SINCE) => ({ cwd: CWD, since, facts: { agent: 'OpenCode' } })

describe('readOpencodeTranscript', () => {
  it("reads the top-level session in this folder that started closest to the agent's start", () => {
    const home = newHome()
    const db = opencodeDb(home)
    const add = db.prepare('insert into session values (?, ?, ?, ?)')
    add.run('too-old', CWD, null, SINCE - 120_000)
    add.run('earlier', CWD, null, SINCE - 40_000)
    add.run('mine', CWD, null, SINCE + 2_000)
    add.run('subagent', CWD, 'mine', SINCE + 1)
    add.run('other-folder', '/Users/dev/blog', null, SINCE)
    for (const s of ['too-old', 'earlier', 'mine', 'subagent', 'other-folder']) say(db, s, `${s}-m`, SINCE, { role: 'user' }, [{ type: 'text', text: `from ${s}` }])
    db.close()
    expect(readOpencodeTranscript(opencode(), home)?.map((t) => t.text)).toEqual(['from mine'])
  })

  it('turns text, tool and error parts into turns, skipping synthetic text', () => {
    const home = newHome()
    const db = opencodeDb(home)
    db.prepare('insert into session values (?, ?, ?, ?)').run('s', CWD, null, SINCE)
    say(db, 's', 'm1', SINCE + 10, { role: 'user' }, [
      { type: 'text', text: '  add a cart page  ' },
      { type: 'text', text: 'file contents the harness attached', synthetic: true }
    ])
    say(db, 's', 'm2', SINCE + 20, { role: 'assistant' }, [
      { type: 'text', text: 'On it.' },
      { type: 'tool', tool: 'bash', state: { input: { command: 'npm   run\nbuild' } } },
      { type: 'tool', tool: 'todowrite', state: { input: {} } }
    ])
    say(db, 's', 'm3', SINCE + 30, { role: 'assistant', error: { name: 'ProviderAuthError', data: { message: 'No API key for openrouter' } } }, [])
    db.close()
    expect(readOpencodeTranscript(opencode(), home)).toEqual([
      { role: 'you', at: SINCE + 10, text: 'add a cart page' },
      { role: 'agent', at: SINCE + 20, text: 'On it.' },
      { role: 'tool', at: SINCE + 20, text: 'bash: npm run build' },
      { role: 'tool', at: SINCE + 20, text: 'todowrite' },
      { role: 'agent', at: SINCE + 30, text: 'No API key for openrouter' }
    ])
  })

  it('is not asked for a non-OpenCode agent, and is empty when OpenCode has no database', () => {
    expect(readOpencodeTranscript({ cwd: CWD, since: SINCE, facts: { agent: 'Claude Code' } }, newHome())).toBeUndefined()
    expect(readOpencodeTranscript(opencode(), newHome())).toEqual([])
  })

  it('a long OpenCode chat keeps its opening ask plus the latest 60 turns', () => {
    const home = newHome()
    const db = opencodeDb(home)
    db.prepare('insert into session values (?, ?, ?, ?)').run('long', CWD, null, SINCE)
    for (let i = 0; i < 70; i++) say(db, 'long', `m${String(i).padStart(3, '0')}`, SINCE + i, { role: i % 2 ? 'assistant' : 'user' }, [{ type: 'text', text: `turn ${i}` }])
    db.close()
    const turns = readSessionTranscript(opencode(), home).map((t) => t.text)
    expect(turns).toHaveLength(61)
    expect(turns[0]).toBe('turn 0')
    expect(turns[1]).toBe('turn 10')
    expect(turns.at(-1)).toBe('turn 69')
  })
})

const hexJson = (o: object): string => Buffer.from(JSON.stringify(o)).toString('hex')
function cursorChat(home: string, cwd: string, chat: string, createdAt: number, messages: object[]): void {
  const dir = join(home, '.cursor', 'chats', createHash('md5').update(cwd).digest('hex'), chat)
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'store.db'))
  db.exec('create table meta (key text, value text); create table blobs (id text, data blob);')
  const ids = messages.map((m, i) => {
    const id = createHash('sha256').update(`${chat}:${i}`).digest()
    db.prepare('insert into blobs values (?, ?)').run(id.toString('hex'), Buffer.from(JSON.stringify(m)))
    return id
  })
  const root = Buffer.concat([Buffer.from([0x10, 0x05]), ...ids.map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), id]))])
  db.prepare('insert into blobs values (?, ?)').run('root', root)
  db.prepare('insert into meta values (?, ?)').run('0', hexJson({ latestRootBlobId: 'root', createdAt }))
  db.close()
}
const cursor = (cwd = CWD, agent = 'Cursor') => ({ cwd, since: SINCE, facts: { agent } })

describe('readCursorTranscript', () => {
  it("reads the newest chat in the folder's md5 bucket that started after the agent", () => {
    const home = newHome()
    cursorChat(home, CWD, 'stale', SINCE - 600_000, [{ role: 'user', content: 'yesterday' }])
    cursorChat(home, CWD, 'first', SINCE + 1_000, [{ role: 'user', content: 'first ask' }])
    cursorChat(home, CWD, 'newest', SINCE + 5_000, [{ role: 'user', content: 'newest ask' }])
    cursorChat(home, '/Users/dev/blog', 'elsewhere', SINCE + 9_000, [{ role: 'user', content: 'blog ask' }])
    expect(readCursorTranscript(cursor(), home)?.map((t) => t.text)).toEqual(['newest ask'])
    expect(readCursorTranscript(cursor('/Users/dev/blog'), home)?.map((t) => t.text)).toEqual(['blog ask'])
  })

  it('takes the user_query out of the wrapped prompt, drops injected context, keeps replies and tools', () => {
    const home = newHome()
    const at = SINCE + 1_000
    cursorChat(home, CWD, 'c', at, [
      { role: 'system', content: 'You are Cursor.' },
      { role: 'user', content: [{ type: 'text', text: '<user_info>os: darwin</user_info>' }] },
      { role: 'user', content: [{ type: 'text', text: '<attached>x</attached>\n<user_query>\n  fix the checkout total\n</user_query>' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking at cart.ts.' }, { type: 'tool-call', toolName: 'read_file', args: { target_file: 'src/cart.ts' } }, { type: 'tool-call', toolName: 'todo' }] },
      { role: 'user', content: 'plain follow-up' }
    ])
    expect(readCursorTranscript(cursor(), home)).toEqual([
      { role: 'you', at: at + 2, text: 'fix the checkout total' },
      { role: 'agent', at: at + 3, text: 'Looking at cart.ts.' },
      { role: 'tool', at: at + 3, text: 'read_file · src/cart.ts' },
      { role: 'tool', at: at + 3, text: 'todo' },
      { role: 'you', at: at + 4, text: 'plain follow-up' }
    ])
  })

  it('is not asked for another named agent, and finds nothing before any chat exists', () => {
    const home = newHome()
    cursorChat(home, CWD, 'c', SINCE + 1_000, [{ role: 'user', content: 'hi' }])
    expect(readCursorTranscript(cursor(CWD, 'Codex'), home)).toBeUndefined()
    expect(readCursorTranscript(cursor(), newHome())).toBeUndefined()
  })
})
