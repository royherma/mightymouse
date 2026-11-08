import AVFoundation
import Foundation
import SwiftUI
import UIKit

/// Swift's only job here is picking which URL the WebView loads. Everything
/// past that -- pairing, auth, retry, blocked reasons -- is server-stated and
/// rendered by the page itself.
@MainActor
final class AppModel: ObservableObject {
    @Published var remoteURL: URL?

    /// The last sweep's non-`found` outcome, or nil while one is still running.
    /// NOT connection state — the deck still owns everything past a host being
    /// found. This is only "the search itself ended with nothing", which
    /// previously reported to analytics and left the launch screen spinning
    /// forever with no retry and no explanation.
    @Published private(set) var searchOutcome: String?
    /// A found Mac only takes the screen when the user asked for it; chat stays home otherwise.
    @Published private(set) var showingDeck = false
    @Published private(set) var deckParked = false
    @Published private(set) var chatLink: URL?
    @Published private(set) var showingChat = false
    @Published private(set) var chatOffered = Prefs.advancedMode || Prefs.chatUnlocked
    private var wantsDeck = false
    private var deckMountedUnproven = false

    /// The lobby's email field. Held here rather than in the view so a keyboard
    /// dismissal or a re-render cannot silently drop a half-typed address.
    @Published var downloadEmail = ""
    @Published private(set) var emailingLink = false

    /// Set on a successful send, cleared by the view once the toast has shown.
    /// Deliberately NOT a latched "sent" flag: the endpoint is public and has no
    /// session, so a latch would survive a relaunch and claim a link that this
    /// launch never sent.
    @Published var linkSentToast: String?
    @Published var lobbyError: String?

    /// The lobby only shows as a sheet from chat, paired phones included.
    @Published var connectingMac = false

    let credentials = Credentials()
    let discovery = Discovery()
    let recording = RecordingModel()

    /// Forces a screen on launch so every state can be screenshotted without a
    /// live Mac. Debug-only: a release build must never let a build flag skip
    /// discovery.
    #if DEBUG
    /// `-D MM_UI_STATE_...` at build time, or `SIMCTL_CHILD_MM_UI_STATE=<state> simctl launch` (env arrives; simctl argv never did).
    #if MM_UI_STATE_LOBBY
    static let uiStateOverride: String? = "lobby"
    #elseif MM_UI_STATE_LOBBY_FIRSTRUN
    static let uiStateOverride: String? = "lobby-firstrun"
    #elseif MM_UI_STATE_LOBBY_NOTFOUND
    static let uiStateOverride: String? = "lobby-notfound"
    #elseif MM_UI_STATE_LOBBY_BLOCKED
    static let uiStateOverride: String? = "lobby-blocked"
    #elseif MM_UI_STATE_LAUNCH
    static let uiStateOverride: String? = "launch"
    #elseif MM_UI_STATE_CHAT
    static let uiStateOverride: String? = "chat"
    #elseif MM_UI_STATE_CHAT_MAC
    static let uiStateOverride: String? = "chat-mac"
    #else
    static let uiStateOverride: String? = ProcessInfo.processInfo.environment["MM_UI_STATE"]
    #endif
    #else
    static let uiStateOverride: String? = nil
    #endif

    init() {
        discovery.onFound = { [weak self] url in
            Task { @MainActor in
                guard let self else { return }
                MMLog.phase.log("→ deck (\(url.absoluteString, privacy: .public))")
                // Persisted only on a REAL hit, so the cache can only ever be
                // an address that actually served us.
                Prefs.lastRemoteURL = url
                self.remoteURL = url
                self.searchOutcome = nil
                self.deckMountedUnproven = false
                if self.wantsDeck || self.connectingMac || (!Prefs.advancedMode && self.isPaired) { self.openDeck() }
            }
        }
        discovery.onOutcome = { [weak self] outcome in
            Task { @MainActor in
                guard let self, outcome != DiscoveryOutcome.found else { return }
                MMLog.phase.log("→ dead end (\(outcome, privacy: .public))")
                self.searchOutcome = outcome
                self.serveUnprovenDeckFromCache()
            }
        }
        discovery.onSweepStart = { [weak self] in
            Task { @MainActor in
                self?.serveUnprovenDeckFromCache()
            }
        }
        Self.clearCredentialsIfReinstalled(credentials)
        advancedObserver = NotificationCenter.default.addObserver(forName: .mmAdvancedChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshChatOffered() }
        }

