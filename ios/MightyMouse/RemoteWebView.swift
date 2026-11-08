import AuthenticationServices
import SafariServices
import SwiftUI
import WebKit

extension WKWebView {
    /// The portal's viewport tag allows zoom for Safari users; the app must not.
    static let noZoomViewport = WKUserScript(
        source: "document.querySelector('meta[name=viewport]')?.setAttribute('content','width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover')",
        injectionTime: .atDocumentEnd,
        forMainFrameOnly: true
    )

    func lockZoom() {
        scrollView.pinchGestureRecognizer?.isEnabled = false
        scrollView.bouncesZoom = false
    }
}

/// The web deck plus the native cover that hides its blank first frame.
///
/// Split from `RemoteWebView` so the loading state lives in SwiftUI, where it
/// can be animated.
struct RemoteDeck: View {
    let url: URL
    let credentials: Credentials
    var extraCredentials: [String: String] = [:]
    var onExitToPairing: ((Bool) -> Void)?
    var onHideDeck: (() -> Void)?
    /// The edge answered but the Mac behind it did not, so there is no deck to
    /// mount. Distinct from the back arrow: nobody chose to leave.
    var onOriginDown: (() -> Void)?
    /// Nil-able so previews and any future caller without recording still
    /// compile -- a deck with nothing to flush is a valid deck.
    var recordingModel: RecordingModel?
    /// Fired on the `connected` edge, the first moment an intent emitted at
    /// launch can actually reach the page. See `AppModel.drainArmedAsk`.
    var onConnected: (() -> Void)?
    /// Read 2s after `connected`: a parked or backgrounded deck must not overwrite the launch picture.
    var isShowing: () -> Bool = { true }

    @State private var loading = true

    private static let snapshotURL = FileManager.default
        .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("last-deck.jpg")

    private var paired: Bool {
        credentials.value(for: Credentials.webKeyPrefix + AppConfig.deviceCredentialKey) != nil
    }

    private static let deckOnScreenProbe = """
        document.visibilityState === 'visible' && innerHeight > innerWidth &&
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) > 0
        """

