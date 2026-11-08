import { BrowserWindow, screen, app } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { spawn } from 'child_process'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { devLog } from '../shared/env'
import type { PermissionKey } from '../shared/types'
import dragIconAsset from '../../resources/drag-icon.png?asset'

// The drag-to-add coach, as its OWN floating panel.
//
// Why a separate window and not a card inside the wizard: pressing Grant on a
// `+`-allow-list permission hands focus to System Settings, which then covers
// the wizard completely. Any coaching rendered inside the wizard is, at the
// exact moment it's needed, behind the window the user is looking at. The
// instruction has to survive that focus change, which means it has to be a
// window of its own — always-on-top, non-focusable, visible over full-screen
// spaces (System Settings opens as one on some setups).
//
// `focusable: false` is load-bearing twice over: the panel must never steal the
// drag the user is performing in System Settings, and taking focus would also
// pull our app forward and re-cover the pane we just told them to use.
//
// Deliberately NOT styled like MightyMouse — see DragCoachApp.tsx. It reads as
// a system affordance because that's what it's explaining; our brand chrome here
// would look like an ad pasted over System Settings.

let coachWindow: BrowserWindow | null = null
let trackTimer: NodeJS.Timeout | null = null

const { WIDTH, HEIGHT, GAP } = CONFIG.DRAG_COACH_PANEL

type Bounds = { x: number; y: number; width: number; height: number }

/**
 * The System Settings window's real position and size, via System Events.
 *
 * Measured rather than assumed: System Settings does NOT reliably open centred
 * (observed at x=60,y=34 on a 1728px display), so any hardcoded placement puts
 * the panel in the wrong place — and it moves the moment the user drags the
 * pane. Returns null if Settings isn't up or Accessibility isn't granted yet,
 * which is a normal state here, not an error: we simply fall back to a corner.
 *
 * Async on purpose. `runOsa` in macos/app-context is spawnSync, which is fine
 * for a one-shot but this runs on a repeating timer — a 3s sync spawn stalling
 * the main process on every tick would jank every window the app owns.
 */
function settingsBounds(): Promise<Bounds | null> {
  return new Promise((resolve) => {
    const script =
      'tell application "System Events" to tell process "System Settings" to get {position, size} of window 1'
    const proc = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })

    let out = ''
    proc.stdout.on('data', (d) => (out += d))
    // Drain stderr: an un-consumed pipe can block a child that errors verbosely.
    proc.stderr.resume()

    // Apple-events can hang indefinitely when the target app is mid-modal, so
    // every call is bounded — same reasoning as OSASCRIPT_TIMEOUT_MS in osa.ts.
    const kill = setTimeout(() => proc.kill(), 2000)

    proc.on('error', () => {
      clearTimeout(kill)
      resolve(null)
    })

    proc.on('close', (code) => {
      clearTimeout(kill)
      // "60, 34, 723, 612" → x, y, width, height
      const n = out.trim().split(',').map((s) => Number(s.trim()))
      if (code !== 0 || n.length !== 4 || n.some(Number.isNaN)) return resolve(null)
      resolve({ x: n[0], y: n[1], width: n[2], height: n[3] })
    })
  })
}

/**
 * Where the panel goes: centred directly BELOW the System Settings window, so
 * the drag runs bottom-to-top into the pane's list.
 *
 * Clamped to the display's work area in both axes — on a short display the pane
 * can end close enough to the bottom that "below it" would be off-screen, and a
 * panel the user can't see is worse than one slightly overlapping. Falls back to
 * the bottom-centre of the active display when Settings can't be located.
 */
async function coachBounds(): Promise<Bounds> {
  const settings = await settingsBounds()
  const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea

  const clamp = (x: number, y: number): Bounds => ({
    x: Math.max(work.x, Math.min(work.x + work.width - WIDTH, x)),
    y: Math.max(work.y, Math.min(work.y + work.height - HEIGHT, y)),
    width: WIDTH,
    height: HEIGHT
  })

  if (!settings) {
    return clamp(work.x + (work.width - WIDTH) / 2, work.y + work.height - HEIGHT - GAP * 2)
  }

  return clamp(
    settings.x + (settings.width - WIDTH) / 2,
    settings.y + settings.height + GAP
  )
}

/**
 * Keep the panel pinned under System Settings while it's open.
 *
 * A one-shot placement goes stale the instant the user drags the pane, which
 * they will — the panel is telling them to interact with it. 700ms is slow
 * enough to be invisible on the CPU and fast enough that the panel reads as
 * attached rather than lagging.
 */