        if Self.uiStateOverride != nil { return }
        // Gated, NOT unconditional: a cold Bonjour sweep touches the LAN, so
        // firing it before the user has asked for anything trips the Local
        // Network alert over a blank screen before the app said what it wanted.
        if Prefs.localNetworkAsked {
            if credentials.value(for: Credentials.webKeyPrefix + AppConfig.deviceCredentialKey) != nil {
                remoteURL = Prefs.lastRemoteURL
                deckMountedUnproven = remoteURL != nil
                showingDeck = remoteURL != nil
            }
            beginDiscovery()
        }
        recording.handleForeground()
    }

    private var advancedObserver: NSObjectProtocol?

    private var isPaired: Bool {
        credentials.value(for: Credentials.webKeyPrefix + AppConfig.deviceCredentialKey) != nil
    }

    private func refreshChatOffered() {
        chatOffered = Prefs.advancedMode || Prefs.chatUnlocked
        if !chatOffered { showingChat = false }
    }

    func unlockChat() {
        Prefs.chatUnlocked = true
        refreshChatOffered()
    }

    /// When the Ask control fired, if the deck hasn't reached `connected` yet.
    /// Held rather than emitted on the spot because a cold launch spends
    /// seconds in discovery with no bridge and no page -- `openChat` sent then
    /// goes nowhere.
    private var askArmedAt: Date?

    /// A tap the user has plainly moved on from. `onConnected` fires on every
    /// reconnect, so without this an arm that never found a Mac would sit live
    /// for the whole session and pop the chat sheet unprompted whenever the
    /// Mac eventually came back -- minutes or hours after the tap.
    private static let askArmTTL: TimeInterval = 90

    /// The Record control's twin of `askArmedAt`. Recording is the DECK's job,
    /// not Swift's: a native AVAudioRecorder alongside the page's mic meant two
    /// recording systems and a native bar the deck knew nothing about.
    private var recordArmedAt: Date?

    private var drawArmedAt: Date?

    /// Reads and clears the Record control's flag, then hands off to the deck.
    private func handleArmedRecording() {
        guard SharedAppGroup.defaults.bool(forKey: SharedAppGroup.armRecordingKey) else { return }
        SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.armRecordingKey)
        MMLog.control.log("foreground: record armed")
        recordArmedAt = Date()
        requestDeck()
        drainArmedRecording()
    }

    /// Also called on the deck's `connected` edge. Shares `askArmTTL`: both are
    /// "a control tap the user has plainly moved on from".
    func drainArmedRecording() {
        guard let armedAt = recordArmedAt, NativeIntentRouter.isConnected else { return }
        recordArmedAt = nil
        let age = Date().timeIntervalSince(armedAt)
        guard age <= Self.askArmTTL else {
            MMLog.control.log("record expired after \(Int(age), privacy: .public)s — dropped")
            return
        }
        MMLog.control.log("record → startRecording emitted")
        NativeIntentRouter.emit(["type": "startRecording"])
    }

    /// The chat page's Draw button: open the deck, then the page's Draw screen once it can hear us.
    func drawTapped() {
        drawArmedAt = Date()
        macTapped()
        drainArmedDraw()
    }

    func drainArmedDraw() {
        guard let armedAt = drawArmedAt, NativeIntentRouter.isConnected else { return }
        drawArmedAt = nil
        guard Date().timeIntervalSince(armedAt) <= Self.askArmTTL else { return }
        NativeIntentRouter.emit(["type": "nativeLog", "text": "draw: openDraw emitted"])
        NativeIntentRouter.emit(["type": "openDraw"])
    }

    /// Reads and clears the widget's flag. Clearing here, not at drain time, is
    /// deliberate: a launch that never reaches a Mac must not leave the flag
    /// armed for the NEXT unrelated launch to act on.
    private func handleArmedAsk() {
        guard SharedAppGroup.defaults.bool(forKey: SharedAppGroup.armAskKey) else { return }
        SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.armAskKey)
        MMLog.control.log("foreground: ask armed")
        askArmedAt = Date()
        requestDeck()
        drainArmedAsk()
    }

    /// A Live Activity Stop the page never received. The emit behind that button
    /// is `evaluateJavaScript` into a backgrounded webview, which is precisely
    /// where Stop is pressed from, so it is delivered on a best-effort basis and
    /// the flag is what makes the stop durable. No TTL: unlike an armed ask,
    /// "stop the thing that is still making noise" does not go stale -- if the
    /// mirror is somehow already off the page's own stop is a no-op.
    private func handlePendingStop() {
        guard SharedAppGroup.defaults.bool(forKey: SharedAppGroup.pendingStopKey) else { return }
        let stopMirror = SharedAppGroup.defaults.bool(forKey: SharedAppGroup.pendingStopMirrorKey)
        MMLog.control.log("foreground: draining pending stop")
        NativeIntentRouter.emit(["type": "nativeLog", "text": "audio: STOP draining pendingStop stopMirror=\(stopMirror) -- REPLAY of a Live Activity Stop"])
        NativeIntentRouter.emit(["type": "nativeStopRequested", "stopMirror": stopMirror])
    }

    /// A relay notification tapped before the deck could show its card. Reads
    /// but does NOT clear here -- see `drainPendingRelayOpen`, which is the
    /// only place that can actually reach the page (`NativeIntentRouter` is
    /// nil until the deck's webview exists, and a cold launch reaches this
    /// function well before that).
    private func handlePendingRelayOpen() {
        guard SharedAppGroup.defaults.string(forKey: SharedAppGroup.pendingRelayRequestIdKey) != nil else { return }
        requestDeck()
        drainPendingRelayOpen()
    }

    /// Answers tapped on the lock screen while the Mac was unreachable. Retried
    /// on foreground rather than on a timer: the app is usually not running
    /// between the failed tap and this call, and a background retry would need
    /// a mode the extension does not have. Unlike the drains above this needs
    /// no `NativeIntentRouter` -- it posts to the Mac directly, so it runs at
    /// foreground time and does not wait for the deck to connect.
    func drainQueuedRelayAnswers() {
        let queued = RelayAnswerQueue.drain()
        guard !queued.isEmpty else { return }
        MMLog.control.log("foreground: retrying \(queued.count, privacy: .public) queued relay answer(s)")
        for body in queued {
            Task {
                do {
                    try await MacRelayClient.post(AppConfig.relayRespondPath, credentials: credentials, body: body)
                } catch let error as MacRelayClient.RelayError where error != .unauthorized {
                    // Still unreachable. Back onto the queue for the next
                    // foreground -- `maxDepth` is what stops this growing.
                    RelayAnswerQueue.enqueue(body)
                } catch {
                    // A credential the Mac refuses will never post, so dropping
                    // it is the only terminating option; the failure surfaced at
                    // tap time via `pendingRelayAnswerFailureKey`.
                    MMLog.control.log("queued relay answer dropped: \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    /// Clears NOTHING -- the page's `relayIntentHandled` ack owns that. An emit is
    /// not a delivery: `isConnected` is true from `makeUIView`, long before React
    /// subscribes, so clearing here lost the tap. Safe to re-run until acked.
    func drainPendingRelayOpen() {
        guard let requestId = SharedAppGroup.defaults.string(forKey: SharedAppGroup.pendingRelayRequestIdKey),
              NativeIntentRouter.isConnected else { return }

        // Only reachable now that the id outlives its launch: an id nothing ever
        // acks (answered on the Mac, a page that never mounts) would otherwise
        // re-open the same card on every launch for the rest of time.
        let tappedAt = SharedAppGroup.defaults.double(forKey: SharedAppGroup.pendingRelayRequestAtKey)
        if tappedAt > 0, Date().timeIntervalSince1970 - tappedAt > SharedAppGroup.pendingRelayTTL {
            MMLog.control.log("pending relay open expired — dropped")
            SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingRelayRequestIdKey)
            SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingRelayAnswerFailureKey)
            SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingRelayRequestAtKey)
            return
        }

        // A failed ANSWER is not an "open the card" -- it is the same id with a
        // reason attached, and emitting the plain open would drop that reason on
        // the floor and show a card that looks perfectly fine.
        if let reason = SharedAppGroup.defaults.string(forKey: SharedAppGroup.pendingRelayAnswerFailureKey) {
            MMLog.control.log("foreground: draining failed relay answer")
            NativeIntentRouter.emit([
                "type": "relayAnswerFailed",
                "requestId": requestId,
                "reason": reason
            ])
            return
        }

        MMLog.control.log("foreground: draining pending relay open")
        NativeIntentRouter.emit(["type": "openRelayRequest", "requestId": requestId])
    }

    /// Also called on the deck's `connected` edge, which is the first moment
    /// `NativeIntentRouter.bridge` exists AND the page can act on an intent.
    func drainArmedAsk() {
        guard let armedAt = askArmedAt, NativeIntentRouter.isConnected else { return }
        askArmedAt = nil
        let age = Date().timeIntervalSince(armedAt)
        guard age <= Self.askArmTTL else {
            MMLog.control.log("ask expired after \(Int(age), privacy: .public)s — dropped")
            return
        }
        MMLog.control.log("ask → openChat emitted")
        NativeIntentRouter.emit(["type": "openChat"])
    }

    /// Drives the lobby's heading to one specific state for a screenshot sweep.
    /// The four headings key off runtime values, not the `#if` ladder, so a bare
    /// `MM_UI_STATE_LOBBY` always lands on whichever one this phone happens to
    /// be in -- which is how four of the five went unscreenshotted and got
    /// hand-drawn instead (src/main/phone-remote/CLAUDE.md).
    ///
    /// DEBUG-only and only ever reached from `routed`, where `uiStateOverride`
    /// is already non-nil and discovery is already suppressed.
    #if DEBUG
    func forceLobbyState(_ forced: String) {
        switch forced {
        case "lobby-firstrun":
            Prefs.lastRemoteURL = nil
            localNetworkAsked = false
            searchOutcome = nil
        case "lobby-notfound":
            Prefs.lastRemoteURL = URL(string: "https://10.0.0.1:17771")
            localNetworkAsked = true
            searchOutcome = DiscoveryOutcome.notFound
        case "lobby-blocked":
            Prefs.lastRemoteURL = URL(string: "https://10.0.0.1:17771")
            localNetworkAsked = true
            searchOutcome = DiscoveryOutcome.blocked
        default:
            // "lobby" -- the searching state, which needs outcome nil and a
            // remembered Mac. This is the one already captured.
            Prefs.lastRemoteURL = URL(string: "https://10.0.0.1:17771")
            localNetworkAsked = true
            searchOutcome = nil
        }
    }
    #endif

    /// Mirrors `Prefs.localNetworkAsked` as published state; a bare UserDefaults
    /// read in `body` is invisible to SwiftUI.
    @Published private(set) var localNetworkAsked = Prefs.localNetworkAsked

    /// Drives the lobby's scanner sheet. The camera is the primary way in: a QR
    /// carries host + port + code, so it answers "where is the Mac" without the
    /// LAN sweep that trips the Local Network alert.
    @Published var scanning = false

    /// A scan that produced no usable target. Rendered on the lobby rather than
    /// inside the scanner, which dismisses itself the moment it decodes.
    @Published var scanError: String?

    /// The lobby's scan tap. No permission of any kind is needed to reach here --
    /// that is the whole point of leading with it.
    func beginScan() {
        scanError = nil
        lobbyError = nil
        scanning = true
    }

    /// A decoded QR, or nil when the user backed out. Swift resolves only the
    /// ADDRESS; the code rides the URL for the deck to spend on `POST /pair`,
    /// because pairing state in Swift is banned (`ios/CLAUDE.md`).
    func handleScan(_ raw: String?) {
        guard let raw else { return }
        guard let url = Self.pairingURL(from: raw) else {
            MMLog.phase.error("qr → FOREIGN, not a MightyMouse pairing code")
            scanError = "That QR code isn't from MightyMouse. Scan the one in MightyMouse Settings on your Mac."
            return
        }
        MMLog.phase.log("qr → deck (\(url.host ?? "?", privacy: .public))")
        discovery.stop()
        searchOutcome = nil
        scanError = nil
        connectingMac = false
        Prefs.lastRemoteURL = url
        // beginDiscovery() is gated on this flag at launch and on foreground,
        // and priming the alert used to be its ONLY writer. A scan-only user
        // therefore never auto-reconnected: the deck worked once and every cold
        // launch after it sat there sweeping nothing. Pairing is the same proof
        // the tap was, so it sets the same flag.
        Prefs.localNetworkAsked = true
        localNetworkAsked = true
        Prefs.pairedByScan = true
        remoteURL = url
        openDeck()
    }

    /// Accepts only an https URL with a host -- the same shape
    /// `parsePairingTarget` enforces on the web side. The query string is kept
    /// verbatim so the deck still sees `?c=`; a scanned payload is
    /// attacker-supplied and is validated by the Mac, never trusted here.
    static func pairingURL(from raw: String) -> URL? {
        guard let url = URL(string: raw),
              url.scheme == "https",
              let host = url.host, !host.isEmpty
        else { return nil }
        return url
    }

    /// Cached host, then the tunnel, then a Bonjour sweep -- whichever answers
    /// first sets `remoteURL` via `discovery.onFound`. Runs unconditionally:
    /// with no credential the deck itself renders `no-credential` and pairs.
    private func beginDiscovery() {
        // Cleared here rather than at each call site: every entry into a sweep
        // has to take the dead-end screen down, or "Try again" leaves it up
        // over a search that is genuinely running.
        searchOutcome = nil
        let tunnelHost = knownTunnelHost()
        if let cached = Prefs.lastRemoteURL {
            discovery.startWithCachedHost(cached, tunnelHost: tunnelHost)
        } else if tunnelHost != nil {
            discovery.startWithTunnelHost(tunnelHost)
        } else {
            discovery.start()
        }
    }

    /// The Mac's public tunnel hostname, if the deck has ever recorded one.
    /// Read from the Keychain, not `Prefs`: the WEB bundle is the only writer
    /// (on socket connect), so a second native copy would disagree with it.
    private func knownTunnelHost() -> String? {
        credentials.value(for: Credentials.webKeyPrefix + AppConfig.lastTunnelHostKey)
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    /// A delete wipes the container but NOT the Keychain, so without this a
    /// reinstall silently restores the previous session. `analytics-anon-id`
    /// is deliberately spared -- it identifies the INSTALL. See `Analytics.anonId`.
    private static func clearCredentialsIfReinstalled(_ credentials: Credentials) {
        defer { Prefs.installSeen = true }
        guard !Prefs.installSeen else { return }
        guard credentials.hasAnyStoredValue() else { return }
        MMLog.phase.log("fresh install with a stale Keychain → cleared")
        credentials.removeAll(except: [Analytics.anonIdKey])
    }

    /// The dead-end screen's "Try again". A full fresh sweep, not a resumed
    /// one: `stop()` bumps the generation so nothing in flight from the failed
    /// attempt can land late and report against this one.
    func retrySearch() {
        MMLog.phase.log("retry search")
        discovery.stop()
        beginDiscovery()
    }

    /// The deck asked to leave -- back off the connect screen, or an unpair.
    ///
    /// Deliberately does NOT sweep. It used to, and that made the back arrow a
    /// no-op you could not escape: discovery re-found the same Mac and remounted
    /// the deck the user had just left. `left` is what keeps routing on the
    /// lobby, since a nil outcome renders the searching screen instead.
    ///
    /// `lastRemoteURL` stays: it is the lobby's "this phone has paired before"
    /// tell, and clearing it told a paired user to go install the Mac app.
    /// Leaving the screen is not the same as forgetting the Mac.
    ///
    /// `outcome` drives the lobby heading, so a caller that did not CHOOSE to
    /// leave must say so -- the origin-down bail-out passes `notFound`.
    func exitToPairing(outcome: String = DiscoveryOutcome.left) {
        MMLog.phase.log("→ lobby (\(outcome, privacy: .public))")
        discovery.stop()
        remoteURL = nil
        searchOutcome = outcome
        connectingMac = showingDeck && outcome == DiscoveryOutcome.notFound
        showingDeck = false
        wantsDeck = false
        deckMountedUnproven = false
        deckParked = false
    }

    /// A paired phone keeps its deck when the Mac is away: the page records offline and shows its own reconnect banner.
    private func serveUnprovenDeckFromCache() {
        guard deckMountedUnproven else { return }
        NativeIntentRouter.bridge?.loadFromCache()
    }

    private func dropUnprovenDeck() {
        guard deckMountedUnproven else { return }
        MMLog.phase.log("saved Mac did not answer → deck unmounted")
        deckMountedUnproven = false
        remoteURL = nil
        if showingDeck { connectingMac = true }
        showingDeck = false
        deckParked = false
    }

    // While the launch check is still running, stopping discovery here would strand the lobby with no sweep.
    func originDown() {
        guard deckMountedUnproven else { return exitToPairing(outcome: DiscoveryOutcome.notFound) }
        dropUnprovenDeck()
    }

    #if DEBUG
    /// Parks a detached model in one outcome so the debug panel can render that
    /// screen. Debug-only: nothing but a real sweep may set this in a shipped
    /// build.
    func forceSearchOutcome(_ outcome: String) {
        searchOutcome = outcome
    }
    #endif

    /// Mail the Mac download link to whatever the user typed. The endpoint owns
    /// the branch on whether that address already has an account -- Swift never
    /// learns who they are, and both arms look identical from here.
    func emailDownloadLink() async {
        let email = downloadEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Matches the endpoint's own check. Catching it here saves a round trip
        // and puts the message next to the field rather than after a spinner.
        guard email.contains("@"), email.contains("."), !email.hasSuffix("@") else {
            lobbyError = "That email doesn't look right. Check it and try again."
            return
        }
        guard !emailingLink else { return }

        emailingLink = true
        lobbyError = nil
        defer { emailingLink = false }

        var request = URLRequest(
            url: AppConfig.supabaseURL.appendingPathComponent("/functions/v1/lobby-download-link"))
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(AppConfig.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["email": email, "source": "ios_lobby"])

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200..<300:
                MMLog.phase.log("lobby: download link sent")
                downloadEmail = ""
                linkSentToast = "Sent - check your inbox"
            case 429:
                // The cap is per address per day. Saying "already sent" is the
                // honest reading: they have the mail, it just isn't a new one.
                lobbyError = "We've already sent that a few times today. Check your inbox, including spam."
            default:
                lobbyError = "Couldn't send that just now. Try again in a moment."
            }
        } catch {
            lobbyError = "Couldn't reach us. Check your connection and try again."
        }
    }

    /// The chat's laptop button: straight to the remote when the Mac already answered, else the lobby sheet.
    func macTapped() {
        showingChat = false
        if remoteURL != nil, !deckMountedUnproven || deckParked { return openDeck() }
        connectingMac = true
        if searchOutcome == DiscoveryOutcome.left || (deckMountedUnproven && searchOutcome == DiscoveryOutcome.notFound) { retrySearch() }
    }

    private func requestDeck() {
        if remoteURL != nil { openDeck() } else { wantsDeck = true }
    }

    func hideDeck() {
        showingDeck = false
        deckParked = true
        showingChat = false
    }

    func openChat() {
        guard chatOffered else { return }
        connectingMac = false
        showingChat = true
    }

    func openChatLink(_ url: URL) {
        if url.scheme == "mightymouse" {
            if url.host == "deck" { macTapped() }
            return
        }
        guard chatOffered, url.host == AppConfig.portalChatURL.host else { return }
        showingDeck = false
        connectingMac = false
        showingChat = true
        chatLink = url
    }

    private func openDeck() {
        wantsDeck = false
        connectingMac = false
        showingDeck = true
    }

    /// The app came back to the foreground, where the Local Network permission
    /// may have changed. iOS exposes no way to read the grant directly, so the
    /// only test is to sweep and see what answers.
    func handleForeground() {
        // Before the discovery guard, never after: a mounted deck (remoteURL
        // non-nil) is the NORMAL state when the Record control fires, so
        // parking this behind that guard makes the widget a no-op exactly when
        // it is meant to work.
        recording.handleForeground()
        handleArmedRecording()
        handleArmedAsk()
        handlePendingStop()
        handlePendingRelayOpen()
        drainQueuedRelayAnswers()
        // A mounted deck is a live WebSocket -- re-sweeping under it would set
        // remoteURL again and remount it, dropping the session the user is in.
        // `left` is the same hazard one hop later: the user backed out to the
        // lobby on purpose, so a sweep on the next foreground would drag them
        // onto the deck they just left. Only their "Look again" tap sweeps now.
        guard remoteURL == nil || (deckMountedUnproven && searchOutcome != nil), localNetworkAsked else { return }
        guard searchOutcome != DiscoveryOutcome.left else { return }
        // `init` suppresses the launch sweep on an override but this path is a
        // second entry: .active fires right after the seeded .onAppear, and
        // beginDiscovery's first line clears searchOutcome -- which silently
        // turned every `blocked`/`notFound` screenshot into `searching`.
        guard Self.uiStateOverride == nil else { return }
        MMLog.phase.log("foreground → rechecking network")
        beginDiscovery()
    }
}

