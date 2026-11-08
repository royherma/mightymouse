import { CONFIG } from '../../shared/config'
import { relayRequestStore, type RelayRequest } from './store'
import { listedAgentSessions } from './mcp/http-listener'
import type { RelayRequestWire, RelaySnapshotWire } from '../../shared/phone-remote-protocol'

/** keepImagePath: the Mac renders that filesystem path through media://, the
 *  phone can't and fetches the picture over /relay-image instead. */
export function toRelayWire(r: RelayRequest, keepImagePath = false): RelayRequestWire {
  const { imagePath, capture: _capture, ...rest } = r.params
  // hasImage goes to BOTH surfaces; the path only to the Mac. The phone fetches
  // the bytes over /relay-image by requestId, so a path would tell it nothing.
  const withFlag = imagePath ? { ...rest, hasImage: true } : rest
  const withImage = keepImagePath && imagePath ? { ...withFlag, imagePath } : withFlag
  // A multi-question card has to know whether the Mac can READ the terminal it
  // came from -- that decides whether it may collect every answer or hands back
  // after Q1. The derived boolean crosses, never the pane id.
  const paramsWire = r.params.questions?.length
    ? {
        ...withImage,
        buffered: r.buffered.length ? r.buffered : undefined,
        canReadPane: Boolean(r.params.origin?.tmuxPane)
      }
    : withImage
  const { reason: _reason, ...responseWire } = r.response ?? {}
  return {
    id: r.id,
    verb: r.verb,
    params: paramsWire,
    createdAt: r.createdAt,
    timeoutMs: r.timeoutMs,
    status: r.status,
    response: r.response ? responseWire : null,
    // The store has always held both; they were simply never sent, which left a
    // Previous card able to date itself only by when it was ASKED.
    resolvedAt: r.resolvedAt,
    resolvedVia: r.resolvedVia,
    // Only meaningful on a dismissed card, and only true while the agent has
    // not been told yet. Sent rather than derived from `resolvedAt` so the
    // surfaces never have to re-implement the window and drift from the store.
    undoable: relayRequestStore.undoPending(r.id) || undefined,
    sessionLabel: paneSessionLabel(r)
  }
}

function paneSessionLabel(r: RelayRequest): string | undefined {
  const origin = r.params.origin
  if (!origin?.tmuxPane) return undefined
  return listedAgentSessions().find(
    (s) =>
      s.origin?.tmuxPane === origin.tmuxPane &&
      (!origin.tmuxSocket || s.origin?.tmuxSocket === origin.tmuxSocket)
  )?.label
}

/** Full pending list + a short resolved tail. notify never appears as PENDING --
 *  it resolves the instant it's minted (see store.ts), so nothing is ever
 *  waiting on it. It does appear in the resolved tail, which is what gives a
 *  tapped notify notification a card to open. */
export function relaySnapshot(keepImagePath = false): RelaySnapshotWire {
  return {
    pending: relayRequestStore
      .listPending()
      .filter((r) => r.verb !== 'notify')
      .map((r) => toRelayWire(r, keepImagePath)),
    resolved: relayRequestStore
      .listRecentResolved(CONFIG.PHONE_REMOTE.RELAY_RESOLVED_TAIL)
      .map((r) => toRelayWire(r, keepImagePath)),
    // Its own list rather than a flavour of `resolved`: a card you cleared and
    // one you answered are different things to go looking for, which is the
    // whole reason 'dismissed' is a separate terminal state.
    dismissed: relayRequestStore
      .listDismissed(CONFIG.PHONE_REMOTE.RELAY_RESOLVED_TAIL)
      .map((r) => toRelayWire(r, keepImagePath))
  }
}
