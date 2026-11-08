#if DEBUG
import OSLog
import SwiftUI
import UIKit

/// Shake-to-open admin panel: every native screen on one map, plus a copyable
/// state + log dump. DEBUG-only by file — the whole thing compiles out of a
/// Release archive, so nothing here can reach the App Store.
///
/// Native screens ONLY. The deck's screens live in the web bundle and are the
/// page's business; a native jump-list into them would be the second state
/// machine `ios/CLAUDE.md` bans.
struct DebugView: View {
    @ObservedObject var model: AppModel
    let onClose: () -> Void

    @State private var preview: DebugScreen?
    @State private var showGallery = false
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                Section("Screens") {
                    ForEach(DebugScreen.allCases) { screen in
                        Button { preview = screen } label: {
                            HStack {
                                Image(systemName: screen.icon)
                                    .foregroundStyle(MMColor.accent)
                                    .frame(width: MMSpace.six)
                                VStack(alignment: .leading, spacing: MMSpace.one / 2) {
                                    Text(screen.title).foregroundStyle(MMColor.onSurface)
                                    Text(screen.subtitle)
                                        .font(.system(size: MMFont.sm))
                                        .foregroundStyle(MMColor.textMutedMedium)
                                }
                                Spacer()
                                if screen.isLive(model) {
                                    Text("LIVE")
                                        .font(.system(size: MMFont.micro, weight: .bold))
                                        .foregroundStyle(MMColor.green)
                                }
                                Image(systemName: "chevron.right")
                                    .font(.system(size: MMFont.sm))
                                    .foregroundStyle(MMColor.textMutedLight)
                            }
                        }
                    }
                }

                Section("Components") {
                    Button { showGallery = true } label: {
                        HStack {
                            Image(systemName: "square.grid.2x2")
                                .foregroundStyle(MMColor.accent)
                                .frame(width: MMSpace.six)
                            VStack(alignment: .leading, spacing: MMSpace.one / 2) {
                                Text("UI gallery").foregroundStyle(MMColor.onSurface)
                                Text("Every primitive and token, live")
                                    .font(.system(size: MMFont.sm))
                                    .foregroundStyle(MMColor.textMutedMedium)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: MMFont.sm))
                                .foregroundStyle(MMColor.textMutedLight)
                        }
                    }
                }

                Section("Debug log") {
                    Button {
                        UIPasteboard.general.string = DebugReport.build(model)
                        copied = true
                        Haptics.play("medium")
                    } label: {
                        Label(
                            copied ? "Copied — paste it to Claude" : "Copy debug log",
                            systemImage: copied ? "checkmark.circle.fill" : "doc.on.doc"
                        )
                        .foregroundStyle(copied ? MMColor.green : MMColor.accent)
                    }
                    ShareLink(item: DebugReport.build(model)) {
                        Label("Share debug log", systemImage: "square.and.arrow.up")
                            .foregroundStyle(MMColor.accent)
                    }
                    // Rendered inline so a glance answers "did anything log at
                    // all" before the paste lands somewhere else.
                    Text(DebugReport.build(model))
                        .font(.system(size: MMFont.micro, design: .monospaced))
                        .foregroundStyle(MMColor.textMutedDark)
                        .textSelection(.enabled)
                }
            }
            .navigationTitle("Debug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        .fullScreenCover(isPresented: $showGallery) {
            DebugGalleryView(onClose: { showGallery = false })
        }
        .fullScreenCover(item: $preview) { screen in
            ZStack(alignment: .topTrailing) {
                screen.view(model)
                Button {
                    preview = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: MMFont.display))
                        .foregroundStyle(MMColor.onSurface, MMColor.surface1)
                }
                .padding(MMSpace.five)
            }
        }
    }
}

/// One case per native screen the app can put on the glass. `DeckLive` is the
/// exception that renders nothing: the deck needs a real host, so previewing it
/// without one would show a webview pointed at nowhere.
enum DebugScreen: String, CaseIterable, Identifiable {
    case lobby
    case launch
    case lobbyBlocked
    case deck

    var id: String { rawValue }

    var title: String {
        switch self {
        // The three dead-end cases collapsed into the lobby: `notFound` and
        // `unresolved` render identically, and `blocked` only swaps the copy.
        case .lobby: return "Lobby"
        case .launch: return "Launch / searching"
        case .lobbyBlocked: return "Lobby — network blocked"
        case .deck: return "Remote deck"
        }
    }

