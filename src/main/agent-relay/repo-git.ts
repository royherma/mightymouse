import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinary } from '../platform'
import { messageMarks } from './checkpoints'
import { resolveSessionRef } from './session-control'
import type { ChangeScope, ChangeSet, RepoGitState, RepoPull, RepoPullResult, RepoPushResult } from '../../shared/types'

const exec = promisify(execFile)
const READ_TIMEOUT_MS = 5_000
const PUSH_TIMEOUT_MS = 120_000
const PENDING_SHOWN = 5
const COPIES_DIR = '.worktrees'
const COPY_BRANCH_PREFIX = 'mightymouse/'
const SLUG_WORDS = 5
const GH_TIMEOUT_MS = 120_000
const PATCH_MAX_CHARS = 200_000
const PATCH_MAX_BUFFER = 16 << 20

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return env
}

async function git(cwd: string, args: string[], timeout = READ_TIMEOUT_MS, maxBuffer = 1 << 20): Promise<string> {
  const bin = resolveBinary('git')
  if (!bin) throw new Error('git is not on this Mac.')
  // GIT_DIR/GIT_WORK_TREE from an inherited env override cwd entirely - strip so cwd always wins.
  const { stdout } = await exec(bin, args, { cwd, env: cleanGitEnv(), timeout, maxBuffer })
  return stdout.trim()
}

async function soft(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch {
    return ''
  }
}

function sessionCwd(ref: string): string | undefined {
  if (typeof ref !== 'string') return undefined
  return resolveSessionRef(ref)?.cwd
}

function refCwd(ref: string): string | undefined {
  return sessionCwd(ref) ?? (typeof ref === 'string' && isAbsolute(ref) && existsSync(ref) ? ref : undefined)
}

// Also takes a folder path, so the new-session box can ask before any session exists.
export async function repoGitState(ref: string): Promise<RepoGitState | null> {
  const cwd = refCwd(ref)
  if (!cwd) return null
  const branch = await soft(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch) return null
  const [upstream, head, dirty] = await Promise.all([
    soft(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    soft(cwd, ['log', '-1', '--format=%h%x00%s']),
    soft(cwd, ['status', '--porcelain'])
  ])
  const range = upstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes']
  const [count, pending, remote] = await Promise.all([
    soft(cwd, ['rev-list', '--count', ...range]),
    soft(cwd, ['log', `-${PENDING_SHOWN}`, '--format=%s', ...range]),
    soft(cwd, ['remote', 'get-url', upstream.split('/')[0] || 'origin'])
  ])
  const ahead = Number(count) || 0
  const [sha = '', subject = ''] = head.split('\0')
  return {
    branch,
    upstream: upstream || undefined,
    ahead,
    dirty: dirty ? dirty.split('\n').length : 0,
    head: { sha, subject },
    pending: pending ? pending.split('\n') : [],
    remoteHost: hostName(remote)
  }
}

function hostName(url: string): string | undefined {
  const host = url.match(/^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i)?.[1]
  if (!host) return undefined
  if (/github\.com$/i.test(host)) return 'GitHub'
  if (/gitlab\./i.test(host)) return 'GitLab'
  if (/bitbucket\./i.test(host)) return 'Bitbucket'
  return host
}

function pushError(raw: string): string {
  if (/\[rejected\]|non-fast-forward|fetch first/.test(raw)) {
    return 'The remote has commits you do not. Pull first, then push.'
  }
  if (/Authentication failed|Permission denied|could not read Username/i.test(raw)) {
    return 'GitHub refused the login on this Mac.'
  }
  if (/Could not resolve host|unable to access/i.test(raw)) return 'Could not reach the remote.'
  const last = raw.split('\n').map((l) => l.trim()).filter(Boolean).pop()
  return last ?? 'Push failed.'
}

export async function repoGitPush(ref: string): Promise<RepoPushResult> {
  const cwd = refCwd(ref)
  if (!cwd) return { ok: false, error: 'This session has no folder.' }
  const before = await repoGitState(ref)
  if (!before) return { ok: false, error: 'This folder is not a git repository.' }
  const args = before.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']
  try {
    await git(cwd, args, PUSH_TIMEOUT_MS)
  } catch (error) {
    const raw = (error as { stderr?: string }).stderr || String(error)
    return { ok: false, error: pushError(raw) }
  }
  const after = await repoGitState(ref)
  return { ok: true, pushed: before.ahead, upstream: after?.upstream ?? `origin/${before.branch}` }
}

function copySlug(said: string): string {
  const words = said
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  return words.slice(0, SLUG_WORDS).join('-') || 'conversation'
}

async function freeCopyName(main: string, slug: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? slug : `${slug}-${n}`
    const taken = await soft(main, [
      'rev-parse',
      '--verify',
      '-q',
      `refs/heads/${COPY_BRANCH_PREFIX}${name}`
    ])
    if (!taken && !existsSync(join(main, COPIES_DIR, name))) return name
  }
}

