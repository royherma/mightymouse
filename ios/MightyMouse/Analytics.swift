import Foundation
import MetricKit
import UIKit

/// Analytics → Supabase `public.events`, mirroring `src/main/analytics.ts`.
///
/// Writes through the `events-ingest` Edge Function with the anon key already in
/// the bundle. The desktop client still inserts straight to PostgREST; this
/// surface does not, because the function is the only place the caller's IP is
/// visible, and geo is the one thing a phone cannot report about itself. The
/// function holds the service-role key and this binary never does, so a key
/// lifted out of here can write events and can never read anyone's data.
///
/// Same contract as the desktop client, for the same reasons:
/// - fire-and-forget — `track()` never throws, never blocks a view, and a failed
///   flush re-buffers rather than surfacing anything to the user. Analytics must
///   not be able to break the product it measures.
/// - anonymous-first — every row carries a stable `anon_id` from the very first
///   launch, so the install → sign-in step is measurable at all. `user_id` is
///   attached once OTP completes, and `stitch_identity` backfills the rows that
///   came before it.
///
/// The event names and prop shapes live in `src/shared/analytics-events.ts` and
/// are duplicated here as literals because Swift cannot import TypeScript. That
/// duplication is the one real risk in this file: a rename there silently
/// becomes a dead event here. Both sides are covered by
/// `src/shared/ios-analytics-contract.test.ts`, which parses THIS file and fails
/// if the two drift.
@MainActor
final class Analytics {
    static let shared = Analytics()

    /// Unprefixed (unlike `Credentials.webKeyPrefix` keys) so the webview never
    /// sees it. Not private: `AppModel`'s fresh-install sweep must skip this key.
    static let anonIdKey = "analytics-anon-id"

    /// Matches `MAX_BUFFER` in the desktop client. A cap rather than a queue: a
    /// phone with no connectivity must not grow this without bound.
    private static let maxBuffer = 50

    /// Retry cadence for rows a failed insert re-buffered, so they don't wait
    /// for a `track()` call that may never come before the app is killed.
    private static let flushInterval: TimeInterval = 15

    /// A foreground return inside this window is the same visit, not a new one —
    /// without it, flicking through the app switcher would inflate DAU.
    private static let foregroundDebounce: TimeInterval = 30

    private let credentials: Credentials
    private let session = URLSession.shared
    /// Minted per process, matching the desktop's per-launch `SESSION_ID`.
    private let sessionId = UUID().uuidString
    private var buffer: [[String: Any]] = []
    private static let maxErrorsPerLaunch = 20
    private static let crashForwarder = CrashReportForwarder()
    private var errorBuffer: [[String: Any]] = []
    private var errorsReported = 0
    private var userId: String?
    private var flushTimer: Timer?
    private var lastForegroundAt: Date?
    /// Distinguishes the first `ios_app_launch` of a process from later resumes.
    private var hasLaunched = false
    /// Last state reported by the WebView, so `trackConnection` fires on
    /// transitions only. Deliberately not persisted: a fresh launch is a fresh
    /// pairing attempt worth counting.
    private var lastConnState: String?

    private init(credentials: Credentials = Credentials()) {
        self.credentials = credentials
    }

    /// Stable per-install id (counts PHONES, not Macs). Keychain, not
    /// UserDefaults: surviving an uninstall is the point — a remint would
    /// inflate installs and destroy retention.
    private var anonId: String {
        if let existing = credentials.value(for: Self.anonIdKey) { return existing }
        let minted = UUID().uuidString
        credentials.set(minted, for: Self.anonIdKey)
        return minted
    }

    /// Every row carries these, matching the desktop's `identityFields()`.
    private func identityFields() -> [String: Any] {
        [
            "anon_id": anonId,
            "session_id": sessionId,
            "user_id": userId as Any,
            "app_version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            // Constrained by the events_platform_check CHECK (migration 0058).
            // A typo here is a rejected insert, not a silently-orphaned row.
            "platform": "ios"
        ]
    }

    /// Merged into every row's `props`. Here rather than in `identityFields()`
    /// because `events` has no column for them -- and raw, so the server owns
    /// the identifier→marketing-name table (`AppConfig.hardwareIdentifier`).
    private func deviceFields() -> [String: Any] {
        [
            "device": AppConfig.hardwareIdentifier,
            "os": UIDevice.current.systemVersion,
            "build": AppConfig.appBuild
        ]
    }

    // MARK: - Public API

    /// Queue an event. Never throws, never blocks — a dropped event is always
    /// preferable to a broken screen.
    func track(_ event: String, _ props: [String: Any] = [:]) {
        var row = identityFields()
        row["event"] = event
        // Call-site props win: the device fields are context, never the point
        // of the event, and a collision means the call site meant something.
        row["props"] = deviceFields().merging(props) { _, callSite in callSite }
        buffer.append(row)
        if buffer.count > Self.maxBuffer { buffer.removeFirst(buffer.count - Self.maxBuffer) }
        Task { await flush() }
    }

