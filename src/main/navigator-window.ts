import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chrome } from './platform'
import { isSideBrowserPage } from './side-browser'

// Unlike the selection bar, this one MUST take focus — it is a search field, and
// a non-focusable window never receives typing. The app the user came from is
// remembered by the target dispatch, not by keeping focus here.

let navWindow: BrowserWindow | null = null
let returnTo: BrowserWindow | null = null

const WIDTH = 960
const HEIGHT = 480

function buildWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    ...chrome.windowOptions('vibrant'),
    visualEffectState: 'active',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  // Clicking into another app while the overlay is up means the user moved on.
  win.on('blur', () => {
    returnTo = null
    hideNavigatorWindow()
  })
  win.on('closed', () => {
    navWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=navigator`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'navigator' } })
  }

  return win
}

/** Center the overlay on whichever display the cursor is on — the user's eyes
 *  are already there, and on a two-screen desk the other display is a miss. */
function placeUnderCursor(win: BrowserWindow): void {
  const pt = screen.getCursorScreenPoint()
  const work = screen.getDisplayNearestPoint(pt).workArea
  win.setBounds({
    x: Math.round(work.x + (work.width - WIDTH) / 2),
    y: Math.round(work.y + work.height * 0.18),
    width: WIDTH,
    height: HEIGHT
  })
}

export function showNavigatorWindow(): void {
  const from = BrowserWindow.getFocusedWindow()
  returnTo = from && from !== navWindow ? from : null
  const reveal = (): void => {
    if (!navWindow || navWindow.isDestroyed()) return
    placeUnderCursor(navWindow)
    navWindow.show()
    navWindow.focus()
    navWindow.webContents.focus()
  }

  if (navWindow && !navWindow.isDestroyed()) {
    reveal()
    return
  }
  navWindow = buildWindow()
  navWindow.once('ready-to-show', reveal)
}

export function hideNavigatorWindow(): void {
  if (!navWindow || navWindow.isDestroyed() || !navWindow.isVisible()) return
  navWindow.hide()
  // An accessory app whose key window hides drops out of the foreground, taking the app window behind other apps.
  const back = returnTo
  returnTo = null
  if (back && !back.isDestroyed() && back.isVisible()) back.focus()
}

export function isNavigatorVisible(): boolean {
  return !!navWindow && !navWindow.isDestroyed() && navWindow.isVisible()
}

/** The chord is a toggle: pressing it again with the overlay up puts it away,
 *  which is what every palette on this machine does. */
export function toggleNavigatorWindow(): void {
  if (isNavigatorVisible()) hideNavigatorWindow()
  else showNavigatorWindow()
}

export function closeNavigatorWindow(): void {
  if (navWindow && !navWindow.isDestroyed()) navWindow.close()
  navWindow = null
}

export function bindInAppNavigatorKey(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.meta || input.alt || input.shift || input.control) return
      if (input.key.toLowerCase() !== 'k') return
      if (isSideBrowserPage(contents)) return
      event.preventDefault()
      toggleNavigatorWindow()
    })
  })
}
