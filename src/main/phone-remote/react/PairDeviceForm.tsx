/**
 * Pairing when the page URL had no `?c=` to spend: type the 6 digits the Mac
 * shows. A lobby scan spends that code before this form mounts. Scan lives
 * on the native lobby, not here -- two pairing methods on one screen is how
 * a finished scan bounced back onto "scan again or type".
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CONFIG } from '@shared/config'
import { exchangePairingCode } from './useHostDiscovery'
import { Button } from '@shared/ui/Button'

/** onPaired reloads, so without this beat a correct code swaps straight to a
 *  white reload -- indistinguishable from a crash. */
const PAIRED_HOLD_MS = 700

interface Props {
  /** Runs after a credential is stored -- the caller reconnects. */
  onPaired: () => void
}

export function PairDeviceForm({ onPaired }: Props): React.JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [paired, setPaired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const length = CONFIG.PHONE_REMOTE.PAIR_CODE_LENGTH
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current)
    }
  }, [])

  const finish = useCallback(
    (result: { ok: true } | { ok: false; error: string }): void => {
      if (result.ok) {
        setPaired(true)
        holdTimer.current = setTimeout(onPaired, PAIRED_HOLD_MS)
        return
      }
      setCode('')
      setError(
        CONFIG.PHONE_REMOTE.PAIR_ERROR_COPY[result.error] ||
          CONFIG.PHONE_REMOTE.PAIR_ERROR_FALLBACK
      )
      setBusy(false)
    },
    [onPaired]
  )

  const trySubmit = useCallback(async (): Promise<void> => {
    if (busy || paired || code.length !== length) return
    setBusy(true)
    setError(null)
    finish(await exchangePairingCode(code))
  }, [busy, paired, code, length, finish])

  // The last digit IS the submit. A submit button is not reachable on every
  // host -- Meta's glasses browser has no pointer and no Enter key.
  useEffect(() => {
    if (code.length === length) void trySubmit()
  }, [code, length, trySubmit])

  function submit(e: FormEvent): void {
    e.preventDefault()
    void trySubmit()
  }

  if (paired) {
    return (
      <div className="pairForm" role="status" aria-live="polite">
        <div className="pairedTick" aria-hidden="true">
          ✓
        </div>
        <div className="pairedTitle">Paired</div>
        <div className="strandedGuardBody">Connecting to your Mac…</div>
      </div>
    )
  }

  return (
    <form className="pairForm" onSubmit={submit}>
      <div className="strandedGuardBody">
        On your Mac, open MightyMouse and click the QR icon at the top. Click Pairing code, then
        type the 6 digits here.
      </div>
      <input
        className="pairInput"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        pattern="[0-9]*"
        maxLength={length}
        placeholder={'0'.repeat(length)}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, length))}
        aria-label="Pairing code"
        disabled={busy}
      />
      {error && <div className="pairError">{error}</div>}
      <Button
        variant="bare"
        className="strandedGuardBtn"
        type="submit"
        disabled={busy || code.length !== length}
      >
        {busy ? 'Connecting…' : 'Connect'}
      </Button>
    </form>
  )
}
