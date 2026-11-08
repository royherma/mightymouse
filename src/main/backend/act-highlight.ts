import { screen } from 'electron'
import type { RunEvent } from '../../shared/types'
import { RUN_EVENT } from '../../shared/types'

// Parses a live act-run ToolStartEvent for an `mm-input` invocation (per the
// grammar in CONFIG.SYSTEM_PROMPT_ACT_SCREEN) and converts its target coords
// from screenshot pixels to a logical on-screen point, for the highlight
// overlay. Best-effort only — a non-match (unexpected quoting, a verb we
// don't highlight) returns null and the caller silently skips the flash.
// Never throws; must never slow down or gate the real mm-input call.

const POINT_VERBS = ['move', 'click', 'rightclick', 'doubleclick', 'tripleclick'] as const

// Matches `<bin> <verb> <x> <y>` or `<bin> drag <x1> <y1> <x2> <y2>` anywhere
// in the command string (the agent may prefix a path or chain with &&).
const POINT_RE = new RegExp(`\\b(?:${POINT_VERBS.join('|')})\\s+(-?\\d+)\\s+(-?\\d+)\\b`)
const DRAG_RE = /\bdrag\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\b/

function commandOf(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in input) {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === 'string') return cmd
  }
  return null
}

/** Screenshot px → logical screen point, same math as resolvePointAndAct.
 *  Exported for act-control.ts: the `mm-ui highlight` verb receives coordinates
 *  in the SAME screenshot-pixel space the agent reads off the attached image
 *  (2x on Retina), so it needs the identical conversion before the overlay can
 *  ring the right spot. */
export function toScreenPoint(px: number, py: number): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  return {
    x: Math.round(display.bounds.x + px / scale),
    y: Math.round(display.bounds.y + py / scale)
  }
}

/** True when the agent is about to run mm-input via Bash — the one synthesis
 *  path that never reaches macos/input.ts. Matches the binary NAME, since the
 *  agent quotes and chains commands freely. */
export function isActInputCommand(event: RunEvent): boolean {
  if (event.kind !== RUN_EVENT.tool_start || event.name !== 'Bash') return false
  const cmd = commandOf(event.input)
  return cmd !== null && /\bmm-input\b/.test(cmd)
}

/** Extracts a target screen point from a live act-mode Bash tool_start event,
 *  or null if this event isn't an mm-input point/drag call. */
export function parseActHighlightTarget(event: RunEvent): { x: number; y: number } | null {
  if (event.kind !== RUN_EVENT.tool_start || event.name !== 'Bash') return null
  const cmd = commandOf(event.input)
  if (!cmd) return null

  const drag = DRAG_RE.exec(cmd)
  if (drag) {
    const x1 = Number(drag[1])
    const y1 = Number(drag[2])
    const x2 = Number(drag[3])
    const y2 = Number(drag[4])
    return toScreenPoint((x1 + x2) / 2, (y1 + y2) / 2)
  }

  const point = POINT_RE.exec(cmd)
  if (point) {
    return toScreenPoint(Number(point[1]), Number(point[2]))
  }

  return null
}