struct ContentView: View {
    @StateObject private var model = AppModel()
    /// Here rather than in `MightyMouseApp`: this is where the model lives, and
    /// the recheck has to see the state the routing below is reading.
    @Environment(\.scenePhase) private var scenePhase

    #if DEBUG
    @State private var showDebug = false
    #endif

    var body: some View {
        routed
            .onOpenURL { model.openChatLink($0) }
            .onChange(of: scenePhase) { old, phase in
                // `.inactive` alone cannot mean "leaving": iOS also fires it for
                // Control Center, a notification banner, and as the middle step
                // of coming BACK (.background -> .inactive -> .active). Treating
                // every non-.active phase as leaving re-entered PiP during the
                // restore, which is what left the window stuck. The PREVIOUS
                // phase is what disambiguates, so both are read.
                //
                // Still `.inactive` and not `.background` on the way out: the
                // deck has to enter PiP while the window is still rendering.
                // By `.background` the pop-out never draws.
                if phase == .inactive, old == .active {
                    NativeIntentRouter.emit(["type": "appActive", "active": false])
                } else if phase == .active {
                    NativeIntentRouter.emit(["type": "appActive", "active": true])
                }
                guard phase == .active else { return }
                model.handleForeground()
            }
            #if DEBUG
            // Two openers on purpose: the simulator has no accelerometer and a
            // real shake can be eaten by whatever owns the responder chain, so
            // a gesture that cannot miss backs it up.
            .overlay(DebugGestureCatcher { showDebug = true })
            .onReceive(NotificationCenter.default.publisher(for: .mmDebugShake)) { _ in
                showDebug = true
            }
            .sheet(isPresented: $showDebug) {
                DebugView(model: model, onClose: { showDebug = false })
            }
            #endif
    }

