import { exec } from 'child_process'
import { ContextData } from '../../shared/types'
import { CONFIG } from '../../shared/config'

// Detects whether the focused browser window is private / incognito, so the
// ambient context logger can DROP those events entirely (never write a focus
// line, text, or URL for private browsing).
//
// Two signals, OR'd:
//   1. Chromium `mode of front window` == "incognito" (Chrome/Brave/Edge) — the
//      only authoritative API, and only Chromium exposes it.
//   2. Window-title heuristic — covers Safari/Arc/Firefox, which expose NO
//      private flag in their AppleScript dictionary. Private windows brand
//      their title, so we match on that.

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = exec('osascript', { timeout: CONFIG.OSASCRIPT_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout) => {
      resolve(err ? '' : stdout.trim())
    })
    child.stdin?.write(script)
    child.stdin?.end()
  })
}

// Title markers that mean "private window" across the common browsers.
// Case-insensitive. Kept deliberately broad — a false positive only costs us
// one dropped log line; a false negative leaks private activity.
const PRIVATE_TITLE_MARKERS = [
  'incognito',
  'private browsing',
  'private window',
  '(private)',
  'inprivate' // Edge
]

function titleLooksPrivate(title: string | null | undefined): boolean {
  if (!title) return false
  const t = title.toLowerCase()
  return PRIVATE_TITLE_MARKERS.some((m) => t.includes(m))
}

// Ask a Chromium browser whether its front window is incognito. Returns true
// only on an explicit "incognito"; any error / unknown answer is false (we fall
// back to the title heuristic for the verdict).
async function chromiumIncognito(frontApp: string): Promise<boolean> {
  let target: string | null = null
  if (frontApp.includes('Chrome')) target = 'Google Chrome'
  else if (frontApp.includes('Brave')) target = 'Brave Browser'
  else if (frontApp.includes('Edge')) target = 'Microsoft Edge'
  if (!target) return false

  const script = `using terms from application "Google Chrome"
      tell application "${target}" to return mode of front window
    end using terms from`
  try {
    const mode = await runAppleScript(script)
    return mode.toLowerCase() === 'incognito'
  } catch {
    return false
  }
}

/**
 * True if the focused window is a private/incognito browser window and must NOT
 * be logged. Non-browser apps always return false.
 */
export async function isPrivateContext(ctx: ContextData): Promise<boolean> {
  const app = ctx.frontApp || ''
  const isBrowser =
    app.includes('Chrome') ||
    app.includes('Brave') ||
    app.includes('Edge') ||
    app === 'Safari' ||
    app === 'Arc' ||
    app.includes('Firefox')
  if (!isBrowser) return false

  // Cheap title check first; fall back to the authoritative Chromium query.
  if (titleLooksPrivate(ctx.windowTitle)) return true
  return chromiumIncognito(app)
}
