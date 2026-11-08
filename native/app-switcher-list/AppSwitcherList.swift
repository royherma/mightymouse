// AppSwitcherList.swift — one-shot binary that lists currently-running,
// user-visible apps in an approximation of Cmd+Tab order, with each app's
// real icon, for Phone Remote's app-switcher popup.
//
// Consumer: src/main/macos/app-switcher-list.ts spawns this once per popup
// open, parses the JSON line it prints, and ships name+icon+bundleId to the
// phone so the user can tap an app directly instead of only "next".
//
// Why a native binary: same Pattern B as notch-info/mm-input — no Electron
// API surfaces NSWorkspace/CGWindowList, a one-shot swiftc binary is the
// lightest bridge.
//
// Ordering: there is NO public API for the Dock's actual Cmd+Tab MRU list —
// it's private state the Dock process owns. This tool approximates it:
//   1. CGWindowListCopyWindowInfo(.optionOnScreenOnly) returns on-screen
//      windows in front-to-back z-order (roughly = recency for apps that
//      have a visible window right now).
//   2. Dedupe by owner PID, keeping the first (frontmost) occurrence.
//   3. Map each PID -> NSRunningApplication, filter to .regular activation
//      policy (excludes menu-bar-only/background agents, matching what
//      Cmd+Tab itself shows).
//   4. Append any remaining .regular running apps that had NO on-screen
//      window (fully hidden via Cmd+H, or all windows minimized) at the end.
// Not pixel-perfect for the hidden/minimized tail, but matches Cmd+Tab
// exactly for the common case (apps with a visible window).
//
// Permissions: PID/layer/owner-name fields from CGWindowListCopyWindowInfo
// do NOT require Screen Recording permission (only window NAMES/contents
// do, which this tool never reads) — verified against macOS's documented
// gating. No Accessibility permission needed either (that's only for
// AXUIElement window control, not this read-only listing).
//
// Output: one JSON line, an array of { name, bundleId, iconPngBase64 }.
// Empty array (not an error) if nothing qualifies. Any internal failure
// still emits `[]` — this is a best-effort UI list, never worth crashing
// the phone-remote popup over.
//
// Args: any argv (space-separated bundle ids) are treated as "the caller
// already has this app's icon cached" -- skips both the NSImage render AND
// the PNG encode for those rows (iconPngBase64 comes back "", caller reuses
// its cached copy). Icons never change while an app stays installed, so this
// avoids redoing real encode work on every popup-open, not just re-sending
// bytes that were going to be thrown away anyway.

import AppKit
import CoreGraphics
import Foundation

/// Render an app's icon at a fixed size and encode as base64 PNG. Returns ""
/// (never nil/crash) if the image has no renderable representation — the
/// phone side just shows a placeholder glyph for that row.
///
/// Size is 64px (2x for a 32px CSS row on a retina phone screen) -- the
/// popup was shipping 128px source icons (130-190KB PNG each) over a phone
/// WebSocket for a 32px display slot, which also blew spawnSync's 1MB
/// default maxBuffer with ~10 apps open. 64px cuts pixel count 4x.
func iconBase64(_ image: NSImage?, size: CGFloat = 64) -> String {
  guard let image = image else { return "" }
  var rect = NSRect(x: 0, y: 0, width: size, height: size)
  guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    return ""
  }
  let bitmap = NSBitmapImageRep(cgImage: cgImage)
  bitmap.size = NSSize(width: size, height: size)
  guard let png = bitmap.representation(using: .png, properties: [:]) else { return "" }
  return png.base64EncodedString()
}

/// Escape the handful of characters that can appear in an app display name
/// and would otherwise break naive JSON string emission. No Foundation
/// JSONEncoder here because we're hand-assembling one flat array of one
/// known shape — a full encoder is unnecessary weight for a one-shot CLI.
func jsonEscape(_ s: String) -> String {
  var out = ""
  for ch in s {
    switch ch {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    default: out.append(ch)
    }
  }
  return out
}

var orderedPids: [pid_t] = []
var seenPids = Set<pid_t>()

// Index 0 comes from NSWorkspace, NOT from window z-order. Z-order ranks
// WINDOWS, and an always-on-top panel outranks the window of the app the user
// is actually working in -- MightyMouse's own floating panel/HUD are exactly
// that, so "Electron" sorted first while cmux was frontmost, and the switcher
// opened marking the wrong app as current. frontmostApplication is the same
// value macOS itself uses for the menu bar, so it cannot disagree with what
// the user sees. Z-order still orders everything BELOW the front app, where
// it's a fine recency approximation and no API exposes the Dock's real MRU.
if let front = NSWorkspace.shared.frontmostApplication {
  seenPids.insert(front.processIdentifier)
  orderedPids.append(front.processIdentifier)
}

// .optionOnScreenOnly is REQUIRED for CGWindowListCopyWindowInfo's
// front-to-back z-order guarantee to hold -- Apple only documents ordering
// for on-screen windows. Omitting it (a prior fix attempt, see git blame)
// let a long-lived background app (Spotify) sort first regardless of true
// frontmost state -- every mode/step-count landed on "Spotify" as a result.
// The hidden/minimized tail below (all remaining .regular running apps) is
// what actually solves the "Safari with no window falls off the end" case
// this flag was originally dropped for -- no need to also drop ordering
// guarantees for the common, visible-window case to get that.
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
  for info in windowList {
    guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t else { continue }
    if seenPids.contains(ownerPid) { continue }
    seenPids.insert(ownerPid)
    orderedPids.append(ownerPid)
  }
}

let alreadyCached = Set(CommandLine.arguments.dropFirst())

var rows: [String] = []
var seenBundleIds = Set<String>()

func appendRow(_ app: NSRunningApplication) {
  guard app.activationPolicy == .regular else { return }
  let bundleId = app.bundleIdentifier ?? "pid:\(app.processIdentifier)"
  if seenBundleIds.contains(bundleId) { return }
  seenBundleIds.insert(bundleId)
  let name = jsonEscape(app.localizedName ?? bundleId)
  let icon = alreadyCached.contains(bundleId) ? "" : iconBase64(app.icon)
  rows.append("{\"name\":\"\(name)\",\"bundleId\":\"\(jsonEscape(bundleId))\",\"iconPngBase64\":\"\(icon)\"}")
}

// Visible windows first, front-to-back — the recency approximation.
for pid in orderedPids {
  guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
  appendRow(app)
}

// Then any remaining regular apps with no on-screen window (hidden/minimized).
for app in NSWorkspace.shared.runningApplications {
  appendRow(app)
}

print("[" + rows.joined(separator: ",") + "]")
