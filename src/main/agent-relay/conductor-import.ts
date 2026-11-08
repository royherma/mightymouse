import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ConductorContinueResult, ConductorWorkspace } from '../../shared/conductor'

const run = promisify(execFile)
const SQLITE = '/usr/bin/sqlite3'
const GIT = '/usr/bin/git'
const MAX_BUFFER = 256 * 1024 * 1024
const TAIL_MESSAGES = 12
const PER_MESSAGE_CHARS = 400
const TOTAL_CHARS = 6000
const TITLE_CHARS = 80

type Row = Record<string, unknown>

function dbPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db')
}

async function query(sql: string): Promise<Row[]> {
  try {
    const { stdout } = await run(SQLITE, ['-readonly', '-json', dbPath(), sql], { maxBuffer: MAX_BUFFER, timeout: 15_000 })
    return stdout.trim() === '' ? [] : (JSON.parse(stdout) as Row[])
  } catch {
    return []
  }
}

async function columns(table: string): Promise<Set<string>> {
  const rows = await query(`PRAGMA table_info(${table})`)
  return new Set(rows.map((r) => String(r.name)))
}

function pick(have: Set<string>, alias: string, col: string, prefix: string): string {
  return have.has(col) ? `${prefix}.${col} AS ${alias}` : `NULL AS ${alias}`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function messageText(role: string, content: string): string {
  if (role === 'user') return content.trim()
  if (!content.startsWith('{')) return role === 'assistant' ? '' : content.trim()
  try {
    const blocks = (JSON.parse(content) as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .map((b) => (b && typeof b === 'object' && (b as Row).type === 'text' ? str((b as Row).text) : ''))
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

function folderFor(repo: string, rootPath: string, directory: string): string {
  const home = homedir()
  for (const base of [join(home, 'conductor', 'workspaces', repo), join(home, 'conductor', 'repo', repo)]) {
    const dir = join(base, directory)
    if (directory !== '' && existsSync(dir)) return dir
  }
  return rootPath
}

async function loadWorkspaces(onlyId?: string): Promise<Array<ConductorWorkspace & { rootPath: string; sessionId: string }>> {
  if (!existsSync(dbPath())) return []
  const [w, r, m] = await Promise.all([columns('workspaces'), columns('repos'), columns('session_messages')])
  if (!w.has('id') || !w.has('repository_id') || !r.has('id')) return []
  const sessionJoin = w.has('active_session_id') && m.has('session_id') && m.has('content')
  const first = sessionJoin
    ? `(SELECT content FROM session_messages WHERE session_id = w.active_session_id AND role = 'user' ORDER BY ${m.has('created_at') ? 'created_at' : 'rowid'} LIMIT 1)`
    : 'NULL'
  const count = sessionJoin ? '(SELECT COUNT(*) FROM session_messages WHERE session_id = w.active_session_id)' : '0'
  const where = onlyId ? `WHERE w.id = '${onlyId.replace(/[^\w-]/g, '')}'` : ''
  const rows = await query(
    `SELECT w.id AS id, ${pick(w, 'city', 'city_name', 'w')}, ${pick(w, 'dir', 'directory_name', 'w')}, ${pick(w, 'branch', 'branch', 'w')}, ` +
      `${pick(w, 'archived', 'archived', 'w')}, ${pick(w, 'updated', 'updated_at', 'w')}, ${pick(w, 'session', 'active_session_id', 'w')}, ` +
      `${pick(r, 'repo', 'name', 'r')}, ${pick(r, 'root', 'root_path', 'r')}, ${first} AS firstMsg, ${count} AS n ` +
      `FROM workspaces w LEFT JOIN repos r ON r.id = w.repository_id ${where} ORDER BY updated DESC`
  )
  return rows.map((row) => {
    const city = str(row.city)
    const directory = str(row.dir) || city.toLowerCase()
    const repo = str(row.repo)
    const rootPath = str(row.root)
    const firstLine = str(row.firstMsg).trim().split('\n')[0]?.slice(0, TITLE_CHARS) ?? ''
    const updated = str(row.updated)
    return {
      id: str(row.id),
      title: firstLine || directory || city,
      repo,
      branch: str(row.branch),
      cwd: folderFor(repo, rootPath, directory),
      archived: Number(row.archived) === 1,
      updatedAt: updated === '' ? '' : `${updated.replace(' ', 'T')}Z`,
      messages: Number(row.n) || 0,
      rootPath,
      sessionId: str(row.session)
    }
  })
}

export async function listConductorWorkspaces(): Promise<ConductorWorkspace[]> {
  const rows = await loadWorkspaces()
  return rows.map(({ rootPath: _root, sessionId: _session, ...row }) => row)
}

async function condensedTail(sessionId: string): Promise<string[]> {
  const order = (await columns('session_messages')).has('created_at') ? 'created_at' : 'rowid'
  const rows = await query(
    `SELECT role, content FROM session_messages WHERE session_id = '${sessionId.replace(/[^\w-]/g, '')}' ORDER BY ${order} DESC LIMIT 200`
  )
  const lines: string[] = []
  let used = 0
  for (const row of rows) {
    const role = str(row.role)
    const text = messageText(role, str(row.content))
    if (text === '') continue
    const line = `${role === 'user' ? 'You' : 'Assistant'}: ${text.slice(0, PER_MESSAGE_CHARS)}`
    if (used + line.length > TOTAL_CHARS || lines.length >= TAIL_MESSAGES) break
    lines.unshift(line)
    used += line.length
  }
  return lines
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  if (branch === '') return false
  try {
    await run(GIT, ['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export async function continueConductorWorkspace(
  id: string,
  start: (input: Record<string, unknown>) => Promise<ConductorContinueResult>
): Promise<ConductorContinueResult> {
  const found = (await loadWorkspaces(id))[0]
  if (!found) return { ok: false, reason: 'That Conductor workspace is no longer on this Mac.' }
  const tail = await condensedTail(found.sessionId)
  const intro = `This continues a Conductor workspace${found.branch ? ` on branch ${found.branch}` : ''}.`
  const switchLine =
    found.cwd === found.rootPath && (await branchExists(found.cwd, found.branch))
      ? `Run \`git switch ${found.branch}\` first.`
      : ''
  const history = tail.length > 0 ? `Here is the end of the old chat:\n\n${tail.join('\n\n')}` : ''
  const message = [intro, switchLine, history, 'Pick up where this left off.'].filter((p) => p !== '').join('\n\n')
  return start({ project: found.repo || found.title, cwd: found.cwd, harness: 'claude', inApp: true, message })
}
