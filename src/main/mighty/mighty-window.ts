import { BrowserWindow, screen } from 'electron'
import { chrome } from '../platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { PREFS } from '../store/prefs'
import { tabUnderCursor } from '../side-browser'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'
import { SETTINGS } from '../store/settings'
import { showSettingsWindow } from '../settings-window'
import type { CodeTab, CodeTabHandoff, WindowBounds, ZoomKey } from '../../shared/types'

let agentForCodeTab: CodeTabHandoff | null = null

export function showAgentInCodeTab(agent: CodeTabHandoff): void {
  agentForCodeTab = agent
  showMightyWindow(false, undefined, undefined, true, 'agents')
}

export function takeAgentForCodeTab(): CodeTabHandoff | null {
  const agent = agentForCodeTab
  agentForCodeTab = null
  return agent
}

const MIN_WIDTH = 680
const MIN_HEIGHT = 480

// Not maximize() — that hides every window behind it and takes a Space of its own.
function defaultBounds(): WindowBounds {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
}

// True when a saved rectangle still lands (at least partly) on a connected display.
// A window restored from a now-disconnected monitor would otherwise open off-screen
// and be unreachable; in that case we fall back to the default (centered) size.
function isOnScreen(b: WindowBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return (
      b.x < wa.x + wa.width &&
      b.x + b.width > wa.x &&
      b.y < wa.y + wa.height &&
      b.y + b.height > wa.y
    )
  })
}

// Persist the current window rectangle. Debounced by the caller's event cadence is
// enough — resize/move fire rapidly, but a write-through of a tiny JSON is cheap and
// the last write (on settle) is the one that matters.
function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
  PREFS.setMightyWindowBounds(win.getBounds())
}

// The Mighty window (?window=mighty). Single instance — re-show if already open.
// Mirrors media-library-window.ts so chrome/loader behavior matches the rest of
// the app's standalone windows.

let mightyWindow: BrowserWindow | null = null

