import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({ sessions: new Map<string, { cwd?: string }>(), gh: null as string | null }))

vi.mock('../../platform', () => ({ resolveBinary: (name: string) => (name === 'gh' ? H.gh : 'git') }))
vi.mock('../session-control', () => ({ resolveSessionRef: (ref: string) => H.sessions.get(ref) ?? null }))

import { mergePullWithFallback, repoGitChanges, repoGitMerge, repoGitOpenPull, repoGitPull } from '../repo-git'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mm-repo-git-pull-')))
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
  mkdirSync(join(cwd, file, '..'), { recursive: true })
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '--no-verify', '-m', `add ${file}`)
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

function worktreeOff(work: string, branch: string): string {
  const copy = join(root, `copy-${n}-${branch}`)
  git(work, 'worktree', 'add', '-q', '-b', branch, copy, 'main')
  return copy
}

const FAKE_GH = `#!/bin/sh
dir="$(dirname "$0")"
echo "$*" >> "$dir/calls.log"
case "$1 $2" in
  "pr view")
    if [ -f "$dir/view.json" ]; then cat "$dir/view.json"; exit 0; fi
    echo 'no pull requests found for branch' >&2; exit 1 ;;
  "pr merge")
    m="\${4#--}"
    if [ -f "$dir/merge-$m.err" ]; then cat "$dir/merge-$m.err" >&2; exit 1; fi
    [ -f "$dir/after-merge.json" ] && cp "$dir/after-merge.json" "$dir/view.json"
    exit 0 ;;
  "pr create")
    [ -f "$dir/after-create.json" ] && cp "$dir/after-create.json" "$dir/view.json"
    exit 0 ;;
esac
exit 2
`

let ghDir = ''
function fakeGh(files: Record<string, unknown> = {}): void {
  ghDir = mkdtempSync(join(root, 'gh-'))
  const bin = join(ghDir, 'gh')
  writeFileSync(bin, FAKE_GH)
  chmodSync(bin, 0o755)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(ghDir, name), typeof body === 'string' ? body : JSON.stringify(body))
  H.gh = bin
}
const ghCalls = (): string[] => (existsSync(join(ghDir, 'calls.log')) ? readFileSync(join(ghDir, 'calls.log'), 'utf8').trim().split('\n') : [])

const PR = { url: 'https://github.com/o/r/pull/7', number: 7, baseRefName: 'main' }

beforeEach(() => {
  H.sessions.clear()
  H.gh = null
})

describe('mergePullWithFallback', () => {
  it('falls through to the next merge method only when the repo disallows the one tried', async () => {
    fakeGh({ 'merge-squash.err': 'GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)' })
    await mergePullWithFallback(root, PR.url)
    expect(ghCalls()).toEqual([`pr merge ${PR.url} --squash`, `pr merge ${PR.url} --merge`])
  })

  it('stops at the first real refusal and reports its first line', async () => {
    fakeGh({ 'merge-squash.err': '\nPull request #7 is not mergeable: the merge commit cannot be cleanly created.\nRun gh pr checkout 7\n' })
    await expect(mergePullWithFallback(root, PR.url)).rejects.toThrow(
      'GitHub did not merge it: Pull request #7 is not mergeable: the merge commit cannot be cleanly created.'
    )
    expect(ghCalls()).toEqual([`pr merge ${PR.url} --squash`])
  })

  it('reports the last refusal when every method is disallowed', async () => {
    fakeGh({
      'merge-squash.err': 'Squash merges are not allowed',
      'merge-merge.err': 'Merge commits are not allowed',
      'merge-rebase.err': 'Rebase merges are not allowed'
    })
    await expect(mergePullWithFallback(root, PR.url)).rejects.toThrow('GitHub did not merge it: Rebase merges are not allowed')
    expect(ghCalls()).toHaveLength(3)
  })
})

describe('repoGitPull', () => {
  const pullFor = async (view: Record<string, unknown>): Promise<unknown> => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    git(work, 'checkout', '-q', '-b', 'feature')
    fakeGh({ 'view.json': view })
    return repoGitPull(work)
  }

  it('names the blocker on an open pull request, with its base branch filled in', async () => {
    expect(await pullFor({ ...PR, state: 'OPEN', mergeStateStatus: 'DIRTY' })).toEqual({
      ...{ url: PR.url, number: 7, base: 'main' },
      state: 'open',
      blocker: 'It conflicts with main. Ask the agent to fix the conflicts.'
    })
    expect(ghCalls()[0]).toBe('pr view feature --json url,number,state,mergeStateStatus,baseRefName')
  })

  it('a merged or closed pull request carries no blocker', async () => {
    expect(await pullFor({ ...PR, state: 'MERGED', mergeStateStatus: 'DIRTY' })).toMatchObject({ state: 'merged', blocker: undefined })
    expect(await pullFor({ ...PR, state: 'CLOSED', mergeStateStatus: 'BLOCKED' })).toMatchObject({ state: 'closed', blocker: undefined })
  })

  it('a clean open pull request has no blocker', async () => {
    expect(await pullFor({ ...PR, state: 'OPEN', mergeStateStatus: 'CLEAN' })).toMatchObject({ state: 'open', blocker: undefined })
  })

  it('is null with no pull request, no gh, a detached head, or a reply missing its number', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    git(work, 'checkout', '-q', '-b', 'feature')
    fakeGh()
    expect(await repoGitPull(work)).toBeNull()
    fakeGh({ 'view.json': { url: PR.url, state: 'OPEN' } })
    expect(await repoGitPull(work)).toBeNull()
    git(work, 'checkout', '-q', '--detach')
    fakeGh({ 'view.json': { ...PR, state: 'OPEN' } })
    expect(await repoGitPull(work)).toBeNull()
    expect(ghCalls()).toEqual([])
    H.gh = null
    git(work, 'checkout', '-q', 'feature')
    expect(await repoGitPull(work)).toBeNull()
  })
})

