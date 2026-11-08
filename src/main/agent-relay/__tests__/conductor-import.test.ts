import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => H.home }))

import { continueConductorWorkspace, listConductorWorkspaces } from '../conductor-import'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mm-conductor-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sql = (db: string, text: string): void => {
  execFileSync('/usr/bin/sqlite3', [db, text])
}
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
const assistant = (...blocks: Array<{ type: string; text?: string }>): string => JSON.stringify({ message: { content: blocks } })

let n = 0
let db = ''
function freshHome(schema: 'full' | 'old' = 'full'): string {
  n++
  H.home = join(root, `home-${n}`)
  const dir = join(H.home, 'Library', 'Application Support', 'com.conductor.app')
  mkdirSync(dir, { recursive: true })
  db = join(dir, 'conductor.db')
  sql(db, 'CREATE TABLE repos (id TEXT, name TEXT, root_path TEXT);')
  sql(
    db,
    schema === 'full'
      ? 'CREATE TABLE workspaces (id TEXT, repository_id TEXT, city_name TEXT, directory_name TEXT, branch TEXT, archived INTEGER, updated_at TEXT, active_session_id TEXT);'
      : 'CREATE TABLE workspaces (id TEXT, repository_id TEXT, city_name TEXT);'
  )
  sql(db, 'CREATE TABLE session_messages (session_id TEXT, role TEXT, content TEXT, created_at TEXT);')
  return H.home
}

function message(session: string, role: string, content: string, at: string): void {
  sql(db, `INSERT INTO session_messages VALUES (${q(session)}, ${q(role)}, ${q(content)}, ${q(at)});`)
}

function gitRepo(path: string, branch: string): void {
  mkdirSync(path, { recursive: true })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL') delete env[key]
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.com', '-c', 'commit.gpgsign=false', ...args], { cwd: path, env, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'base')
  git('branch', branch)
}

beforeEach(() => {
  H.home = join(root, 'nobody')
})

describe('listConductorWorkspaces', () => {
  it('reads each workspace: title from the first thing you typed, its own folder, ISO time, message count', async () => {
    const home = freshHome()
    const repoRoot = join(root, `repo-${n}`)
    const own = join(home, 'conductor', 'workspaces', 'shop', 'lisbon')
    mkdirSync(own, { recursive: true })
    sql(db, `INSERT INTO repos VALUES ('r1', 'shop', ${q(repoRoot)});`)
    sql(db, `INSERT INTO workspaces VALUES ('w1', 'r1', 'Lisbon', 'lisbon', 'roy/checkout', 0, '2026-11-01 09:30:00', 's1');`)
    sql(db, `INSERT INTO workspaces VALUES ('w2', 'r1', 'Oslo', 'oslo', 'roy/old', 1, '2026-10-01 08:00:00', 's2');`)
    message('s1', 'user', `  Fix the checkout total ${'x'.repeat(100)}\nsecond line`, '2026-11-01 09:00:00')
    message('s1', 'assistant', assistant({ type: 'text', text: 'On it' }), '2026-11-01 09:01:00')
    message('s1', 'user', 'later ask', '2026-11-01 09:02:00')
    expect(await listConductorWorkspaces()).toEqual([
      {
        id: 'w1',
        title: `Fix the checkout total ${'x'.repeat(100)}`.slice(0, 80),
        repo: 'shop',
        branch: 'roy/checkout',
        cwd: own,
        archived: false,
        updatedAt: '2026-11-01T09:30:00Z',
        messages: 3
      },
      { id: 'w2', title: 'oslo', repo: 'shop', branch: 'roy/old', cwd: repoRoot, archived: true, updatedAt: '2026-10-01T08:00:00Z', messages: 0 }
    ])
  })

  it('an older Conductor schema with missing columns still lists, named by city', async () => {
    freshHome('old')
    sql(db, `INSERT INTO repos VALUES ('r1', 'shop', '/x');`)
    sql(db, `INSERT INTO workspaces VALUES ('w1', 'r1', 'Lima');`)
    expect(await listConductorWorkspaces()).toEqual([
      { id: 'w1', title: 'lima', repo: 'shop', branch: '', cwd: '/x', archived: false, updatedAt: '', messages: 0 }
    ])
  })

  it('no Conductor on this Mac is an empty list', async () => {
    expect(await listConductorWorkspaces()).toEqual([])
  })
})

