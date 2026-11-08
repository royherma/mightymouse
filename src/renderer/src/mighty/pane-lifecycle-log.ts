import { devLog } from '../../../shared/env'

export type PaneLayoutMode = 'grid' | 'stacked'

export type PaneResolveAction = 'wipe' | 'skip' | 'fetch'

export type PaneSendPhase = 'start' | 'bound' | 'done'

export const paneLifecycleLog = {
  resolve(
    paneId: string,
    action: PaneResolveAction,
    sessionId: string | null,
    inFlight: boolean
  ): void {
    devLog.log('[pane] resolve', { paneId, action, sessionId, inFlight })
  },

  send(paneId: string, phase: PaneSendPhase, sessionId: string | null): void {
    devLog.log('[pane] send', { paneId, phase, sessionId })
  },

  layout(paneCount: number, from: PaneLayoutMode, to: PaneLayoutMode, width: number): void {
    devLog.log('[pane] layout', { paneCount, from, to, width })
  },

  open(
    sessionId: string,
    plan: {
      kind: 'focus' | 'bind' | 'add-pane' | 'add-tab' | 'none'
      tabId?: string
      paneId?: string
    },
    viewMode: 'grid' | 'single' = 'grid'
  ): void {
    devLog.log('[pane] open', { sessionId, viewMode, ...plan })
  }
}
