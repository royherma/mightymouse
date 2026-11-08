/**
 * Single fan-out point for CHANNELS.mightyTurnAppended. The Mighty window, the Panel
 * window, and a connected phone may all be bound to the same session (a live ask-mode
 * run started on the panel) — push to whichever is open and let each subscriber decide
 * whether the id matches before refetching. The phone is a subscriber for the same
 * reason the panel is: sessions are shared, so a turn run on the Mac must appear in a
 * thread the phone has open, not only when it is reopened.
 */
import { CHANNELS } from '../../shared/ipc'
import { getMightyWindow } from './mighty-window'
import { getPanelWindow } from '../panel-window'
import { getReplyWindow } from '../reply-window'
import { sendToPhone } from '../phone-remote/server'
import type { MightyTurnAppendedPayload } from '../../shared/types'

export function broadcastMightyTurnAppended(sessionId: string): void {
  const payload: MightyTurnAppendedPayload = { sessionId }
  getMightyWindow()?.webContents.send(CHANNELS.mightyTurnAppended, payload)
  getPanelWindow()?.webContents.send(CHANNELS.mightyTurnAppended, payload)
  getReplyWindow()?.webContents.send(CHANNELS.mightyTurnAppended, payload)
  // No-ops when no phone is connected, so this stays free in the common case.
  sendToPhone({ type: 'chatSessionChanged', sessionId })
}

/**
 * Push a running session's current phase to the phone's thread list.
 *
 * Phone-only on purpose: the Mac's own windows already receive phases through
 * their run's callback, and `chatSessionChanged` (above) fires only at turn
 * boundaries — so without this a row's "Running…" could not change for the
 * length of a run, no matter how many phases went by.
 */
export function broadcastMightyPhase(sessionId: string, phase: string, detail: string): void {
  sendToPhone({ type: 'chatSessionPhase', sessionId, phase, detail })
}
