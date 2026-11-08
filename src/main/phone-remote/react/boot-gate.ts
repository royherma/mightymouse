// boot-gate.ts -- does the full-screen "Connecting to your Mac…" cover the deck?
//
// Pure so it's testable under this repo's `environment: 'node'` vitest config,
// same split as useDelayedFlag.ts. The gate is a TAKEOVER: it unmounts the deck,
// so the bar is "nothing to show yet", not "the socket is down".

export interface BootGateInputs {
  connected: boolean
  /** Reached `connected` at least once THIS load. */
  everConnected: boolean
  /** A stored device credential -- connected before on some earlier load, and
   *  still paired. */
  returning: boolean
  /** A screen-only host (the glasses). */
  cursorless: boolean
  /** The native shell is still holding its own LaunchView over this page. */
  nativeCoverHoldsThisWait: boolean
}

/**
 * True while the boot gate should cover the deck.
 *
 * `everConnected` covers drops within ONE load; `returning` is the same fact
 * across loads, so a PWA relaunch keeps its deck instead of reading as a
 * first-ever connect. Either one means ReconnectBanner over a live deck.
 *
 * `cursorless` forces the gate back ON: a frozen mirror with a banner the user
 * can't act on is worse than the gate, and only the gate's reconnect re-runs
 * `askMirror`.
 */
export function showBootGate(inputs: BootGateInputs): boolean {
  const { connected, everConnected, returning, cursorless, nativeCoverHoldsThisWait } = inputs
  if (connected) return false
  if (nativeCoverHoldsThisWait) return false
  if (cursorless) return true
  return !everConnected && !returning
}
