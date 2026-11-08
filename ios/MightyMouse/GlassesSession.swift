// Gated out of Release entirely (MM_GLASSES is set on Debug only). The Meta
// Wearables Toolkit is a third-party SDK that App Review asks for authorization
// documentation on, so the shipped binary must not link it at all -- hiding the
// UI is not enough when the framework is still inside the app.
#if MM_GLASSES
import AVFoundation
import Foundation
import MWDATCamera
import MWDATCore
import UIKit

#if targetEnvironment(simulator)
import MWDATMockDevice
#endif

// Meta Wearables Device Access Toolkit, wrapped
//
// DAT runs on THIS phone, not on the glasses: the SDK talks to the Meta AI app
// over Bluetooth and hands back the wearer's camera stream. The Mac and the
// phone-remote page never see the SDK -- frames leave here as base64 over the
// existing pipFrame path, exactly like PipMirror's feed.
//
// Owns no connection state (ios/CLAUDE.md). `Unavailable` is the whole reason
// vocabulary; nothing in this file infers a reason from timing.

/// Why the glasses can't be a source right now. Every value is something the
/// SDK or the audio route STATED -- a revoked phone taught us that inferring a
/// cause from timing is how you ship a wrong error message
/// (src/main/phone-remote/CLAUDE.md).
enum GlassesUnavailable: String {
    case sdkUnsupported = "sdk-unsupported"
    case metaAiNotInstalled = "meta-ai-not-installed"
    case notRegistered = "not-registered"
    case noDevice = "no-device"
    case permissionDenied = "permission-denied"
    case glassesFolded = "glasses-folded"
    case batteryOrThermal = "battery-or-thermal"
    case audioRouteNotHfp = "audio-route-not-hfp"
    case connectionError = "connection-error"
    case internalError = "internal-error"

    /// ELI5, benefits-not-features (docs/brand-voice.md). The page shows this
    /// verbatim -- it never builds its own sentence from the raw value.
    var message: String {
        switch self {
        case .sdkUnsupported: return "Your glasses need iOS 17.2 or newer."
        case .metaAiNotInstalled: return "Install the Meta AI app to use your glasses."
        case .notRegistered: return "Open the Meta AI app once to let MightyMouse use your glasses."
        case .noDevice: return "Put your glasses on and make sure they're connected."
        case .permissionDenied: return "Allow MightyMouse to use the glasses camera in the Meta AI app."
        case .glassesFolded: return "Unfold your glasses to start."
        case .batteryOrThermal: return "Your glasses are too low on battery or too warm."
        case .audioRouteNotHfp: return "Your glasses aren't the microphone yet. Try again in a moment."
        case .connectionError: return "Lost the link to your glasses."
        case .internalError: return "Your glasses couldn't start. Try again."
        }
    }
}

/// A DAT-reported condition alongside a live camera stream. Kept separate from
/// `GlassesUnavailable` because the page reacts differently: a stream that
/// stops needs the picker to fall back, a stream that never started does not.
enum GlassesState: String {
    case idle
    case starting
    case streaming
    case stopped
}

/// Resuming a continuation twice is a crash, and a link-state listener can fire
/// again while the first callback is still unwinding. Locked rather than
/// actor-isolated because the SDK calls its listeners from its own queue.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?

    init(_ continuation: CheckedContinuation<Bool, Never>) {
        self.continuation = continuation
    }

    func resume(_ value: Bool) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}

@MainActor
final class GlassesSession: NSObject {
    static let shared = GlassesSession()

    private var session: DeviceSession?
    private var camera: Camera?
    private var listeners: [any AnyListenerToken] = []
    private var configured = false

    private(set) var state: GlassesState = .idle
    private(set) var lastUnavailable: GlassesUnavailable?

    /// Frames go out through the SAME base64 path as the Mac's mirror feed
    /// (ios/CLAUDE.md: WKScriptMessage carries no binary). JPEG rather than
    /// H.264: DAT hands back decoded CMSampleBuffers, so re-encoding to H.264
    /// only to decode it again on the page would be a round trip for nothing.
    private var frameSink: ((String) -> Void)?

