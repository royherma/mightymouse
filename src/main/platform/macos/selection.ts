/**
 * selection.ts — deterministic text-selection capture for macOS
 *
 * PRIMARY path: macOS Accessibility API (AXSelectedText / AXFocusedUIElement).
 *   Implemented as a tiny Swift helper compiled at first use and cached under
 *   ~/MightyMouse/. Spawn cost is ~10ms once the binary exists. No clipboard
 *   is touched, so concurrent clipboard writes (password managers, notifications)
 *   cannot corrupt the result.
 *
 *   Why Swift and not JXA/osascript?
 *   - JXA's ObjC bridge (Ref() semantics) is fragile for AXUIElement handles.
 *   - Pure AppleScript "System Events" cannot traverse deep UI trees reliably.
 *   - The C-level AX API (ApplicationServices) is the authoritative path;
 *     Swift gives clean access with no extra dependencies. swiftc ships with
 *     macOS Xcode Command Line Tools (standard on developer machines).
 *
 *   Compile trigger: first call after the app starts (or if the binary is missing).
 *   Subsequent calls spawn the cached binary — no recompile.
 *
 * FALLBACK path (automatic): the existing clipboard-swap race.
 *   Triggered when the AX path returns an empty string (apps that don't expose
 *   AXSelectedText — e.g. some Electron apps, game engines, terminal emulators
 *   without AX support). Preserves and restores the user's clipboard exactly as
 *   before.
 */

import { clipboard } from 'electron'
import { exec, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CONFIG } from '../../../shared/config'

// Notified BEFORE a System Events Cmd+V: unstamped, the paste reads as a person
// at the Mac and relocks the session. Callback, not an import — this module must
// not know Away Mode exists. `make why Q="paste relock"`.
let onSynthesizedPaste: (() => void) | null = null

export function setSyntheticPasteListener(cb: (() => void) | null): void {
  onSynthesizedPaste = cb
}

function noteSyntheticPaste(): void {
  if (onSynthesizedPaste) onSynthesizedPaste()
}

// ── Swift helper source ─────────────────────────────────────────────────────

/**
 * Tiny Swift program that reads AXSelectedText from the focused UI element
 * of the frontmost application.
 *
 * Outputs: the selected text on stdout (empty string if nothing selected or
 * if the AX attribute is not supported). Never exits non-zero for normal cases.
 */
const AX_SWIFT_SOURCE = `
import ApplicationServices
import Foundation
import AppKit

// Resolve the frontmost application's PID via NSWorkspace (same technique
// the Accessibility Inspector uses). Correctly handles multi-process apps
// (Chrome, VS Code, etc.) by targeting the actual frontmost process.
let ws = NSWorkspace.shared
guard let frontApp = ws.frontmostApplication else {
    print("")
    exit(0)
}
let pid = frontApp.processIdentifier
let axApp = AXUIElementCreateApplication(pid)

// Walk to the focused UI element (the widget that currently has keyboard focus).
var focusedRef: CFTypeRef?
let focusedErr = AXUIElementCopyAttributeValue(
    axApp,
    kAXFocusedUIElementAttribute as CFString,
    &focusedRef
)
guard focusedErr == .success, let focused = focusedRef else {
    // kAXErrorCannotComplete (-25204): app doesn't expose AX (some Electron apps,
    // games, custom renderers). kAXErrorNoValue (-25212): nothing focused.
    // Both cases: return empty so the caller falls back to clipboard-swap.
    print("")
    exit(0)
}

// Read the selected text directly — no clipboard is touched.
var selRef: CFTypeRef?
let selErr = AXUIElementCopyAttributeValue(
    focused as! AXUIElement,
    kAXSelectedTextAttribute as CFString,
    &selRef
)
if selErr == .success, let text = selRef as? String, !text.isEmpty {
    print(text)
    exit(0)
}

// AXSelectedText came back empty. On a browser's AXWebArea (rendered page text, as
// opposed to an editable AXTextArea) Chrome/Safari return noValue here even with a
// live selection — but they still answer AXSelectedTextRange. So ask for the range
// and resolve it to a string ourselves. This is the ordinary case on any web page,
// not an edge case: without it the bar never appears on non-editable text.
let el = focused as! AXUIElement
var rangeRef: CFTypeRef?
if AXUIElementCopyAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
   let rangeVal = rangeRef,
   CFGetTypeID(rangeVal) == AXValueGetTypeID() {
    var range = CFRange()
    if AXValueGetValue(rangeVal as! AXValue, .cfRange, &range), range.length > 0 {
        var strRef: CFTypeRef?
        let rangeArg = AXValueCreate(.cfRange, &range)!
        if AXUIElementCopyParameterizedAttributeValue(
            el,
            kAXStringForRangeParameterizedAttribute as CFString,
            rangeArg,
            &strRef
        ) == .success, let text = strRef as? String, !text.isEmpty {
            print(text)
            exit(0)
        }
        // Some AXWebAreas only answer the attributed variant.
        if AXUIElementCopyParameterizedAttributeValue(
            el,
            kAXAttributedStringForRangeParameterizedAttribute as CFString,
            rangeArg,
            &strRef
        ) == .success, let attr = strRef as? NSAttributedString, !attr.string.isEmpty {
            print(attr.string)
            exit(0)
        }
    }
}

// Genuinely nothing selected, or the widget exposes none of the three attributes.
print("")
`.trim()

