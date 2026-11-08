// osa.ts — the one osascript call every adapter shares.
//
// Split out of the adapters so a timeout or a failure mode gets fixed once. A
// browser blocked on a modal dialog, or a terminal mid-prompt, can hang an
// Apple-events round trip indefinitely, so every call is bounded.

import { spawn, spawnSync } from 'child_process'
import { devLog } from '../../../../shared/env'

/** osascript is a process spawn plus an Apple-events round trip. */
export const OSASCRIPT_TIMEOUT_MS = 3000

/**
 * Separator between AppleScript list items.
 *
 * `,` appears constantly in page titles and working directories and would split
 * one row into two; this sequence does not.
 */
export const FIELD_SEP = ''

export function runOsa(script: string): string | null {
  const r = spawnSync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: OSASCRIPT_TIMEOUT_MS
  })
  if (r.error || r.status !== 0) {
    devLog.warn('[app-context] osascript failed:', r.stderr?.trim() || r.error?.message)
    return null
  }
  return r.stdout.trim()
}

export function runOsaAsync(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-e', script])
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill()
      finish(null)
    }, OSASCRIPT_TIMEOUT_MS)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    proc.on('error', (err) => {
      devLog.warn('[app-context] osascript failed:', err.message)
      finish(null)
    })
    proc.on('close', (status) => {
      if (status !== 0) {
        devLog.warn('[app-context] osascript failed:', stderr.trim() || `status ${status}`)
        finish(null)
        return
      }
      finish(stdout.trim())
    })
  })
}
