// virtual-keyboard-pref.ts — which keyboard the Keyboard pill OPENS.
//
// Off by default: the native-soft-keyboard trick (openKeyboard in App.tsx,
// which focuses a hidden <input> and lets iOS pop its own keyboard) gets
// autocorrect/emoji/dictation for free, so it stays the default rather than
// being silently replaced. Turning this ON swaps the same Keyboard pill
// (KeyPillGrid) over to the on-screen virtual keyboard -- one entry point, two
// behaviors, chosen in Settings. Not a second button: see DESIGN.md on not
// adding a second way to do something that already has one.
//
// THIS PREF HAS EXACTLY ONE WRITER: the Settings switch. It previously had
// three -- Settings plus the swap button each keyboard carries -- so a
// momentary action ("show me the other board for this sentence") rewrote the
// durable default. The user then hit the pill days later and got a keyboard
// they never chose, which on device reads as "it switches keyboards by itself".
// The swap buttons now move keyboard-state.ts's session-scoped mode instead and
// never touch this file.
//
// One writer also means no subscription machinery: nothing can change the value
// behind Settings' back, so a mount-time read is always current.
//
// Phone-local (localStorage), same reasoning as haptics.ts/debug-layout.ts:
// which typing UI you prefer is a property of the phone in your hand, not
// config worth round-tripping to the Mac.

const VIRTUAL_KEYBOARD_PREF_KEY = 'mm-remote-virtual-keyboard'

export function getVirtualKeyboardEnabled(): boolean {
  try {
    // Default OFF -- absence of the key means "never turned on".
    return localStorage.getItem(VIRTUAL_KEYBOARD_PREF_KEY) === 'on'
  } catch {
    return false
  }
}

export function setVirtualKeyboardEnabled(value: boolean): void {
  try {
    localStorage.setItem(VIRTUAL_KEYBOARD_PREF_KEY, value ? 'on' : 'off')
  } catch {
    // Private mode / storage disabled -- the in-memory toggle still applies
    // for this session, which is the best available behavior.
  }
}
