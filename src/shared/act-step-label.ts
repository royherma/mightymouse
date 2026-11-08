/**
 * Turns one live act-run tool call into a short line a human can read off the
 * phone mirror — "click 812,340", "type “cats”", "Reading Safari".
 *
 * Sibling of src/main/backend/act-highlight.ts, which parses the SAME mm-input
 * grammar (CONFIG.SYSTEM_PROMPT_ACT_SCREEN) for the highlight overlay. That one
 * imports electron for the px→point conversion, so it can't be reused here:
 * this file is pure string work, lives in shared/, and is unit-testable without
 * an Electron seam.
 *
 * Best-effort by design. A verb we don't recognise falls back to something
 * still true and still readable, never null — a blank bubble mid-run reads as
 * "it froze", which is worse than a vague label.
 */

import type { RunEvent } from './types'
import { RUN_EVENT } from './types'

/** mm-input verbs that carry a single x y target. */
const POINT_VERBS = ['move', 'click', 'rightclick', 'doubleclick', 'tripleclick'] as const

const DRAG_RE = /\bdrag\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\b/
const POINT_RE = new RegExp(`\\b(${POINT_VERBS.join('|')})\\s+(-?\\d+)\\s+(-?\\d+)\\b`)
const SCROLL_RE = /\bscroll\s+(-?\d+)\s+(-?\d+)\b/
// `type` and `key` take a quoted string; the agent may use single or double
// quotes, so capture whichever opened and require the same one to close.
const TEXT_RE = /\b(type|key)\s+(['"])([\s\S]*?)\2/
const MM_INPUT_RE = /\bmm-input\b/

/** Longest a step label may run before it stops being glanceable on a mirror. */
const MAX_LABEL = 60

function commandOf(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in input) {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === 'string') return cmd
  }
  return null
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat
}

/** The label for an mm-input command, or null if it isn't one we can read. */
function inputLabel(cmd: string): string | null {
  const drag = DRAG_RE.exec(cmd)
  if (drag) return `drag ${drag[1]},${drag[2]} → ${drag[3]},${drag[4]}`

  const point = POINT_RE.exec(cmd)
  if (point) return `${point[1]} ${point[2]},${point[3]}`

  const scroll = SCROLL_RE.exec(cmd)
  if (scroll) return `scroll ${scroll[1]},${scroll[2]}`

  const text = TEXT_RE.exec(cmd)
  if (text) return `${text[1]} “${truncate(text[3])}”`

  return null
}

/**
 * One readable line for a live run event, or null when the event isn't a step
 * worth showing (assistant text, a tool RESULT, a run-level edge).
 */
export function actStepLabel(event: RunEvent): string | null {
  if (event.kind !== RUN_EVENT.tool_start) return null

  if (event.name === 'Bash') {
    const cmd = commandOf(event.input)
    if (!cmd) return null
    if (MM_INPUT_RE.test(cmd)) {
      // An mm-input call we can't parse still happened — say so rather than
      // dropping the only evidence the agent did something.
      return inputLabel(cmd) ?? 'acting on screen'
    }
    return `run ${truncate(cmd)}`
  }

  return truncate(event.name)
}