    private static func saveDeckSnapshot(isShowing: @escaping () -> Bool) {
        // 2s -- the deck's own connect animations have to settle or the picture is mid-fade.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard UIApplication.shared.applicationState == .active, isShowing(),
                  let webView = NativeIntentRouter.bridge?.webView else { return }
            webView.evaluateJavaScript(deckOnScreenProbe) { onScreen, _ in
                guard (onScreen as? Bool) == true else {
                    MMLog.webview.log("deck snapshot skipped: page not laid out on screen")
                    return
                }
                webView.takeSnapshot(with: nil) { image, _ in
                    guard let data = image?.jpegData(compressionQuality: 0.85) else { return }
                    try? data.write(to: snapshotURL, options: .atomic)
                }
            }
        }
    }

    var body: some View {
        ZStack {
            RemoteWebView(
                url: url,
                credentials: credentials,
                extraCredentials: extraCredentials,
                onLoadingChange: { loading = $0 },
                onConnectionStateChange: { state, reason in
                    // `connecting` is the ONLY state this cover outranks -- it
                    // is the same wait the page's own connect gate draws, and
                    // showing both in sequence is the two-screens report. Every
                    // other state (blocked, disconnected, awaitingApproval) has
                    // a real web screen that must be uncovered immediately.
                    // A paired phone's page draws the deck itself while it reconnects (`boot-gate.ts` `returning`).
                    if state == "connected", paired, loading {
                        // 0.8s -- app icons and agent pills land after `connected`; lifting on the edge shows them popping in.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { loading = false }
                    } else if state != "connecting" {
                        loading = false
                    } else if paired {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { loading = false }
                    }
                    if state == "connected" {
                        Self.saveDeckSnapshot(isShowing: isShowing)
                        recordingModel?.flushQueue()
                        onConnected?()
                    }
                    Analytics.shared.trackConnection(state: state, reason: reason)
                },
                onClipDelivered: { recordingModel?.didDeliver(clipId: $0) },
                onNativeClipReady: { recordingModel?.flushQueue() },
                onExitToPairing: onExitToPairing,
                onHideDeck: onHideDeck,
                onOriginDown: onOriginDown
            )
            if loading {
                // Same furniture as LaunchView, so a cached-host launch reads as
                // one continuous screen.
                Group {
                    if paired, let last = UIImage(contentsOfFile: Self.snapshotURL.path) {
                        Image(uiImage: last).resizable().ignoresSafeArea().allowsHitTesting(false)
                    } else {
                        LaunchView(status: "Connecting to your Mac…")
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: loading)
    }
}

/// Home for a phone with no Mac. The page's only message is "open the Mac sheet"; Swift owns no connection state.
struct ChatHome: View {
    @ObservedObject var model: AppModel
    @State private var loaded = false

    var body: some View {
        ChatWebView(url: AppConfig.portalChatURL, link: model.chatLink, onConnectMac: { model.macTapped() }, onOpenDraw: { model.drawTapped() }, onLoaded: { loaded = true })
            // Edge to edge so page scrims cover the status bar; the page pads its own top.
            .ignoresSafeArea()
            .overlay {
                if !loaded {
                    // Same picture as the iOS launch screen, so launch hands off to chat with no blank frame.
                    ZStack {
                        Color("LaunchBackground")
                        Image("LaunchLogo")
                    }
                    .ignoresSafeArea()
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.25), value: loaded)
            .background(MMRgb.bg.ignoresSafeArea())
            .onAppear { Analytics.shared.track(AnalyticsEvent.chatOpened) }
    }
}

private struct ChatWebView: UIViewRepresentable {
    let url: URL
    let link: URL?
    let onConnectMac: () -> Void
    let onOpenDraw: () -> Void
    let onLoaded: () -> Void

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var loadedLink: URL?
        var onConnectMac: () -> Void
        var onOpenDraw: () -> Void
        var onLoaded: () -> Void
        init(onConnectMac: @escaping () -> Void, onOpenDraw: @escaping () -> Void, onLoaded: @escaping () -> Void) {
            self.onConnectMac = onConnectMac
            self.onOpenDraw = onOpenDraw
            self.onLoaded = onLoaded
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in self.onLoaded() }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // A script-driven leave is a sign-in (Connect GitHub); the server answers mightymouse://<portal path>, nil means cancelled.
            let scripted = navigationAction.navigationType == .other
            let taken = MainActor.assumeIsolated {
                OffSiteLinks.intercept(navigationAction, home: AppConfig.portalChatURL.host, onReturn: !scripted ? nil : { [weak webView] back in
                    guard let back, var page = URLComponents(url: AppConfig.portalChatURL, resolvingAgainstBaseURL: false) else {
                        webView?.reload()
                        return
                    }
                    page.path = "/\(back.host ?? "")\(back.path)"
                    page.query = back.query
                    if let url = page.url { webView?.load(URLRequest(url: url)) }
                })
            }
            decisionHandler(taken ? .cancel : .allow)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in self.onLoaded() }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in self.onLoaded() }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let body = message.body as? [String: Any]
            switch body?["type"] as? String {
            case "connectMac":
                let draw = body?["open"] as? String == "draw"
                Task { @MainActor in draw ? self.onOpenDraw() : self.onConnectMac() }
            case "haptic": Haptics.play(body?["style"] as? String ?? "light")
            case "account":
                Prefs.accountId = body?["userId"] as? String
            case "offlineNote":
                guard let id = body?["id"] as? String, let webView = message.webView else { return }
                let audio = (body?["audioBase64"] as? String).flatMap { Data(base64Encoded: $0) }
                let ext = body?["ext"] as? String ?? ""
                let durationMs = (body?["durationMs"] as? NSNumber)?.intValue ?? 0
                let keep = body?["keep"] as? Bool ?? true
                Task { @MainActor in
                    guard let audio, let clip = RecordingQueue.keepNote(audio: audio, ext: ext, durationMs: durationMs, queued: keep) else {
                        return Self.answerNote(webView, ["id": id, "stage": "failed"])
                    }
                    Self.answerNote(webView, ["id": id, "stage": "saved"])
                    if keep { NativeIntentRouter.bridge?.onNativeClipReady?() }
                    let outcome = await ClipTranscriber.transcribe(fileURL: RecordingQueue.fileURL(for: clip))
                    if !keep { try? FileManager.default.removeItem(at: RecordingQueue.fileURL(for: clip)) }
                    guard case let .text(text) = outcome else {
                        return Self.answerNote(webView, ["id": id, "stage": "noText"])
                    }
                    RecordingQueue.setPhoneText(text, for: clip.id)
                    Self.answerNote(webView, ["id": id, "stage": "text", "text": text])
                }
            default: break
            }
        }

        // Event name mirrors `PHONE_NOTE_EVENT` in portal/src/lib/platform.ts.
        @MainActor
        private static func answerNote(_ webView: WKWebView, _ detail: [String: String]) {
            guard let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mightymouse-note', { detail: \(json) }))")
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onConnectMac: onConnectMac, onOpenDraw: onOpenDraw, onLoaded: onLoaded) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The portal hides every purchase when it sees this tag (App Store 3.1.1).
        configuration.applicationNameForUserAgent = "Mobile/15E148 \(AppConfig.inAppUserAgentTag)"
        // Name mirrors `macPairingHandler` in portal/src/web-chat-extras.tsx.
        configuration.userContentController.add(context.coordinator, name: "mightymouseChat")
        configuration.userContentController.addUserScript(WKWebView.noZoomViewport)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.lockZoom()
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        context.coordinator.loadedLink = link
        webView.load(URLRequest(url: link ?? url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onConnectMac = onConnectMac
        context.coordinator.onOpenDraw = onOpenDraw
        context.coordinator.onLoaded = onLoaded
        if let link, link != context.coordinator.loadedLink {
            context.coordinator.loadedLink = link
            webView.load(URLRequest(url: link))
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "mightymouseChat")
    }
}

