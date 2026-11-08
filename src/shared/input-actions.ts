// input-actions.ts — the typed vocabulary of "human hands" MightyMouse can
// synthesize on the user's machine. ONE source of truth for the verbs, shared by:
//   • the native binary's CLI contract (native/mm-input/MmInput.swift)
//   • the TS spawn wrapper (src/main/platform/macos/input.ts)
//   • the act system-prompt docs (src/shared/config.ts) that teach the agent
//     which commands it may run mid-loop.
//
// No magic strings: every verb lives in INPUT_VERB; an InputAction is a typed
// union, so a typo can't compile. To add a human action: add the verb here, the
// union member, a serializeAction case, and ONE case in MmInput.swift. Nothing
// else changes — the wrapper, the gate, and the IPC are untouched.

/** Scroll directions the wheel supports. Typed so callers can't pass garbage. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

/** The verb each action maps to — matches the `switch verb` in MmInput.swift. */
export const INPUT_VERB = {
  move: 'move',
  click: 'click',
  rightClick: 'rightclick',
  doubleClick: 'doubleclick',
  tripleClick: 'tripleclick',
  drag: 'drag',
  scroll: 'scroll',
  type: 'type',
  key: 'key',
  keyDown: 'keydown',
  keyUp: 'keyup',
  appTab: 'apptab',
  zoom: 'zoom',
  smartZoom: 'smartzoom'
} as const

export type InputVerb = (typeof INPUT_VERB)[keyof typeof INPUT_VERB]

/**
 * One human input action. Coordinates are LOGICAL SCREEN POINTS, origin top-left
 * (the screen.getCursorScreenPoint() / find-on-screen space) — the binary posts
 * matching global-display CGEvents, so no conversion happens anywhere in TS.
 */
export type InputAction =
  | { verb: 'move'; x: number; y: number }
  | { verb: 'click'; x: number; y: number }
  | { verb: 'rightclick'; x: number; y: number }
  | { verb: 'doubleclick'; x: number; y: number }
  | { verb: 'tripleclick'; x: number; y: number }
  | { verb: 'drag'; x1: number; y1: number; x2: number; y2: number }
  | { verb: 'scroll'; direction: ScrollDirection; amount: number }
  | { verb: 'type'; text: string }
  // One combo, or several pressed in order inside a SINGLE spawn. A sequence
  // (tmux's ctrl+b then z) must not be two spawns: ~49ms each, they can land out
  // of order, and a lost second one strands the app mid-prefix. mm-input walks
  // the list, leaving modifier state empty between combos.
  | { verb: 'key'; combo: string | readonly string[] }
  | { verb: 'keydown'; key: string }
  | { verb: 'keyup'; key: string }
  // Whole Cmd+Tab cycle in ONE spawn. Not decomposable into keydown/key/keyup
  // calls -- each spawn posts from its own event source, which macOS scores as
  // a fresh Cmd+Tab toggle rather than an advance inside a live switcher
  // session (measured: 2 spawned taps land back on the same app).
  | { verb: 'apptab'; steps: number }
  // Zoom the frontmost app by whole notches, + = in. Implemented as Cmd-scroll,
  // NOT a magnify gesture -- macOS exposes no public way to synthesize a real
  // pinch, so this reaches apps that bind Cmd-scroll (browsers, Preview, Maps,
  // editors) and nothing else. Same caveat for smartzoom, which is Cmd+0.
  | { verb: 'zoom'; steps: number }
  | { verb: 'smartzoom' }

/** Round + stringify a coord (the binary parses Double but we pass whole points). */
const n = (v: number): string => String(Math.round(v))

/**
 * Turn a typed action into the argv array passed to `mm-input`. The single place
 * the action shape → CLI args mapping lives, so the wrapper and the binary can
 * never drift. Exhaustive switch: a new union member that isn't handled fails the
 * typecheck (the `never` assertion at the end).
 */
export function serializeAction(a: InputAction): string[] {
  switch (a.verb) {
    case 'move':
    case 'click':
    case 'rightclick':
    case 'doubleclick':
    case 'tripleclick':
      return [a.verb, n(a.x), n(a.y)]
    case 'drag':
      return [a.verb, n(a.x1), n(a.y1), n(a.x2), n(a.y2)]
    case 'scroll':
      return [a.verb, a.direction, n(a.amount)]
    case 'type':
      return [a.verb, a.text]
    case 'key':
      return typeof a.combo === 'string' ? [a.verb, a.combo] : [a.verb, ...a.combo]
    case 'keydown':
    case 'keyup':
      return [a.verb, a.key]
    case 'apptab':
    case 'zoom':
      return [a.verb, n(a.steps)]
    case 'smartzoom':
      return [a.verb]
    default: {
      // Exhaustiveness guard — adding a union member without a case fails here.
      const _never: never = a
      return _never
    }
  }
}