    @ViewBuilder
    private var routed: some View {
        if let forced = AppModel.uiStateOverride {
            switch forced {
            case "launch": LaunchView(status: "Looking for MightyMouse on your network…")
            case "chat": ChatHome(model: model)
            case "chat-mac": LobbyView(model: model, onChat: model.chatOffered ? { model.openChat() } : nil)
            #if DEBUG
            default: LobbyView(model: model, onChat: model.chatOffered ? { model.openChat() } : nil).onAppear { model.forceLobbyState(forced) }
            #else
            default: LobbyView(model: model, onChat: model.chatOffered ? { model.openChat() } : nil)
            #endif
            }
            // Only the two states above exist. An unknown flag falling through
            // to the lobby is what let `blocked` and `pair` rot for weeks while
            // the sweep "passed" -- uiStateOverride is set by the #if ladder
            // above, so an unmatched -D simply leaves it nil and runs live.
        } else {
            live
        }
    }

    @ViewBuilder
    private var live: some View {
        ZStack {
            LobbyView(model: model, onChat: model.chatOffered ? { model.openChat() } : nil)
            if model.showingChat { ChatHome(model: model) }
            if model.showingDeck || model.deckParked, let remoteURL = model.remoteURL {
                RemoteDeck(
                    url: remoteURL,
                    credentials: model.credentials,
                    // Nils remoteURL, so the deck unmounts and a fresh sweep runs.
                    onExitToPairing: { model.exitToPairing(outcome: $0 ? DiscoveryOutcome.notFound : DiscoveryOutcome.left) },
                    onHideDeck: { model.hideDeck() },
                    onOriginDown: { model.originDown() },
                    recordingModel: model.recording,
                    onConnected: {
                        model.drainArmedAsk()
                        model.drainArmedRecording()
                        model.drainArmedDraw()
                        model.drainPendingRelayOpen()
                        // The one moment the Mac is PROVEN reachable, so a queued
                        // answer posts on the first try here where a foreground
                        // retry is still a guess.
                        model.drainQueuedRelayAnswers()
                        PushRegistration.requestOnFirstConnection()
                    },
                    isShowing: { [weak model] in model?.showingDeck ?? false }
                )
                .ignoresSafeArea()
                .opacity(model.showingDeck ? 1 : 0)
                .allowsHitTesting(model.showingDeck)
            }
        }
    }
}

