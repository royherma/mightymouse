// WindowLayout.swift — position + resize other apps' windows by bundle id, for
// Phone Remote's window-layout sheet (long-press an app tile → Left / Right /
// Left & Right / Quarters / …).
//
// Consumer: src/main/macos/window-layout.ts, which owns the geometry (it reads
// the screen's visibleFrame and the user's tiled-margins pref) and hands this
// binary already-computed frames. This tool does no layout math of its own —
// it is the AX write head, nothing more.
//
// Why a separate binary, same Pattern B as activate-app/app-switcher-list: no
// Electron API surfaces the Accessibility API, and a one-shot swiftc binary is
// the lightest bridge. Distinct from activate-app because that is a plain
// NSRunningApplication call needing no permission, while this needs AX trust.
//
// PERMISSION: this is the first helper here that requires Accessibility. It is
// a DIFFERENT grant from Screen Recording (which app-switcher-list explicitly
// notes it does not need). Untrusted, every AX call fails with -25211 and the
// user sees windows simply not move, so the trust check happens up front and
// reports `ax-untrusted` rather than letting each op fail opaquely.
//
// WHY NOT the Window menu (Move & Resize ▸ Arrange): macOS 26 has those items,
// but driving them means menu-bar scripting against the frontmost app — the
// same synthesized-UI approach that quick-switch.ts abandoned after three
// rounds of timing tuning. Setting kAXPosition/kAXSize is a direct write that
// needs no activation, so a background app tiles without ever coming forward.
//
// Usage:  window-layout '<json>'
//   in:   { "ops": [ { "bundleId": "com.google.Chrome",
//                      "frame": { "x": 0, "y": 34, "w": 864, "h": 1006 } } ] }
//   out:  one JSON line:
//         { "ok": true,
//           "applied": [ { "bundleId": "…", "before": {x,y,w,h} } ],
//           "failed":  [ { "bundleId": "…", "error": "no-windows" } ] }
//
// `before` is the window's rect prior to the move — window-layout.ts stashes it
// so the sheet's Restore button can put things back. Pass "frame": null to READ
// that rect without moving anything.
//
// Never throws and never crashes: every failure path still prints one JSON
// line, because a failed layout must not take down the phone-remote session.
// Partial success is normal and expected — tiling two apps where one has no
// open windows applies the other and reports the miss.

import AppKit
import Foundation

// MARK: - Wire types

struct Frame: Codable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
}

/// One app to act on. A nil `frame` is a READ: report where the window is now
/// and move nothing. window-layout.ts probes that way to learn which display an
/// app is on before it computes any geometry — it cannot ask AX directly, and
/// guessing the primary display would fling a window off its own monitor.
struct Op: Codable {
  let bundleId: String
  let frame: Frame?
}

struct Request: Codable {
  let ops: [Op]
}

struct Applied: Codable {
  let bundleId: String
  let before: Frame
}

struct Failure: Codable {
  let bundleId: String
  let error: String
}

struct Response: Codable {
  let ok: Bool
  var applied: [Applied] = []
  var failed: [Failure] = []
  var error: String? = nil
}

/// Print one JSON line and exit. The ONLY way this program terminates, so
/// there is no path where the caller gets an empty stdout to parse.
func emit(_ response: Response) -> Never {
  let encoder = JSONEncoder()
  if let data = try? encoder.encode(response), let line = String(data: data, encoding: .utf8) {
    print(line)
  } else {
    // Encoding our own small struct cannot realistically fail, but a silent
    // exit here would be indistinguishable from a crash to the TS side.
    print("{\"ok\":false,\"applied\":[],\"failed\":[],\"error\":\"encode-failed\"}")
  }
  exit(0)
}

// MARK: - AX helpers

/// Read a window's current position + size as one rect.
///
/// Returns nil only if the window element refuses both attributes, which in
/// practice means it was destroyed between listing and reading it.
func readFrame(_ window: AXUIElement) -> Frame? {
  var positionRef: CFTypeRef?
  var sizeRef: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRef) == .success,
    AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success
  else { return nil }

  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(positionRef as! AXValue, .cgPoint, &point)
  AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
  return Frame(x: Double(point.x), y: Double(point.y), w: Double(size.width), h: Double(size.height))
}

/// Whether a window is minimized to the Dock. Tiling one of these would move a
/// window nobody can see and read as "the button did nothing".
func isMinimized(_ window: AXUIElement) -> Bool {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &value) == .success
  else { return false }
  return (value as? Bool) ?? false
}