    /// 15fps at .low. The design's budget: a POV framing view, not a recording.
    private static let streamFrameRate: UInt = 15
    /// 3s: the SDK's handshake with the Meta AI app settles well inside this on a
    /// warm app, and the page's own start timeout is 12s -- so waiting longer
    /// here would just spend that budget without ever reporting a reason.
    private static let registrationSettleSeconds = 3.0
    /// 4s: waking glasses over Bluetooth is slower than the registration
    /// handshake, and this plus the settle above still fits the page's 12s.
    private static let activeDeviceSettleSeconds = 4.0
    /// nonisolated: the frame publisher's closure is Sendable, so a main-actor
    /// constant read there is an error under Swift 6.
    private nonisolated static let jpegQuality: CGFloat = 0.5

    private func trace(_ text: String) {
        MMLog.glasses.info("\(text, privacy: .public)")
        NativeIntentRouter.emit(["type": "nativeLog", "text": "glasses: \(text)"])
    }

    private var framesSeen = 0
    private var dropsSeen = 0

    /// Frames arrive at 15fps, so only the first is worth a line -- it is the
    /// one that proves the whole chain end to end.
    private func traceFirstFrame(bytes: Int) {
        framesSeen += 1
        if framesSeen == 1 { trace("FIRST FRAME \(bytes) bytes jpeg") }
    }

    private func traceFrameDrop(_ why: String) {
        dropsSeen += 1
        if dropsSeen == 1 || dropsSeen % 30 == 0 { trace("frame dropped (\(dropsSeen)): \(why)") }
    }

    private func report(_ reason: GlassesUnavailable) {
        lastUnavailable = reason
        state = .idle
        trace("unavailable: \(reason.rawValue)")
        NativeIntentRouter.emit([
            "type": "glassesUnavailable",
            "reason": reason.rawValue,
            "message": reason.message
        ])
    }

    private func setState(_ next: GlassesState) {
        state = next
        trace("state: \(next.rawValue)")
        NativeIntentRouter.emit(["type": "glassesState", "state": next.rawValue])
        emitStatus()
    }

    /// The debug HUD's glasses row. Every field is something the SDK STATED --
    /// there is deliberately no battery percentage, because DAT does not expose
    /// one: `DeviceState` carries `thermalLevel` and nothing else, and battery
    /// appears only as the terminal `.batteryCritical` error. Inventing a
    /// percentage from thermal, or leaving the field out so the HUD looks
    /// incomplete, are both worse than saying `crit` at the one moment DAT
    /// actually knows something about the battery.
    ///
    /// Pushed on every state change rather than polled: the wearer is reading
    /// this through the optics mid-run, and a poll would either lag the thing
    /// that just went wrong or spend Bluetooth on a value that rarely moves.
    func emitStatus() {
        let wearables = Wearables.shared
        let device = wearables.devices.compactMap { wearables.deviceForIdentifier($0) }
            .first { $0.linkState == .connected }
            ?? wearables.devices.compactMap { wearables.deviceForIdentifier($0) }.first
        NativeIntentRouter.emit([
            "type": "glassesStatus",
            "link": device.map { Self.linkName($0.linkState) } ?? "none",
            "name": device?.nameOrId() ?? "",
            "thermal": lastThermal,
            // Sticky for the session: `.batteryCritical` arrives once, as the
            // error that ends the stream, so a field cleared on the next state
            // change would blank the one reading that explains the ending.
            "batteryCritical": batteryCritical
        ])
    }

    private static func linkName(_ state: LinkState) -> String {
        switch state {
        case .connected: return "conn"
        case .connecting: return "conn.."
        case .disconnected: return "down"
        @unknown default: return "?"
        }
    }

    /// Last thermal level DAT reported, short enough to read at glasses
    /// resolution. `--` until something says otherwise: DAT publishes thermal
    /// only alongside a session, so "no reading yet" is the honest state for a
    /// HUD that mounts before the glasses do.
    private var lastThermal = "--"
    private var batteryCritical = false

    // MARK: - Registration

