// ActivateApp.swift — bring one running app to the front by bundle id.
//
// Consumer: src/main/macos/activate-app.ts, called when the phone taps a
// specific row in the app-switcher popup (direct-activate, as opposed to
// the blind held-Cmd+Tab-advance flow in mm-input's `apptab` verb).
//
// Why a separate binary rather than a new mm-input verb: mm-input only
// imports CoreGraphics+Foundation (pure CGEvent synthesis, no AppKit).
// Activating a specific app is a plain NSRunningApplication AppKit call,
// not a synthesized keystroke — a different concern, so it gets its own
// one-shot binary, same as notch-info/app-switcher-list.
//
// No permission needed: NSRunningApplication.activate(options:) is a normal
// AppKit API, not gated behind Accessibility or Screen Recording.
//
// Usage: activate-app <bundleId>
// Exits 0 + prints "ok" on success, exits 1 + prints an error line on
// failure (bundle id not found among running apps, or the activate call
// itself returning false).

import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: activate-app <bundleId>\n".data(using: .utf8)!)
  exit(2)
}
let targetBundleId = args[1]

guard
  let target = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier == targetBundleId
  })
else {
  FileHandle.standardError.write("app not found: \(targetBundleId)\n".data(using: .utf8)!)
  exit(1)
}

let ok = target.activate(options: [])
if ok {
  print("ok")
  exit(0)
} else {
  FileHandle.standardError.write("activate() returned false\n".data(using: .utf8)!)
  exit(1)
}
