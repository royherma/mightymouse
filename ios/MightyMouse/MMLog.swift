import Foundation
import os

/// Launch-path logging, readable off-device via
/// `log stream --predicate 'subsystem == "com.mightymouse.ios"'`.
///
/// `os.Logger` rather than `print`, which only exists while Xcode is attached.
enum MMLog {
    /// Not private: the debug panel reads the unified log back by this value.
    static let subsystem = "com.mightymouse.ios"

    static let phase = Logger(subsystem: subsystem, category: "phase")
    static let discovery = Logger(subsystem: subsystem, category: "discovery")
    static let webview = Logger(subsystem: subsystem, category: "webview")
    static let pairing = Logger(subsystem: subsystem, category: "pairing")
    /// Spans two processes: the widget extension writes the arm flag, the app
    /// reads it. One category so a single stream shows both halves.
    static let recording = Logger(subsystem: subsystem, category: "recording")
    /// Control Center buttons -- same two-process span as `recording`, kept
    /// separate so an Ask trace isn't buried in the audio-queue chatter.
    static let control = Logger(subsystem: subsystem, category: "control")
    static let pip = Logger(subsystem: subsystem, category: "pip")
    static let glasses = Logger(subsystem: subsystem, category: "glasses")
}
