import { describe, expect, it } from 'vitest'
import { SHEET_ANCHOR_GAP, sheetBoxIn } from './AppContextBar'

/**
 * A real iPhone with the native keyboard up. The two viewport heights differ by
 * exactly the occluded region, which is the whole hazard this file guards: the
 * sheet is portalled to document.body, so `position: fixed` resolves against
 * the LAYOUT height, while anything measuring "what can I see" wants the VISUAL
 * one. Numbers are from Roy's device trace (occluded=335, top=517).
 */
const IPHONE = { vw: 393, layoutH: 853, visualH: 518 }
/** y of the keyboard's top edge on that device -- where the bar sits. */
const BAR_TOP = 517

const anchorAt = (top: number, left = 120): DOMRect =>
  ({ top, left, width: 90, height: 34, bottom: top + 34, right: left + 90 }) as DOMRect

describe('sheetBoxIn', () => {
  it('places the sheet ABOVE the anchor, in layout-viewport space', () => {
    const box = sheetBoxIn(anchorAt(BAR_TOP), IPHONE)
    // Measured from the layout bottom, the sheet's bottom edge must sit at
    // least (layoutH - anchor.top) up -- i.e. above the bar, not below it.
    expect(box.bottom).toBeGreaterThan(IPHONE.layoutH - BAR_TOP)
  })

  it('does NOT use the visual height for `bottom` -- the keyboard-height bug', () => {
    // THE REGRESSION. Measuring against visualHeight yields
    // 518 - 517 + gap = ~7px, which pins the sheet to the bottom of the screen,
    // behind the keyboard. Against layoutHeight it is ~342px. The gap between
    // those two answers IS the keyboard.
    const box = sheetBoxIn(anchorAt(BAR_TOP), IPHONE)
    // Both candidate answers carry the same +SHEET_ANCHOR_GAP term, so the
    // difference between them is exactly the occluded region: the keyboard.
    const wrongByVisual = IPHONE.visualH - BAR_TOP + SHEET_ANCHOR_GAP
    const rightByLayout = IPHONE.layoutH - BAR_TOP + SHEET_ANCHOR_GAP
    expect(box.bottom).toBe(rightByLayout)
    expect(box.bottom - wrongByVisual).toBe(IPHONE.layoutH - IPHONE.visualH)
  })

  it('caps height to the space actually above the anchor', () => {
    const box = sheetBoxIn(anchorAt(BAR_TOP), IPHONE)
    expect(box.maxHeight).toBeLessThanOrEqual(BAR_TOP)
    expect(box.maxHeight).toBeGreaterThan(0)
  })

  it('keeps both horizontal edges on screen', () => {
    // An anchor near the right edge must not push the sheet off it.
    const box = sheetBoxIn(anchorAt(BAR_TOP, IPHONE.vw - 40), IPHONE)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.left + box.maxWidth).toBeLessThanOrEqual(IPHONE.vw)
  })

  it('falls back sanely when no keyboard is up (both heights equal)', () => {
    const noKeyboard = { vw: 393, layoutH: 853, visualH: 853 }
    const box = sheetBoxIn(anchorAt(BAR_TOP), noKeyboard)
    expect(box.bottom).toBeGreaterThan(0)
    expect(box.maxHeight).toBeGreaterThan(0)
  })
})
