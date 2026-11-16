import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chrome } from './platform'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import type { PopoverMenuRequest } from '../shared/types'

const GAP = 4
const START_HEIGHT = 200

type Side = 'below' | 'above'
type Open = { request: PopoverMenuRequest; owner: BrowserWindow; side: Side | null; resolve: (id: string | null) => void }

let menuWindow: BrowserWindow | null = null
let loaded: Promise<void> = Promise.resolve()
let open: Open | null = null

function build(): BrowserWindow {
  const win = new BrowserWindow({
    width: 300,
    height: START_HEIGHT,
    ...chrome.windowOptions('panel'),
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)
  win.on('blur', () => finish(null, false))
  win.on('closed', () => {
    menuWindow = null
    finish(null, false)
  })
  loaded = new Promise((done) => win.webContents.once('did-finish-load', () => done()))
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=popover-menu`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'popover-menu' } })
  }
  return win
}

function finish(id: string | null, refocus: boolean): void {
  const done = open
  open = null
  if (!done) return
  if (refocus && !done.owner.isDestroyed()) {
    done.owner.show()
    done.owner.webContents.focus()
  }
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide()
  done.resolve(id)
}

function place(height: number): void {
  if (!open || !menuWindow || menuWindow.isDestroyed() || open.owner.isDestroyed()) return
  const { anchor, width } = open.request
  const content = open.owner.getContentBounds()
  const area = screen.getDisplayMatching(content).workArea
  const top = content.y + anchor.y
  const bottom = top + anchor.height
  const below = area.y + area.height - bottom - GAP
  const above = top - area.y - GAP
  // side is fixed at first show so typing in the search box never flips the menu across the button
  open.side ??= height <= below || below >= above ? 'below' : 'above'
  const room = open.side === 'below' ? below : above
  const h = Math.max(1, Math.min(Math.ceil(height), room))
  const w = Math.min(width, area.width)
  const x = Math.min(Math.max(area.x, Math.round(content.x + anchor.x)), area.x + area.width - w)
  const y = open.side === 'below' ? bottom + GAP : top - GAP - h
  menuWindow.setBounds({ x, y: Math.round(y), width: w, height: h })
  if (!menuWindow.isVisible()) {
    // show() alone: focus() activates the app and raises the main window over the browser
    menuWindow.show()
    menuWindow.webContents.focus()
  }
}

async function show(e: IpcMainInvokeEvent, request: PopoverMenuRequest): Promise<string | null> {
  const owner = BrowserWindow.fromWebContents(e.sender)
  if (!owner || !Array.isArray(request?.items) || request.items.length === 0) return null
  finish(null, false)
  if (!menuWindow || menuWindow.isDestroyed()) menuWindow = build()
  const win = menuWindow
  await loaded
  return new Promise((resolve) => {
    open = { request, owner, side: null, resolve }
    win.setSize(Math.round(request.width), win.getSize()[1])
    win.webContents.send(CHANNELS.popoverMenuShow, request)
  })
}

export function registerPopoverMenu(): void {
  ipcMain.handle(CHANNELS.popoverMenu, show)
  ipcMain.on(CHANNELS.popoverMenuSize, (e, height: unknown) => {
    if (e.sender === menuWindow?.webContents && typeof height === 'number' && height > 0) place(height)
  })
  ipcMain.on(CHANNELS.popoverMenuPick, (e, id: unknown) => {
    if (e.sender === menuWindow?.webContents) finish(typeof id === 'string' ? id : null, true)
  })
}