struct RemoteWebView: UIViewRepresentable {
    let url: URL
    let credentials: Credentials
    /// Injected on top of the Keychain's own values, keyed WITHOUT the `web.`
    /// prefix. The Keychain is not readable within the SwiftUI pass that wrote
    /// it — `make why Q="keychain write not readable same pass"`.
    var extraCredentials: [String: String] = [:]
    /// Raised while the page is loading, so the caller can cover the blank
    /// first frame. See `NativeBridge.onLoadStateChange`.
    var onLoadingChange: ((Bool) -> Void)?
    var onConnectionStateChange: ((String, String?) -> Void)?
    var onClipDelivered: ((String) -> Void)?
    var onNativeClipReady: (() -> Void)?
    /// The deck's back arrow, which only the native shell can honour.
    var onExitToPairing: ((Bool) -> Void)?
    var onHideDeck: (() -> Void)?
    var onOriginDown: (() -> Void)?

    /// Owns the bridge. `navigationDelegate` and `NativeIntentRouter.bridge`
    /// are both WEAK, so a bridge held only by `makeUIView`'s scope deallocates
    /// the moment that function returns.
    final class Coordinator {
        var bridge: NativeBridge?
        /// The last URL handed to `load`. See `updateUIView`.
        var requestedURL: URL?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Defaults to false in a WKWebView and OVERRIDES each <video>'s own
        // `playsInline`, so without it the screen mirror plays fullscreen.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Already the default, set anyway: PiP is what keeps the mirror visible
        // after an app switch, and a silent default flip would look like the
        // page's `webkitSetPresentationMode` call failing.
        configuration.allowsPictureInPictureMediaPlayback = true
        let bridge = NativeBridge(credentials: credentials)
        context.coordinator.bridge = bridge
        NativeIntentRouter.bridge = bridge
        bridge.onLoadStateChange = { loading in
            Task { @MainActor in onLoadingChange?(loading) }
        }
        bridge.onConnectionState = { state, reason in
            Task { @MainActor in onConnectionStateChange?(state, reason) }
        }
        bridge.onClipDelivered = { clipId in
            Task { @MainActor in onClipDelivered?(clipId) }
        }
        bridge.onNativeClipReady = {
            Task { @MainActor in onNativeClipReady?() }
        }
        bridge.onExitToPairing = { notFound in Task { @MainActor in onExitToPairing?(notFound) } }
        bridge.onHideDeck = { Task { @MainActor in onHideDeck?() } }
        bridge.onOriginDown = { Task { @MainActor in onOriginDown?() } }
        let controller = configuration.userContentController
        controller.add(bridge, name: "mightymouse")
        // Re-injected before every navigation too: a user script is frozen at
        // add time. See `NativeBridge.refreshBootstrap`.
        bridge.seedCredentials = extraCredentials
        bridge.refreshBootstrap(on: controller) 
        let webView = WKWebView(frame: .zero, configuration: configuration)
        bridge.webView = webView
        webView.navigationDelegate = bridge
        // Camera/mic capture is denied outright without a UI delegate.
        webView.uiDelegate = bridge
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.bounces = false
        webView.lockZoom()
        // `.automatic`l would ADD a UIKit inset on top of the page's own
        // `env(safe-area-inset-*)`, paying for the notch twice. `.never` leaves
        // `env()` as the single place the safe area is applied.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.requestedURL = url
        bridge.loadDeck(url)
        // Native PiP's source layer. Mounted once, here, because AVKit needs a
        // layer in a live hierarchy before PiP is startable -- attaching it when
        // the stream arrives is already too late.
        PipMirror.shared.attach(to: webView)
        return webView
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        // The page's JS cleanups die with the webview, so the holds it emitted
        // are released here -- a dead deck must not keep the Live Activity, the
        // audio session, or the PiP layer alive. Detaching also frees
        // `attach(to:)`'s once-only guard for the next deck mount.
        PipMirror.shared.detach()
        // NOT `release()`: that deactivates the shared AVAudioSession, which
        // WebKit is holding for the mirror's <video>, and blanks the picture
        // while audio keeps playing. SwiftUI dismantles this view on its own
        // schedule, so it can fire on a LIVE mirror.
        AudioCapture.shared.releaseHoldsForTeardown()
        // AFTER the mirror holds are gone, so `release(.micCapture)` inside
        // `finish()` resolves to no role and hands the session back. With the
        // page dead nothing else can stop the recorder until the 300s cap --
        // this stops it now and queues the clip for the next connect.
        AudioCapture.shared.stop()
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Compared against the URL we ASKED for, not `webView.url` (the page
        // rewrites its own address), and on the FULL url, not `host` — re-pairing
        // to the same Mac keeps the host identical.
        guard context.coordinator.requestedURL != url else { return }
        context.coordinator.requestedURL = url
        context.coordinator.bridge?.loadDeck(url)
    }
}

/// These web views have no browser chrome, so any page that leaves our own host opens in a Safari sheet with a Done button.
@MainActor
enum OffSiteLinks {
    private static let relay = DoneRelay()
    private static var signIn: ASWebAuthenticationSession?

