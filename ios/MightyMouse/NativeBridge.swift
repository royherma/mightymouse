import Foundation
import UIKit
import UserNotifications
import WebKit

#if !MM_GLASSES
/// Release builds ship without the Meta Wearables Toolkit, so every glasses
/// intent answers with a STATED reason rather than silence -- the picker infers
/// a cause from a timeout otherwise, which is how you ship a wrong message.
private let glassesAbsentPayload: [String: Any] = [
    "type": "glassesAvailability",
    "available": false,
    "reason": "sdk-unsupported",
    "message": "Glasses aren't available in this version."
]
#endif

final class NativeBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    weak var webView: WKWebView?
    let credentials: Credentials

    /// Values injected on top of the Keychain sweep, keyed WITHOUT the `web.`
    /// prefix. Seeded by the Swift onboarding pair and then kept current by
    /// `storeCredential`, so the Keychain is never the read-back channel for a
    /// write we just made.
    var seedCredentials: [String: String] = [:]

    /// The content controller holding our bootstrap script, so a refresh can
    /// replace it. Strong: the webview owns the bridge via its configuration,
    /// never the reverse, so this closes no retain cycle.
    private var controller: WKUserContentController?

    /// The web deck's back arrow. Unmounts the webview and returns to
    /// onboarding -- the native shell owns discovery and the pair sheet, and
    /// neither is reachable while `remoteURL` is non-nil.
    var onExitToPairing: ((Bool) -> Void)?
    var onHideDeck: (() -> Void)?
    /// Separate from `onExitToPairing` only so the lobby can say which of the
    /// two happened -- see `AppModel.exitToPairing(outcome:)`.
    var onOriginDown: (() -> Void)?
    var onConnectionState: ((String, String?) -> Void)?
    var onClipDelivered: ((String) -> Void)?
    /// A native recording just landed in `RecordingQueue`. Without this the clip
    /// would sit there until the next foreground or reconnect, which for a
    /// recording the user just finished on a live socket reads as a lost note.
    var onNativeClipReady: (() -> Void)?

    /// Fired once the remote page has actually painted (or failed to). A
    /// WKWebView is TRANSPARENT until its first frame commits, and only the
    /// native side can cover that — the web splash isn't fetched yet.
    var onLoadStateChange: ((Bool) -> Void)?

    /// Long enough that a slow-but-working connect is never interrupted --
    /// this only fires when the page painted and then said nothing at all.
    static let coverGraceSeconds: Double = 8

    /// Lifts the cover if `didFinish` is never followed by a `connState`.
    /// Cancelled by the first one that arrives. See `didFinish`.
    private var coverDeadline: DispatchWorkItem?

    private var deckURL: URL?
    private var committed = false
    private var servedFromCache = false

    init(credentials: Credentials) {
        self.credentials = credentials
    }

    deinit {
        coverDeadline?.cancel()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["t"] as? String else { return }
        switch type {
        case "haptic": Haptics.play(body["style"] as? String ?? "light")
        // Fired on drag engage so the Taptic Engine is already spun up by the
        // first detent -- see Haptics.warm.
        case "hapticWarm": Haptics.warm(body["style"] as? String ?? "light")
        // Namespaced so bootstrap can enumerate web-owned keys without a
        // hardcoded list, and so JS can never read or clobber a native secret.
        case "storeCredential":
            if let key = body["key"] as? String, let value = body["value"] as? String {
                credentials.set(value, for: Credentials.webKeyPrefix + key)
                // Held by value too — a Keychain read racing its own write.
                seedCredentials[key] = value
                // NOW, not at the next navigation callback: the page reloads
                // moments from here, and by then it is too late to change what
                // gets injected at document start.
                reinjectBootstrap()
            }
        case "scanQr": presentQrScanner()
        // The pairing chain past `qr decoded` is entirely web-side, and nothing
        // web-side reaches the device log -- which is exactly where every
        // "scanned, nothing happened" report went dark.
        case "log":
            let text = body["text"] as? String ?? ""
            if body["level"] as? String == "error" {
                MMLog.pairing.error("web \(text, privacy: .public)")
            } else {
                MMLog.pairing.log("web \(text, privacy: .public)")
            }
        case "exitToPairing":
            let notFound = body["outcome"] as? String == "notFound"
            DispatchQueue.main.async { [weak self] in self?.onExitToPairing?(notFound) }
        case "hideDeck":
            DispatchQueue.main.async { [weak self] in self?.onHideDeck?() }
        case "advancedMode":
            let on = body["on"] as? Bool ?? false
            guard on != Prefs.advancedMode else { return }
            Prefs.advancedMode = on
            NotificationCenter.default.post(name: .mmAdvancedChanged, object: nil)
        case "pushStatusQuery":
            Task { [weak self] in await self?.emitPushStatus() }
        case "pushSettingsOpen":
            // Branches on the LIVE status, not on what the chip believed: only
            // `denied` is unfixable in-app, and sending a never-asked user to
            // Settings makes a one-tap grant look like a chore.
            Task { [weak self] in
                if await PushRegistration.authorizationStatus() == .notDetermined {
                    PushRegistration.requestAndRegister()
                    // The prompt is answered off this call, so re-read once the
                    // user is back rather than reporting the pre-prompt status.
                    await self?.emitPushStatusWhenSettled()
                    return
                }
                await MainActor.run {
                    guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
            }
        case "connState":
            let state = body["state"] as? String ?? "disconnected"
            let reason = body["reason"] as? String
            // The page is talking, so the cover's deadline is moot -- from here
            // the state machine decides when it lifts. See `didFinish`.
            coverDeadline?.cancel()
            DispatchQueue.main.async { [weak self] in self?.onConnectionState?(state, reason) }
        case "removeCredential":
            if let key = body["key"] as? String {
                credentials.remove(Credentials.webKeyPrefix + key)
                // Or the seed would resurrect a credential the page just
                // dropped, and a revoked device would retry it forever.
                seedCredentials.removeValue(forKey: key)
                reinjectBootstrap()
            }
        case "clipDelivered":
            if let clipId = body["clipId"] as? String {
                DispatchQueue.main.async { [weak self] in self?.onClipDelivered?(clipId) }
            }
        // Which relay card is open full-screen, so a push about THAT card does
        // not banner over itself while the user is answering it. `nil` clears.
        // Derived by the page, never natively: the deck's detail view is web,
        // and a native guess would suppress the wrong notification.
        case "visibleRelayRequest":
            let requestId = body["requestId"] as? String
            Task { @MainActor in PushRegistration.visibleRelayRequestId = requestId }
        // The only place the stashed id is cleared -- clearing at emit time lost
        // cold-launch taps. Guarded on a match so a late ack for a superseded
        // request cannot clear the newer one the user is waiting on.
        case "relayIntentHandled":
            guard let requestId = body["requestId"] as? String,
                  SharedAppGroup.defaults.string(forKey: SharedAppGroup.pendingRelayRequestIdKey) == requestId
            else { return }
            SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingRelayRequestIdKey)
            SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingRelayAnswerFailureKey)
            SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingRelayRequestAtKey)
        // The deck telling us the mirror is making noise, so the app may stay
        // alive with the screen off. Deliberately NOT derived natively: only the
        // page knows whether a track is actually flowing, and a native guess
        // would hold the phone awake over a mirror that ended (ios/CLAUDE.md:
        // Swift owns no connection state).
        case "audioActivity":
            let active = body["active"] as? Bool ?? false
            Task { @MainActor in
                if active { AudioCapture.shared.hold(.mirrorAudio) }
                else { AudioCapture.shared.release(.mirrorAudio) }
            }
        // The opposite direction: this phone's mic going TO the Mac. Same
        // "only the page knows" reasoning as above.
        case "phoneMicActivity":
            let active = body["active"] as? Bool ?? false
            Task { @MainActor in
                if active { AudioCapture.shared.hold(.phoneMic) }
                else { AudioCapture.shared.release(.phoneMic) }
            }
        // The mirror is floating in PiP. A SEPARATE hold from `audioActivity`
        // because it must survive the Mac's audio being off -- see the
        // `mirrorPip` case in AudioCapture.Reason for why a frozen window is
        // what happens without it.
        // Native PiP's H.264 pipe. The web view owns the socket (ios/CLAUDE.md:
        // Swift owns no connection state), so frames cross here as base64 --
        // WKScriptMessage cannot carry raw bytes.
        case "pipFrame":
            guard let encoded = body["b64"] as? String,
                  let data = Data(base64Encoded: encoded) else { return }
            Task { @MainActor in PipMirror.shared.handle(frame: data) }
        case "pipConfig":
            let width = body["width"] as? Int ?? 0
            let height = body["height"] as? Int ?? 0
            let fps = body["frameRate"] as? Int ?? 20
            guard width > 0, height > 0 else { return }
            Task { @MainActor in PipMirror.shared.configure(width: width, height: height, frameRate: fps) }
        case "pipAudio":
            guard let encoded = body["b64"] as? String,
                  let data = Data(base64Encoded: encoded) else { return }
            Task { @MainActor in PipMirror.shared.handle(audio: data) }
        case "pipAudioConfig":
            let rate = body["sampleRate"] as? Int ?? 0
            let channels = body["channels"] as? Int ?? 0
            guard rate > 0, channels > 0 else { return }
            Task { @MainActor in PipMirror.shared.configureAudio(sampleRate: rate, channels: channels) }
        case "pipEnded":
            let reason = body["reason"] as? String ?? "unknown"
            Task { @MainActor in PipMirror.shared.streamEnded(reason: reason) }
        case "pipStopWindow":
            Task { @MainActor in PipMirror.shared.stopWindow() }
        case "pipActivity":
            let active = body["active"] as? Bool ?? false
            Task { @MainActor in
                PipMirror.shared.setAutoStart(active)
                if active { AudioCapture.shared.hold(.mirrorPip) }
                else { AudioCapture.shared.release(.mirrorPip) }
            }
        // Native capture, because WebKit mutes a `getUserMedia` track when the
        // app backgrounds and no Info.plist key changes that. The DECK still
        // owns the button, the HUD and the Stop -- this is its microphone, not
        // a second recorder.
        case "nativeMicStart":
            // No `?? .paste` fallback: an unrecognised destination means the page
            // and this enum have drifted, and silently pasting a clip the user
            // dictated into chat is worse than not recording at all.
            guard let raw = body["to"] as? String,
                  let to = PhoneAudioDestination(rawValue: raw) else {
                MMLog.phase.error("nativeMicStart: unknown destination \(body["to"] as? String ?? "nil", privacy: .public)")
                NativeIntentRouter.emit(["type": "nativeMicFailed", "reason": "destination"])
                return
            }
            // Defaults to false: an older page that doesn't send the flag has a
            // live socket by definition, so the Mac is there to transcribe.
            let macAway = body["macAway"] as? Bool ?? false
            Task { @MainActor in AudioCapture.shared.start(to: to, macAway: macAway) }
        // The page confirming a Live Activity Stop actually took effect. Only
        // the page can end a WebRTC track, so this -- not the button press --
        // is when the mirror hold may be dropped.
        case "stopAcknowledged":
            Task { @MainActor in AudioCapture.shared.acknowledgeStop() }
        case "nativeMicStop":
            let discard = body["discard"] as? Bool ?? false
            Task { @MainActor [weak self] in
                if discard {
                    AudioCapture.shared.cancel()
                } else if AudioCapture.shared.stop() != nil {
                    self?.onNativeClipReady?()
                }
            }
        // Every photo case answers with the SAME `requestId` it was given.
        // The page has no other way to pair a reply with its call -- two
        // searches can be in flight, and a bare "here is a result" would let
        // the slower one overwrite the faster.
        case "photosSearch":
            let requestId = body["requestId"] as? String ?? ""
            let query = PhotoLibrary.Query(
                after: Self.date(body["after"]),
                before: Self.date(body["before"]),
                isScreenshot: body["isScreenshot"] as? Bool,
                // Capped as well as defaulted: an agent asking for 5,000 rows
                // would build a JSON blob far past what its own context holds.
                limit: min(body["limit"] as? Int ?? 20, 100)
            )
            Task { [weak self] in
                let result = PhotoLibrary.search(query)
                self?.emit([
                    "type": "photosSearchResult",
                    "requestId": requestId,
                    "scope": result.scope.rawValue,
                    "matched": result.matched,
                    "photos": result.photos
                ])
            }
        // Called only after a search has already failed for lack of access, so
        // the prompt arrives with a reason the user has just seen.
        case "photosRequestAccess":
            let requestId = body["requestId"] as? String ?? ""
            Task { [weak self] in
                let scope = await PhotoLibrary.requestAccess()
                self?.emit([
                    "type": "photosAccessResult",
                    "requestId": requestId,
                    "scope": scope.rawValue
                ])
            }
        case "photosGet":
            let requestId = body["requestId"] as? String ?? ""
            let id = body["id"] as? String ?? ""
            Task { [weak self] in
                switch await PhotoLibrary.jpeg(for: id) {
                case .success(let data):
                    self?.emit([
                        "type": "photosGetResult",
                        "requestId": requestId,
                        // Same base64 reason as pipFrame: WKScriptMessage and
                        // evaluateJavaScript both carry text only.
                        "b64": data.base64EncodedString()
                    ])
                case .failure(let error):
                    self?.emit([
                        "type": "photosGetResult",
                        "requestId": requestId,
                        "error": error.rawValue
                    ])
                }
            }
        // The Meta AI app's approval round trip. Separate from `glassesProbe`
        // because it leaves the app, so the picker only asks on a real tap.
        case "glassesRegister":
            #if MM_GLASSES
            Task { @MainActor in
                let blocked = await GlassesSession.shared.register()
                NativeIntentRouter.emit([
                    "type": "glassesAvailability",
                    "available": blocked == nil,
                    "reason": blocked?.rawValue ?? "",
                    "message": blocked?.message ?? ""
                ])
            }
            #else
            NativeIntentRouter.emit(glassesAbsentPayload)
            #endif
        case "glassesMicSource":
            guard let raw = body["source"] as? String,
                  let source = AudioCapture.MicSource(rawValue: raw) else { return }
            Task { @MainActor in AudioCapture.shared.micSource = source }
        case "glassesCameraStart":
            #if MM_GLASSES
            NativeIntentRouter.emit([
                "type": "nativeLog",
                "text": "glasses: bridge received glassesCameraStart"
            ])
            Task { @MainActor in
                await GlassesSession.shared.startCamera { encoded in
                    NativeIntentRouter.emit(["type": "glassesFrame", "b64": encoded])
                }
            }
            #else
            NativeIntentRouter.emit(glassesAbsentPayload)
            #endif
        case "glassesCameraStop":
            #if MM_GLASSES
            Task { @MainActor in GlassesSession.shared.stopCamera() }
            #endif
        // Answers "can the glasses be a source" with a STATED reason, so the
        // picker never infers one from a timeout.
        case "glassesProbe":
            #if MM_GLASSES
            Task { @MainActor in
                let blocked = await GlassesSession.shared.availability()
                NativeIntentRouter.emit([
                    "type": "glassesAvailability",
                    "available": blocked == nil,
                    "reason": blocked?.rawValue ?? "",
                    "message": blocked?.message ?? ""
                ])
            }
            #else
            NativeIntentRouter.emit(glassesAbsentPayload)
            #endif
        // Persist-only: the widget is a separate process and reads this back
        // from the App Group on its own timeline. No state derivation here --
        // "asleep"/"not connected" is computed from `at`'s age at RENDER time
        // (ios/CLAUDE.md: Swift owns no connection state).
        case "hostStatus":
            // JS sends `null` for a batteryless Mac; NSNumber's Int? bridge
            // fails that cast (rather than yielding 0), so this stays absent.
            if let percent = body["batteryPercent"] as? Int {
                SharedAppGroup.defaults.set(percent, forKey: SharedAppGroup.hostBatteryPercentKey)
            } else {
                SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.hostBatteryPercentKey)
            }
            SharedAppGroup.defaults.set(body["charging"] as? Bool ?? false, forKey: SharedAppGroup.hostChargingKey)
            SharedAppGroup.defaults.set(body["hostname"] as? String ?? "", forKey: SharedAppGroup.hostNameKey)
            SharedAppGroup.defaults.set(body["at"] as? Double ?? 0, forKey: SharedAppGroup.hostStatusAtKey)
        default: break
        }
    }

    /// Always emits `qrScanned` -- a cancel sends a null value rather than
    /// nothing, so the page can drop its waiting state instead of hanging.
    private func presentQrScanner() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let host = self.webView?.window?.rootViewController else { return }
            let scanner = QrScannerController { [weak self] value in
                self?.emit(["type": "qrScanned", "value": value ?? NSNull()])
            }
            scanner.modalPresentationStyle = .fullScreen
            host.present(scanner, animated: true)
        }
    }

    /// Collapses iOS's six-case status into the three the chip can render.
    /// Provisional and ephemeral count as on: a push does reach the phone.
    private func emitPushStatus() async {
        let name: String
        switch await PushRegistration.authorizationStatus() {
        case .authorized, .provisional, .ephemeral: name = "authorized"
        case .notDetermined: name = "notDetermined"
        default: name = "denied"
        }
        emit(["type": "pushStatus", "status": name])
    }

    /// The system prompt has no completion we can await here, so poll briefly:
    /// a status read taken immediately still returns `notDetermined` and would
    /// leave the chip saying "off" over a grant the user just gave.
    private func emitPushStatusWhenSettled() async {
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if await PushRegistration.authorizationStatus() != .notDetermined { break }
        }
        await emitPushStatus()
    }

    /// `YYYY-MM-DD` or a full ISO-8601 stamp, both of which an agent writes.
    /// A bare date means midnight LOCAL: the user who says "photos from
    /// yesterday" means their yesterday, not UTC's.
    private static func date(_ raw: Any?) -> Date? {
        guard let text = raw as? String, !text.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        if let parsed = iso.date(from: text) { return parsed }
        let plain = DateFormatter()
        plain.dateFormat = "yyyy-MM-dd"
        plain.timeZone = TimeZone.current
        return plain.date(from: text)
    }

    func emit(_ intent: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: intent),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__mmNative?.emit(\(json));")
        }
    }

    /// Rebuild the `atDocumentStart` bootstrap against the CURRENT credentials.
    /// MUST be called on every credential write: a `WKUserScript` is frozen at
    /// add time, and removing/re-adding is the only way to change one.
    func refreshBootstrap(on controller: WKUserContentController) {
        self.controller = controller
        let bootstrap = credentials.allBootstrapValues().merging(seedCredentials) { _, fresh in fresh }
        // Over the credentials channel, NOT as query params — `updateUIView`
        // compares the load URL against its prop to decide on a reload. Sent on
        // every connect so an already-paired phone backfills its model.
        let device: [String: String] = [
            "model": AppConfig.hardwareIdentifier,
            "osVersion": UIDevice.current.systemVersion,
            "appBuild": AppConfig.appBuild
        ]
        var payload: [String: Any] = ["credentials": bootstrap, "device": device, "features": Prefs.advancedMode ? ["hideDeck", "exitNotFound"] : ["hideDeck", "exitNotFound", "simple"]]
        if let accountId = Prefs.accountId { payload["accountId"] = accountId }
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        // Nothing else adds a user script, so clearing all of them is safe and
        // avoids tracking an identity WebKit does not expose.
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: "window.__MM_NATIVE_BOOTSTRAP__ = \(json);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    func loadDeck(_ url: URL) {
        deckURL = url
        committed = false
        servedFromCache = false
        webView?.load(URLRequest(url: url))
    }

    /// The Mac can't serve the deck, so a paired phone gets its last copy from WebKit's cache.
    func loadFromCache() {
        guard !committed, !servedFromCache, let url = deckURL, let webView else { return }
        MMLog.webview.log("Mac unreachable → deck from cache")
        servedFromCache = true
        webView.stopLoading()
        // A cache miss must fail fast, not after a dead LAN address's ~60s timeout.
        webView.load(URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 5))
    }

    private func pageUnavailable() {
        guard servedFromCache else { return loadFromCache() }
        coverDeadline?.cancel()
        onLoadStateChange?(false)
        DispatchQueue.main.async { [weak self] in self?.onOriginDown?() }
    }

    /// Re-run the rebuild against the controller we were seeded with.
    private func reinjectBootstrap() {
        guard let controller else { return }
        refreshBootstrap(on: controller)
    }

    /// Statuses the edge returns when the tunnel is up but the Mac behind it is
    /// not. Mirrors `ORIGIN_DOWN` in `workers/remote-error-page/src/index.js`,
    /// which turns each of these into a branded HTML page.
    private static let originDown: Set<Int> = [502, 503, 504, 521, 522, 523, 524, 530]

    /// Refuse to render a page that isn't the deck: the shell has no chrome, so
    /// an origin-down page replacing the app strands the user with no exit.
    /// Reads an HTTP status and nothing else -- not connection state
    /// (`ios/CLAUDE.md`), since a 530 has no deck to be authoritative about.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame,
              let http = navigationResponse.response as? HTTPURLResponse,
              Self.originDown.contains(http.statusCode) else {
            decisionHandler(.allow)
            return
        }
        MMLog.webview.error("origin down (\(http.statusCode, privacy: .public))")
        decisionHandler(.cancel)
        DispatchQueue.main.async { [weak self] in self?.pageUnavailable() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let taken = MainActor.assumeIsolated { OffSiteLinks.intercept(navigationAction, home: deckURL?.host) }
        decisionHandler(taken ? .cancel : .allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committed = true
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        MMLog.webview.log("load start → \(webView.url?.absoluteString ?? "nil", privacy: .public)")
        onLoadStateChange?(true)
    }

    /// The page has PAINTED, which is not the same as connected -- its own
    /// connect gate is what paints first. Lifting the cover here swapped one
    /// full-screen "Connecting to your Mac…" for a second, differently drawn
    /// one, mid-connect, which reads as the app jumping to another screen.
    ///
    /// So the cover now waits for `connState`, and this is only the deadline:
    /// every ConnState transition reaches Swift (`native-bridge.ts`), but a
    /// page that hangs before its first one would otherwise cover forever.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MMLog.webview.log("load FINISHED — remote deck is live")
        coverDeadline?.cancel()
        let deadline = DispatchWorkItem { [weak self] in
            MMLog.webview.error("no connState \(Self.coverGraceSeconds, privacy: .public)s after load — lifting cover")
            self?.onLoadStateChange?(false)
        }
        coverDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.coverGraceSeconds, execute: deadline)
    }

    /// Both failure paths lift the cover. A cover that outlives a failed load
    /// is a permanent spinner over an error the user can never see.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MMLog.webview.error("load FAILED: \(error.localizedDescription, privacy: .public)")
        coverDeadline?.cancel()
        onLoadStateChange?(false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MMLog.webview.error("provisional load FAILED: \(error.localizedDescription, privacy: .public)")
        let error = error as NSError
        let interrupted = error.code == NSURLErrorCancelled
            || (error.domain == "WebKitErrorDomain" && error.code == 102)
        // 102 is our own 5xx cancel, which already ran `pageUnavailable`.
        guard !interrupted else { return }
        coverDeadline?.cancel()
        onLoadStateChange?(false)
        pageUnavailable()
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let host = challenge.protectionSpace.host.lowercased()
        if LanSession.isPrivateHost(host), let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    /// REQUIRED: WKWebView denies getUserMedia outright with no UI delegate set.
    /// Matched against the loaded page, not a hardcoded domain — the tunnel
    /// suffix is server-side and can change without a release.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host.lowercased()
        let loaded = webView.url?.host?.lowercased()
        decisionHandler(host == loaded || LanSession.isPrivateHost(host) ? .grant : .deny)
    }

    /// Only a LAN host may present the Mac's self-signed certificate. An earlier
    /// version accepted any dotted quad, which would have trusted a bad cert from
    /// a public IP; discovery only ever yields RFC1918 addresses, so narrow to those.
}
