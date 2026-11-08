/**
 * selection.ts — text-selection capture and paste for Windows
 *
 * ONE path, not two. macOS reads AXSelectedText first and only falls back to the
 * clipboard; Windows has no equivalent primary. UI Automation's TextPattern is
 * the nearest thing and it is unimplemented in most of the apps that matter
 * (every Electron app, every browser web page, most terminals) — so it would be
 * a slow, ~2s round trip that usually returns nothing and then does the
 * clipboard swap anyway. Tier 1 does the swap directly and honestly.
 *
 * The swap: remember the clipboard, send Ctrl+C, poll for a change, restore.
 * Every rule the macOS implementation learned the hard way applies here and is
 * reproduced deliberately —
 *  - No sentinel written to the clipboard. Compare against what is already there
 *    instead; a sentinel that outlives a late ⌘C/^C leaks into the user's next
 *    paste and their real clipboard is gone.
 *  - Restore ONLY if the copy actually landed. Nothing was clobbered otherwise,
 *    and writing anyway races a Ctrl+C still in flight.
 *  - One lock over every path that touches the clipboard, so two overlapping
 *    swaps cannot save each other's text as "the original".
 *
 * Keystrokes go through SendKeys rather than a SendInput addon: Tier 1 ships no
 * native toolchain, and SendKeys is the same synthesized-input channel
 * with a PowerShell spawn in front of it.
 */
import { clipboard } from 'electron'
import { quote, runPowerShell } from './shell'

// Notified BEFORE a synthetic Ctrl+V, so Away Mode's input watch can tell our
// paste from a person at the keyboard and not relock the session. Callback, not
// an import — this module must not know Away Mode exists.
let onSynthesizedPaste: (() => void) | null = null

export function setSyntheticPasteListener(cb: (() => void) | null): void {
  onSynthesizedPaste = cb
}

function noteSyntheticPaste(): void {
  if (onSynthesizedPaste) onSynthesizedPaste()
}

/** How long to wait for a synthetic Ctrl+C to show up on the clipboard. Same
 *  400ms budget as macOS, measured there against real apps. */
const COPY_POLL_MS = 400
const COPY_POLL_STEP_MS = 20

/** Beat between writing the clipboard and firing Ctrl+V, so the paste cannot
 *  read the value we are still writing. */
const CLIPBOARD_SYNC_MS = 30

/** How long to leave our text on the clipboard after Ctrl+V before restoring the
 *  user's. Longer than the sync delay because the keystroke is delivered
 *  asynchronously and a restore that beats it pastes the OLD clipboard. */
const PASTE_SETTLE_MS = 400

/** Beat after activating a window before its focused field is ready for a paste.
 *  A re-activated window restores caret focus on its next message pump, not
 *  synchronously. */
const ACTIVATE_SETTLE_MS = 120

/**
 * Send one key chord to whatever currently has focus.
 *
 * SendKeys drives keybd_event, which posts to the foreground window system-wide
 * — the PowerShell child never needs focus itself (and never takes it: spawn's
 * windowsHide means no console is created at all).
 *
 * The one thing this cannot reach is a window running elevated while we are not:
 * User Interface Privilege Isolation drops synthesized input across that
 * boundary silently, exit code 0 and all. There is no API to detect it; the
 * symptom is a copy that never lands, which the caller already handles as "no
 * selection".
 */
