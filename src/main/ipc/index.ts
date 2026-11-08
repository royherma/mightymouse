import { registerCanvasHandlers } from '../canvas'
import { registerPanelHandlers } from './panel'
import { registerSettingsHandlers } from './settings'
import { registerWindowHandlers } from './windows'
import { registerPhoneRemoteHandlers } from './phone-remote'
import { registerAgentRelayHandlers } from './agent-relay'
import { registerFactoryHandlers } from './factory'
import { registerMediaHandlers } from './media'
import { registerMightyHandlers } from './mighty'
import { registerAnalyticsHandlers } from './analytics'
import { registerAuthBillingHandlers } from './auth-billing'
import { registerKeysHandlers } from './keys'
import { registerInfraHandlers } from './infra'
import { registerReportsHandlers } from './reports'
import { registerBuiltHandlers } from './built'
import { registerFirstRunCodeHandlers } from './first-run-code'
import { registerFirstRunHandlers } from './first-run'
import { registerSystemHandlers } from './system'
import { registerSelectionBarHandlers } from './selection-bar'
import { registerVoiceRoutingHandlers } from './voice-routing'
import { registerActionsIpc } from './actions'
import { registerSpecialistHandlers } from '../specialist'
import { registerResourcesIpc } from './resources'
import { registerMcpConnectionsIpc } from './mcp-connections'
import { registerPulseIpc } from '../agent-relay/session-pulse'
import { registerHideoutIpc } from '../hideout'
import { registerSideBrowserHandlers } from '../side-browser'
import { registerFilesHandlers } from '../files-ipc'
import { registerBrowserTaskHandlers } from '../browser-task/form-fill'
import { HISTORY } from '../store/history'
import { isPanelVisible, sendToPanelRenderer } from '../panel-window'
import { CHANNELS } from '../../shared/ipc'

export { buildPanelInitData } from './panel'
export { runStartupBackendProbe } from './settings'

export function registerIpcHandlers(): void {
  // Every finished run (rewrite/ask/act/listen/recording/screenshot) appends a
  // history row. When the panel is open, push the fresh list so the History flyout
  // refreshes live instead of needing a reopen. Gated on visibility — no point
  // sending to a hidden panel; it reseeds from getInitialData on next open anyway.
  // The renderer's onHistoryData listener already swaps in the rows.
  HISTORY.onAppend(() => {
    if (isPanelVisible()) sendToPanelRenderer(CHANNELS.historyData, HISTORY.readRecent(30))
  })

  registerPanelHandlers()

  registerSettingsHandlers()

  registerWindowHandlers()

  registerCanvasHandlers()

  registerPhoneRemoteHandlers()

  registerAgentRelayHandlers()

  registerFactoryHandlers()

  registerMediaHandlers()

  registerMightyHandlers()

  registerSpecialistHandlers()

  registerAnalyticsHandlers()

  registerAuthBillingHandlers()


  registerKeysHandlers()

  registerInfraHandlers()

  registerReportsHandlers()

  registerBuiltHandlers()

  registerFirstRunCodeHandlers()

  registerFirstRunHandlers()

  registerSystemHandlers()

  registerSelectionBarHandlers()

  registerVoiceRoutingHandlers()

  registerActionsIpc()

  registerPulseIpc()
  registerHideoutIpc()

  registerResourcesIpc()
  registerMcpConnectionsIpc()

  registerSideBrowserHandlers()
  registerFilesHandlers()
  registerBrowserTaskHandlers()
}