    /// Must run before any other SDK call. Idempotent, so the picker may ask
    /// freely; a second `Wearables.configure()` would throw.
    @discardableResult
    func configureIfNeeded() -> Bool {
        guard !configured else { return true }
        #if targetEnvironment(simulator)
        // The real SDK finds no Bluetooth transport on a simulator, so every
        // call fails with `noDevice` and the picker looks broken rather than
        // absent. The mock pairs a glasses model and plays the front camera.
        if !MockDeviceKit.shared.isEnabled {
            MockDeviceKit.shared.enable(config: MockDeviceKitConfig())
            _ = try? MockDeviceKit.shared.pairGlasses(model: .rayBanMeta)
        }
        #endif
        do {
            try Wearables.configure()
            configured = true
            return true
        } catch {
            report(.internalError)
            return false
        }
    }

    /// The Meta AI app's approval round trip. Returns the reason it could not
    /// happen rather than a bare false, so the page never guesses.
    func register() async -> GlassesUnavailable? {
        guard configureIfNeeded() else { return .internalError }
        let wearables = Wearables.shared
        if wearables.registrationState == .registered { return nil }
        if wearables.registrationState == .unavailable { return .metaAiNotInstalled }
        do {
            try await wearables.startRegistration()
            trace("register: returned, state=\(wearables.registrationState)")
            return wearables.registrationState == .registered ? nil : .notRegistered
        } catch {
            trace("register: threw \(error)")
            return error == .metaAINotInstalled ? .metaAiNotInstalled : .notRegistered
        }
    }

    /// Waits for any known device to report a live link. `linkState` reads
    /// `.disconnected` before the SDK has actually probed, so glasses that are
    /// on and worn look dead on a cold read -- the same late-value shape as
    /// registration and the device list.
    private func settleLinkState() async {
        let wearables = Wearables.shared
        let devices = wearables.devices.compactMap { wearables.deviceForIdentifier($0) }
        if devices.contains(where: { $0.linkState == .connected }) { return }
        trace("availability: no live link on read, waiting for one")

        var tokens: [any AnyListenerToken] = []
        var timeout: Task<Void, Never>?
        // ResumeOnce because every device plus the timeout share one
        // continuation, and resuming a continuation twice is a crash.
        let linked = await withCheckedContinuation { continuation in
            let box = ResumeOnce(continuation)
            for device in devices {
                tokens.append(device.addLinkStateListener { state in
                    if state == .connected { box.resume(true) }
                })
            }
            timeout = Task {
                try? await Task.sleep(for: .seconds(Self.activeDeviceSettleSeconds))
                box.resume(false)
            }
        }
        timeout?.cancel()
        for token in tokens { await token.cancel() }
        trace("availability: link settled connected=\(linked)")
    }

