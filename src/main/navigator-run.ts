import { ipcMain } from 'electron'
import { CHANNELS } from '../shared/ipc'
import { hideNavigatorWindow } from './navigator-window'
import { navigatorCaptureAction } from './capture'
import { showAnalyticsWindow } from './analytics-window'
import { showCheatSheetWindow } from './cheatsheet-window'
import { showActionsWindow } from './actions-window'
import { showBugReportWindow } from './bug-report-window'
import { showDeckWindow } from './deck-window'
import { showCanvasWindow } from './canvas-window'
import { showBillingWindow } from './billing-window'
import { showSettingsWindow } from './settings-window'
import { SETTINGS_SECTION } from '../shared/types'
import { showMediaLibraryWindow } from './media-library-window'
import { showPhoneRemoteQrWindow } from './phone-remote-qr-window'
import { route } from './routing'
import { showAgentInCodeTab, showMightyWindow } from './mighty/mighty-window'
import { isCurrentUserAdmin } from './auth'
import { ADMIN_SCREEN_IDS, type NavigatorSearchRef } from '../shared/navigator-targets'
import { searchConversations } from './navigator-search'

// The actions that live in index.ts next to the hotkey handlers. Passed in
// rather than imported so there is still exactly ONE definition of each.
export interface NavigatorActions {
  onMain: () => void
  onSuggest: () => void
  onStop: () => void
  onToggleSelectionBar: () => void
}

const SCREENS: Record<string, () => void> = {
  newChat: () => showMightyWindow(true),
  agents: () => showMightyWindow(false, undefined, undefined, true, 'agents'),
  code: () => showMightyWindow(false, undefined, undefined, true, 'agents'),
  newCodeSession: () => showAgentInCodeTab({ newIn: null }),
  connectCodingTool: () => showSettingsWindow(SETTINGS_SECTION.agentRelay),
  settings: () => showSettingsWindow(),
  phone: () => showPhoneRemoteQrWindow(),
  library: () => showMediaLibraryWindow(),
  analytics: () => showAnalyticsWindow(),
  cheatsheet: () => showCheatSheetWindow(),
  actions: () => showActionsWindow(),
  deck: () => showDeckWindow(),
  canvas: () => showCanvasWindow(),
  billing: () => showBillingWindow(),
  bug: () => showBugReportWindow(),
  tutorial: () => route('tour', { tourSource: 'navigator' })
}

function runShortcut(id: string, a: NavigatorActions): void {
  if (id === 'listen' || id === 'listenSend' || id === 'capture') {
    navigatorCaptureAction(id)
    return
  }
  if (id === 'main' || id === 'rewrite') a.onMain()
  else if (id === 'chat') showMightyWindow()
  else if (id === 'suggest') a.onSuggest()
  else if (id === 'selectionBar') a.onToggleSelectionBar()
  else if (id === 'stop') a.onStop()
}

export function registerNavigatorIpc(actions: NavigatorActions): void {
  ipcMain.removeHandler(CHANNELS.navigatorClose)
  ipcMain.removeHandler(CHANNELS.navigatorRun)
  ipcMain.removeHandler(CHANNELS.navigatorSearch)
  ipcMain.handle(CHANNELS.navigatorClose, () => hideNavigatorWindow())
  ipcMain.handle(CHANNELS.navigatorSearch, (_e, query: string, refs: NavigatorSearchRef[]) =>
    searchConversations(query, refs)
  )

  ipcMain.handle(CHANNELS.navigatorRun, async (_e, targetId: string) => {
    // Hide FIRST: every action below either wants the user's real front app back
    // (listen, capture, the panel's selection grab) or opens a window that would
    // otherwise sit behind this always-on-top overlay.
    hideNavigatorWindow()

    const sep = targetId.indexOf(':')
    const kind = targetId.slice(0, sep)
    const id = targetId.slice(sep + 1)

    if (kind === 'shortcut') runShortcut(id, actions)
    else if (kind === 'screen') {
      if (ADMIN_SCREEN_IDS.has(id) && !(await isCurrentUserAdmin())) return
      SCREENS[id]?.()
    }
    else if (kind === 'project') showMightyWindow(true, undefined, undefined, false, undefined, id)
    else if (kind === 'codeProject') showAgentInCodeTab({ newIn: id })
    else if (kind === 'chat') showMightyWindow(false, id)
    else if (kind === 'session') showAgentInCodeTab({ ref: id })
  })
}
