import type { SettingsSectionFocus } from '../shared/types'
import { getMightyWindow, showMightyWindow } from './mighty/mighty-window'

// Pulled by the renderer; a push would be lost when Settings is not mounted yet.
let pendingFocusSection: SettingsSectionFocus | null = null

export function takePendingSettingsFocus(): SettingsSectionFocus | null {
  const section = pendingFocusSection
  pendingFocusSection = null
  return section
}

export function showSettingsWindow(focusSection?: SettingsSectionFocus): void {
  pendingFocusSection = focusSection ?? null
  showMightyWindow(false, undefined, undefined, false, undefined, undefined, true)
}

export function sendToSettingsRenderer(channel: string, ...args: unknown[]): void {
  const win = getMightyWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}
