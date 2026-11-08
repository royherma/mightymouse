// fn-watch.ts — subscribe to "the fn (globe) key went down / came up", via the
// native FnWatch binary.
//
// Consumer: src/main/capture/capture-hotkey.ts, which feeds these edges into the
// SAME listen gesture machine ⌘⌥⇧L drives, so fn gets tap, double-tap and
// long-press for free rather than a second copy of that logic.
//
// Why a native helper and not uiohook: uiohook cannot see this key at all. Its
// UiohookKey table has no Fn entry, and the AnyEvent shape it hands us carries only
// alt/ctrl/shift/meta. macOS reports fn as a flag bit on a flagsChanged event
// (keycode 63) -- a different channel than the keydown/keyup stream uiohook taps.
//
// Like frontmost-watch this is a LONG-LIVED child process rather than a one-shot
// spawn, so it owns a start/stop lifecycle and a single shared subscriber list --
// never one process per listener.

import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { existsSync } from 'fs'
import { devLog } from '../../../shared/env'
import { resolveHelper } from './helpers'

const FN_WATCH_BIN = 'fn-watch'

/** Cooldown before a died-on-its-own watcher is respawned. Guards against a
 *  crash-loop burning CPU; a missing binary is caught before this ever runs. */
const RESPAWN_DELAY_MS = 5000

/** `down` is the edge: true = fn pressed, false = fn released. */
type Listener = (down: boolean) => void

/** stdin is `ignore`d — this helper only ever talks outward. */
type Watcher = ChildProcessByStdio<null, Readable, Readable>

let child: Watcher | null = null
let respawnTimer: NodeJS.Timeout | null = null
let stopped = true
const listeners = new Set<Listener>()
/** Last edge seen, so a repeated `fn down` can never open a second gesture. The
 *  binary emits one line per real transition, but a respawn mid-hold would
 *  otherwise deliver a down with no matching up ever having been seen. */
let lastDown = false

function resolveBinaryPath(): string {
  return resolveHelper(FN_WATCH_BIN)
}

function fanOut(down: boolean): void {
  // A duplicate edge in the same direction is not a transition. Dropping it here
  // keeps every subscriber from having to hold its own is-it-already-down flag.
  if (down === lastDown) return
  lastDown = down
  for (const fn of listeners) {
    // One listener throwing must not starve the others, and must not kill the
    // watcher: this runs on a stdout event, where a throw is an unhandled
    // rejection rather than something a caller can catch.
    try {
      fn(down)
    } catch (err) {
      devLog.error('[fn-watch] listener threw:', err)
    }
  }
}

function handleLine(line: string): void {
  if (line === 'fn down') {
    fanOut(true)
    return
  }
  if (line === 'fn up') fanOut(false)
}

function spawnWatcher(): void {
  const bin = resolveBinaryPath()
  if (!existsSync(bin)) {
    devLog.warn(
      `[fn-watch] binary not found at ${bin}. Run: cd native/fn-watch && bash build.sh`
    )
    return
  }

  const proc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  // A respawn can land mid-hold, so the key's real state is unknown. Assume up:
  // the next genuine press then reads as a transition, where assuming down would
  // swallow it.
  lastDown = false

  // One edge per line, but a pipe can split a write anywhere -- carry the partial
  // tail rather than acting on a truncated line.
  let buffer = ''
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) handleLine(trimmed)
    }
  })

  proc.stderr.setEncoding('utf-8')
  proc.stderr.on('data', (chunk: string) => {
    devLog.warn('[fn-watch] stderr:', chunk.trim())
  })

  proc.on('error', (err) => devLog.error('[fn-watch] spawn error:', err.message))

  proc.on('exit', (code) => {
    if (child === proc) child = null
    if (stopped) return
    // exit(2) is the binary's "Accessibility denied" code. Respawning on a loop
    // cannot fix a missing TCC grant, so say what to do and stay down -- the
    // toggle re-arms it once the user grants and comes back.
    if (code === 2) {
      devLog.warn(
        '[fn-watch] Accessibility denied — fn will not trigger listen. ' +
          'System Settings → Privacy & Security → Accessibility.'
      )
      return
    }
    devLog.warn(`[fn-watch] exited (${code}), respawning in ${RESPAWN_DELAY_MS}ms`)
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      if (!stopped) spawnWatcher()
    }, RESPAWN_DELAY_MS)
  })
}

/**
 * Subscribe to fn key edges. Returns an unsubscribe function.
 *
 * The watcher process starts with the first listener and stops with the last, so
 * nothing is running while the fn-listen setting is off.
 */
export function onFnEdge(fn: Listener): () => void {
  listeners.add(fn)
  if (listeners.size === 1) {
    stopped = false
    spawnWatcher()
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) stopFnWatch()
  }
}

/** Tear the watcher down. Safe to call when it was never started. */
export function stopFnWatch(): void {
  stopped = true
  if (respawnTimer) {
    clearTimeout(respawnTimer)
    respawnTimer = null
  }
  child?.kill()
  child = null
  lastDown = false
}
