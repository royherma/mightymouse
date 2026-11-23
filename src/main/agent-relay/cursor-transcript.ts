import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { AgentTranscriptTurn } from '../../shared/types'
import type { TranscriptSession } from './session-transcript'

const START_SKEW_MS = 60_000
const TEXT_MAX = 4000
const TOOL_DETAIL_MAX = 80
const BLOB_ID_BYTES = 32
const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/

type Cached = { stamp: string; turns: AgentTranscriptTurn[] }
const cache = new Map<string, Cached>()
const createdAtByDb = new Map<string, number>()

function stampOf(dbPath: string): string {
  return [dbPath, `${dbPath}-wal`]
    .map((p) => {
      try {
        return statSync(p).mtimeMs
      } catch {
        return 0
      }
    })
    .join(':')
}

function childIds(root: Buffer): string[] {
  const ids: string[] = []
  let i = 0
  const varint = (): number => {
    let n = 0
    let shift = 0
    while (i < root.length) {
      const b = root[i++]
      n += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) break
      shift += 7
    }
    return n
  }
  while (i < root.length) {
    const tag = varint()
    const wire = tag & 7
    if (wire === 0) varint()
    else if (wire === 2) {
      const len = varint()
      if (tag >> 3 === 1 && len === BLOB_ID_BYTES) ids.push(root.subarray(i, i + len).toString('hex'))
      i += len
    } else break
  }
  return ids
}

function toolLine(part: { toolName?: string; args?: Record<string, unknown> }): string {
  const name = part.toolName ?? 'tool'
  const a = part.args ?? {}
  const detail = [a.command, a.path, a.file_path, a.target_file, a.relative_workspace_path, a.pattern, a.glob_pattern, a.query, a.url, a.description].find(
    (v): v is string => typeof v === 'string' && v.length > 0
  )
  return detail ? `${name} · ${detail.replace(/\s+/g, ' ').slice(0, TOOL_DETAIL_MAX)}` : name
}

function push(turns: AgentTranscriptTurn[], turn: AgentTranscriptTurn): void {
  const text = turn.text.trim().slice(0, TEXT_MAX)
  if (text) turns.push({ ...turn, text })
}

function parse(db: Database.Database, createdAt: number): AgentTranscriptTurn[] {
  const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('0') as { value: string } | undefined
  if (!meta) return []
  const rootId = (JSON.parse(Buffer.from(meta.value, 'hex').toString('utf8')) as { latestRootBlobId?: string }).latestRootBlobId
  const root = rootId ? (db.prepare('SELECT data FROM blobs WHERE id = ?').get(rootId) as { data: Buffer } | undefined) : undefined
  if (!root) return []
  const byId = db.prepare('SELECT data FROM blobs WHERE id = ?')
  const turns: AgentTranscriptTurn[] = []
  childIds(root.data).forEach((id, index) => {
    const row = byId.get(id) as { data: Buffer } | undefined
    if (!row || row.data[0] !== 0x7b) return
    let msg: { role?: string; content?: unknown }
    try {
      msg = JSON.parse(row.data.toString('utf8'))
    } catch {
      return
    }
    const at = createdAt + index
    const parts = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string; toolName?: string; args?: Record<string, unknown> }[]) : []
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : parts.map((p) => p.text ?? '').join('\n')
      const query = USER_QUERY.exec(text)
      if (query) push(turns, { role: 'you', at, text: query[1] })
      else if (!text.startsWith('<')) push(turns, { role: 'you', at, text })
      return
    }
    if (msg.role !== 'assistant') return
    for (const part of parts) {
      if (part.type === 'text' && part.text) push(turns, { role: 'agent', at, text: part.text })
      else if (part.type === 'tool-call') push(turns, { role: 'tool', at, text: toolLine(part) })
    }
  })
  return turns
}

function chatDbs(cwd: string, home: string): string[] {
  const dir = join(home, '.cursor', 'chats', createHash('md5').update(cwd).digest('hex'))
  try {
    return readdirSync(dir).map((chat) => join(dir, chat, 'store.db'))
  } catch {
    return []
  }
}

function createdAtOf(dbPath: string): number | undefined {
  const known = createdAtByDb.get(dbPath)
  if (known !== undefined) return known
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('0') as { value: string } | undefined
      const at = row ? (JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')) as { createdAt?: number }).createdAt : undefined
      if (typeof at === 'number') createdAtByDb.set(dbPath, at)
      return at
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

export function readCursorTranscript(session: TranscriptSession, home: string): AgentTranscriptTurn[] | undefined {
  const agent = (session.facts?.agent ?? '').toLowerCase()
  if (!session.cwd || (agent && !agent.includes('cursor'))) return undefined
  const since = (session.since ?? 0) - START_SKEW_MS
  const newest = chatDbs(session.cwd, home)
    .map((path) => ({ path, createdAt: createdAtOf(path) }))
    .filter((c): c is { path: string; createdAt: number } => c.createdAt !== undefined && c.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!newest) return undefined
  const stamp = stampOf(newest.path)
  const hit = cache.get(newest.path)
  if (hit?.stamp === stamp) return hit.turns
  try {
    const db = new Database(newest.path, { readonly: true, fileMustExist: true })
    try {
      const turns = parse(db, newest.createdAt)
      cache.set(newest.path, { stamp, turns })
      return turns
    } finally {
      db.close()
    }
  } catch {
    return hit?.turns
  }
}
