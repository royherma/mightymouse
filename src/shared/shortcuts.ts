// ── Global shortcuts — THE single source of truth ───────────────────────────
//
// One typed registry, keyed by ShortcutId. Each row carries BOTH:
//   • the structured key combo (modifiers + libuiohook keycode + display glyph)
//   • the cheat-sheet copy (title / desc / tips)
//
// Two consumers read the SAME row, so nothing is ever hand-duplicated:
//   • src/main/capture/capture-hotkey.ts  — registers `key` (+ `aliases`)
//   • src/renderer/src/CheatSheetApp.tsx   — renders comboGlyphs(row)
//
// The visible "Cmd+Opt+Shift+;" string is DERIVED (comboGlyphs), never stored —
// change a glyph or keycode here and both the registration and the cheat sheet
// follow. This shape is also the seam for user-customizable hotkeys later: a
// future PREFS override would just swap a row's { mods, key, glyph } at runtime.

import { CONFIG } from './config'

// Modifier set shared by every shortcut (Cmd+Opt+Shift). Kept as a named const
// so a future per-shortcut override can diverge without touching the others.
export interface Mods {
  meta: boolean
  alt: boolean
  shift: boolean
  ctrl?: boolean // only the lighter aliases set this; BASE_MODS leaves it undefined
}
export const BASE_MODS: Mods = { meta: true, alt: true, shift: true }
// Lighter, single-modifier set for power-user aliases that want fewer keys than
// the BASE_MODS chord (e.g. Ctrl+Space → listen). Lives here so the alias and
// the cheat sheet derive from one definition.
export const CTRL_ONLY_MODS: Mods = { meta: false, alt: false, shift: false, ctrl: true }

// Display glyphs for the modifier keys, in render order. Paired with each
// shortcut's own `glyph` to build the key-cap row in the cheat sheet.
const MOD_GLYPHS: Array<{ on: (m: Mods) => boolean; glyph: string }> = [
  { on: (m) => m.meta, glyph: 'Cmd' },
  { on: (m) => !!m.ctrl, glyph: 'Ctrl' },
  { on: (m) => m.alt, glyph: 'Opt' },
  { on: (m) => m.shift, glyph: 'Shift' }
]

// libuiohook keycodes (VC_*). The ONE place a physical key maps to a number.
export const VC = {
  O: 24,
  SEMICOLON: 39,
  L: 38,
  SPACE: 57,
  H: 35,
  M: 50,
  S: 31,
  C: 46,
  D: 32,
  E: 18,
  G: 34,
  J: 36,
  I: 23,
  K: 37, // the navigator chord (⌘⌥⇧K)
  V: 47,
  R: 19,
  P: 25, // the stop / kill-switch chord (⌘⌥⇧P) — moved off K when the navigator took it
  T: 20,
  Y: 21,
  // Number-row digits 1/2/3 — the suggestion-accept chords (⌘⌥⇧1/2/3).
  ONE: 2,
  TWO: 3,
  THREE: 4,
  // Physical modifier keys (left/right pairs). uiohook's e.metaKey/altKey/
  // shiftKey flags lag one event behind the modifier's OWN keydown/keyup, so
  // anything that wants live "is this modifier held?" state (the tour's cap
  // feedback) must track these keycodes physically instead of trusting flags.
  SHIFT_L: 42,
  SHIFT_R: 54,
  ALT_L: 56,
  ALT_R: 3640,
  META_L: 3675,
  META_R: 3676
} as const

// macOS symbol glyphs for the modifier caps (⌘⌥⇧⌃). The cheat sheet keeps the
// word form from MOD_GLYPHS ('Cmd') for readability; the tour's key caps use
// these so the caps match the "Hold ⌘⌥⇧" copy underneath them.
export const MAC_MOD_GLYPHS: Record<string, string> = {
  Cmd: '⌘',
  Ctrl: '⌃',
  Opt: '⌥',
  Shift: '⇧'
}

export type ShortcutId =
  | 'rewrite'
  | 'capture'
  | 'listen'
  | 'main'
  | 'chat'
  | 'suggest'
  | 'selectionBar'
  | 'stop'
  | 'navigator'
  | 'voice'
  | 'reply'
  | 'canvas'

