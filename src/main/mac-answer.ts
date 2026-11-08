/**
 * One-shot model primitives for callers that want an ANSWER, not a stream.
 *
 * `runBackend` is streaming-shaped (Promise<void> + onPhase/onDone callbacks) because
 * the HUD needs live phases. Every one-shot caller re-implements the same collector
 * around it. These two wrap that once:
 *
 *   askMac()            — prompt in, string out
 *   askMacAboutScreen() — screenshot the Mac, hand it to the model, string out
 *
 * Built for the App Intents work (a Siri request has no HUD and no socket), but the
 * shape is general: any caller wanting one string back should use these instead of
 * writing another onDone collector.
 */

import { randomUUID } from 'node:crypto'
import { runBackend } from './backend/runner'
import { captureScreenshot } from './platform'
import { CONFIG } from '../shared/config'
import { PATHS } from './store/paths'
import { PREFS } from './store/prefs'
import type { BackendId } from './backend/adapters'
import type { AppMode, MediaAttachment } from '../shared/types'

export interface AskMacOptions {
  /** Defaults to the user's chosen backend — S6: no forced model, BYO stays free. */
  backend?: BackendId
  systemPrompt?: string
  /** Billing/feature label on the usage row. Defaults to 'ask'. */
  mode?: AppMode
  timeoutMs?: number
  /** Force structured JSON output on the http path. */
  json?: boolean
  /** Prefer the adapter's lighter/faster model where it has one. */
  fast?: boolean
  attachments?: MediaAttachment[]
  addDirs?: string[]
  /** Fires once the screenshot exists, before the model is called. The only
   *  seam where a caller can tell a slow capture from a slow model — which is
   *  the split that decides whether this path fits inside Siri's timeout. */
  onCaptured?: () => void
}

export class MacAnswerError extends Error {
  constructor(
    message: string,
    /** 'no-screen' is an expected degrade a caller can speak aloud; 'backend' and
     *  'empty' are real failures. Callers branch on this, never on the text. */
    readonly kind: 'backend' | 'no-screen' | 'empty'
  ) {
    super(message)
    this.name = 'MacAnswerError'
  }
}

/**
 * Run one prompt through the user's backend and resolve with the model's text.
 *
 * Never hangs: runBackend's own timeout fires onDone with a non-zero exit code, and
 * a non-zero exit rejects here. A caller on a Siri-style deadline should still pass
 * its own `timeoutMs` — the default is the app's generous interactive ceiling.
 */
export async function askMac(userPrompt: string, opts: AskMacOptions = {}): Promise<string> {
  const backend = opts.backend ?? PREFS.getBackend()
  const mode = opts.mode ?? 'ask'

  return new Promise<string>((resolve, reject) => {
    let settled = false
    void runBackend({
      backend,
      runId: randomUUID(),
      systemPrompt: opts.systemPrompt ?? '',
      userPrompt,
      runDir: PATHS.TMP,
      addDirs: opts.addDirs,
      attachments: opts.attachments,
      mode,
      json: opts.json,
      fast: opts.fast,
      lean: true,
      timeoutMs: opts.timeoutMs ?? CONFIG.RUN_TIMEOUT_MS[mode],
      onPhase: () => {},
      onDone: (result, exitCode, _stdOut, stdErr) => {
        if (settled) return
        settled = true
        if (exitCode !== 0) {
          reject(new MacAnswerError(stdErr.trim() || `backend exit ${exitCode}`, 'backend'))
          return
        }
        const text = (result ?? '').trim()
        if (text === '') {
          reject(new MacAnswerError('model returned nothing', 'empty'))
          return
        }
        resolve(text)
      }
    })
  })
}

/**
 * Screenshot the Mac and ask the model about what's on it.
 *
 * Throws `MacAnswerError('no-screen')` when the screenshot comes back null — the
 * sleeping-display case (SCK -3815) lands here, and it is an EXPECTED degrade the
 * caller should speak, not an error to log. The whole point is the screen, so there
 * is no useful answer without one.
 */
export async function askMacAboutScreen(
  question: string,
  opts: AskMacOptions = {}
): Promise<{ answer: string; screenshotPath: string }> {
  const shot = await captureScreenshot().catch(() => null)
  if (!shot) {
    throw new MacAnswerError('screenshot capture returned null', 'no-screen')
  }
  opts.onCaptured?.()

  // Naming the path is load-bearing, not belt-and-braces. Measured 2026-09-15:
  // with only the --add-dir grant, claude answered "no screenshot was passed to
  // me this turn" in 8.6s -- it is never told the file exists. The http/codex
  // paths carry the image on the wire and ignore this sentence; the claude CLI
  // reads it off the grant, and needs to be told where.
  const answer = await askMac(`Read the image at ${shot}.\n\n${question}`, {
    ...opts,
    attachments: [{ path: shot, kind: 'image' }, ...(opts.attachments ?? [])],
    // Grant the screenshot's dir so a CLI backend can Read the image off disk.
    addDirs: [shot.substring(0, shot.lastIndexOf('/')), ...(opts.addDirs ?? [])]
  })

  return { answer, screenshotPath: shot }
}