    func trackError(kind: String, message: String, stack: String? = nil, props: [String: Any] = [:]) {
        guard errorsReported < Self.maxErrorsPerLaunch else { return }
        errorsReported += 1
        var row = identityFields()
        row["kind"] = kind
        row["message"] = String(message.prefix(4000))
        // PostgREST rejects a batch whose rows carry different keys, so a missing stack is null, not absent.
        row["stack"] = stack.map { String($0.prefix(8000)) as Any } ?? NSNull()
        row["source"] = "ios"
        row["props"] = deviceFields().merging(props) { _, callSite in callSite }
        errorBuffer.append(row)
        Task { await flushErrors() }
    }

    func startCrashReporting() {
        MXMetricManager.shared.add(Self.crashForwarder)
    }

    /// Called on every foreground, including the first. `cold` splits a genuine
    /// process start from a resume, so one event serves both install and DAU.
    func trackForeground() {
        let now = Date()
        if let last = lastForegroundAt, now.timeIntervalSince(last) < Self.foregroundDebounce { return }
        lastForegroundAt = now
        let cold = !hasLaunched
        hasLaunched = true
        track(AnalyticsEvent.appLaunch, ["cold": cold])
    }

    /// The WebView owns connection state (`ios/CLAUDE.md`), so the pair funnel is
    /// derived from its transitions rather than tracked separately in Swift.
    /// `connecting` is the attempt, `connected` the success, `blocked` the
    /// failure with the server's own reason; `disconnected` is an ordinary
    /// teardown and not a funnel step.
    ///
    /// De-duped on the state itself because a flaky link re-enters `connecting`
    /// on every reconnect, which would report one pairing as dozens of attempts.
    func trackConnection(state: String, reason: String?) {
        guard state != lastConnState else { return }
        lastConnState = state
        // `manual` splits a typed code from a scan. Swift never sees which was
        // used -- the code rides the QR URL into the deck -- so a scan is the
        // only case it can attest to, and a lobby entered without one is manual.
        let manual = !Prefs.pairedByScan
        switch state {
        case "connecting":
            track(AnalyticsEvent.pairStarted, ["manual": manual])
        case "connected":
            track(AnalyticsEvent.pairSucceeded, ["manual": manual])
        case "blocked":
            track(AnalyticsEvent.pairFailed, [
                "manual": manual,
                "reason": Self.pairFailReason(from: reason)
            ])
        default:
            break
        }
    }

    /// The web machine's `BlockedReason` is a different vocabulary from
    /// `IosPairFailReason`; an unmapped value would silently become a name no
    /// dashboard query matches, so anything unknown lands on `other`.
    private static func pairFailReason(from blocked: String?) -> String {
        switch blocked {
        case "no-credential", "credential-revoked": return PairFailReason.invalidCode
        case "mac-unreachable": return PairFailReason.unreachable
        case "rate-limited": return PairFailReason.rateLimited
        default: return PairFailReason.other
        }
    }

    /// On sign-in: attach `user_id` going forward and backfill every anonymous
    /// row this install already wrote, so one person's phone and Mac resolve to
    /// one identity. Mirrors `identify()` in the desktop client.
    func identify(userId: String) {
        self.userId = userId
        Task { await stitchIdentity(userId: userId) }
    }

    func signOut() {
        userId = nil
    }

    /// `user_id` is the JWT's subject, not the email — `events` has a FK onto
    /// `auth.users(id)`. Decoded locally, not via `/auth/v1/user`, to avoid a
    /// network hop in front of sign-in; signature is unverified since GoTrue already validated it.
    static func subject(ofJWT token: String) -> String? {
        let segments = token.split(separator: ".")
        guard segments.count == 3 else { return nil }
        var payload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // base64url drops the padding that Foundation's decoder requires.
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sub = json["sub"] as? String else { return nil }
        return sub
    }

    /// Start the retry loop. Idempotent. Without it a row that fails its first
    /// insert waits for the next `track()`, which on a phone often never comes.
    func startFlushLoop() {
        guard flushTimer == nil else { return }
        flushTimer = Timer.scheduledTimer(withTimeInterval: Self.flushInterval, repeats: true) { _ in
            Task { @MainActor in
                await self.flush()
                await self.flushErrors()
            }
        }
    }

    // MARK: - Transport

