/**
 * ONE source of truth for "is there actually something to scan right now?".
 *
 * Badge text and the QR-is-visible decision come out of the SAME expression, so
 * they cannot disagree. Every pairing surface calls this and renders what it
 * returns — never re-derive the condition inline.
 */

import type { PhoneRemoteTunnelStatus } from './types'
import { refusalCopy, type RefusalCopy } from './remote-refusal'

export const PAIRING_BADGE = {
  connected: '✓ Phone connected',
  /** Only ever shown when a QR is genuinely on screen. */
  ready: 'Ready to pair - scan the QR',
  noQr: 'Not ready - tap Pair',
  /** Toggle on, tunnel not up, nothing in flight. Deliberately NOT
   *  "Setting up…": no setup is running in this state, so the progress claim
   *  read as a hang that Retry appeared to ignore. */
  tunnelIdle: 'Off-Wi-Fi access is not connected',
  tunnelError: 'Off-Wi-Fi access failed',
  /** Not a failure — the plan's limit. Says so, rather than crying error. */
  tunnelLimit: 'Free plan limit reached'
} as const

export const TUNNEL_SETUP_STEPS = 3

export const TUNNEL_STAGE = {
  downloading: { step: 1, badge: 'Downloading the secure tunnel…', note: 'One-time 17 MB download - only happens once.' },
  provisioning: { step: 2, badge: 'Creating your private address…', note: 'Registering an address only your phone will know.' },
  starting: { step: 3, badge: 'Connecting…', note: 'Almost there - opening the secure link.' }
} as const

export interface PairingInputs {
  /** The phone-remote feature toggle. Everything below is moot when false. */
  enabled: boolean
  connected: boolean
  lanQr: string | null
  tunnelEnabled: boolean
  tunnelStatus: PhoneRemoteTunnelStatus
  tunnelQr: string | null
}

/** Non-null ⟺ the tunnel is mid-setup. The panel renders its bar and note from
 *  THIS, never from its own read of `tunnelStatus`. */
export interface PairingSetup {
  /** 1-based, out of TUNNEL_SETUP_STEPS. */
  step: number
  /** 0-100 across the WHOLE setup, not within the step. */
  pct: number
  note: string
}

export interface PairingView {
  /** True ⟺ a QR image is rendered. The badge is derived from this. */
  showQr: boolean
  qrDataUrl: string | null
  badge: string
  badgeColor: 'green' | 'amber' | 'red'
  errorText: string | null
  canRetry: boolean
  setup: PairingSetup | null
  /** Non-null ⟺ the server refused on entitlement grounds. The panel renders THIS
   *  instead of `errorText` — a refusal is a sales moment, not a red error. */
  refusal: RefusalCopy | null
}

export function derivePairing(input: PairingInputs): PairingView {
  const { enabled, connected, lanQr, tunnelEnabled, tunnelStatus, tunnelQr } = input

  if (!enabled) {
    return { showQr: false, qrDataUrl: null, badge: '', badgeColor: 'amber', errorText: null, canRetry: false, setup: null, refusal: null }
  }

  // THE chain — evaluated exactly once, here. The tunnel code wins when it is
  // genuinely up, and the LAN code carries the screen until then, so there is
  // always something to scan rather than a mode the user has to pick first.
  const tunnelUp = tunnelEnabled && tunnelStatus.state === 'up' && tunnelQr !== null
  const qrDataUrl = tunnelUp ? tunnelQr : lanQr
  const showQr = qrDataUrl !== null

  // A live phone outranks everything: pairing is already done.
  if (connected) {
    return {
      showQr,
      qrDataUrl,
      badge: PAIRING_BADGE.connected,
      badgeColor: 'green',
      errorText: null,
      canRetry: false,
      setup: null,
      refusal: null
    }
  }

  if (showQr) {
    return {
      showQr,
      qrDataUrl,
      badge: PAIRING_BADGE.ready,
      badgeColor: 'amber',
      errorText: null,
      canRetry: false,
      setup: null,
      refusal: null
    }
  }

  // No QR at all — say WHY, in one line, instead of claiming readiness. The
  // tunnel's own states only reach the badge here: while a LAN code is on
  // screen the setup is background work, not the user's problem.
  if (tunnelEnabled) {
    if (tunnelStatus.state === 'error') {
      // A refusal is the server working as designed, so it gets the plan's copy
      // and no Retry — retrying a cap just spends another round-trip to be told
      // the same thing. Only a genuine failure is red and retryable.
      const refused = tunnelStatus.refusal
      if (refused) {
        return {
          showQr: false,
          qrDataUrl: null,
          badge: PAIRING_BADGE.tunnelLimit,
          badgeColor: 'amber',
          errorText: null,
          canRetry: false,
          setup: null,
          refusal: refusalCopy(refused)
        }
      }
      return {
        showQr: false,
        qrDataUrl: null,
        badge: PAIRING_BADGE.tunnelError,
        badgeColor: 'red',
        errorText: tunnelStatus.error ?? "Couldn't set up off-Wi-Fi access.",
        canRetry: true,
        setup: null,
        refusal: null
      }
    }

    const stage = TUNNEL_STAGE[tunnelStatus.state as keyof typeof TUNNEL_STAGE] as
      | (typeof TUNNEL_STAGE)[keyof typeof TUNNEL_STAGE]
      | undefined
    if (stage) {
      // Only 'downloading' reports real bytes, so it advances within its share;
      // the other two sit at their step's start rather than inventing a ratio.
      const share = 100 / TUNNEL_SETUP_STEPS
      const within = tunnelStatus.state === 'downloading' ? (tunnelStatus.pct ?? 0) / 100 : 0
      return {
        showQr: false,
        qrDataUrl: null,
        badge: stage.badge,
        badgeColor: 'amber',
        errorText: null,
        canRetry: false,
        setup: {
          step: stage.step,
          pct: Math.round((stage.step - 1 + within) * share),
          note: stage.note
        },
        refusal: null
      }
    }

    // 'stopped' is the resting state before the first status push, NOT a
    // failure — claiming one here greeted every Settings mount with a red error.
    return {
      showQr: false,
      qrDataUrl: null,
      badge: PAIRING_BADGE.tunnelIdle,
      badgeColor: 'amber',
      errorText: null,
      canRetry: true,
      setup: null,
      refusal: null
    }
  }

  return { showQr: false, qrDataUrl: null, badge: PAIRING_BADGE.noQr, badgeColor: 'amber', errorText: null, canRetry: true, setup: null, refusal: null }
}

/** `m:ss` for the pairing code's remaining life. Ceil, not floor: flooring
 *  renders a fresh 5-minute code as "4:59" and then shows some seconds twice. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