function startTracking(): void {
  if (trackTimer) clearInterval(trackTimer)
  trackTimer = setInterval(() => {
    void (async () => {
      if (!coachWindow || coachWindow.isDestroyed()) return
      const next = await coachBounds()
      // Re-check after the await: the panel can close while osascript is in
      // flight, and setBounds on a destroyed window throws.
      if (!coachWindow || coachWindow.isDestroyed()) return
      const cur = coachWindow.getBounds()
      // Only write on a real move — setBounds every tick fights the user if
      // they're dragging our panel itself, and rounding makes it jitter.
      if (Math.abs(cur.x - next.x) > 2 || Math.abs(cur.y - next.y) > 2) {
        coachWindow.setBounds(next)
      }
    })()
  }, 700)
}

function stopTracking(): void {
  if (trackTimer) clearInterval(trackTimer)
  trackTimer = null
}

/**
 * Absolute path to the .app bundle the user has to drag into the pane.
 *
 * `getPath('exe')` points INSIDE the bundle (…/MightyMouse.app/Contents/MacOS/
 * MightyMouse); dragging that would hand macOS the unix binary, which it
 * refuses in a TCC pane. Walk up to the .app itself — the only draggable thing.
 * In dev there is no bundle (it's Electron.app), so this falls back to the exe.
 */
export function appBundlePath(): string {
  const exe = app.getPath('exe')
  const m = exe.match(/^(.*\.app)\/Contents\/MacOS\//)
  return m ? m[1] : exe
}

/**
 * Show the coach for one permission. Idempotent: calling it again while open
 * just re-points the existing panel at the new key (the user can walk from
 * Accessibility to Screen Recording without the panel flickering out and back).
 */
export async function showDragCoachWindow(key: PermissionKey): Promise<void> {
  if (coachWindow && !coachWindow.isDestroyed()) {
    coachWindow.setBounds(await coachBounds())
    coachWindow.showInactive()
    return
  }

  coachWindow = new BrowserWindow({
    ...(await coachBounds()),
    frame: false,
    transparent: true,
    // `vibrancy` + a transparent frame is what makes this read as a macOS
    // sheet rather than a web page: the panel picks up the desktop behind it
    // the same way a real system dialog does.
    ...chrome.windowOptions('vibrant'),
    visualEffectState: 'active',
    roundedCorners: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    // Never take focus: the user is mid-drag in System Settings, and pulling
    // focus here would both interrupt that and re-cover the pane.
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 'floating' rather than 'screen-saver': high enough to sit over System
  // Settings, low enough that a real system alert still wins — this panel must
  // never be the thing covering a TCC dialog the user has to answer.
  coachWindow.setAlwaysOnTop(true, 'floating')
  chrome.showOnAllWorkspaces(coachWindow)

  const query = { window: 'drag-coach', perm: key }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const qs = new URLSearchParams(query).toString()
    coachWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${qs}`)
  } else {
    coachWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  coachWindow.on('ready-to-show', () => {
    // showInactive, not show: same reason as focusable:false above.
    coachWindow?.showInactive()
  })

  coachWindow.on('closed', () => {
    stopTracking()
    coachWindow = null
  })

  startTracking()
  devLog.log('[drag-coach] panel opened for', key)
}

/**
 * Start a REAL macOS file drag of the .app bundle, from the panel's icon.
 *
 * This is the whole point of the panel. A static <img> teaches a gesture that
 * does nothing when attempted — the user drags it, nothing happens, and the
 * instruction is worse than none. `startDrag` hands the actual bundle to the
 * system drag pasteboard, so dropping it on the pane's list adds the app for
 * real, exactly as dragging it out of Finder would.
 */
export function startAppDrag(): void {
  if (!coachWindow || coachWindow.isDestroyed()) return
  const file = appBundlePath()
  try {
    coachWindow.webContents.startDrag({
      file,
      // The cursor image during the drag. Electron REQUIRES a non-empty icon —
      // it throws "Must specify non-empty 'icon'" otherwise — so this is not
      // cosmetic. app.getFileIcon would give the real bundle icon but it's
      // async, and startDrag has to be called synchronously inside the gesture.
      // `?asset` (not a raw join) so electron-vite rewrites the path for the
      // packaged build, where resources/ does not sit beside __dirname.
      icon: dragIconAsset
    })
  } catch (err) {
    devLog.warn('[drag-coach] startDrag failed:', err)
  }
}

/** Hide the coach. Safe to call when it was never shown. */
export function closeDragCoachWindow(): void {
  stopTracking()
  if (coachWindow && !coachWindow.isDestroyed()) {
    coachWindow.close()
  }
  coachWindow = null
}
