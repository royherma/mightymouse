import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { AgentTranscriptTurn } from '../../shared/types'
import type { TranscriptSession } from './session-transcript'

type Field = { f: number; v: bigint | Buffer }

const STEP_USER = 14
const STEP_MODEL = 15
const TEXT_MAX = 4000
const DETAIL_MAX = 160
const DETAIL_KEYS = ['CommandLine', 'command', 'AbsolutePath', 'TargetFile', 'FilePath', 'Path', 'Query', 'Url', 'query']

function fields(b: Buffer): Field[] {
  const out: Field[] = []
  let i = 0
  const varint = (): bigint => {
    let r = 0n
    let s = 0n
    while (i < b.length) {
      const c = b[i++]
      r |= BigInt(c & 127) << s
      s += 7n
      if (!(c & 128)) break
    }
    return r
  }
  while (i < b.length) {
    const key = Number(varint())
    const f = key >> 3
    const wire = key & 7
    if (wire === 0) out.push({ f, v: varint() })
    else if (wire === 2) {
      const len = Number(varint())
      if (len < 0 || i + len > b.length) return out
      out.push({ f, v: b.subarray(i, i + len) })
      i += len
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else return out
  }
  return out
}

const sub = (b: Buffer, f: number): Buffer | undefined => {
  const hit = fields(b).find((x) => x.f === f && Buffer.isBuffer(x.v))
  return hit?.v as Buffer | undefined
}
const str = (b: Buffer | undefined, f: number): string => sub(b ?? Buffer.alloc(0), f)?.toString('utf8') ?? ''

function stepMs(payload: Buffer): number {
  const seconds = fields(sub(sub(payload, 5) ?? Buffer.alloc(0), 1) ?? Buffer.alloc(0)).find((x) => x.f === 1)?.v
  return typeof seconds === 'bigint' ? Number(seconds) * 1000 : 0
}

function toolLine(call: Buffer): string {
  const name = str(call, 2)
  if (!name) return ''
  let detail = ''
  try {
    const args = JSON.parse(str(call, 3)) as Record<string, unknown>
    const key = DETAIL_KEYS.find((k) => typeof args[k] === 'string' && args[k])
    detail = key ? String(args[key]).replace(/\s+/g, ' ').slice(0, DETAIL_MAX) : ''
  } catch {
    detail = ''
  }
  return detail ? `${name} · ${detail}` : name
}

function turnsOf(dbPath: string): AgentTranscriptTurn[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare('select step_type t, step_payload p from steps where step_type in (?, ?) order by idx')
      .all(STEP_USER, STEP_MODEL) as { t: number; p: Buffer }[]
    const turns: AgentTranscriptTurn[] = []
    for (const { t, p } of rows) {
      const at = stepMs(p)
      if (t === STEP_USER) {
        const text = str(sub(p, 19), 2).trim()
        if (text) turns.push({ role: 'you', at, text: text.slice(0, TEXT_MAX) })
        continue
      }
      const body = sub(p, 20)
      if (!body) continue
      const text = str(body, 1).trim()
      if (text) turns.push({ role: 'agent', at, text: text.slice(0, TEXT_MAX) })
      for (const f of fields(body)) {
        if (f.f !== 7 || !Buffer.isBuffer(f.v)) continue
        const line = toolLine(f.v)
        if (line) turns.push({ role: 'tool', at, text: line })
      }
    }
    return turns
  } finally {
    db.close()
  }
}

const isAgyPid = new Map<string, boolean>()
function runsAgy(session: TranscriptSession): boolean {
  const pid = session.facts?.agentPid
  if (!pid) return false
  const key = `${pid}:${session.since ?? 0}`
  const known = isAgyPid.get(key)
  if (known !== undefined) return known
  let agy = false
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()
    agy = basename(args.split(/\s+/)[0] ?? '') === 'agy'
  } catch {
    agy = false
  }
  isAgyPid.set(key, agy)
  return agy
}

const CREATED = /Created conversation ([0-9a-f-]{36})/
const convByPid = new Map<string, string>()
function conversationFromLog(pid: number, key: string): string {
  const hit = convByPid.get(key)
  if (hit) return hit
  try {
    const open = execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8', timeout: 3000 })
    const log = open.split('\n').find((l) => /^n.*\/antigravity-cli\/log\/cli-.*\.log$/.test(l))?.slice(1)
    const id = log ? CREATED.exec(readFileSync(log, 'utf8'))?.[1] : undefined
    if (id) convByPid.set(key, id)
    return id ?? ''
  } catch {
    return ''
  }
}

function newestDbForCwd(dir: string, cwd: string, since: number): string {
  let best = ''
  let bestAt = 0
  const needle = Buffer.from(`file://${cwd}`)
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db')) continue
    const path = join(dir, name)
    const born = statSync(path).birthtimeMs
    if (born < since - 5000 || born < bestAt) continue
    try {
      const db = new Database(path, { readonly: true, fileMustExist: true })
      const row = db.prepare('select step_payload p from steps where idx = 0').get() as { p: Buffer } | undefined
      db.close()
      if (row?.p.includes(needle)) {
        best = path
        bestAt = born
      }
    } catch {
      continue
    }
  }
  return best
}

const cache = new Map<string, { mtime: number; turns: AgentTranscriptTurn[] }>()

export function readAntigravityTranscript(session: TranscriptSession, home: string): AgentTranscriptTurn[] | undefined {
  if (!runsAgy(session)) return undefined
  const dir = join(home, '.gemini', 'antigravity-cli', 'conversations')
  if (!existsSync(dir)) return []
  const pid = session.facts?.agentPid as number
  const key = `${pid}:${session.since ?? 0}`
  const id = conversationFromLog(pid, key)
  const path = id ? join(dir, `${id}.db`) : session.cwd ? newestDbForCwd(dir, session.cwd, session.since ?? 0) : ''
  if (!path || !existsSync(path)) return []
  const stamp = Math.max(statSync(path).mtimeMs, existsSync(`${path}-wal`) ? statSync(`${path}-wal`).mtimeMs : 0)
  const hit = cache.get(path)
  if (hit && hit.mtime === stamp) return hit.turns
  try {
    const turns = turnsOf(path)
    cache.set(path, { mtime: stamp, turns })
    return turns
  } catch {
    return hit?.turns ?? []
  }
}
