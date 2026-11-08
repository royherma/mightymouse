// MmVdisplay — creates ONE macOS virtual display and holds it open.
//
// Why this exists: the phone-remote "extended display" mode needs a display that
// isn't the real monitor, so the phone can show something different from the Mac
// macOS has
// NO public API for this — verified across ScreenCaptureKit, DriverKit,
// CoreMediaIO, CGDisplayStream and Sidecar. The only path is the private
// CGVirtualDisplay in CoreGraphics, which is what BetterDisplay, DeskPad and
// Chromium itself all use. It needs no entitlement and no TCC prompt of its own,
// and ships fine under Developer ID + notarization (but never on the App Store).
//
// Everything private is reached through the ObjC runtime by NAME, never a linked
// symbol or a vendored header: a missing class then degrades to a clean "FAIL"
// line on stdout instead of a dyld crash at launch. That matters because Apple
// can delete this API in any OS update, and when they do, extended mode must
// simply not offer itself (see isAvailable() in ../../src/main/capture/virtual-display.ts).
//
// Contract with the Node side (src/main/capture/virtual-display.ts):
//   stdout  — exactly one line, then silence:
//               "READY <displayID> <x> <y> <width> <height>"  on success
//               "FAIL <reason>"                               on any failure
//             The bounds are the CGDisplayBounds the WindowServer actually
//             assigned, in global coordinates — the Node side needs them to
//             normalize the phone's absolute cursor warps, and must NOT
//             recompute them from the requested size (macOS places the display
//             itself, and hiDPI halves the logical size).
//   signal  — SIGINT/SIGTERM, or stdin EOF, tears the display down and exits 0.
//   exit    — nonzero only when no display was ever created.
//
// Two traps, each of which produced a SILENT FALSE SUCCESS during the spike and
// cost real time:
//
//   1. applySettings: returns true even when NOTHING attaches. It is not a
//      success signal. The only proof is polling CGGetActiveDisplayList for the
//      displayID, which is what waitForAttach() does.
//   2. The display lives only as long as this process pumps its dispatch queue
//      AND the descriptor carries a terminationHandler. The ivars _client /
//      _serverRPC_port on CGVirtualDisplay show why: it's a live WindowServer RPC
//      client, not a fire-and-forget registration. Hence RunLoop.main.run() at
//      the bottom, and hence this being a long-lived helper process at all.

import AppKit
import CoreGraphics
import Foundation

// Identifies the display as ours in system UI (System Settings › Displays).
private let DISPLAY_NAME = "MightyMouse"

// EDID-ish identity. Arbitrary, but must be STABLE across launches so macOS
// reuses the same display arrangement/scaling prefs instead of treating every
// session as a brand-new monitor the user has to re-arrange.
private let VENDOR_ID: UInt32 = 0x4D4D  // "MM"
private let PRODUCT_ID: UInt32 = 0x0001
private let SERIAL_NUMBER: UInt32 = 0x0001

// hiDPI:2 gives a Retina-density display, so text on the phone is sharp and the
// logical resolution is half the pixel size. 1 would be a blurry 1x panel.
private let HIDPI_SCALE: UInt32 = 2

private let REFRESH_HZ = 60.0

// How long to wait for the WindowServer to attach the display before calling it
// a failure. Attach measured well under 1s; 5s is slack for a busy machine.
private let ATTACH_TIMEOUT_SECONDS = 5.0
private let ATTACH_POLL_SECONDS = 0.05

/// Physical size claimed for the panel. Only the RATIO matters (it sets the
/// display's reported DPI); macOS derives nothing else from it. Kept at a
/// 16:9-ish laptop-panel size so the OS doesn't treat it as a giant TV.
private let MM_PER_INCH = 25.4
private let ASSUMED_DPI = 142.0

private func physicalSize(pixelsWide: Int, pixelsHigh: Int) -> NSSize {
    NSSize(
        width: Double(pixelsWide) / ASSUMED_DPI * MM_PER_INCH,
        height: Double(pixelsHigh) / ASSUMED_DPI * MM_PER_INCH
    )
}

