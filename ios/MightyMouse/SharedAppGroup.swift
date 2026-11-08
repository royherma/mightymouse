import Foundation

/// The App Group both the app and `MightyMouseWidgets` read/write. Member of
/// both targets so neither hardcodes the id (docs/conventions.md: no magic
/// strings) and a rename only ever needs one edit.
enum SharedAppGroup {
    static let id = "group.com.mightymouse.ios"

    static var defaults: UserDefaults {
        guard let store = UserDefaults(suiteName: id) else {
            // The simulator has no provisioning profile, so the group container
            // never exists there and this crashed before the first screen drew
            // -- which blocked every UI screenshot sweep. Falling back keeps the
            // app-half working (the widget process, the only other reader, does
            // not run on the sim anyway). Still fatal on device, where a missing
            // group IS the entitlement bug this was written to catch.
            #if targetEnvironment(simulator)
            return .standard
            #else
            fatalError("App Group \(id) is missing from this target's entitlements.")
            #endif
        }
        return store
    }

    /// Key the widget extension's `StartRecordingIntent` writes and the app
    /// reads on launch to arm foreground recording. A raw `Bool` default
    /// (`false`) is indistinguishable from "never armed", which is fine here:
    /// the app clears the flag the instant it acts on it.
    static let armRecordingKey = "mm.armRecording"
    static let armAskKey = "mm.armAsk"

    /// Where `AudioCapture` writes finished recordings and the app-only
    /// `RecordingModel` reads them back to flush. Only the app target ever
    /// touches this directory -- the extension writes nothing but the arm flag.
    /// Nil only when the group container is genuinely absent. On the simulator
    /// that is always -- see `defaults` -- so it falls back to the app's own
    /// Documents dir, which the sim-only reader (`RecordingModel`) is happy with.
    private static var containerURL: URL? {
        if let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) {
            return shared
        }
        #if targetEnvironment(simulator)
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        #else
        return nil
        #endif
    }

    static var projectAvatarsDirectory: URL? {
        guard let dir = containerURL?.appendingPathComponent("project-avatars", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var recordingsDirectory: URL {
        guard let container = containerURL else {
            fatalError("App Group \(id) container is unavailable.")
        }
        let dir = container.appendingPathComponent("recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Last host status NativeBridge persisted from a `hostStatus` message, for
    /// the home-screen widget (a separate process) to read. Absent
    /// `hostBatteryPercentKey` means a Mac with no battery (Mini/Studio/Mac
    /// Pro) -- never a sentinel 0 or 100. `hostStatusAtKey` is epoch ms; the
    /// widget derives staleness/"Not connected" from ITS age, never a bool
    /// read off the wire (ios/CLAUDE.md: Swift owns no connection state).
    static let hostBatteryPercentKey = "mm.hostBatteryPercent"
    static let hostChargingKey = "mm.hostCharging"
    static let hostNameKey = "mm.hostName"
    static let hostStatusAtKey = "mm.hostStatusAt"

    /// A Live Activity Stop the page has not acted on yet. `emit` is
    /// `evaluateJavaScript` into a webview whose app is backgrounded or locked
    /// -- exactly the state Stop is pressed from -- and there is no ack, no
    /// retry and no queue behind it, so the mirror kept playing while the
    /// activity vanished. The page drains this on its next foreground.
    static let pendingStopKey = "mm.pendingStop"
    static let pendingStopMirrorKey = "mm.pendingStopMirror"

    /// Mirror of `Prefs.lastRemoteURL` (which lives in `UserDefaults.standard`,
    /// invisible to an extension process). The Notification Service Extension
    /// has no other way to learn which Mac to fetch a relay request from --
    /// `Prefs` writes here too so the two never drift.
    static let lastRemoteURLKey = "mm.lastRemoteURL"

    /// A relay push tapped before the deck could show its card. Cleared ONLY by
    /// the page's `relayIntentHandled` ack -- clearing at emit time lost the tap,
    /// since the bridge exists before the page has any subscriber.
    static let pendingRelayRequestIdKey = "mm.pendingRelayRequestId"

    /// When the tap happened. The id now survives until acked, so without a TTL
    /// an unacked one would re-open the same card on every launch forever.
    static let pendingRelayRequestAtKey = "mm.pendingRelayRequestAt"

    /// A Mac asleep overnight still honours the tap; nothing older surprises you.
    static let pendingRelayTTL: TimeInterval = 24 * 60 * 60

    /// Why the last lock-screen answer never reached the Mac: `unauthorized`
    /// (this phone's credential is gone -- only pairing again fixes it) or
    /// `unreachable` (asleep Mac / dead tunnel, fixes itself). Written beside
    /// `pendingRelayRequestIdKey` because a failed tap usually happens with the
    /// app not running at all, so the emit alone reaches nobody. Cleared by the
    /// web bundle once it has shown the user.
    static let pendingRelayAnswerFailureKey = "mm.pendingRelayAnswerFailure"

    /// Lock-screen answers posted while the Mac was unreachable. See
    /// `RelayAnswerQueue`, which owns the shape of the values stored here.
    static let queuedRelayAnswersKey = "mm.queuedRelayAnswers"
}

/// Lock-screen answers that could not be delivered yet, retried on the next
/// foreground.
///
/// Lives here rather than in its own file because the `.xcodeproj` is
/// hand-rolled: a new Swift file needs four manual `project.pbxproj` entries
/// and compiles locally while failing the real build (ios/CLAUDE.md).
///
/// Deliberately NOT a general outbox. It holds only answers -- the one payload
/// whose loss destroys something the user cannot reproduce, since the
/// notification is dismissed the instant they tap and the text they typed
/// exists nowhere else.
enum RelayAnswerQueue {
    /// Small on purpose. A backlog this deep means the Mac has been gone for a
    /// long time, and by then the requests these answer have all timed out --
    /// so an unbounded queue would only replay stale decisions into a fresh
    /// session. Oldest is dropped first: the newest answer is the one whose
    /// request might still be waiting.
    static let maxDepth = 10

    /// Answers are `[String: Any]` bodies built at the tap. Stored as JSON so
    /// they survive a process death -- the app is very often killed between the
    /// failed post and the retry, which is exactly the case an in-memory list
    /// would miss.
    static func enqueue(_ body: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var queued = SharedAppGroup.defaults.array(forKey: SharedAppGroup.queuedRelayAnswersKey) as? [Data] ?? []
        queued.append(data)
        SharedAppGroup.defaults.set(Array(queued.suffix(maxDepth)), forKey: SharedAppGroup.queuedRelayAnswersKey)
    }

    /// Removes and returns everything queued. Drained rather than peeked so a
    /// caller cannot loop forever on a body that will never post; a retry that
    /// fails again re-enqueues through the normal path.
    static func drain() -> [[String: Any]] {
        let queued = SharedAppGroup.defaults.array(forKey: SharedAppGroup.queuedRelayAnswersKey) as? [Data] ?? []
        guard !queued.isEmpty else { return [] }
        SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.queuedRelayAnswersKey)
        return queued.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }
}
