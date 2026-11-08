// main.swift — no Xcode project, so this hand-rolls the NSApplication entry
// point (mirrors the "no Xcode project checked in" convention from native/,
// just for a windowed app instead of a CLI helper).

import SwiftUI
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let model = InstallerModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let hosting = NSHostingView(rootView: ContentView(model: model))
        hosting.frame = CGRect(x: 0, y: 0, width: 340, height: 320)

        window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "MightyMouse Installer"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.contentView = hosting
        window.center()
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
struct Main {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
