import { appendFileSync, existsSync, readFileSync } from 'fs'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { decryptLine, encryptLine } from '../store/safe-storage'
import { CONFIG } from '../../shared/config'
import { isAppMode } from '../../shared/mode'
import type { AppMode } from '../../shared/types'
import type { InsightBucket } from './signal-collector'

// What ended a shown suggestion. `accepted` stays a separate boolean (ranker +
// acceptRateByContext read it) — `decision` is the richer companion that splits
// the "not accepted" bucket into WHY:
//   accepted   → user picked this chip
//   rejected   → user actively dismissed (Esc→Enter / ✕), OR picked a sibling chip
//   superseded → a newer prediction replaced this bubble before a choice
//   ignored    → bubble torn down while live (app quit / manager stopped)
export type SuggestionDecision = 'accepted' | 'rejected' | 'superseded' | 'ignored'
export const SUGGESTION_DECISIONS: SuggestionDecision[] = [
  'accepted',
  'rejected',
  'superseded',
  'ignored'
]

export interface Outcome {
  ts: string
  front_app: string
  mode: AppMode
  instruction_stem: string
  shown_index: number
  accepted: boolean
  // Wall-clock ms the LLM took to generate the suggestion batch this row belongs
  // to (measured at the predict() call site). Same value on every row from one
  // batch. Optional so legacy rows (written before this field) still decode.
  gen_ms?: number
  // The decision that ended this suggestion. Optional so legacy rows (written
  // before this field) still decode — a missing value means "unknown", which
  // analytics infers from `accepted` (true → accepted, false → rejected).
  decision?: SuggestionDecision
  // Which provider + model generated this batch — the audit fields. `mightymouse`
  // is the billed cloud backend; `claude`/`codex` are the free local CLIs. Optional
  // so legacy rows (written before these fields) still decode.
  backend?: string
  model?: string
}

interface StemCounts {
  accepted: number
  dismissed: number
  lastTs: number
}

export interface StemRate {
  stem: string
  accepted: number
  dismissed: number
  rate: number
  lastTs: number
}

const EMPTY: Outcome[] = []

export function outcomeTimestamp(): string {
  return new Date().toISOString()
}

function decodeLine(line: string): Outcome | null {
  const plain = decryptLine(line)
  if (plain === null) return null
  const trimmed = plain.trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed) as Outcome
    if (
      typeof parsed.ts === 'string' &&
      typeof parsed.front_app === 'string' &&
      isAppMode(parsed.mode) &&
      typeof parsed.instruction_stem === 'string' &&
      typeof parsed.shown_index === 'number' &&
      typeof parsed.accepted === 'boolean'
    ) {
      return parsed
    }
  } catch {}
  return null
}

export function createOutcomeStore(filePath: string): {
  record: (outcome: Outcome) => void
  readRecent: (limit?: number) => Outcome[]
  readAll: () => Outcome[]
  acceptRateByContext: (bucket: InsightBucket) => Map<string, StemRate>
} {
  const readRecent = (limit = CONFIG.SUGGESTIONS.OUTCOME_RECENT): Outcome[] => {
    if (!existsSync(filePath)) return EMPTY
    try {
      const rows: Outcome[] = []
      const lines = readFileSync(filePath, 'utf-8').split('\n')
      for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
        const line = lines[i]
        if (line.trim() === '') continue
        const row = decodeLine(line)
        if (row) rows.push(row)
      }
      return rows
    } catch (err) {
      console.error('Failed to read suggestion outcomes:', err)
      return EMPTY
    }
  }

  return {
    record(outcome: Outcome): void {
      if (PREFS.getIncognito()) return
      try {
        appendFileSync(filePath, encryptLine(JSON.stringify(outcome)) + '\n', 'utf-8')
      } catch (err) {
        console.error('Failed to append suggestion outcome:', err)
      }
    },

    readRecent,

    // Full history (analytics range-filters itself). Reuses readRecent's
    // newest-first decode with no count cap.
    readAll: () => readRecent(Infinity),

    acceptRateByContext(bucket: InsightBucket): Map<string, StemRate> {
      const counts = new Map<string, StemCounts>()
      for (const row of readRecent()) {
        if (row.front_app !== bucket.front_app) continue
        const prev = counts.get(row.instruction_stem) ?? {
          accepted: 0,
          dismissed: 0,
          lastTs: 0
        }
        if (row.accepted) prev.accepted += 1
        else prev.dismissed += 1
        prev.lastTs = Math.max(prev.lastTs, Date.parse(row.ts) || 0)
        counts.set(row.instruction_stem, prev)
      }

      const rates = new Map<string, StemRate>()
      for (const [stem, value] of counts) {
        const total = value.accepted + value.dismissed
        rates.set(stem, {
          stem,
          accepted: value.accepted,
          dismissed: value.dismissed,
          rate: total > 0 ? value.accepted / total : 0,
          lastTs: value.lastTs
        })
      }
      return rates
    }
  }
}

export const OutcomeStore = createOutcomeStore(PATHS.OUTCOMES)
