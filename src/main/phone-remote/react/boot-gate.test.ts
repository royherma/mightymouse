import { describe, it, expect } from 'vitest'
import { showBootGate, type BootGateInputs } from './boot-gate'

/**
 * A phone that has connected before must come back to its DECK, not a splash.
 *
 * `everConnected` is useState, so it only ever knew about drops within one load.
 * A PWA relaunch or a restored Safari tab starts a new load, which made a phone
 * that never unpaired indistinguishable from a first-ever connect and gave it the
 * full-screen gate for a reconnect that usually takes ~200ms.
 */
const PHONE: BootGateInputs = {
  connected: false,
  everConnected: false,
  returning: false,
  cursorless: false,
  nativeCoverHoldsThisWait: false
}

describe('showBootGate', () => {
  it('covers a first-ever connect -- this device has nothing to show yet', () => {
    expect(showBootGate(PHONE)).toBe(true)
  })

  it('never covers a live connection', () => {
    expect(showBootGate({ ...PHONE, connected: true })).toBe(false)
  })

  it('keeps the deck through a mid-session drop', () => {
    expect(showBootGate({ ...PHONE, everConnected: true })).toBe(false)
  })

  it('keeps the deck for a returning device -- the regression', () => {
    // Fresh load (everConnected false) on a phone that is still paired: the PWA
    // relaunch that used to get a splash.
    expect(showBootGate({ ...PHONE, returning: true })).toBe(false)
  })

  it('still covers a returning device on the glasses', () => {
    // A frozen mirror with a banner the user cannot act on is worse than the
    // gate, and the gate's reconnect is what re-runs askMirror.
    expect(showBootGate({ ...PHONE, returning: true, cursorless: true })).toBe(true)
  })

  it('yields to the native launch cover rather than stacking a second screen', () => {
    expect(showBootGate({ ...PHONE, nativeCoverHoldsThisWait: true })).toBe(false)
  })
})
