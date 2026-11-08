/**
 * A rolling log of what each arrow press did to focus.
 *
 * `last-key-seen.ts` holds ONE key and overwrites it, which answers "did the
 * last press arrive" and nothing else. The question on a cursorless host is
 * different and needs history: the ring appears stuck, and "stuck" has three
 * causes that look identical in the hand -- the key never reached JS, the
 * handler was never installed because the cursorless gate read false, or the
 * key arrived and every candidate was rejected. Which one it is decides the
 * fix, and a single overwritten string cannot say.
 *
 * So each press records where focus was, where it went, and how many
 * candidates were in play. `cands:0` means the selector matched nothing (a
 * scoping bug); `cands:12 -> edge` means the geometry rejected all twelve (a
 * direction bug). Those need opposite fixes.
 *
 * Same shape and reasoning as `keyboard-trace.ts`: DOM-free, capped, and
 * formatted into the existing debug paste so there is one thing to send.
 */

/** ~2 screens of pasted text, and comfortably more presses than anyone makes
 *  before giving up on a stuck ring. Old entries are the ones that stop
 *  mattering, so the buffer drops from the front. */
const MAX_ENTRIES = 40

interface NavEntry {
  key: string
  from: string
  to: string
  candidates: number
  at: string
}

const entries: NavEntry[] = []

/** `HH:MM:SS.mmm`, local. Millisecond precision because the question these lines
 *  answer is usually about a burst -- whether four hops were one swipe or four. */
function clockTime(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Ships each hop to the Mac's dev log so a swipe can be WATCHED instead of
 *  screenshotted and read back. A plain sink rather than a React dep because
 *  the traversal handler is installed once at boot, outside the tree. */
let sink: ((line: string) => void) | null = null

export function setNavTraceSink(fn: ((line: string) => void) | null): void {
  sink = fn
}

/** Repaints the on-screen readout. Injected, not imported, for the same reason
 *  the sink is: this module stays DOM-free. */
let onNote: (() => void) | null = null

export function setNavTraceObserver(fn: (() => void) | null): void {
  onNote = fn
}

/** The ring's membership, not just its size. A count that changes between two
 *  presses (`cands:11` then `cands:10`) says a node left the ring and cannot say
 *  WHICH -- and the candidate that silently drops is the whole bug on a host
 *  where focus is the cursor. Logged on the first press and thereafter only when
 *  the roster changes, so a steady ring costs one line, not one per swipe. */
let lastRoster = ''

export function noteNav(
  key: string,
  from: string,
  to: string,
  candidates: number,
  roster?: string[]
): void {
  const at = clockTime()
  if (roster) {
    const joined = roster.join(' | ')
    if (joined !== lastRoster) {
      lastRoster = joined
      try {
        sink?.(`[nav] ${at} ring(${roster.length}): ${joined}`)
      } catch {
        // Same rule as below -- a trace must never break traversal.
      }
    }
  }
  entries.push({ key, from, to, candidates, at })
  if (entries.length > MAX_ENTRIES) entries.shift()
  try {
    onNote?.()
  } catch {
    // Same rule as the sink below -- a trace must never break traversal.
  }
  // Never let a dead socket break traversal -- send() drops silently when the
  // socket isn't OPEN, but a throwing sink would take the ring down with it.
  try {
    // Wall-clock on every line. Without it a log full of identical hops cannot
    // be dated, so traces from a previous session read as current -- which is
    // exactly how a stale bundle's output got diagnosed as today's bug.
    sink?.(`[nav] ${at} ${key} cands:${candidates} ${from} -> ${to}`)
  } catch {
    // A trace that breaks the thing it traces is worse than no trace.
  }
}

/** A node reduced to something recognisable in a paste: `button.proMic` beats
 *  `[object HTMLButtonElement]` when the question is which control the ring
 *  landed on. */
export function describeNode(el: Element | null): string {
  if (!el) return 'none'
  const tag = el.tagName.toLowerCase()
  // `className` on an SVG element is an SVGAnimatedString, not a string, so
  // String() on it yields "[object SVGAnimatedString]" and every SVG logged as
  // the same useless name. getAttribute is the one form that works for both.
  const cls = (el.getAttribute('class') ?? '').split(' ').filter(Boolean)[0]
  const label = el.getAttribute('aria-label') ?? el.getAttribute('title')
  return `${tag}${cls ? '.' + cls : ''}${label ? `[${label}]` : ''}`
}

/** Where the last hop LANDED, as the readout's `focus:` line.
 *
 *  Deliberately not `document.activeElement`: the readout repaints through
 *  React, a frame or more after focus actually moved, so reading the DOM at
 *  render time shows the hop before last. That made a correct, instant ring look
 *  badly lagged on the glasses -- the highlight was already right and only the
 *  numbers were behind. Null before the first arrow, so the caller can fall back
 *  to whatever the browser focused on load. */
export function readLastNavTarget(): string | null {
  return entries[entries.length - 1]?.to ?? null
}

/** The last hop only, for the one-line status readout -- the whole point is
 *  seeing where the ring went without stopping to copy a report. */
export function readLastNav(): string {
  const e = entries[entries.length - 1]
  return e ? `${e.at} ${e.key}/${e.candidates}/${e.to}` : '-'
}

export function formatNavTrace(): string {
  if (entries.length === 0) return '(no arrow keys seen)'
  return entries.map((e) => `${e.at} ${e.key} cands:${e.candidates} ${e.from} -> ${e.to}`).join('\n')
}
