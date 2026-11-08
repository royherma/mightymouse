import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { captureContext } from '../platform'
import { acquire, isAvailable, on, AnyEvent } from './uiohook-manager'
import { redact } from './redact'
import { isPrivateContext } from './private-window'
import { ContextData, ContextLogEvent, ContextLogMovePoint } from '../../shared/types'

// Ambient Context Log (Feature D). Opt-in, off by default. Continuously records
// the active app/window/URL context (same bundle the screenshot flow writes)
// plus typed text and mouse activity, into rolling daily JSONL at
// ~/MightyMouse/context-log/.
//
// Keystroke -> text is intentionally LOSSY: uiohook gives keycodes, so we map
// printable keys + shift only. No IME, no dead keys, no emoji. Good enough for
// "roughly what I typed" + pattern mining; swap to a native text observer if
// fidelity ever matters. Raw keycodes are NEVER persisted; only the buffered,
// redacted string is.
//
// Mouse movement is intentionally COMPRESSED: uiohook fires `mousemove` on
// every pixel, so we never persist a row per tick. Instead we buffer
// delta-encoded points (dt/dx/dy from the previous point) and only flush the
// trail once cumulative movement crosses MOVE_FLUSH_DIST_PX or the idle timer
// fires — one `move` row per gesture, not per tick. Clicks are cheap
// (one event per press) so those log immediately; scroll is throttled.

const FOCUS_POLL_MS = 2000
const IDLE_FLUSH_MS = 3000
const BUFFER_CAP = 256
// Cumulative on-screen distance (px) a move trail must cover before it's
// eligible to flush early (still gated by MOVE_SAMPLE_MIN_PX between points).
const MOVE_FLUSH_DIST_PX = 400
// Minimum distance (px) between two consecutive buffered points. Below this,
// the tick is dropped rather than buffered — this is the actual compression:
// a slow 2px-per-tick drag collapses to a handful of points instead of dozens.
const MOVE_SAMPLE_MIN_PX = 20
// A scroll gesture fires dozens of wheel ticks.
const WHEEL_ROW_GAP_MS = 1000

let running = false
let lastWheelRowAt = 0
let latestPointerFile: string | null = null
let release: (() => void) | null = null
const unsubs: Array<() => void> = []
let pollTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

let shiftDown = false
let buffer = ''
let ctx: ContextData = { frontApp: null, windowTitle: null, browserURL: null }
// True while the focused window is private/incognito. We still buffer keystrokes
// (we can't know mid-buffer where they'll land), but flushBuffer DROPS them.
let ctxIsPrivate = false

// Compressed move-trail state. startX/Y is the trail's first sampled point;
// movePoints holds delta-encoded points after it. lastSampleX/Y/T track the
// most recent SAMPLED point (for delta math), separate from the raw last
// mousemove tick, so ticks under MOVE_SAMPLE_MIN_PX apart are dropped, not buffered.
let moveStartX: number | null = null
let moveStartY: number | null = null
let lastSampleX = 0
let lastSampleY = 0
let lastSampleT = 0
let moveDistAccum = 0
let movePoints: ContextLogMovePoint[] = []
let moveIdleTimer: ReturnType<typeof setTimeout> | null = null

// uiohook-napi standard keycodes (subset: printable + control keys we care about).
const KC = {
  BACKSPACE: 14,
  ENTER: 28,
  TAB: 15,
  SPACE: 57,
  LSHIFT: 42,
  RSHIFT: 54
} as const

// keycode -> [unshifted, shifted] printable char.
const CHARS: Record<number, [string, string]> = {
  2: ['1', '!'], 3: ['2', '@'], 4: ['3', '#'], 5: ['4', '$'], 6: ['5', '%'],
  7: ['6', '^'], 8: ['7', '&'], 9: ['8', '*'], 10: ['9', '('], 11: ['0', ')'],
  12: ['-', '_'], 13: ['=', '+'],
  16: ['q', 'Q'], 17: ['w', 'W'], 18: ['e', 'E'], 19: ['r', 'R'], 20: ['t', 'T'],
  21: ['y', 'Y'], 22: ['u', 'U'], 23: ['i', 'I'], 24: ['o', 'O'], 25: ['p', 'P'],
  26: ['[', '{'], 27: [']', '}'],
  30: ['a', 'A'], 31: ['s', 'S'], 32: ['d', 'D'], 33: ['f', 'F'], 34: ['g', 'G'],
  35: ['h', 'H'], 36: ['j', 'J'], 37: ['k', 'K'], 38: ['l', 'L'],
  39: [';', ':'], 40: ["'", '"'], 41: ['`', '~'],
  43: ['\\', '|'],
  44: ['z', 'Z'], 45: ['x', 'X'], 46: ['c', 'C'], 47: ['v', 'V'], 48: ['b', 'B'],
  49: ['n', 'N'], 50: ['m', 'M'],
  51: [',', '<'], 52: ['.', '>'], 53: ['/', '?']
}

