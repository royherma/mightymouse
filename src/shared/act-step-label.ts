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
// Quoted (either quote, same one closes) or bare up to the line end or a shell operator (&& ; | 2>&1).
const TEXT_RE = /\b(type|key)\s+(?:(['"])([\s\S]*?)\2|([^\s'"](?:(?!\s*(?:[;&|]|\d*[<>]))[^\n])*))/
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
  if (text) return `${text[1]} “${truncate((text[3] ?? text[4]).trim())}”`

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

const NARRATION_MAX = 70

function inputField(input: unknown, key: string): string | null {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return truncate(url)
  }
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function firstSentence(text: string): string | null {
  const plain = text.replace(/[`*_#>]/g, '').trim()
  const end = plain.search(/[.!?](\s|$)|\n/)
  const line = (end === -1 ? plain : plain.slice(0, end)).trim()
  return line.length < 3 ? null : clip(line, NARRATION_MAX)
}

const SCROLL_DIR_RE = /\bscroll\s+(up|down|left|right)\b/
const HIGHLIGHT_RE = /\bhighlight\s+-?\d+\s+-?\d+/

// Varied by step count so three clicks in a row read as progress, not a frozen label.
const SAY = {
  look: ['Peeking at your screen', 'Eyes on the screen', 'Checking what changed', 'Taking another look'],
  click: ['Clicking', 'Clicking the next bit', 'One more click', 'Pressing that button'],
  keys: ['Hitting a shortcut', 'Pressing keys'],
  drag: ['Dragging it into place'],
  mouse: ['Moving the mouse'],
  point: ['Pointing it out on screen'],
  app: ['Nudging an app', 'Steering an app'],
  command: ['Running a quick command', 'Doing some behind-the-scenes work'],
  page: ['Reading the page', 'Skimming the page'],
  search: ['Searching the web', 'Digging around the web'],
  readFile: ['Reading a file', 'Flipping through a file'],
  writeFile: ['Writing a file', 'Saving that down'],
  findFiles: ['Hunting through your files', 'Searching your files'],
  helper: ['Calling in a helper']
} as const

function pick(pool: readonly string[], n: number): string {
  return pool[n % pool.length]
}

function opening(target: string, n: number, site: boolean): string {
  return site ? pick([`Heading to ${target}`, `Opening ${target}`], n) : pick([`Opening ${target}`, `Popping open ${target}`], n)
}

function bashStep(cmd: string, n: number): string | null {
  if (MM_INPUT_RE.test(cmd)) {
    const text = TEXT_RE.exec(cmd)
    if (text) return text[1] === 'type' ? `Typing “${clip((text[3] ?? text[4]).trim(), 40)}”` : pick(SAY.keys, n)
    if (DRAG_RE.test(cmd)) return pick(SAY.drag, n)
    const dir = SCROLL_DIR_RE.exec(cmd)
    if (dir || SCROLL_RE.test(cmd)) return dir ? `Scrolling ${dir[1]}` : 'Scrolling'
    const point = POINT_RE.exec(cmd)
    if (point) return point[1] === 'move' ? null : pick(SAY.click, n)
    return pick(SAY.mouse, n)
  }
  if (HIGHLIGHT_RE.test(cmd)) return pick(SAY.point, n)
  const app = /\bopen\s+-a\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd)
  if (app) return opening(app[1] ?? app[2] ?? app[3], n, false)
  const url = /\bopen\s+["']?(https?:\/\/[^\s"']+)/.exec(cmd)
  if (url) return opening(hostOf(url[1]), n, true)
  if (/\bscreencapture\b|mm-shot/.test(cmd)) return pick(SAY.look, n)
  if (/\bosascript\b/.test(cmd)) return pick(SAY.app, n)
  return pick(SAY.command, n)
}

/** Words for the voice pill ("Heading to x.com", "Typing “hi”"); `n` varies repeats. null = keep the last step. */
export function friendlyStep(event: RunEvent, n = 0): string | null {
  if (event.kind === RUN_EVENT.text) return firstSentence(event.text)
  if (event.kind !== RUN_EVENT.tool_start) return null
  const name = event.name.replace(/^mcp__.+?__/, '')
  const url = inputField(event.input, 'url')
  if (name === 'Bash') {
    const cmd = commandOf(event.input)
    return cmd ? bashStep(cmd, n) : null
  }
  if (/screenshot/i.test(name)) return pick(SAY.look, n)
  if (name === 'browser_open') return url ? opening(hostOf(url), n, true) : 'Opening a page'
  if (name === 'browser_read' || name === 'browser_attach') return pick(SAY.page, n)
  if (name === 'browser_type' || name === 'browser_fill') {
    const text = inputField(event.input, 'text') ?? inputField(event.input, 'value')
    return text ? `Typing “${clip(text, 40)}”` : 'Typing'
  }
  if (name === 'browser_press') return pick(SAY.keys, n)
  if (name === 'WebSearch') return pick(SAY.search, n)
  if (name === 'WebFetch') return url ? pick([`Reading ${hostOf(url)}`, `Skimming ${hostOf(url)}`], n) : pick(SAY.page, n)
  if (name === 'Read') return pick(SAY.readFile, n)
  if (name === 'Write' || name === 'Edit') return pick(SAY.writeFile, n)
  if (name === 'Grep' || name === 'Glob') return pick(SAY.findFiles, n)
  if (name === 'Task' || name === 'Agent') return pick(SAY.helper, n)
  return null
}