export interface Shortcut {
  id: ShortcutId
  mods: Mods
  key: number // primary libuiohook keycode (drives registration)
  aliases?: number[] // extra keycodes that fire the same action under the SAME mods (e.g. Space → listen)
  // Aliases that use a DIFFERENT modifier set than `mods` (e.g. Ctrl+Space → listen).
  // Each carries its own mods + key so the watcher can match them before the
  // BASE_MODS gate. Kept separate from `aliases` (which reuse `mods`).
  comboAliases?: Array<{ mods: Mods; key: number; glyph: string }>
  // Display cap for the primary key (e.g. ';' or 'O'). ONE key, nothing else:
  // this string is rendered inside a fixed-size square cap, so a parenthetical
  // like "L (or Space)" overflows it and spills onto the copy below. Alternate
  // ways to fire the same action go in `altHint`.
  glyph: string
  // Prose hint for the OTHER ways to fire this shortcut, shown next to the cap
  // rather than inside it (e.g. 'or Space, Ctrl+Space'). Cheat-sheet copy —
  // never rendered on a cap.
  altHint?: string
  // A single un-modified key that fires this same action (fn → listen). When the
  // user has it enabled, the tour teaches THIS instead of the chord: one cap, no
  // hold-then-tap gate. Its own hint replaces altHint there, since the chord
  // becomes the alternate rather than the main event.
  solo?: { glyph: string; altHint: string; prefKey: 'fnListenEnabled' }
  // The word the letter stands for, so the key is memorable instead of arbitrary
  // ('L is for Listen'). Must actually start with `glyph` — a mnemonic that
  // doesn't share the letter is worse than none.
  mnemonic?: string
  hidden?: boolean // registered + working, but not shown in the cheat sheet / tour
  title: string
  desc: string
  tips: string
}

