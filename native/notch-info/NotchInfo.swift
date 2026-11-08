// NotchInfo — one-shot binary: read notch geometry, print JSON, exit.
//
// Why this exists: MightyMouse's app shell has no notch API. NSScreen has everything
// we need — safeAreaInsets.top gives notch height, and auxiliaryTopLeftArea /
// auxiliaryTopRightArea define the usable regions flanking the notch, so the
// notch width is the gap between them.
//
// Contract with the Node side (notch-info.ts):
//   no argv — takes nothing
//   stdout  — exactly one JSON line, then exit 0
//   stderr  — only on unexpected errors (not "no notch" — that's valid JSON)
//
// Coordinate-space note (important for the consumer):
//   AppKit uses a BOTTOM-LEFT origin (y increases upward). For the notch itself
//   (always at the PHYSICAL TOP of its screen), the consumer's y is simply 0 relative
//   to the screen that owns it, so notchX / notchWidth / notchHeight are used directly.

import AppKit
import Foundation

// Pick the screen that has a notch: safeAreaInsets.top > 0.
// On machines without a notch, this will be nil → emit {"hasNotch":false}.
let notchedScreen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 })

guard let screen = notchedScreen else {
    print("{\"hasNotch\":false}")
    fflush(stdout)
    exit(0)
}

// Notch height — the safe-area top inset is exactly the notch height in points.
let notchHeight = Int(screen.safeAreaInsets.top)

// auxiliaryTopLeftArea / auxiliaryTopRightArea are Optional<NSRect>; they are
// nil on Intel Macs (which have menu-bar space but no notch). Guard both.
let leftWidth: CGFloat
let rightWidth: CGFloat

if let leftRect = screen.auxiliaryTopLeftArea {
    leftWidth = leftRect.width
} else {
    leftWidth = 0
}

if let rightRect = screen.auxiliaryTopRightArea {
    rightWidth = rightRect.width
} else {
    rightWidth = 0
}

// The notch is the gap between the two auxiliary areas.
// notchX = distance from the left edge of the screen to where the notch begins.
let screenWidth = Int(screen.frame.width)
let notchWidth = screenWidth - Int(leftWidth) - Int(rightWidth)
let notchX = Int(leftWidth)

// Emit a single compact JSON line. No JSONEncoder dependency — keep it pure stdlib.
print("{\"hasNotch\":true,\"notchX\":\(notchX),\"notchWidth\":\(notchWidth),\"notchHeight\":\(notchHeight),\"screenWidth\":\(screenWidth)}")
fflush(stdout)
exit(0)