    var subtitle: String {
        switch self {
        case .lobby: return "No deck — connect, or get the download link"
        case .launch: return "Sweeping for a Mac"
        case .lobbyBlocked: return "iOS denied Local Network"
        case .deck: return "The web bundle — needs a live host"
        }
    }

    var icon: String {
        switch self {
        case .lobby: return "hand.wave"
        case .launch: return "antenna.radiowaves.left.and.right"
        case .lobbyBlocked: return "lock.shield"
        case .deck: return "rectangle.on.rectangle"
        }
    }

    /// Whether this is the screen the app is showing right now, so the map
    /// doubles as "where am I".
    @MainActor
    func isLive(_ model: AppModel) -> Bool {
        switch self {
        case .lobby:
            return model.remoteURL == nil
                && model.searchOutcome != DiscoveryOutcome.blocked
                && (model.searchOutcome != nil || !model.localNetworkAsked)
        case .launch: return model.remoteURL == nil && model.searchOutcome == nil && model.localNetworkAsked
        case .lobbyBlocked: return model.searchOutcome == DiscoveryOutcome.blocked
        case .deck: return model.remoteURL != nil
        }
    }

    /// Renders the REAL screen against a throwaway model rather than a copy of
    /// it. The previous hand-built preview drifted from the screen it claimed to
    /// show, and a debug panel that lies is worse than no panel.
    @MainActor
    @ViewBuilder
    func view(_ model: AppModel) -> some View {
        switch self {
        case .lobby:
            LobbyView(model: model)
        case .launch:
            LaunchView(status: "Looking for MightyMouse on your network…")
        case .lobbyBlocked:
            LobbyView(model: DebugScreen.blockedPreviewModel())
        case .deck:
            LaunchView(status: "The deck is the web bundle — connect a Mac to see it.")
        }
    }

    /// A detached model parked in the blocked state, so the panel can show that
    /// copy without denying Local Network on the real one.
    @MainActor
    private static func blockedPreviewModel() -> AppModel {
        let preview = AppModel()
        preview.forceSearchOutcome(DiscoveryOutcome.blocked)
        return preview
    }
}

/// Every primitive in `Primitives.swift`, rendered live in each state it ships
/// in, over the real `MMColor.bg`.
///
/// Renders the ACTUAL primitives rather than copies, so a token change shows up
/// here the moment it lands -- a gallery of look-alikes would drift from the
/// components it claims to document and quietly become a lie.
struct DebugGalleryView: View {
    let onClose: () -> Void

