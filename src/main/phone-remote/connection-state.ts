/**
 * The one connection-state vocabulary (PRD 2026-08-02-1785667000). The Mac
 * server is the only authority on connection state; Swift and the WebView
 * both render what it last said. No client-side inference belongs here or
 * anywhere downstream of it.
 */

/** Five reasons, five actions (PRD §2.2). Not a string the client composed --
 *  always sent by the server, verbatim, over the wire or the bridge. */
export type BlockedReason =
  | 'no-credential'
  | 'credential-revoked'
  | 'mac-unreachable'
  | 'mac-busy'
  | 'rate-limited'

export type ConnState =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'blocked'; reason: BlockedReason }
  /** Socket is open but not yet authorized: the paired phone has been asked to
   *  vouch for this device. A state rather than a flag because it is genuinely
   *  none of the others -- not connected (no credential yet), not blocked (no
   *  action to offer, and it can still succeed on its own). */
  | { kind: 'awaitingApproval'; expiresAt: number }

export type ConnStateKind = ConnState['kind']

/** Every event this machine reacts to. Kept flat and closed so a new one
 *  can't be added without updating `transition`'s switch. */
export type ConnEvent =
  | { type: 'connectAttemptStarted' }
  | { type: 'socketOpened' }
  | { type: 'socketClosed'; reason: BlockedReason | null }
  | { type: 'retry' }
  | { type: 'approvalPending'; expiresAt: number }

/** The legal-transition table. Anything not listed here is a no-op: an event
 *  that doesn't apply to the current state returns the state unchanged
 *  rather than guessing. This is what makes it an actual state machine
 *  instead of a label -- PR #27's `transition()` started with `void state`
 *  and mapped every event to a fixed target regardless of where it fired
 *  from, so nothing ever called it. */
export function transition(state: ConnState, event: ConnEvent): ConnState {
  switch (event.type) {
    case 'connectAttemptStarted':
      // Legal from any state: a fresh attempt (first load, retry button,
      // reconnect after a drop) always moves to connecting.
      return { kind: 'connecting' }

    case 'socketOpened':
      // Only a live attempt can succeed into connected.
      if (state.kind !== 'connecting') return state
      return { kind: 'connected' }

    case 'approvalPending':
      // Only a live attempt can be parked for approval. Arriving in any other
      // state is a stale event from a socket that has already moved on.
      if (state.kind !== 'connecting') return state
      return { kind: 'awaitingApproval', expiresAt: event.expiresAt }

    case 'socketClosed':
      // A close is only meaningful on a live socket -- one arriving while
      // already disconnected/blocked is a stale/duplicate event and must not
      // re-trigger a state change. A denial or timeout closes the parked
      // socket, so awaitingApproval is live for this purpose too.
      if (
        state.kind !== 'connecting' &&
        state.kind !== 'connected' &&
        state.kind !== 'awaitingApproval'
      ) {
        return state
      }
      return event.reason ? { kind: 'blocked', reason: event.reason } : { kind: 'disconnected' }

    case 'retry':
      // The recovery action from a blocked or disconnected state. Not valid
      // mid-connection -- a stray retry while already connecting/connected
      // must not restart a socket that's fine.
      if (state.kind !== 'blocked' && state.kind !== 'disconnected') return state
      return { kind: 'connecting' }

    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

/** What each `blocked` reason means and the one action offered (PRD §2.2
 *  table, verbatim). UI copy is written elsewhere per docs/brand-voice.md --
 *  this map is the semantic contract other pieces test against, not the
 *  final on-screen strings. */
export const BLOCKED_REASON_INFO: Record<
  BlockedReason,
  { summary: string; action: string }
> = {
  'no-credential': { summary: 'never paired, or credential wiped', action: 'Pair this phone' },
  'credential-revoked': { summary: 'Mac revoked this device', action: 'Pair this phone' },
  'mac-unreachable': { summary: 'host not answering on any transport', action: 'Try again' },
  'mac-busy': { summary: 'another phone is in control', action: 'Take control' },
  'rate-limited': { summary: 'too many attempts, cooldown active', action: 'Wait' }
}
