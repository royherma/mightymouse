/**
 * The load-bearing assertion is the invariant sweep at the bottom — it walks the
 * ENTIRE tunnel-state × qr-presence matrix, so any edit that lets badge and QR
 * drift apart fails here whichever branch introduced it.
 */
import { describe, it, expect } from 'vitest'
import { REFUSAL_CODE, UPGRADE_CTA } from '../remote-refusal'
import {
  derivePairing,
  formatCountdown,
  PAIRING_BADGE,
  TUNNEL_SETUP_STEPS
} from '../phone-remote-pairing'
import type { PhoneRemoteTunnelState } from '../types'

const QR = 'data:image/png;base64,AAAA'
const TUNNEL_QR = 'data:image/png;base64,BBBB'

const base = {
  enabled: true,
  connected: false,
  lanQr: null as string | null,
  tunnelEnabled: false,
  tunnelStatus: { state: 'stopped' as PhoneRemoteTunnelState },
  tunnelQr: null as string | null
}

describe('derivePairing', () => {
  it('says nothing when the feature is off', () => {
    const v = derivePairing({ ...base, enabled: false, lanQr: QR })
    expect(v.badge).toBe('')
    expect(v.showQr).toBe(false)
  })

  it('a LAN QR alone is ready to pair', () => {
    const v = derivePairing({ ...base, lanQr: QR })
    expect(v.showQr).toBe(true)
    expect(v.qrDataUrl).toBe(QR)
    expect(v.badge).toBe(PAIRING_BADGE.ready)
  })

  it('NO QR at all never claims readiness, and offers a retry', () => {
    const v = derivePairing(base)
    expect(v.showQr).toBe(false)
    expect(v.badge).toBe(PAIRING_BADGE.noQr)
    expect(v.canRetry).toBe(true)
  })

  // The whole point of dropping `mode`: the user never picks a network, so the
  // LAN code must carry the screen while the tunnel is still coming up.
  it('shows the LAN QR while the tunnel is mid-setup, and swaps to the tunnel QR once up', () => {
    const setting = derivePairing({
      ...base,
      lanQr: QR,
      tunnelEnabled: true,
      tunnelStatus: { state: 'downloading', pct: 20 }
    })
    expect(setting.qrDataUrl).toBe(QR)
    expect(setting.badge).toBe(PAIRING_BADGE.ready)
    // Setup is background work while something is scannable — never a progress
    // bar sitting on top of a working QR.
    expect(setting.setup).toBeNull()

    const up = derivePairing({
      ...base,
      lanQr: QR,
      tunnelEnabled: true,
      tunnelStatus: { state: 'up' },
      tunnelQr: TUNNEL_QR
    })
    expect(up.qrDataUrl).toBe(TUNNEL_QR)
  })

  // 'stopped' is the resting state on every Settings mount and between the
  // toggle flipping and the first status push -- not a failure, though it does
  // offer Retry since nothing is driving it.
  it('tunnel enabled but not up yet, with no LAN fallback, says neither ready NOR failed', () => {
    const v = derivePairing({
      ...base,
      tunnelEnabled: true,
      tunnelStatus: { state: 'stopped' }
    })
    expect(v.badge).not.toBe(PAIRING_BADGE.ready)
    expect(v.badge).toBe(PAIRING_BADGE.tunnelIdle)
    expect(v.badgeColor).not.toBe('red')
    expect(v.errorText).toBeNull()
    expect(v.canRetry).toBe(true)
    expect(v.setup).toBeNull()
  })

  // The "why is it stuck on setting up" report: all three setup states shared
  // ONE frozen badge, so a 17 MB download and a 1s spawn looked identical.
  it('narrates each setup stage distinctly, and advances the bar', () => {
    const remote = { ...base, tunnelEnabled: true }
    const dl = derivePairing({ ...remote, tunnelStatus: { state: 'downloading', pct: 50 } })
    const prov = derivePairing({ ...remote, tunnelStatus: { state: 'provisioning' } })
    const start = derivePairing({ ...remote, tunnelStatus: { state: 'starting' } })

    for (const v of [dl, prov, start]) {
      expect(v.setup).not.toBeNull()
      expect(v.canRetry).toBe(false) // nothing to retry while it's actively working
    }
    // Three different stories, not one repeated.
    expect(new Set([dl.badge, prov.badge, start.badge]).size).toBe(3)
    expect(dl.setup?.step).toBe(1)
    expect(prov.setup?.step).toBe(2)
    expect(start.setup?.step).toBe(3)
    // Download reports real bytes, so it moves WITHIN its own step.
    expect(dl.setup?.pct).toBeGreaterThan(0)
    expect(dl.setup!.pct).toBeLessThan(prov.setup!.pct)
    expect(prov.setup!.pct).toBeLessThan(start.setup!.pct)
  })

  it('download progress is monotonic across pct', () => {
    const remote = { ...base, tunnelEnabled: true }
    const at = (pct: number): number =>
      derivePairing({ ...remote, tunnelStatus: { state: 'downloading', pct } }).setup!.pct
    expect(at(0)).toBeLessThan(at(99))
    expect(at(0)).toBe(0)
  })

  it('surfaces the tunnel error on the badge, with its reason', () => {
    const v = derivePairing({
      ...base,
      tunnelEnabled: true,
      tunnelStatus: { state: 'error', error: 'cloudflared exited early (signal SIGTERM)' }
    })
    expect(v.badge).toBe(PAIRING_BADGE.tunnelError)
    expect(v.badgeColor).toBe('red')
    expect(v.errorText).toContain('SIGTERM')
    expect(v.canRetry).toBe(true)
    expect(v.refusal).toBeNull()
  })

  // Same 'error' state as above, opposite rendering: hitting the plan's cap is
  // the server working, so it must never reach the red-and-retryable branch.
  it('renders a cap as the plan limit, not a failure', () => {
    const v = derivePairing({
      ...base,
      tunnelEnabled: true,
      tunnelStatus: {
        state: 'error',
        error: 'remote_limit_reached',
        refusal: {
          code: REFUSAL_CODE.remoteLimitReached,
          message: "You've used all your off-Wi-Fi access on the free plan.",
          usage: {
            used: { day: 15, week: 45, month: 90 },
            limits: { day: 15, week: 45, month: 90 },
            window: 'daily'
          }
        }
      }
    })
    expect(v.badge).toBe(PAIRING_BADGE.tunnelLimit)
    expect(v.badgeColor).toBe('amber')
    // The raw enum must never reach the screen -- that was the whole bug.
    expect(v.errorText).toBeNull()
    // Retrying a cap just spends a round-trip to be refused again.
    expect(v.canRetry).toBe(false)
    expect(v.refusal?.detail).toContain('15 of 15 minutes')
    expect(v.refusal?.cta).toBe(UPGRADE_CTA)
  })

  it('tunnel up WITH a QR is ready', () => {
    const v = derivePairing({
      ...base,
      tunnelEnabled: true,
      tunnelStatus: { state: 'up' },
      tunnelQr: TUNNEL_QR
    })
    expect(v.showQr).toBe(true)
    expect(v.badge).toBe(PAIRING_BADGE.ready)
  })

  it('tunnel up but QR not generated yet, and no LAN, does NOT say ready', () => {
    const v = derivePairing({
      ...base,
      tunnelEnabled: true,
      tunnelStatus: { state: 'up' },
      tunnelQr: null
    })
    expect(v.showQr).toBe(false)
    expect(v.badge).not.toBe(PAIRING_BADGE.ready)
  })

  it('a tunnel QR is ignored while the tunnel is not actually up', () => {
    const v = derivePairing({ ...base, connected: true, tunnelQr: TUNNEL_QR })
    expect(v.badge).toBe(PAIRING_BADGE.connected)
    expect(v.showQr).toBe(false) // tunnel not enabled/up -> no QR, even though tunnelQr exists
  })

  // THE invariant. Everything above is an example; this is the rule.
  it('badge claims a scannable QR if and only if one is rendered — whole matrix', () => {
    const states: PhoneRemoteTunnelState[] = [
      'stopped',
      'downloading',
      'provisioning',
      'starting',
      'up',
      'error'
    ]
    let cases = 0
    for (const state of states) {
      for (const tunnelEnabled of [false, true]) {
        for (const lanQr of [null, QR]) {
          for (const tunnelQr of [null, TUNNEL_QR]) {
            for (const connected of [false, true]) {
              const v = derivePairing({
                enabled: true,
                connected,
                lanQr,
                tunnelEnabled,
                tunnelStatus: { state },
                tunnelQr
              })
              cases++
              // The invariant, stated two ways so a badge rename can't dodge it.
              expect(v.badge === PAIRING_BADGE.ready).toBe(v.showQr && !connected)
              expect(v.showQr).toBe(v.qrDataUrl !== null)
              // Never promise a scan without an image behind it.
              if (v.badge.includes('scan the QR')) expect(v.qrDataUrl).not.toBeNull()

              // SECOND INVARIANT: in-progress is exactly `setup !== null`, and
              // may never coexist with a QR, an error, or a retry -- each of
              // which means setup is NOT in flight.
              if (v.setup) {
                expect(v.showQr).toBe(false)
                expect(v.errorText).toBeNull()
                expect(v.canRetry).toBe(false)
                expect(v.setup.pct).toBeGreaterThanOrEqual(0)
                expect(v.setup.pct).toBeLessThanOrEqual(100)
                expect(v.setup.step).toBeGreaterThanOrEqual(1)
                expect(v.setup.step).toBeLessThanOrEqual(TUNNEL_SETUP_STEPS)
              }

              // THIRD INVARIANT (new with the mode drop): a LAN code is always
              // scannable. Nothing about the tunnel may hide it — that was the
              // whole defect, where picking "Anywhere" blanked a working QR.
              if (lanQr) expect(v.qrDataUrl).not.toBeNull()
            }
          }
        }
      }
    }
    expect(cases).toBe(6 * 2 * 2 * 2 * 2)
  })
})

describe('formatCountdown', () => {
  it('shows a full 5:00 for a freshly minted code', () => {
    // Roy asked to SEE 5:00 then 4:59. Flooring 300_000ms renders "5:00" too,
    // but flooring 299_600 gives 4:59 twice — ceil is what makes the first
    // second land on 5:00 and every later tick fall exactly once.
    expect(formatCountdown(300_000)).toBe('5:00')
    expect(formatCountdown(299_600)).toBe('5:00')
    expect(formatCountdown(299_000)).toBe('4:59')
  })

  it('zero-pads the seconds so the width never jumps', () => {
    expect(formatCountdown(61_000)).toBe('1:01')
    expect(formatCountdown(9_000)).toBe('0:09')
  })

  it('floors at 0:00 rather than counting negative', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})