function excludeCopies(commonDir: string): void {
  const file = join(commonDir, 'info', 'exclude')
  const line = `/${COPIES_DIR}/`
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split('\n').includes(line)) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`)
}

// Copies live inside the main checkout so the session still groups under its project (mightyProjectForCwd).
export async function makeConversationCopy(
  cwd: string,
  said: string
): Promise<{ cwd: string } | { error: string }> {
  const top = await soft(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) return { cwd }
  const raw = await soft(cwd, ['rev-parse', '--git-common-dir'])
  const commonDir = isAbsolute(raw) ? raw : resolve(cwd, raw)
  if (basename(commonDir) !== '.git') return { cwd }
  const main = dirname(commonDir)
  const head = await soft(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!head) return { error: 'This project has no commits yet, so it cannot get its own copy.' }
  const name = await freeCopyName(main, copySlug(said))
  const branch = `${COPY_BRANCH_PREFIX}${name}`
  const folder = join(main, COPIES_DIR, name)
  try {
    excludeCopies(commonDir)
    await git(main, ['worktree', 'add', '-b', branch, folder, head], PUSH_TIMEOUT_MS)
  } catch (error) {
    const msg = (error as { stderr?: string }).stderr || String(error)
    return {
      error: `Could not make a copy of the project. ${
        msg
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop() ?? ''
      }`.trim()
    }
  }
  const sub = join(folder, relative(realpathSync(top), realpathSync(cwd)))
  return { cwd: existsSync(sub) ? sub : folder }
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const bin = resolveBinary('gh')
  if (!bin) throw new Error('The GitHub CLI (gh) is not on this Mac.')
  const { stdout } = await exec(bin, args, { cwd, env: cleanGitEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: 8 << 20 })
  return stdout.trim()
}

function firstLine(error: unknown): string {
  const raw = (error as { stderr?: string }).stderr || (error instanceof Error ? error.message : String(error))
  return raw.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? 'GitHub did not answer.'
}

export async function mergePullWithFallback(cwd: string, target: string): Promise<void> {
  let failure = ''
  for (const method of ['--squash', '--merge', '--rebase']) {
    try {
      await gh(cwd, ['pr', 'merge', target, method])
      return
    } catch (error) {
      failure = firstLine(error)
      if (!/not allowed|merge method/i.test(failure)) break
    }
  }
  throw new Error(`GitHub did not merge it: ${failure}`)
}

async function baseBranch(cwd: string, branch: string): Promise<string | undefined> {
  const [common, own] = await Promise.all([soft(cwd, ['rev-parse', '--git-common-dir']), soft(cwd, ['rev-parse', '--absolute-git-dir'])])
  const commonDir = isAbsolute(common) ? common : resolve(cwd, common)
  if (own && resolve(own) !== commonDir && basename(commonDir) === '.git') {
    const mainBranch = await soft(dirname(commonDir), ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (mainBranch && mainBranch !== 'HEAD' && mainBranch !== branch) return mainBranch
  }
  const remoteDefault = (await soft(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '')
  return remoteDefault && remoteDefault !== branch ? remoteDefault : undefined
}

async function changeSet(cwd: string, base: string, from: string, to?: string, withUntracked = true): Promise<ChangeSet> {
  const range = to ? [from, to] : [from]
  const [numstat, untracked, patch] = await Promise.all([
    soft(cwd, ['diff', '--numstat', '--no-renames', ...range]),
    withUntracked ? soft(cwd, ['ls-files', '--others', '--exclude-standard']) : '',
    git(cwd, ['diff', '--no-renames', ...range], READ_TIMEOUT_MS, PATCH_MAX_BUFFER)
  ])
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split('\t')
      return { path: path.join('\t'), added: Number(added) || undefined, removed: Number(removed) || undefined }
    })
  for (const path of untracked.split('\n').filter(Boolean)) files.push({ path, added: undefined, removed: undefined })
  return { base, files, patch: patch.slice(0, PATCH_MAX_CHARS), truncated: patch.length > PATCH_MAX_CHARS }
}

export async function repoGitChanges(ref: string, scope: ChangeScope = 'branch'): Promise<ChangeSet | null> {
  const cwd = refCwd(ref)
  if (!cwd) return null
  const branch = await soft(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch) return null
  try {
    if (scope === 'message') {
      const session = resolveSessionRef(ref)
      const marks = session ? await messageMarks(session) : null
      if (!marks) return { base: 'before your last message', files: [], patch: '', truncated: false }
      return await changeSet(cwd, 'before your last message', marks.from, marks.to, false)
    }
    if (scope === 'uncommitted') return await changeSet(cwd, 'the last commit', 'HEAD')
    const base = await baseBranch(cwd, branch)
    const upstream = await soft(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const from = (base && (await soft(cwd, ['merge-base', 'HEAD', base]))) || (upstream ? '@{u}' : 'HEAD')
    return await changeSet(cwd, base || upstream || 'the last commit', from)
  } catch {
    return null
  }
}

const MERGE_BLOCKERS: Record<string, string> = {
  DIRTY: 'It conflicts with {base}. Ask the agent to fix the conflicts.',
  BLOCKED: 'GitHub is waiting on checks or a review.',
  DRAFT: 'It is still a draft on GitHub.',
  BEHIND: 'It is behind {base}.'
}

export async function repoGitPull(ref: string): Promise<RepoPull | null> {
  const cwd = refCwd(ref)
  if (!cwd || !resolveBinary('gh')) return null
  const branch = await soft(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') return null
  try {
    const raw = await gh(cwd, ['pr', 'view', branch, '--json', 'url,number,state,mergeStateStatus,baseRefName'])
    const body = JSON.parse(raw) as { url?: string; number?: number; state?: string; mergeStateStatus?: string; baseRefName?: string }
    if (!body.url || typeof body.number !== 'number') return null
    const state = body.state === 'MERGED' ? 'merged' : body.state === 'CLOSED' ? 'closed' : 'open'
    const base = body.baseRefName ?? ''
    const blocker = MERGE_BLOCKERS[body.mergeStateStatus ?? '']?.replace('{base}', base)
    return { url: body.url, number: body.number, state, base, blocker: state === 'open' ? blocker : undefined }
  } catch {
    return null
  }
}

export async function repoGitOpenPull(ref: string): Promise<RepoPullResult> {
  const cwd = refCwd(ref)
  if (!cwd) return { ok: false, error: 'This session has no folder.' }
  const state = await repoGitState(ref)
  if (!state) return { ok: false, error: 'This folder is not a git repository.' }
  const existing = await repoGitPull(ref)
  if (existing?.state === 'open') return { ok: true, pull: existing }
  const base = await baseBranch(cwd, state.branch)
  if (!base) return { ok: false, error: `${state.branch} is the main branch. Start the agent in its own copy to open a pull request.` }
  const ahead = Number(await soft(cwd, ['rev-list', '--count', `${base}..HEAD`])) || 0
  if (ahead === 0) return { ok: false, error: `No commits beyond ${base} yet. Commit first.` }
  if (state.upstream !== `origin/${state.branch}` || state.ahead > 0) {
    try {
      await git(cwd, ['push', '-u', 'origin', `HEAD:refs/heads/${state.branch}`], PUSH_TIMEOUT_MS)
    } catch (error) {
      return { ok: false, error: pushError((error as { stderr?: string }).stderr || String(error)) }
    }
  }
  try {
    await gh(cwd, ['pr', 'create', '--fill', '--base', base, '--head', state.branch])
  } catch (error) {
    return { ok: false, error: firstLine(error) }
  }
  const pull = await repoGitPull(ref)
  return pull ? { ok: true, pull } : { ok: false, error: 'GitHub made the pull request but did not show it back.' }
}

export async function repoGitMerge(ref: string): Promise<RepoPullResult> {
  const cwd = refCwd(ref)
  const pull = await repoGitPull(ref)
  if (!cwd || !pull || pull.state !== 'open') return { ok: false, error: 'There is no open pull request to merge.' }
  try {
    await mergePullWithFallback(cwd, pull.url)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, pull: (await repoGitPull(ref)) ?? { ...pull, state: 'merged', blocker: undefined } }
}