// startFresh: expand from an EMPTY panel → open Mighty on a new empty chat instead
// of resuming its last session. A non-empty panel leaves Mighty resuming as usual.
// sessionId: expand from a LIVE panel conversation, already bound to a Mighty session
// (created when its first ask-mode run started) — takes priority over startFresh.
// focusCapture: open on the Library tab with this capture folder selected — where a
// finished recording's HUD card lands, so a capture opens in-app instead of Finder.
// focusCode: open on the Code tab — the panel's Code button, which has no surface of
// its own and routes here so there is one place agent cards get answered on the Mac.
export function showMightyWindow(
  startFresh = false,
  sessionId?: string,
  focusCapture?: string,
  focusCode = false,
  codeTab?: CodeTab,
  projectId?: string,
  focusSettings = false
): void {
  if (!focusSettings && focusCapture === undefined && !SETTINGS.advancedMode()) return showSettingsWindow('phoneRemote')
  if (mightyWindow && !mightyWindow.isDestroyed()) {
    // Already open: tell the live renderer which chat to land on before revealing.
    // undefined (not '') means "no library intent" — '' is a real request for the
    // tab with nothing selected, so it must not fall through to the session branch.
    if (focusSettings) mightyWindow.webContents.send(CHANNELS.settingsFocusSection)
    else if (focusCode) mightyWindow.webContents.send(CHANNELS.mightyFocusCode, codeTab)
    else if (focusCapture !== undefined)
      mightyWindow.webContents.send(CHANNELS.mediaFocusFolder, focusCapture)
    else if (sessionId) mightyWindow.webContents.send(CHANNELS.mightyOpenSession, sessionId)
    else if (startFresh) mightyWindow.webContents.send(CHANNELS.mightyStartFresh, projectId)
    mightyWindow.show()
    mightyWindow.focus()
    return
  }

  // Restore the last size/place if we have a valid, on-screen rectangle; else the
  // default centered size. Width/height are floored to the OS minimums so a stale
  // tiny bounds can't open an unusably small window.
  const saved = PREFS.getMightyWindowBounds()
  const restore =
    saved && isOnScreen(saved)
      ? {
          x: saved.x,
          y: saved.y,
          width: Math.max(saved.width, MIN_WIDTH),
          height: Math.max(saved.height, MIN_HEIGHT)
        }
      : defaultBounds()

  mightyWindow = new BrowserWindow({
    ...restore,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: PREFS.getMightyName(),
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: true,
    minimizable: true,
    maximizable: true,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const query: Record<string, string> = { window: 'mighty' }
  if (!SETTINGS.advancedMode()) query.simple = '1'
  if (focusSettings) query.tab = 'settings'
  else if (focusCode) {
    query.tab = 'code'
    if (codeTab) query.codeTab = codeTab
  } else if (focusCapture !== undefined) query.focus = focusCapture
  else if (sessionId) query.session = sessionId
  else if (startFresh) {
    query.fresh = '1'
    if (projectId) query.project = projectId
  } else {
    const mode = PREFS.getMightyLastMode()
    if (mode) query.mode = mode
    const codeSession = mode === 'code' ? PREFS.getMightyLastCodeSession() : null
    if (codeSession) query.codeSession = codeSession
  }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const qs = new URLSearchParams(query).toString()
    mightyWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${qs}`)
  } else {
    mightyWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  // Restore the saved zoom. This has to run on did-finish-load: Electron resets
  // zoom to 0 on every navigation, so a level set any earlier is wiped by the load
  // we just kicked off. Setting it before the window is shown avoids a visible
  // reflow from 100% → the saved level.
  mightyWindow.webContents.on('did-finish-load', () => {
    mightyWindow?.webContents.setZoomLevel(PREFS.getMightyZoomLevel())
  })

  // Zoom keys go to the renderer, which zooms the pane under the pointer (pane-zoom.tsx).
  mightyWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return
    if (input.code === 'KeyW' && !input.shift) {
      event.preventDefault()
      if (!mightyWindow) return
      const viewId = tabUnderCursor(mightyWindow) ?? ''
      mightyWindow.webContents.send(CHANNELS.sideBrowserShortcut, { viewId, shortcut: 'closeTab' })
      return
    }
    // '=' is the unshifted key for '+', so ⌘+ arrives as either depending on shift.
    const key: ZoomKey | null =
      input.key === '-' ? 'out' : input.key === '=' || input.key === '+' ? 'in' : input.key === '0' ? 'reset' : null
    if (key) {
      event.preventDefault()
      mightyWindow?.webContents.send(CHANNELS.mightyZoomKey, key)
    }
  })

  // Trackpad pinch / ⌘-scroll — the one zoom route that DOES emit an event. Same
  // persist + broadcast, so the indicator tracks a pinch too.
  mightyWindow.webContents.on('zoom-changed', () => {
    const win = getMightyWindow()
    if (!win) return
    const level = win.webContents.getZoomLevel()
    PREFS.setMightyZoomLevel(level)
    win.webContents.send(CHANNELS.mightyZoomChanged, level)
    refreshTrayZoom()
  })

  mightyWindow.on('ready-to-show', () => {
    mightyWindow?.show()
    mightyWindow?.focus()
  })

  // Remember size + position. `resized`/`moved` fire once per gesture-settle (not
  // per pixel), so this is cheap; a final save on close catches any last change.
  const win = mightyWindow
  win.on('resized', () => saveBounds(win))
  win.on('moved', () => saveBounds(win))

  mightyWindow.on('close', () => saveBounds(win))
  mightyWindow.on('closed', () => {
    mightyWindow = null
  })
}

/**
 * The live Mighty window, or null if it's closed. Used by the chat IPC handler to
 * push live-activity phases to the renderer without re-opening the window.
 */
export function getMightyWindow(): BrowserWindow | null {
  return mightyWindow && !mightyWindow.isDestroyed() ? mightyWindow : null
}

/** The window's current zoom level, or the persisted one when it's closed. */
export function getMightyZoomLevel(): number {
  const win = getMightyWindow()
  return win ? win.webContents.getZoomLevel() : PREFS.getMightyZoomLevel()
}

/**
 * Set the Mighty window's zoom, clamped to CONFIG.MIGHTY.ZOOM. Persists the level
 * and tells the renderer, so the header indicator reflects it however the zoom was
 * triggered. Safe to call with the window closed — it just records the pref, which
 * the next open applies.
 */
function refreshTrayZoom(): void {
  void import('../index').then((m) => m.refreshTrayMenu())
}

export function setMightyZoomLevel(level: number): void {
  const { MIN_LEVEL, MAX_LEVEL } = CONFIG.MIGHTY.ZOOM
  const clamped = Math.min(Math.max(level, MIN_LEVEL), MAX_LEVEL)
  PREFS.setMightyZoomLevel(clamped)
  refreshTrayZoom()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.setZoomLevel(clamped)
  }
  getMightyWindow()?.webContents.send(CHANNELS.mightyZoomChanged, clamped)
}

// Hide (not close) the Mighty window — its renderer + chat state stay alive, so
// re-showing via showMightyWindow() restores in place. Mirrors hidePanelWindow():
// panel and Mighty are two views of the same chat, only one visible at a time.
export function hideMightyWindow(): void {
  if (mightyWindow && !mightyWindow.isDestroyed()) {
    mightyWindow.hide()
  }
}