    private func flush() async {
        guard !buffer.isEmpty else { return }
        let batch = buffer
        buffer = []
        guard let body = try? JSONSerialization.data(withJSONObject: batch) else { return }

        // The events-ingest Edge Function, not /rest/v1/events directly. The one
        // thing it adds is the caller's IP: a PostgREST insert arrives with the
        // phone's location nowhere in the payload or the headers, so every
        // install was unattributable to any country. The function resolves the
        // IP server-side and merges country/city/asn into props before writing.
        // Nothing about the fire-and-forget contract changes -- a non-2xx still
        // re-buffers below, exactly as it did against PostgREST.
        var request = URLRequest(url: AppConfig.supabaseURL.appendingPathComponent("/functions/v1/events-ingest"))
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(AppConfig.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                requeue(batch)
                return
            }
        } catch {
            requeue(batch)
        }
    }

    /// Put a failed batch back, oldest-first, and drop the excess. Newest rows
    /// win a tie: on a phone that has been offline for a day, the recent funnel
    /// is worth more than the stale one.
    private func requeue(_ batch: [[String: Any]]) {
        buffer = Array((batch + buffer).suffix(Self.maxBuffer))
    }

    private func flushErrors() async {
        guard !errorBuffer.isEmpty else { return }
        let batch = errorBuffer
        errorBuffer = []
        guard let body = try? JSONSerialization.data(withJSONObject: batch) else { return }

        var request = URLRequest(url: AppConfig.supabaseURL.appendingPathComponent("/rest/v1/errors"))
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(AppConfig.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = body

        let status = ((try? await session.data(for: request))?.1 as? HTTPURLResponse)?.statusCode
        // A 4xx is a row the table will never take; only no-answer and 5xx are worth another try.
        if status == nil || status! >= 500 {
            errorBuffer = Array((batch + errorBuffer).suffix(Self.maxBuffer))
        }
    }

    private func stitchIdentity(userId: String) async {
        var request = URLRequest(url: AppConfig.supabaseURL.appendingPathComponent("/rest/v1/rpc/stitch_identity"))
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(AppConfig.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["p_anon": anonId, "p_user": userId])
        _ = try? await session.data(for: request)
    }
}

private final class CrashReportForwarder: NSObject, MXMetricManagerSubscriber {
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let crashes = payloads.flatMap { $0.crashDiagnostics ?? [] }.map { crash in
            (
                message: [
                    crash.exceptionReason?.composedMessage,
                    crash.terminationReason,
                    crash.exceptionType.map { "exception type \($0)" },
                    crash.signal.map { "signal \($0)" }
                ].compactMap { $0 }.joined(separator: " - "),
                stack: Self.crashedThreadFrames(crash.callStackTree),
                props: [
                    "crash_version": crash.applicationVersion,
                    "crash_build": crash.metaData.applicationBuildVersion,
                    "crash_os": crash.metaData.osVersion
                ]
            )
        }
        Task { @MainActor in
            for crash in crashes {
                Analytics.shared.trackError(
                    kind: "ios.crash",
                    message: crash.message.isEmpty ? "crash" : crash.message,
                    stack: crash.stack,
                    props: crash.props)
            }
        }
    }

    private static func crashedThreadFrames(_ tree: MXCallStackTree) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: tree.jsonRepresentation()) as? [String: Any],
              let stacks = json["callStacks"] as? [[String: Any]],
              let crashed = stacks.first(where: { $0["threadAttributed"] as? Bool == true }) ?? stacks.first
        else { return nil }
        var lines: [String] = []
        var frames = crashed["callStackRootFrames"] as? [[String: Any]] ?? []
        while let frame = frames.first {
            lines.append("\(frame["binaryName"] ?? "?") \(frame["binaryUUID"] ?? "?") +\(frame["offsetIntoBinaryTextSegment"] ?? "?")")
            frames = frame["subFrames"] as? [[String: Any]] ?? []
        }
        return lines.joined(separator: "\n")
    }
}

/// Event names + prop values, mirroring `ANALYTICS_EVENT` and the reason unions
/// in `src/shared/analytics-events.ts`. Constants rather than inline literals so
/// a call site can't invent a name that no dashboard query will ever match.
enum AnalyticsEvent {
    static let appLaunch = "ios_app_launch"
    static let signInStarted = "ios_signin_started"
    static let signInCompleted = "ios_signin_completed"
    static let signInFailed = "ios_signin_failed"
    static let pairStarted = "ios_pair_started"
    static let pairSucceeded = "ios_pair_succeeded"
    static let pairFailed = "ios_pair_failed"
    static let discoveryResult = "ios_discovery_result"
    static let localNetworkPrimed = "ios_local_network_primed"
    static let chatOpened = "ios_chat_opened"
}

/// Mirrors `IosSignInFailReason`.
enum SignInFailReason {
    static let rateLimited = "rate_limited"
    static let badCode = "bad_code"
    static let network = "network"
    static let other = "other"
}

/// Mirrors `IosPairFailReason`.
enum PairFailReason {
    static let invalidCode = "invalid_code"
    static let rateLimited = "rate_limited"
    static let badHost = "bad_host"
    static let unreachable = "unreachable"
    static let other = "other"
}

/// Mirrors `IosDiscoveryOutcome`.
enum DiscoveryOutcome {
    static let found = "found"
    static let notFound = "not_found"
    static let unresolved = "unresolved"
    static let blocked = "blocked"
    /// Not a sweep result: the user tapped back off the connect screen. It exists
    /// so routing can tell "we looked and failed" from "they chose to leave",
    /// which are the same nil state otherwise and render the searching screen.
    static let left = "left"
}