export function isContextLoggingAvailable(): boolean {
  return isAvailable()
}

function todayFile(): string {
  // Local date, filename-safe. Rollover happens naturally as the date changes.
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
  return join(PATHS.CONTEXT_LOG_DIR, `${stamp}.jsonl`)
}

function appendEvent(ev: ContextLogEvent): void {
  if (PREFS.getIncognito()) return
  try {
    const file = todayFile()
    appendFileSync(file, JSON.stringify(ev) + '\n', 'utf-8')
    if (latestPointerFile === file) return
    writeFileSync(PATHS.CONTEXT_LOG_LATEST, file, 'utf-8')
    latestPointerFile = file
  } catch (err) {
    console.error('context-log append failed:', err)
  }
}

function sameContext(a: ContextData, b: ContextData): boolean {
  return a.frontApp === b.frontApp && a.windowTitle === b.windowTitle && a.browserURL === b.browserURL
}

// Flush the pending typed buffer as one redacted `text` event, attributed to the
// context that was active while it was typed.
function flushBuffer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const text = buffer.trim()
  buffer = ''
  // Private/incognito window: discard, never write.
  if (ctxIsPrivate) return
  if (text.length < 2) return
  const clean = redact(text)
  appendEvent({
    ts: new Date().toISOString(),
    type: 'text',
    app: ctx.frontApp ?? null,
    title: ctx.windowTitle ?? null,
    url: ctx.browserURL ?? null,
    text: clean
  })
}

function armIdleFlush(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(flushBuffer, IDLE_FLUSH_MS)
}

async function pollFocus(): Promise<void> {
  let next: ContextData
  try {
    next = await captureContext()
  } catch {
    return
  }
  if (sameContext(next, ctx)) return
  // Context changed: flush whatever was typed/moved in the OLD context first
  // (flushBuffer/flushMoveTrail respect the OLD ctxIsPrivate). Then switch.
  flushBuffer()
  flushMoveTrail()
  ctx = next
  ctxIsPrivate = await isPrivateContext(next)
  // Private/incognito browser window: log NOTHING — no focus line, no URL.
  if (ctxIsPrivate) return
  appendEvent({
    ts: new Date().toISOString(),
    type: 'focus',
    app: ctx.frontApp ?? null,
    title: ctx.windowTitle ?? null,
    url: ctx.browserURL ?? null
  })
}

function onKeydown(e: AnyEvent): void {
  if (e.keycode === KC.LSHIFT || e.keycode === KC.RSHIFT) {
    shiftDown = true
    return
  }
  if (e.keycode === KC.BACKSPACE) {
    buffer = buffer.slice(0, -1)
    armIdleFlush()
    return
  }
  if (e.keycode === KC.SPACE) {
    buffer += ' '
    armIdleFlush()
    return
  }
  if (e.keycode === KC.ENTER || e.keycode === KC.TAB) {
    // Word/line boundary: flush so the buffer maps to one logical input.
    flushBuffer()
    return
  }
  const pair = CHARS[e.keycode]
  if (pair) {
    buffer += shiftDown ? pair[1] : pair[0]
    if (buffer.length >= BUFFER_CAP) {
      flushBuffer()
    } else {
      armIdleFlush()
    }
  }
  // Modifier-only / unmapped keys are ignored for text.
}

function onKeyup(e: AnyEvent): void {
  if (e.keycode === KC.LSHIFT || e.keycode === KC.RSHIFT) shiftDown = false
}

