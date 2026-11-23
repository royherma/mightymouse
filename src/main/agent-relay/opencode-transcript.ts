import Database from 'better-sqlite3'
import { statSync } from 'fs'
import { join } from 'path'
import type { AgentTranscriptTurn } from '../../shared/types'
import type { TranscriptSession } from './session-transcript'

const START_SKEW_MS = 60_000
const TEXT_MAX = 4000
const TOOL_DETAIL_MAX = 80

type Cached = { stamp: string; turns: AgentTranscriptTurn[] }
const cache = new Map<string, Cached>()

function stampOf(dbPath: string): string | null {
  try {
    const parts = [dbPath, `${dbPath}-wal`].map((p) => {
      try {
        return statSync(p).mtimeMs
      } catch {
        return 0
      }
    })
    return statSync(dbPath) ? parts.join(':') : null
  } catch {
    return null
  }
}

function toolLine(part: { tool?: string; state?: { input?: Record<string, unknown>; title?: string } }): string {
  const input = part.state?.input ?? {}
  const detail = [input.filePath, input.command, input.pattern, input.url, input.description, part.state?.title].find(
    (v): v is string => typeof v === 'string' && v.length > 0
  )
  return detail ? `${part.tool}: ${detail.replace(/\s+/g, ' ').slice(0, TOOL_DETAIL_MAX)}` : String(part.tool ?? 'tool')
}

function parse(db: Database.Database, session: TranscriptSession): AgentTranscriptTurn[] {
  const since = session.since ?? 0
  const rows = db
    .prepare('SELECT id, time_created FROM session WHERE directory = ? AND parent_id IS NULL AND time_created >= ?')
    .all(session.cwd, since - START_SKEW_MS) as { id: string; time_created: number }[]
  if (!rows.length) return []
  const row = rows.reduce((a, b) => (Math.abs(b.time_created - since) < Math.abs(a.time_created - since) ? b : a))
  const messages = db
    .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
    .all(row.id) as { id: string; time_created: number; data: string }[]
  const partsByMessage = new Map<string, string[]>()
  const parts = db
    .prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id')
    .all(row.id) as { message_id: string; data: string }[]
  for (const p of parts) {
    const list = partsByMessage.get(p.message_id) ?? []
    list.push(p.data)
    partsByMessage.set(p.message_id, list)
  }
  const turns: AgentTranscriptTurn[] = []
  for (const m of messages) {
    let info: { role?: string; error?: { data?: { message?: string }; name?: string } }
    try {
      info = JSON.parse(m.data)
    } catch {
      continue
    }
    const role = info.role === 'user' ? 'you' : 'agent'
    const at = m.time_created
    for (const raw of partsByMessage.get(m.id) ?? []) {
      let part: { type?: string; text?: string; synthetic?: boolean; tool?: string; state?: { input?: Record<string, unknown>; title?: string } }
      try {
        part = JSON.parse(raw)
      } catch {
        continue
      }
      if (part.type === 'text' && part.text?.trim() && !part.synthetic) {
        turns.push({ role, at, text: part.text.trim().slice(0, TEXT_MAX) })
      } else if (part.type === 'tool') {
        turns.push({ role: 'tool', at, text: toolLine(part) })
      }
    }
    const error = info.error?.data?.message ?? info.error?.name
    if (error) turns.push({ role: 'agent', at, text: error.slice(0, TEXT_MAX) })
  }
  return turns
}

export function readOpencodeTranscript(session: TranscriptSession, home: string): AgentTranscriptTurn[] | undefined {
  if (!(session.facts?.agent ?? '').toLowerCase().includes('opencode') || !session.cwd) return undefined
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
  const stamp = stampOf(dbPath)
  if (!stamp) return []
  const key = `${dbPath}|${session.cwd}|${session.since ?? 0}`
  const hit = cache.get(key)
  if (hit?.stamp === stamp) return hit.turns
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const turns = parse(db, session)
    cache.set(key, { stamp, turns })
    return turns
  } catch {
    return []
  } finally {
    db?.close()
  }
}
