import { RUN_EVENT } from '../../../shared/types'
import type { RunEvent, ToolStartEvent, ToolEndEvent } from '../../../shared/types'

// ── run-events ─────────────────────────────────────────────────────────────
// Shared reducer for turning a live RunEvent stream into a renderable timeline —
// used by both the Run Transcript Inspector overlay (TranscriptApp.tsx) and
// Mighty chat's inline step rendering (ChatTab in MightyApp.tsx), so the two
// surfaces don't fork their own copies of tool-call pairing logic.

/** One tool call, assembled from its start (+ maybe end) events. */
export interface ToolRow {
  key: string
  id: string
  name: string
  input: unknown
  /** Set once the matching tool_end arrives. */
  output?: unknown
  isError?: boolean
  done: boolean
}

/** A rendered timeline entry — a tool call, a thinking block, or assistant text. */
export type TimelineItem =
  | { kind: 'tool'; row: ToolRow }
  | { kind: typeof RUN_EVENT.thinking; key: string; text: string }
  | { kind: typeof RUN_EVENT.text; key: string; text: string }

/**
 * Fold one RunEvent into a timeline array, pairing tool_start/tool_end by id and
 * appending thinking/text as their own entries. `usage` events are handled by the
 * caller separately (not part of the ordered timeline). Returns a NEW array
 * (or the same array reference when the event doesn't change the timeline, e.g.
 * a usage event) — safe to use directly inside a setState updater.
 */
export function foldRunEvent(prev: TimelineItem[], event: RunEvent, nextKey: () => number): TimelineItem[] {
  if (event.kind === RUN_EVENT.tool_start) {
    const e = event as ToolStartEvent
    return [
      ...prev,
      { kind: 'tool', row: { key: `t-${nextKey()}`, id: e.id, name: e.name, input: e.input, done: false } }
    ]
  }
  if (event.kind === RUN_EVENT.tool_end) {
    const e = event as ToolEndEvent
    const next = [...prev]
    // Attach to the most recent still-open tool row with this id.
    for (let i = next.length - 1; i >= 0; i--) {
      const it = next[i]
      if (it.kind === 'tool' && it.row.id === e.id && !it.row.done) {
        next[i] = { kind: 'tool', row: { ...it.row, output: e.output, isError: e.isError, done: true } }
        break
      }
    }
    return next
  }
  if (event.kind === RUN_EVENT.thinking) {
    return [...prev, { kind: RUN_EVENT.thinking, key: `k-${nextKey()}`, text: event.text }]
  }
  if (event.kind === RUN_EVENT.text) {
    return [...prev, { kind: RUN_EVENT.text, key: `x-${nextKey()}`, text: event.text }]
  }
  return prev
}

/** Compact, readable rendering of an arbitrary tool input/output value. */
export function stringifyToolValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** A one-line preview of a tool's input for a collapsed header (command, path, …). */
export function toolInputPreview(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const pick = o.command ?? o.file_path ?? o.path ?? o.query ?? o.description ?? o.pattern ?? o.url
    if (typeof pick === 'string') return pick
  }
  return stringifyToolValue(input).replace(/\s+/g, ' ').trim()
}