    @State private var text = ""
    @State private var filled = "roy@example.com"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: MMSpace.six) {
                    group("MMButton") {
                        MMButton("Primary", systemImage: "qrcode.viewfinder") {}
                        MMButton("Secondary", kind: .secondary, systemImage: "arrow.clockwise") {}
                        MMButton("Borderless", kind: .borderless) {}
                        MMButton("Loading", loading: true) {}
                    }

                    group("MMTextField") {
                        MMTextField(placeholder: "Empty — placeholder", text: $text)
                        MMTextField(placeholder: "Email", text: $filled, keyboard: .emailAddress)
                    }

                    group("MMCard") {
                        MMCard {
                            Text("Card title")
                                .font(.system(size: MMFont.xl, weight: .semibold))
                                .foregroundStyle(MMColor.onSurface)
                            Text("Body copy inside a card, wrapping across lines.")
                                .font(.system(size: MMFont.lg))
                                .foregroundStyle(MMColor.textMutedDark)
                            MMButton("Action") {}
                        }
                    }

                    group("MMErrorNote") {
                        MMErrorNote(message: "Something went wrong. This is the inline error.")
                    }

                    group("MMToast") {
                        MMToast(message: "Link sent")
                    }

                    group("MMGlowDot") {
                        HStack(spacing: MMSpace.five) {
                            labelled("pulsing") { MMGlowDot() }
                            labelled("static") { MMGlowDot(pulsing: false) }
                            labelled("green") { MMGlowDot(color: MMColor.green) }
                            labelled("large") { MMGlowDot(size: MMSpace.four) }
                        }
                    }

                    group("BrandGlyph") {
                        HStack(alignment: .bottom, spacing: MMSpace.five) {
                            BrandGlyph(size: MMFont.display)
                            BrandGlyph(size: MMFont.display * 1.6)
                            BrandGlyph(size: MMFont.display * 2)
                        }
                    }

                    group("MMCardElevation") {
                        RoundedRectangle(cornerRadius: MMRadius.lg, style: .continuous)
                            .fill(MMColor.surface1)
                            .frame(height: MMSpace.six * 2)
                            .modifier(MMCardElevation())
                    }

                    tokens
                }
                .padding(.horizontal, MMSpace.five)
                .padding(.vertical, MMSpace.six)
            }
            .background(MMColor.bg)
            .navigationTitle("UI gallery")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
    }

    /// Colors last: the swatches are reference, not components, and putting them
    /// first buries the things people actually came to look at.
    private var tokens: some View {
        VStack(alignment: .leading, spacing: MMSpace.four) {
            group("MMFont") {
                ForEach(Self.fonts, id: \.0) { name, size in
                    HStack(spacing: MMSpace.three) {
                        Text("\(name) \(Int(size))")
                            .font(.system(size: MMFont.micro, design: .monospaced))
                            .foregroundStyle(MMColor.textMutedLight)
                            .frame(width: MMSpace.six * 3, alignment: .leading)
                        Text("MightyMouse")
                            .font(.system(size: size))
                            .foregroundStyle(MMColor.onSurface)
                    }
                }
            }

            group("MMColor") {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: MMSpace.two), count: 4),
                    spacing: MMSpace.two
                ) {
                    ForEach(Self.colors, id: \.0) { name, color in
                        VStack(spacing: MMSpace.one) {
                            RoundedRectangle(cornerRadius: MMRadius.sm, style: .continuous)
                                .fill(color)
                                .frame(height: MMSpace.six * 1.5)
                                .overlay(
                                    RoundedRectangle(cornerRadius: MMRadius.sm, style: .continuous)
                                        .strokeBorder(MMColor.surfaceBorderAlt, lineWidth: 1)
                                )
                            Text(name)
                                .font(.system(size: MMFont.micro, design: .monospaced))
                                .foregroundStyle(MMColor.textMutedMedium)
                                .lineLimit(1)
                                .minimumScaleFactor(0.6)
                        }
                    }
                }
            }

            group("MMRadius / MMSpace") {
                HStack(alignment: .bottom, spacing: MMSpace.three) {
                    ForEach(Self.radii, id: \.0) { name, radius in
                        VStack(spacing: MMSpace.one) {
                            RoundedRectangle(cornerRadius: radius, style: .continuous)
                                .fill(MMColor.surface2)
                                .frame(width: MMSpace.six * 2, height: MMSpace.six * 2)
                                .overlay(
                                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                                        .strokeBorder(MMColor.surfaceBorderAlt, lineWidth: 1)
                                )
                            Text("\(name) \(Int(radius))")
                                .font(.system(size: MMFont.micro, design: .monospaced))
                                .foregroundStyle(MMColor.textMutedMedium)
                        }
                    }
                }
                HStack(alignment: .bottom, spacing: MMSpace.three) {
                    ForEach(Self.spaces, id: \.0) { name, space in
                        VStack(spacing: MMSpace.one) {
                            Rectangle()
                                .fill(MMColor.accent)
                                .frame(width: space, height: MMSpace.six)
                            Text("\(name)\n\(Int(space))")
                                .font(.system(size: MMFont.micro, design: .monospaced))
                                .foregroundStyle(MMColor.textMutedMedium)
                                .multilineTextAlignment(.center)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func group<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: MMSpace.three) {
            Text(title)
                .font(.system(size: MMFont.sm, weight: .bold, design: .monospaced))
                .foregroundStyle(MMColor.textMutedLight)
            content()
        }
    }

    @ViewBuilder
    private func labelled<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(spacing: MMSpace.two) {
            content()
            Text(title)
                .font(.system(size: MMFont.micro, design: .monospaced))
                .foregroundStyle(MMColor.textMutedMedium)
        }
    }

    // Hand-listed because Swift cannot enumerate an enum's static members. A
    // token added to Theme.swift will not appear here until it is added below.
    private static let fonts: [(String, CGFloat)] = [
        ("micro", MMFont.micro), ("xs", MMFont.xs), ("sm", MMFont.sm),
        ("md", MMFont.md), ("mlg", MMFont.mlg), ("lg", MMFont.lg),
        ("xlg", MMFont.xlg), ("xl", MMFont.xl), ("display", MMFont.display)
    ]

    private static let radii: [(String, CGFloat)] = [
        ("sm", MMRadius.sm), ("md", MMRadius.md), ("lg", MMRadius.lg)
    ]

    private static let spaces: [(String, CGFloat)] = [
        ("one", MMSpace.one), ("two", MMSpace.two), ("three", MMSpace.three),
        ("four", MMSpace.four), ("five", MMSpace.five), ("six", MMSpace.six)
    ]

    private static let colors: [(String, Color)] = [
        ("bg", MMColor.bg), ("surface1", MMColor.surface1),
        ("surface2", MMColor.surface2), ("surface3", MMColor.surface3),
        ("onSurface", MMColor.onSurface), ("muted", MMColor.muted),
        ("textMutedDark", MMColor.textMutedDark), ("textMutedMedium", MMColor.textMutedMedium),
        ("textMutedLight", MMColor.textMutedLight), ("accent", MMColor.accent),
        ("accentWash", MMColor.accentWash), ("accentBgSubtle", MMColor.accentBgSubtle),
        ("green", MMColor.green), ("red", MMColor.red), ("violet", MMColor.violet),
        ("cyan", MMColor.cyan), ("amber", MMColor.amber), ("blue", MMColor.blue),
        ("rose", MMColor.rose), ("yellow", MMColor.yellow), ("magenta", MMColor.magenta),
        ("orange", MMColor.orange), ("grayMuted", MMColor.grayMuted),
        ("bgDark", MMColor.bgDark), ("borderDark", MMColor.borderDark),
        ("surfaceBorderAlt", MMColor.surfaceBorderAlt)
    ]
}

