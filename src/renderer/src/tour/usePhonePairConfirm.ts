import { useCallback, useEffect, useRef, useState } from 'react'
import { CONFIG } from '../../../shared/config'
import { TOUR } from '../../../shared/tour/constants'
import type { HotkeyConfirmState, TourProbeEventPayload } from '../../../shared/tour/types'
import type { PhoneRemoteTunnelStatus } from '../../../shared/types'
import { useTourAnalytics } from './useTourAnalytics'
import { startSession } from './confirmSession'

/** The shape phoneRemoteSetEnabled / phoneRemoteGetQr answer with. */
export interface PhoneArmResponse {
  ok: boolean
  qrDataUrl?: string
  /** A phone is connected AT THIS MOMENT (not a transition — see the main-side
   *  isPhoneConnected() note). */
  connected?: boolean
}

/** What arming the phone step should do with the server's answer. */
export interface PhoneArmOutcome {
  /** The code to show, or null when there isn't one. */
  qrDataUrl: string | null
  /** Dead end — no LAN address, so no QR can ever exist for this step. */
  noLan: boolean
  /** Replay a `hit` into the session because a phone is ALREADY connected. */
  alreadyConnected: boolean
}

/**
 * Pure: server answer → what the step should do. Split out of the hook so it's
 * testable — the hook itself can't be mounted in this repo's vitest config
 * (node environment, no jsdom; see hotkeyConfirmMachine.ts's header).
 *
 * The `alreadyConnected` case is the one that isn't obvious: the server only
 * BROADCASTS connect/disconnect transitions, so a returning user whose phone is
 * already live produces no event at all and the step would wait out its whole
 * window for something that fired minutes ago.
 */
export function phoneArmOutcome(r: PhoneArmResponse): PhoneArmOutcome {
  if (!r.ok) return { qrDataUrl: null, noLan: true, alreadyConnected: false }
  return {
    qrDataUrl: r.qrDataUrl ?? null,
    noLan: false,
    alreadyConnected: r.connected === true
  }
}

/**
 * Should the step show the off-Wi-Fi code instead of the LAN one?
 *
 * Pure, and split out for the same reason as phoneArmOutcome: the component
 * can't be mounted in this repo's vitest config. Three conditions, each guarding
 * a real failure:
 *   - `up` + a code exists → asking for off-Wi-Fi must never blank the step
 *     while cloudflared downloads and provisions; the LAN code holds the fort.
 *   - not yet `confirmed` → once a phone has connected, the code FREEZES.
 *     Swapping the QR out from under a camera mid-scan is worse than showing
 *     the narrower code.
 */
export function shouldUseTunnelQr(input: {
  tunnelEnabled: boolean
  tunnelStatus: PhoneRemoteTunnelStatus
  tunnelQr: string | null
  confirmed: boolean
}): boolean {
  const { tunnelEnabled, tunnelStatus, tunnelQr, confirmed } = input
  return tunnelEnabled && !confirmed && tunnelStatus.state === 'up' && tunnelQr !== null
}

/** What the phone step needs to render, beyond the shared confirm state. */
export interface PhonePairConfirmResult {
  /** Same contract as useHotkeyConfirm so TourApp's nav gate reads ONE shape. */
  state: HotkeyConfirmState
  unlocked: boolean
  /** The LAN code — always available, no sign-in, no wait. */
  qrDataUrl: string | null
  /** Set when there's no LAN address to pair on — a dead end for this step, so
   *  the UI stops waiting and points at Settings instead of spinning forever. */
  noLan: boolean
  /** Off-Wi-Fi (tunnel) opted into from this step. */
  tunnelEnabled: boolean
  tunnelStatus: PhoneRemoteTunnelStatus
  /** The tunnel code, once it's up. */
  tunnelQr: string | null
  /** Flip off-Wi-Fi access on/off. THIS is the consent: the tunnel exposes the
   *  Mac past the LAN, which prefs.ts deliberately keeps behind a second opt-in,
   *  so the tour offers it as a choice rather than turning it on for them. */
  setTunnelEnabled: (on: boolean) => void
}

/**
 * Press-to-confirm for the phone-pairing step — the SAME session shell the
 * hotkey steps use (confirmSession.ts), with a phone-shaped set of deps:
 *
 *   arm      = start the phone-remote server + fetch its QR
 *   hit      = the server reported a phone connected
 *   unlockMs = TOUR_PHONE_UNLOCK_MS (scanning takes ~3x a keypress)
 *
 * That reuse is deliberate: the timer/latch/teardown/focus-gated-advance logic
 * is identical for both, and cloning it would be ~90 LOC of duplicated
 * correctness (see the PRD's reuse audit). Nothing here re-implements it.
 *
 * The server is started, never stopped, on unmount. Stopping it would kill a
 * phone the user JUST paired — the whole point of the step. The toggle in
 * Settings remains the way to turn it off.
 *
 * Off-Wi-Fi access (the Cloudflare tunnel) is offered here as a toggle, not
 * turned on for them. Three reasons it can't just be the default:
 *   1. It exposes the Mac beyond the LAN, which prefs.ts guards behind a
 *      deliberate second opt-in ("never silently exposes it beyond the LAN").
 *   2. provision() requires a signed-in session — a first-run user often has
 *      none, so a tunnel-only step would hard-fail for exactly the people the
 *      tour exists to serve.
 *   3. Cold start means downloading cloudflared + provisioning before any code
 *      can render, which would spend the whole step on a spinner.
 * So the LAN code shows instantly and the tunnel upgrades it if they ask.
 */
