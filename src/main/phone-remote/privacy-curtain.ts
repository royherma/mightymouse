/**
 * Privacy curtain — a black screen over every display while the phone drives a
 * Mac that Away Mode is holding open (idle-lock-suppressor.ts).
 *
 * Thing #3 of the five "locks" (the list is in idle-lock-suppressor.ts). This
 * one is REVERSIBLE and that is its whole point: the Mac stays unlocked behind
 * the black, and the phone keeps working through it. So a phone that went away
 * gets the curtain, never a real lock -- a lock the phone cannot undo.
 *
 * The problem it solves: the hold trades a real lock for a live screen. That
 * is the right trade for the phone, and the wrong one for the room — an
 * unattended Mac would sit there showing the user's desktop to anyone walking
 * past. Codex covers its displays for the same reason while it holds an unlock.
 *
 * Capture-hidden: buildCurtain sets setContentProtection(true) so the curtain
 * shows on the PHYSICAL screen but is excluded from the phone's getDisplayMedia
 * stream. That split is the whole feature — the room sees black, the phone sees
 * the live desktop underneath. Without it the capture composites the curtain in
 * and the phone goes black too.
 *
 * What this is NOT: a security boundary. It is an opaque window, and a window
 * can be moved past by anything with local access — Mission Control, a hardware
 * key, another app forcing focus. Anyone who is physically at the machine and
 * trying to get around it will. Its actual job is (a) making a walk-past see
 * nothing, and (b) making the machine's state legible, so someone sitting down
 * knows it is being driven rather than finding a mysteriously unlocked Mac. The
 * real protection is that touching the Mac RESTORES THE LOCK (see onLocalInput),
 * not that a window is in the way. Never document it as a lock.
 *
 * Why one window per display: one `setSimpleFullScreen` window covers one
 * screen, and a two-monitor setup would leave the second showing everything.
 * `screen.getAllDisplays()` at show-time rather than a cached list — displays get
 * plugged in mid-session, and a curtain that missed one is the whole failure.
 * Each window is then put into simple-fullscreen so it also covers the menu bar,
 * which a screen-saver-level window alone sits below.
 */
import { BrowserWindow, screen } from 'electron'
import { devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
import { input, chrome } from '../platform'
import { CURTAIN_HTML_V2 } from './curtain-art-v2'

let curtains: BrowserWindow[] = []
let cursorHidden = false

/**
 * The art lives in its own module so a look can be swapped without touching the
 * window plumbing. `curtain-art-v1.ts` is the previous flat-grid version, kept
 * importable as a fallback — swapping back is this one line.
 */
const CURTAIN_HTML = CURTAIN_HTML_V2

/**
 * Black, borderless, above everything including other fullscreen apps.
 *
 * `screen-saver` level is deliberate: `floating` sits below a fullscreen video,
 * which is exactly the case where the desktop is most worth hiding. The window
 * is deliberately NOT focusable — stealing focus would make the phone's own
 * keystrokes land on the curtain instead of the app the user is driving, which
 * silently breaks the remote it exists to protect.
 */
function buildCurtain(bounds: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: CONFIG.THEME_TOKENS.curtainBlack,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // No renderer, no preload, no IPC surface: this window displays a color and
    // nothing else. Loading anything here would give a screen that is up while
    // the Mac is unlocked a reason to have privileges, which it must not.
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  })
  curtains.push(win)
  // Hide the curtain from screen capture (NSWindowSharingNone under the hood).
  // This is what makes the ONE screen show black to the room while the phone's
  // getDisplayMedia stream skips the curtain and sees the live desktop beneath —
  // without it, the capture composites the curtain in and the phone goes black
  // too, defeating the whole point (Roy, on-device: "on phone I should not see
  // it, on the computer it should be there").
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  // Cover the menu bar / tray strip too. A screen-saver-level window still sits
  // BELOW the macOS menu bar, leaving the top ~24px of desktop showing through
  // (Roy, on-device: "the top can't you make it go over the tray bar as well").
  // setSimpleFullScreen takes the window over the menu bar without the native
  // fullscreen animation or a Space of its own.
  win.setSimpleFullScreen(true)
  // Follow the user onto other Spaces — a curtain that stays on Space 1 while
  // the phone drives an app on Space 2 is uncovering the exact thing it hides.
  chrome.showOnAllWorkspaces(win)
  win.setIgnoreMouseEvents(true)
  // loadURL of a data: URI rather than a file — no asset to ship, no path to
  // resolve differently in dev vs packaged, and nothing to fail to load and
  // leave a transparent hole where the curtain should be. encodeURIComponent is
  // mandatory: the markup carries `#`, which truncates the URI at the fragment
  // and would load a half-written page.
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CURTAIN_HTML)}`)
  return win
}

function releaseCurtain(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return true
  try {
    win.setSimpleFullScreen(false)
  } catch (err) {
    devLog.error('Privacy curtain: failed to restore window presentation', err)
  }
  try {
    if (!win.isDestroyed()) win.destroy()
    return win.isDestroyed()
  } catch (err) {
    devLog.error('Privacy curtain: failed to destroy a curtain window', err)
    return false
  }
}

/** True while the curtain is up. */
export function isCurtainVisible(): boolean {
  return curtains.length > 0
}

/**
 * Cover every display. Idempotent — a second call while up is a no-op rather
 * than a second stack of windows nothing tracks.
 */
export function showCurtain(): void {
  if (curtains.length > 0) return

  try {
    for (const display of screen.getAllDisplays()) buildCurtain(display.bounds)
    for (const win of curtains) win.showInactive()
    // Inside the idempotence guard above, and paired with the show in
    // hideCurtain(): CGDisplayHideCursor is refcounted, so a hide without its
    // matching show leaves the user with no pointer at all after the session.
    input.hideSystemCursor()
    cursorHidden = true
    devLog.log('Privacy curtain: shown across', curtains.length, 'display(s)')
  } catch (err) {
    // Non-fatal by design: the session is still valid without a curtain, and
    // taking the remote down over a cosmetic window would be a worse outcome.
    // The caller does NOT treat this as a reason to keep the lock armed.
    devLog.error('Privacy curtain: failed to show', err)
    hideCurtain()
  }
}

/** Take the curtain down. Safe to call when nothing is up. */
export function hideCurtain(): void {
  if (curtains.length === 0) return

  const remaining = curtains.filter((win) => !releaseCurtain(win))
  curtains = remaining
  if (remaining.length === 0 && cursorHidden) {
    input.showSystemCursor()
    cursorHidden = false
    devLog.log('Privacy curtain: hidden')
  }
}
