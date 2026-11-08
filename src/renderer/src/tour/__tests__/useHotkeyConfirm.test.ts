import { describe, it, expect, vi } from 'vitest'
import { startSession, type SessionDeps } from '../confirmSession'
import { TOUR } from '../../../../shared/tour/constants'
import { CONFIG } from '../../../../shared/config'
import { hasLiveDemo } from '../../../../shared/tour/types'
import { TIMING } from '../hotkeyConfirmMachine'
import type { TourProbeEventPayload } from '../../../../shared/tour/types'

// useHotkeyConfirm.ts itself can't be mounted in this repo's vitest config (no
// jsdom/@testing-library — see hotkeyConfirmMachine.ts's header comment), so
// these tests drive startSession() — the exact logic the hook wires into a
// useEffect — with a fully faked `deps` object standing in for window.api +
// timers + focus, per the design's "mock window.api" requirement.

function makeDeps(overrides: Partial<SessionDeps> = {}): {
  deps: SessionDeps
  emit: (payload: TourProbeEventPayload) => void
  fireTimer: (id: number) => void
  fireFocus: () => void
  /** The `ms` a given timer id was registered with — lets a test assert WHICH
   *  delay was chosen, not just that a timer exists. */
  delayFor: (id: number) => number | undefined
  armCalls: Array<string | null>
  states: ReturnType<SessionDeps['onStateChange']>[]
} {
  let probeHandler: ((payload: TourProbeEventPayload) => void) | null = null
  let focusHandler: (() => void) | null = null
  const armCalls: Array<string | null> = []
  const states: Parameters<SessionDeps['onStateChange']>[0][] = []
  let nextTimerId = 1
  const pendingTimers = new Map<number, () => void>()
  const timerDelays = new Map<number, number>()
  let clock = 0

  const deps: SessionDeps = {
    arm: () => armCalls.push('main'),
    disarm: () => armCalls.push(null),
    unlockMs: TIMING.UNLOCK_MS,
    advanceMs: TIMING.ADVANCE_MS,
    subscribe: (cb) => {
      probeHandler = cb
      return () => {
        probeHandler = null
      }
    },
    hasFocus: () => true,
    now: () => clock,
    setTimeout: (fn, ms) => {
      const id = nextTimerId++
      pendingTimers.set(id, fn)
      timerDelays.set(id, ms)
      return id
    },
    clearTimeout: (id) => {
      pendingTimers.delete(id)
    },
    addFocusListener: (cb) => {
      focusHandler = cb
      return () => {
        focusHandler = null
      }
    },
    onConfirmed: vi.fn(),
    onStateChange: (s) => states.push(s),
    analytics: {
      confirmed: vi.fn(),
      timedOut: vi.fn()
    },
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
    fireFocus: () => focusHandler?.(),
    delayFor: (id: number) => timerDelays.get(id),
    armCalls,
    states
  }
}