/// The lobby: the only screen shown when there is no deck. Two offers, because
/// there are exactly two kinds of person who land here -- someone whose Mac app
/// exists and isn't answering, and someone who hasn't installed it yet.
///
/// It replaced a first-run `onboarding` screen and a `SearchDeadEndView` that
/// each answered half the problem; their copy survives as the headings below.
struct LobbyView: View {
    @ObservedObject var model: AppModel
    var onClose: (() -> Void)? = nil
    var onChat: (() -> Void)? = nil
    @FocusState private var emailFocused: Bool
    @State private var offeringDownload = false

    /// Written only on a real discovery hit, so it is a reliable "this phone has
    /// paired before" -- the difference between "install it" and "wake it up".
    private var hasConnectedBefore: Bool { Prefs.lastRemoteURL != nil }

    /// The one outcome a retry cannot fix: iOS has denied Local Network and only
    /// Settings can change that, so "Try again" would loop forever.
    private var blocked: Bool { model.searchOutcome == DiscoveryOutcome.blocked }

    /// A sweep is in flight. This used to be a whole separate screen, which hid
    /// the cards for its entire duration; it is a heading here instead.
    ///
    /// `hasConnectedBefore` is load-bearing since I1: pairing by scan now sets
    /// `localNetworkAsked` too, so without it a phone that has NEVER paired
    /// would greet its owner with "Looking for your Mac…" and no Mac to find.
    private var searching: Bool {
        hasConnectedBefore && model.localNetworkAsked && model.searchOutcome == nil
    }

