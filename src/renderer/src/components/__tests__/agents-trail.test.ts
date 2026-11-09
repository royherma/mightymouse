import { describe, it, expect } from 'vitest'
import {
  AGENTS_TRAIL_MAX,
  EMPTY_TRAIL,
  claimStepKey,
  trailBack,
  trailForward,
  trailMove,
  type AgentsSpot,
  type AgentsTrail
} from '../agents-trail'

const session = (label: string): AgentsSpot => ({ label, tableId: null, fromTable: false })

// Same order as the real window: CodePanel's capture listener first, then MightyApp's
// bubble listener, which skips a key that was already claimed (defaultPrevented).
function makeWindow(screens: string[]) {
  let trail: AgentsTrail = EMPTY_TRAIL
  const screenBack = [...screens.slice(0, -1)]
  let screen = screens.at(-1)!
  return {
    open: (label: string) => (trail = trailMove(trail, session(label), true)),
    press: (code: 'BracketLeft' | 'BracketRight') => {
      const e = { metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, code, defaultPrevented: false }
      const key = claimStepKey(e, trail, true)
      if (key) {
        e.defaultPrevented = true
        trail = (key === 'back' ? trailBack(trail) : trailForward(trail)) ?? trail
      }
      if (!e.defaultPrevented && code === 'BracketLeft' && screenBack.length) screen = screenBack.pop()!
    },
    get session() {
      return trail.at.label
    },
    get screen() {
      return screen
    },
    get trail() {
      return trail
    }
  }
}

describe('Cmd+[ / Cmd+] session history', () => {
  it('open A, B, C; Cmd+[ twice lands on B then A; Cmd+] once lands on B', () => {
    const w = makeWindow(['bubba', 'code'])
    w.open('A')
    w.open('B')
    w.open('C')
    expect(w.session).toBe('C')
    w.press('BracketLeft')
    expect(w.session).toBe('B')
    w.press('BracketLeft')
    expect(w.session).toBe('A')
    w.press('BracketRight')
    expect(w.session).toBe('B')
    expect(w.screen).toBe('code')
  })

  it('going back past the first session lands on the Code home, then on the last screen', () => {
    const w = makeWindow(['bubba', 'code'])
    w.open('A')
    w.press('BracketLeft')
    expect(w.session).toBeNull()
    expect(w.screen).toBe('code')
    w.press('BracketLeft')
    expect(w.screen).toBe('bubba')
  })

  it('opening a new session clears the forward list', () => {
    const w = makeWindow(['code'])
    w.open('A')
    w.open('B')
    w.open('C')
    w.press('BracketLeft')
    w.press('BracketLeft')
    expect(w.trail.ahead.map((s) => s.label)).toEqual(['C', 'B'])
    w.open('D')
    expect(w.trail.ahead).toEqual([])
    w.press('BracketRight')
    expect(w.session).toBe('D')
    w.press('BracketLeft')
    expect(w.session).toBe('A')
  })

  it('does not claim the key when the Code view is not the one on screen', () => {
    const t = trailMove(EMPTY_TRAIL, session('A'), true)
    const e = { metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, code: 'BracketLeft' }
    expect(claimStepKey(e, t, false)).toBeNull()
    expect(claimStepKey({ ...e, shiftKey: true }, t, true)).toBeNull()
    expect(claimStepKey(e, t, true)).toBe('back')
  })

  it('a move outside the sessions view updates where you are without adding a step', () => {
    const t = trailMove(trailMove(EMPTY_TRAIL, session('A'), true), session('B'), false)
    expect(t.at.label).toBe('B')
    expect(t.back.map((s) => s.label)).toEqual([null])
  })

  it(`keeps at most ${AGENTS_TRAIL_MAX} steps`, () => {
    let t = EMPTY_TRAIL
    for (let i = 0; i < AGENTS_TRAIL_MAX + 10; i++) t = trailMove(t, session(`s${i}`), true)
    expect(t.back).toHaveLength(AGENTS_TRAIL_MAX)
  })
})