private func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

private func fail(_ reason: String) -> Never {
    emit("FAIL \(reason)")
    exit(1)
}

private func activeDisplayIDs() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    return Array(ids.prefix(Int(count)))
}

// MARK: - Arguments

/// Requested PIXEL size. The phone sends its own viewport (scaled) so the
/// stream doesn't need letterboxing; defaults are a safe 1080p.
private func parseArgs() -> (width: Int, height: Int) {
    var width = 1920
    var height = 1080
    var args = Array(CommandLine.arguments.dropFirst())
    while let flag = args.first {
        args.removeFirst()
        switch flag {
        case "--width":
            width = Int(args.first ?? "") ?? width
            if !args.isEmpty { args.removeFirst() }
        case "--height":
            height = Int(args.first ?? "") ?? height
            if !args.isEmpty { args.removeFirst() }
        default:
            break
        }
    }
    // Clamp: a 0-size or absurd display is rejected by the WindowServer with the
    // same silent non-attach as any other bad config, which is hard to diagnose.
    width = min(max(width, 640), 7680)
    height = min(max(height, 480), 4320)
    return (width, height)
}

// MARK: - Private API access

/// Resolves a private class by name. Nil (not a crash) when Apple removes it.
private func privateClass(_ name: String) -> NSObject.Type? {
    NSClassFromString(name) as? NSObject.Type
}

/// CGVirtualDisplayMode's initializer takes PRIMITIVES, so perform(_:with:)
/// can't call it (it would pass boxed objects and corrupt the arguments).
/// A typed function pointer to the real IMP is the only correct call path.
private typealias ModeInitFn = @convention(c) (AnyObject, Selector, UInt32, UInt32, Double)
    -> AnyObject

private func makeMode(width: Int, height: Int) -> AnyObject? {
    guard let modeClass = privateClass("CGVirtualDisplayMode"),
          let allocated = modeClass.perform(NSSelectorFromString("alloc"))?
              .takeUnretainedValue()
    else { return nil }
    let selector = NSSelectorFromString("initWithWidth:height:refreshRate:")
    guard let imp = (allocated as AnyObject).method(for: selector) else { return nil }
    let modeInit = unsafeBitCast(imp, to: ModeInitFn.self)
    return modeInit(allocated, selector, UInt32(width), UInt32(height), REFRESH_HZ)
}

private func makeDescriptor(width: Int, height: Int) -> NSObject? {
    guard let descriptorClass = privateClass("CGVirtualDisplayDescriptor") else { return nil }
    let descriptor = descriptorClass.init()
    descriptor.setValue(DISPLAY_NAME, forKey: "name")
    descriptor.setValue(UInt32(width), forKey: "maxPixelsWide")
    descriptor.setValue(UInt32(height), forKey: "maxPixelsHigh")
    descriptor.setValue(
        physicalSize(pixelsWide: width, pixelsHigh: height), forKey: "sizeInMillimeters")
    descriptor.setValue(VENDOR_ID, forKey: "vendorID")
    descriptor.setValue(PRODUCT_ID, forKey: "productID")
    // "serialNumber", NOT "serialNum" — both exist on the class and the old
    // reverse-engineered headers name the wrong one. Verified by enumerating
    // the live class with class_copyPropertyList on macOS 26.1.
    descriptor.setValue(SERIAL_NUMBER, forKey: "serialNumber")
    descriptor.setValue(DispatchQueue.main, forKey: "queue")

    // Trap 2: without a termination handler the WindowServer drops the client
    // right after applySettings: and nothing ever attaches. The block itself
    // only needs to exist; it fires when the OS tears the display down (e.g.
    // display sleep or a WindowServer restart), which is our cue to exit so the
    // Node side notices and can restart cleanly rather than holding a dead id.
    let onTerminate: @convention(block) (AnyObject?) -> Void = { _ in
        FileHandle.standardError.write(Data("[mm-vdisplay] terminated by system\n".utf8))
        exit(0)
    }
    descriptor.perform(NSSelectorFromString("setTerminationHandler:"), with: onTerminate)
    return descriptor
}

