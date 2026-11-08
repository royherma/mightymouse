import { describe, it, expect } from 'vitest'
import {
  pickNextFocus,
  navOrder,
  resolveArrowAction,
  isTextEntry,
  type AdjustTarget,
  type Candidate,
  type NavRect
} from './arrow-focus-nav'

function at(x: number, y: number, width = 40, height = 40): NavRect {
  return { x, y, width, height }
}

function c(name: string, rect: NavRect, group?: string): Candidate<string> {
  return { rect, node: name, group }
}

/** The real deck, roughly: mic alone, then three icons beside it, then the 2x2
 *  key grid below. Positions are the shape that matters, not exact pixels. */
const MIC = c('mic', at(60, 400, 56, 56), 'primary')
const SWITCHER = c('switcher', at(160, 410), 'main')
const PREV = c('prev', at(220, 410), 'main')
const SETTINGS = c('settings', at(280, 410), 'main')
const ESC = c('esc', at(60, 300, 120, 40), 'keys')
const KB = c('kb', at(200, 300, 120, 40), 'keys')
const TAB = c('tab', at(60, 350, 120, 40), 'keys')
const ENTER = c('enter', at(200, 350, 120, 40), 'keys')
const DECK = [ENTER, SETTINGS, MIC, ESC, PREV, TAB, KB, SWITCHER]

