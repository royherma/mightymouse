import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readCachedReferral, writeCachedReferral, clearCachedReferral } from '../referral-cache'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

interface UseReferralArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
}

/** Owns referral link/code/count, invite send, and the sheet open flag. */
export function useReferral({ bus, send }: UseReferralArgs) {
  const cachedReferral = useMemo(() => readCachedReferral(Date.now()), [])
  const [referralOpen, setReferralOpen] = useState(false)
  const [referralLink, setReferralLink] = useState<string | null>(cachedReferral?.link ?? null)
  const [referralCode, setReferralCode] = useState<string | null>(cachedReferral?.code ?? null)
  const [referredCount, setReferredCount] = useState(cachedReferral?.referredCount ?? 0)
  const [referralError, setReferralError] = useState<string | null>(null)
  const referralLinkRef = useRef<string | null>(referralLink)
  referralLinkRef.current = referralLink
  const [inviteState, setInviteState] = useState<string | null>(null)
  // Clears the terminal 'sent'/error note after a beat. Held in a ref so a
  // second send cancels the first's pending clear -- otherwise the older timer
  // wipes the newer result mid-read.
  const inviteClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inviteSendingRef = useRef(false)

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('referralCode', (msg) => {
        // Error and success are mutually exclusive: clearing the other side
        // means a retry that succeeds doesn't leave the old error rendered
        // underneath a freshly-loaded QR.
        if (msg.error) {
          if (msg.error === 'signed_out') {
            clearCachedReferral()
            setReferralError(msg.error)
            setReferralLink(null)
            setReferralCode(null)
            setReferredCount(0)
          } else if (!referralLinkRef.current) {
            setReferralError(msg.error)
          }
        } else {
          setReferralError(null)
          setReferralLink(msg.link ?? null)
          setReferralCode(msg.code ?? null)
          setReferredCount(msg.referredCount ?? 0)
          // Remember it for the NEXT page load. Written on arrival rather than
          // on unload: iOS Safari kills a backgrounded tab without firing
          // anything reliable.
          writeCachedReferral(msg, Date.now())
        }
      }),
      bus.subscribe('inviteResult', (msg) => {
        // Terminal either way -- the Mac always answers, so this can never be
        // left on 'sending'. A skipped send (already a member, unsubscribed)
        // arrives as ok:true on purpose; see the Edge function.
        inviteSendingRef.current = false
        setInviteState(msg.ok ? 'sent' : (msg.error ?? 'send_failed'))
        if (inviteClearRef.current) clearTimeout(inviteClearRef.current)
        inviteClearRef.current = setTimeout(() => setInviteState(null), 4000)
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus])

  const onToggleReferral = useCallback(() => {
    setReferralOpen((open) => {
      const next = !open
      if (next) send({ type: 'getReferralCode' })
      return next
    })
  }, [send])

  const onCloseReferral = useCallback(() => setReferralOpen(false), [])

  const onRetryReferral = useCallback(() => send({ type: 'getReferralCode' }), [send])

  const onSendInvite = useCallback(
    (email: string) => {
      if (inviteSendingRef.current) return
      inviteSendingRef.current = true
      if (inviteClearRef.current) clearTimeout(inviteClearRef.current)
      setInviteState('sending')
      send({ type: 'sendInvite', email })
    },
    [send]
  )

  return {
    referralOpen,
    referralLink,
    referralCode,
    referredCount,
    referralError,
    inviteState,
    onToggleReferral,
    onCloseReferral,
    onRetryReferral,
    onSendInvite
  }
}