/// Pick the window a user means by "this app".
///
/// kAXMainWindow, NOT windows[0]. Probed 2026-08-16 against four real apps:
/// Chrome (3 windows) and Xcode agreed, but cmux's windows[0] is a helper panel
/// titled "Item-0" while its real window sits at index 1 — so an index-based
/// pick tiles something invisible. kAXMainWindow and kAXFocusedWindow agreed on
/// every app that had any window, so main alone is enough.
///
/// Falls back to the first non-minimized window when an app publishes no main
/// window (some apps only set it once activated). Returns nil when the app has
/// no usable window at all — Safari with every window closed answers -25212
/// (kAXErrorNoValue) here, which is a legitimate skip, not an error to retry.
func targetWindow(of application: AXUIElement) -> AXUIElement? {
  var mainRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(application, kAXMainWindowAttribute as CFString, &mainRef) == .success,
    let main = mainRef
  {
    let window = main as! AXUIElement
    if !isMinimized(window) { return window }
  }

  var windowsRef: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windowsRef) == .success,
    let windows = windowsRef as? [AXUIElement]
  else { return nil }

  return windows.first { !isMinimized($0) }
}

/// Move + resize one window.
///
/// POSITION FIRST, then size: a window still sitting at its old origin can have
/// a size request clamped against the screen edge it currently overlaps.
/// Verified at a real edge (x=0) 2026-08-16 — both writes returned success.
///
/// The caller must NOT compare the resulting frame to the requested one. Apps
/// clamp to their own minimum/increment sizing: Finder took 1005px for a
/// requested 1006. Re-issuing a "corrective" resize on that mismatch is an
/// infinite fight with the app, so this deliberately reports success on the
/// write succeeding, not on the geometry matching.
func apply(_ frame: Frame, to window: AXUIElement) -> Bool {
  var point = CGPoint(x: frame.x, y: frame.y)
  var size = CGSize(width: frame.w, height: frame.h)
  guard
    let positionValue = AXValueCreate(.cgPoint, &point),
    let sizeValue = AXValueCreate(.cgSize, &size)
  else { return false }

  let positionErr = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, positionValue)
  let sizeErr = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
  return positionErr == .success && sizeErr == .success
}

// MARK: - Main

let arguments = CommandLine.arguments
guard arguments.count >= 2, let payload = arguments[1].data(using: .utf8) else {
  emit(Response(ok: false, error: "usage: window-layout '<json>'"))
}

guard let request = try? JSONDecoder().decode(Request.self, from: payload) else {
  emit(Response(ok: false, error: "bad-json"))
}

guard request.ops.isEmpty == false else {
  emit(Response(ok: false, error: "no-ops"))
}

// Checked before any op so the phone gets one actionable reason instead of N
// identical -25211s. Not prompting: a modal system dialog triggered from a
// phone tap, with the user possibly not at the Mac, is the wrong surface —
// the app requests trust through its own onboarding.
guard AXIsProcessTrusted() else {
  emit(Response(ok: false, error: "ax-untrusted"))
}

var response = Response(ok: true)

for op in request.ops {
  guard
    let running = NSWorkspace.shared.runningApplications.first(where: {
      $0.bundleIdentifier == op.bundleId
    })
  else {
    response.failed.append(Failure(bundleId: op.bundleId, error: "not-running"))
    continue
  }

  let application = AXUIElementCreateApplication(running.processIdentifier)
  guard let window = targetWindow(of: application) else {
    response.failed.append(Failure(bundleId: op.bundleId, error: "no-windows"))
    continue
  }

  // Captured BEFORE the move — this is what Restore replays.
  guard let before = readFrame(window) else {
    response.failed.append(Failure(bundleId: op.bundleId, error: "unreadable-frame"))
    continue
  }

  // A read-only op reports the rect it found and moves nothing.
  guard let frame = op.frame else {
    response.applied.append(Applied(bundleId: op.bundleId, before: before))
    continue
  }

  if apply(frame, to: window) {
    response.applied.append(Applied(bundleId: op.bundleId, before: before))
  } else {
    response.failed.append(Failure(bundleId: op.bundleId, error: "set-failed"))
  }
}

// ok reflects "at least one window moved". Tiling two apps where one has no
// windows is a partial success the caller should still stash a Restore rect
// for, so a wholly-failed run is the only false.
response = Response(
  ok: response.applied.isEmpty == false,
  applied: response.applied,
  failed: response.failed,
  error: response.applied.isEmpty ? "all-ops-failed" : nil
)
emit(response)
