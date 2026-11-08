import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinary } from '../platform'
import type { CheckpointResult, TurnUndoState } from '../../shared/types'

const exec = promisify(execFile)
const ROOT = 'refs/mightymouse/checkpoints'
const KEEP = 50
const TIMEOUT_MS = 30_000
// Transcript stamps and hook stamps are taken by different processes for the same keystroke.
const MATCH_WINDOW_MS = 15_000
const PATHS_PER_CALL = 200
const IDENTITY = { GIT_AUTHOR_NAME: 'MightyMouse', GIT_AUTHOR_EMAIL: 'checkpoints@getmightymouse.com', GIT_COMMITTER_NAME: 'MightyMouse', GIT_COMMITTER_EMAIL: 'checkpoints@getmightymouse.com' }

export type CheckpointSession = { sessionId?: string; cwd?: string; busySince?: number }

type Saved = { at: number[]; undone: Map<number, string> }
const cache = new Map<string, Saved>()
const queues = new Map<string, Promise<unknown>>()

function env(indexFile?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY }
  for (const key of Object.keys(out)) if (key.startsWith('GIT_') && !(key in IDENTITY)) delete out[key]
  if (indexFile) out.GIT_INDEX_FILE = indexFile
  return out
}

async function git(cwd: string, args: string[], indexFile?: string): Promise<string> {
  const bin = resolveBinary('git')
  if (!bin) throw new Error('git is not on this Mac.')
  const { stdout } = await exec(bin, args, { cwd, env: env(indexFile), timeout: TIMEOUT_MS, maxBuffer: 64 << 20 })
  return stdout.trim()
}

function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9-]/g, '_')
}

function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(job, job)
  queues.set(key, next.catch(() => undefined))
  return next
}

async function repoRoot(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd || !existsSync(cwd)) return undefined
  return git(cwd, ['rev-parse', '--show-toplevel']).catch(() => undefined)
}

