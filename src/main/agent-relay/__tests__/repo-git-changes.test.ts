import { execFileSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sessions = vi.hoisted(() => new Map<string, { cwd?: string; sessionId?: string }>())

vi.mock('../../platform', () => ({ resolveBinary: () => 'git' }))
vi.mock('../session-control', () => ({ resolveSessionRef: (ref: string) => sessions.get(ref) ?? null }))

import { repoGitChanges } from '../repo-git'
import { saveCheckpoint } from '../checkpoints'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mm-repo-changes-')))
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
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...IDENTITY, ...args], { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function commit(cwd: string, file: string, body: string): void {
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '--no-verify', '-m', file)
}

let n = 0
function featureRepo(): string {
  n++
  const remote = join(root, `remote-${n}.git`)
  const work = join(root, `work-${n}`)
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'remote', 'add', 'origin', remote)
  commit(work, 'base.txt', 'base\n')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'remote', 'set-head', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'feature')
  commit(work, 'committed.txt', 'on the branch\n')
  return work
}

const paths = (set: { files: { path: string }[] } | null): string[] => (set?.files.map((f) => f.path) ?? []).sort()

beforeEach(() => sessions.clear())

describe('repoGitChanges scopes', () => {
  it('branch scope shows everything since main, committed or not', async () => {
    const work = featureRepo()
    writeFileSync(join(work, 'base.txt'), 'edited\n')
    writeFileSync(join(work, 'new.txt'), 'untracked\n')
    const set = await repoGitChanges(work)
    expect(set?.base).toBe('main')
    expect(paths(set)).toEqual(['base.txt', 'committed.txt', 'new.txt'])
  })

  it('uncommitted scope leaves out what the branch already committed', async () => {
    const work = featureRepo()
    writeFileSync(join(work, 'base.txt'), 'edited\n')
    writeFileSync(join(work, 'new.txt'), 'untracked\n')
    const set = await repoGitChanges(work, 'uncommitted')
    expect(set?.base).toBe('the last commit')
    expect(paths(set)).toEqual(['base.txt', 'new.txt'])
    expect(set?.files.find((f) => f.path === 'base.txt')).toEqual({ path: 'base.txt', added: 1, removed: 1 })
  })

  it('message scope with no saved checkpoint is an empty list, not an error', async () => {
    const work = featureRepo()
    sessions.set('s-none', { cwd: work, sessionId: 'never-sent' })
    writeFileSync(join(work, 'base.txt'), 'edited\n')
    expect(await repoGitChanges('s-none', 'message')).toEqual({ base: 'before your last message', files: [], patch: '', truncated: false })
  })

  it('message scope shows only what changed after the last message, new files included', async () => {
    const work = featureRepo()
    sessions.set('s-1', { cwd: work, sessionId: 'sess-1' })
    writeFileSync(join(work, 'before.txt'), 'edited before the message\n')
    await saveCheckpoint({ cwd: work, sessionId: 'sess-1' }, 1_000)
    writeFileSync(join(work, 'base.txt'), 'edited after\n')
    writeFileSync(join(work, 'after.txt'), 'created after\n')
    const set = await repoGitChanges('s-1', 'message')
    expect(set?.base).toBe('before your last message')
    expect(paths(set)).toEqual(['after.txt', 'base.txt'])
    expect(set?.patch).toContain('+edited after')
    expect(set?.patch).not.toContain('edited before the message')
  })

  it('a rename shows as the old path removed and the new one added', async () => {
    const work = featureRepo()
    git(work, 'mv', 'committed.txt', 'moved.txt')
    expect(paths(await repoGitChanges(work, 'uncommitted'))).toEqual(['committed.txt', 'moved.txt'])
  })

  it('a diff too big to show still lists its files, marked truncated', async () => {
    const work = featureRepo()
    writeFileSync(join(work, 'huge.txt'), `${'x'.repeat(99)}\n`.repeat(180_000))
    git(work, 'add', 'huge.txt')
    const set = await repoGitChanges(work, 'uncommitted')
    expect(set).not.toBeNull()
    expect(paths(set)).toEqual(['huge.txt'])
    expect(set?.truncated).toBe(true)
  }, 20_000)
})
