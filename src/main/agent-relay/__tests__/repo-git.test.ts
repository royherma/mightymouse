import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sessions = vi.hoisted(() => new Map<string, { cwd?: string }>())

vi.mock('../../platform', () => ({ resolveBinary: () => 'git' }))
vi.mock('../session-control', () => ({ resolveSessionRef: (ref: string) => sessions.get(ref) ?? null }))

import { makeConversationCopy, repoGitPush, repoGitState } from '../repo-git'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mm-repo-git-')))
const globalConfig = process.env.GIT_CONFIG_GLOBAL
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
afterAll(() => {
  if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = globalConfig
  rmSync(root, { recursive: true, force: true })
})

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  return env
}
// A pre-push hook's own environment carries GIT_DIR/GIT_WORK_TREE, which override cwd and
// point these fixture repos at the real worktree instead - strip it before every call.
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

function commit(cwd: string, file: string, subject: string): void {
  writeFileSync(join(cwd, file), subject)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '--no-verify', '-m', subject)
}

let n = 0
function freshRepo(): { remote: string; work: string } {
  n++
  const remote = join(root, `remote-${n}.git`)
  const work = join(root, `work-${n}`)
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'remote', 'add', 'origin', remote)
  return { remote, work }
}

beforeEach(() => sessions.clear())

describe('repoGitState', () => {
  it('counts commits not on any remote before the branch has an upstream', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'first')
    commit(work, 'b.txt', 'second')
    writeFileSync(join(work, 'dirty.txt'), 'x')
    sessions.set('s1', { cwd: work })
    const state = await repoGitState('s1')
    expect(state).toMatchObject({ branch: 'main', upstream: undefined, ahead: 2, dirty: 1, pending: ['second', 'first'] })
    expect(state?.head.subject).toBe('second')
  })

  it('a new branch off pushed history counts only its own commits', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'shared')
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'checkout', '-q', '-b', 'feature')
    commit(work, 'f.txt', 'feature work')
    sessions.set('s1', { cwd: work })
    expect(await repoGitState('s1')).toMatchObject({ branch: 'feature', upstream: undefined, ahead: 1, pending: ['feature work'] })
  })

  it('returns null for a session with no folder or a folder that is not a repo', async () => {
    sessions.set('nofolder', {})
    sessions.set('plain', { cwd: root })
    expect(await repoGitState('nofolder')).toBeNull()
    expect(await repoGitState('unknown')).toBeNull()
    expect(await repoGitState('plain')).toBeNull()
  })
})

describe('repoGitPush', () => {
  it('first push sets the upstream and reports how many commits went up', async () => {
    const { remote, work } = freshRepo()
    commit(work, 'a.txt', 'one')
    commit(work, 'b.txt', 'two')
    commit(work, 'c.txt', 'three')
    sessions.set('s1', { cwd: work })
    expect(await repoGitPush('s1')).toEqual({ ok: true, pushed: 3, upstream: 'origin/main' })
    expect(git(remote, 'rev-parse', 'main')).toBe(git(work, 'rev-parse', 'HEAD'))
    expect(await repoGitState('s1')).toMatchObject({ upstream: 'origin/main', ahead: 0 })
    expect(git(work, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/main')
  })

  it('a later push counts only the new commits', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'one')
    sessions.set('s1', { cwd: work })
    await repoGitPush('s1')
    commit(work, 'b.txt', 'two')
    expect(await repoGitPush('s1')).toEqual({ ok: true, pushed: 1, upstream: 'origin/main' })
  })

  it('a rejected non-fast-forward push says to pull first and leaves the remote untouched', async () => {
    const { remote, work } = freshRepo()
    commit(work, 'a.txt', 'base')
    sessions.set('s1', { cwd: work })
    await repoGitPush('s1')
    const other = join(root, `other-${n}`)
    git(root, 'clone', '-q', remote, other)
    commit(other, 'theirs.txt', 'theirs')
    git(other, 'push', '-q', 'origin', 'main')
    const remoteHead = git(remote, 'rev-parse', 'main')

    commit(work, 'mine.txt', 'mine')
    expect(await repoGitPush('s1')).toEqual({ ok: false, error: 'The remote has commits you do not. Pull first, then push.' })
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead)
  })

  it('refuses a session with no folder or no repo', async () => {
    sessions.set('plain', { cwd: root })
    expect(await repoGitPush('nothing')).toEqual({ ok: false, error: 'This session has no folder.' })
    expect(await repoGitPush('plain')).toEqual({ ok: false, error: 'This folder is not a git repository.' })
  })
})

