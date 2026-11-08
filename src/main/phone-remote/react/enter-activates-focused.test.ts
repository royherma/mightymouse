import { describe, it, expect } from 'vitest'
import { shouldSynthesizeClick, type FocusedTarget } from './enter-activates-focused'

function target(over: Partial<FocusedTarget> = {}): FocusedTarget {
  return { tagName: 'BUTTON', inForm: false, hasHref: false, disabled: false, ...over }
}

describe('enter activates focused control', () => {
  it('clicks a standalone button — the whole point on a cursorless host', () => {
    expect(shouldSynthesizeClick(target())).toBe(true)
  })

  it('clicks a div given an explicit role/tabindex', () => {
    expect(shouldSynthesizeClick(target({ tagName: 'DIV' }))).toBe(true)
  })

  // The single-use pairing code is what makes this expensive: the browser
  // already submits the form on Enter, so a second synthesized click POSTs the
  // code twice and the retry burns the code it just spent.
  it('does NOT double-fire a submit button inside a form', () => {
    expect(shouldSynthesizeClick(target({ inForm: true }))).toBe(false)
  })

  it('leaves text inputs alone so typing Enter still submits', () => {
    expect(shouldSynthesizeClick(target({ tagName: 'INPUT', type: 'text' }))).toBe(false)
    expect(shouldSynthesizeClick(target({ tagName: 'INPUT', type: 'email' }))).toBe(false)
    expect(shouldSynthesizeClick(target({ tagName: 'TEXTAREA' }))).toBe(false)
    expect(shouldSynthesizeClick(target({ tagName: 'SELECT' }))).toBe(false)
  })

  // A bare <input> IS a text field per the HTML spec, and the pairing code
  // field is one -- defaulting an unknown type to "clickable" would let a pinch
  // POST a half-typed code.
  it('treats an <input> with no type as text', () => {
    expect(shouldSynthesizeClick(target({ tagName: 'INPUT' }))).toBe(false)
  })

  it('clicks a checkbox — nothing else can toggle one on a cursorless host', () => {
    expect(shouldSynthesizeClick(target({ tagName: 'INPUT', type: 'checkbox' }))).toBe(true)
  })

  // A click on a range jumps the thumb to the CLICK POINT, and a band that
  // sends four arrows has no click point -- so the pinch would move the slider
  // somewhere arbitrary. Left/Right own this control instead.
  it('does NOT click a range input', () => {
    expect(shouldSynthesizeClick(target({ tagName: 'INPUT', type: 'range' }))).toBe(false)
  })

  it('leaves a real link to the browser', () => {
    expect(shouldSynthesizeClick(target({ tagName: 'A', hasHref: true }))).toBe(false)
  })

  // An <a> with no href is a styled button in practice and gets no free Enter.
  it('clicks an anchor with no href', () => {
    expect(shouldSynthesizeClick(target({ tagName: 'A', hasHref: false }))).toBe(true)
  })

  it('ignores a disabled control', () => {
    expect(shouldSynthesizeClick(target({ disabled: true }))).toBe(false)
  })
})
