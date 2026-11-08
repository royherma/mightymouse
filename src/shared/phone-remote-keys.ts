// phone-remote-keys.ts — the shared key/modifier vocabulary for the phone
// remote's pressKey path.
//
// Why this lives in src/shared/: the phone-remote React bundle is a standalone
// Vite build that may ONLY import src/shared (see react/vite.config.ts), while
// the server (src/main/phone-remote/server.ts) and the IPC handler
// (src/main/ipc/phone-remote.ts) live in src/main. This is the one home all
// three can import, so the wire union, the layout data, and the server-side
// validation all reference the same literals — a key name typo can't compile,
// and a hand-crafted network message can't smuggle an arbitrary string into an
// mm-input spawn (see isPhoneRemoteKeyName below).
//
// Every PhoneRemoteKeyName maps 1:1 to an entry in mm-input's keyCodes table
// (native/mm-input/MmInput.swift) — extend BOTH or the key exits 2 at the
// binary. Modifiers likewise mirror mm-input's modifierFlags table.

/** Modifier keys the phone can hold onto a combo. Mirrors mm-input's
 *  modifierFlags: these become CGEventFlags on the base key's event. */
export const PHONE_REMOTE_MODIFIERS = ['cmd', 'ctrl', 'option', 'shift', 'fn'] as const
export type PhoneRemoteModifier = (typeof PHONE_REMOTE_MODIFIERS)[number]

/** Every base key the phone may ask the Mac to press (alone or under
 *  modifiers). Letters/digits/punctuation are their literal character —
 *  mm-input keys its table by the same literals, and parseCombo splits on '+'
 *  so any single non-'+' character is a valid token. */
