// MmShot.swift — screenshot the display WITHOUT MightyMouse's own overlays in it.
//
// Why this exists: the act agent reads a screenshot and clicks what it sees. Once
// the companion draws full-screen (Stage mode), `screencapture -x` captures our
// own bubbles sitting on top of the user's apps, so the agent reads OUR UI as the
// screen and clicks it. Excluding the windows at CAPTURE time is the only fix
// that keeps them visible to the human (and to the phone mirror) while hiding
// them from the agent.
//
// NOT setContentProtection: that hides a window from every capture path at once,
// including the phone mirror — which would blank the exact thing the user is
// watching. The whole point of Stage is bubbles readable off the mirror.
//
// Usage:
//   mm-shot <out.png|out.jpg> [--exclude-pid <pid>]... [--max-width <px>]
//
// --exclude-pid may repeat. An unknown pid is ignored (nothing to exclude), and
// exit is non-zero ONLY on a real capture failure, so a caller can always fall
// back to screencapture.

import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("[mm-shot] \(message)\n".data(using: .utf8)!)
    exit(1)
}

// --- argv ------------------------------------------------------------------

var outPath: String?
var excludedPids: Set<pid_t> = []
var maxWidth: Int?

var argv = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < argv.count {
    let arg = argv[i]
    if arg == "--exclude-pid" {
        guard i + 1 < argv.count, let pid = pid_t(argv[i + 1]) else {
            fail("--exclude-pid needs a numeric pid")
        }
        excludedPids.insert(pid)
        i += 2
    } else if arg == "--max-width" {
        guard i + 1 < argv.count, let w = Int(argv[i + 1]), w > 0 else {
            fail("--max-width needs a positive number")
        }
        maxWidth = w
        i += 2
    } else if outPath == nil {
        outPath = arg
        i += 1
    } else {
        fail("unexpected argument: \(arg)")
    }
}

guard let destination = outPath else {
    fail("usage: mm-shot <out.png> [--exclude-pid <pid>]...")
}

guard #available(macOS 14.0, *) else {
    // SCScreenshotManager is 14+. Older macOS falls back to screencapture on the
    // TS side, which is exactly today's behavior minus the exclusion.
    fail("ScreenCaptureKit stills require macOS 14+")
}

// --- capture ---------------------------------------------------------------

func writeImage(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    let jpeg = url.pathExtension.lowercased() == "jpg" || url.pathExtension.lowercased() == "jpeg"
    let type = jpeg ? UTType.jpeg : UTType.png
    guard
        let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)
    else {
        fail("could not open \(path) for writing")
    }
    let props = jpeg ? [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary : nil
    CGImageDestinationAddImage(dest, image, props)
    guard CGImageDestinationFinalize(dest) else {
        fail("could not encode \(path)")
    }
}

// A semaphore, not RunLoop.main.run(): this is a one-shot CLI, and the process
// must exit as soon as the file is on disk — the agent is blocked waiting on it.
let done = DispatchSemaphore(value: 0)

Task {
    do {
        // onScreenWindowsOnly: true — an offscreen/minimized window can't be in
        // the picture anyway, and including them makes the exclusion list bigger
        // than it needs to be on every call.
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else {
            fail("no display available")
        }

        // Exclude by owning pid rather than by window id or title: our overlays
        // are several borderless panels that come and go per turn, and any list
        // captured up-front would be stale by the time the agent looks again.
        let ourWindows = content.windows.filter { window in
            guard let owningPid = window.owningApplication?.processID else { return false }
            return excludedPids.contains(owningPid)
        }

        let filter = SCContentFilter(display: display, excludingWindows: ourWindows)

        let config = SCStreamConfiguration()
        // Match the display's real backing resolution. The agent reads
        // coordinates off this image and mm-input converts them back through the
        // same scale factor, so a downscaled capture would silently shift every
        // click it makes.
        let fullWidth = filter.contentRect.width * CGFloat(filter.pointPixelScale)
        let scale = min(1, CGFloat(maxWidth ?? Int.max) / fullWidth)
        config.width = Int(fullWidth * scale)
        config.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale) * scale)
        config.showsCursor = false

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: config
        )
        writeImage(image, to: destination)
        done.signal()
    } catch {
        // Screen Recording permission missing shows up here too — the caller
        // falls back to screencapture, which prompts for its own permission.
        FileHandle.standardError.write("[mm-shot] capture failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
}

done.wait()