describe('repoGitOpenPull', () => {
  it('refuses on the main branch itself without calling GitHub', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    fakeGh()
    expect(await repoGitOpenPull(work)).toEqual({
      ok: false,
      error: 'main is the main branch. Start the agent in its own copy to open a pull request.'
    })
    expect(ghCalls().some((c) => c.startsWith('pr create'))).toBe(false)
  })

  it('refuses a copy with no commits beyond its base', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    const copy = worktreeOff(work, 'feature')
    fakeGh()
    expect(await repoGitOpenPull(copy)).toEqual({ ok: false, error: 'No commits beyond main yet. Commit first.' })
    expect(ghCalls().some((c) => c.startsWith('pr create'))).toBe(false)
  })

  it('pushes the branch, opens the pull request against the main checkout branch, and reads it back', async () => {
    const { remote, work } = freshRepo()
    commit(work, 'a.txt', 'a')
    const copy = worktreeOff(work, 'feature')
    commit(copy, 'f.txt', 'f')
    fakeGh({ 'after-create.json': { ...PR, state: 'OPEN', mergeStateStatus: 'CLEAN' } })
    expect(await repoGitOpenPull(copy)).toEqual({ ok: true, pull: { url: PR.url, number: 7, state: 'open', base: 'main', blocker: undefined } })
    expect(git(remote, 'rev-parse', 'feature')).toBe(git(copy, 'rev-parse', 'HEAD'))
    expect(ghCalls()).toContain('pr create --fill --base main --head feature')
  })

  it('hands back an already-open pull request instead of opening a second one', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    const copy = worktreeOff(work, 'feature')
    commit(copy, 'f.txt', 'f')
    fakeGh({ 'view.json': { ...PR, state: 'OPEN' } })
    expect(await repoGitOpenPull(copy)).toMatchObject({ ok: true, pull: { number: 7, state: 'open' } })
    expect(ghCalls().some((c) => c.startsWith('pr create'))).toBe(false)
  })
})

describe('repoGitMerge', () => {
  it('refuses when the pull request is not open, and never calls merge', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    git(work, 'checkout', '-q', '-b', 'feature')
    fakeGh({ 'view.json': { ...PR, state: 'MERGED' } })
    expect(await repoGitMerge(work)).toEqual({ ok: false, error: 'There is no open pull request to merge.' })
    expect(ghCalls().some((c) => c.startsWith('pr merge'))).toBe(false)
  })

  it('merges the open pull request by its url and returns the fresh state', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    git(work, 'checkout', '-q', '-b', 'feature')
    fakeGh({ 'view.json': { ...PR, state: 'OPEN' }, 'after-merge.json': { ...PR, state: 'MERGED' } })
    expect(await repoGitMerge(work)).toEqual({ ok: true, pull: { url: PR.url, number: 7, state: 'merged', base: 'main', blocker: undefined } })
    expect(ghCalls()).toContain(`pr merge ${PR.url} --squash`)
  })

  it('passes GitHub refusal back as the error', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a')
    git(work, 'checkout', '-q', '-b', 'feature')
    fakeGh({ 'view.json': { ...PR, state: 'OPEN' }, 'merge-squash.err': 'Required status check "ci" is expected.' })
    expect(await repoGitMerge(work)).toEqual({ ok: false, error: 'GitHub did not merge it: Required status check "ci" is expected.' })
  })
})

describe('repoGitChanges', () => {
  it('a copy compares against where it left main: committed, uncommitted and new files, not later main commits', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'one\n')
    const copy = worktreeOff(work, 'feature')
    commit(work, 'later-on-main.txt', 'x\n')
    commit(copy, 'f.txt', 'one\ntwo\n')
    writeFileSync(join(copy, 'a.txt'), 'changed\n')
    writeFileSync(join(copy, 'new.txt'), 'n\n')
    const changes = await repoGitChanges(copy)
    expect(changes?.base).toBe('main')
    expect(changes?.truncated).toBe(false)
    expect(changes?.files).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', added: 1, removed: 1 },
        { path: 'f.txt', added: 2, removed: undefined },
        { path: 'new.txt', added: undefined, removed: undefined }
      ])
    )
    expect(changes?.files.map((f) => f.path)).not.toContain('later-on-main.txt')
    expect(changes?.patch).toContain('+changed')
  })

  it('cuts a huge patch at 200,000 characters and says so', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a\n')
    const copy = worktreeOff(work, 'feature')
    writeFileSync(join(copy, 'a.txt'), `${'line of text\n'.repeat(20_000)}`)
    const changes = await repoGitChanges(copy)
    expect(changes?.truncated).toBe(true)
    expect(changes?.patch).toHaveLength(200_000)
  })

  it('a repo with no base branch and no upstream says it compares with the last commit', async () => {
    const { work } = freshRepo()
    commit(work, 'a.txt', 'a\n')
    writeFileSync(join(work, 'a.txt'), 'b\n')
    const changes = await repoGitChanges(work)
    expect(changes?.files).toEqual([{ path: 'a.txt', added: 1, removed: 1 }])
    expect(changes?.base).toBe('the last commit')
  })
})
