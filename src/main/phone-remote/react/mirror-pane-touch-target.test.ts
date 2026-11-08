import { describe, it, expect, beforeAll } from 'vitest'
import {
  isMirrorPaneControlTouch,
  MIRROR_PANE_CONTROL_SELECTOR
} from './mirror-pane-touch-target'

// The suite runs on `environment: 'node'`, which has no Element. These fakes
// stand in for the one DOM contract the predicate uses: `instanceof Element`
// plus `closest`. Nesting is modeled by the ancestor chain each node reports.
class FakeElement {
  constructor(private readonly classes: string[] = [], private readonly parent?: FakeElement) {}

  closest(selector: string): FakeElement | null {
    if (selector !== MIRROR_PANE_CONTROL_SELECTOR) throw new Error(`unexpected ${selector}`)
    const wanted = selector.slice(1)
    for (let n: FakeElement | undefined = this; n; n = n.parent) {
      if (n.classes.includes(wanted)) return n
    }
    return null
  }
}

beforeAll(() => {
  ;(globalThis as { Element?: unknown }).Element = FakeElement
})

describe('isMirrorPaneControlTouch', () => {
  it('claims a touch on the badge itself', () => {
    const control = new FakeElement(['mirrorAudioControl'])
    expect(isMirrorPaneControlTouch(new FakeElement(['mirrorAudioBadge'], control))).toBe(true)
  })

  it('claims a touch on the slider knob nested several levels deep', () => {
    const control = new FakeElement(['mirrorAudioControl'])
    const panel = new FakeElement(['mirrorVolumePanel'], control)
    const track = new FakeElement(['mirrorVolumeTrack'], panel)
    expect(isMirrorPaneControlTouch(new FakeElement(['mirrorVolumeKnob'], track))).toBe(true)
  })

  it('lets a touch on the video through, so the mirror still works', () => {
    expect(isMirrorPaneControlTouch(new FakeElement(['mirrorVideo']))).toBe(false)
  })

  it('does not throw on a null or non-Element target', () => {
    expect(isMirrorPaneControlTouch(null)).toBe(false)
    expect(isMirrorPaneControlTouch({} as EventTarget)).toBe(false)
  })
})
