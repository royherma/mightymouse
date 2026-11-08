import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CHANNELS } from '../shared/ipc'
import { CONFIG } from '../shared/config'
import { ActivityPayload } from '../shared/types'
import { getActivity } from './activity'
import { system, chrome, capabilities } from './platform'

// Dynamic Island — a single persistent, transparent, click-through overlay that WRAPS
// AROUND the macOS notch. Unlike the HUD (one BrowserWindow per run, stacked
// top-right), this is ONE long-lived window that morphs between activity states and
// collapses to a thin sliver hugging the notch when idle. Opt-in
// (PREFS.getDynamicIsland) and fully additive: it never touches the HUD path.
//
// The window sits at the TRUE top of the screen (y = bounds.y, NOT workArea.y) and
// spans wider than the notch so the renderer can paint a black blob AROUND the camera
// — content in the gutters left + right, hanging below, with concave corners where it
// meets the notch. Real notch dims come from the native reader (macos/notch-info, via
// NSScreen.safeAreaInsets); we fall back to CONFIG constants on non-notch displays.

let islandWindow: BrowserWindow | null = null
// Holds a done/error flash for COLLAPSE_MS, then snaps the window back to collapsed.
// Cleared on every push so a new state never gets clobbered by a stale collapse.
let collapseTimer: NodeJS.Timeout | null = null
// First-run demo timers. A real activity (or window close) cancels them so the
// scripted tour never fights an actual run.
let demoTimers: NodeJS.Timeout[] = []

function cancelDemo(): void {
  for (const t of demoTimers) clearTimeout(t)
  demoTimers = []
}

// Resolved notch geometry for the primary display. Reads real dims from the native
// bridge (NSScreen.safeAreaInsets) once and caches; falls back to CONFIG constants on
// non-notch / external displays so the blob still renders, just centered without a
// real camera to hug.
let cachedNotch: { width: number; height: number } | null = null
function notchGeometry(): { width: number; height: number } {
  if (cachedNotch) return cachedNotch
  const info = capabilities.notch ? system.getNotchInfo() : null
  cachedNotch =
    info && info.hasNotch
      ? { width: info.notchWidth, height: info.notchHeight }
      : { width: CONFIG.ISLAND.NOTCH_W, height: CONFIG.ISLAND.NOTCH_H }
  return cachedNotch
}

// Where the user dragged the island, as a delta from its notch-anchored home. Session
// only, by design: a drag is "get out of my way right now", not a new permanent home,
// so a restart puts it back on the notch. Double-click resets it without a restart.
let dragOffset = { x: 0, y: 0 }

/** Drag + reset wiring. The renderer sends screen-space DELTAS, not absolute points:
 *  the window is the drag surface, so its own movement would poison an absolute read. */
export function registerIslandIpc(): void {
  ipcMain.on(CHANNELS.islandMove, (_e, dx: number, dy: number) => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    dragOffset = { x: dragOffset.x + dx, y: dragOffset.y + dy }
    applyBounds()
  })

  // Double-click snaps back to the notch — the way out if it lands somewhere bad.
  ipcMain.on(CHANNELS.islandResetPosition, () => {
    if (dragOffset.x === 0 && dragOffset.y === 0) return
    dragOffset = { x: 0, y: 0 }
    applyBounds()
  })
}

/** Re-apply bounds for the CURRENT expanded state, so a move mid-run keeps its size. */
function applyBounds(): void {
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.setBounds(islandBounds(getActivity().state !== 'idle'))
}

// Window bounds for the wrap-around blob. The window starts at the TRUE top of the
// screen (bleeding a few px above so the top edge tucks behind the black notch with no
// seam) and spans the notch width plus a gutter on each side, so the renderer can draw
// the blob AROUND the camera. Height = notch height + the drop below it (the body where
// content lives). Idle = thin sliver hugging the notch; expanded = wide gutters + drop.
function islandBounds(expanded: boolean): { x: number; y: number; width: number; height: number } {
  const { ISLAND } = CONFIG
  const b = screen.getPrimaryDisplay().bounds
  const notch = notchGeometry()
  const gutter = expanded ? ISLAND.GUTTER_EXPANDED : ISLAND.GUTTER_COLLAPSED
  const drop = expanded ? ISLAND.DROP_EXPANDED : ISLAND.DROP_COLLAPSED
  const { TOP_BLEED } = ISLAND
  const width = notch.width + gutter * 2
  const height = TOP_BLEED + notch.height + drop
  const homeX = Math.round(b.x + b.width / 2 - width / 2)
  const homeY = b.y - TOP_BLEED
  // Clamped against the FULL virtual desktop, not the primary display, so dragging
  // onto a second monitor works. Half the window may leave the screen; a whole one
  // may not, or there is nothing left to grab to drag it back.
  const all = screen.getAllDisplays().map((d) => d.bounds)
  const minX = Math.min(...all.map((d) => d.x)) - width / 2
  const maxX = Math.max(...all.map((d) => d.x + d.width)) - width / 2
  const maxY = Math.max(...all.map((d) => d.y + d.height)) - height / 2
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, homeX + dragOffset.x))),
    y: Math.round(Math.min(maxY, Math.max(homeY, homeY + dragOffset.y))),
    width,
    height
  }
}

function buildWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...islandBounds(false),
    frame: false,
    transparent: true,
    // macOS auto-rounds transparent window corners; we draw our own bottom radius on
    // the bar and want a HARD-SQUARE top, so disable the OS rounding.
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: false,
    hasShadow: false,
    // Lets the frame extend ABOVE the screen top (y<0) so the blob's top edge tucks
    // behind the notch. Without this, macOS clamps the window down below the menu bar
    // (observed: requested y=-6 → got y=34). cursor-window.ts relies on the same flag.
    enableLargerThanScreen: true,
    ...chrome.windowOptions('panel'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Observational only (MVP): never intercept clicks, and float above the menu bar /
  // fullscreen apps / every Space — same overlay class as the cursor companion.
  win.setIgnoreMouseEvents(true, { forward: false })
  // 'screen-saver' is the highest Electron level; combined with the panel type +
  // enableLargerThanScreen it draws OVER the menu bar instead of being clamped below.
  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  // Hand the renderer the notch geometry so it can carve the camera cutout in the
  // right spot and hug it with concave corners. notchTop = px from the window's top to
  // the notch's bottom edge (the bleed masked above the screen + the notch height).
  const notch = notchGeometry()
  const notchTop = String(CONFIG.ISLAND.TOP_BLEED + notch.height)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=island&notchW=${notch.width}&notchTop=${notchTop}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'island', notchW: String(notch.width), notchTop }
    })
  }

  win.on('closed', () => {
    islandWindow = null
  })

  return win
}

// Resize the window for the state and forward the payload to the renderer. Shared by
// real activity and the demo.
function renderState(payload: ActivityPayload): void {
  if (!islandWindow || islandWindow.isDestroyed()) return
  const active = payload.state !== 'idle'
  islandWindow.setBounds(islandBounds(active))
  // Catch the mouse ONLY while a run is showing, so the island can be dragged out of
  // the way mid-run. Idle it goes back to click-through: parked over the menu bar, a
  // permanently mouse-catching island would eat clicks on whatever sits behind it.
  islandWindow.setIgnoreMouseEvents(!active, { forward: false })
  islandWindow.webContents.send(CHANNELS.islandActivity, payload)
}

/**
 * Push an activity state to the island. Resizes the window (collapsed sliver when idle,
 * expanded blob when active) and forwards the payload to the renderer. A done/error
 * state holds expanded for COLLAPSE_MS then collapses — the emitter's own RESET_MS
 * timer drives the actual return to idle, so this just handles window geometry. No-op
 * when the island is off (window absent) — call sites stay dumb.
 */
export function pushIslandActivity(payload: ActivityPayload): void {
  if (!islandWindow || islandWindow.isDestroyed()) return

  // A real run wins: kill any first-run demo in flight so it can't stomp the state.
  cancelDemo()
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }

  renderState(payload)

  if (payload.state === 'done' || payload.state === 'error') {
    collapseTimer = setTimeout(() => {
      collapseTimer = null
      if (islandWindow && !islandWindow.isDestroyed()) {
        islandWindow.setBounds(islandBounds(false))
      }
    }, CONFIG.ISLAND.COLLAPSE_MS)
  }
}

export function startIslandWindow(demo = false): void {
  if (islandWindow && !islandWindow.isDestroyed()) {
    if (demo) runIslandDemo()
    return
  }
  islandWindow = buildWindow()
  islandWindow.on('ready-to-show', () => {
    if (!islandWindow || islandWindow.isDestroyed()) return
    islandWindow.showInactive()
    // Re-assert bounds AFTER show: macOS otherwise clamps the frame below the menu
    // bar on first paint (observed y=-6 → y=34). With enableLargerThanScreen + the
    // panel type, the second set sticks at the true top.
    islandWindow.setBounds(islandBounds(false))
    // Seed the renderer with whatever's happening right now (usually idle).
    islandWindow.webContents.send(CHANNELS.islandActivity, getActivity())
    // First-run tour when the user just turned it on, so they see it do something.
    if (demo) runIslandDemo()
  })
}

// Scripted first-run tour: cycle through the live states with friendly labels so the
// user instantly sees what the island does when they turn it on. Plays directly to the
// renderer (not through the activity emitter), and any real run cancels it mid-flight.
const DEMO_SCRIPT: ActivityPayload[] = [
  { state: 'listening', detail: 'Listening' },
  { state: 'recording', detail: 'Recording' },
  { state: 'screenshot', detail: 'Screenshot' },
  { state: 'thinking', detail: 'Thinking…' },
  { state: 'done', detail: 'This is your Island' },
  { state: 'idle' }
]

export function runIslandDemo(): void {
  if (!islandWindow || islandWindow.isDestroyed()) return
  cancelDemo()
  const step = CONFIG.ISLAND.DEMO_STEP_MS
  DEMO_SCRIPT.forEach((payload, i) => {
    demoTimers.push(
      setTimeout(() => {
        if (!islandWindow || islandWindow.isDestroyed()) return
        renderState(payload)
      }, i * step)
    )
  })
}

export function stopIslandWindow(): void {
  cancelDemo()
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  if (islandWindow && !islandWindow.isDestroyed()) {
    islandWindow.close()
  }
  islandWindow = null
}

export function isIslandWindowRunning(): boolean {
  return islandWindow !== null && !islandWindow.isDestroyed()
}

/**
 * Toggle wrapper, mirroring setCursorCompanion — drives the PREFS live effect.
 * Pass demo=true (user just flipped it ON) to play the first-run tour so they
 * immediately see what the island does. Startup restore passes demo=false.
 */
export function setIslandWindow(on: boolean, demo = false): void {
  if (on) startIslandWindow(demo)
  else stopIslandWindow()
}
