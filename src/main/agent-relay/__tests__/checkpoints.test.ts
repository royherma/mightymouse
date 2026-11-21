import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', () => ({ resolveBinary: () => 'git' }))

import { saveCheckpoint, toggleTurnUndo, turnUndoStates } from '../checkpoints'

const root = mkdtempSync(join(tmpdir(), 'mm-checkpoints-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
const read = (f: string): string | null => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : null)
const put = (f: string, body: string): void => writeFileSync(join(root, f), body)

describe('checkpoints', () => {
  it('undo restores files from before the message, put back restores the newer work, the index is untouched', async () => {
    git('init', '-q')
    put('.gitignore', '*.log\n')
    put('a.txt', 'a1')
    git('add', '.')
    git('commit', '-qm', 'base')
    put('b.txt', 'untracked before')
    put('c.log', 'ignored before')
    const session = { sessionId: 'sess-1', cwd: root }
    const turnAt = 1_000_000

    await saveCheckpoint(session, turnAt)
    put('a.txt', 'a2')
    unlinkSync(join(root, 'b.txt'))
    put('d.txt', 'new file')
    put('c.log', 'ignored after')
    git('add', 'd.txt')
    put('other-agent.txt', 'not ours')
    const edited = [join(root, 'a.txt'), 'b.txt', 'd.txt']
    const staged = git('diff', '--cached', '--name-only')

    expect((await turnUndoStates(session, [turnAt + 2_000, turnAt + 60_000])).get(turnAt + 2_000)).toBe('undo')
    expect(await turnUndoStates(session, [turnAt + 60_000])).toEqual(new Map())

    expect(await toggleTurnUndo({ ...session, busySince: 1 }, turnAt, edited)).toMatchObject({ ok: false })
    expect(await toggleTurnUndo(session, turnAt, ['c.log'])).toMatchObject({ ok: false })
    expect(await toggleTurnUndo(session, turnAt + 2_000, edited)).toEqual({ ok: true, state: 'putBack', files: 3 })
    expect([read('a.txt'), read('b.txt'), read('d.txt'), read('c.log'), read('other-agent.txt')]).toEqual(['a1', 'untracked before', null, 'ignored after', 'not ours'])
    expect(git('diff', '--cached', '--name-only')).toBe(staged)
    expect((await turnUndoStates(session, [turnAt + 2_000])).get(turnAt + 2_000)).toBe('putBack')

    expect(await toggleTurnUndo(session, turnAt + 2_000, edited)).toEqual({ ok: true, state: 'undo', files: 3 })
    expect([read('a.txt'), read('b.txt'), read('d.txt')]).toEqual(['a2', null, 'new file'])

    await toggleTurnUndo(session, turnAt + 2_000, edited)
    await saveCheckpoint(session, turnAt + 90_000)
    expect((await turnUndoStates(session, [turnAt + 2_000])).get(turnAt + 2_000)).toBe('undo')
  }, 30_000)
})

describe('checkpoints across several messages', () => {
  const fresh = (): { dir: string; run: (...args: string[]) => string; put: (f: string, body: string) => void; read: (f: string) => string } => {
    const dir = mkdtempSync(join(root, 'repo-'))
    const run = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim()
    run('init', '-q')
    return {
      dir,
      run,
      put: (f, body) => writeFileSync(join(dir, f), body),
      read: (f) => readFileSync(join(dir, f), 'utf8')
    }
  }

  it('undoing an earlier message after a later one, then putting it back, returns the newest work', async () => {
    const repo = fresh()
    repo.put('a.txt', 'v0')
    repo.run('add', '.')
    repo.run('commit', '-qm', 'base')
    const session = { sessionId: 'sess-two-turns', cwd: repo.dir }
    const t1 = 2_000_000
    const t2 = 3_000_000

    await saveCheckpoint(session, t1)
    repo.put('a.txt', 'v1')
    await saveCheckpoint(session, t2)
    repo.put('a.txt', 'v2')

    expect(await toggleTurnUndo(session, t2, ['a.txt'])).toEqual({ ok: true, state: 'putBack', files: 1 })
    expect(repo.read('a.txt')).toBe('v1')
    expect(await toggleTurnUndo(session, t1, ['a.txt'])).toEqual({ ok: true, state: 'putBack', files: 1 })
    expect(repo.read('a.txt')).toBe('v0')
    expect(await turnUndoStates(session, [t1, t2])).toEqual(new Map([[t1, 'putBack'], [t2, 'undo']]))

    expect(await toggleTurnUndo(session, t1, ['a.txt'])).toEqual({ ok: true, state: 'undo', files: 1 })
    expect(repo.read('a.txt')).toBe('v2')
  }, 30_000)

  it('an edit in the same second as the last git write, same size, still lands in the checkpoint', async () => {
    const repo = fresh()
    repo.run('config', 'core.trustctime', 'false')
    const sameSecond = new Date('2026-01-01T00:00:00Z')
    repo.put('a.txt', 'v0')
    utimesSync(join(repo.dir, 'a.txt'), sameSecond, sameSecond)
    repo.run('add', '.')
    repo.run('commit', '-qm', 'base')
    utimesSync(join(repo.dir, '.git', 'index'), sameSecond, sameSecond)
    const session = { sessionId: 'sess-racy', cwd: repo.dir }
    const t1 = 4_000_000

    await saveCheckpoint(session, t1)
    repo.put('a.txt', 'v1')
    utimesSync(join(repo.dir, 'a.txt'), sameSecond, sameSecond)
    await saveCheckpoint(session, t1 + 1_000)
    repo.put('a.txt', 'v2')

    expect(await toggleTurnUndo(session, t1 + 1_000, ['a.txt'])).toEqual({ ok: true, state: 'putBack', files: 1 })
    expect(repo.read('a.txt')).toBe('v1')
  }, 30_000)
})
