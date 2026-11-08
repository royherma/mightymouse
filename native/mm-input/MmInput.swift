// MmInput.swift — the unified "human hands" for MightyMouse. One native binary
// that synthesizes every real mouse + keyboard action via CGEvent (CoreGraphics),
// dispatched by a verb argument. Supersedes ClickHelper.swift + TypeHelper.swift
// (which are kept as thin re-exports for back-compat); add a new human action by
// adding ONE case here, nothing else.
//
// Consumer: src/main/macos/input.ts spawns this for the whole "act on screen"
// family — the opt-in "Let MightyMouse act for me" toggle (PREFS.getClickEnabled)
// + the Accessibility permission the app already checks. The act-mode `claude`
// agent ALSO calls this binary directly via its Bash tool, mid-loop, so it can
// scroll/click/drag/type, re-screenshot, and decide the next action.
//
// Why a native binary: macOS has no Electron API to synthesize real mouse/key
// events. CGEvent does, and a one-shot swiftc binary is the lightest bridge —
// same Pattern B as click-helper / type-helper / notch-info / ocr. The spawning
// process (the Electron app, or the `claude` CLI it spawns) must hold Accessibility
// trust for posted events to land; permissions.ts gates exactly that.
//
// Coordinate space: x,y are LOGICAL SCREEN POINTS, origin top-left — the same
// space as screen.getCursorScreenPoint(), the cursor overlay, and find-on-screen.
// CGEvent global-display coords match this, so no conversion happens here.
//
// Usage (verb + args):
//   mm-input move <x> <y>
//   mm-input moveloop                          # reads tagged lines from stdin, posts one CGEvent
//                                               # per line, exits on EOF/"quit" -- one long-lived
//                                               # process instead of a spawn per move (phone
//                                               # remote's trackpad is the only true per-frame
//                                               # hot path in the app; a spawn there costs
//                                               # ~70ms, more than the whole move-throttle
//                                               # window, which reads as jittery drag input).
//                                               # Line formats (space-separated):
//                                               #   x y            bare pair = plain move (legacy, still valid)
//                                               #   m x y          explicit move
//                                               #   dd x y         drag-down: press+hold left button at point
//                                               #   dm x y         drag-move: drag to point (button still held)
//                                               #   du x y         drag-up: release the held button at point
//                                               #   sc dy dx       scroll nudge (line units, no internal sleep --
//                                               #                  caller throttles by how often it writes a line).
//                                               #                  Prints "ok sc" once posted; moves print nothing.
//                                               #   quit           end the loop (also ends on stdin EOF)
//   mm-input click <x> <y>                     # left click
//   mm-input rightclick <x> <y>
//   mm-input doubleclick <x> <y>
//   mm-input tripleclick <x> <y>
//   mm-input drag <x1> <y1> <x2> <y2>          # press at 1, move to 2, release
//   mm-input scroll <up|down|left|right> <amount>   # amount = wheel "lines" (~3 per nudge)
//   mm-input type <text...>                    # literal Unicode text (joins remaining args with space)
//   mm-input key <combo>                       # e.g. cmd+a, return, cmd+shift+t
//   mm-input keydown <key>                     # press & HOLD a key (no release) — for shift-drag etc.
//   mm-input keyup <key>                        # release a held key
//   mm-input apptab <steps>                     # cmd+tab N apps back, one held session
// Output: "ok ..." on success (stdout); usage/arg error → exit 2; post failure → exit 1.

import Foundation
import CoreGraphics
// Carbon, only for KBGetLayoutType — the one API that reports whether the
// physical board is ANSI or ISO. No Cocoa/CG equivalent exists.
import Carbon

let src = CGEventSource(stateID: .hidSystemState)

func die(_ msg: String, _ code: Int32 = 2) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

// ── Mouse helpers ───────────────────────────────────────────────────────────

/// Move the real cursor to a point (no buttons). Lets a watching user — and the
/// flown overlay glyph — see where the action lands before a click fires.
func moveTo(_ pt: CGPoint) {
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
          mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
}