// Refocuses the frontmost app's compose field so a following Cmd+V lands.
//
// Why this exists: a MOUSE-picked write suggestion pulls keyboard focus off the
// page onto our overlay, blurring the web compose field (X/LinkedIn contenteditable).
// `tell app to activate` makes the window key again but does NOT restore the field's
// caret — only the page can, and a plain activate doesn't trigger it. Confirmed live:
// the paste fired (suggestion_write_pasted, 750 chars) into a blurred field and landed
// nowhere. So before pasting we re-press the focused element via AX, which makes the
// page put the caret back. Prints "ok" if it pressed something, "" otherwise (caller
// pastes regardless — a no-op press is harmless).
const AX_REFOCUS_SWIFT_SOURCE = `
import ApplicationServices
import Foundation
import AppKit

let ws = NSWorkspace.shared
guard let frontApp = ws.frontmostApplication else { print(""); exit(0) }
let pid = frontApp.processIdentifier
let axApp = AXUIElementCreateApplication(pid)

// The element with keyboard focus before we touch anything. On a web page that
// re-takes focus correctly this is the compose field; if focus was lost to our
// overlay the app still reports its last in-page focused element here.
var focusedRef: CFTypeRef?
let focusedErr = AXUIElementCopyAttributeValue(
    axApp, kAXFocusedUIElementAttribute as CFString, &focusedRef)
guard focusedErr == .success, let focused = focusedRef else { print(""); exit(0) }
let el = focused as! AXUIElement

// Re-press it: for a contenteditable / text area this re-enters edit mode and
// restores the caret (the page handles the synthesized press), so the pending
// Cmd+V has somewhere to land. AXPress is a no-op on elements that don't support
// it — safe to always try.
let pressErr = AXUIElementPerformAction(el, kAXPressAction as CFString)
if pressErr == .success { print("ok") } else { print("") }
`.trim()

// ── Binary cache paths ──────────────────────────────────────────────────────

const HOME = homedir()
const APP_DIR = join(HOME, CONFIG.APP_NAME)
const AX_BINARY_PATH = join(APP_DIR, 'ax-selected-text')
const AX_SOURCE_PATH = join(APP_DIR, 'ax-selected-text.swift')
const AX_REFOCUS_BINARY_PATH = join(APP_DIR, 'ax-refocus')
const AX_REFOCUS_SOURCE_PATH = join(APP_DIR, 'ax-refocus.swift')

/** True once we've confirmed or compiled the binary this session. */
let axBinaryReady = false
/** True after a compile failure — skip retries so every hotkey press isn't delayed. */
let axBinaryUnavailable = false
/** Same lifecycle for the refocus helper, tracked separately. */
let axRefocusReady = false
let axRefocusUnavailable = false

// ── Compile helper ──────────────────────────────────────────────────────────

/**
 * Writes the Swift source and compiles it with swiftc.
 * Returns true on success, false on any failure (swiftc not found, compile error).
 * Compiles at most once per session; subsequent calls return immediately.
 */
/** Source-file read that treats any failure as "no stamp", so a missing or
 *  unreadable file just triggers a recompile. */
function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

async function ensureAxBinary(): Promise<boolean> {
  if (axBinaryReady) return true
  if (axBinaryUnavailable) return false

  // Cached binary from a previous session — reuse it ONLY if it was built from the
  // source we ship today. compileSwiftHelper writes the .swift next to the binary,
  // so that file is the build stamp. Without this check an edit to AX_SWIFT_SOURCE
  // ships nothing: every machine that ever ran an older build keeps its old binary
  // forever, and the change looks live in the diff but never runs.
  if (existsSync(AX_BINARY_PATH) && readFileSyncSafe(AX_SOURCE_PATH) === AX_SWIFT_SOURCE) {
    axBinaryReady = true
    return true
  }

  const ok = await compileSwiftHelper(AX_SWIFT_SOURCE, AX_SOURCE_PATH, AX_BINARY_PATH)
  if (ok) axBinaryReady = true
  else axBinaryUnavailable = true
  return ok
}

