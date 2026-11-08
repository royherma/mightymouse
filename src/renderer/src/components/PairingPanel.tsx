import { useState, type JSX } from 'react'
import type { PhoneRemoteTunnelStatus } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { PairCodeRow } from './PairCodeRow'
import { PairQr, PAIR_QR_SIZE, type PairQrSize } from './PairQr'
import { ProgressBar } from './ProgressBar'
import { Spinner } from './Spinner'
import { Switch } from './Switch'
import { TUNNEL_SETUP_STEPS, type PairingView } from '../../../shared/phone-remote-pairing'
import { Button } from './Button'

/**
 * The pairing surface — the QR, the away-from-home switch, the recovery code.
 *
 * SettingsApp's card and PhoneRemoteQrApp's window used to build this
 * independently, so a fix in one never reached the other; that is how two
 * different QR codes once ended up on screen at once. `derivePairing()`
 * unified the state, this unifies the markup. Everything the two surfaces
 * genuinely disagree on is a prop — a third copy is never the answer.
 *
 * There is no mode picker. A user's first action here is to SCAN, never to
 * answer a question about network topology: `derivePairing` hands back one QR
 * that silently upgrades from the LAN address to the tunnel's once it is up.
 */

const CERT_NOTE =
  "Safari may warn the connection isn't private. That's expected, because your Mac signs " +
  'its own certificate. Tap Show Details → visit this website to continue; this is what lets ' +
  'voice commands use the microphone.'

/** Hover-or-click "i" that parks a long aside out of the layout until asked for.
 *  Not the <Tooltip> primitive: that needs a per-window root this panel's two
 *  hosts don't have, and it hides on mouse-out — no good for copy you follow
 *  step by step on your phone. */
function InfoDot({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex">
      <Button
        variant="bare"
        aria-label="Why does Safari warn me?"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[10px] font-semibold leading-none cursor-help"
        style={{
          background: 'rgba(var(--accent-rgb), 0.10)',
          color: 'var(--text-muted-medium)',
          border: '1px solid rgba(var(--accent-rgb), 0.20)'
        }}
      >
        i
      </Button>
      {open && (
        <span
          role="tooltip"
          // Centred on the dot and pinned above it, so it never pushes the QR
          // around when it opens.
          className="absolute z-50 rounded-lg font-normal text-left pointer-events-none"
          style={{
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 260,
            fontSize: '11px',
            lineHeight: 1.35,
            padding: '6px 9px',
            background: 'rgba(var(--accent-rgb), 0.08)',
            color: 'var(--text-muted-medium)',
            border: '1px solid rgba(var(--accent-rgb), 0.18)',
            boxShadow: '0 4px 14px rgba(var(--shadow-rgb), 0.10)',
            backdropFilter: 'blur(14px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(14px) saturate(1.4)'
          }}
        >
          {text}
        </span>
      )}
    </span>
  )
}

export interface PairingPanelProps {
  pairing: PairingView
  tunnelEnabled: boolean
  tunnelStatus: PhoneRemoteTunnelStatus
  onTunnelToggle: (on: boolean) => void
  /** Full off→on. REQUIRED, not derived from onTunnelToggle: a bare re-enable
   *  hits startTunnel()'s idempotent early-return, so a tunnel stuck in
   *  'starting' ignores it and Retry does visibly nothing. */
  onTunnelRetry: () => void
  /** LAN QR fetch failure, rendered inside the QR box with its own retry. */
  lanError?: string | null
  onLanRetry?: () => void
  /** Settings renders small QRs in a dense card; the standalone window is roomier. */
  qrSize?: PairQrSize
  /** Settings' card copy runs one step smaller than the standalone window's. */
  dense?: boolean
  /** Settings-only: the cert warning a first LAN scan will hit. The standalone
   *  window is opened from the Panel by users already past that step. */
  showCertNote?: boolean
  /** Where the upgrade CTA goes. REQUIRED: an optional one silently deleted the
   *  button on the QR window, which is how the prompt shipped buttonless. Any
   *  new surface must answer this rather than inherit a hole. */
  onUpgrade: () => void
}

