import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../../shared/env'
import { resolveHelper } from '../../platform/macos/helpers'
import type { AxElement, AxFrame } from './ui-rank'

const AX_BIN = 'mm-ax'

// The binary's settle sleep before it walks. Its 1000ms default put the whole
// dump at 1.35s against the registry's 1500ms budget -- 150ms of margin, which
// vite-node overhead alone was enough to blow. At 250ms the tree came back
// complete (400 emitted, 287 pressable, target present) on a warm window. A
// cold window may return a short tree; that costs one missed offer, where
// paying 1s every time costs the whole capability on every command.
const DUMP_SETTLE_MS = 250

// Ceiling for the spawn, not a target: a dump measured 0.33-0.47s at this
// settle, so this only catches a wedged process. 2500 because Finder's tree is
// spiky -- 8 runs measured median 1.01s but a 3.62s tail, and killing at 1200
// threw away a whole step's sight to save 1.3s.
const DUMP_TIMEOUT_MS = 2_500

/** Never throws and never rejects — a capability that blows up during listing
 *  takes every other action down with it. An empty list is the honest answer
 *  for a dead bundleId, a missing binary, or a tree that was not ready. */
export function dumpElements(bundleId: string): Promise<AxElement[]> {
  return new Promise((resolve) => {
    if (bundleId === '') {
      resolve([])
      return
    }
    let bin = ''
    try {
      bin = resolveHelper(AX_BIN)
    } catch {
      // resolveHelper reaches for electron's app.getAppPath(); a caller outside
      // Electron would otherwise get a throw from a function documented never
      // to throw, which takes every other capability down with it.
      resolve([])
      return
    }
    if (!existsSync(bin)) {
      devLog.warn('mm-ax binary missing at', bin)
      resolve([])
      return
    }

    let proc
    try {
      proc = spawn(bin, ['dump', bundleId, '--settle-ms', String(DUMP_SETTLE_MS)])
    } catch {
      resolve([])
      return
    }
    let stdout = ''
    let settled = false
    const done = (rows: AxElement[]): void => {
      if (settled) return
      settled = true
      resolve(rows)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      done([])
    }, DUMP_TIMEOUT_MS)

    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      done([])
    })
    proc.on('close', () => {
      clearTimeout(timer)
      try {
        const raw = JSON.parse(stdout.trim()) as {
          status?: string
          elements?: unknown
          offscreen?: unknown
        }
        if (raw.status !== 'ok' || !Array.isArray(raw.elements)) {
          done([])
          return
        }
        const parse = (rows: unknown, offscreen: boolean): AxElement[] =>
          (Array.isArray(rows) ? rows : []).flatMap((row) => {
            const el = row as Partial<AxElement>
            const f = el.frame as Partial<AxFrame> | undefined
            const frame =
              f && [f.x, f.y, f.w, f.h].every((n) => typeof n === 'number') ? (f as AxFrame) : undefined
            if (typeof el.label !== 'string' || typeof el.role !== 'string') return []
            return [
              {
                role: el.role,
                label: el.label,
                actions: Array.isArray(el.actions) ? el.actions.map(String) : [],
                offscreen,
                frame
              }
            ]
          })
        done([...parse(raw.elements, false), ...parse(raw.offscreen, true)])
      } catch {
        done([])
      }
    })
  })
}