export const PHONE_REMOTE_KEY_NAMES = [
  // prettier-ignore
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`', '§',
  'return', 'tab', 'space', 'delete', 'escape',
  'left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'
] as const
export type PhoneRemoteKeyName = (typeof PHONE_REMOTE_KEY_NAMES)[number]

const KEY_NAME_SET: ReadonlySet<string> = new Set(PHONE_REMOTE_KEY_NAMES)
const MODIFIER_SET: ReadonlySet<string> = new Set(PHONE_REMOTE_MODIFIERS)

/** Runtime guard for network input. The WS layer only casts inbound JSON
 *  (`JSON.parse(...) as PhoneRemoteMessage`), so the pressKey handler must
 *  prove the strings are ours before they reach a spawned mm-input. */
export function isPhoneRemoteKeyName(value: unknown): value is PhoneRemoteKeyName {
  return typeof value === 'string' && KEY_NAME_SET.has(value)
}

export function isPhoneRemoteModifier(value: unknown): value is PhoneRemoteModifier {
  return typeof value === 'string' && MODIFIER_SET.has(value)
}

/**
 * tmux prefix actions the phone can fire as ONE tap.
 *
 * Each is a two-keystroke sequence — the prefix (ctrl+b), then a second key
 * tmux interprets. The phone sends the ACTION, never the two keys: the pair
 * must arrive in order with the shell processing the prefix before the second
 * key, and a network gap between two separate pressKey messages leaves tmux
 * sitting in prefix mode waiting for a key that may never come. The Mac paces
 * the pair (see the tmuxAction case in ipc/phone-remote.ts).
 *
 * Values are the SECOND key, so the handler needs no lookup table — it presses
 * the prefix, then this. Every value must be a PhoneRemoteKeyName.
 */
export const TMUX_ACTION = {
  /** Toggle the focused pane fullscreen — tmux's `resize-pane -Z`. */
  zoom: 'z',
  paneLeft: 'left',
  paneRight: 'right',
  paneUp: 'up',
  paneDown: 'down'
} as const
export type TmuxAction = keyof typeof TMUX_ACTION

/** The prefix every TMUX_ACTION is sent under. tmux's default bind; a user who
 *  remapped it would need this configurable, which no one has asked for. */
export const TMUX_PREFIX_KEY: PhoneRemoteKeyName = 'b'
export const TMUX_PREFIX_MODIFIER: PhoneRemoteModifier = 'ctrl'

const TMUX_ACTION_SET: ReadonlySet<string> = new Set(Object.keys(TMUX_ACTION))

/** Runtime guard for network input — same contract as isPhoneRemoteKeyName:
 *  the WS layer only casts, so prove it before it reaches a spawned mm-input. */
export function isTmuxAction(value: unknown): value is TmuxAction {
  return typeof value === 'string' && TMUX_ACTION_SET.has(value)
}

/** NOT keys: ctrl+arrow is consumed by WindowServer above mm-input's HID tap,
 *  so it exits 0 and does nothing. The Mac maps the Mission Control pair to
 *  `open -a` and `escape` instead (docs/gotchas.md), and smartZoom to ⌘0 —
 *  macOS exposes no synthesizable two-finger-double-tap. */
export const PAD_GESTURES = ['missionControl', 'closeMissionControl', 'smartZoom'] as const
export type PadGesture = (typeof PAD_GESTURES)[number]

/** Zoom notches one padZoom message may carry. One gesture frame is a few at
 *  most; the cap stops a malformed or replayed frame from slamming the zoom to
 *  its limit in a single message. Enforced host-side — the phone is untrusted. */
export const PAD_ZOOM_MAX_STEPS = 6

const PAD_GESTURE_SET: ReadonlySet<string> = new Set(PAD_GESTURES)

/** Runtime guard for network input — same contract as isTmuxAction. */
export function isPadGesture(value: unknown): value is PadGesture {
  return typeof value === 'string' && PAD_GESTURE_SET.has(value)
}

/** What kind of physical keyboard the HOST machine has — sent to the phone in
 *  the layoutPrefs event so the virtual keyboard can mirror it (Roy: "the auto
 *  keyboard will be based on the same keyboard of the device"). ANSI and ISO are
 *  genuinely different boards, not localizations: ISO has one extra key left of
 *  Z, so drawing 'mac' at an ISO user hides a key they reach for. 'generic' is
 *  the typed fallback a non-Mac host (or an older Mac build, which only ever
 *  sends 'mac') resolves to. Adding a host type = a member here + one
 *  KEYBOARD_LAYOUT_FOR_HOST entry (react/keyboard-layouts.ts). */
export const HOST_KEYBOARD = {
  /** ANSI — the US board, no key between left Shift and Z. */
  mac: 'mac',
  /** ISO — European/international, with the extra §/± key left of Z. */
  macIso: 'mac-iso',
  generic: 'generic'
} as const
export type HostKeyboard = (typeof HOST_KEYBOARD)[keyof typeof HOST_KEYBOARD]

export const MAC_FRAME = {
  pro: 'macbook-pro',
  air: 'macbook-air',
  desktop: 'desktop'
} as const
export type MacFrame = (typeof MAC_FRAME)[keyof typeof MAC_FRAME]

export interface HostDevice {
  frame: MacFrame
  name: string
  notch: boolean
}

const DESKTOP_NAMES = ['iMac', 'Mac mini', 'Mac Studio', 'Mac Pro']
const NO_NOTCH_NEW_LAPTOPS = new Set(['Mac14,7'])

export function hostDeviceFrom(machineName: string, model: string): HostDevice {
  const name = machineName.trim() || 'Mac'
  if (DESKTOP_NAMES.some((d) => name.startsWith(d))) {
    return { frame: MAC_FRAME.desktop, name, notch: false }
  }
  const frame = name.includes('Air') ? MAC_FRAME.air : MAC_FRAME.pro
  const generation = /^Mac(\d+),/.exec(model)
  const notch =
    model.startsWith('MacBookPro18,') ||
    (generation !== null && Number(generation[1]) >= 14 && !NO_NOTCH_NEW_LAPTOPS.has(model))
  return { frame, name, notch }
}

/** First byte of every Mac→phone binary frame, so a second stream can share the
 *  socket. Until this existed H.264 was the only binary on the wire and the
 *  phone told it from JSON by type alone; audio would have been fed straight
 *  into the video decoder. Prefixed on both streams -- an untagged frame is not
 *  a video frame, it's an older Mac, and the phone drops it rather than
 *  guessing. */
export const PIP_BINARY_KIND = {
  video: 0x01,
  audio: 0x02
} as const
export type PipBinaryKind = (typeof PIP_BINARY_KIND)[keyof typeof PIP_BINARY_KIND]

const PIP_BINARY_KINDS: ReadonlySet<number> = new Set(Object.values(PIP_BINARY_KIND))

/** Split a tagged frame back into kind + payload. Returns null for anything the
 *  reader must not act on -- a frame too short to hold both parts, or a kind
 *  this build doesn't know (an older/newer Mac). Both would otherwise reach a
 *  decoder as if they were video. */
export function readPipBinary(buf: ArrayBuffer): { kind: PipBinaryKind; payload: Uint8Array } | null {
  if (buf.byteLength < 2) return null
  const kind = new Uint8Array(buf, 0, 1)[0]
  if (!PIP_BINARY_KINDS.has(kind)) return null
  return { kind: kind as PipBinaryKind, payload: new Uint8Array(buf, 1) }
}

/**
 * Validate a written combo ("cmd+shift+v") against the vocabulary above and
 * return it normalised, or null.
 *
 * Exists because a hotkey typed by a user is the same untrusted string as one
 * off the wire — it reaches a spawned mm-input either way. Modifiers are
 * emitted in PHONE_REMOTE_MODIFIERS order so two spellings of one chord store
 * as one value; the base key is required and must be last.
 */
export function parseKeyCombo(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts = value.toLowerCase().trim().split('+').filter(Boolean)
  if (parts.length < 2) return null
  const base = parts[parts.length - 1]
  if (!isPhoneRemoteKeyName(base)) return null
  const mods = parts.slice(0, -1)
  if (!mods.every(isPhoneRemoteModifier)) return null
  // Against the RAW length, not a deduped one -- 'cmd+cmd+v' must not quietly
  // normalise to 'cmd+v'. A combo the user cannot have typed is a combo we
  // cannot be sure matches what they bound in the other app.
  const ordered = PHONE_REMOTE_MODIFIERS.filter((m) => mods.includes(m))
  if (ordered.length !== mods.length) return null
  return [...ordered, base].join('+')
}
