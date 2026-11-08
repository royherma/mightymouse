import { describe, it, expect } from 'vitest'
import { shouldShowDelayed } from './useDelayedFlag'

// The touchpad's post-release "Transcribing…" pill is gated on BOTH "the wait is
// still running" and "it has been running long enough to be worth mentioning".
// Dropping either gate produces a real, previously-shipped failure mode, so the
// truth table is locked in here rather than left to the hook's timer wiring.
describe('shouldShowDelayed', () => {
  it('stays hidden for a wait that resolves inside the delay window', () => {
    // The common case: transcription came back in ~400ms, the timer never fired.
    // Showing anything here is the flicker the delay exists to prevent.
    expect(shouldShowDelayed(false, false)).toBe(false)
  })

  it('stays hidden while a slow wait has not yet crossed the threshold', () => {
    expect(shouldShowDelayed(true, false)).toBe(false)
  })

  it('shows once a still-running wait crosses the threshold', () => {
    expect(shouldShowDelayed(true, true)).toBe(true)
  })

  it('hides the moment the wait ends, even after the timer already fired', () => {
    // Guards the strand: `elapsed` latches true and is only reset by the hook's
    // !active branch, so a predicate of `elapsed` alone would leave the pill on
    // screen forever after the first slow transcription.
    expect(shouldShowDelayed(false, true)).toBe(false)
  })
})
