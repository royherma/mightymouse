// keyboard-layouts.ts — the on-screen virtual keyboard's layouts as DATA, not JSX.
//
// The user's brief (voice note phone:e075659a, then V2 2026-07-24): "the auto
// keyboard will be based on the same keyboard of the device... I have a
// MacBook Pro... I want to have the exact same keyboard. It's very critical."
// v1 shipped one generic QWERTY behind a seam built for exactly this; V2 adds
// the Mac layout and the host→layout mapping. VirtualKeyboard.tsx and its
// send-path (App.tsx) stay layout-agnostic: they only ever walk whatever
// KeyboardLayout the caller hands them.
//
// Adding a THIRD layout (Windows host, ISO variant, ...) = a KeyboardLayoutId
// member + a KEYBOARD_LAYOUTS entry + (if host-driven) a KEYBOARD_LAYOUT_FOR_HOST
// row once the host reports the new HostKeyboard value. Nothing else changes.
//
// HOW KEYS REACH THE MAC: plain letters/digits/symbols go through the
// 'typeText' Unicode path (no keycode table needed — see VirtualKeyboard.tsx's
// header). Named keys (return, arrows, F-row) and ANY key pressed while a
// modifier is armed go through 'pressKey', whose vocabulary is the shared
// PhoneRemoteKeyName union (src/shared/phone-remote-keys.ts) mirroring
// mm-input's keyCodes table 1:1.

import type { PhoneRemoteKeyName, PhoneRemoteModifier, HostKeyboard } from '@shared/phone-remote-keys'

/** One key's two faces (plain / shifted) plus how wide it draws relative to a
 *  standard 1-unit letter key. */
export type KeyDef = {
  /** What the key sends with Shift off. */
  lower: string
  /** What the key sends with Shift on. Equal to `lower` for keys Shift doesn't
   *  affect -- required (not optional) so a layout author can't forget to
   *  decide, and the renderer never falls back. */
  upper: string
  /** What's printed on the cap. Usually `lower`; control keys show a glyph or
   *  short label instead of what they send. */
  display: string
  /** Relative width in "1 letter key" units (flex-grow within the row). */
  width: number
  /** How this key reaches the Mac. 'char' sends literal text via typeText
   *  (or a pressKey combo when a modifier is held). 'backspace' sends one
   *  deleteText (or a cmd/option+delete combo). 'special' sends its
   *  PhoneRemoteKeyName via pressKey. 'shift' and 'modifier' (cmd/ctrl/
   *  option/fn) are HOLD keys -- active only while a finger is on them, every
   *  key tapped during the hold rides them as a combo. 'capslock' is the one
   *  latching toggle, matching its physical counterpart. All client-side. */
  action: 'char' | 'backspace' | 'special' | 'shift' | 'capslock' | 'modifier'
  /** Only for action:'special' -- which key to press. */
  specialKey?: PhoneRemoteKeyName
  /** Only for action:'modifier' -- which modifier this key arms. */
  modifier?: PhoneRemoteModifier
  /** The key's name on the pressKey path when a modifier is armed, for 'char'
   *  keys whose `lower` is not itself a PhoneRemoteKeyName (space: ' ' types a
   *  space but the combo token is 'space'). Letters/digits/punctuation need no
   *  override -- their literal character IS their key name. */
  comboKey?: PhoneRemoteKeyName
  /** True for letter keys: Caps Lock uppercases them, but NOT digits/symbols
   *  (caps lock on a real keyboard doesn't turn 1 into !). Derived by the
   *  key() helper, never hand-set. */
  letter?: boolean
}

const key = (lower: string, upper = lower.toUpperCase(), width = 1): KeyDef => ({
  lower,
  upper,
  display: lower,
  width,
  action: 'char',
  letter: /^[a-z]$/.test(lower)
})

const special = (specialKey: PhoneRemoteKeyName, display: string, width = 1): KeyDef => ({
  lower: specialKey,
  upper: specialKey,
  display,
  width,
  action: 'special',
  specialKey
})

const modifier = (mod: PhoneRemoteModifier, display: string, width = 1): KeyDef => ({
  lower: mod,
  upper: mod,
  display,
  width,
  action: 'modifier',
  modifier: mod
})

/** One row of keys, left to right. */
export type KeyRow = readonly KeyDef[]

/** A full layout: rows top to bottom. Purely data -- VirtualKeyboard.tsx just
 *  maps over `rows`. `dense` flags layouts whose rows run wider than ~10 units
 *  (the Mac's run 14+) so the CSS can drop key font/padding to fit. */
export type KeyboardLayout = {
  id: KeyboardLayoutId
  label: string
  rows: readonly KeyRow[]
  dense: boolean
}

/** Every layout id that exists. */
export const KEYBOARD_LAYOUT_ID = {
  qwertyGeneric: 'qwerty-generic',
  macUs: 'mac-us'
} as const
export type KeyboardLayoutId = (typeof KEYBOARD_LAYOUT_ID)[keyof typeof KEYBOARD_LAYOUT_ID]

/** Host machine → the layout that mirrors its physical keyboard. THE seam for
 *  "add more keyboards as we recognize more devices": when a new HostKeyboard
 *  value exists, its row here is the only routing change. */
