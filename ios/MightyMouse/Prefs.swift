import Foundation

/// Non-secret values that survive a relaunch — the counterpart to
/// `Credentials`, which holds the secrets.
///
/// Not the Keychain: a read there can fail while the device is still locked
/// after a cold boot, and every miss costs a `SecItemCopyMatching` on the
/// launch path. Add a key to `Key` plus a typed accessor; callers never pass a
/// raw string.
enum Prefs {
    /// The `mm.` prefix keeps these clear of anything the webview stores.
    enum Key: String {
        case lastSignInEmail = "mm.lastSignInEmail"
        case accountId = "mm.accountId"
        case lastRemoteURL = "mm.lastRemoteURL"
        case installSeen = "mm.installSeen"
        case localNetworkAsked = "mm.localNetworkAsked"
        case pairedByScan = "mm.pairedByScan"
        case localNetworkPrimed = "mm.localNetworkPrimed"
        case advancedMode = "mm.advancedMode"
        case chatUnlocked = "mm.chatUnlocked"
    }

    private static let store = UserDefaults.standard

    // MARK: - Typed accessors

    /// NOT cleared on `signOut()` — signing back in with the same address is
    /// the common path.
    static var lastSignInEmail: String? {
        get { value(for: .lastSignInEmail) }
        set { set(newValue, for: .lastSignInEmail) }
    }

    static var accountId: String? {
        get { value(for: .accountId) }
        set { set(newValue, for: .accountId) }
    }

    /// Tried before sweeping again. Safe to be wrong — a stale host fails its
    /// probe and hands over to discovery. Survives `signOut()`: names a machine.
    /// Mirrored into the App Group on every write -- the Notification Service
    /// Extension runs in a separate process and can only see it there.
    static var lastRemoteURL: URL? {
        get { value(for: .lastRemoteURL).flatMap(URL.init(string:)) }
        set {
            set(newValue?.absoluteString, for: .lastRemoteURL)
            SharedAppGroup.defaults.set(newValue?.absoluteString, forKey: SharedAppGroup.lastRemoteURLKey)
        }
    }

    /// Absent here but present in the Keychain is the only reliable signal of a
    /// delete-and-reinstall: this dies with the app container, the Keychain not.
    static var installSeen: Bool {
        get { store.bool(forKey: Key.installSeen.rawValue) }
        set { store.set(newValue, forKey: Key.installSeen.rawValue) }
    }

    /// Tracks the ASK, not the answer — iOS exposes no way to read the current
    /// grant, so a later launch re-sweeps and lets the browser say.
    static var localNetworkAsked: Bool {
        get { store.bool(forKey: Key.localNetworkAsked.rawValue) }
        set { store.set(newValue, forKey: Key.localNetworkAsked.rawValue) }
    }

    /// Set by `handleScan`, read only by analytics to split a scanned pairing
    /// from a typed one. Sticky by design: the scan is what got this install
    /// paired, and later reconnects to the same Mac inherit that.
    static var pairedByScan: Bool {
        get { store.bool(forKey: Key.pairedByScan.rawValue) }
        set { store.set(newValue, forKey: Key.pairedByScan.rawValue) }
    }

    /// Distinct from `localNetworkAsked`, which gates auto-reconnect. This one
    /// only records that the OS alert has been raised once, so the analytics
    /// event counts installs rather than sweeps.
    static var localNetworkPrimed: Bool {
        get { store.bool(forKey: Key.localNetworkPrimed.rawValue) }
        set { store.set(newValue, forKey: Key.localNetworkPrimed.rawValue) }
    }

    static var advancedMode: Bool {
        get { store.bool(forKey: Key.advancedMode.rawValue) }
        set { store.set(newValue, forKey: Key.advancedMode.rawValue) }
    }

    static var chatUnlocked: Bool {
        get { store.bool(forKey: Key.chatUnlocked.rawValue) }
        set { store.set(newValue, forKey: Key.chatUnlocked.rawValue) }
    }

    // MARK: - Primitives

    static func value(for key: Key) -> String? {
        // Treat empty as absent: a blank prefill would still trip the
        // "Add your email address first" guard and read as a bug.
        guard let raw = store.string(forKey: key.rawValue), !raw.isEmpty else { return nil }
        return raw
    }

    static func set(_ value: String?, for key: Key) {
        guard let value, !value.isEmpty else { return remove(key) }
        store.set(value, forKey: key.rawValue)
    }

    static func remove(_ key: Key) {
        store.removeObject(forKey: key.rawValue)
    }
}

extension Notification.Name {
    static let mmAdvancedChanged = Notification.Name("mm.advancedChanged")
}
