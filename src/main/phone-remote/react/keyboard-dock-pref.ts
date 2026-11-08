// keyboard-dock-pref.ts — which edge the virtual keyboard hugs.
//
// Same idea as iOS's one-handed keyboard: full-width is the default, but the
// header toggle (VirtualKeyboard.tsx) can squash the board toward the left or
// right edge so it stops covering the whole touchpad — especially in
// landscape, where a full-width board eats the entire screen. The uncovered
// side stays live touchpad (the keyboard deliberately has no scrim).
//
// Phone-local (localStorage), same reasoning as virtual-keyboard-pref.ts:
// which corner of YOUR screen the keyboard sits in is a property of the phone
// in your hand, not config worth round-tripping to the Mac.

export type KeyboardDock = 'left' | 'full' | 'right'

const KEYBOARD_DOCK_PREF_KEY = 'mm-remote-keyboard-dock'

export function getKeyboardDock(): KeyboardDock {
  try {
    const v = localStorage.getItem(KEYBOARD_DOCK_PREF_KEY)
    // Absence or anything unrecognized means full-width — the default board.
    return v === 'left' || v === 'right' ? v : 'full'
  } catch {
    return 'full'
  }
}

export function setKeyboardDock(dock: KeyboardDock): void {
  try {
    localStorage.setItem(KEYBOARD_DOCK_PREF_KEY, dock)
  } catch {
    // Private mode / storage disabled — the in-memory choice still applies
    // for this session, which is the best available behavior.
  }
}