describe('continueConductorWorkspace', () => {
  const started: Array<Record<string, unknown>> = []
  const start = async (input: Record<string, unknown>): Promise<{ ok: true; pane: string }> => {
    started.push(input)
    return { ok: true, pane: '%9' }
  }
  beforeEach(() => {
    started.length = 0
  })

  it('starts a Claude agent with the end of the old chat, oldest first, text only', async () => {
    freshHome()
    const repoRoot = join(root, `repo-${n}`)
    mkdirSync(repoRoot, { recursive: true })
    sql(db, `INSERT INTO repos VALUES ('r1', 'shop', ${q(repoRoot)});`)
    sql(db, `INSERT INTO workspaces VALUES ('w1', 'r1', 'Lisbon', 'gone-dir', 'roy/checkout', 0, '2026-11-01 09:30:00', 's1');`)
    message('s1', 'user', 'Fix the total', '2026-11-01 09:00:00')
    message('s1', 'assistant', assistant({ type: 'tool_use' }), '2026-11-01 09:01:00')
    message('s1', 'assistant', assistant({ type: 'text', text: 'Found it' }, { type: 'text', text: 'Fixed' }, { type: 'tool_use' }), '2026-11-01 09:02:00')
    message('s1', 'assistant', 'plain text the parser cannot read', '2026-11-01 09:03:00')
    message('s1', 'user', 'Thanks', '2026-11-01 09:04:00')
    message('other', 'user', 'not this chat', '2026-11-01 09:05:00')
    expect(await continueConductorWorkspace('w1', start)).toEqual({ ok: true, pane: '%9' })
    expect(started).toEqual([
      {
        project: 'shop',
        cwd: repoRoot,
        harness: 'claude',
        inApp: true,
        message: [
          'This continues a Conductor workspace on branch roy/checkout.',
          'Here is the end of the old chat:\n\nYou: Fix the total\n\nAssistant: Found it\nFixed\n\nYou: Thanks',
          'Pick up where this left off.'
        ].join('\n\n')
      }
    ])
  })

  it('tells the agent to switch branch when it lands in the main repo folder and the branch exists there', async () => {
    freshHome()
    const repoRoot = join(root, `repo-${n}`)
    gitRepo(repoRoot, 'roy/checkout')
    sql(db, `INSERT INTO repos VALUES ('r1', 'shop', ${q(repoRoot)});`)
    sql(db, `INSERT INTO workspaces VALUES ('w1', 'r1', 'Lisbon', 'lisbon', 'roy/checkout', 0, '', 's1');`)
    await continueConductorWorkspace('w1', start)
    expect(String(started[0].message)).toContain('Run `git switch roy/checkout` first.')
  })

  it('keeps only the last 12 messages and cuts each one at 400 characters', async () => {
    freshHome()
    sql(db, `INSERT INTO repos VALUES ('r1', 'shop', '/x');`)
    sql(db, `INSERT INTO workspaces VALUES ('w1', 'r1', 'Lisbon', 'lisbon', '', 0, '', 's1');`)
    for (let i = 0; i < 20; i++) message('s1', 'user', `m${String(i).padStart(2, '0')} ${'y'.repeat(500)}`, `2026-11-01 09:${String(i).padStart(2, '0')}:00`)
    await continueConductorWorkspace('w1', start)
    const lines = String(started[0].message).split('\n\n').filter((l) => l.startsWith('You: '))
    expect(lines).toHaveLength(12)
    expect(lines[0].startsWith('You: m08 ')).toBe(true)
    expect(lines.at(-1)!.startsWith('You: m19 ')).toBe(true)
    expect(lines.every((l) => l.length === 'You: '.length + 400)).toBe(true)
  })

  it('an id carrying SQL is stripped to word characters and matches nothing', async () => {
    freshHome()
    sql(db, `INSERT INTO repos VALUES ('r1', 'shop', '/x');`)
    sql(db, `INSERT INTO workspaces VALUES ('w1', 'r1', 'Lisbon', 'lisbon', '', 0, '', 's1');`)
    expect(await continueConductorWorkspace("nope' OR '1'='1", start)).toEqual({ ok: false, reason: 'That Conductor workspace is no longer on this Mac.' })
    expect(started).toEqual([])
  })
})
