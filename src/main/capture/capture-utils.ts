import type { ChildProcess } from 'child_process'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { captureContext } from '../platform'
import { PREFS } from '../store/prefs'
import { ContextData, CaptureKind } from '../../shared/types'

/**
 * Write a context file next to a capture's artifacts, recording the frontmost
 * app / window / URL at capture time. Best-effort: a failure here must never
 * abort the capture itself, so it logs and returns rather than throwing.
 *
 * SINGLE SOURCE OF TRUTH — screenshot, recorder, and listen-recorder all call
 * this so the context-file format can't drift between capture kinds.
 *
 * @param folder    capture folder to write into
 * @param label     written in the file header (e.g. 'screenshot', 'recording-start')
 * @param fileName  output filename; defaults to `context-<label>.txt`. Screenshot
 *                  passes 'context.txt' to keep its single-shot filename.
 */
export async function writeContextFile(
  folder: string,
  label: string,
  fileName = `context-${label}.txt`
): Promise<void> {
  // Incognito drops the capture side-log (front app / window / URL). The capture's
  // primary artifact (PNG / MP4 / transcript) the user explicitly asked for is kept.
  if (PREFS.getIncognito()) return
  try {
    const ctx = await captureContext()
    const lines = [
      `# ${label}`,
      `ts: ${new Date().toISOString()}`,
      `front_app: ${ctx.frontApp || ''}`,
      `window_title: ${ctx.windowTitle || ''}`,
      `browser_url: ${ctx.browserURL || ''}`
    ]
    writeFileSync(join(folder, fileName), lines.join('\n') + '\n', 'utf-8')
  } catch (err) {
    console.error('writeContextFile failed:', err)
  }
}

/** The context-*.txt names a kind writes, preferring the start file for rec/listen. */
function contextFileNames(kind: CaptureKind): string[] {
  if (kind === 'screenshot') return ['context.txt']
  if (kind === 'recording') return ['context-recording-start.txt', 'context-recording-end.txt']
  return ['context-listen-start.txt']
}

/**
 * Read back the structured context a capture wrote to its sidecar (`writeContextFile`
 * above is the writer). Reverse of that format — `front_app:`/`window_title:`/
 * `browser_url:` lines. Returns {} when there's no readable sidecar, so a capture
 * with no context still logs fine. Used to mirror the sidecar into run.json without
 * re-running captureContext() (which would drift from what the capture recorded).
 */
export function readCaptureContext(folder: string, kind: CaptureKind): ContextData {
  const out: ContextData = {}
  const fileName = contextFileNames(kind).find((f) => existsSync(join(folder, f)))
  if (!fileName) return out
  try {
    for (const line of readFileSync(join(folder, fileName), 'utf-8').split('\n')) {
      const [key, ...rest] = line.split(':')
      const val = rest.join(':').trim()
      if (!val) continue
      if (key === 'front_app') out.frontApp = val
      else if (key === 'window_title') out.windowTitle = val
      else if (key === 'browser_url') out.browserURL = val
    }
  } catch {
    // unreadable sidecar — run.json just omits the context block
  }
  return out
}

const STOP_WAIT_MS = 8000

/** Waits for a SIGINTed ffmpeg to flush and exit; one that ignores it is SIGKILLed so it stops holding the mic or screen. */
export function waitForExit(proc: ChildProcess | null, timeoutMs = STOP_WAIT_MS): Promise<void> {
  return new Promise((res) => {
    if (!proc || proc.exitCode !== null) return res()
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      res()
    }, timeoutMs)
    proc.once('close', () => {
      clearTimeout(timer)
      res()
    })
  })
}
