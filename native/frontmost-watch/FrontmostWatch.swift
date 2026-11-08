// FrontmostWatch.swift — stream app-activation and app-launch/quit events, one
// line per change.
//
// Consumer: src/main/macos/frontmost-watch.ts, which feeds Phone Remote's
// app-aware keyboard bar. Unlike every other helper here this one is LONG-LIVED:
// it stays resident and writes a line each time the frontmost app changes.
//
// Two event kinds share this stream, tagged by prefix:
//   front <bundleId>  — the frontmost app changed
//   set             — the running-app SET changed (something launched or quit)
//
// The set line carries no bundle id on purpose: the consumer's answer to it is
// to re-read the whole list from app-switcher-list (which resolves names, icons
// and z-order), so naming the one app that moved would only invite a caller to
// trust a half-picture. This is the launch/quit half of the same NSWorkspace
// feed the activation half already rides, which is why it lives here rather
// than in a second resident process.
//
// Why a resident process rather than polling from Node: reading the frontmost
// app over Apple events costs ~200ms of BLOCKING spawnSync in the main process
// (measured; see app-context/index.ts). At any cadence fast enough to keep the
// bar honest that stutters the trackpad stream sharing that thread. NSWorkspace
// already publishes the change as a notification, so the only honest way to get
// it is to sit on that notification instead of asking repeatedly.
//
// Emits ONLY the bundle id + a newline. Resolving what that app is showing (tabs,
// terminals) stays in the AppleScript adapters — this binary is deliberately the
// cheap half, and prints nothing that needs parsing beyond a string compare.
//
// No permission needed: NSWorkspace notifications and `bundleIdentifier` are
// plain AppKit, not gated behind Accessibility or Screen Recording.
//
// Usage: frontmost-watch
// Runs until killed. Line-buffered, so Node sees each change immediately.

import AppKit
import Foundation

// The current app is printed FIRST, before any notification arrives: a consumer
// that started mid-session would otherwise hold no value at all until the user
// happened to switch apps, and would have to fall back to the ~200ms read this
// binary exists to avoid.
func emitLine(_ line: String) {
  print(line)
  // stdout to a pipe is block-buffered, so without this a change sits in the
  // buffer until ~4KB of them accumulate -- which for this stream is never.
  fflush(stdout)
}

func emitFront(_ bundleId: String?) {
  guard let id = bundleId, !id.isEmpty else { return }
  emitLine("front \(id)")
}

emitFront(NSWorkspace.shared.frontmostApplication?.bundleIdentifier)

NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: .main
) { note in
  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  emitFront(app?.bundleIdentifier)
}

// An app becoming visible in the switcher lags its launch notification: at
// didLaunchApplication time the process exists but has usually not yet placed a
// window, and app-switcher-list orders by CGWindowList z-order -- so re-reading
// on the notification itself routinely returns the list WITHOUT the new app and
// looks exactly like the staleness this fixes. Coalescing on a short delay also
// collapses the burst a multi-process app (helpers, agents) emits at launch
// into one re-read.
var setChangeTimer: DispatchWorkItem?

func emitSetChanged() {
  setChangeTimer?.cancel()
  let work = DispatchWorkItem { emitLine("set") }
  setChangeTimer = work
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
}

for name: NSNotification.Name in [
  NSWorkspace.didLaunchApplicationNotification,
  NSWorkspace.didTerminateApplicationNotification
] {
  NSWorkspace.shared.notificationCenter.addObserver(
    forName: name,
    object: nil,
    queue: .main
  ) { _ in emitSetChanged() }
}

// Exit when stdout closes rather than lingering as an orphan if the parent dies
// without reaping us -- a resident helper is the one shape that can leak here.
signal(SIGPIPE) { _ in exit(0) }

RunLoop.main.run()
