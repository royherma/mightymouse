/** Skip getSession when send() or a prior resolve already claimed this binding. */
export function shouldSkipSessionResolve(
  sessionId: string,
  sessionIdRef: string | null
): boolean {
  return sessionIdRef === sessionId
}

/** Whether an unbound pane should clear local state. False while first-send is in flight
 *  and sessionId prop is still null (parent re-render must not wipe optimistic turns). */
export function shouldWipeUnboundPane(
  sessionId: string | null,
  hasInFlightSend: boolean
): boolean {
  if (sessionId !== null) return false
  return !hasInFlightSend
}