describe('repoGitState by folder', () => {
  it('reads a folder path before any session exists, and ignores a relative one', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'first')
    expect(await repoGitState(work)).toMatchObject({ branch: 'main', ahead: 1 })
    expect(await repoGitState('work-1')).toBeNull()
  })
})

describe('makeConversationCopy', () => {
  const copyOf = async (cwd: string, said: string): Promise<string> => {
    const out = await makeConversationCopy(cwd, said)
    if (!('cwd' in out)) throw new Error(out.error)
    return out.cwd
  }

  it('makes a worktree on a new branch named from the first five words of the message', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'base')
    const cwd = await copyOf(work, 'Fix the Login page, please! It breaks on Safari')
    expect(cwd).toBe(join(work, '.worktrees', 'fix-the-login-page-please'))
    expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('mightymouse/fix-the-login-page-please')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(work, 'rev-parse', 'HEAD'))
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('never reuses a taken name, and lists the copies folder in .git/info/exclude once', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'base')
    writeFileSync(join(work, '.git', 'info', 'exclude'), '# keep me\n*.swp')
    expect(await copyOf(work, 'same ask')).toBe(join(work, '.worktrees', 'same-ask'))
    expect(await copyOf(work, 'same ask')).toBe(join(work, '.worktrees', 'same-ask-2'))
    expect(await copyOf(work, 'Same ask!!')).toBe(join(work, '.worktrees', 'same-ask-3'))
    expect(readFileSync(join(work, '.git', 'info', 'exclude'), 'utf8')).toBe('# keep me\n*.swp\n/.worktrees/\n')
    expect(git(work, 'status', '--porcelain')).toBe('')
  })

  it('steps past a leftover copies folder that has no branch', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'base')
    mkdirSync(join(work, '.worktrees', 'leftover'), { recursive: true })
    expect(await copyOf(work, 'leftover')).toBe(join(work, '.worktrees', 'leftover-2'))
  })

  it('leaves a repo whose git folder lives elsewhere in place instead of guessing its root', async () => {
    const work = join(root, `separate-${++n}`)
    git(root, 'init', '-q', '-b', 'main', `--separate-git-dir=${join(root, `separate-${n}.git`)}`, work)
    commit(work, 'a.txt', 'base')
    expect(await makeConversationCopy(work, 'anything')).toEqual({ cwd: work })
    expect(git(work, 'branch', '--list', 'mightymouse/*')).toBe('')
  })

  it('names a copy with no usable words "conversation"', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'base')
    expect(await copyOf(work, '!!! ???')).toBe(join(work, '.worktrees', 'conversation'))
  })

  it('opens the same subfolder inside the copy the session started in', async () => {
    const { work } = freshRepo()
    mkdirSync(join(work, 'app', 'src'), { recursive: true })
    commit(work, 'app/src/x.ts', 'base')
    expect(await copyOf(join(work, 'app', 'src'), 'sub folder')).toBe(join(work, '.worktrees', 'sub-folder', 'app', 'src'))
  })

  it('opens the same subfolder when the session folder is reached through a symlink', async () => {
    const { work } = freshRepo()
    mkdirSync(join(work, 'app'))
    commit(work, 'app/x.ts', 'base')
    const link = `${work}-link`
    symlinkSync(work, link)
    expect(await copyOf(join(link, 'app'), 'via link')).toBe(join(link, '.worktrees', 'via-link', 'app'))
  })

  it('a copy made from inside a copy lands next to it, not nested', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'base')
    const first = await copyOf(work, 'first')
    expect(await copyOf(first, 'second')).toBe(join(work, '.worktrees', 'second'))
  })

  it('leaves a plain folder alone and refuses a repo with no commits', async () => {
    const plain = mkdtempSync(join(root, 'plain-'))
    expect(await makeConversationCopy(plain, 'anything')).toEqual({ cwd: plain })
    const { work } = freshRepo()
    expect(await makeConversationCopy(work, 'anything')).toEqual({ error: 'This project has no commits yet, so it cannot get its own copy.' })
    expect(existsSync(join(work, '.worktrees'))).toBe(false)
  })
})