/// The paste payload: state header + the session's own log lines.
@MainActor
enum DebugReport {
    /// Lines older than this are almost always the previous launch. Long enough
    /// to still hold a cold-launch sweep that has since gone quiet.
    private static let logWindow: TimeInterval = -600

    static func build(_ model: AppModel) -> String {
        ([header(model), "", "--- log ---"] + logLines()).joined(separator: "\n")
    }

    private static func header(_ model: AppModel) -> String {
        let device = UIDevice.current
        return [
            "MightyMouse iOS debug",
            "app: \(Bundle.main.bundleIdentifier ?? "?") \(version)",
            "device: \(device.model) iOS \(device.systemVersion)",
            "remoteURL: \(model.remoteURL?.absoluteString ?? "nil")",
            "searchOutcome: \(model.searchOutcome ?? "nil")",
            "localNetworkAsked: \(model.localNetworkAsked)",
            "cachedHost: \(Prefs.lastRemoteURL?.absoluteString ?? "nil")",
            // Presence only. A tunnel hostname is a routable address to Roy's
            // Mac, so the value never goes in a pasteable blob.
            "tunnelHost: \(hasTunnelHost(model) ? "set" : "nil")",
            "credentials: \(model.credentials.hasAnyStoredValue() ? "present" : "none")",
            "deviceCredential: \(deviceCredentialState(model))",
            "deckConnected: \(NativeIntentRouter.isConnected)"
        ].joined(separator: "\n")
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }

    /// Presence + OSStatus, never the value. "unreadable (-34018)" is a signing
    /// problem; "unreadable (-25300)" means pairing never wrote it -- the split
    /// that §13b of the agent-relay PRD burned a session distinguishing.
    private static func deviceCredentialState(_ model: AppModel) -> String {
        let key = Credentials.webKeyPrefix + AppConfig.deviceCredentialKey
        if model.credentials.value(for: key) != nil { return "readable" }
        return "unreadable (\(model.credentials.lastReadStatus))"
    }

    private static func hasTunnelHost(_ model: AppModel) -> Bool {
        let key = Credentials.webKeyPrefix + AppConfig.lastTunnelHostKey
        return model.credentials.value(for: key).map { !$0.isEmpty } ?? false
    }