    static func intercept(_ action: WKNavigationAction, home: String?, onReturn: ((URL?) -> Void)? = nil) -> Bool {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return false }
        if ["mailto", "tel", "sms"].contains(scheme) {
            UIApplication.shared.open(url)
            return true
        }
        guard scheme == "http" || scheme == "https" else { return false }
        guard let frame = action.targetFrame else {
            present(url, onDone: nil)
            return true
        }
        guard frame.isMainFrame, let home, url.host?.lowercased() != home.lowercased() else { return false }
        if let onReturn { authorize(url, onReturn: onReturn) } else { present(url, onDone: nil) }
        return true
    }

    fileprivate static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow)
    }

    // The Safari sheet cannot close itself; this one does when the page redirects to our URL scheme.
    private static func authorize(_ url: URL, onReturn: @escaping (URL?) -> Void) {
        let session = ASWebAuthenticationSession(url: url, callback: .customScheme("mightymouse")) { back, _ in
            Task { @MainActor in
                signIn = nil
                onReturn(back)
            }
        }
        session.presentationContextProvider = relay
        signIn = session
        if !session.start() {
            signIn = nil
            present(url) { onReturn(nil) }
        }
    }

    private static func present(_ url: URL, onDone: (() -> Void)?) {
        guard var top = keyWindow?.rootViewController else {
            UIApplication.shared.open(url)
            return
        }
        while let next = top.presentedViewController { top = next }
        let safari = SFSafariViewController(url: url)
        relay.onDone = onDone
        safari.delegate = relay
        top.present(safari, animated: true)
    }
}

@MainActor
private final class DoneRelay: NSObject, SFSafariViewControllerDelegate, ASWebAuthenticationPresentationContextProviding {
    var onDone: (() -> Void)?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        OffSiteLinks.keyWindow ?? ASPresentationAnchor()
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        onDone?()
        onDone = nil
    }
}