async function withTempIndex<T>(root: string, seedFromRepo: boolean, job: (indexFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mm-checkpoint-'))
  const indexFile = join(dir, 'index')
  try {
    if (seedFromRepo) {
      const raw = await git(root, ['rev-parse', '--git-path', 'index'])
      const real = isAbsolute(raw) ? raw : join(root, raw)
      // Seeding with the real index reuses its stat cache, so `add -A` does not rehash the whole tree.
      if (existsSync(real)) copyFileSync(real, indexFile)
    }
    return await job(indexFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function snapshot(root: string): Promise<string> {
  return withTempIndex(root, true, async (indexFile) => {
    await git(root, ['add', '-A', '--', '.'], indexFile)
    const tree = await git(root, ['write-tree'], indexFile)
    const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')
    return git(root, ['commit-tree', '--no-gpg-sign', tree, ...(head ? ['-p', head] : []), '-m', 'MightyMouse checkpoint'])
  })
}

async function load(root: string, sid: string): Promise<Saved> {
  const hit = cache.get(sid)
  if (hit) return hit
  const raw = await git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `${ROOT}/${sid}/`]).catch(() => '')
  const saved: Saved = { at: [], undone: new Map() }
  for (const line of raw.split('\n').filter(Boolean)) {
    const [name, sha] = line.split(' ')
    const rest = name.slice(`${ROOT}/${sid}/`.length)
    if (rest.startsWith('undone/')) saved.undone.set(Number(rest.slice(7)), sha)
    else if (/^\d+$/.test(rest)) saved.at.push(Number(rest))
  }
  saved.at.sort((a, b) => a - b)
  cache.set(sid, saved)
  return saved
}

export async function saveCheckpoint(session: CheckpointSession, at = Date.now()): Promise<void> {
  if (!session.sessionId) return
  const root = await repoRoot(session.cwd)
  if (!root) return
  const sid = safeId(session.sessionId)
  await serial(sid, async () => {
    const saved = await load(root, sid)
    const sha = await snapshot(root)
    await git(root, ['update-ref', `${ROOT}/${sid}/${at}`, sha])
    saved.at.push(at)
    // New work after an undo makes the old "put back" a way to destroy it.
    for (const turnAt of saved.undone.keys()) await git(root, ['update-ref', '-d', `${ROOT}/${sid}/undone/${turnAt}`])
    saved.undone.clear()
    while (saved.at.length > KEEP) {
      const old = saved.at.shift()
      await git(root, ['update-ref', '-d', `${ROOT}/${sid}/${old}`]).catch(() => undefined)
    }
  })
}

export async function messageMarks(session: CheckpointSession): Promise<{ from: string; to: string } | null> {
  if (!session.sessionId) return null
  const root = await repoRoot(session.cwd)
  if (!root) return null
  const sid = safeId(session.sessionId)
  const last = (await load(root, sid)).at.at(-1)
  if (last === undefined) return null
  const from = await git(root, ['rev-parse', `${ROOT}/${sid}/${last}`])
  return { from, to: await snapshot(root) }
}

function nearest(saved: Saved, turnAt: number): number | undefined {
  let best: number | undefined
  for (const at of saved.at) {
    if (Math.abs(at - turnAt) > MATCH_WINDOW_MS) continue
    if (best === undefined || Math.abs(at - turnAt) < Math.abs(best - turnAt)) best = at
  }
  return best
}

export async function withUndoStates<T extends { role: string; at: number }>(session: CheckpointSession, turns: T[]): Promise<Array<T & { undo?: TurnUndoState }>> {
  const states = await turnUndoStates(
    session,
    turns.filter((t) => t.role === 'you').map((t) => t.at)
  ).catch(() => new Map<number, TurnUndoState>())
  return turns.map((t) => (states.has(t.at) ? { ...t, undo: states.get(t.at) } : t))
}

export async function turnUndoStates(session: CheckpointSession, turnAts: number[]): Promise<Map<number, TurnUndoState>> {
  const out = new Map<number, TurnUndoState>()
  if (!session.sessionId) return out
  const root = await repoRoot(session.cwd)
  if (!root) return out
  const saved = await load(root, safeId(session.sessionId))
  for (const turnAt of turnAts) {
    if (saved.undone.has(turnAt)) out.set(turnAt, 'putBack')
    else if (nearest(saved, turnAt) !== undefined) out.set(turnAt, 'undo')
  }
  return out
}

async function restore(root: string, target: string, current: string, only: Set<string>): Promise<number> {
  const raw = await git(root, ['diff', '--name-status', '--no-renames', '-z', target, current])
  const parts = raw.split('\0').filter(Boolean)
  const write: string[] = []
  let changed = 0
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [status, path] = [parts[i], parts[i + 1]]
    if (!only.has(path)) continue
    changed++
    if (status === 'A') {
      const file = join(root, path)
      if (existsSync(file)) unlinkSync(file)
    } else write.push(path)
  }
  if (write.length) {
    await withTempIndex(root, false, async (indexFile) => {
      await git(root, ['read-tree', target], indexFile)
      for (let i = 0; i < write.length; i += PATHS_PER_CALL) {
        await git(root, ['checkout-index', '-f', '--', ...write.slice(i, i + PATHS_PER_CALL)], indexFile)
      }
    })
  }
  return changed
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// git reports the resolved root (/private/var) while agents log the path they were given (/var).
function repoPaths(root: string, cwd: string, paths: string[]): Set<string> {
  const realRoot = realPath(root)
  const out = new Set<string>()
  for (const p of paths) {
    const abs = resolve(cwd, p)
    const real = existsSync(abs) ? realPath(abs) : join(realPath(resolve(abs, '..')), abs.split('/').pop() ?? '')
    const rel = relative(realRoot, real)
    if (rel && !rel.startsWith('..')) out.add(rel)
  }
  return out
}

// Other agents often share the folder, so only paths this agent edited are ever written back.
export async function toggleTurnUndo(session: CheckpointSession, turnAt: number, edited: string[]): Promise<CheckpointResult> {
  if (!session.sessionId) return { ok: false, error: 'This session has no id.' }
  if (session.busySince !== undefined) return { ok: false, error: 'Wait for the agent to finish, then try again.' }
  const root = await repoRoot(session.cwd)
  if (!root) return { ok: false, error: 'This folder is not a git repository.' }
  const sid = safeId(session.sessionId)
  const only = repoPaths(root, session.cwd ?? root, edited)
  return serial(sid, async () => {
    const saved = await load(root, sid)
    const backup = saved.undone.get(turnAt)
    try {
      if (backup) {
        const files = await restore(root, backup, await snapshot(root), only)
        await git(root, ['update-ref', '-d', `${ROOT}/${sid}/undone/${turnAt}`])
        saved.undone.delete(turnAt)
        return { ok: true, state: 'undo', files }
      }
      const at = nearest(saved, turnAt)
      if (at === undefined) return { ok: false, error: 'No saved copy of the files for this message.' }
      const target = await git(root, ['rev-parse', `${ROOT}/${sid}/${at}`])
      const current = await snapshot(root)
      const files = await restore(root, target, current, only)
      if (files === 0) return { ok: false, error: 'Nothing to undo. The files this agent edited have not changed since this message.' }
      // Undoing a second message keeps the FIRST backup: that is the newest real work.
      const keep = [...saved.undone.values()][0] ?? current
      for (const old of saved.undone.keys()) await git(root, ['update-ref', '-d', `${ROOT}/${sid}/undone/${old}`])
      saved.undone.clear()
      await git(root, ['update-ref', `${ROOT}/${sid}/undone/${turnAt}`, keep])
      saved.undone.set(turnAt, keep)
      return { ok: true, state: 'putBack', files }
    } catch (error) {
      const raw = (error as { stderr?: string }).stderr || String(error)
      return { ok: false, error: raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'Could not restore the files.' }
    }
  })
}
