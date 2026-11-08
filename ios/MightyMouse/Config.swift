import Foundation

/// Mirrors `SUPABASE_ENVS` in `src/shared/config.ts`, keyed off Debug-vs-Release
/// via the two `MM_SUPABASE_*` Info.plist values.
///
/// Nothing here may be hardcoded: a literal ref pins the shell to prod while
/// every other surface follows the build flag.
enum AppConfig {
    /// Fails at launch rather than 401-ing every auth call against a URL nobody
    /// can see.
    private static func requiredString(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty,
              !value.hasPrefix("$(") else {
            fatalError("Info.plist is missing \(key) — check the target's build settings.")
        }
        return value
    }

    /// e.g. `nyfzsxuslvceajlxmvry` (staging) or `czylhdjjfsxyltvgnnyh` (prod).
    static let supabaseRef = requiredString("MMSupabaseRef")

    static let supabaseAnonKey = requiredString("MMSupabaseAnonKey")

    static let supabaseURL = URL(string: "https://\(supabaseRef).supabase.co")!

    // No download URL constant on purpose: every route to the Mac app goes
    // through an email (lobby-download-link from the lobby, send-download-link
    // once signed in), so the address is always captured.

    static var portalChatURL: URL {
        let host = supabaseRef == "nyfzsxuslvceajlxmvry"
            ? "mightymouse-portal-staging.pages.dev"
            : "app.getmightymouse.com"
        return URL(string: "https://\(host)/chat")!
    }

    /// Mirrors `IOS_APP_UA_TAG` in portal/src/lib/platform.ts.
    static let inAppUserAgentTag = "MightyMouseApp"

    /// Mirrors `CONFIG.PHONE_REMOTE.PAIR_CODE_LENGTH`, and the sign-in code.
    static let pairCodeLength = 6

    #if DEBUG
    /// Ref-gated as well as `#if DEBUG` — a `#if` alone still fires on a Debug
    /// build pointed at prod. The password has NO literal fallback on purpose:
    /// with one, nobody notices the build setting was never wired.
    static var stagingTestAdmin: (email: String, password: String)? {
        guard supabaseRef == "nyfzsxuslvceajlxmvry" else { return nil }
        guard let password = (Bundle.main.object(forInfoDictionaryKey: "MMStagingTestPassword") as? String)
            .flatMap({ $0.hasPrefix("$(") || $0.isEmpty ? nil : $0 }) else { return nil }
        return ("test-admin@staging.local", password)
    }
    #endif

    /// Mirrors `CONFIG.PHONE_REMOTE.PORT`. Only the first guess — the server
    /// retries upward through `PORT_RANGE_SIZE` ports.
    static let phoneRemotePort = 17771

    /// Mirrors `CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_KEY`. Stored under the web
    /// prefix so bootstrap hands it to JS, which is what opens the socket.
    static let deviceCredentialKey = "mm-remote-device-credential"

    /// Mirrors `CONFIG.PHONE_REMOTE.DISCOVERY_LAST_TUNNEL_HOST_KEY`. Bare host,
    /// no scheme or port — the tunnel terminates TLS on 443. Written by the web
    /// bundle, read here as discovery's off-LAN rung.
    static let lastTunnelHostKey = "mm-remote-last-tunnel-host"

    /// Mirrors `CONFIG.PHONE_REMOTE.PUSH_TOKEN_PATH`.
    static let pushTokenPath = "/push-token"

    /// Mirrors `CONFIG.PHONE_REMOTE.RELAY_REQUEST_PATH`. The NSE's GET to
    /// resolve a content-free push into real question/options/image data.
    static let relayRequestPath = "/relay-request"

    /// Mirrors `CONFIG.PHONE_REMOTE.RELAY_RESPOND_PATH`. Where a lock-screen
    /// notification action posts its answer.
    static let relayRespondPath = "/relay-respond"

    /// Mirrors `CONFIG.PHONE_REMOTE.RELAY_IMAGE_PATH`. The NSE's second fetch
    /// for a `show` verb, scoped server-side by request_id -- see server.ts.
    static let relayImagePath = "/relay-image"

    /// The sender's project picture, served by the Mac for the NSE's communication notification.
    static let relayAvatarPath = "/relay-avatar"

    /// Mirrors `CONFIG.PHONE_REMOTE.SHARE_PATH`. Where the share extension puts
    /// one image or one string of text; `submit` decides whether the Mac
    /// presses Return after pasting.
    static let sharePath = "/share"

    /// Mirrors `CONFIG.PHONE_REMOTE.INTENT_PATH`. Runs one named action from
    /// the Mac's closed table -- the Siri path, which reaches the Mac with the
    /// app closed and no socket open.
    static let intentPath = "/intent"

    /// 2048px long edge at JPEG q0.85 lands ~300-500 KB. A share extension has
    /// a tighter memory ceiling than the app (~120 MB) and a full-res burst
    /// screenshot is exactly what trips it, so the downscale happens here
    /// rather than on the Mac.
    static let shareImageMaxPixel: CGFloat = 2048
    static let shareImageQuality: CGFloat = 0.85

    /// Read from the bundle, never typed into a view: the repo folder is called
    /// ShowAndTell and that name must never reach a screen.
    static let appName = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
        ?? "MightyMouse"

    /// e.g. `iPhone16,2`. Sent RAW so the Mac owns the identifier→name table and
    /// can gain next September's rows without an App Store submission.
    static var hardwareIdentifier: String {
        var info = utsname()
        uname(&info)
        // Copied to a local first: reading `info.machine` for the capacity
        // INSIDE the closure overlaps the `&` access and the exclusivity
        // checker rejects it.
        let machine = info.machine
        let size = MemoryLayout.size(ofValue: machine)
        return withUnsafePointer(to: machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: size) { String(cString: $0) }
        }
    }

    /// `CFBundleVersion`, so the Mac can tell which native build a phone is on.
    static let appBuild = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? ""
}