// Flush the buffered move trail as one `move` event (startX/Y + delta points),
// attributed to the current context. No-op if nothing was buffered.
function flushMoveTrail(): void {
  if (moveIdleTimer) {
    clearTimeout(moveIdleTimer)
    moveIdleTimer = null
  }
  if (moveStartX === null || moveStartY === null) return
  const startX = moveStartX
  const startY = moveStartY
  const points = movePoints
  moveStartX = null
  moveStartY = null
  moveDistAccum = 0
  movePoints = []
  if (ctxIsPrivate) return
  appendEvent({
    ts: new Date().toISOString(),
    type: 'move',
    app: ctx.frontApp ?? null,
    title: ctx.windowTitle ?? null,
    url: ctx.browserURL ?? null,
    startX,
    startY,
    points
  })
}

function armMoveIdleFlush(): void {
  if (moveIdleTimer) clearTimeout(moveIdleTimer)
  moveIdleTimer = setTimeout(flushMoveTrail, IDLE_FLUSH_MS)
}

// Buffers mousemove into a delta-encoded trail, dropping ticks under
// MOVE_SAMPLE_MIN_PX so a slow drag compresses instead of logging every pixel.
function onMouseMove(e: AnyEvent): void {
  const now = Date.now()
  if (moveStartX === null || moveStartY === null) {
    moveStartX = e.x
    moveStartY = e.y
    lastSampleX = e.x
    lastSampleY = e.y
    lastSampleT = now
    armMoveIdleFlush()
    return
  }
  const dx = e.x - lastSampleX
  const dy = e.y - lastSampleY
  const dist = Math.hypot(dx, dy)
  if (dist < MOVE_SAMPLE_MIN_PX) return
  movePoints.push({ dt: now - lastSampleT, dx, dy })
  lastSampleX = e.x
  lastSampleY = e.y
  lastSampleT = now
  moveDistAccum += dist
  armMoveIdleFlush()
  if (moveDistAccum >= MOVE_FLUSH_DIST_PX) flushMoveTrail()
}

function buttonName(button: number): ContextLogEvent['button'] {
  if (button === 1) return 'left'
  if (button === 2) return 'right'
  if (button === 3) return 'middle'
  return 'left'
}

function onMouseUp(e: AnyEvent): void {
  if (ctxIsPrivate) return
  appendEvent({
    ts: new Date().toISOString(),
    type: 'click',
    app: ctx.frontApp ?? null,
    title: ctx.windowTitle ?? null,
    url: ctx.browserURL ?? null,
    button: buttonName(e.button),
    x: e.x,
    y: e.y
  })
}

function onWheel(e: AnyEvent): void {
  if (ctxIsPrivate) return
  const now = Date.now()
  if (now - lastWheelRowAt < WHEEL_ROW_GAP_MS) return
  lastWheelRowAt = now
  appendEvent({
    ts: new Date().toISOString(),
    type: 'click',
    app: ctx.frontApp ?? null,
    title: ctx.windowTitle ?? null,
    url: ctx.browserURL ?? null,
    button: 'wheel',
    x: e.x,
    y: e.y
  })
}

/** Start ambient context logging. Idempotent; no-op if uiohook unavailable. */
export function startContextLogging(): boolean {
  if (!isAvailable() || running) return false
  if (!existsSync(PATHS.CONTEXT_LOG_DIR)) {
    mkdirSync(PATHS.CONTEXT_LOG_DIR, { recursive: true })
  }
  shiftDown = false
  buffer = ''
  ctx = { frontApp: null, windowTitle: null, browserURL: null }
  ctxIsPrivate = false
  moveStartX = null
  moveStartY = null
  moveDistAccum = 0
  movePoints = []
  lastWheelRowAt = 0
  latestPointerFile = null

  unsubs.push(on('keydown', onKeydown))
  unsubs.push(on('keyup', onKeyup))
  unsubs.push(on('mousemove', onMouseMove))
  unsubs.push(on('mouseup', onMouseUp))
  unsubs.push(on('wheel', onWheel))
  release = acquire()
  pollTimer = setInterval(() => void pollFocus(), FOCUS_POLL_MS)
  void pollFocus() // seed the first focus event immediately
  running = true
  return true
}

export function stopContextLogging(): void {
  if (!running) return
  flushBuffer()
  flushMoveTrail()
  unsubs.forEach((u) => u())
  unsubs.length = 0
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (moveIdleTimer) {
    clearTimeout(moveIdleTimer)
    moveIdleTimer = null
  }
  if (release) release()
  release = null
  running = false
}

export function isContextLoggingRunning(): boolean {
  return running
}
