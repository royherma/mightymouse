// ax-control.ts — drive another app's UI by accessibility label, and find out
// whether it worked.
//
// The alternative this replaces was a global hotkey the user configures in the
// other app and then types into MightyMouse a second time. That is two chances
// to be wrong for a worse outcome: a hotkey fires blind (nothing reports back
// whether anything happened), it ships Off in ChatGPT's case, and a combo that
// drifts in one app goes on silently pressing the wrong keys in the other.
// A labelled button is already there, needs no setup, and can be verified.
//
// Boundary note: this is macOS-only because AXUIElement is. Callers reach it
// through the `context` sub-contract in platform/, never by importing macos/*.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../../shared/env'
import { resolveHelper } from './helpers'
import type { AxPressRequest, AxPressResult } from '../contract'

const AX_BIN = 'mm-ax'

/** Ceiling for the whole spawn. The binary has its own internal deadline
 *  (--timeout-ms) and exits on its own; this only catches a wedged process, so
 *  it sits above the largest deadline we ever pass rather than near it. */
const AX_SPAWN_TIMEOUT_MS = 25_000

/**
 * Press a labelled control in another app. Never throws — every failure is a
 * status, because the caller is usually answering a voice request where an
 * exception would surface as silence.
 */
export function axPress(req: AxPressRequest): Promise<AxPressResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const bin = resolveHelper(AX_BIN)
    if (!existsSync(bin)) {
      devLog.warn('mm-ax binary missing at', bin)
      resolve({ status: 'failed', verified: false, ms: Date.now() - started })
      return
    }

    const args = ['press', req.bundleId, '--press', req.press.join(',')]
    if (req.verify?.length) args.push('--verify', req.verify.join(','))
    if (req.already?.length) args.push('--already', req.already.join(','))
    if (req.timeoutMs) args.push('--timeout-ms', String(req.timeoutMs))

    const proc = spawn(bin, args)
    let stdout = ''
    let settled = false
    const done = (result: AxPressResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      done({ status: 'failed', verified: false, ms: Date.now() - started })
    }, AX_SPAWN_TIMEOUT_MS)

    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      done({ status: 'failed', verified: false, ms: Date.now() - started })
    })
    proc.on('close', () => {
      clearTimeout(timer)
      const ms = Date.now() - started
      let raw: Record<string, unknown> | undefined
      try {
        raw = JSON.parse(stdout.trim()) as Record<string, unknown>
      } catch {
        // A binary that printed nothing parseable is a failure regardless of
        // its exit code — we have no evidence either way, and reporting
        // success without evidence is the thing this module exists to avoid.
        done({ status: 'failed', verified: false, ms })
        return
      }
      const status = String(raw.status ?? 'failed') as AxPressResult['status']
      done({
        status,
        verified: raw.verified === true || status === 'already',
        pressed: typeof raw.pressed === 'string' ? raw.pressed : undefined,
        confirmedBy: typeof raw.confirmedBy === 'string' ? raw.confirmedBy : undefined,
        ms,
        raw
      })
    })
  })
}