describe('flat ring focus traversal', () => {
  it('orders group first, then top-to-bottom, then left-to-right', () => {
    expect(navOrder(DECK).map((x) => x.node)).toEqual([
      'mic',
      'switcher',
      'prev',
      'settings',
      'esc',
      'kb',
      'tab',
      'enter'
    ])
  })

  it('treats a whole row as one row despite mismatched heights', () => {
    // The 56px mic and the 40px icons beside it have centres ~8px apart.
    const row = [SETTINGS, MIC]
    expect(navOrder(row).map((x) => x.node)).toEqual(['mic', 'settings'])
  })

  // The point of the rewrite: four directions, two moves. Up/Right go forward,
  // Left/Down go back -- so no swipe is ever dead. The pairing is Roy's, set
  // from driving the band on-device; it is NOT reading order.
  it('steps forward on both Up and Right', () => {
    const rest = DECK.filter((x) => x.node !== 'switcher')
    expect(pickNextFocus(SWITCHER.rect, rest, 'right', 'main')).toBe('prev')
    expect(pickNextFocus(SWITCHER.rect, rest, 'up', 'main')).toBe('prev')
  })

  it('steps back on both Down and Left', () => {
    const rest = DECK.filter((x) => x.node !== 'prev')
    expect(pickNextFocus(PREV.rect, rest, 'left', 'main')).toBe('switcher')
    expect(pickNextFocus(PREV.rect, rest, 'down', 'main')).toBe('switcher')
  })

  // Inside a sheet the vertical pair INVERTS: a settings sheet is a list, not a
  // ring of buttons around a trackpad, so Down must walk down the screen. Roy
  // set both rules on the band -- the deck one above, then this one.
  it('inverts Up/Down inside a sheet so Down walks down the list', () => {
    const rest = DECK.filter((x) => x.node !== 'prev')
    expect(pickNextFocus(PREV.rect, rest, 'down', 'main', undefined, true)).toBe('settings')
    expect(pickNextFocus(PREV.rect, rest, 'up', 'main', undefined, true)).toBe('switcher')
  })

  it('leaves Left/Right alone inside a sheet — they carry no up/down meaning', () => {
    const rest = DECK.filter((x) => x.node !== 'prev')
    expect(pickNextFocus(PREV.rect, rest, 'right', 'main', undefined, true)).toBe('settings')
    expect(pickNextFocus(PREV.rect, rest, 'left', 'main', undefined, true)).toBe('switcher')
  })

  // A modal has a way out, so BACK off the head exits instead of teleporting
  // you to the last control. null means "no move" -- the handler sends Escape.
  it('refuses to wrap backwards off the head of a sheet — that exit is the way out', () => {
    const rest = DECK.filter((x) => x.node !== 'mic')
    expect(pickNextFocus(MIC.rect, rest, 'up', 'primary', undefined, true)).toBeNull()
    expect(pickNextFocus(MIC.rect, rest, 'left', 'primary', undefined, true)).toBeNull()
  })

  it('still wraps FORWARD off the tail of a sheet — a lap stays unbroken', () => {
    const rest = DECK.filter((x) => x.node !== 'enter')
    expect(pickNextFocus(ENTER.rect, rest, 'down', 'keys', undefined, true)).toBe('mic')
  })

  it('keeps the deck wrapping backwards — only sheets exit', () => {
    const rest = DECK.filter((x) => x.node !== 'mic')
    expect(pickNextFocus(MIC.rect, rest, 'left', 'primary')).toBe('enter')
  })

  it('crosses from the end of one group into the next', () => {
    const rest = DECK.filter((x) => x.node !== 'settings')
    expect(pickNextFocus(SETTINGS.rect, rest, 'right', 'main')).toBe('esc')
  })

  // No dead ends: a band has no back button, so every end must wrap or the
  // user is stranded on a control with nowhere to go.
  it('wraps forward off the tail to the head', () => {
    const rest = DECK.filter((x) => x.node !== 'enter')
    expect(pickNextFocus(ENTER.rect, rest, 'right', 'keys')).toBe('mic')
  })

  it('wraps back off the head to the tail', () => {
    const rest = DECK.filter((x) => x.node !== 'mic')
    expect(pickNextFocus(MIC.rect, rest, 'left', 'primary')).toBe('enter')
  })

  it('visits every control exactly once in a full lap', () => {
    let at_ = MIC
    const seen = ['mic']
    for (let i = 0; i < DECK.length - 1; i++) {
      const rest = DECK.filter((x) => !seen.includes(x.node))
      const next = pickNextFocus(at_.rect, rest, 'right', at_.group)
      expect(next).not.toBeNull()
      seen.push(next as string)
      at_ = DECK.find((x) => x.node === next)!
    }
    expect(new Set(seen).size).toBe(DECK.length)
  })

  // The key grid is a 2x2 block: Esc/Kbd on top, Tab/Enter below. Reading order
  // therefore starts at Esc, but Tab and Enter are the two people actually use.
  it('honours an explicit order over geometry inside a group', () => {
    const keys = [
      { ...ESC, order: 3 },
      { ...KB, order: 4 },
      { ...TAB, order: 1 },
      { ...ENTER, order: 2 }
    ]
    expect(navOrder(keys).map((x) => x.node)).toEqual(['tab', 'enter', 'esc', 'kb'])
  })

  it('sorts an ordered control ahead of an unordered one in the same group', () => {
    const mixed = [c('plain', at(10, 10), 'keys'), { ...c('ranked', at(500, 500), 'keys'), order: 9 }]
    expect(navOrder(mixed).map((x) => x.node)).toEqual(['ranked', 'plain'])
  })

  it('starts at the head of the ring when nothing is focused', () => {
    expect(pickNextFocus(null, DECK, 'right')).toBe('mic')
    expect(pickNextFocus(null, DECK, 'up')).toBe('mic')
  })

  it('stays put when there is nothing to move to', () => {
    expect(pickNextFocus(at(100, 100), [], 'up')).toBeNull()
    expect(pickNextFocus(null, [], 'up')).toBeNull()
  })

  it('never returns null while anything is on screen', () => {
    const only = [c('lonely', at(10, 10))]
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      expect(pickNextFocus(at(500, 500), only, dir)).toBe('lonely')
    }
  })
})

