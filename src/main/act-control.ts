import { createServer, type Server } from 'net'
import { unlinkSync, existsSync, writeFileSync } from 'fs'
import { actControlSocketPath, actControlPointerPath } from './act-control-path'
import { CONFIG } from '../shared/config'
import { devLog } from '../shared/env'
import { flashHighlightBox } from './highlight-window'
import { toScreenPoint } from './backend/act-highlight'
import { ACT_CONTROL_VERB, type ActControlVerb } from '../shared/act-control'

// act-control.ts — a one-way command channel from the spawned act agent back
// INTO the Electron main process.
//
// Why this exists: the act agent is a separate `claude` process whose only
// interface to the machine is shell commands. mm-input covers everything that
// is a real HID event (CGEvent posts need no app state). But some capabilities
// live in the APP — the highlight overlay is an Electron BrowserWindow that
// only main can move, show, and route across displays. The agent could not
// reach it, so "highlight this button" had no implementation and the model
// fell back to annotating a PNG with an image library.
//
// Shape: a unix domain socket, one newline-delimited JSON command per line,
// fire-and-forget (the agent never needs a reply beyond "ok"). Deliberately
// NOT a new Swift binary — a second native process would need its own
// NSWindow, multi-display logic, and click-through setup, i.e. a duplicate of
// highlight-window.ts that drifts. One socket keeps a single source of truth.
//
// Security: the socket is inside PATHS.TMP (user-owned, 0700 by the OS) and
// only accepts a fixed verb set with numeric args. It cannot run shell.

let server: Server | null = null

// NOTE: actControlSocketPath() deliberately lives in ./act-control-path, NOT
// here. runner.ts needs the path to put in the act spawn env, and importing it
// from this module pulled highlight-window → electron into runner's graph,
// breaking four headless test files that mock electron only at the top level.
// A path string has no business dragging a BrowserWindow behind it.
export { actControlSocketPath } from './act-control-path'

/** Coerce an unknown JSON value to a finite number, or null. */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Execute one parsed command. Unknown verbs and bad args are dropped silently —
 * a malformed line from the agent must never crash or stall the main process.
 */
function dispatch(cmd: Record<string, unknown>): void {
  const verb = cmd['verb']
  if (verb !== ACT_CONTROL_VERB.highlight) return

  const x = num(cmd['x'])
  const y = num(cmd['y'])
  if (x === null || y === null) return

  // The agent reads coordinates off the ATTACHED SCREENSHOT (2x pixels on a
  // Retina display), which is the space the whole act prompt speaks in — the
  // same space mm-input's click verbs use. flashHighlightBox wants logical
  // screen points, so convert with the identical math the passive sniffer uses.
  const pt = toScreenPoint(x, y)

  const size = num(cmd['size'])
  const duration = num(cmd['duration'])
  flashHighlightBox(
    pt.x,
    pt.y,
    size ?? CONFIG.ACT_HIGHLIGHT.BOX_SIZE_PX,
    duration ?? CONFIG.ACT_HIGHLIGHT.DURATION_MS
  )
}

/**
 * Start the control socket. Idempotent — a second call is a no-op. Any listen
 * failure is logged and swallowed: the act loop must still work (minus the
 * app-side verbs) if the socket can't bind.
 */
export function startActControlServer(): void {
  if (server) return

  const sockPath = actControlSocketPath()
  // A stale socket file from a crashed run blocks listen() with EADDRINUSE.
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath)
  } catch {}

  try {
    server = createServer((conn) => {
      let buf = ''
      conn.setEncoding('utf-8')
      conn.on('data', (chunk: string) => {
        buf += chunk
        // Newline-delimited JSON: process every complete line, keep the tail.
        let nl = buf.indexOf('\n')
        while (nl !== -1) {
          const line = buf.substring(0, nl).trim()
          buf = buf.substring(nl + 1)
          if (line !== '') {
            try {
              const parsed: unknown = JSON.parse(line)
              if (parsed && typeof parsed === 'object') {
                dispatch(parsed as Record<string, unknown>)
              }
            } catch {
              // Malformed line — ignore, keep reading.
            }
          }
          nl = buf.indexOf('\n')
        }
      })
      conn.on('error', () => {})
    })

    server.on('error', (err) => {
      devLog.warn('act-control server error', err)
    })

    server.listen(sockPath, () => {
      // Sidecar pointer so the shim resolves the socket without the path being
      // duplicated across prompt/shim/main.
      try {
        writeFileSync(actControlPointerPath(), sockPath, 'utf-8')
      } catch {}
      devLog.log('act-control listening at', sockPath)
    })
  } catch (err) {
    devLog.warn('act-control failed to start', err)
    server = null
  }
}

/** Stop the socket and clean up its file (app quit). */
export function stopActControlServer(): void {
  if (server) {
    try {
      server.close()
    } catch {}
    server = null
  }
  try {
    const p = actControlSocketPath()
    if (existsSync(p)) unlinkSync(p)
  } catch {}
}

export type { ActControlVerb }
