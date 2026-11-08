import { ipcMain, shell, webContents } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { BuiltItem, BuiltRunResult } from '../../shared/built'
import { cachedBuilt, favoriteBuilt, hideBuilt, scanBuilt, startBuilt, stopBuilt } from '../built/scan'
import { autoTagBuilt, setBuiltTags, withTags } from '../built/tags'
import { queueThumbs, withThumbs } from '../built/thumbs'

const RESCAN_AFTER_MS = 30_000
const WARM_UP_MS = 15_000
let lastScan = 0
let scannedOnce = false
let pushTimer: NodeJS.Timeout | null = null

const view = (items: BuiltItem[]): BuiltItem[] => withTags(withThumbs(items))

function push(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    const items = view(cachedBuilt())
    webContents.getAllWebContents().forEach((wc) => wc.send(CHANNELS.builtChanged, items))
  }, 250)
}

function refresh(): void {
  if (Date.now() - lastScan < RESCAN_AFTER_MS) return
  lastScan = Date.now()
  const started = Date.now()
  void scanBuilt()
    .then((items) => {
      scannedOnce = true
      console.log(`[built] scan ${items.length} items in ${Date.now() - started}ms`)
      push()
      queueThumbs(items, push)
      autoTagBuilt(items, push)
    })
    .catch((err) => console.warn('[built] scan failed', err))
}

function find(id: string): BuiltItem | undefined {
  return cachedBuilt().find((i) => i.id === id)
}

export function registerBuiltHandlers(): void {
  setTimeout(refresh, WARM_UP_MS)
  ipcMain.handle(CHANNELS.builtList, () => {
    refresh()
    return scannedOnce ? view(cachedBuilt()) : null
  })

  ipcMain.handle(CHANNELS.builtOpen, async (_, id: string, how: 'open' | 'reveal') => {
    const item = find(id)
    if (!item) return false
    if (how === 'reveal') {
      if (!item.file) return false
      shell.showItemInFolder(item.file)
      return true
    }
    if (item.kind === 'file' && item.file) return (await shell.openPath(item.file)) === ''
    if (item.url && /^https?:\/\//.test(item.url)) {
      await shell.openExternal(item.url)
      return true
    }
    return false
  })

  const rescanNow = async (result: BuiltRunResult): Promise<BuiltRunResult> => {
    lastScan = Date.now()
    await scanBuilt().then(push).catch(() => undefined)
    return result
  }
  ipcMain.handle(CHANNELS.builtStop, async (_, id: string) => rescanNow(await stopBuilt(id)))
  ipcMain.handle(CHANNELS.builtStart, async (_, id: string) => rescanNow(await startBuilt(id)))
  ipcMain.handle(CHANNELS.builtHide, async (_, id: string) => view(await hideBuilt(id)))
  ipcMain.handle(CHANNELS.builtFavorite, async (_, id: string, on: boolean) => view(await favoriteBuilt(id, on)))
  ipcMain.handle(CHANNELS.builtTag, (_, id: string, tags: string[]) => {
    setBuiltTags(id, tags)
    return view(cachedBuilt())
  })
}