// Order = render order in the cheat sheet / tray. `hidden` rows still register
// (the key works) but are filtered out of display — see VISIBLE_SHORTCUTS.
export const SHORTCUTS: Shortcut[] = [
  {
    id: 'main',
    mods: BASE_MODS,
    key: VC.M,
    glyph: 'M',
    // Not CONFIG.BRAND_NAME: that renders "MightyMouse Staging" on staging builds,
    // and the mnemonic only works as the single word the M stands for.
    mnemonic: 'Mighty',
    title: `Open ${CONFIG.BRAND_NAME}`,
    desc: 'Open the main panel. Grabs your selected text and context if you have any.',
    tips: 'Quick way to start a fresh ask/act, with or without selecting something first.'
  },
  {
    id: 'chat',
    mods: BASE_MODS,
    key: VC.C,
    glyph: 'C',
    mnemonic: 'Chat',
    title: 'Open full chat',
    desc: 'Open the big chat window. Type or talk, and see your past chats.',
    tips: 'The panel is for quick asks; this is for a real back-and-forth or building something.'
  },
  {
    // `;` does the same thing as `M` (open panel + grab context), so we keep it
    // working as a power-user alias but hide it from the cheat sheet to avoid
    // showing two keys for one outcome.
    id: 'rewrite',
    mods: BASE_MODS,
    key: VC.SEMICOLON,
    glyph: ';',
    hidden: true,
    title: 'Rewrite / Ask / Act',
    desc: 'Open the panel near your cursor. Auto-captures selected text + app/URL context.',
    tips: 'Type an instruction to rewrite. Start with ? to ask. Start with ! to run an action.'
  },
  {
    id: 'capture',
    mods: BASE_MODS,
    key: VC.O,
    glyph: 'O',
    mnemonic: 'Observe',
    title: 'Capture',
    desc: 'Tap for a screenshot. Hold to start recording (screen + mic + events).',
    tips: 'Press again while recording to stop and auto-transcribe.'
  },
  {
    id: 'listen',
    mods: BASE_MODS,
    key: VC.L,
    aliases: [VC.SPACE],
    comboAliases: [{ mods: CTRL_ONLY_MODS, key: VC.SPACE, glyph: 'Space' }],
    glyph: 'L',
    altHint: 'or fn, Space, Ctrl+Space',
    solo: { glyph: 'fn', altHint: 'or Cmd+Opt+Shift+L, Ctrl+Space', prefKey: 'fnListenEnabled' },
    mnemonic: 'Listen',
    title: 'Listen / Transcribe',
    desc: 'Press to start recording mic-only (saves context). Press again to stop, transcribe, and auto-copy the text to your clipboard.',
    tips:
      (CONFIG.LISTEN_DOUBLE_TAP_HANDS_FREE
        ? 'Double-tap to go hands-free: keep talking, and every time you pause it types where your cursor is. Tap once to stop. '
        : '') +
      'With Action routing set to With a button, hold fn and tap Option while you record and the list of places to send it opens by itself.'
  },
  {
    id: 'suggest',
    mods: BASE_MODS,
    key: VC.S,
    glyph: 'S',
    mnemonic: 'Suggest',
    title: 'Suggest a move',
    desc: 'Pop a suggestion bubble for whatever you are looking at right now. Reads the screen, your selection, and what it knows about you.',
    tips: 'Stuck in an email or a doc? Hit this for the best next move, then ⌘⌥⇧1/2/3 to run one.'
  },
  {
    id: 'selectionBar',
    mods: BASE_MODS,
    key: VC.T,
    glyph: 'T',
    mnemonic: 'Text',
    hidden: !CONFIG.SELECTION_BAR.ENABLED,
    title: 'Fix my text',
    desc: 'Pop a little bar right by your cursor with one-tap fixes: clean up the spelling, make it shorter, make it read better, or just ask.',
    tips: 'Select some text first and it works on that. Press again to send the bar away.'
  },
  {
    id: 'navigator',
    mods: BASE_MODS,
    key: VC.K,
    glyph: 'K',
    mnemonic: 'Keys',
    title: 'Find anything',
    desc: 'One search box for everything MightyMouse does. Start typing what you want - listen, draw, settings, an old chat - and hit Enter.',
    tips: 'The fastest way in when you cannot remember a shortcut. It shows you the keys as you go, so you learn them by using it.'
  },
  {
    id: 'stop',
    mods: BASE_MODS,
    key: VC.P,
    glyph: 'P',
    mnemonic: 'Panic',
    title: 'Stop the agent',
    desc: 'Halt a running action right away. Kills whatever the agent is doing on your screen.',
    tips: 'Your panic button. Hit it any time an act run is going and you want it to stop now.'
  },
  {
    id: 'voice',
    mods: BASE_MODS,
    key: VC.V,
    glyph: 'V',
    mnemonic: 'Voice',
    hidden: true,
    title: 'Voice mode on or off',
    desc: 'Turn on hands-free voice. Say "hey Mighty" and what you want, and it does it on your Mac.',
    tips: 'Press again to turn it off. Esc or saying "stop" stops a running task without turning voice off.'
  },
  {
    id: 'reply',
    mods: BASE_MODS,
    key: VC.Y,
    glyph: 'Y',
    mnemonic: 'Yes',
    title: 'Reply to an agent',
    desc: 'Pop a small window over whatever you are looking at, already on the agent that made it, so you can read it and answer.',
    tips: 'Press again to send it away. Pin it to stay on one agent.'
  },
  {
    id: 'canvas',
    mods: BASE_MODS,
    key: VC.I,
    glyph: 'I',
    mnemonic: 'Idea',
    hidden: true,
    title: 'Open Canvas',
    desc: 'Say or type anything. It files itself under the right project and shows you what it did.',
    tips: 'Press again or Esc to put it away. Everything you added is still there next time.'
  }
]

// Display subset: the cheat sheet, tray, and tour render THESE, not the raw
// registry. Hidden rows (e.g. the `;` alias) stay registered but unlisted.
export const VISIBLE_SHORTCUTS: Shortcut[] = SHORTCUTS.filter((s) => !s.hidden)

// Look up a shortcut by id (typed — no stringly-keyed misses).
export function getShortcut(id: ShortcutId): Shortcut {
  const s = SHORTCUTS.find((x) => x.id === id)
  if (!s) throw new Error(`Unknown shortcut id: ${id}`)
  return s
}

// Display key caps for a shortcut: modifier glyphs + the key glyph. Drives the
// cheat sheet's <Kbd> caps. e.g. ['Cmd', 'Opt', 'Shift', ';'].
export function comboGlyphs(s: Shortcut): string[] {
  const mods = MOD_GLYPHS.filter((m) => m.on(s.mods)).map((m) => m.glyph)
  return [...mods, s.glyph]
}
