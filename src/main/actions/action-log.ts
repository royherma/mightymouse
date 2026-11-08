import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync } from 'fs'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { decryptLine, encryptLine } from '../store/safe-storage'
import type {
  ActionContextSnapshot,
  ActionOutcomeKind,
  ActionSlotValues,
  ActionTrigger
} from '../../shared/action-engine'
import { invalidatePersonalModel } from './personal-model'

const MAX_TRANSCRIPT_CHARS = 500
const TAIL_BYTES_PER_ROW = 2048

export interface ActionDecisionRow {
  runId: string
  trigger: ActionTrigger
  transcript: string
  context: ActionContextSnapshot
  offered: { actionId: string; percent: number }[]
  topActionId: string
  slots: ActionSlotValues
  isCommand: boolean
  latencyMs: number
  via: 'proxy' | 'direct'
  inputTokens: number
  skipped?: string
}

export interface ActionOutcomeRow {
  runId: string
  trigger: ActionTrigger
  frontApp: string
  topActionId: string
  chosenActionId: string
  suggestedSlots: ActionSlotValues
  slots: ActionSlotValues
  outcome: ActionOutcomeKind
  ok: boolean
  line: string
  runMs: number
}

export type ActionLogRow =
  | ({ ts: string; event: 'decided' } & ActionDecisionRow)
  | ({ ts: string; event: 'outcome' } & ActionOutcomeRow)

function appendRow(row: ActionLogRow): void {
  if (PREFS.getIncognito()) return
  try {
    appendFileSync(PATHS.ACTION_LOG, encryptLine(JSON.stringify(row)) + '\n', 'utf-8')
  } catch (err) {
    console.error('Failed to append action log row:', err)
  }
}

export function appendActionDecision(row: ActionDecisionRow): void {
  appendRow({
    ts: new Date().toISOString(),
    event: 'decided',
    ...row,
    transcript: row.transcript.slice(0, MAX_TRANSCRIPT_CHARS)
  })
}

export function appendActionOutcome(row: ActionOutcomeRow): void {
  appendRow({
    ts: new Date().toISOString(),
    event: 'outcome',
    ...row,
    line: row.line.slice(0, MAX_TRANSCRIPT_CHARS)
  })
  invalidatePersonalModel()
}

function decodeRow(line: string): ActionLogRow | null {
  const plain = decryptLine(line)
  if (plain === null) return null
  const trimmed = plain.trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed) as ActionLogRow
    if (
      typeof parsed.ts === 'string' &&
      (parsed.event === 'decided' || parsed.event === 'outcome')
    ) {
      return parsed
    }
  } catch {}
  return null
}

function tailLines(path: string, bytes: number): { lines: string[]; whole: boolean } {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const tail = Buffer.alloc(length)
    readSync(fd, tail, 0, length, size - length)
    const lines = tail.toString('utf-8').split('\n')
    return length === size ? { lines, whole: true } : { lines: lines.slice(1), whole: false }
  } finally {
    closeSync(fd)
  }
}

export function readRecentActionRows(limit: number): ActionLogRow[] {
  if (!existsSync(PATHS.ACTION_LOG)) return []
  try {
    for (let bytes = limit * TAIL_BYTES_PER_ROW; ; bytes *= 4) {
      const { lines, whole } = tailLines(PATHS.ACTION_LOG, bytes)
      const rows: ActionLogRow[] = []
      for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
        const line = lines[i]
        if (line.trim() === '') continue
        const row = decodeRow(line)
        if (row) rows.push(row)
      }
      if (rows.length >= limit || whole) return rows.reverse()
    }
  } catch (err) {
    console.error('Failed to read action log:', err)
    return []
  }
}
