// Throwaway probe fixture: a borderless full-screen magenta window, own pid.
import Cocoa

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let screen = NSScreen.main!
let window = NSWindow(
    contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false
)
window.backgroundColor = NSColor(red: 1, green: 0, blue: 1, alpha: 1)
window.level = .screenSaver
window.isOpaque = true
window.ignoresMouseEvents = true
window.makeKeyAndOrderFront(nil)

// Never outlive the probe that spawned it.
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { exit(0) }
app.run()
