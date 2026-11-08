/**
 * A ring buffer of keyboard-lifecycle events, readable off the device.
 *
 * WHY THIS EXISTS: four fixes to the keyboard bar shipped against reasoning
 * rather than evidence, and three of them were wrong. The reason is structural,
 * not carelessness -- everything that matters here happens inside a ~200ms
 * window on a device no debugger is attached to, between a `pointerdown`, an
 * iOS-scheduled `visualViewport` resize, a blur, and two React commits. By the
 * time anyone looks at the screen, the only visible state is the OUTCOME
 * ("keyboard gone"), which is identical for four different causes:
 *
 *   the strip unmounted   (top -> null)
 *   the bar unmounted     (appName -> null)
 *   the keyboard tore down (nativeKeyboardOpen -> false)
 *   the tap never landed   (nothing logged at all)
 *
 * A trace tells them apart in one read, which is what "which value flipped
 * first?" was always asking. Cheap enough to leave in: a bounded array of
 * strings, written only from lifecycle edges, never from a render.
 *
 * Read it by tapping the status line (it rides along in copyDebugReport), or
 * from Safari's console via `window.__mmKbTrace()`.
 */

/**
 * Big enough to survive the trip to the report.
 *
 * The obvious size is ~60 -- one tap is ~10 lines and the interesting window is
 * the most recent one. That is wrong here, because READING the trace costs
 * events: opening Settings dismisses the keyboard, and the dismissal fires a
 * burst of vv:resize. Size it so the incident is still in the buffer after the
 * user has navigated to the button that copies it.
 */
const TRACE_LIMIT = 400

interface TraceEntry {
  t: number
  event: string
  detail: string
  /** Set once an identical line repeats; absent means it happened once. */
  repeat?: number
}

const entries: TraceEntry[] = []
const startedAt = Date.now()

/**
 * Where a flushed trace goes. Set once by App, which owns the socket.
 *
 * A sink rather than an import so this module stays free of the WS: it is
 * imported by KeyboardAccessoryBar, whose pure visibility rule is unit-tested
 * with no browser and no socket at all.
 */
let sink: ((text: string) => void) | null = null

/** How long the phone waits for the burst to finish before shipping it. One
 *  tap's worth of lifecycle (pointerdown, resizes, blur, commits) is over well
 *  inside this; anything longer is a separate incident and gets its own send. */
const FLUSH_QUIET_MS = 600

let flushTimer: ReturnType<typeof setTimeout> | null = null
/** Index of the first entry not yet sent, so a flush never re-sends history. */
let sentUpTo = 0

/**
 * Hard ceiling on blocks per page load, so a stuck loop cannot bury the log.
 *
 * A debounce bounds the RATE but not the TOTAL: a page left open all day with
 * something retriggering the keyboard would still trickle out thousands of
 * blocks and drown the dev log the trace exists to make readable. Diagnosing
 * one incident takes a handful; a reload resets it.
 */
const MAX_BLOCKS_PER_SESSION = 40
let sentBlocks = 0

export function setKbTraceSink(fn: (text: string) => void): void {
  sink = fn
}

/**
 * Ship whatever is new, once the phone has been quiet for a moment.
 *
 * DEBOUNCED, not per-event, and this is the whole design: iOS fires resize
 * bursts, and a message per event would put hundreds of lines through the
 * socket and bury the signal in the very log meant to reveal it. One tap
 * produces ONE block, which is also how a human reads it.
 */
function scheduleFlush(): void {
  // Bare setTimeout, NOT window.setTimeout: this module is imported by
  // KeyboardAccessoryBar, whose pure visibility rule is unit-tested in a Node
  // environment with no `window`. Reaching for the browser global here threw
  // from every traced path the moment a test touched one.
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    const fresh = entries.slice(sentUpTo)
    sentUpTo = entries.length
    if (fresh.length === 0 || !sink) return
    if (sentBlocks >= MAX_BLOCKS_PER_SESSION) {
      if (sentBlocks === MAX_BLOCKS_PER_SESSION) {
        sentBlocks++
        sink(`(trace muted: ${MAX_BLOCKS_PER_SESSION} blocks sent, reload to resume)`)
      }
      return
    }
    sentBlocks++
    sink(fresh.map(formatEntry).join('\n'))
  }, FLUSH_QUIET_MS)
}

/**
 * Record one lifecycle edge.
 *
 * Call from EVENTS (a handler, an effect that fires on a real transition),
 * never from a render body -- React renders twice in StrictMode and more under
 * concurrent scheduling, and a trace full of phantom duplicate lines is worse
 * than no trace.
 */
export function kbTrace(event: string, detail: Record<string, unknown> = {}): void {
  const parts = Object.entries(detail).map(([k, v]) => `${k}=${String(v)}`)
  const line = parts.join(' ')
  // Collapse an identical repeat into a count instead of a new row. iOS fires
  // visualViewport events continuously while a keyboard animates or the page
  // scrolls, and 200 identical resize lines would evict the handful of edges
  // that actually explain the bug -- the buffer would faithfully record only
  // the noise that overwrote the signal.
  const last = entries[entries.length - 1]
  if (last && last.event === event && last.detail === line) {
    last.repeat = (last.repeat ?? 1) + 1
    last.t = Date.now() - startedAt
    // A repeat is still activity: it must push the quiet window out, or a
    // steady stream of identical resizes would flush a half-finished burst and
    // then never send the rest. If that row was already sent, un-send it so the
    // final count ships rather than a stale "x2".
    sentUpTo = Math.min(sentUpTo, entries.length - 1)
    scheduleFlush()
    return
  }
  entries.push({ t: Date.now() - startedAt, event, detail: line })
  if (entries.length > TRACE_LIMIT) {
    entries.shift()
    // The buffer just slid, so every index into it slid too. Without this the
    // send cursor points one entry further along after each eviction and
    // silently starts skipping the newest lines -- a diagnostic that drops
    // exactly the events it was added to capture.
    sentUpTo = Math.max(0, sentUpTo - 1)
  }
  scheduleFlush()
}

/** One entry as a line. Shared so the copied report and the auto-sent block
 *  can never disagree about what happened. */
function formatEntry(e: TraceEntry): string {
  return `+${e.t}ms ${e.event}${e.detail ? ` ${e.detail}` : ''}${e.repeat ? ` (x${e.repeat})` : ''}`
}

/**
 * The trace as pasteable text, newest LAST so it reads top-to-bottom as time.
 *
 * Timestamps are relative ms since page load: absolute clock times are noise
 * here, and what every question about this surface actually needs is the GAP
 * between two events -- a resize 8ms after a pointerdown is the keyboard
 * animating, the same resize 400ms later is a real dismissal.
 */
export function formatKbTrace(): string {
  if (entries.length === 0) return '(no keyboard events recorded)'
  return entries.map(formatEntry).join('\n')
}

// Reachable from a Safari console attached to the phone, for the case where
// copying the report is more friction than just reading it live. Guarded: this
// module is imported by KeyboardAccessoryBar, whose pure visibility rule is
// unit-tested in a Node environment with no `window` at all.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __mmKbTrace: () => string }).__mmKbTrace = formatKbTrace
}