    /// Read back from the unified log rather than tee'd at the MMLog call sites:
    /// a second in-memory sink would only hold what was logged after it was
    /// installed, and would miss the widget extension's lines entirely.
    private static func logLines() -> [String] {
        do {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
            let since = store.position(date: Date().addingTimeInterval(logWindow))
            let entries = try store.getEntries(
                at: since,
                matching: NSPredicate(format: "subsystem == %@", MMLog.subsystem)
            )
            let stamp = DateFormatter()
            stamp.dateFormat = "HH:mm:ss"
            return entries.compactMap { $0 as? OSLogEntryLog }
                .map { "\(stamp.string(from: $0.date)) [\($0.category)] \($0.composedMessage)" }
        } catch {
            return ["log read failed: \(error.localizedDescription)"]
        }
    }
}

/// Shake anywhere, including over the mounted deck. UIKit walks the responder
/// chain for motion events and SwiftUI exposes no hook, so the notification is
/// the only route that survives a full-screen WKWebView.
///
/// `canBecomeFirstResponder` + the `becomeFirstResponder()` on `didMoveToWindow`
/// are BOTH load-bearing: a UIWindow refuses first responder by default, so
/// without them the chain never reaches this override and the shake is silently
/// swallowed -- which is exactly how this shipped dead the first time.
extension UIWindow {
    open override var canBecomeFirstResponder: Bool { true }

    open override func didMoveToWindow() {
        super.didMoveToWindow()
        becomeFirstResponder()
    }

    // motionBegan, not motionEnded: a WKWebView in the chain can consume the
    // end event, and the begin edge fires the moment iOS classifies the shake.
    open override func motionBegan(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        super.motionBegan(motion, with: event)
        guard motion == .motionShake else { return }
        MMLog.phase.log("debug: shake → panel")
        NotificationCenter.default.post(name: .mmDebugShake, object: nil)
    }
}

extension Notification.Name {
    static let mmDebugShake = Notification.Name("mm.debug.shake")
}

/// Two-finger long-press (1s) anywhere, as the opener that cannot miss: the
/// simulator has no accelerometer, so shake is unavailable there entirely.
///
/// Two fingers rather than one so it can never fire from an ordinary press on
/// the trackpad, and the recognizer is attached to a passthrough overlay whose
/// `hitTest` returns nil -- the view is invisible to touch delivery, so the deck
/// underneath keeps every event it would otherwise have received.
struct DebugGestureCatcher: UIViewRepresentable {
    let onTrigger: () -> Void

    func makeUIView(context: Context) -> UIView {
        let view = PassthroughView()
        let press = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handle(_:))
        )
        press.numberOfTouchesRequired = 2
        press.minimumPressDuration = 1.0
        // Otherwise UIKit delays/cancels the touches the deck is mid-gesture on.
        press.cancelsTouchesInView = false
        press.delaysTouchesBegan = false
        press.delegate = context.coordinator
        // Attached to the WINDOW, not to `view`: a recognizer only sees touches
        // delivered to the view it is on, and this view is deliberately
        // invisible to hit-testing. The window sees every touch before
        // hit-testing runs, so this is the one attachment point that both fires
        // over the deck AND costs the deck nothing.
        DispatchQueue.main.async {
            (view.window ?? UIApplication.keyWindow)?.addGestureRecognizer(press)
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onTrigger = onTrigger
    }

    func makeCoordinator() -> Coordinator { Coordinator(onTrigger: onTrigger) }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onTrigger: () -> Void

        init(onTrigger: @escaping () -> Void) { self.onTrigger = onTrigger }

        @objc func handle(_ recognizer: UILongPressGestureRecognizer) {
            guard recognizer.state == .began else { return }
            MMLog.phase.log("debug: two-finger press → panel")
            Haptics.play("rigid")
            onTrigger()
        }

        // The WebView runs its own recognizers; without this ours never fires
        // while the deck is mounted.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }

    /// Invisible to hit-testing, so the overlay costs the app below nothing.
    /// It exists only to reach the window; the recognizer lives there.
    private final class PassthroughView: UIView {
        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
    }
}

extension UIApplication {
    /// The foreground window. `UIApplication.shared.keyWindow` is deprecated and
    /// nil under scenes, which is why this walks the connected scenes instead.
    static var keyWindow: UIWindow? {
        shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }?
            .windows.first { $0.isKeyWindow }
    }
}
#endif