export function usePhonePairConfirm(
  enabled: boolean,
  onConfirmed: () => void
): PhonePairConfirmResult {
  const [state, setState] = useState<HotkeyConfirmState>(TOUR.CONFIRM_STATE.idle)
  const [unlocked, setUnlocked] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [noLan, setNoLan] = useState(false)
  const [tunnelEnabled, setTunnelEnabledState] = useState(false)
  const [tunnelStatus, setTunnelStatus] = useState<PhoneRemoteTunnelStatus>({ state: 'stopped' })
  const [tunnelQr, setTunnelQr] = useState<string | null>(null)
  const analytics = useTourAnalytics()

  const onConfirmedRef = useRef(onConfirmed)
  onConfirmedRef.current = onConfirmed

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    // The step's own subscription to the server's connected broadcast, adapted
    // to the session's `hit` payload. Held here so cleanup can drop it even if
    // the session never armed.
    let offStatus: (() => void) | null = null
    // Set once subscribe() runs, so arm() can replay an already-connected phone
    // into the session. arm() fires first, but its answer is async, so by the
    // time the response lands this is always wired.
    let emit: ((payload: TourProbeEventPayload) => void) | null = null

    const session = startSession('phone', {
      arm: () => {
        // Turning the server on IS the arm. Auto-enabled rather than asked
        // (DESIGN.md rule 5: every extra tap costs completion) — it's a local
        // LAN server and Settings can turn it back off.
        void window.api.phoneRemoteSetEnabled(true).then((r) => {
          if (cancelled) return
          const outcome = phoneArmOutcome(r)
          setQrDataUrl(outcome.qrDataUrl)
          if (outcome.noLan) {
            // No Wi-Fi address to pair on: a retry would fail identically, so
            // don't offer one. The UI unlocks Next immediately instead.
            setNoLan(true)
            setUnlocked(true)
          }
          // Returning user whose phone is ALREADY on — replay the connect the
          // step never got to hear, so it opens pre-confirmed instead of asking
          // them to re-pair a phone that's sitting right there.
          if (outcome.alreadyConnected) emit?.({ kind: 'hit' })
        })
      },
      // Deliberately does NOT stop the server: the user may have just paired.
      disarm: () => {
        offStatus?.()
        offStatus = null
      },
      subscribe: (cb) => {
        emit = cb
        offStatus = window.api.onPhoneRemoteStatus((s) => {
          // Only a CONNECT confirms. A later disconnect must not un-confirm a
          // finished step — the machine latches `confirmed` anyway, but not
          // forwarding it keeps the intent explicit.
          if (s.connected) cb({ kind: 'hit' })
        })
        return () => {
          emit = null
          offStatus?.()
          offStatus = null
        }
      },
      unlockMs: CONFIG.TOUR_PHONE_UNLOCK_MS,
      // The plain pause, not the longer demo one: this step has no live demo to
      // play after the confirm, just a ✓ to register before the card slides on.
      advanceMs: CONFIG.TOUR_ADVANCE_MS,
      hasFocus: () => document.hasFocus(),
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      addFocusListener: (cb) => {
        window.addEventListener('focus', cb)
        return () => window.removeEventListener('focus', cb)
      },
      analytics: {
        confirmed: analytics.phonePaired,
        timedOut: analytics.phonePairTimedOut
      },
      onConfirmed: () => onConfirmedRef.current(),
      onStateChange: (m) => {
        setState(m.state)
        setUnlocked(m.unlocked)
      }
    })

    return () => {
      cancelled = true
      session.cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // Tunnel state: read what's already there, then follow the live transitions.
  // A user who turned off-Wi-Fi access on previously gets it here for free —
  // already provisioned, already warm, no toggle to find, no second consent to
  // give (they gave it once and it stuck).
  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    void window.api.phoneRemoteGetTunnel().then((t) => {
      if (cancelled) return
      setTunnelEnabledState(t.enabled)
      setTunnelStatus(t.status)
      setTunnelQr(t.qrDataUrl ?? null)
    })

    const off = window.api.onPhoneRemoteTunnelStatus((s) => {
      setTunnelStatus(s)
      // The code only exists once the tunnel is actually up — ask for it then,
      // rather than rendering a hostname that isn't serving yet.
      if (s.state === 'up') {
        void window.api.phoneRemoteGetTunnel().then((t) => {
          if (!cancelled) setTunnelQr(t.qrDataUrl ?? null)
        })
      }
    })

    return () => {
      cancelled = true
      off()
    }
  }, [enabled])

  const setTunnelEnabled = useCallback((on: boolean): void => {
    // Optimistic: the toggle must feel instant even though provisioning is a
    // network round trip. A failure arrives as a tunnelStatus 'error', which
    // derivePairing turns into an honest badge — the LAN code stays on screen
    // throughout, so a failed upgrade never costs the user the step.
    setTunnelEnabledState(on)
    if (!on) setTunnelQr(null)
    void window.api.phoneRemoteSetTunnelEnabled(on).then((r) => {
      if (r.ok && r.qrDataUrl) setTunnelQr(r.qrDataUrl)
    })
  }, [])

  return {
    state,
    unlocked,
    qrDataUrl,
    noLan,
    tunnelEnabled,
    tunnelStatus,
    tunnelQr,
    setTunnelEnabled
  }
}