/** Same compile-cache lifecycle as ensureAxBinary, for the refocus helper. */
async function ensureAxRefocusBinary(): Promise<boolean> {
  if (axRefocusReady) return true
  if (axRefocusUnavailable) return false

  if (
    existsSync(AX_REFOCUS_BINARY_PATH) &&
    readFileSyncSafe(AX_REFOCUS_SOURCE_PATH) === AX_REFOCUS_SWIFT_SOURCE
  ) {
    axRefocusReady = true
    return true
  }

  const ok = await compileSwiftHelper(
    AX_REFOCUS_SWIFT_SOURCE,
    AX_REFOCUS_SOURCE_PATH,
    AX_REFOCUS_BINARY_PATH
  )
  if (ok) axRefocusReady = true
  else axRefocusUnavailable = true
  return ok
}

/**
 * Writes a Swift source file and compiles it with swiftc to the given binary path.
 * Returns true on success, false on any failure (swiftc missing, compile error).
 * Shared by every AX helper so each gets the same caching + error handling.
 */
function compileSwiftHelper(
  source: string,
  sourcePath: string,
  binaryPath: string
): Promise<boolean> {
  try {
    writeFileSync(sourcePath, source, 'utf-8')
  } catch (err) {
    console.error('[selection] Failed to write AX Swift source:', err)
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    // swiftc is available on any macOS machine with Xcode Command Line Tools.
    // -O enables basic optimization (faster binary, no debug info needed).
    const child = exec(
      `/usr/bin/swiftc -O -o "${binaryPath}" "${sourcePath}"`,
      { timeout: 30_000 },
      (err) => {
        if (err) {
          console.error('[selection] swiftc compile failed:', err.message)
          resolve(false)
        } else {
          resolve(true)
        }
      }
    )
    // Drain swiftc's output streams so the process doesn't block.
    child.stdout?.resume()
    child.stderr?.resume()
  })
}

/**
 * Re-press the frontmost app's focused element via AX so a following Cmd+V lands.
 * Best-effort: resolves whether or not it pressed anything (a miss is harmless —
 * the caller pastes regardless). Used only on the mouse-picked write path, where
 * the click blurred a web compose field that `activate` alone can't refocus.
 */