/// Post a press+release at `pt` for `button`, with `clickState` (1=single,
/// 2=double, 3=triple). Double/triple require the same point + the click-state
/// field set, or apps treat them as N separate single clicks.
func clickButton(_ pt: CGPoint, button: CGMouseButton, clickState: Int64) {
  let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
  moveTo(pt)
  usleep(60_000) // settle — lets the move render before the down/up
  for _ in 0..<clickState {
    if let d = CGEvent(mouseEventSource: src, mouseType: down, mouseCursorPosition: pt, mouseButton: button) {
      d.setIntegerValueField(.mouseEventClickState, value: clickState)
      d.post(tap: .cghidEventTap)
    }
    usleep(40_000)
    if let u = CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: pt, mouseButton: button) {
      u.setIntegerValueField(.mouseEventClickState, value: clickState)
      u.post(tap: .cghidEventTap)
    }
    usleep(40_000)
  }
}

/// Press the left button and hold it (no release) -- the first half of a
/// caller-driven drag session streamed line-by-line over moveloop, as opposed
/// to drag()'s single self-contained down->move->up call below.
func dragDown(_ pt: CGPoint) {
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
          mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
}

/// Post one leftMouseDragged event while the button is already held down --
/// the moveloop equivalent of moveTo() for an in-progress drag.
func dragMoveTo(_ pt: CGPoint) {
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged,
          mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
}

/// Release the left button held by dragDown() -- the second half of a
/// caller-driven drag session.
func dragUp(_ pt: CGPoint) {
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
          mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
}

/// Post one scroll-wheel nudge with no internal sleep loop -- unlike scroll()
/// below (a self-contained multi-nudge call meant for a one-shot spawn), this
/// is meant to be called once per moveloop line so the CALLER's own send-rate
/// (already throttled to ~30fps by the phone/IPC layer) sets the cadence.
func scrollNudge(dy: Int32, dx: Int32) {
  CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
          wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
}

/// Press at `from`, glide to `to` in steps (so the OS registers a real drag,
/// not a teleport), release. Steps + sleeps mirror a human drag so apps that
/// gate on intermediate move events (selection, sliders, reordering) work.
func drag(_ from: CGPoint, _ to: CGPoint) {
  moveTo(from)
  usleep(60_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
          mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(40_000)
  let steps = 24
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged,
            mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(8_000)
  }
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
          mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)
}

/// Scroll the wheel by `lines` in a direction. Line units (not pixels) match a
/// physical wheel notch, so apps interpret the amount sensibly. Positive Y =
/// content up / scroll down (CGEvent's wheel1 is inverted vs screen y).
func scroll(direction: String, lines: Int32) {
  var wheel1: Int32 = 0 // vertical
  var wheel2: Int32 = 0 // horizontal
  switch direction {
  case "down":  wheel1 = -lines
  case "up":    wheel1 =  lines
  case "left":  wheel2 =  lines
  case "right": wheel2 = -lines
  default: die("scroll direction must be up|down|left|right, got: \(direction)")
  }
  // Emit in small nudges so long scrolls animate smoothly and momentum-scroll
  // apps (Safari, most Mac apps) accept them, instead of one giant jump.
  let perStep: Int32 = 3
  var remaining = max(abs(wheel1), abs(wheel2))
  let vSign: Int32 = wheel1 == 0 ? 0 : (wheel1 > 0 ? 1 : -1)
  let hSign: Int32 = wheel2 == 0 ? 0 : (wheel2 > 0 ? 1 : -1)
  while remaining > 0 {
    let step = min(perStep, remaining)
    CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
            wheel1: vSign * step, wheel2: hSign * step, wheel3: 0)?.post(tap: .cghidEventTap)
    remaining -= step
    usleep(16_000) // ~one frame between nudges
  }
}

