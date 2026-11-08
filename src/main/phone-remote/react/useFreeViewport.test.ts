import { describe, it, expect } from 'vitest'
import { computeFreeBand, FREE_VIEWPORT_MARGIN_PX } from './useFreeViewport'

// The band a centered modal may occupy. Two obstructions bound it and they are
// measured completely differently: a NATIVE keyboard shrinks vvHeight before we
// ever look, while a VIRTUAL one is an ordinary element we have to measure. The
// notch is a third, and it is the one that was missing -- the band used to start
// at the physical screen top, so a modal tall enough to use the full height grew
// straight up under the status bar.
//
// Numbers are an iPhone 15/16 Pro in portrait: 852pt tall, 59pt top inset,
// ~336pt native keyboard with the accessory strip.
const SCREEN = 852
const SAFE_TOP = 59
const KEYBOARD = 336

describe('free viewport band', () => {
  it('excludes the top safe area when nothing else obstructs', () => {
    const band = computeFreeBand(0, SCREEN, SAFE_TOP, null)
    expect(band.top).toBe(SAFE_TOP)
    expect(band.height).toBe(SCREEN - SAFE_TOP)
  })

  // The regression this file exists for. A native keyboard leaves the LAYOUT
  // viewport untouched and only shrinks the visual one, so the band's height
  // arrives pre-reduced -- but its top still has to clear the notch, and that
  // subtraction was missing.
  it('keeps a modal clear of the notch while a native keyboard is up', () => {
    const band = computeFreeBand(0, SCREEN - KEYBOARD, SAFE_TOP, null)
    expect(band.top).toBe(SAFE_TOP)

    // What the caller actually renders: centered in the band, capped with a
    // margin on BOTH edges.
    const maxHeight = band.height - FREE_VIEWPORT_MARGIN_PX * 2
    const modalTop = band.top + band.height / 2 - maxHeight / 2

    expect(modalTop).toBeGreaterThanOrEqual(SAFE_TOP)
    expect(modalTop + maxHeight).toBeLessThanOrEqual(SCREEN - KEYBOARD)
  })

  // Halving the margin instead of doubling it is the exact arithmetic slip that
  // shipped: the modal then overruns whichever edge the centering pushes it to.
  it('a single-edge margin is not enough to keep a full-height modal inside', () => {
    const band = computeFreeBand(0, SCREEN - KEYBOARD, SAFE_TOP, null)
    const tooTall = band.height - FREE_VIEWPORT_MARGIN_PX
    const modalTop = band.top + band.height / 2 - tooTall / 2
    expect(modalTop).toBeLessThan(SAFE_TOP + FREE_VIEWPORT_MARGIN_PX)
  })

  it('measures a virtual keyboard, which no viewport API can see', () => {
    // The visual viewport is full-height (nothing native is up); the virtual
    // board is just an element sitting at y=520.
    const band = computeFreeBand(0, SCREEN, SAFE_TOP, 520)
    expect(band.top).toBe(SAFE_TOP)
    expect(band.height).toBe(520 - SAFE_TOP)
  })

  it('ignores an obstruction that has already slid off the bottom', () => {
    const band = computeFreeBand(0, SCREEN - KEYBOARD, SAFE_TOP, SCREEN + 40)
    expect(band.height).toBe(SCREEN - KEYBOARD - SAFE_TOP)
  })

  // iOS pans the visual viewport when focus moves; the whole band travels with
  // it rather than the top staying pinned to the screen.
  it('follows the visual viewport when iOS pans the page', () => {
    const band = computeFreeBand(120, SCREEN - KEYBOARD, SAFE_TOP, null)
    expect(band.top).toBe(120 + SAFE_TOP)
  })

  it('never reports a negative height', () => {
    const band = computeFreeBand(0, 40, SAFE_TOP, null)
    expect(band.height).toBe(0)
  })
})
