// frontmost-watch.ts — subscribe to "the frontmost app changed", via the native
// FrontmostWatch binary.
//
// Consumer: src/main/ipc/phone-remote.ts, to keep the phone's app-aware keyboard
// bar naming the app that is actually in front.
//
// Why an event stream and not a poll: readAppContext() costs ~200ms of BLOCKING
// spawnSync (measured), on the same thread as the phone's trackpad/keystroke
// stream. Polling it at any useful cadence is visible as a stutter. NSWorkspace
// publishes the change for free, so this subscribes instead.
//
// Unlike the other native helpers this one is a LONG-LIVED child process rather
// than a one-shot spawn, so it owns a start/stop lifecycle and a single shared
// subscriber list -- never one process per listener.

import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { existsSync } from 'fs'
import { devLog } from '../../../shared/env'
import { isOwnBundleId } from '../../../shared/app-context'
import { resolveHelper } from './helpers'

const FRONTMOST_WATCH_BIN = 'frontmost-watch'

/** Cooldown before a died-on-its-own watcher is respawned. Guards against a
 *  crash-loop burning CPU; a missing binary is caught before this ever runs. */
const RESPAWN_DELAY_MS = 5000

/** spawnEcho: this is the binary's print-current-value-on-start line, not a real
 *  activation. It fans out (a respawn may have missed real switches, so
 *  consumers still want the fresh value) but must never be treated as motion:
 *  every phone connect respawns the watcher, and the echo heralding a downscale
 *  cost a 2-keyframe encoder stall per connect. */
type Listener = (bundleId: string, spawnEcho: boolean) => void
type SetListener = () => void

/** stdin is `ignore`d — this helper only ever talks outward. */
type Watcher = ChildProcessByStdio<null, Readable, Readable>

let child: Watcher | null = null
let respawnTimer: NodeJS.Timeout | null = null
let stopped = true
let pinned = false
let firstFrontAfterSpawn = false
const listeners = new Set<Listener>()
const setListeners = new Set<SetListener>()
/** Last bundle id seen, so a duplicate line never fans out as a change. */
let lastBundleId = ''
/** Last bundle id that was NOT one of ours. Our own windows (the HUD, the route
 *  card, the panel) activating must not overwrite the app the user was actually
 *  in: voice routing reads this AFTER the card is already up, so caching our own
 *  id made every note report Electron instead of Chrome. */
let lastForeignBundleId = ''

function resolveBinaryPath(): string {
  return resolveHelper(FRONTMOST_WATCH_BIN)
}

function fanOut(bundleId: string): void {
  const echo = firstFrontAfterSpawn
  firstFrontAfterSpawn = false
  // The binary prints its CURRENT value on start, which is normally the app the
  // last listener already knows about -- so dedupe here rather than making every
  // subscriber tolerate a redundant first event.
  if (!bundleId || bundleId === lastBundleId) return
  lastBundleId = bundleId
  if (!isOwnBundleId(bundleId)) lastForeignBundleId = bundleId
  devLog.log(`[frontmost-watch] front=${bundleId}${echo ? ' (spawn echo)' : ''}`)
  for (const fn of listeners) {
    // One listener throwing must not starve the others, and must not kill the
    // watcher: this runs on a stdout event, where an throw is an unhandled
    // rejection rather than something a caller can catch.
    try {
      fn(bundleId, echo)
    } catch (err) {
      devLog.error('[frontmost-watch] listener threw:', err)
    }
  }
}

function fanOutSetChanged(): void {
  for (const fn of setListeners) {
    try {
      fn()
    } catch (err) {
      devLog.error('[frontmost-watch] set listener threw:', err)
    }
  }
}

/** Route one stdout line to the right fan-out. An untagged line is a binary
 *  older than the `front `/`set` protocol, so treat it as the bundle id it used
 *  to be rather than dropping every activation on a stale build. */
function handleLine(line: string): void {
  if (line === 'set') {
    fanOutSetChanged()
    return
  }
  if (line.startsWith('front ')) {
    fanOut(line.slice('front '.length).trim())
    return
  }
  fanOut(line)
}

function spawnWatcher(): void {
  const bin = resolveBinaryPath()
  if (!existsSync(bin)) {
    devLog.warn(
      `[frontmost-watch] binary not found at ${bin}. ` +
        `Run: cd native/frontmost-watch && bash build.sh`
    )
    return
  }

  const proc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  firstFrontAfterSpawn = true

  // One bundle id per line, but a pipe can split a write anywhere -- carry the
  // partial tail rather than emitting a truncated bundle id.
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
    devLog.warn('[frontmost-watch] stderr:', chunk.trim())
  })

  proc.on('error', (err) => devLog.error('[frontmost-watch] spawn error:', err.message))

  proc.on('exit', (code) => {
    if (child === proc) child = null
    if (stopped) return
    devLog.warn(`[frontmost-watch] exited (${code}), respawning in ${RESPAWN_DELAY_MS}ms`)
    // Re-read on respawn: the frontmost app has almost certainly moved while we
    // were blind, and a stale lastBundleId would swallow the first real event.
    lastBundleId = ''
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      if (!stopped) spawnWatcher()
    }, RESPAWN_DELAY_MS)
  })
}

export function currentFrontmostBundleId(): string {
  return lastBundleId
}

/** The frontmost app ignoring our own windows — what "where the user was" means
 *  for anything deciding on the user's behalf (voice routing, actions). */
export function currentForeignFrontmostBundleId(): string {
  return lastForeignBundleId
}

/** Keep NSWorkspace running so `currentFrontmostBundleId` is a memory read — Phone Remote used to kill it, forcing an 800ms+ System Events spawnSync on Voice Route click. */
export function pinFrontmostWatch(): void {
  pinned = true
  ensureWatching()
}

/** Subscribe to frontmost-app changes. Returns an unsubscribe function. */
export function onFrontmostAppChange(fn: Listener): () => void {
  listeners.add(fn)
  ensureWatching()
  return () => {
    listeners.delete(fn)
    stopIfIdle()
  }
}

/**
 * Subscribe to "an app launched or quit" — i.e. the running-app SET changed,
 * not just which one is in front. Returns an unsubscribe function.
 *
 * Carries no bundle id: the answer to this event is to re-read the whole list
 * (see the Swift source). Already coalesced binary-side, so a multi-process app
 * launching fires this once.
 */
export function onRunningAppsChange(fn: SetListener): () => void {
  setListeners.add(fn)
  ensureWatching()
  return () => {
    setListeners.delete(fn)
    stopIfIdle()
  }
}

/** Both subscriptions share ONE watcher. A pin is keep-alive so Phone disconnect does not kill the cache Voice Route needs. */
function ensureWatching(): void {
  if (child || respawnTimer) return
  if (!pinned && listeners.size + setListeners.size === 0) return
  stopped = false
  spawnWatcher()
}

function stopIfIdle(): void {
  if (pinned) return
  if (listeners.size + setListeners.size === 0) stopFrontmostWatch()
}

/** Tear the watcher down. Safe to call when it was never started. */
export function stopFrontmostWatch(): void {
  pinned = false
  stopped = true
  if (respawnTimer) {
    clearTimeout(respawnTimer)
    respawnTimer = null
  }
  child?.kill()
  child = null
  lastBundleId = ''
  lastForeignBundleId = ''
}
