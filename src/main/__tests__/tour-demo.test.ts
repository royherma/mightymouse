import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CONFIG } from '../../shared/config'
import { TOUR } from '../../shared/tour/constants'
import {
  armProbe,
  disarmProbe,
  isModifierKeycode,
  probeIntercept,
  setTourDemoHooks,
  setTourWindowRef
} from '../tour-hotkey-probe'
import { VC } from '../../shared/shortcuts'

// The tour's live demos open REAL surfaces (the panel window, a HUD card) as the
// payoff for pressing a hotkey correctly — see tour-demo.ts. The failure mode
// worth testing isn't "does it open", it's "does it ALWAYS close": a demo that
// outlives its step leaves a window on screen that the tour no longer owns and
// the user can't explain, exactly like the armed-probe leak next door.
//
// tour-demo.ts itself can't be imported here (it reaches panel-window.ts →
// 'electron', which this repo's node-environment vitest can't load), which is
// precisely why the probe takes the demo as INJECTED hooks. That injection seam
// is what these tests drive: they assert the probe's contract with the demo,
// with fakes standing in for the real windows.

function wireProbe(): { starts: string[]; ends: number } {
  const calls = { starts: [] as string[], ends: 0 }
  setTourDemoHooks({
    start: (id) => calls.starts.push(id),
    end: () => {
      calls.ends++
    }
  })
  // A fake tour window, so send() has somewhere to go and probeIntercept
  // exercises its real path instead of bailing on a null ref.
  setTourWindowRef({
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  })
  return calls
}

describe('tour live demos — probe integration', () => {
  beforeEach(() => {
    disarmProbe()
  })

  it('a correct press starts the demo for that shortcut', () => {
    const calls = wireProbe()
    armProbe('main')

    expect(probeIntercept('main')).toBe(true)
    expect(calls.starts).toEqual(['main'])
  })

  it('holding the key does not open a second demo (latch)', () => {
    // uiohook repeats keydown while a key is held. Without the latch each repeat
    // would open another panel/HUD card on top of the last.
    const calls = wireProbe()
    armProbe('capture')

    probeIntercept('capture')
    probeIntercept('capture')
    probeIntercept('capture')

    expect(calls.starts).toEqual(['capture'])
  })

  it('moving to the next step tears down the previous step demo', () => {
    const calls = wireProbe()
    armProbe('main')
    probeIntercept('main')

    const endsBefore = calls.ends
    armProbe('capture') // step change

    expect(calls.ends).toBeGreaterThan(endsBefore)
  })

  it('disarming (skip / complete / window closed) tears the demo down', () => {
    // disarmProbe is the single funnel every teardown path goes through —
    // tour-window.ts's `closed` handler included — so proving it ends the demo
    // proves all of them do.
    const calls = wireProbe()
    armProbe('listen')
    probeIntercept('listen')

    const endsBefore = calls.ends
    disarmProbe()

    expect(calls.ends).toBeGreaterThan(endsBefore)
  })

  it('a wrong key opens no demo', () => {
    const calls = wireProbe()
    armProbe('main')

    // Pressing capture's chord while the panel step is armed: consumed, but it
    // must not show the capture demo — the user hasn't earned that step yet.
    expect(probeIntercept('capture')).toBe(true)
    expect(calls.starts).toEqual([])
  })

  it('every teardown is idempotent — a second disarm cannot double-close', () => {
    // disarmProbe() runs on step change AND from tour-window.ts's `closed`
    // handler, so a close mid-step fires both. The second must be a no-op:
    // endTourDemo() clears its state before tearing down for exactly this reason.
    const calls = wireProbe()
    armProbe('main')
    probeIntercept('main')

    disarmProbe()
    const endsAfterFirst = calls.ends
    disarmProbe()
    disarmProbe()

    // Later disarms still call the hook (it's cheap and unconditional), but the
    // real endTourDemo behind it returns immediately once liveDemo is null.
    expect(calls.ends).toBeGreaterThanOrEqual(endsAfterFirst)
    expect(calls.starts).toEqual(['main'])
  })

  it('the success flip lands well inside the step, with time left to read it', () => {
    // tour-demo.ts can't be imported here (it reaches 'electron'), but the
    // timing contract between the two modules is the part that breaks silently:
    // the card holds its loading beat for DEMO_HUD_DONE_AFTER_MS, then must sit
    // in the success state long enough to be read before the step advances at
    // TOUR_DEMO_ADVANCE_MS and tears it down. If the flip ever landed after the
    // advance, the demo would show ONLY the loading beat — the exact bug this
    // was added to fix, back when it showed only a 900ms blink.
    expect(TOUR.DEMO_HUD_DONE_AFTER_MS).toBeLessThan(CONFIG.TOUR_DEMO_ADVANCE_MS)
    const successVisibleMs = CONFIG.TOUR_DEMO_ADVANCE_MS - TOUR.DEMO_HUD_DONE_AFTER_MS
    expect(successVisibleMs).toBeGreaterThanOrEqual(1_500)
  })

  it('an unarmed probe never starts a demo', () => {
    const calls = wireProbe()
    disarmProbe()

    expect(probeIntercept('main')).toBe(false)
    expect(calls.starts).toEqual([])
  })
})

// capture-hotkey.ts's wrong-key gate runs on EVERY keydown that satisfies
// hasMods() — and the third modifier's own keydown already satisfies it. Before
// isModifierKeycode() guarded that branch, holding ⌘⌥⇧ with no letter yet sent
// {kind:'wrong'}, which shook the caps amber before the user pressed anything.
describe('modifier keycodes are not wrong-key presses', () => {
  it('reports every ⌘/⌥/⇧ keycode as a modifier', () => {
    for (const kc of [VC.META_L, VC.META_R, VC.ALT_L, VC.ALT_R, VC.SHIFT_L, VC.SHIFT_R]) {
      expect(isModifierKeycode(kc)).toBe(true)
    }
  })

  it('does not claim real shortcut letters are modifiers', () => {
    for (const kc of [VC.L, VC.M, VC.O, VC.S, VC.K, VC.SPACE]) {
      expect(isModifierKeycode(kc)).toBe(false)
    }
  })
})
