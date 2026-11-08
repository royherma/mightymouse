import { ipcMain, clipboard, webContents } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { KeyScope, KeySetPayload, KeyPatch } from '../../shared/keys'
import { KEYS } from '../keys/store'
import { scanScope } from '../keys/scanner'
import { probeKey } from '../keys/probes'

export function publishKeys<T>(result: T): T {
  const maps = KEYS.syncMaps()
  webContents.getAllWebContents().forEach((wc) => wc.send(CHANNELS.keysChanged, maps))
  return result
}

export function registerKeysHandlers(): void {
  ipcMain.handle(CHANNELS.keysScan, async (_, scope: KeyScope) => scanScope(scope))

  ipcMain.handle(CHANNELS.keysList, async () => KEYS.readMaps())

  ipcMain.handle(CHANNELS.keysSet, async (_, payload: KeySetPayload) => publishKeys(await KEYS.set(payload)))

  ipcMain.handle(CHANNELS.keysUpdate, async (_, id: string, patch: KeyPatch) => publishKeys(KEYS.update(id, patch)))

  ipcMain.handle(CHANNELS.keysRemove, async (_, id: string, deleteValue: boolean) =>
    publishKeys(await KEYS.remove(id, deleteValue))
  )

  ipcMain.handle(CHANNELS.keysProbe, async (_, id: string) => publishKeys(await probeKey(id)))

  ipcMain.handle(CHANNELS.keysCopy, async (_, id: string) => {
    const record = KEYS.get(id)
    if (!record) return false
    const value = await KEYS.getValue(record.name)
    if (!value) return false
    clipboard.writeText(value)
    return true
  })
}