describe('isTextEntry — who owns the arrow keys', () => {
  it('keeps out of every text-entry field', () => {
    for (const type of ['text', 'email', 'password', 'search', 'tel', 'url', 'number']) {
      expect(isTextEntry({ tagName: 'INPUT', type })).toBe(true)
    }
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(true)
  })

  // A bare <input> is a text field per the spec, and the pairing code field is
  // one -- guessing "not text" here would eat a half-typed code.
  it('treats an input with no type as text', () => {
    expect(isTextEntry({ tagName: 'INPUT' })).toBe(true)
  })

  // The two that were wrongly refused: a checkbox got no pinch and a range got
  // no arrows, so on the glasses they were the only controls on screen that
  // could not be operated at all.
  it('lets the value controls through', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTextEntry({ tagName: 'INPUT', type: 'range' })).toBe(false)
  })

  it('ignores non-inputs entirely', () => {
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntry({ tagName: 'DIV' })).toBe(false)
  })
})

describe('resolveArrowAction — Left/Right open sections, nothing else', () => {
  // A swipe must NEVER flip a switch: Left on Screen sharing would kill the
  // mirror the user is navigating by, and undoing it needs the screen that just
  // went dark. Select owns switches. Arrows once did this -- keep it out.
  it('refuses to drive a checkbox in any direction', () => {
    const cb = { tagName: 'INPUT', type: 'checkbox' }
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      expect(resolveArrowAction(cb, dir)).toBe('step')
    }
  })

  it('never lets Up/Down do anything but move focus', () => {
    const cb = { tagName: 'INPUT', type: 'checkbox' }
    expect(resolveArrowAction(cb, 'up')).toBe('step')
    expect(resolveArrowAction(cb, 'down')).toBe('step')
  })

  // THE regression guard for this whole design. All three are <button>s that
  // the pinch already activates, so giving arrows a meaning here would ship a
  // second, invisible way to do what the HUD legend says `return` does.
  it('steps focus on a section header, a segmented option and a plain button', () => {
    for (const dir of ['left', 'right'] as const) {
      expect(resolveArrowAction({ tagName: 'BUTTON' }, dir)).toBe('step')
    }
  })

  // A range needs no action: once the INPUT decline is narrowed, the browser's
  // own arrow handling moves the thumb and SensitivitySlider's onKeyUp commits.
  it('steps on a range and lets the browser move the thumb', () => {
    expect(resolveArrowAction({ tagName: 'INPUT', type: 'range' }, 'right')).toBe('step')
  })

  it('steps on anything it does not recognise — no swipe is ever dead', () => {
    expect(resolveArrowAction({ tagName: 'DIV' }, 'left')).toBe('step')
    expect(resolveArrowAction({ tagName: 'A' }, 'right')).toBe('step')
    expect(resolveArrowAction({ tagName: 'INPUT', type: 'color' }, 'right')).toBe('step')
  })

  it('steps on a disabled checkbox rather than pretending to set it', () => {
    expect(resolveArrowAction({ tagName: 'INPUT', type: 'checkbox', disabled: true }, 'right')).toBe(
      'step'
    )
  })

  const header = (expanded: boolean): AdjustTarget => ({
    tagName: 'BUTTON',
    ariaExpanded: String(expanded)
  })

  it('Right opens a collapsed section, Left shuts an open one', () => {
    expect(resolveArrowAction(header(false), 'right')).toBe('expand')
    expect(resolveArrowAction(header(true), 'left')).toBe('collapse')
  })

  // The other two are the no-ops, and they must stay steps or a section
  // becomes a trap: Right on an open header has to walk INTO it, and Left on a
  // closed one has to leave, or the ring stalls on that header forever.
  it('steps rather than re-applying a state the section is already in', () => {
    expect(resolveArrowAction(header(true), 'right')).toBe('step')
    expect(resolveArrowAction(header(false), 'left')).toBe('step')
  })

  it('leaves Up/Down alone on a header — those are pure traversal', () => {
    for (const dir of ['up', 'down'] as const) {
      expect(resolveArrowAction(header(false), dir)).toBe('step')
      expect(resolveArrowAction(header(true), dir)).toBe('step')
    }
  })

  it('ignores aria-expanded on a disabled header', () => {
    expect(resolveArrowAction({ ...header(false), disabled: true }, 'right')).toBe('step')
  })
})
