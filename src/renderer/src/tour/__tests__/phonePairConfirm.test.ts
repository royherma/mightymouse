import { describe, it, expect, vi } from 'vitest'
import { phoneArmOutcome, shouldUseTunnelQr } from '../usePhonePairConfirm'
import { startSession, type SessionDeps } from '../confirmSession'
import { TOUR } from '../../../../shared/tour/constants'
import type { TourProbeEventPayload } from '../../../../shared/tour/types'

// Two halves, matching how the step is actually built:
//
//   1. phoneArmOutcome() — the phone-specific decision (dead-end vs code vs
//      already-paired), pure and directly testable.
//   2. startSession() driven with PHONE-shaped deps — proving the shared shell
//      behaves correctly for a pairing step, notably that a disconnect after a
//      confirm can't un-confirm it.
//
// The hook that glues them can't be mounted here (node environment, no jsdom —
// see hotkeyConfirmMachine.ts's header), which is exactly why the decision was
// extracted rather than left inline.

describe('phoneArmOutcome', () => {
  it('surfaces the QR when the server came up', () => {
    expect(phoneArmOutcome({ ok: true, qrDataUrl: 'data:image/png;base64,AAA' })).toEqual({
      qrDataUrl: 'data:image/png;base64,AAA',
      noLan: false,
      alreadyConnected: false
    })
  })

  it('flags a dead end when the server has no LAN address', () => {
    // A retry would fail identically, so the step must stop waiting rather than
    // spin on a QR that can never exist.
    expect(phoneArmOutcome({ ok: false })).toEqual({
      qrDataUrl: null,
      noLan: true,
      alreadyConnected: false
    })
  })

  it('reports an ALREADY-connected phone so the step can open pre-confirmed', () => {
    // The regression this guards: connect/disconnect are broadcast as
    // TRANSITIONS. A returning user's phone connected long before this step
    // mounted, so no event will ever arrive and the step would sit through its
    // whole window asking them to re-pair a phone that's already working.
    const out = phoneArmOutcome({ ok: true, qrDataUrl: 'data:image/png;base64,AAA', connected: true })
    expect(out.alreadyConnected).toBe(true)
    expect(out.noLan).toBe(false)
  })

  it('does not claim already-connected when the field is absent', () => {
    expect(phoneArmOutcome({ ok: true, qrDataUrl: 'x' }).alreadyConnected).toBe(false)
  })

  it('yields no QR when the server said ok but handed back no code', () => {
    expect(phoneArmOutcome({ ok: true }).qrDataUrl).toBeNull()
  })
})

describe('shouldUseTunnelQr', () => {
  const QR = 'data:image/png;base64,BBB'
  const base = {
    tunnelEnabled: true,
    tunnelStatus: { state: 'up' } as const,
    tunnelQr: QR,
    confirmed: false
  }

  it('shows the off-Wi-Fi code once the tunnel is up', () => {
    expect(shouldUseTunnelQr(base)).toBe(true)
  })

  it('keeps the LAN code while the tunnel is still coming up', () => {
    // The whole point of not defaulting to the tunnel: cloudflared has to
    // download and provision first, and the step must never go blank waiting.
    for (const state of ['stopped', 'downloading', 'provisioning', 'starting'] as const) {
      expect(shouldUseTunnelQr({ ...base, tunnelStatus: { state } })).toBe(false)
    }
  })

  it('keeps the LAN code when the tunnel failed', () => {
    // A failed upgrade must cost the user nothing — they can still pair on Wi-Fi.
    expect(shouldUseTunnelQr({ ...base, tunnelStatus: { state: 'error' } })).toBe(false)
  })

  it('keeps the LAN code when off-Wi-Fi was never asked for', () => {
    expect(shouldUseTunnelQr({ ...base, tunnelEnabled: false })).toBe(false)
  })

  it('keeps the LAN code when the tunnel is up but has no code yet', () => {
    expect(shouldUseTunnelQr({ ...base, tunnelQr: null })).toBe(false)
  })

  it('FREEZES the code once a phone has connected', () => {
    // Swapping the QR out from under a camera that's mid-scan is worse than
    // showing the narrower code — the step is already done at this point.
    expect(shouldUseTunnelQr({ ...base, confirmed: true })).toBe(false)
  })
})

const PHONE_UNLOCK_MS = 25_000

