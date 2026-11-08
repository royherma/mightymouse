// FnWatch.swift — stream fn (globe) key press/release, one line per edge.
//
// Consumer: src/main/macos/fn-watch.ts, which feeds the listen gesture machine in
// capture/capture-hotkey.ts so fn is a full alias for ⌘⌥⇧L (tap, double-tap,
// long-press). Like frontmost-watch this one is LONG-LIVED: it stays resident and
// writes a line each time fn changes state.
//
//   fn down  — fn pressed
//   fn up    — fn released
//
// Why a native binary at all: uiohook cannot see this key. Its UiohookKey table has
// no Fn entry, and the AnyEvent shape it hands us carries only alt/ctrl/shift/meta —
// so even a leaked keycode would have nowhere to live. macOS reports fn as a FLAG BIT
// (maskSecondaryFn, 0x800000) on a flagsChanged event with keycode 63, which is a
// different event channel than the keydown/keyup stream uiohook exposes.
//
// LISTEN-ONLY, deliberately. A .defaultTap could return nil and swallow fn system-
// wide, which would break the user's own "Press 🌐 to" binding (emoji / input source)
// everywhere. We observe and let macOS's binding fire too; the app-side toggle is the
// escape hatch, not event suppression. Same class of bug as the uiohook typing-swallow
// incident, and not worth repeating.
//
// Needs Accessibility permission — the same grant uiohook already requires. Without
// it tapCreate returns nil, and we exit(2) so the parent can tell "denied" apart from
// "crashed".
//
// Usage: fn-watch
// Runs until killed. Line-buffered, so Node sees each edge immediately.

import Cocoa

// The fn/globe key. Not in any Carbon header as a named constant worth importing —
// kVK_Function is 63, and it arrives on flagsChanged rather than keyDown/keyUp.
let kFnKeycode: Int64 = 63

func emitLine(_ line: String) {
  print(line)
  // stdout to a pipe is block-buffered, so without this an edge sits in the buffer
  // until ~4KB of them accumulate -- which for this stream is never.
  fflush(stdout)
}

// No initial-state line on purpose. "fn is currently up" is not information, and a
// spawn echo would read as a real edge downstream and fire a phantom listen.
let eventMask = (1 << CGEventType.flagsChanged.rawValue)

guard
  let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(eventMask),
    callback: { _, _, event, _ in
      if event.getIntegerValueField(.keyboardEventKeycode) == kFnKeycode {
        // The flag is the state AFTER this edge: set means fn just went down.
        emitLine(event.flags.contains(.maskSecondaryFn) ? "fn down" : "fn up")
      }
      return Unmanaged.passUnretained(event)
    },
    userInfo: nil
  )
else {
  FileHandle.standardError.write(Data("fn-watch: tapCreate failed (Accessibility denied)\n".utf8))
  exit(2)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

// macOS DISABLES an event tap that takes too long in its callback, and the only
// notice is a tapDisabledByTimeout event on the same stream. Ours does nothing but a
// compare and a print, so this should never fire -- but a silently dead tap looks
// exactly like "the fn key stopped working", so re-arm rather than sit there dead.
let watchdog = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: CGEventMask(
    (1 << CGEventType.tapDisabledByTimeout.rawValue)
      | (1 << CGEventType.tapDisabledByUserInput.rawValue)
  ),
  callback: { _, _, event, info in
    if let info {
      CGEvent.tapEnable(tap: Unmanaged<CFMachPort>.fromOpaque(info).takeUnretainedValue(), enable: true)
    }
    return Unmanaged.passUnretained(event)
  },
  userInfo: Unmanaged.passUnretained(tap).toOpaque()
)
if let watchdog {
  let wSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, watchdog, 0)
  CFRunLoopAddSource(CFRunLoopGetCurrent(), wSource, .commonModes)
  CGEvent.tapEnable(tap: watchdog, enable: true)
}

CFRunLoopRun()
