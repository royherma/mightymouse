import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { PREFS } from '../store/prefs'
import { finishFirstRun, sendToFirstRunRenderer } from '../first-run-window'
import { dictationReady, onParakeetProgress } from '../setup-check'

export function registerFirstRunHandlers(): void {
  ipcMain.handle(CHANNELS.firstRunFinish, () => {
    finishFirstRun()
  })

  ipcMain.handle(CHANNELS.firstRunGetFirstBootAtMs, () => PREFS.getFirstBootAtMs())

  ipcMain.handle(CHANNELS.firstRunModelReady, () => dictationReady())

  onParakeetProgress((pct) => {
    sendToFirstRunRenderer(CHANNELS.firstRunModelProgress, pct)
  })
}