export const KEYBOARD_LAYOUT_FOR_HOST: Record<HostKeyboard, KeyboardLayoutId> = {
  mac: KEYBOARD_LAYOUT_ID.macUs,
  // An ISO board has one extra key left of Z (§/±). It's detected and reported,
  // but deliberately NOT drawn -- the user has an ISO Mac and asked for it removed
  // after using it: the glyph reads as noise on a phone-sized cap, and the keys
  // he actually wanted turned out to be elsewhere on the board. Route ISO to the
  // ANSI layout rather than deleting the host value, so the finding survives and
  // drawing the key later is one layout away.
  'mac-iso': KEYBOARD_LAYOUT_ID.macUs,
  generic: KEYBOARD_LAYOUT_ID.qwertyGeneric
}

const SHIFT_KEY = (width: number): KeyDef => ({
  lower: 'shift',
  upper: 'shift',
  display: '⇧',
  width,
  action: 'shift'
})

const CAPS_LOCK_KEY: KeyDef = {
  lower: 'capslock',
  upper: 'capslock',
  display: '⇪',
  width: 1.8,
  action: 'capslock'
}

const BACKSPACE_KEY = (width: number): KeyDef => ({
  lower: 'backspace',
  upper: 'backspace',
  display: '⌫',
  width,
  action: 'backspace'
})

const SPACE_KEY = (width: number): KeyDef => ({
  lower: ' ',
  upper: ' ',
  display: 'space',
  width,
  action: 'char',
  comboKey: 'space'
})

/** A generic US QWERTY, three letter rows + a space bar row -- the fallback
 *  when the host's keyboard isn't recognized. Deliberately minimal; the
 *  host-mirrored layouts are where fidelity lives. */
const QWERTY_GENERIC: KeyboardLayout = {
  id: KEYBOARD_LAYOUT_ID.qwertyGeneric,
  label: 'QWERTY',
  dense: false,
  rows: [
    [key('q'), key('w'), key('e'), key('r'), key('t'), key('y'), key('u'), key('i'), key('o'), key('p')],
    [key('a'), key('s'), key('d'), key('f'), key('g'), key('h'), key('j'), key('k'), key('l')],
    [SHIFT_KEY(1.5), key('z'), key('x'), key('c'), key('v'), key('b'), key('n'), key('m'), BACKSPACE_KEY(1.5)],
    [SPACE_KEY(5), special('return', 'return', 1.8)]
  ]
}

/** The full US-ANSI MacBook keyboard, row for row: esc+F-row, number row,
 *  and the fn/control/option/command bottom row with arrows. Mirrors what's
 *  physically under the user's hands ("exact same keyboard. It's very critical"),
 *  so muscle-memory combos (⌘C, ⌘S, ⌥⌫) work from the phone. F-keys send
 *  plain F1-F12 (no media functions -- design non-goal). */
const MAC_US: KeyboardLayout = {
  id: KEYBOARD_LAYOUT_ID.macUs,
  label: 'Mac (US)',
  dense: true,
  rows: [
    [
      special('escape', 'esc', 1.5),
      special('f1', 'F1'), special('f2', 'F2'), special('f3', 'F3'), special('f4', 'F4'),
      special('f5', 'F5'), special('f6', 'F6'), special('f7', 'F7'), special('f8', 'F8'),
      special('f9', 'F9'), special('f10', 'F10'), special('f11', 'F11'), special('f12', 'F12')
    ],
    [
      key('`', '~'), key('1', '!'), key('2', '@'), key('3', '#'), key('4', '$'),
      key('5', '%'), key('6', '^'), key('7', '&'), key('8', '*'), key('9', '('),
      key('0', ')'), key('-', '_'), key('=', '+'), BACKSPACE_KEY(1.5)
    ],
    [
      special('tab', '⇥', 1.5),
      key('q'), key('w'), key('e'), key('r'), key('t'), key('y'), key('u'), key('i'),
      key('o'), key('p'), key('[', '{'), key(']', '}'), key('\\', '|')
    ],
    [
      CAPS_LOCK_KEY,
      key('a'), key('s'), key('d'), key('f'), key('g'), key('h'), key('j'), key('k'),
      key('l'), key(';', ':'), key("'", '"'), special('return', '⏎', 1.7)
    ],
    [
      SHIFT_KEY(2.3),
      key('z'), key('x'), key('c'), key('v'), key('b'), key('n'), key('m'),
      key(',', '<'), key('.', '>'), key('/', '?'), SHIFT_KEY(2.2)
    ],
    [
      modifier('fn', 'fn'),
      modifier('ctrl', '⌃'),
      modifier('option', '⌥'),
      modifier('cmd', '⌘', 1.25),
      SPACE_KEY(4.5),
      modifier('cmd', '⌘', 1.25),
      modifier('option', '⌥'),
      special('left', '←'), special('up', '↑'), special('down', '↓'), special('right', '→')
    ]
  ]
}

/** The one registry a layout id resolves through. */
export const KEYBOARD_LAYOUTS: Record<KeyboardLayoutId, KeyboardLayout> = {
  [KEYBOARD_LAYOUT_ID.qwertyGeneric]: QWERTY_GENERIC,
  [KEYBOARD_LAYOUT_ID.macUs]: MAC_US
}
