/**
 * Pairing-code row for the Phone Remote settings card.
 *
 * The QR's `?t=` token can't reach an installed Home Screen app (own storage
 * partition, launches at start_url with no query string), so the credential
 * travels the other way: the phone asks for a code and exchanges it same-origin.
 *
 * Stays collapsed by default -- DESIGN.md's one-pairing-surface rule. This is a
 * recovery path, not a second way to pair alongside the QR.
 */

import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { CONFIG } from '../../../shared/config'
import { formatCountdown } from '../../../shared/phone-remote-pairing'
import { Button } from './Button'
import { PairedDeviceList } from './PairedDeviceList'

/** `divided` -- pass false when nothing rendered above (QR hidden); a rule there separates nothing. */
export function PairCodeRow({ divided = true }: { divided?: boolean }): JSX.Element {
  const [code, setCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Bumped after a revoke-all so PairedDeviceList remounts and re-fetches --
  // it owns its own list, and nothing else pushes device changes at it.
  const [devicesEpoch, setDevicesEpoch] = useState(0)

  const showCode = useCallback(async (rotate = false): Promise<void> => {
    setBusy(true)
    const res = await window.api.phoneRemoteGetPairCode(rotate ? { rotate: true } : undefined)
    setCode(res.code)
    setExpiresAt(res.expiresAt)
    setNow(Date.now())
    setBusy(false)
  }, [])

  // A code is single-use -- handlePair clears it, so re-mint on devices-changed.
  // Read through a ref, not `code`: resubscribing per code would drop the very
  // event that triggers the next re-mint.
  const showingRef = useRef(false)
  showingRef.current = code !== null
  useEffect(() => {
    return window.api.onPhoneRemoteDevicesChanged((p) => {
      // Fresh QRs mean the live code changed (pair or rotate). A revoke omits
      // them so this does not spin the digits under a scan.
      if (showingRef.current && p.qrDataUrl) void showCode()
    })
  }, [showCode])

  // 500ms, not 1000: a 1s tick beating against the deadline visibly skips a
  // second (5:00 -> 4:58).
  useEffect(() => {
    if (expiresAt === null) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [expiresAt])

  // Keyed on expiresAt so a 0:00 tick does not loop; Hide clears it and cancels.
  useEffect(() => {
    if (expiresAt === null) return
    const delay = Math.max(0, expiresAt - Date.now())
    const id = setTimeout(() => void showCode(true), delay)
    return () => clearTimeout(id)
  }, [expiresAt, showCode])

  const remainingMs = expiresAt === null ? null : Math.max(0, expiresAt - now)

  return (
    <div className={divided ? 'mt-3 pt-3 border-t border-surface3' : 'mt-3'}>
      {!code ? (
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted text-xs">
            {CONFIG.UI_LABELS.PAIRING_CODE_PROMPT}
          </div>
          <Button
            variant="ghost"
            className="px-2 text-sm shrink-0"
            disabled={busy}
            onClick={() => void showCode()}
          >
            {CONFIG.UI_LABELS.PAIRING_CODE_SHOW}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <div className="text-muted text-xs text-center">
            {CONFIG.UI_LABELS.PAIRING_CODE_ENTER}
          </div>
          <div className="text-3xl font-semibold tracking-[0.3em] tabular-nums mt-2">{code}</div>
          <div className="text-muted text-xs mt-1 tabular-nums">
            {remainingMs === null
              ? CONFIG.UI_LABELS.PAIRING_CODE_EXPIRES
              : remainingMs === 0
                ? CONFIG.UI_LABELS.PAIRING_CODE_EXPIRED
                : `${CONFIG.UI_LABELS.PAIRING_CODE_EXPIRES_IN} ${formatCountdown(remainingMs)}`}
          </div>
          <div className="flex items-center gap-3 mt-3">
            <Button
              variant="ghost"
              className="px-2 text-sm"
              disabled={busy}
              onClick={() => void showCode(true)}
            >
              {CONFIG.UI_LABELS.PAIRING_CODE_NEW}
            </Button>
            {/* Showing the code was a one-way door: nothing else clears `code`,
                so a curious tap left a live credential on screen for good. */}
            <Button
              variant="ghost"
              className="px-2 text-sm"
              onClick={() => {
                setCode(null)
                setExpiresAt(null)
              }}
            >
              {CONFIG.UI_LABELS.PAIRING_CODE_HIDE}
            </Button>
          </div>
        </div>
      )}

      {/* Outside the code branch on purpose: "who can control this Mac" must be
          answerable without minting a pairing code. */}
      <PairedDeviceList key={devicesEpoch} onRevokedAll={() => setDevicesEpoch((n) => n + 1)} />
    </div>
  )
}
