import type { CoordinationMessage } from '../../../shared/coordination'
import { BUSY_MAX_MS } from '../../../shared/relay-status'
import { devLog } from '../../../shared/env'
import {
  addSessionTurnEndedListener,
  getCoordinationService,
  listedAgentSessions,
  liveAgentSessions,
  type AgentSession
} from '../mcp/http-listener'
import { sendPaneText } from '../picker-keys'
import { relayRequestStore } from '../store'
import type { CoordinationStore } from './store'
import type { HandoffDelivery } from './service'

const SETTLE_MS = 1_500
const HARNESSES_WITH_PRESENCE = new Set(['claude'])
const CLOSED_NOTE =
  'Not delivered: the recipient agent is closed, so nothing will read this. Send it to a live agent.'

const typed = new Set<string>()

function wakeText(count: number): string {
  const what = count === 1 ? 'a new handoff' : `${count} new handoffs`
  return `Shared work: another agent sent you ${what}. Read your shared-work inbox, decide whether to take it, and ack it.`
}

function liveRow(harnessSession: string): AgentSession | undefined {
  return liveAgentSessions().find((s) => s.sessionId === harnessSession)
}

function isIdle(session: AgentSession): boolean {
  const busy = session.busySince !== undefined && Date.now() - session.busySince < BUSY_MAX_MS
  if (busy) return false
  // Typed text would land in an open picker as its answer.
  return !relayRequestStore
    .listPending()
    .some((r) => r.params.sessionId === session.sessionId && (r.verb === 'ask' || r.verb === 'approve'))
}

async function wake(session: AgentSession, messages: CoordinationMessage[]): Promise<boolean> {
  const fresh = messages.filter((m) => !typed.has(m.id))
  if (fresh.length === 0) return false
  for (const m of fresh) typed.add(m.id)
  const via = await sendPaneText(session.origin, wakeText(fresh.length), session.facts?.pid)
  if (via === 'skipped') {
    for (const m of fresh) typed.delete(m.id)
    return false
  }
  devLog.log('[coordination] woke recipient', { label: session.label, via, count: fresh.length })
  return true
}

function route(store: CoordinationStore, message: CoordinationMessage): HandoffDelivery {
  const target = store.handoffTarget(message.id)
  if (!target) return 'next-turn'
  const { recipient } = target
  const live = liveRow(recipient.session)
  if (!live) {
    const reconnecting = listedAgentSessions().some((s) => s.sessionId === recipient.session)
    const closed = !reconnecting && recipient.stale && HARNESSES_WITH_PRESENCE.has(recipient.harness)
    return closed ? 'closed' : 'next-turn'
  }
  if (!isIdle(live)) return 'after-turn'
  void wake(live, [message])
  return 'woken'
}

export function deliverHandoff(
  store: CoordinationStore,
  message: CoordinationMessage
): { delivery: HandoffDelivery; message: CoordinationMessage } {
  const delivery = route(store, message)
  if (delivery !== 'closed') return { delivery, message }
  return { delivery, message: store.bounce(message.id, CLOSED_NOTE) ?? message }
}

async function onTurnEnded(harnessSession: string): Promise<void> {
  const service = getCoordinationService()
  if (service.unreadFor(harnessSession).length === 0) return
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  const live = liveRow(harnessSession)
  if (!live || !isIdle(live)) return
  await wake(live, service.unreadFor(harnessSession))
}

export function startHandoffDelivery(): void {
  getCoordinationService().setDelivery(deliverHandoff)
  addSessionTurnEndedListener((sessionId) => {
    void onTurnEnded(sessionId).catch((error: unknown) =>
      devLog.warn('[coordination] wake failed', (error as Error).message)
    )
  })
}