/// Zoom the frontmost app by `steps` notches (+ = in, - = out).
///
/// This is ⌘-held scroll, NOT a real magnify gesture. macOS delivers a physical
/// trackpad pinch as an NSEvent magnification with no public API to synthesize
/// it; the private kCGEventGesture (type 29) route was tried and rejected --
/// its fields set and read back cleanly, but the event is routed as a plain
/// scroll and never zooms.
/// before reaching for it again.
///
/// Consequence to keep in mind: this zooms anything bound to ⌘-scroll (Safari,
/// Chrome, Preview, Maps, VS Code) and nothing else -- notably not the system
/// Accessibility zoom.
func zoom(steps: Int32) {
  guard steps != 0 else { return }
  let sign: Int32 = steps > 0 ? 1 : -1
  // NO physical cmd keyDown/keyUp here, deliberately. Apps read the modifier off
  // the scroll event they're handling, so the flag alone is enough -- and a real
  // key press risks latching ⌘ system-wide if the release is coalesced away or
  // the process dies mid-loop (memory cgevent-modifier-release-coalesced). A
  // stuck ⌘ turns every later keystroke into a shortcut, which is far worse than
  // a zoom that doesn't fire.
  for _ in 0..<abs(steps) {
    if let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1,
                       wheel1: sign, wheel2: 0, wheel3: 0) {
      e.flags = .maskCommand
      e.post(tap: .cghidEventTap)
    }
    usleep(16_000) // ~one frame between notches
  }
  // Setting .maskCommand on a scroll event asserts cmd on the shared event
  // SOURCE, not just on that event: measured, a keystroke synthesized within
  // ~2s afterwards came out carrying cmd. It decays on its own, but "type right
  // after a pinch and your letters become shortcuts" is a real 2s window, so
  // close it explicitly rather than waiting it out.
  if let clear = CGEvent(keyboardEventSource: src, virtualKey: 0x37, keyDown: false) {
    clear.type = .flagsChanged
    clear.flags = []
    clear.post(tap: .cghidEventTap)
  }
}

/// Smart zoom: the two-finger double-tap on a real trackpad. ⌘0 (actual size)
/// is the closest public-API equivalent -- no synthesizable gesture exists.
func smartZoom() {
  pressKey("cmd+0")
}

// ── Keyboard helpers (shared with the old TypeHelper behavior) ───────────────