export function PairingPanel(props: PairingPanelProps): JSX.Element {
  const {
    pairing,
    tunnelEnabled,
    tunnelStatus,
    onTunnelToggle,
    onTunnelRetry,
    lanError = null,
    onLanRetry,
    qrSize = PAIR_QR_SIZE.md,
    dense = false,
    showCertNote = false,
    onUpgrade
  } = props

  const bodyCls = dense ? 'text-muted text-xs' : 'text-sm font-medium'
  const noteCls = 'text-muted text-xs text-center max-w-[280px]'
  // Setup progress comes from the shared derivation, never from a second read of
  // tunnelStatus here — that split is how this panel printed "isn't running"
  // directly under a badge saying "Setting up off-Wi-Fi access…".
  const setup = pairing.setup

  // ONE source for "the remote block offers a Retry". The copy naming the button
  // and the button itself both read this, so a state can never print "Tap Retry"
  // with nothing to tap — which is exactly what shipped.
  const retryable = !setup && tunnelStatus.state !== 'up' && !pairing.refusal && pairing.canRetry

  // Flipping the switch off tears the tunnel down; flipping it on has to reach
  // startTunnel() even when the PREF already says on, because the pref is
  // durable while the process is not — a dead tunnel under an on pref is how
  // "Anywhere" once landed on nothing that was ever going to restart.
  const toggleTunnel = (next: boolean): void => {
    if (next !== tunnelEnabled) {
      onTunnelToggle(next)
      return
    }
    if (next && tunnelStatus.state !== 'up' && !setup) onTunnelRetry()
  }

  return (
    <>
      <div className="flex flex-col items-center">
        {/* No URL text by design — the QR is the only pairing surface, so
            there's nothing to read aloud or screenshot. */}
        <PairQr
          qrDataUrl={pairing.showQr ? pairing.qrDataUrl : null}
          size={qrSize}
          error={lanError}
          onRetry={onLanRetry}
        />
        <div className={`${dense ? 'text-muted text-sm' : 'text-sm font-medium'} mt-2`}>
          {CONFIG.UI_LABELS.TOUR_PHONE_SCAN}
        </div>
        {showCertNote && (
          <div className={`${noteCls} mt-1 flex items-center justify-center gap-1.5`}>
            <span>Fastest and most private - both on the same Wi-Fi.</span>
            {/* The cert warning is 3 sentences nobody needs until Safari actually
                shows it, so it hides behind the "i" rather than crowding the QR. */}
            <InfoDot text={CERT_NOTE} />
          </div>
        )}

        {/* The one control on this screen, and it is optional: the QR above
            already works. Deliberately BELOW the code so nothing stands between
            a new user and the scan. */}
        <label className="flex items-center gap-2 cursor-pointer mt-3">
          <Switch on={tunnelEnabled} onChange={toggleTunnel} />
          <span className="text-muted text-xs">{CONFIG.UI_LABELS.TOUR_PHONE_TUNNEL_TOGGLE}</span>
        </label>
      </div>

      {/* Home Screen app recovery — an installed PWA strands the same way
          whichever address it was added from. Scanning the QR only ever reaches
          Safari; this code is the one path into the installed app's own storage
          partition. */}
      <PairCodeRow divided={pairing.showQr} />

      {/* Off-Wi-Fi STATUS, not a mode. It only has anything to say once the
          switch above is on, and never gates the QR. */}
      {tunnelEnabled && (setup || pairing.errorText || pairing.refusal || retryable) && (
        <div
          // mt-3 so the panel clears PairCodeRow's buttons above it.
          className="rounded-lg p-4 mt-3"
          style={{
            background: 'var(--violet-bg-subtle)',
            border: '1px solid var(--violet-border-subtle)'
          }}
        >
          <div className={bodyCls}>
            {setup
              ? setup.note
              : pairing.refusal
                ? // The refusal block below carries the whole message. Telling
                  // them to retry a cap would just spend a round-trip to be
                  // refused again.
                  pairing.refusal.headline
                : // Failed/stalled. errorText names the cause right below, so
                  // this line says what to do. It names the button ONLY when
                  // the button renders — see the canRetry block below.
                  retryable
                  ? 'Tap Retry to set up off-Wi-Fi access again.'
                  : 'Off-Wi-Fi access is not set up right now.'}
          </div>

          {/* The wait made legible: three countable beats, the one in flight
              lit. A single frozen "Setting up…" is what read as hung. */}
          {setup && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <Spinner size="w-3.5 h-3.5" accent="border-t-violet" />
                <ProgressBar
                  pct={setup.pct}
                  segments={TUNNEL_SETUP_STEPS}
                  activeSegment={setup.step}
                  color="var(--violet)"
                  height="h-1.5"
                />
                <div className="text-muted text-xs tabular-nums whitespace-nowrap">
                  {setup.step}/{TUNNEL_SETUP_STEPS}
                </div>
              </div>
              <div className="text-muted text-xs mt-1.5">
                This takes a few seconds the first time.
              </div>
            </div>
          )}

          {pairing.errorText && (
            <div className="text-red-400 text-xs mt-1">{pairing.errorText}</div>
          )}

          {/* Re-arming the tunnel IS the retry: derivePairing only sets canRetry
              for a genuine failure, never for a cap. Both surfaces get this from
              the toggle they already pass, so neither needs a new prop. */}
          {retryable && (
            <Button
              variant="secondary"
              onClick={onTunnelRetry}
              className="mt-2"
            >
              Retry
            </Button>
          )}

          {/* Hitting the cap is the one moment the value of paying is concrete,
              so it reads as the plan's limit — not a red failure. Copy comes from
              refusalCopy(); this renders it and never maps a code itself. */}
          {pairing.refusal && (
            <div className="mt-2">
              {pairing.refusal.detail && (
                <div className="text-muted text-xs">{pairing.refusal.detail}</div>
              )}
              {pairing.refusal.cta && onUpgrade && (
                <Button
                  variant="secondary"
                  onClick={onUpgrade}
                  className="mt-2"
                >
                  {pairing.refusal.cta}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
