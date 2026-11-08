// input.ts — the single TS gateway to MightyMouse's "human hands". Spawns the
// native mm-input binary (native/mm-input/MmInput.swift) to synthesize any real
// mouse/keyboard action. Supersedes click.ts + type-text.ts, which now re-export
// clickAt/typeText from here so their callers in backend/hud-run.ts are untouched.
//
// Consumer: the "act on screen" family in backend/hud-run.ts, gated behind
// PREFS.getClickEnabled() + the Accessibility permission. The act-mode `claude`
// agent ALSO calls the binary directly via Bash (see SYSTEM_PROMPT_ACT) — this
// wrapper is the in-process path for the one-shot ask [POINT]/[TYPE] tags.
//
// Coordinate space: LOGICAL SCREEN POINTS, origin top-left (find-on-screen +
// cursor-overlay space). The binary posts matching global-display CGEvents, so
// no conversion happens here.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { CONFIG } from '../../../shared/config'
import { devLog } from '../../../shared/env'
import { resolveHelper } from './helpers'
import { type InputAction, serializeAction } from '../../../shared/input-actions'

const INPUT_BIN = 'mm-input'

// mm-ui is mm-input's app-side sibling: a shell shim the act agent calls to
// reach capabilities that live in the Electron process (the highlight overlay)
// rather than in CGEvent. Same repo-vs-Resources resolution, so it ships and
// resolves identically. See native/mm-ui/mm-ui + src/main/act-control.ts.
const UI_BIN = 'mm-ui'

// mm-shot captures the screen WITHOUT our own overlays in it (ScreenCaptureKit
// window exclusion). Same resolution as the two above so it ships identically.
// See native/mm-shot/MmShot.swift and shotBinPath() below.
const SHOT_BIN = 'mm-shot'

// One synthesized action is near-instant; this only guards a wedged child. Wide
// enough to cover a long `type` (per-char posting) or a multi-step drag/scroll.
const INPUT_TIMEOUT_MS = 8_000

/** Repo path in dev; app Resources when packaged (mirrors ocr.ts / notch-info.ts). */
function resolveInputBin(): string {
  return resolveHelper(INPUT_BIN)
}

/** Absolute path to the binary — exported so callers that hand the path to the
 *  act agent (so it can call mm-input via Bash) have one source of truth. */
export function inputBinPath(): string {
  return resolveInputBin()
}

/**
 * The screenshot command the act agent should run, already argv-complete.
 *
 * mm-shot when it is built, with our own pid excluded so the agent never reads
 * MightyMouse's overlays as if they were the user's screen. Falls back to
 * `screencapture -x` when the binary is missing (a dev checkout that hasn't run
 * native/build-all.sh) — identical to the behavior before mm-shot existed,
 * overlays included, rather than a broken command.
 */
export function shotCommand(): string {
  const bin = resolveHelper(SHOT_BIN)
  if (!existsSync(bin)) return `${CONFIG.SCREENCAPTURE_PATH} -x`
  return `${bin} --exclude-pid ${process.pid}`
}

export function captureScreenWithoutUs(outPath: string, maxWidth: number): Promise<boolean> {
  const bin = resolveHelper(SHOT_BIN)
  if (!existsSync(bin)) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(
      bin,
      [outPath, '--exclude-pid', String(process.pid), '--max-width', String(maxWidth)],
      { timeout: INPUT_TIMEOUT_MS },
      (err) => resolve(!err)
    )
  })
}

/** Absolute path to the mm-ui shim — same dev/packaged resolution as mm-input.
 *  Exported for the act prompt, which hands the path to the agent. */
export function uiBinPath(): string {
  return resolveHelper(UI_BIN)
}

// Notified BEFORE this module posts a synthetic event, so Away Mode's watch can
// tell our CGEvents from a human's. A callback, not an import of the watch: this
// is `macos/`, which must not know Away Mode exists. `make why Q="dictation relock"`.
let onSynthesized: (() => void) | null = null

export function setSyntheticInputListener(cb: (() => void) | null): void {
  onSynthesized = cb
}

function noteSynthetic(): void {
  if (onSynthesized) onSynthesized()
}

/**
 * Perform one typed input action by spawning mm-input. Resolves true on a clean
 * exit, false on any failure (missing binary, timeout, non-zero exit). Never
 * throws — a failed synthetic event must not crash a run.
 *
 * The CALLER gates on PREFS.getClickEnabled() + Accessibility; this just acts.
 */
