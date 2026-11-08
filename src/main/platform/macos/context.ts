import { exec } from 'child_process'
import { statSync, rmSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../../store/paths'
import { ContextData } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { devLog } from '../../../shared/env'

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = exec('osascript', (err, stdout, _stderr) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(stdout.trim())
    })
    // Cap a single osascript call. A browser's active-tab URL query (fetchBrowserURL)
    // or a front-app query against a beachballing app can hang indefinitely; an
    // unbounded await here froze captureContext() — which the WRITE paste path calls
    // right before pasting. Kill + reject so capture degrades to partial context.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('osascript timed out'))
    }, CONFIG.OSASCRIPT_TIMEOUT_MS)
    child.stdin?.write(script)
    child.stdin?.end()
  })
}

// Fetch the active-tab URL for a specific browser. Run as a SEPARATE osascript
// call so a not-installed browser's missing dictionary can't break the main
// front-app/title script's compilation. `using terms from` lets the script
// compile even when the target app isn't present.
async function fetchBrowserURL(frontApp: string): Promise<string | null> {
  let script: string | null = null
  if (frontApp === 'Safari') {
    script = `tell application "Safari" to return URL of current tab of window 1`
  } else if (frontApp.includes('Chrome')) {
    script = `using terms from application "Google Chrome"
      tell application "Google Chrome" to return URL of active tab of front window
    end using terms from`
  } else if (frontApp === 'Arc') {
    script = `using terms from application "Safari"
      tell application "Arc" to return URL of active tab of front window
    end using terms from`
  } else if (frontApp.includes('Brave')) {
    script = `using terms from application "Google Chrome"
      tell application "Brave Browser" to return URL of active tab of front window
    end using terms from`
  }
  if (!script) return null
  try {
    const url = await runAppleScript(script)
    return url || null
  } catch {
    return null
  }
}

export async function captureContext(): Promise<ContextData> {
  const result: ContextData = {
    frontApp: null,
    windowTitle: null,
    browserURL: null
  }

  // Resolve the frontmost app by name FIRST (`frontmost application` is a fast,
  // O(1) lookup), then read the window title of that named process. The old
  // `first process whose frontmost is true` predicate scans every process and is
  // the thing that hangs under load — it caused recurring "osascript timed out"
  // bursts (every selection / WRITE-paste calls this). Both halves stay in one
  // `try` so a missing-window error degrades to just the app name.
  const script = `
    set frontAppName to ""
    set windowTitle to ""
    try
      tell application "System Events"
        set frontAppName to name of first application process whose frontmost is true
      end tell
    end try
    try
      tell application "System Events"
        tell application process frontAppName
          if exists (window 1) then set windowTitle to name of window 1
        end tell
      end tell
    end try
    return frontAppName & "|||" & windowTitle
  `

  try {
    const raw = await runAppleScript(script)
    const parts = raw.split('|||')
    if (parts.length >= 1 && parts[0]) result.frontApp = parts[0]
    if (parts.length >= 2 && parts[1]) result.windowTitle = parts[1]
  } catch (err) {
    // Expected + degradable: callers proceed with partial context. Keep it out of
    // console.error / crash analytics so a slow System Events doesn't spam the log.
    devLog.warn('captureContext: front-app query failed (degrading to partial):', err)
  }

  // Browser URL via a separate, app-specific call (see fetchBrowserURL).
  if (result.frontApp) {
    result.browserURL = await fetchBrowserURL(result.frontApp)
  }

  return result
}

export async function captureFinderSelection(): Promise<string[]> {
  const script = `
    tell application "Finder"
      try
        set _sel to selection as alias list
        set _out to ""
        repeat with _it in _sel
          set _out to _out & (POSIX path of (_it as text)) & "\n"
        end repeat
        return _out
      on error
        return ""
      end try
    end tell
  `

  try {
    const raw = await runAppleScript(script)
    return raw
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p !== '')
  } catch (err) {
    console.error('Failed to capture Finder selection:', err)
    return []
  }
}

/**
 * Best-effort screen context for a run. Resolves null when there's no usable
 * screenshot — every caller treats that as "run without the image".
 *
 * The size floor is the permission check. `screencapture -x` exits ZERO and
 * writes an empty/black image when Screen Recording is denied, so without this a
 * black image was silently attached to the prompt and sent to the model as if
 * it were the user's screen. Degrading to null is deliberate: for these callers
 * (the suggest bubble, Panel "include screen context") the screenshot is an
 * enhancement, so a weaker answer beats blocking the run over a permission the
 * user only implicitly asked to use.
 *
 * JPG, not PNG, and capped on the long edge: measured on one 3456x2234 Retina
 * frame, 1.64 MB PNG -> 311 KB. The relay is why it matters -- the iOS
 * notification extension pulls this file over the tunnel inside a hard ~30s
 * budget, and blowing that delivers a card with no picture and no error, which
 * looks exactly like a bug. The floor survives the switch: a BLACK frame at that
 * geometry is 22,589 bytes as PNG and 27,025 as JPG, so the denied-permission
 * case still lands far above 1024 (both measured 2026-08-22, not assumed).
 */
export function captureScreenshot(): Promise<string | null> {
  return new Promise((resolve) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shotPath = join(PATHS.TMP, `rewrite-ctx-${stamp}.jpg`)
    // Two commands because they split the work: `screencapture` cannot resize
    // and `sips` cannot capture. `-Z` scales the LONG edge either orientation,
    // so one number covers portrait and landscape displays.
    const cmd =
      `"${CONFIG.SCREENCAPTURE_PATH}" -x -t jpg "${shotPath}" && ` +
      `sips -Z ${CONFIG.SCREENSHOT_MAX_EDGE} -s formatOptions ${CONFIG.SCREENSHOT_JPG_QUALITY} "${shotPath}"`

    exec(cmd, (err) => {
      if (err) {
        console.error('Failed to capture screenshot:', err)
        resolve(null)
        return
      }
      try {
        if (statSync(shotPath).size < CONFIG.MIN_SCREENSHOT_BYTES) {
          console.error('Screenshot came back empty — Screen Recording permission?')
          rmSync(shotPath, { force: true })
          resolve(null)
          return
        }
      } catch {
        resolve(null)
        return
      }
      resolve(shotPath)
    })
  })
}