/// The FULL US-ANSI base-key table (letters, digits, punctuation, F-row, nav).
/// Originally this held only the ~13 keys shortcuts needed; the phone remote's
/// Mac-mirror keyboard (src/shared/phone-remote-keys.ts) now sends any base key
/// under a modifier, so every key it can draw must resolve here or the combo
/// dies with exit 2. Plain unmodified characters still go through `type`
/// (postUnicode) — this table is only consulted for the `key` combo path.
/// Punctuation is keyed by its literal character, matching the shared TS union.
let keyCodes: [String: CGKeyCode] = [
  "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "delete": 0x33,
  "escape": 0x35, "esc": 0x35, "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
  "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
  "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03, "g": 0x05,
  "h": 0x04, "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D,
  "o": 0x1F, "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11, "u": 0x20,
  "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10, "z": 0x06,
  "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17, "6": 0x16,
  "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,
  "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A, ";": 0x29,
  "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C, "`": 0x32,
  // ISO-only key, left of Z. Absent on ANSI boards, so it's keyed by the glyph
  // an ISO Mac produces there (§/±) rather than by a name ANSI users would look
  // for. Sending it to an ANSI Mac still posts 0x0A, which that layout maps to
  // whatever it maps to -- harmless, and only the ISO layout ever draws the key.
  "§": 0x0A,
  "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
  "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F
]

let modifierFlags: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand,
  "shift": .maskShift, "alt": .maskAlternate, "option": .maskAlternate,
  "ctrl": .maskControl, "control": .maskControl,
  // fn — best-effort: .maskSecondaryFn posts on the event, but whether
  // fn+arrow becomes Home/End is up to the focused app, not the system.
  "fn": .maskSecondaryFn
]

/// Virtual keycodes for the modifier keys THEMSELVES (left-hand variants). Held
/// modifiers are a different event shape than modified keys: `key cmd+tab` sets
/// .maskCommand as a *flag* on a Tab event, whereas holding Cmd across several
/// later keystrokes (Cmd+Tab+Tab app cycling) needs a real .flagsChanged event
/// for the Cmd key itself. parseCombo() can't produce these — it looks the last
/// token up in `keyCodes`, and "cmd" deliberately isn't there.
let modifierKeyCodes: [String: CGKeyCode] = [
  "cmd": 0x37, "command": 0x37,
  "shift": 0x38,
  "alt": 0x3A, "option": 0x3A,
  "ctrl": 0x3B, "control": 0x3B,
  "fn": 0x3F
]

/// Type one string as a Unicode payload (handles emoji/accents with no keymap).
func postUnicode(_ s: String) {
  guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { return }
  // A new CGEvent INHERITS the source's current modifier state, and a zoom's
  // cmd-flagged scroll events leave cmd asserted there for ~2s (measured). Text
  // typed inside that window would go out as ⌘-shortcuts, so state it as empty.
  down.flags = []
  up.flags = []
  var chars = Array(s.utf16)
  down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
  up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
  down.post(tap: .cghidEventTap)
  usleep(8_000)
  up.post(tap: .cghidEventTap)
}

/// Parse "cmd+shift+a" → (flags, base keycode). Exits 2 on an unknown base key.
func parseCombo(_ value: String) -> (CGEventFlags, CGKeyCode) {
  let parts = value.lowercased().split(separator: "+").map(String.init)
  guard let baseName = parts.last, let code = keyCodes[baseName] else {
    die("unknown key: \(value)")
  }
  var flags: CGEventFlags = []
  for p in parts.dropLast() { if let f = modifierFlags[p] { flags.insert(f) } }
  return (flags, code)
}

/// Walk the Cmd+Tab app switcher `steps` apps back, in ONE process.
///
/// Why this is a verb and not three calls from TS: the entire hold-tab-release
/// cycle must be posted from a single event source. Spawning `keydown cmd`,
/// then `key cmd+tab` twice, then `keyup cmd` was measured to land back on the
/// SAME app -- each spawn's own source makes macOS treat every Tab as a fresh
/// Cmd+Tab toggle instead of an advance within a live switcher session. Run
/// in-process, 2 steps genuinely reaches the 2nd app back.
///
/// Every Tab event carries .maskCommand explicitly. The held .flagsChanged
/// alone is not enough: each synthesized event carries its own flag state, so a
/// Tab posted with empty flags reads as a BARE Tab and does nothing.
///
/// Cmd is released on every path, including a bad argument -- a stranded Cmd
/// turns the user's next keystroke into a shortcut.
func appTab(_ steps: Int) {
  let cmdKey: CGKeyCode = 0x37
  let tabKey: CGKeyCode = 0x30
  // Cmd-down alone already highlights the 1st app back (index 1) before any
  // Tab is pressed -- that's how the real HUD behaves, and steps=1 needs ZERO
  // Tab presses. But for steps>=2, the FIRST real Tab press is absorbed as a
  // "wake the switcher HUD" event and doesn't advance the selection (the "first
  // Tab is swallowed" settle-timing comment below was masking this, not fixing
  // it) -- so steps=N needs N presses, not N-1, once N>=2. Verified live
  // 2026-07-19: `steps - 1` undercounted by exactly one for every N>=2 burst,
  // with zero exceptions across multiple independent taps.
  let tabPresses = steps <= 1 ? 0 : min(9, steps)

  func post(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, as type: CGEventType? = nil) {
    guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return }
    if let t = type { e.type = t }
    e.flags = flags
    e.post(tap: .cghidEventTap)
  }

  post(cmdKey, down: true, flags: .maskCommand, as: .flagsChanged)
  // The switcher needs a beat to come up or the first Tab is swallowed. This
  // is the single most timing-sensitive value here: too short and the whole
  // burst collapses into one advance, which reads as "it ignored my extra
  // taps". Measured to need well over 100ms when the Mac is busy (an Electron
  // app spawning us mid-render is exactly that case).
  usleep(180_000)
  for i in 0..<tabPresses {
    post(tabKey, down: true, flags: .maskCommand)
    usleep(45_000)
    post(tabKey, down: false, flags: .maskCommand)
    // Let the switcher's selection actually move before the next Tab. Skipped
    // after the final Tab -- that beat is covered by the pre-release settle.
    if i < tabPresses - 1 { usleep(120_000) }
  }
  // Settle BEFORE releasing Cmd. Without this the release can be processed
  // ahead of the trailing Tabs, committing the switch at whatever the
  // selection was early on -- the observed symptom being every multi-step
  // burst landing on the SAME app (index 1) no matter how many taps.
  usleep(140_000)
  // Releasing Cmd is what commits the switch.
  post(cmdKey, down: false, flags: [], as: .flagsChanged)
}

/// Press a key with modifiers, then release (a full combo / single key).
///
/// A modified combo is FIVE events, not two -- the same sandwich `appTab` uses:
///
///   flagsChanged(cmd, down) → t down[cmd] → t up[cmd] → flagsChanged(cmd, up)
///
/// Setting `.flags` on the key events alone is not enough, and clearing them on
/// the key-UP alone is not enough either. Two separate things read modifier
/// state and they read it differently:
///   • The FOCUSED APP scores a shortcut off the flags carried ON the key
///     event -- so both the down AND the up need the modifiers set, or the app
///     sees a bare `t` release after a ⌘T and can mis-handle the pair.
///   • The HID SYSTEM tracks a running modifier state that only moves on
///     .flagsChanged transitions. With no flagsChanged ever posted, that state
///     is driven by whatever the last key event's flags happened to be, and it
///     LATCHES: `key cmd+t` opened a tab, then a plain `t` opened another one,
///     and the user's PHYSICAL keyboard was cmd-modified too until they tapped
///     a real Cmd. Bit for real via the phone remote's Mac keyboard.
///
/// The earlier fix (`up.flags = []`) addressed only the second bullet, and did
/// it by lying to the app about the release. This posts the transitions
/// explicitly instead, so both readers see a coherent press-and-release.
///
/// Flag-less presses (tab/return/escape -- every caller before the phone
/// remote's keyboard existed) skip the sandwich entirely and stay two events.
func pressKey(_ value: String) {
  let (flags, code) = parseCombo(value)
  guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { exit(1) }

  // Which modifier KEYS the combo named, in a stable press order. Derived from
  // the parsed flags rather than re-splitting the string, so an alias
  // ("command" vs "cmd") can't produce a different sandwich than its flag.
  let heldModifiers: [(CGKeyCode, CGEventFlags)] = [
    ("cmd", CGEventFlags.maskCommand), ("ctrl", .maskControl),
    ("alt", .maskAlternate), ("shift", .maskShift), ("fn", .maskSecondaryFn)
  ].compactMap { name, flag in
    guard flags.contains(flag), let code = modifierKeyCodes[name] else { return nil }
    return (code, flag)
  }

  /// Post one .flagsChanged carrying the modifier state as of this transition.
  /// The flags are CUMULATIVE: pressing Shift while Cmd is already down must
  /// report [cmd, shift], not [shift] -- a non-cumulative set reads as "cmd
  /// was released", which is the stuck/dropped-modifier bug in reverse.
  func postFlagsChanged(_ code: CGKeyCode, _ state: CGEventFlags, keyDown: Bool) {
    guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: keyDown) else { return }
    e.type = .flagsChanged
    e.flags = state
    e.post(tap: .cghidEventTap)
    usleep(6_000)
  }

  var state: CGEventFlags = []
  for (code, flag) in heldModifiers {
    state.insert(flag)
    postFlagsChanged(code, state, keyDown: true)
  }

  // Both key events carry the full modifier set -- that's what the focused app
  // matches its shortcut against.
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  usleep(20_000)
  up.post(tap: .cghidEventTap)

  // Release in reverse, each transition reporting what's STILL held.
  for (code, flag) in heldModifiers.reversed() {
    state.remove(flag)
    postFlagsChanged(code, state, keyDown: false)
  }

  // Then assert empty state one final time, unconditionally.
  //
  // Not belt-and-braces -- measured. The per-modifier releases above are what
  // the focused app reads, but the HID system COALESCES transitions posted
  // faster than it processes them, and a long chain outruns it: 1-2 modifiers
  // came back clean while cmd+ctrl+alt+shift left CMD latched, every time.
  // Raising the inter-event delay enough to survive 4 modifiers would tax every
  // ordinary keystroke, so instead the last word is a single flagsChanged
  // carrying [] -- there is no state it can be dropped from, and it costs one
  // event. Verified with a CGEventSource.flagsState probe: without this line
  // the 4-modifier case latches, with it every combo reads clean.
  if !heldModifiers.isEmpty {
    postFlagsChanged(modifierKeyCodes["cmd"] ?? 0x37, [], keyDown: false)
  }
}

/// Press-and-hold (keydown) or release (keyup) a single key — enables chords a
/// caller assembles manually (hold shift, drag, release shift).
///
/// Two distinct cases, because macOS models them differently:
///   • A BARE MODIFIER ("cmd") → a .flagsChanged event on the modifier's own
///     keycode, carrying the cumulative flag state.
///   • Anything else ("shift+a", "tab") → the original parseCombo path.
///
/// NOT usable for app cycling across separate invocations. Measured: holding
/// cmd here and spawning `key cmd+tab` twice lands back on the SAME app, because
/// each process posts from its own event source and macOS scores every Tab as a
/// fresh Cmd+Tab (toggling A↔B) rather than an advance inside one live switcher
/// session. The whole cycle has to happen in ONE process — see `apptab`.
func holdKey(_ value: String, down isDown: Bool) {
  let name = value.lowercased()

  if let modCode = modifierKeyCodes[name], let flag = modifierFlags[name] {
    guard let ev = CGEvent(keyboardEventSource: src, virtualKey: modCode, keyDown: isDown) else {
      exit(1)
    }
    ev.type = .flagsChanged
    // On press the flag is set; on release it clears. A stale flag here is
    // exactly the "stuck modifier" failure mode, so releases post an empty set.
    ev.flags = isDown ? flag : []
    ev.post(tap: .cghidEventTap)
    return
  }

  let (flags, code) = parseCombo(value)
  guard let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: isDown) else { exit(1) }
  ev.flags = flags
  ev.post(tap: .cghidEventTap)
}

// ── Dispatch ────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else {
  die("usage: mm-input <move|click|rightclick|doubleclick|tripleclick|drag|scroll|type|key|keydown|keyup> ...")
}
let verb = args[1]

func pt(_ i: Int) -> CGPoint {
  guard args.count > i + 1, let x = Double(args[i]), let y = Double(args[i + 1]) else {
    die("\(verb) needs <x> <y>")
  }
  return CGPoint(x: x, y: y)
}

switch verb {
case "move":
  let p = pt(2); moveTo(p); print("ok move \(Int(p.x)),\(Int(p.y))")
case "moveloop":
  // Long-lived mode: one tagged command per line on stdin, one CGEvent per
  // line, no per-move process spawn. "quit" or EOF ends the loop (and the
  // process). See the tag table in the header comment above.
  while let line = readLine(strippingNewline: true) {
    if line == "quit" { break }
    let parts = line.split(separator: " ").map(String.init)
    // Bare "x y" (no tag) is the legacy plain-move form -- kept working since
    // it's indistinguishable from a 2-token line and costs nothing to accept.
    if parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]) {
      moveTo(CGPoint(x: x, y: y))
      continue
    }
    guard parts.count == 3 else { continue }
    let tag = parts[0]
    switch tag {
    case "m", "dd", "dm", "du":
      guard let x = Double(parts[1]), let y = Double(parts[2]) else { continue }
      let p = CGPoint(x: x, y: y)
      switch tag {
      case "m": moveTo(p)
      case "dd": dragDown(p)
      case "dm": dragMoveTo(p)
      case "du": dragUp(p)
      default: break
      }
    case "sc":
      guard let dy = Int32(parts[1]), let dx = Int32(parts[2]) else { continue }
      scrollNudge(dy: dy, dx: dx)
      // Acked because a wheel is the one event nothing re-stamps: moves stream
      // continuously, a scroll posts once after the gesture ended. The caller
      // stamps on THIS line, so attribution survives a backlogged stdin.
      // Moves stay silent -- 30/sec of acks on the hot path buys nothing.
      print("ok sc")
      fflush(stdout)
    default:
      continue
    }
  }
case "click":
  let p = pt(2); clickButton(p, button: .left, clickState: 1); print("ok click \(Int(p.x)),\(Int(p.y))")
case "rightclick":
  let p = pt(2); clickButton(p, button: .right, clickState: 1); print("ok rightclick \(Int(p.x)),\(Int(p.y))")
case "doubleclick":
  let p = pt(2); clickButton(p, button: .left, clickState: 2); print("ok doubleclick \(Int(p.x)),\(Int(p.y))")
case "tripleclick":
  let p = pt(2); clickButton(p, button: .left, clickState: 3); print("ok tripleclick \(Int(p.x)),\(Int(p.y))")
case "drag":
  guard args.count >= 6 else { die("drag needs <x1> <y1> <x2> <y2>") }
  drag(pt(2), pt(4)); print("ok drag")
case "scroll":
  guard args.count >= 4, let amt = Int32(args[3]) else { die("scroll needs <up|down|left|right> <amount>") }
  scroll(direction: args[2], lines: amt); print("ok scroll \(args[2]) \(amt)")
case "zoom":
  guard args.count >= 3, let steps = Int32(args[2]) else { die("zoom needs <steps> (+ in, - out)") }
  zoom(steps: steps); print("ok zoom \(steps)")
case "smartzoom":
  smartZoom(); print("ok smartzoom")
case "type":
  guard args.count >= 3 else { die("type needs <text>") }
  // Join remaining args so unquoted multi-word text still types fully.
  let text = args[2...].joined(separator: " ")
  for ch in text { postUnicode(String(ch)); usleep(6_000) }
  print("ok type")
case "key":
  guard args.count >= 3 else { die("key needs <combo> [combo ...]") }
  // Variadic on purpose: a prefix sequence (tmux's ctrl+b then z) must arrive in
  // order, and a spawn per combo costs ~49ms -- more than the keystrokes. Two
  // statements in one process order themselves for free. pressKey() leaves the
  // modifier state empty before returning, so combos can't bleed into each other.
  let combos = Array(args[2...])
  for combo in combos { pressKey(combo) }
  print("ok key \(combos.joined(separator: " "))")
case "keydown":
  guard args.count >= 3 else { die("keydown needs <key>") }
  holdKey(args[2], down: true); print("ok keydown \(args[2])")
case "keyup":
  guard args.count >= 3 else { die("keyup needs <key>") }
  holdKey(args[2], down: false); print("ok keyup \(args[2])")
case "apptab":
  guard args.count >= 3, let steps = Int(args[2]) else { die("apptab needs <steps>") }
  appTab(steps); print("ok apptab \(steps)")
case "kbdtype":
  // Which physical board is attached, so the phone remote's virtual keyboard can
  // mirror it. ISO has one more key than ANSI (§ left of Z) — drawing the wrong
  // one hides a key the user reaches for. Read-only; needs no permissions.
  let layoutType = KBGetLayoutType(Int16(LMGetKbdType()))
  switch Int(layoutType) {
  case kKeyboardISO: print("ok kbdtype iso")
  case kKeyboardJIS: print("ok kbdtype jis")
  default: print("ok kbdtype ansi")
  }
case "cursorscale":
  // Private SkyLight call, dlopen'd so a future macOS that drops it fails this verb, not the binary.
  guard args.count > 2, let scale = Float(args[2]), scale >= 1, scale <= 4 else { die("cursorscale needs <1..4>") }
  typealias ConnFn = @convention(c) () -> Int32
  typealias SetFn = @convention(c) (Int32, Float) -> Int32
  guard let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
        let connSym = dlsym(sky, "SLSMainConnectionID"), let setSym = dlsym(sky, "SLSSetCursorScale")
  else { die("cursorscale unavailable") }
  let rc = unsafeBitCast(setSym, to: SetFn.self)(unsafeBitCast(connSym, to: ConnFn.self)(), scale)
  guard rc == 0 else { die("cursorscale failed \(rc)") }
  print("ok cursorscale \(scale)")
default:
  die("unknown verb: \(verb)")
}