async function refocusComposeField(): Promise<void> {
  const ready = await ensureAxRefocusBinary()
  if (!ready) return

  await new Promise<void>((resolve) => {
    const child = spawn(AX_REFOCUS_BINARY_PATH, [], {
      timeout: 1_500,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    child.on('close', () => resolve())
    child.on('error', (err) => {
      console.error('[selection] AX refocus spawn error:', err)
      resolve()
    })
  })
}

// ── AX primary path ─────────────────────────────────────────────────────────

/**
 * Reads the selected text via the macOS Accessibility API (AXSelectedText).
 * Returns the selected string, or '' if nothing is selected or the app
 * doesn't support AXSelectedText (triggers fallback in the caller).
 */
async function captureSelectionViaAX(): Promise<string> {
  const ready = await ensureAxBinary()
  if (!ready) return ''

  return new Promise<string>((resolve) => {
    const child = spawn(AX_BINARY_PATH, [], {
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })

    child.on('close', () => {
      // Binary always prints one line (the selection or ''). Trim the newline.
      resolve(out.trimEnd())
    })

    child.on('error', (err) => {
      console.error('[selection] AX binary spawn error:', err)
      resolve('')
    })
  })
}

// ── Shared AppleScript runner ────────────────────────────────────────────────

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
    // osascript can hang forever (busy/beachballing target app, stalled browser
    // tab query). Without this the awaiting path — e.g. the WRITE-suggestion paste —
    // freezes indefinitely. Kill the child + reject so the caller degrades gracefully.
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

// ── Clipboard-swap fallback ──────────────────────────────────────────────────

// Serialises every path that saves/clobbers/restores the clipboard. Two
// overlapping swaps used to permanently clobber the user's clipboard: the
// second read the FIRST's still-unrestored sentinel as its "original" and
// restored that, leaving `__cm_rewrite_sentinel_…` on the clipboard forever.
let clipboardSwap: Promise<unknown> = Promise.resolve()

function withClipboardLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = clipboardSwap.then(fn, fn)
  // Swallow rejections on the CHAIN only — the caller still sees its own.
  clipboardSwap = next.catch(() => {})
  return next
}

/**
 * Original clipboard-swap method — sends Cmd+C and polls the clipboard.
 * Used automatically when the AX path returns empty (app doesn't expose
 * AXSelectedText). Preserves and restores the user's clipboard.
 */
function captureSelectionViaClipboard(): Promise<string> {
  return withClipboardLock(captureSelectionViaClipboardUnlocked)
}

async function captureSelectionViaClipboardUnlocked(): Promise<string> {
  const originalText = clipboard.readText()

  // We do NOT write a marker to the clipboard to detect the copy. That was the
  // old design and it leaked: when ⌘C landed after the 400ms poll gave up, the
  // marker outlived the restore and the user's next paste produced the literal
  // `__cm_rewrite_sentinel_<ts>` string, their real clipboard gone. Comparing
  // against the text already there answers the same question with nothing to
  // leak — worst case we miss a copy of identical text, which is a no-op anyway
  // since the result would have equalled the clipboard we were preserving.
  // Stamped at the keystroke, not at entry: the clipboard read above eats the
  // window. The paste sites below do the same — this copy was the one System
  // Events keystroke in this file that never got the 2026-08-12 treatment, and
  // an unstamped one relocks the Mac mid-session.
  noteSyntheticPaste()
  try {
    await runAppleScript(`
      tell application "System Events"
        keystroke "c" using command down
      end tell
    `)
  } catch (err) {
    console.error('[selection] clipboard-swap AppleScript error:', err)
  }

  // Poll clipboard for up to 400ms
  const startTime = Date.now()
  let result = ''
  while (Date.now() - startTime < 400) {
    const cur = clipboard.readText()
    if (cur && cur !== originalText) {
      result = cur
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  // Restore only if the copy actually landed. If nothing did we never clobbered
  // anything, so writing here is pointless churn that also races a ⌘C still in
  // flight — the late-delivery window that leaked the marker in the old design.
  if (result !== '') clipboard.writeText(originalText)

  return result
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Captures the user's current text selection.
 *
 * Tries the macOS Accessibility API first (no clipboard side-effects).
 * Falls back to the clipboard-swap method if AX returns nothing (apps that
 * don't expose AXSelectedText: some terminals, Electron apps with custom
 * rendering, web views that block AX).
 *
 * Signature unchanged: Promise<string>.
 */
export async function captureSelection(passive = false): Promise<string> {

  // PRIMARY: Accessibility API — fast, deterministic, no clipboard mutation.
  const axResult = await captureSelectionViaAX()
  if (axResult.length > 0) {
    return axResult
  }

  // A passive caller (the selection watcher, firing after EVERY mouseup) must
  // never reach the fallback: its synthesized ⌘C lands in whatever is open —
  // it was closing the tray's NSMenu ~1s after every click.
  if (passive) return ''

  // FALLBACK: clipboard-swap race (original behaviour).
  // Triggered when AX returns '' — either no selection or the app doesn't
  // expose AXSelectedText (e.g. some Electron/custom-renderer apps).
  return captureSelectionViaClipboard()
}

export function pasteText(text: string): Promise<void> {
  return withClipboardLock(() => pasteTextUnlocked(text))
}

async function pasteTextUnlocked(text: string): Promise<void> {
  const originalText = clipboard.readText()

  // Fast path: the text is already on the clipboard (e.g. listen/transcribe
  // copies first, then pastes). Skip the write + the 30ms sync + the 400ms
  // restore — there's nothing to preserve, so just fire Cmd+V immediately.
  // This is the difference between an instant paste and a ~0.5s lag.
  const alreadyOnClipboard = originalText === text

  if (!alreadyOnClipboard) {
    clipboard.writeText(text)
    // Small delay for clipboard synchronization
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  // Fire Cmd+V through System Events. We do NOT spawn our own unsigned helper
  // binary here: macOS ties event-posting (Accessibility) permission to the
  // posting process, so a freshly-spawned child binary exits 0 but the OS
  // SILENTLY DROPS the keystroke until that exact binary is added to the
  // Accessibility allowlist. System Events is already trusted, so it just works.

  // Stamped at the keystroke, not at entry: the awaits above eat the window.
  noteSyntheticPaste()
  try {
    await runAppleScript(`
      tell application "System Events"
        keystroke "v" using command down
      end tell
    `)
  } catch (err) {
    console.error('[selection] pasteText AppleScript error:', err)
  }

  // Only restore if we clobbered the user's clipboard. When the text was
  // already there (listen path), leave it — "copy AND paste" wants it to stay.
  // Awaited, not fire-and-forget: the caller's clipboard lock has to outlive
  // the restore or the next swap saves OUR text as the user's "original".
  if (!alreadyOnClipboard) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    clipboard.writeText(originalText)
  }
}

/**
 * Like pasteText, but first RE-ACTIVATES the named app so Cmd+V lands there.
 *
 * Why: a write suggestion can be picked with the MOUSE (clicking the chip in the
 * cursor overlay). That click pulls key focus off the trigger app's text field —
 * the app often stays frontmost, but the field caret is blurred, so a plain Cmd+V
 * goes nowhere. Activating the app by name re-makes it key; for web compose fields
 * (X, Gmail, etc.) the field that was focused regains the caret on re-activation.
 * The ⌘-chord accept path doesn't need this (it never moves the mouse), but routing
 * both through here is harmless — re-activating the already-active app is a no-op.
 *
 * `appName` is the frontmost-app name we captured when the bubble was shown.
 */
export function pasteTextToApp(text: string, appName: string): Promise<void> {
  if (text === '') return Promise.resolve()
  return withClipboardLock(() => pasteTextToAppUnlocked(text, appName))
}

async function pasteTextToAppUnlocked(text: string, appName: string): Promise<void> {
  const originalText = clipboard.readText()
  const alreadyOnClipboard = originalText === text

  // TEMP perf instrumentation: stamp each step so we can see WHICH one eats the
  // 2-3s lag the user reported (osascript spawn? activate hang? AX refocus?).
  // Remove once the paste is fast. Logs to the dev-server stdout (main process).
  const t0 = Date.now()
  const lap = (label: string): void =>
    console.log(`[paste-perf] ${label}: +${Date.now() - t0}ms`)

  // Put the draft on the clipboard BEFORE re-activating the app. Order matters:
  // write first, then activate + paste, so the System Events keystroke can never
  // fire ahead of the clipboard being ready.
  if (!alreadyOnClipboard) {
    clipboard.writeText(text)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  lap('clipboard-written')

  // Re-activate the target by name AND give the page a real beat. A mouse-picked
  // suggestion pulled key focus onto our overlay window, blurring the web compose
  // field (X/LinkedIn contenteditable). `activate` makes the app frontmost; the
  // page then restores the field's caret — but only if it gets a frame to do so.
  // 60ms was too tight on a contenteditable, so the paste fired into a still-blurred
  // field and landed nowhere. Give it longer here (the chord path doesn't blur, so
  // its paste already worked; this delay only costs the mouse path a beat).
  if (appName !== '') {
    try {
      await runAppleScript(`tell application "${appName.replace(/"/g, '\\"')}" to activate`)
      lap('activated')
      await new Promise((resolve) => setTimeout(resolve, CONFIG.SUGGESTIONS.PASTE_REFOCUS_MS))
    } catch (err) {
      console.error('[selection] pasteTextToApp activate error:', err)
    }
  }
  lap('after-activate-wait')

  // Activate alone can't restore a blurred web contenteditable's caret — confirmed
  // live (paste fired into a blurred LinkedIn field, landed nowhere). Re-press the
  // focused element via AX so the page re-enters the field, THEN paste. Best-effort:
  // a no-op press is harmless; we paste regardless.
  await refocusComposeField()
  lap('refocused')

  // Fire Cmd+V through System Events (already-trusted process — see pasteText).
  // Stamped last, after the activate + refocus waits: those can total seconds,
  // far past the watch's attribution window.
  noteSyntheticPaste()
  try {
    await runAppleScript(`
      tell application "System Events"
        keystroke "v" using command down
      end tell
    `)
  } catch (err) {
    console.error('[selection] pasteTextToApp paste error:', err)
  }
  lap('pasted')

  // Restore the user's clipboard AFTER the keystroke is delivered (we awaited it),
  // not on a fire-and-forget timer that could clobber the draft mid-paste — the
  // latent race in the generic pasteText path that could replace the draft with the
  // old clipboard before macOS delivered Cmd+V.
  if (!alreadyOnClipboard) {
    await new Promise((resolve) => setTimeout(resolve, 80))
    clipboard.writeText(originalText)
  }
}