private func makeSettings(mode: AnyObject) -> NSObject? {
    guard let settingsClass = privateClass("CGVirtualDisplaySettings") else { return nil }
    let settings = settingsClass.init()
    settings.setValue([mode], forKey: "modes")
    settings.setValue(HIDPI_SCALE, forKey: "hiDPI")
    return settings
}

/// Trap 1: applySettings: lies. Poll for the id actually joining the active
/// display list — that is the only real proof the display exists.
private func waitForAttach(displayID: CGDirectDisplayID) -> Bool {
    let deadline = Date().addingTimeInterval(ATTACH_TIMEOUT_SECONDS)
    while Date() < deadline {
        // Pumping the main run loop is what lets the WindowServer RPC complete;
        // a bare sleep() here never attaches.
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(ATTACH_POLL_SECONDS))
        if activeDisplayIDs().contains(displayID) { return true }
    }
    return false
}

// MARK: - Main

let requested = parseArgs()

guard let descriptor = makeDescriptor(width: requested.width, height: requested.height) else {
    fail("CGVirtualDisplayDescriptor unavailable on this macOS")
}
guard let displayClass = privateClass("CGVirtualDisplay"),
      let allocatedDisplay = displayClass.perform(NSSelectorFromString("alloc"))?
          .takeUnretainedValue() as? NSObject,
      allocatedDisplay.responds(to: NSSelectorFromString("initWithDescriptor:"))
else {
    fail("CGVirtualDisplay unavailable on this macOS")
}
// Held for the process lifetime: releasing it tears the display down.
let virtualDisplay = allocatedDisplay
_ = virtualDisplay.perform(NSSelectorFromString("initWithDescriptor:"), with: descriptor)

guard let displayID = virtualDisplay.value(forKey: "displayID") as? UInt32, displayID != 0 else {
    fail("no displayID assigned")
}
guard let mode = makeMode(width: requested.width, height: requested.height) else {
    fail("CGVirtualDisplayMode unavailable on this macOS")
}
guard let settings = makeSettings(mode: mode) else {
    fail("CGVirtualDisplaySettings unavailable on this macOS")
}
guard virtualDisplay.perform(NSSelectorFromString("applySettings:"), with: settings) != nil else {
    fail("applySettings rejected")
}
guard waitForAttach(displayID: displayID) else {
    fail("display never attached (applySettings reported success)")
}

// Report the bounds macOS ACTUALLY assigned, not what we asked for: the
// WindowServer chooses the position, and hiDPI:2 halves the logical size.
let bounds = CGDisplayBounds(displayID)
emit(
    "READY \(displayID) \(Int(bounds.origin.x)) \(Int(bounds.origin.y)) "
        + "\(Int(bounds.width)) \(Int(bounds.height))"
)

// Teardown. Dropping the last reference is what actually removes the display, so
// the exit path must run — a SIGKILL would strand it until the OS notices the
// dead RPC client.
func teardown() -> Never {
    // Give the WindowServer a moment to process the removal before the process
    // image disappears, so windows migrate back to the real screen cleanly.
    _ = virtualDisplay.perform(NSSelectorFromString("applySettings:"), with: nil)
    exit(0)
}

for signalNumber in [SIGINT, SIGTERM] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { teardown() }
    source.resume()
    // Sources are intentionally leaked: they must outlive this loop iteration
    // and the process exits via teardown() anyway.
    _ = Unmanaged.passRetained(source as AnyObject)
}

// stdin EOF is the primary stop signal: if the Electron app is force-quit its
// child's pipe closes, and a helper that only watched for SIGTERM would keep a
// phantom monitor attached with the user's windows on it.
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
stdinSource.setEventHandler {
    var buffer = [UInt8](repeating: 0, count: 256)
    let bytesRead = read(STDIN_FILENO, &buffer, buffer.count)
    if bytesRead <= 0 { teardown() }
}
stdinSource.resume()

// Trap 2 again: this run loop IS the display's lifeline, not just an idle wait.
RunLoop.main.run()