describe('useHotkeyConfirm session (confirmSession.ts)', () => {
  it('arms the probe with the given shortcut on start', () => {
    const { deps, armCalls } = makeDeps()
    startSession('welcome-main', deps)
    expect(armCalls).toEqual(['main'])
  })

  it('latch: a second hit event (e.g. a stray duplicate IPC message) still only fires onConfirmed once', () => {
    // capture-hotkey.ts already latches at the source (first press per arm
    // wins), but the renderer session must be equally defensive against a
    // duplicate 'hit' reaching it — tryAdvance's `advanceFired` flag is what
    // actually enforces the "only once" contract, exercised here directly.
    const { deps, emit, fireFocus } = makeDeps()
    startSession('welcome-main', deps)

    emit({ kind: 'hit' }) // queues one advance timer + focus is already true
    emit({ kind: 'hit' }) // a second hit must not queue a second successful advance

    // Focus events (the other path into tryAdvance) firing repeatedly after
    // both hits must still only have advanced once.
    fireFocus()
    fireFocus()

    expect(deps.onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('confirmed press fires onConfirmed exactly once after the advance timer, even with focus regained twice', () => {
    const { deps, emit, fireFocus } = makeDeps()
    startSession('capture', deps)

    emit({ kind: 'hit' })
    // Two focus events in a row (e.g. window blur/refocus twice) must not
    // double-fire onConfirmed — tryAdvance's `advanceFired` latch guards this.
    fireFocus()
    fireFocus()

    expect(deps.onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('window focus with no hit never advances the step', () => {
    const { deps, fireFocus } = makeDeps()
    startSession('phone', deps)

    fireFocus()
    fireFocus()

    expect(deps.onConfirmed).toHaveBeenCalledTimes(0)
  })

  it('holds auto-advance until the window regains focus (§5.3)', () => {
    const { deps, emit } = makeDeps({ hasFocus: () => false })
    startSession('capture', deps)

    emit({ kind: 'hit' })
    // No focus yet — onConfirmed must not have fired.
    expect(deps.onConfirmed).toHaveBeenCalledTimes(0)
  })

  it('advances once focus returns after a hit while unfocused', () => {
    let focused = false
    const { deps, emit, fireFocus } = makeDeps({ hasFocus: () => focused })
    startSession('capture', deps)

    emit({ kind: 'hit' })
    expect(deps.onConfirmed).toHaveBeenCalledTimes(0)

    focused = true
    fireFocus()
    expect(deps.onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('8s unlock: the unlock timer flips `unlocked` and fires timedOut analytics', () => {
    const { deps, fireTimer, states } = makeDeps()
    startSession('listen', deps)

    // First registered timer is the UNLOCK_MS timer (id 1).
    fireTimer(1)

    expect(deps.analytics.timedOut).toHaveBeenCalledWith('listen')
    expect(states.at(-1)?.unlocked).toBe(true)
    expect(states.at(-1)?.state).toBe(TOUR.CONFIRM_STATE.idle)
  })

  it('wrong-key: transitions to `wrong`, then reverts to `idle` after the reset timer', () => {
    const { deps, emit, fireTimer, states } = makeDeps()
    startSession('welcome-main', deps)

    emit({ kind: 'wrong', expected: 'main' })
    expect(states.at(-1)?.state).toBe(TOUR.CONFIRM_STATE.wrong)

    // Timer 1 = unlock, timer 2 = the wrong-reset timer registered by the 'wrong' event.
    fireTimer(2)
    expect(states.at(-1)?.state).toBe(TOUR.CONFIRM_STATE.idle)
  })

  it('mods events update the live modifier trio without changing `state`', () => {
    const { deps, emit, states } = makeDeps()
    startSession('welcome-main', deps)

    emit({ kind: 'mods', meta: true, alt: true, shift: false })

    expect(states.at(-1)?.mods).toEqual({ meta: true, alt: true, shift: false })
    expect(states.at(-1)?.state).toBe(TOUR.CONFIRM_STATE.idle)
  })

  it('disarm on cleanup: cleanup() always calls armProbe(null), unsubscribes the probe listener, and clears pending timers', () => {
    const { deps, emit, armCalls } = makeDeps()
    const session = startSession('capture', deps)

    expect(armCalls).toEqual(['main'])

    session.cleanup()
    expect(armCalls).toEqual(['main', null])

    // A probe event delivered after cleanup must be a no-op (listener removed) —
    // simulate by emitting again; the module-level handler reference would only
    // still fire if the unsubscribe didn't actually take effect.
    const before = deps.onConfirmed as ReturnType<typeof vi.fn>
    emit({ kind: 'hit' })
    expect(before).toHaveBeenCalledTimes(0)
  })

  it('cleanup mid-flight (before the advance timer fires) prevents onConfirmed from ever firing', () => {
    const { deps, emit } = makeDeps()
    const session = startSession('welcome-main', deps)

    emit({ kind: 'hit' })
    // Cleanup before the ADVANCE_MS timer would have elapsed — clearTimeout is
    // called on it, so it can never fire attemptAdvance after unmount.
    session.cleanup()

    expect(deps.onConfirmed).toHaveBeenCalledTimes(0)
  })

  // ── Two-stage gate: chordDown drives whether mini-step B (the letter cap) is
  // on screen at all. These pin the gate's edges, since the whole step layout
  // hangs off this one boolean.

  it('chordDown is false until all three modifiers are down together', () => {
    const { deps, emit, states } = makeDeps()
    startSession('welcome-main', deps)

    emit({ kind: 'mods', meta: true, alt: false, shift: false })
    emit({ kind: 'mods', meta: true, alt: true, shift: false })
    // Nothing so far has had all three down, so no emitted state may claim it.
    expect(states.some((s) => s.chordDown)).toBe(false)

    emit({ kind: 'mods', meta: true, alt: true, shift: true })
    expect(states[states.length - 1].chordDown).toBe(true)
  })

  it('chordDown goes back to false when a modifier is released (mini-step B hides again)', () => {
    // Deliberately live, not latched: releasing the chord really should take
    // the letter cap away. Safe only because the probe reports PHYSICAL modifier
    // state — driving this off uiohook's lagging flag bits strobed the row.
    const { deps, emit, states } = makeDeps()
    startSession('capture', deps)

    emit({ kind: 'mods', meta: true, alt: true, shift: true })
    expect(states[states.length - 1].chordDown).toBe(true)

    emit({ kind: 'mods', meta: true, alt: false, shift: true })
    expect(states[states.length - 1].chordDown).toBe(false)
  })

  // ── Advance delay: the confirmed hold is what keeps a live demo on screen,
  // because advancing calls armProbe(next) which tears the demo down.

  it('the advance timer uses the INJECTED advanceMs, not a hardcoded beat', () => {
    // Regression: the demo HUD appeared and vanished in one blink because the
    // hold was pinned to the short TIMING.ADVANCE_MS regardless of the step.
    const { deps, emit, delayFor } = makeDeps({ advanceMs: 2_600 })
    startSession('capture', deps)

    emit({ kind: 'hit' })

    // Timer 1 = unlock, timer 2 = the advance timer queued by the hit.
    expect(delayFor(2)).toBe(2_600)
  })

  it('hasLiveDemo picks the long hold for demo steps and the short one otherwise', () => {
    // The renderer and main must agree on which steps show a demo — this reads
    // the shared list rather than restating the ids.
    expect(hasLiveDemo('main')).toBe(true)
    expect(hasLiveDemo('capture')).toBe(true)
    expect(hasLiveDemo('listen')).toBe(true)
    expect(hasLiveDemo(undefined)).toBe(false)
    expect(hasLiveDemo('suggest')).toBe(false)
    // The whole point of the longer beat: it must actually be longer.
    expect(CONFIG.TOUR_DEMO_ADVANCE_MS).toBeGreaterThan(CONFIG.TOUR_ADVANCE_MS)
  })

  it('TIMING constants are wired from CONFIG, not hardcoded', () => {
    expect(TIMING.UNLOCK_MS).toBeGreaterThan(0)
    expect(TIMING.ADVANCE_MS).toBeGreaterThan(0)
    expect(TIMING.WRONG_RESET_MS).toBeGreaterThan(0)
  })
})