export function runInput(action: InputAction): Promise<boolean> {
  // Before the spawn, not after: a `type` walks 87 words per-char over seconds,
  // so stamping on completion leaves the whole burst unattributed.
  noteSynthetic()
  return new Promise((resolve) => {
    const bin = resolveInputBin()
    if (!existsSync(bin)) {
      devLog.warn('mm-input binary missing at', bin)
      resolve(false)
      return
    }
    const proc = spawn(bin, serializeAction(action))
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      done(false)
    }, INPUT_TIMEOUT_MS)
    proc.on('error', () => {
      clearTimeout(timer)
      done(false)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0)
    })
  })
}

/** What physical keyboard is attached. ISO has one more key than ANSI (§ left
 *  of Z), which is why this is worth asking rather than assuming. */
export type HostKeyboardLayoutType = 'ansi' | 'iso' | 'jis'

// Read once per app run: the answer only changes if you unplug one keyboard and
// attach a different kind, and the phone re-reads it on every layoutPrefs push.
let cachedKbdType: HostKeyboardLayoutType | null = null

/**
 * Ask mm-input which board is attached (Carbon's KBGetLayoutType — no Node API
 * exposes it). Falls back to 'ansi' on any failure: it's the majority board, and
 * drawing it at an ISO user costs one missing key rather than a broken keyboard.
 */
export function detectHostKeyboardType(): Promise<HostKeyboardLayoutType> {
  if (cachedKbdType) return Promise.resolve(cachedKbdType)
  return new Promise((resolve) => {
    const bin = resolveInputBin()
    if (!existsSync(bin)) {
      resolve('ansi')
      return
    }
    const proc = spawn(bin, ['kbdtype'])
    let out = ''
    let settled = false
    const done = (value: HostKeyboardLayoutType): void => {
      if (settled) return
      settled = true
      cachedKbdType = value
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      done('ansi')
    }, INPUT_TIMEOUT_MS)
    proc.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      done('ansi')
    })
    proc.on('close', () => {
      clearTimeout(timer)
      const word = out.trim().split(/\s+/).pop()
      done(word === 'iso' || word === 'jis' ? word : 'ansi')
    })
  })
}

// ── Move loop: one long-lived mm-input process for a per-frame hot path ──────
//
// Phone Remote's trackpad is the only true per-frame caller in the app (~30
// moves/sec while dragging). A spawn per move costs ~70ms on this machine --
// more than the whole 33ms throttle window -- so moves queue up behind their
// own process teardown and the drag reads as jittery, not smooth. Posting
// "x y" lines to one persistent `mm-input moveloop` process's stdin instead
// avoids that spawn cost entirely. Scoped to moves only: clicks/taps/drag/
// type/scroll stay one-shot spawns via runInput() above, since they're rare
// (not per-frame) and don't need this.
let moveLoopProc: ChildProcessWithoutNullStreams | null = null

function ensureMoveLoop(): ChildProcessWithoutNullStreams | null {
  if (moveLoopProc && !moveLoopProc.killed) return moveLoopProc
  const bin = resolveInputBin()
  if (!existsSync(bin)) {
    devLog.warn('mm-input binary missing at', bin)
    return null
  }
  const proc = spawn(bin, ['moveloop'])
  // Stamping on the child's post-ack, not just the stdin write, is what survives
  // a backlogged stdin: a wheel has no stream of later events to re-stamp it.
  proc.stdout.on('data', (chunk) => {
    if (String(chunk).includes('ok sc')) noteSynthetic()
  })
  proc.on('error', (err) => {
    devLog.error('mm-input moveloop failed to start', err)
  })
  proc.stdin.on('error', (err) => devLog.warn('mm-input moveloop stdin closed:', err.message))
  proc.on('exit', () => {
    if (moveLoopProc === proc) moveLoopProc = null
  })
  moveLoopProc = proc
  return proc
}

// The one write path to the moveloop, so the synthetic stamp cannot be missed by
// a sixth streamer. Silent no-op if the process can't start -- same "never
// throws" contract as runInput().
function postMoveLoop(line: string): void {
  const proc = ensureMoveLoop()
  if (!proc || !proc.stdin.writable) return
  noteSynthetic()
  proc.stdin.write(`${line}\n`)
}