    private var firstRun: Bool { !hasConnectedBefore && !blocked }

    private var ready: Bool { model.remoteURL != nil }

    private var heading: String {
        if ready { return "Your Mac is ready" }
        if searching { return "Looking for your Mac…" }
        if firstRun { return "Use your phone as your Mac's remote" }
        if blocked { return "Allow MightyMouse to find your Mac" }
        return hasConnectedBefore ? "Can't find your Mac" : "MightyMouse runs on your Mac"
    }

    /// I3: a retry, offered ONLY to someone with something to retry -- a phone
    /// that has paired before, or a sweep iOS actually denied. A first-time user
    /// gets the scan card and nothing else to weigh up.
    private var showRetry: Bool { blocked || (hasConnectedBefore && !searching) }

    private var subheading: String {
        if ready { return "Move the pointer, click and talk to your Mac from here." }
        if searching { return "Make sure MightyMouse is open on your Mac and you're on the same Wi-Fi." }
        if blocked {
            // The ONE place the words "Local Network" are allowed: a sweep has
            // actually been denied, so the term now names something the user
            // can see and change in Settings.
            return "Turn on Local Network for MightyMouse in Settings."
        }
        return hasConnectedBefore
            ? "Make sure MightyMouse is open on your Mac and you're on the same Wi-Fi."
            : "Set it up once. After that it connects on its own."
    }

