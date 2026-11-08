import { useCallback, useEffect, useState } from 'react'
import type { RelayResponseWire, RelaySnapshotWire } from '../../../shared/phone-remote-protocol'
import type { AgentRelayStatus, McpClientState } from '../../../shared/types'
import type { RelayRefusal } from '../../../shared/relay-cards'

// Snapshot at mount, then live off main's change feed — the same data the
// phone's Code sheet gets, never polled. `enabled` is the Settings toggle: the
// relay is opt-in, so an untoggled surface can never produce a card.

export interface AgentRelayFeed {
  enabled: boolean
  /** False until the first status reply lands. Callers that ACT on `enabled`
   *  being false -- bouncing off the Code tab, say -- must wait for this, or
   *  they fire on the startup gap where "off" and "not asked yet" look alike. */
  known: boolean
  status: AgentRelayStatus
  /** `configured: false` means installed but not connected yet. */
  clients: McpClientState[]
  pending: RelaySnapshotWire['pending']
  resolved: RelaySnapshotWire['resolved']
  /** Cleared without answering. Separate from `resolved` because only these
   *  can carry `undoable`. */
  dismissed: RelaySnapshotWire['dismissed']
  respond: (requestId: string, response: RelayResponseWire) => void
  /** Take a clear back. Only meaningful while the card says `undoable` -- past
   *  that the agent has already been told and there is nothing to call back. */
  undismiss: (requestId: string) => void
  /** Set when the store refused the last answer -- answered elsewhere, or the
   *  agent already gave up. Null the rest of the time. */
  refusal: RelayRefusal | null
  clearRefusal: () => void
}

const OFF: AgentRelayStatus = { enabled: false, running: false }

function keepUnchanged(prev: AgentRelayStatus, next: AgentRelayStatus): AgentRelayStatus {
  const before = new Map((prev.agentSessions ?? []).map((s) => [JSON.stringify(s), s]))
  const agentSessions = next.agentSessions?.map((s) => before.get(JSON.stringify(s)) ?? s)
  const kept =
    agentSessions?.length === prev.agentSessions?.length &&
    agentSessions?.every((s, i) => s === prev.agentSessions?.[i])
  const merged = { ...next, agentSessions: kept ? prev.agentSessions : agentSessions }
  return JSON.stringify({ ...prev, agentSessions: 0 }) === JSON.stringify({ ...next, agentSessions: 0 }) &&
    kept
    ? prev
    : merged
}

export function useAgentRelay(): AgentRelayFeed {
  const [status, setStatus] = useState<AgentRelayStatus>(OFF)
  const [clients, setClients] = useState<McpClientState[]>([])
  const [known, setKnown] = useState(false)
  const [snapshot, setSnapshot] = useState<RelaySnapshotWire>({ pending: [], resolved: [], dismissed: [] })
  const enabled = status.enabled

  useEffect(() => {
    let cancelled = false

    const refreshEnabled = (): void => {
      window.api.agentRelayGetStatus().then((s) => {
        if (cancelled) return
        setStatus((prev) => keepUnchanged(prev, s))
        setKnown(true)
      })
      window.api.agentRelayListClients().then((c) => {
        if (!cancelled) setClients((prev) => (JSON.stringify(prev) === JSON.stringify(c) ? prev : c))
      })
    }
    refreshEnabled()
    window.api.agentRelayGetRequests().then((s) => {
      if (!cancelled) setSnapshot(s)
    })

    const off = window.api.onAgentRelayRequestsChanged((next) => {
      setSnapshot(next)
      setKnown(true)
      // A card can only exist because the relay is running, so its arrival is
      // also the answer to "is it on" — this is what picks up a toggle flipped
      // in Settings while the panel was already open.
      setStatus((prev) => (prev.enabled && prev.running ? prev : { ...prev, enabled: true, running: true }))
    })

    // Sessions push their own status, so the count moves the moment a terminal
    // opens or shuts rather than on the next poll.
    const offStatus = window.api.onAgentRelayStatusChanged((next) => {
      setStatus((prev) => keepUnchanged(prev, next))
      setKnown(true)
    })

    // Settings lives in another window, so a toggle there reaches us only when
    // the panel is next shown. Cheap: one IPC per focus.
    window.addEventListener('focus', refreshEnabled)
    const poll = setInterval(() => {
      if (!document.hidden) refreshEnabled()
    }, 5000)
    return () => {
      cancelled = true
      off()
      offStatus()
      clearInterval(poll)
      window.removeEventListener('focus', refreshEnabled)
    }
  }, [])

  // Set when the store refused an answer. The card vanishing and reappearing
  // with no explanation is the whole reason this exists: the protection has
  // always worked server-side, it was just invisible.
  const [refusal, setRefusal] = useState<RelayRefusal | null>(null)

  const respond = useCallback((requestId: string, response: RelayResponseWire): void => {
    // Drop it locally rather than waiting for the store's echo. The push that
    // follows is authoritative and restores the card if the store refused it
    // (already answered on the phone, or timed out).
    // A multi-question answer (questionIndex set) leaves the request PENDING at
    // the next question, so dropping it here would blank the card until the
    // store's echo put it back -- a flicker on every step of an interview.
    if (response.questionIndex === undefined) {
      setSnapshot((prev) => ({
        ...prev,
        pending: prev.pending.filter((r) => r.id !== requestId)
      }))
    }
    void window.api.agentRelayRespond(requestId, response).then((result) => {
      if (result === 'already-resolved') setRefusal({ requestId, kind: 'already-resolved' })
      else if (result === 'unknown') setRefusal({ requestId, kind: 'unknown' })
    })
  }, [])

  const undismiss = useCallback((requestId: string): void => {
    // No optimistic move here, unlike `respond`: undo puts a card BACK, and
    // showing it in the inbox before the store agreed would let a card the
    // window had already closed on flash into view and vanish again.
    void window.api.agentRelayUndismiss(requestId).then((ok) => {
      if (!ok) setRefusal({ requestId, kind: 'already-resolved' })
    })
  }, [])

  const clearRefusal = useCallback(() => setRefusal(null), [])

  return {
    enabled,
    known,
    status,
    clients,
    pending: snapshot.pending,
    resolved: snapshot.resolved,
    dismissed: snapshot.dismissed,
    respond,
    undismiss,
    refusal,
    clearRefusal
  }
}
