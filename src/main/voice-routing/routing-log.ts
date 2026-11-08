import type { PageOwner } from './page-owner'
// routing-log.ts — one JSONL row per routing decision.
//
// This is the ONLY evidence of whether the ranking is any good. The number that
// matters is the override rate: how often the user picks something other than
// the sink Jev suggested. A high rate means the ranking is wrong and the feature
// is costing time rather than saving it.
//
// Records the transcript and the full option list Jev ranked, each with the
// description string that was actually sent as Choice criteria — that string IS
// the basis of the ranking, so a bad pick is otherwise undiagnosable (the user hit a
// case that recommended "Robot Jobs HQ" for a note about "Kuna" and there was no
// way to see why). The user asked for this explicitly 2026-09-18, reversing the
// earlier no-transcript design. Capped rather than unbounded: TRANSCRIPT_CAP
// chars of transcript and MAX_OPTIONS options logged per row, since a runaway
// past either is itself a bug worth seeing rather than data worth keeping whole.
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync } from 'fs'
import { PATHS } from '../store/paths'

const TRANSCRIPT_CAP = 2000
const MAX_OPTIONS = 40

export interface RoutingOption {
  id: string
  label: string
  /** The description string sent to Jev as Choice criteria — the whole basis
   *  of the ranking. If a pick looks wrong, this is the first thing to read. */
  description: string
  /** 0-100, Jev's probability for this option. */
  percent: number
}

export interface RoutingDecision {
  runId: string
  transcript: string
  chars: number
  frontmostSinkId: string
  /** What was actually on screen, exactly as Jev received it. Without this a
   *  wrong pick is undiagnosable: the app the note was about is the single
   *  biggest input to the ranking, and it used to be nowhere in the row. */
  screen: { appName: string; title: string; url: string } | null
  suggestedSinkId: string
  confidence: number
  latencyMs: number
  /** Every sink + helper Jev was offered, ranked highest percent first. */
  options: RoutingOption[]
  pageOwner: PageOwner | null
}

export interface RoutingOutcome {
  runId: string
  chosenSinkId: string
  /** True when the user picked a sink other than the one Jev suggested. */
  overrode: boolean
  mode: string
  submitted: boolean
  via: 'row' | 'search'
  query: string
  variant?: string
}

function append(row: Record<string, unknown>): void {
  try {
    appendFileSync(PATHS.VOICE_ROUTING_LOG, `${JSON.stringify(row)}\n`, 'utf-8')
  } catch (err) {
    console.error('routing-log: append failed:', err)
  }
}

/** Truncate the transcript and option list so one bad-looking recording can't
 *  balloon the file. Both caps are generous for normal dictation — a hit means
 *  something unusual happened, which is itself worth the "…truncated" marker. */
function capDecision(decision: RoutingDecision): Record<string, unknown> {
  const transcript =
    decision.transcript.length > TRANSCRIPT_CAP
      ? `${decision.transcript.slice(0, TRANSCRIPT_CAP)}…[truncated ${decision.transcript.length} chars]`
      : decision.transcript
  const options =
    decision.options.length > MAX_OPTIONS
      ? decision.options.slice(0, MAX_OPTIONS)
      : decision.options
  return { ...decision, transcript, options }
}

export function appendRoutingDecision(decision: RoutingDecision): void {
  append({ ts: new Date().toISOString(), event: 'ranked', ...capDecision(decision) })
}

export function appendRoutingOutcome(outcome: RoutingOutcome): void {
  append({ ts: new Date().toISOString(), event: 'delivered', ...outcome })
}

const PICK_WINDOW = 300
// Tail read: the log grows forever, and only recent picks should steer.
const TAIL_BYTES = 4 * 1024 * 1024

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const tail = Buffer.alloc(length)
    readSync(fd, tail, 0, length, size - length)
    return tail.toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

/** How often each destination was picked across the last PICK_WINDOW deliveries. */
export function recentPickCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  try {
    if (!existsSync(PATHS.VOICE_ROUTING_LOG)) return counts
    const lines = readTail(PATHS.VOICE_ROUTING_LOG, TAIL_BYTES).split('\n')
    let seen = 0
    for (let i = lines.length - 1; i >= 0 && seen < PICK_WINDOW; i--) {
      if (!lines[i].includes('"delivered"')) continue
      try {
        const row = JSON.parse(lines[i]) as { event?: string; chosenSinkId?: string; submitted?: boolean }
        if (row.event !== 'delivered' || !row.chosenSinkId) continue
        counts[row.chosenSinkId] = (counts[row.chosenSinkId] ?? 0) + 1
        seen++
      } catch {
        continue
      }
    }
  } catch (err) {
    console.error('routing-log: read failed:', err)
  }
  return counts
}
