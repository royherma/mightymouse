import { useCallback, useEffect, useState } from 'react'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

/** Pairing approval request from the Mac. */
export type ApprovalRequest = {
  id: string
  label: string
  expiresAt: number
}

interface UseApprovalArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
}

/** Owns the pairing-approval prompt and its verdict. */
export function useApproval({ bus, send }: UseApprovalArgs) {
  // A device waiting at the door for this phone to vouch for it. Only ever set
  // on the controller -- the Mac sends the request nowhere else.
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null)

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('approvalRequest', (msg) => {
        setApprovalRequest({ id: msg.id, label: msg.label, expiresAt: msg.expiresAt })
      }),
      bus.subscribe('approvalResolved', (msg) => {
        // Scoped by id: the waiting device giving up must not clear a prompt
        // for whoever arrived after it.
        setApprovalRequest((cur) => (cur && cur.id === msg.id ? null : cur))
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus])

  const answerApproval = useCallback(
    (allow: boolean) => {
      if (!approvalRequest) return
      send({ type: 'approvalVerdict', id: approvalRequest.id, allow })
      // Cleared locally rather than waiting for the Mac's `approvalResolved`:
      // the tap must feel answered even if the echo is slow, and a stale prompt
      // is the one thing that could get a second device waved in by accident.
      setApprovalRequest(null)
    },
    [approvalRequest, send]
  )

  return { approvalRequest, answerApproval }
}
