import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { ChromeApi, ChromeKind } from '../contract'

// The mac-only BrowserWindow chrome each window used to restate inline. Values
// are the exact ones the 22 window files carried before Phase 3.3 — change one
// here and every window follows.
const OPTIONS: Record<ChromeKind, BrowserWindowConstructorOptions> = {
  inset: { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } },
  // deck-window.ts never set trafficLightPosition — kept as its own kind so the
  // collapse stays value-identical.
  'inset-notraffic': { titleBarStyle: 'hiddenInset' },
  panel: { type: 'panel' },
  vibrant: { vibrancy: 'under-window' }
}

export const chrome: ChromeApi = {
  windowOptions: (kind) => OPTIONS[kind],
  showOnAllWorkspaces: (win: BrowserWindow) =>
    // Without skipTransformProcessType Electron calls app.dock.hide() and our Dock icon vanishes.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
}
