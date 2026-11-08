import { JSX } from 'react'
import { CONFIG } from '../../../shared/config'
import { TOUR } from '../../../shared/tour/constants'
import { derivePairing } from '../../../shared/phone-remote-pairing'
import { PairQr, PAIR_QR_SIZE } from '../components/PairQr'
import { Switch } from '../components/Switch'
import { shouldUseTunnelQr, type PhonePairConfirmResult } from './usePhonePairConfirm'

// Visual layer for the phone-pairing step. Same contract as HotkeyConfirm:
// pure props-in, all state/timing lives in usePhonePairConfirm.
//
// It renders NOTHING of its own about "is there a QR" — that comes from
// derivePairing(), the one expression that decides badge text and QR-visibility
// together (shared/phone-remote-pairing.ts). Rendering the QR off one condition
// and the badge off another is the exact bug that file exists to kill, and a
// third pairing surface re-deriving it inline would resurrect it here.
//
// The step pairs on the LAN by default and OFFERS off-Wi-Fi as a toggle. It's not
// the default because the tunnel needs a signed-in session to provision (a
// first-run user often has none) and a cold start would spend the whole step
// downloading cloudflared. The toggle is also the consent prefs.ts requires
// before this Mac is reachable past the LAN — see usePhonePairConfirm's header.
export function PhonePairConfirm({ confirm }: { confirm: PhonePairConfirmResult }): JSX.Element {
  const { state, unlocked, qrDataUrl, noLan, tunnelEnabled, tunnelStatus, tunnelQr } = confirm
  const confirmed = state === TOUR.CONFIRM_STATE.confirmed

  // Which code is on screen — see shouldUseTunnelQr for why each condition.
  // Withholding tunnelQr is how the freeze lands now that derivePairing has no
  // mode: with nothing to upgrade to, it keeps painting the LAN code rather
  // than swapping one out from under a camera mid-scan.
  const useTunnel = shouldUseTunnelQr({ tunnelEnabled, tunnelStatus, tunnelQr, confirmed })

  const pairing = derivePairing({
    enabled: !noLan,
    connected: confirmed,
    lanQr: qrDataUrl,
    tunnelEnabled,
    tunnelStatus,
    tunnelQr: useTunnel ? tunnelQr : null
  })

  // No LAN address = a dead end for this step. A retry would fail identically,
  // so point at Settings instead of spinning on a QR that can't exist.
  if (noLan) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="text-sm text-amber text-center">{CONFIG.UI_LABELS.TOUR_PHONE_NO_LAN}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-2">
      {/* lg (256px), not sm. The old 160px was forced by the 480x540 portrait
          card, where the QR shared ~294px of body with the title, blurb, status
          and toggle. In the landscape layout the QR IS the left column's
          subject and has 300px to itself, so it takes the size that's actually
          comfortable to scan — the one thing this step lives or dies on. */}
      <PairQr qrDataUrl={pairing.qrDataUrl} size={PAIR_QR_SIZE.lg} />

      {/* Fixed-height copy slot — no layout shift between scanning/confirmed.
          While the tunnel is mid-flight derivePairing's badge is the honest
          line ("Setting up off-Wi-Fi access…", "…failed"), so it wins over the
          generic scan prompt. */}
      <div className="h-5 flex items-center justify-center" aria-live="polite">
        <span className={confirmed ? 'text-sm text-green' : 'text-sm text-muted'}>
          {confirmed
            ? CONFIG.UI_LABELS.TOUR_PHONE_CONFIRMED
            : tunnelEnabled && !useTunnel
              ? pairing.badge
              : CONFIG.UI_LABELS.TOUR_PHONE_SCAN}
        </span>
      </div>

      {/* The off-Wi-Fi opt-in. A toggle rather than a default because the tunnel
          exposes this Mac past the LAN — prefs.ts keeps that behind a deliberate
          second consent, and onboarding is the worst place to grant it on
          someone's behalf. Hidden once paired: the step is done, and offering to
          change the code they just used would only confuse. */}
      {!confirmed && (
        <label className="flex items-center gap-2 cursor-pointer">
          <Switch on={tunnelEnabled} onChange={confirm.setTunnelEnabled} />
          <span className="text-xs text-muted">{CONFIG.UI_LABELS.TOUR_PHONE_TUNNEL_TOGGLE}</span>
        </label>
      )}

      {unlocked && !confirmed && (
        <div className="text-xs text-muted">{CONFIG.UI_LABELS.TOUR_PHONE_UNLOCKED}</div>
      )}
    </div>
  )
}