function sendChord(chord: string): Promise<string> {
  return runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms\n` +
      `[System.Windows.Forms.SendKeys]::SendWait('${chord}')`
  )
}

// ── Clipboard lock ──────────────────────────────────────────────────────────

let clipboardSwap: Promise<unknown> = Promise.resolve()

function withClipboardLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = clipboardSwap.then(fn, fn)
  // Swallow rejections on the CHAIN only — the caller still sees its own.
  clipboardSwap = next.catch(() => {})
  return next
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Capture the user's current text selection.
 *
 * `passive` callers (the selection watcher, firing after EVERY mouseup) get ''
 * without touching anything. There is no non-destructive read to offer them
 * here, and a synthetic Ctrl+C after every click lands in whatever happens to be
 * open — on macOS that was closing the tray menu about a second after each
 * click. Returning '' is the honest answer: passive selection sensing is a
 * capability Windows does not have in Tier 1.
 */
export function captureSelection(passive = false): Promise<string> {
  if (passive) return Promise.resolve('')
  return withClipboardLock(captureSelectionUnlocked)
}

async function captureSelectionUnlocked(): Promise<string> {
  const originalText = clipboard.readText()

  try {
    await sendChord('^c')
  } catch (err) {
    console.error('[selection] Ctrl+C SendKeys failed:', err)
  }

  const startTime = Date.now()
  let result = ''
  while (Date.now() - startTime < COPY_POLL_MS) {
    const cur = clipboard.readText()
    if (cur && cur !== originalText) {
      result = cur
      break
    }
    await new Promise((resolve) => setTimeout(resolve, COPY_POLL_STEP_MS))
  }

  if (result !== '') clipboard.writeText(originalText)

  return result
}

export function pasteText(text: string): Promise<void> {
  return withClipboardLock(() => pasteTextUnlocked(text))
}

async function pasteTextUnlocked(text: string): Promise<void> {
  const originalText = clipboard.readText()

  // Fast path: the text is already on the clipboard (listen/transcribe copies
  // first, then pastes). Nothing to preserve, so skip the write, the sync and
  // the restore — the difference between an instant paste and a ~0.5s lag.
  const alreadyOnClipboard = originalText === text

  if (!alreadyOnClipboard) {
    clipboard.writeText(text)
    await new Promise((resolve) => setTimeout(resolve, CLIPBOARD_SYNC_MS))
  }

  // Stamped at the keystroke, not at entry: the awaits above eat the window the
  // input watch attributes against.
  noteSyntheticPaste()
  try {
    await sendChord('^v')
  } catch (err) {
    console.error('[selection] Ctrl+V SendKeys failed:', err)
  }

  // Only restore if we clobbered the user's clipboard. When the text was already
  // there, leave it — "copy AND paste" wants it to stay. Awaited, not
  // fire-and-forget: the caller's lock has to outlive the restore or the next
  // swap saves OUR text as the user's "original".
  if (!alreadyOnClipboard) {
    await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
    clipboard.writeText(originalText)
  }
}

/**
 * Like pasteText, but first re-activates the named window so Ctrl+V lands there.
 *
 * Why: a write suggestion can be picked with the MOUSE (clicking the chip in the
 * cursor overlay). That click pulls focus off the trigger app's text field, so a
 * plain Ctrl+V goes nowhere.
 *
 * AppActivate is the Windows analogue of AppleScript's `activate`, and it takes
 * the same thing the caller already has: a name. It matches a window TITLE by
 * prefix (and falls back to process name), which is a looser match than macOS's
 * app name — so it is best-effort, and a miss just means the paste goes where
 * focus already was, exactly as before.
 */
export function pasteTextToApp(text: string, appName: string): Promise<void> {
  if (text === '') return Promise.resolve()
  return withClipboardLock(() => pasteTextToAppUnlocked(text, appName))
}

async function pasteTextToAppUnlocked(text: string, appName: string): Promise<void> {
  const originalText = clipboard.readText()
  const alreadyOnClipboard = originalText === text

  // Clipboard first, then activate + paste, so the keystroke can never fire
  // ahead of the clipboard being ready.
  if (!alreadyOnClipboard) {
    clipboard.writeText(text)
    await new Promise((resolve) => setTimeout(resolve, CLIPBOARD_SYNC_MS))
  }

  if (appName !== '') {
    try {
      // AppActivate throws when nothing matches; -ErrorAction SilentlyContinue
      // does not cover a COM method call, hence the try/catch inside the script
      // as well as around it.
      await runPowerShell(
        `try { (New-Object -ComObject WScript.Shell).AppActivate(${quote(appName)}) | Out-Null } catch {}`
      )
      await new Promise((resolve) => setTimeout(resolve, ACTIVATE_SETTLE_MS))
    } catch (err) {
      console.error('[selection] AppActivate failed:', err)
    }
  }

  noteSyntheticPaste()
  try {
    await sendChord('^v')
  } catch (err) {
    console.error('[selection] pasteTextToApp Ctrl+V failed:', err)
  }

  if (!alreadyOnClipboard) {
    await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
    clipboard.writeText(originalText)
  }
}