function makePhoneDeps(overrides: Partial<SessionDeps> = {}): {
  deps: SessionDeps
  emit: (payload: TourProbeEventPayload) => void
  fireTimer: (id: number) => void
  onConfirmed: ReturnType<typeof vi.fn>
  paired: ReturnType<typeof vi.fn>
  timedOut: ReturnType<typeof vi.fn>
  states: Parameters<SessionDeps['onStateChange']>[0][]
} {
  let probeHandler: ((payload: TourProbeEventPayload) => void) | null = null
  const states: Parameters<SessionDeps['onStateChange']>[0][] = []
  let nextTimerId = 1
  const pendingTimers = new Map<number, () => void>()
  let clock = 0

  const onConfirmed = vi.fn()
  const paired = vi.fn()
  const timedOut = vi.fn()

  const deps: SessionDeps = {
    arm: () => {},
    disarm: () => {},
    unlockMs: PHONE_UNLOCK_MS,
    advanceMs: 600,
    subscribe: (cb) => {
      probeHandler = cb
      return () => {
        probeHandler = null
      }
    },
    hasFocus: () => true,
    now: () => (clock += 1000),
    setTimeout: (fn, _ms) => {
      const id = nextTimerId++
      pendingTimers.set(id, fn)
      return id
    },
    clearTimeout: (id) => {
      pendingTimers.delete(id)
    },
    addFocusListener: () => () => {},
    onConfirmed,
    onStateChange: (s) => states.push(s),
    analytics: { confirmed: paired, timedOut },
    ...overrides
  }

  return {
    deps,
    emit: (payload) => probeHandler?.(payload),
    fireTimer: (id) => {
      const fn = pendingTimers.get(id)
      pendingTimers.delete(id)
      fn?.()
    },
    onConfirmed,
    paired,
    timedOut,
    states
  }
}

describe('phone pairing session (confirmSession.ts with phone deps)', () => {
  // Timer 1 is the unlock window, scheduled at start. The advance is a SECOND
  // timer scheduled on the hit — the deliberate beat that lets the ✓ land before
  // the step slides away — so confirming and advancing are separate moments.
  const ADVANCE_TIMER = 2

  it('confirms and advances when a phone connects', () => {
    const { deps, emit, fireTimer, onConfirmed, paired, states } = makePhoneDeps()
    startSession('phone', deps)

    emit({ kind: 'hit' })
    expect(states.at(-1)?.state).toBe(TOUR.CONFIRM_STATE.confirmed)
    expect(paired).toHaveBeenCalledWith('phone', expect.any(Number))

    fireTimer(ADVANCE_TIMER)
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('a disconnect after pairing does not un-confirm the step', () => {
    // The hook only forwards CONNECTs, but the latch is what makes that safe:
    // a phone dropping off Wi-Fi mid-tour must not reopen a finished step.
    const { deps, emit, fireTimer, onConfirmed, states } = makePhoneDeps()
    startSession('phone', deps)

    emit({ kind: 'hit' })
    emit({ kind: 'hit' })
    fireTimer(ADVANCE_TIMER)

    expect(states.at(-1)?.state).toBe(TOUR.CONFIRM_STATE.confirmed)
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('unlocks Next when nobody ever scans, without confirming', () => {
    const { deps, fireTimer, onConfirmed, timedOut, states } = makePhoneDeps()
    startSession('phone', deps)

    fireTimer(1)

    expect(states.at(-1)?.unlocked).toBe(true)
    expect(states.at(-1)?.state).not.toBe(TOUR.CONFIRM_STATE.confirmed)
    // Reported separately from tour_key_timed_out on purpose — an unscanned QR
    // is not evidence of a broken Accessibility grant.
    expect(timedOut).toHaveBeenCalledWith('phone')
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it('a late scan after the unlock still confirms', () => {
    const { deps, emit, fireTimer, onConfirmed, states } = makePhoneDeps()
    startSession('phone', deps)

    fireTimer(1)
    emit({ kind: 'hit' })
    fireTimer(ADVANCE_TIMER)

    expect(states.at(-1)?.state).toBe(TOUR.CONFIRM_STATE.confirmed)
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('drops its subscription on cleanup', () => {
    const { deps, emit, onConfirmed } = makePhoneDeps()
    const session = startSession('phone', deps)

    session.cleanup()
    emit({ kind: 'hit' })

    expect(onConfirmed).not.toHaveBeenCalled()
  })
})