    /// Waits for the SDK to publish its device list. Observed empty-then-two on
    /// the same phone seconds apart, so a cold read reports `no-device` for
    /// glasses that are connected and fine.
    private func settleDevices() async {
        let wearables = Wearables.shared
        guard wearables.devices.isEmpty else { return }
        trace("availability: no devices on read, waiting for the SDK to publish")
        let found = await withTaskGroup(of: [DeviceIdentifier]?.self) { group in
            group.addTask {
                for await ids in wearables.devicesStream() where !ids.isEmpty { return ids }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(Self.activeDeviceSettleSeconds))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        trace("availability: devices settled to \(found?.count ?? 0)")
    }

    /// Waits for `AutoDeviceSelector` to name a device. Same late-value shape as
    /// `settleRegistrationState`, and raced against a timeout for the same
    /// reason: a selector that never resolves must not park the start forever.
    private func settleActiveDevice(_ selector: AutoDeviceSelector) async {
        guard selector.activeDevice == nil else { return }
        trace("startCamera: no active device yet, waiting for the selector")
        let picked = await withTaskGroup(of: DeviceIdentifier?.self) { group in
            group.addTask {
                for await id in selector.activeDeviceStream() where id != nil { return id }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(Self.activeDeviceSettleSeconds))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        trace("startCamera: selector settled to \(picked ?? "none")")
    }

    /// `start()` returns while the session is still `starting`, and a camera
    /// added in that window comes back nil. Raced against a timeout for the
    /// same reason as the other settles: a session that never reaches
    /// `started` must not park the start forever.
    private func settleSessionStarted(_ session: DeviceSession) async {
        guard session.state != .started else { return }
        trace("startCamera: session not started yet (state=\(session.state)), waiting")
        let reached = await withTaskGroup(of: DeviceSessionState?.self) { group in
            group.addTask {
                for await state in session.stateStream() where state == .started { return state }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(Self.activeDeviceSettleSeconds))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        trace("startCamera: session settled to \(reached.map(String.init(describing:)) ?? "timeout(\(session.state))")")
    }

    /// Runs the Meta AI app's camera grant. The user picks "Allow once" or
    /// "Allow always" there; both come back `.granted`.
    private func requestCameraPermission() async -> Bool {
        do {
            let status = try await Wearables.shared.requestPermission(.camera)
            trace("requestPermission: \(status)")
            return status == .granted
        } catch {
            trace("requestPermission: threw \(error)")
            return false
        }
    }

    /// The `mightymouse://` callback the Meta AI app opens to finish
    /// registration. Returning false means the URL was ours but not DAT's.
    func handleCallback(_ url: URL) async -> Bool {
        trace("callback: \(url.scheme ?? "?")://\(url.host ?? "")")
        guard configureIfNeeded() else { return false }
        do {
            let claimed = try await Wearables.shared.handleUrl(url)
            trace("callback: claimed=\(claimed) state=\(Wearables.shared.registrationState)")
            return claimed
        } catch {
            trace("callback: threw \(error)")
            return false
        }
    }

    // MARK: - Availability

    /// A stated answer to "can the glasses be a source", with no side effects
    /// beyond the SDK's own permission check. nil means yes.
    func availability() async -> GlassesUnavailable? {
        trace("availability: begin")
        guard #available(iOS 17.2, *) else { return .sdkUnsupported }
        guard configureIfNeeded() else { return .internalError }
        let wearables = Wearables.shared
        await settleRegistrationState()
        trace("availability: registrationState=\(wearables.registrationState)")
        guard wearables.registrationState == .registered else {
            return wearables.registrationState == .unavailable ? .metaAiNotInstalled : .notRegistered
        }
        await settleDevices()
        trace("availability: devices=\(wearables.devices.count)")
        guard !wearables.devices.isEmpty else { return .noDevice }
        await settleLinkState()
        for id in wearables.devices {
            guard let device = wearables.deviceForIdentifier(id) else { continue }
            trace("availability: device '\(device.nameOrId())' link=\(device.linkState) type=\(device.deviceType())")
        }
        do {
            trace("availability: checkPermissionStatus(.camera) awaiting")
            let status = try await wearables.checkPermissionStatus(.camera)
            trace("availability: permission=\(status)")
            return status == .granted ? nil : .permissionDenied
        } catch {
            trace("availability: permission threw \(error)")
            return Self.reason(for: error)
        }
    }

    /// `configure()` returns before the SDK has actually resolved registration,
    /// and until it does `registrationState` reads `.unavailable` -- which is
    /// indistinguishable from "Meta AI isn't installed". Reading the bare
    /// property is how a signed-in phone reported meta-ai-not-installed on every
    /// cold start and .available only when a foreground bounce happened to
    /// re-run the read late enough.
    private func settleRegistrationState() async {
        let wearables = Wearables.shared
        guard wearables.registrationState == .unavailable else { return }
        trace("availability: unavailable on read, waiting for the SDK to settle")

        // Raced against a timeout rather than iterated directly: an SDK that
        // never publishes again would otherwise park this task forever, and the
        // page would sit on "Starting your glasses..." with nothing to report.
        let settled = await withTaskGroup(of: RegistrationState?.self) { group in
            group.addTask {
                for await state in wearables.registrationStateStream()
                where state != .unavailable { return state }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(Self.registrationSettleSeconds))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        if let settled {
            trace("availability: settled to \(settled)")
        } else {
            trace("availability: still unavailable after \(Self.registrationSettleSeconds)s")
        }
    }

    private static func reason(for error: PermissionError) -> GlassesUnavailable {
        switch error {
        case .metaAINotInstalled: return .metaAiNotInstalled
        case .noDevice, .noDeviceWithConnection: return .noDevice
        case .connectionError, .requestTimeout: return .connectionError
        case .requestInProgress, .internalError: return .internalError
        @unknown default: return .internalError
        }
    }

    /// The only battery signal DAT gives, on either error type. Recorded rather
    /// than only mapped to `batteryOrThermal`, because that one reason answers
    /// "why did it stop" while the HUD is asking "which of the two was it".
    private static func thermal(for error: DeviceSessionError) -> String? {
        switch error {
        case .thermalCritical: return "crit"
        case .thermalEmergency: return "emerg"
        case .peakPowerShutdown: return "shutdn"
        default: return nil
        }
    }

    private static func thermal(for error: StreamError) -> String? {
        switch error {
        case .thermalCritical: return "crit"
        case .thermalEmergency: return "emerg"
        case .peakPowerShutdown: return "shutdn"
        default: return nil
        }
    }

    private func noteTerminal(battery: Bool, thermal: String?) {
        if battery { batteryCritical = true }
        if let thermal { lastThermal = thermal }
        emitStatus()
    }

    private static func reason(for error: DeviceSessionError) -> GlassesUnavailable {
        switch error {
        case .noEligibleDevice: return .noDevice
        case .thermalCritical, .thermalEmergency, .peakPowerShutdown, .batteryCritical:
            return .batteryOrThermal
        case .datAppOnTheGlassesUpdateRequired, .dwaUnavailable: return .metaAiNotInstalled
        default: return .internalError
        }
    }

    private static func reason(for error: StreamError) -> GlassesUnavailable {
        switch error {
        case .permissionDenied: return .permissionDenied
        case .hingesClosed: return .glassesFolded
        case .deviceNotFound, .deviceNotConnected: return .noDevice
        case .thermalCritical, .thermalEmergency, .peakPowerShutdown, .batteryCritical:
            return .batteryOrThermal
        case .timeout, .videoStreamingError: return .connectionError
        default: return .internalError
        }
    }

    // MARK: - Camera

    /// Starts the wearer's camera. `onFrame` receives base64 JPEG, already
    /// chunk-sized for the bridge by the caller's transport.
    ///
    /// NOT idempotent: a second call while streaming stops the first session.
    func startCamera(onFrame: @escaping (String) -> Void) async {
        trace("startCamera: entered")
        if session != nil { stopCamera() }
        // .available means Meta AI is installed but has never approved us. That
        // approval is a round trip THROUGH their app, so asking here is the only
        // way the first-ever start does not dead-end on `not-registered`.
        // Settled first: a cold read is `.unavailable` and would skip this.
        guard configureIfNeeded() else { report(.internalError); return }
        await settleRegistrationState()
        if Wearables.shared.registrationState == .available {
            trace("startCamera: registering")
            if let failed = await register() {
                trace("startCamera: registration failed \(failed.rawValue)")
                report(failed)
                return
            }
            trace("startCamera: registered")
        }
        if let blocked = await availability() {
            // Registration only makes us a permitted app; the camera is a
            // SECOND grant that Meta AI prompts for separately. Asking is the
            // whole remedy for a first-run `denied`, so a plain check here
            // would strand every new user on an error they cannot clear.
            guard blocked == .permissionDenied else {
                trace("startCamera: blocked by \(blocked.rawValue)")
                report(blocked)
                return
            }
            trace("startCamera: requesting camera permission")
            guard await requestCameraPermission() else {
                trace("startCamera: camera permission denied")
                report(.permissionDenied)
                return
            }
            trace("startCamera: camera permission granted")
        }
        frameSink = onFrame
        lastUnavailable = nil
        framesSeen = 0
        dropsSeen = 0
        setState(.starting)

        let wearables = Wearables.shared
        do {
            // Unfiltered, the selector picked an id matching neither paired
            // device and addCamera returned nil on it. Two are paired here (a
            // Display and a plain Ray-Ban) and only one is ever awake, so the
            // filter is "the link is actually up".
            let selector = AutoDeviceSelector(wearables: wearables) { $0.linkState == .connected }
            // The selector picks its device asynchronously, so constructing it
            // and creating a session on the next line races it -- and losing
            // that race throws `noEligibleDevice` on a phone whose glasses are
            // connected and fine.
            await settleActiveDevice(selector)
            trace("startCamera: createSession active=\(selector.activeDevice ?? "none")")
            let created = try wearables.createSession(deviceSelector: selector)
            session = created
            listen(to: created)

            let config = StreamConfiguration(
                videoCodec: .raw,
                resolution: .low,
                frameRate: Self.streamFrameRate
            )
            // The session must be running before it will hand out a camera:
            // `addCamera` on an `idle` session returned nil with nothing on the
            // error publisher, and `DeviceSessionError.sessionIdle` exists for
            // exactly this. start() first, then attach.
            trace("startCamera: session.start (state=\(created.state) device=\(created.deviceId))")
            try created.start()
            await settleSessionStarted(created)

            trace("startCamera: addCamera session.state=\(created.state)")
            guard let cam = try created.addCamera(config: config) else {
                // addCamera both throws AND returns optional: a nil is the
                // silent half, so the session's own state is the only thing
                // left that says why.
                trace("startCamera: addCamera returned nil, session.state=\(created.state)")
                report(.internalError)
                stopCamera()
                return
            }
            camera = cam
            listen(to: cam.stream)
            trace("startCamera: stream.start")
            cam.stream.start()
            trace("startCamera: started, waiting for frames")
        } catch {
            trace("startCamera: threw \(error)")
            report(Self.reason(for: error))
            stopCamera()
        }
    }

    func stopCamera() {
        camera?.stop()
        session?.stop()
        camera = nil
        session = nil
        frameSink = nil
        listeners.removeAll()
        if state != .idle { setState(.stopped) }
    }

    private func listen(to session: DeviceSession) {
        listeners.append(session.errorPublisher.listen { [weak self] error in
            Task { @MainActor in
                self?.trace("session: error \(error)")
                self?.noteTerminal(battery: error == .batteryCritical, thermal: Self.thermal(for: error))
                self?.report(Self.reason(for: error))
                self?.stopCamera()
            }
        })
        // addCamera can fail by returning nil with nothing on the error
        // publisher, so the state track is the only other witness to why.
        listeners.append(session.statePublisher.listen { [weak self] sessionState in
            Task { @MainActor in self?.trace("session: state \(sessionState)") }
        })
    }

    private func listen(to stream: MWDATCamera.Stream) {
        listeners.append(stream.errorPublisher.listen { [weak self] error in
            Task { @MainActor in
                self?.trace("stream: error \(error)")
                self?.noteTerminal(battery: error == .batteryCritical, thermal: Self.thermal(for: error))
                self?.report(Self.reason(for: error))
                self?.stopCamera()
            }
        })
        listeners.append(stream.statePublisher.listen { [weak self] streamState in
            Task { @MainActor in
                guard let self else { return }
                // A stream that starts and never delivers a frame is silent
                // otherwise: .waitingForDevice and .streaming look identical
                // from the outside.
                self.trace("stream: state \(streamState)")
                switch streamState {
                case .streaming: self.setState(.streaming)
                case .stopped: if self.state != .idle { self.setState(.stopped) }
                default: break
                }
            }
        })
        listeners.append(stream.videoFramePublisher.listen { [weak self] frame in
            guard let image = frame.makeUIImage() else {
                Task { @MainActor in self?.traceFrameDrop("makeUIImage returned nil") }
                return
            }
            guard let jpeg = image.jpegData(compressionQuality: Self.jpegQuality) else {
                Task { @MainActor in self?.traceFrameDrop("jpegData returned nil") }
                return
            }
            let encoded = jpeg.base64EncodedString()
            Task { @MainActor in
                self?.traceFirstFrame(bytes: jpeg.count)
                self?.frameSink?(encoded)
            }
        })
    }
}
#endif