    private var downloadForm: some View {
        VStack(alignment: .leading, spacing: MMSpace.three) {
            Text("We'll email you the link and the steps, so you can install it on your Mac.")
                .font(.system(size: MMFont.sm))
                .foregroundStyle(MMColor.textMutedDark)
                .fixedSize(horizontal: false, vertical: true)
            MMTextField(
                placeholder: "you@example.com",
                text: $model.downloadEmail,
                keyboard: .emailAddress,
                contentType: .emailAddress,
                submitLabel: .send,
                onSubmit: { Task { await model.emailDownloadLink() } }
            )
            .focused($emailFocused)
            MMButton(
                "Email me the download link",
                kind: .secondary,
                loading: model.emailingLink,
                systemImage: "envelope"
            ) {
                emailFocused = false
                Task { await model.emailDownloadLink() }
            }
        }
    }

    private var helpMenu: some View {
        Menu {
            Link(destination: URL(string: "https://getmightymouse.com/support.html#:~:text=The%20phone%20remote%20won't%20connect")!) {
                Label("Can't connect? Read the fixes", systemImage: "book")
            }
            Link(destination: URL(string: "mailto:hello@getmightymouse.com?subject=Help%20connecting%20my%20iPhone")!) {
                Label("Email us", systemImage: "envelope")
            }
        } label: {
            Image(systemName: "questionmark.circle")
                .font(.system(size: MMFont.xl * 1.3, weight: .regular))
                .foregroundStyle(MMColor.textMutedDark)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Help")
        .padding(.trailing, MMSpace.three)
    }

    private var firstRunSteps: some View {
        VStack(spacing: MMSpace.four) {
            MMCard {
                step(1, "Install the free MightyMouse app on your Mac") {
                    if offeringDownload {
                        downloadForm
                    } else {
                        MMButton("Email me the link", kind: .secondary, systemImage: "envelope") {
                            offeringDownload = true
                        }
                    }
                }
                step(2, "Open it. Your Mac shows a QR code.") { EmptyView() }
                step(3, "Scan it with this phone") { EmptyView() }
            }
            if let scanError = model.scanError {
                MMErrorNote(message: scanError)
            }
            MMButton("Scan the QR code", systemImage: "qrcode.viewfinder") {
                model.beginScan()
            }
        }
    }

    private func step<Extra: View>(
        _ number: Int, _ title: String, @ViewBuilder extra: () -> Extra
    ) -> some View {
        HStack(alignment: .top, spacing: MMSpace.three) {
            Text("\(number)")
                .font(.system(size: MMFont.md, weight: .bold, design: .rounded))
                .foregroundStyle(MMColor.accent)
                .frame(width: MMSpace.six, height: MMSpace.six)
                .background(Circle().fill(MMColor.accentWash))
            VStack(alignment: .leading, spacing: MMSpace.three) {
                Text(title)
                    .font(.system(size: MMFont.lg, weight: .semibold))
                    .foregroundStyle(MMColor.onSurface)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
                extra()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    var body: some View {
        MMScreen {
            VStack(spacing: MMSpace.six) {
                VStack(spacing: MMSpace.three) {
                    if searching {
                        MMRadarSweep(size: MMFont.display * 3.4, lineWidth: 4)
                    } else {
                        BrandGlyph(size: MMFont.display * 2)
                            .onTapGesture(count: 5) { model.unlockChat() }
                    }
                    Text(heading)
                        .font(.system(size: MMFont.display, weight: .bold, design: .rounded))
                        .foregroundStyle(MMColor.onSurface)
                        .multilineTextAlignment(.center)
                    Text(subheading)
                        .font(.system(size: MMFont.lg))
                        .foregroundStyle(MMColor.textMutedDark)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Above the cards, not after them: an error appended to the end
                // of a scroll this long renders below the fold, which is where
                // the "can't reach your Mac" note was landing -- clipped, unread.
                if let error = model.lobbyError {
                    MMErrorNote(message: error)
                }
                if showRetry {
                    MMButton(
                        blocked ? "Open Settings" : "Look again",
                        systemImage: blocked ? "gearshape" : "arrow.clockwise"
                    ) {
                        model.lobbyError = nil
                        if blocked {
                            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                            UIApplication.shared.open(url)
                        } else {
                            model.retrySearch()
                        }
                    }
                }
                if ready {
                    MMButton("Open the remote", systemImage: "cursorarrow.motionlines") {
                        model.macTapped()
                    }
                } else if firstRun {
                    firstRunSteps
                } else {
                    MMCard {
                        Text(searching ? "Taking a while?" : showRetry ? "Or connect with a QR code" : "Connect with a QR code")
                            .font(.system(size: MMFont.lg, weight: .semibold))
                            .foregroundStyle(MMColor.onSurface)
                        Text("On your Mac, open MightyMouse Settings, then Phone Remote. Scan the code it shows.")
                            .font(.system(size: MMFont.sm))
                            .foregroundStyle(MMColor.textMutedDark)
                            .fixedSize(horizontal: false, vertical: true)

                        if let scanError = model.scanError {
                            MMErrorNote(message: scanError)
                        }

                        // The QR carries the Mac's address, so scanning needs no Local Network permission.
                        MMButton(
                            "Scan the QR code",
                            kind: showRetry ? .secondary : .primary,
                            systemImage: "qrcode.viewfinder"
                        ) {
                            model.beginScan()
                        }
                    }

                    MMButton(
                        hasConnectedBefore ? "Set up another Mac" : "Don't have it yet?",
                        kind: .borderless
                    ) {
                        offeringDownload.toggle()
                    }

                    if offeringDownload { downloadForm }
                }

                if let onChat {
                    MMButton("No Mac? Chat with AI instead", kind: .borderless, systemImage: "bubble.left") {
                        onChat()
                    }
                }
            }
            .animation(.easeOut(duration: 0.2), value: offeringDownload)
            // The five lobby states swapped as hard text cuts. Both values are
            // needed: `searching` reads localNetworkAsked as well as the outcome.
            .animation(.easeOut(duration: 0.2), value: model.searchOutcome)
            .animation(.easeOut(duration: 0.2), value: model.localNetworkAsked)
            // §11 -- the send result and any error have to read as a change,
            // not a silent relayout.
            .animation(.easeOut(duration: 0.2), value: model.lobbyError)
        }
        .overlay(alignment: .topTrailing) { helpMenu }
        .overlay(alignment: .topLeading) {
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: MMFont.xlg, weight: .semibold))
                        .foregroundStyle(MMColor.onSurface)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Close")
                .padding(.leading, MMSpace.three)
            }
        }
        .background(
            QrScanSheet(presented: $model.scanning) { model.handleScan($0) }
        )
        .overlay(alignment: .bottom) {
            if let toast = model.linkSentToast {
                MMToast(message: toast)
                    .padding(.bottom, MMSpace.six)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        // Clears itself so a later send can toast again. A
                        // latched flag here would survive a relaunch and claim
                        // a link this launch never sent.
                        try? await Task.sleep(for: .seconds(3))
                        model.linkSentToast = nil
                    }
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.linkSentToast)
    }
}

/// Shown while Swift is still finding a host to point the webview at, and
/// reused by `RemoteDeck` as the cover over the blank first frame. Once a URL
/// loads, every further connect state (pairing, blocked, retry) is the page's
/// own job -- this view says nothing about why or what comes next.
struct LaunchView: View {
    let status: String

    var body: some View {
        // Deliberately NOT MMScreen: its ScrollView sizes to content, so the
        // centring Spacers below have nothing to push against and collapse.
        VStack(spacing: MMSpace.four) {
            // The mark IS the sweep -- one circle, not a static glyph with a
            // second animated one stacked under it.
            MMRadarSweep(size: MMFont.display * 1.6)
            Text(status)
                .font(.system(size: MMFont.lg))
                .foregroundStyle(MMColor.textMutedDark)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, MMSpace.five)
        // Centred on the SCREEN, not the safe area: the top inset (notch) is
        // ~25pt taller than the bottom one, so centring inside it sits the
        // glyph half that gap low on every device with a notch.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MMColor.bg)
        .ignoresSafeArea()
    }
}

/// The mouse mark, drawn from tokens. `computermouse.fill` at 56pt in system
/// `.orange` is what made this screen read as a stock demo -- an SF Symbol at the
/// wrong accent is the most recognisable "no design system" tell there is.
struct BrandGlyph: View {
    var size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(MMColor.accentWash)
                .overlay(Circle().strokeBorder(MMColor.accentBorderSubtle, lineWidth: 1))
            Image(systemName: "computermouse.fill")
                .font(.system(size: size * 0.44, weight: .medium))
                .foregroundStyle(MMColor.accent)
        }
        .frame(width: size, height: size)
        .modifier(MMCardElevation())
    }
}