/** Post one cursor move via the persistent moveloop process instead of a
 *  one-shot spawn. */
export function moveCursorFast(x: number, y: number): void {
  postMoveLoop(`m ${Math.round(x)} ${Math.round(y)}`)
}

/** Press-and-hold the left button at (x,y) via the moveloop process -- the
 *  start of a live-streamed drag (phone-remote long-press+drag). Distinct
 *  from runInput({verb:'drag'}) below, which is a single self-contained
 *  down->move->up call meant for a one-shot spawn, not a per-frame stream. */
export function dragDownFast(x: number, y: number): void {
  postMoveLoop(`dd ${Math.round(x)} ${Math.round(y)}`)
}

/** Drag the held button to (x,y) via the moveloop process. Call repeatedly
 *  (same throttle cadence as moveCursorFast) while the drag gesture continues. */
export function dragMoveFast(x: number, y: number): void {
  postMoveLoop(`dm ${Math.round(x)} ${Math.round(y)}`)
}

/** Release the button held by dragDownFast() at (x,y) via the moveloop process. */
export function dragUpFast(x: number, y: number): void {
  postMoveLoop(`du ${Math.round(x)} ${Math.round(y)}`)
}

/** Post one scroll-wheel nudge via the moveloop process -- the caller's own
 *  send rate (already throttled) sets the cadence, unlike runInput's 'scroll'
 *  verb below which self-paces a whole multi-nudge scroll in one blocking spawn. */
export function scrollFast(dy: number, dx: number): void {
  postMoveLoop(`sc ${Math.round(dy)} ${Math.round(dx)}`)
}

/** Stop the persistent moveloop process (Phone Remote toggle off / server
 *  stop). Safe to call when not running. */
export function stopMoveLoop(): void {
  if (!moveLoopProc) return
  if (moveLoopProc.stdin.writable) moveLoopProc.stdin.end('quit\n')
  moveLoopProc.kill()
  moveLoopProc = null
}

// ── Back-compat shims so existing hud-run.ts callers stay unchanged ───────────

/** Move the cursor to (x,y) in logical screen points and post one left click. */
export function clickAt(x: number, y: number): Promise<boolean> {
  return runInput({ verb: 'click', x, y })
}

/** Move the cursor to (x,y) and post one RIGHT click. Used by the right-eye wink. */
export function rightClickAt(x: number, y: number): Promise<boolean> {
  return runInput({ verb: 'rightclick', x, y })
}

/** Move the cursor to (x,y) and post one double click (correct clickState, not
 *  two independent single clicks -- apps that gate on it, e.g. text/icon
 *  selection, only recognize a real double click). */
export function doubleClickAt(x: number, y: number): Promise<boolean> {
  return runInput({ verb: 'doubleclick', x, y })
}

/** What the type path accepts: literal text, or a named key/combo (e.g. 'cmd+a'). */
export type TypeMode = 'text' | 'key'

/**
 * Type `value` as literal text (mode 'text') or press it as a key combo
 * (mode 'key', e.g. 'return', 'cmd+a'). Maps onto the typed action union.
 */
export function typeText(value: string, mode: TypeMode = 'text'): Promise<boolean> {
  return mode === 'key'
    ? runInput({ verb: 'key', combo: value })
    : runInput({ verb: 'type', text: value })
}

/**
 * Press several combos in order inside ONE spawn — for sequences where the gap
 * between keystrokes is the bug, not just a cost. Awaiting two typeText() calls
 * pays ~49ms of process startup per key and lets the pair interleave or half-
 * arrive; mm-input walks the list with nothing in between.
 */
export function pressKeys(combos: readonly string[]): Promise<boolean> {
  return runInput({ verb: 'key', combo: combos })
}

/** Zoom the frontmost app by `steps` notches, + = in, as ⌘= / ⌘- presses. */
export function zoomMac(steps: number): Promise<boolean> {
  return pressKeys(Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? 'cmd+=' : 'cmd+-')))
}

/** The two-finger double-tap equivalent — Cmd+0 (actual size). */
export function smartZoomMac(): Promise<boolean> {
  return runInput({ verb: 'smartzoom' })
}

export function openAppOverview(): void {
  execFile('open', ['-a', 'Mission Control'], () => {})
}
