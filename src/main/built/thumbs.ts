import { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { BuiltItem } from '../../shared/built'
import { PATHS } from '../store/paths'

const THUMB_DIR = join(PATHS.LINK_PREVIEWS, 'built')
const VIEW = { width: 1280, height: 800 }
const THUMB_WIDTH = 480
const SETTLE_MS = 1200
const LOAD_TIMEOUT_MS = 8000
const RUNNING_REFRESH_MS = 10 * 60_000

let win: BrowserWindow | null = null

function captureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    ...VIEW,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    useContentSize: true,
    webPreferences: { partition: 'mm-built-thumbs', offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1 }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, done) => done(false))
  win.webContents.setAudioMuted(true)
  win.on('closed', () => {
    win = null
  })
  return win
}

async function target(item: BuiltItem): Promise<{ url: string; key: string } | null> {
  if (item.file) {
    const st = await stat(item.file).catch(() => null)
    return st ? { url: pathToFileURL(item.file).href, key: `${item.file}:${st.mtimeMs}` } : null
  }
  if (item.kind === 'running' && item.port) {
    return { url: `http://127.0.0.1:${item.port}/`, key: `${item.port}:${item.cwd}:${Math.floor(Date.now() / RUNNING_REFRESH_MS)}` }
  }
  return null
}

async function capture(url: string, out: string): Promise<boolean> {
  const w = captureWindow()
  try {
    await Promise.race([
      w.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS))
    ])
  } catch {
    if (w.isDestroyed() || w.webContents.isLoading()) return false
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  if (w.isDestroyed()) return false
  const image = await w.webContents.capturePage()
  if (image.isEmpty()) return false
  await writeFile(out, image.resize({ width: THUMB_WIDTH, quality: 'good' }).toPNG())
  void w.loadURL('about:blank')
  return true
}

const done = new Map<string, string>()
let queue: Promise<void> = Promise.resolve()

export function withThumbs(items: BuiltItem[]): BuiltItem[] {
  return items.map((i) => (done.has(i.id) ? { ...i, thumb: done.get(i.id) } : i))
}

export function queueThumbs(items: BuiltItem[], onChange: () => void): void {
  queue = queue.then(async () => {
    await mkdir(THUMB_DIR, { recursive: true })
    for (const item of items) {
      const t = await target(item)
      if (!t) continue
      const out = join(THUMB_DIR, `${createHash('sha1').update(t.key).digest('hex').slice(0, 16)}.png`)
      if (done.get(item.id) === out) continue
      if (existsSync(out) || (await capture(t.url, out).catch(() => false))) {
        done.set(item.id, out)
        onChange()
      }
    }
  }).catch(() => undefined)
}
