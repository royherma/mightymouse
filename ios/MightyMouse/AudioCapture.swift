import AVFoundation
import Foundation
import Speech

/// A finished recording waiting to reach the Mac. Persisted as JSON in the App
/// Group defaults; the audio bytes live alongside it as a file, since
/// UserDefaults is the wrong place for megabytes.
struct QueuedClip: Codable, Identifiable {
    let id: String
    let fileName: String
    let durationMs: Int
    let to: PhoneAudioDestination
    let createdAt: Date
    /// What the PHONE heard, for display while the clip waits. Never what gets
    /// pasted -- the Mac re-transcribes on arrival and its text always wins
    /// Optional so index entries written before this shipped
    /// still decode, and nil whenever recognition was denied or unavailable.
    var phoneText: String?
    /// The Mac was unreachable when this was RECORDED, so it drains late: the
    /// user spoke minutes ago and is looking at some other app. The Mac reads
    /// this to transcribe silently instead of pasting into whatever is
    /// frontmost. Every clip takes this queue -- even a live one, which drains
    /// immediately -- so the flag is the only thing telling the two apart.
    /// Optional so entries written before this shipped still decode.
    var macAway: Bool?
}

/// Two values only, matching `src/shared/types.ts`'s `PHONE_AUDIO_TO` --
/// Swift can't import that file, so this is the one place the enum is
/// hand-mirrored. Keep it exactly two cases.
enum PhoneAudioDestination: String, Codable {
    case paste
    case chat
}

/// Owns 100% of the audio-session lifecycle (`ios/docs/background-audio-spike.md`
/// isolation advice): `AVAudioSession` activation, `AVAudioRecorder`
/// start/stop, the hard duration cap, and the on-disk queue. No other file
/// touches `AVAudioSession` or `AVAudioRecorder`.
///
/// Recording only ever STARTS while the app is in the foreground -- there is
/// no cold-start path here, by design (see the spike doc for why).
///
/// The deck (`react/App.tsx`) remains the ONE recorder in the product sense:
/// it owns the button, the HUD, the Stop and the destination, and it drives
/// this class as its capture device on the native shell. It is not a second
/// recorder -- `native-bridge.ts`'s `startRecording` note and `RecordingModel`'s
/// header both describe the stop-bar bug that shape caused before.
@MainActor
final class AudioCapture: NSObject, ObservableObject {
    /// Reachable from `Intents.swift` (the Live Activity's Stop button runs in
    /// the app process) and `NativeBridge`, neither of which can be handed an
    /// instance.
    static let shared = AudioCapture()

    enum PermissionState {
        case unknown
        case granted
        case denied
    }

    /// Why the app currently needs to stay alive in the background. Empty set
    /// means it may suspend normally, which is the whole 2.5.4 defense: we hold
    /// the session while something audible is genuinely happening and not a
    /// moment longer.
    enum Reason: String {
        case micCapture
        /// Writing out a queued clip. Holds the session because `SFSpeechRecognizer`
        /// activates one of its own: without this the release in `finish()` tears
        /// the session down under the recognizer, and the NEXT `start()` finds it
        /// still owned and throws -- record once, then never again.
        case clipTranscribe
        case mirrorAudio
        /// The mirror is in Picture-in-Picture. Unlike `mirrorAudio` this DOES
        /// activate a session, because it has to work with the Mac's audio
        /// switched off: with no audio track WebKit holds no session, so
        /// nothing keeps the page alive, it suspends, and the PiP window shows
        /// the last decoded frame forever. A frozen picture was exactly the
        /// on-device report.
        case mirrorPip
        /// This phone's mic is streaming TO the Mac (a voice call). Distinct
        /// from `mirrorAudio`, which is the Mac's sound arriving here: the Live
        /// Activity has to say "Hearing you", and pocketing the phone mid-call
        /// must not drop the hold that keeps the mic alive.
        case phoneMic
    }

    /// What the shared session is FOR right now. Derived from `holds`, never
    /// stored: two of these states were previously one `recording == false`
    /// branch, and collapsing them is what silenced PiP audio -- `.mixWithOthers`
    /// is right for one and wrong for the other, so no single flag can serve
    /// both. Ordered by precedence; `resolve` returns the first that applies.
    enum Role {
        /// A voice note is capturing. Outranks everything: the mirror losing
        /// mixability for the length of a note is recoverable, a note that
        /// cannot record is not.
        case micCapture
        /// The mirror plays INLINE, in the foreground, inside WebKit's own
        /// session. We are the passenger here.
        case mirrorInline
        /// The mirror is floating in PiP. The video is ours (`PipMirror`'s
        /// `AVSampleBufferDisplayLayer`), the audio is still WebKit's, and the
        /// app must be the primary session or iOS routes nothing to the speaker.
        case mirrorPip
        /// This phone's mic is streaming to the Mac over WebRTC. The track is
        /// WebKit's, but a `.playback` session does not keep a getUserMedia
        /// track alive once the app backgrounds -- WebKit mutes it, and the call
        /// goes silent the moment the phone is pocketed, which is the posture
        /// this feature is FOR. So it takes the recording category itself.
        case phoneMic

        /// The one place a category is chosen. `.playAndRecord` needs the mic,
        /// so only `.micCapture` may ask for it -- the others would put a
        /// permission prompt in front of someone who just switched apps.
        var category: (AVAudioSession.Category, AVAudioSession.CategoryOptions) {
            switch self {
            case .micCapture:
                // HFP is what a Bluetooth mic (incl. the glasses) arrives on.
                return (.playAndRecord, [.defaultToSpeaker, .allowBluetoothHFP])
            case .mirrorInline:
                // Mixable ON PURPOSE: WebKit's WebContent process holds its own
                // session for the inline <video>, and a non-mixable activation
                // interrupts it -- WebKit pauses the video and iOS dismisses the
                // PiP window seconds later (the round-3 eject).
                return (.playback, [.mixWithOthers])
            case .phoneMic:
                // Same tuple as `.micCapture`: the mic permission is already
                // granted (the page opened the track before this hold exists),
                // so there is no prompt to put in front of anyone here.
                return (.playAndRecord, [.defaultToSpeaker, .allowBluetoothHFP])
            case .mirrorPip:
                // The category was NEVER the audio variable -- every tuple incl.
                // `.playAndRecord` tested silent (docs/pip-audio-attempts.md).
                // PiP audio is WebKit's <video>, revived page-side by play() on
                // the hide edge. This session exists only so auto-PiP arms.
                return (.playback, [])
            }
        }
    }

    /// Which microphone a voice note should use. The glasses mic is NOT a DAT
    /// API -- `Permission` has only `.camera`. Glasses audio is ordinary
    /// Bluetooth HFP, so this selects a preferred INPUT on the session we
    /// already own rather than opening a second capture path.
    enum MicSource: String {
        case phone
        case glasses
    }

    @Published private(set) var isRecording = false
    @Published private(set) var elapsedSeconds: Int = 0
    @Published private(set) var permission: PermissionState = .unknown
    @Published private(set) var holds: Set<Reason> = []

    /// Set by the deck's picker, read at `applyRole` time. Not persisted here:
    /// the page owns the preference, this is the live value for the next note.
    var micSource: MicSource = .phone

    /// A forgotten recording must end itself -- this is the isolation-advice
    /// cap, not a UX nicety. Keeps clips comfortably under `MAX_AUDIO_BYTES`
    /// (48MB) at any reasonable bitrate.
    static let maxDurationSeconds = 300

    /// 10Hz. The deck's waveform is 5 bars, so anything faster is redundant
    /// motion paid for with a `evaluateJavaScript` hop per tick.
    private static let meterInterval: TimeInterval = 0.1

    private var recorder: AVAudioRecorder?
    private var currentFileName: String?
    private var startedAt: Date?
    private var capTimer: Timer?
    private var tickTimer: Timer?
    private var meterTimer: Timer?
    private var sessionActive = false
    /// Armed by `releaseHoldsForTeardown()`, cancelled by the next `hold()`.
    /// See that pair for why a bare deactivate-on-teardown regresses PiP.
    private var teardownDeadlineTimer: Timer?
    /// SwiftUI remounts a recycled `dismantleUIView`/`makeUIView` pair inside
    /// one runloop turn; 3s is generous enough to never race that while still
    /// closing a genuinely-dead deck well before a reviewer notices.
    private static let teardownDeadline: TimeInterval = 3.0

    /// Bumped by every start AND every stop, so the permission callback can tell
    /// whether the tap it was armed for is still the current one. Without it a
    /// stop during the prompt is invisible to Swift -- `isRecording` is still
    /// false, so `finish()` no-ops -- and the grant then starts a recording the
    /// deck has already forgotten, which it can never stop again.
    private var startGeneration = 0

    // MARK: - Background holds

    func hold(_ reason: Reason) {
        // A remount re-asserting a mirror hold is exactly the "recycle, not
        // dead" case the teardown deadline exists to distinguish -- cancel it
        // before it can deactivate a session this new hold just re-claimed.
        cancelTeardownDeadline()
        // Session first, and OUTSIDE the already-held guard: `applyRole` is
        // itself idempotent, and a reentrant hold that skipped it would leave
        // the Live Activity claiming a live session that was never activated.
        applyRole(incoming: reason)
        guard !holds.contains(reason) else { return }
        holds.insert(reason)
        trace("hold +\(reason.rawValue) -> [\(holdsDescription)]")
        BackgroundActivity.sync(holds: holds, startedAt: startedAt ?? Date())
    }

    /// Re-derives the role on the way DOWN too. Dropping the mic while PiP is
    /// still held used to leave `.playAndRecord` pinned for the rest of the
    /// session with nothing ever taking it away.
    func release(_ reason: Reason) {
        guard holds.remove(reason) != nil else { return }
        trace("release -\(reason.rawValue) -> [\(holdsDescription)]")
        // Re-assert for whatever still holds it -- releasing PiP mid-voice-note
        // must not cut the recording's session out from under it.
        if resolveRole() != nil {
            applyRole(outgoing: reason)
            BackgroundActivity.sync(holds: holds, startedAt: startedAt ?? Date())
            return
        }
        // Nothing audible left: hand the session back.
        deactivateSession()
        BackgroundActivity.sync(holds: holds, startedAt: startedAt ?? Date())
    }

    /// Drops the mirror holds WITHOUT re-deriving the role or deactivating.
    /// SwiftUI dismantles the representable on its own schedule and can fire on
    /// a LIVE mirror, so a teardown must not hand back a session something is
    /// still playing through. The page emits its own `pipActivity`/`audioActivity`
    /// false when the mirror genuinely ends; that path goes through `release`.
    ///
    /// But a dead webview can never emit that false -- its JS died with it --
    /// so a genuinely-gone deck would otherwise leave the session active with
    /// an empty `holds` set forever. Arms a deadline
    /// instead: a remount cancels it via `hold()`, silence lets it fire and
    /// deactivate.
    func releaseHoldsForTeardown() {
        holds.remove(.mirrorAudio)
        holds.remove(.mirrorPip)
        BackgroundActivity.sync(holds: holds, startedAt: startedAt ?? Date())
        armTeardownDeadline()
    }

    /// Re-checks `resolveRole()` at FIRE time, not arm time: a voice note can
    /// start after teardown while the deadline is pending, and must not have
    /// its session yanked out from under it.
    private func armTeardownDeadline() {
        teardownDeadlineTimer?.invalidate()
        trace("teardown deadline armed (\(Self.teardownDeadline)s)")
        teardownDeadlineTimer = Timer.scheduledTimer(withTimeInterval: Self.teardownDeadline, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.teardownDeadlineTimer = nil
                guard self.resolveRole() == nil else {
                    self.trace("teardown deadline fired -- role still held, skipping deactivate")
                    return
                }
                self.trace("teardown deadline fired -- deactivating")
                self.deactivateSession()
            }
        }
    }

    private func cancelTeardownDeadline() {
        guard teardownDeadlineTimer != nil else { return }
        teardownDeadlineTimer?.invalidate()
        teardownDeadlineTimer = nil
        trace("teardown deadline cancelled -- remount re-asserted a hold")
    }

    /// The page confirming it actually stopped what the Live Activity's Stop
    /// asked it to stop. Releasing `.mirrorAudio` optimistically inside the
    /// intent is what made Stop a no-op that still dismissed its own activity:
    /// the hold is dropped HERE, once the mirror is genuinely off, so an
    /// undeliverable emit leaves the activity up telling the truth instead.
    func acknowledgeStop() {
        trace("STOP acknowledgeStop pendingStop=\(SharedAppGroup.defaults.bool(forKey: SharedAppGroup.pendingStopKey)) pendingMirror=\(SharedAppGroup.defaults.bool(forKey: SharedAppGroup.pendingStopMirrorKey)) holds=[\(holdsDescription)]")
        SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingStopKey)
        SharedAppGroup.defaults.removeObject(forKey: SharedAppGroup.pendingStopMirrorKey)
        release(.mirrorAudio)
        release(.mirrorPip)
    }

    /// Relayed to the Mac's log over the page's socket, same as `PipMirror`'s:
    /// a device log needs a cable, and every audio-session theory so far has
    /// been reasoning about state nobody could observe.
    private func trace(_ text: String) {
        MMLog.recording.info("\(text, privacy: .public)")
        NativeIntentRouter.emit(["type": "nativeLog", "text": "audio: \(text)"])
    }

    private var holdsDescription: String {
        holds.isEmpty ? "none" : holds.map(\.rawValue).sorted().joined(separator: "+")
    }

    /// `incoming` matters because `holds` has not been updated yet when `hold`
    /// calls this: resolving on the set alone would pick the mirror's role for
    /// the mic's own hold. `outgoing` is the mirror image for `release`, where
    /// the hold is already gone but must not be counted.
    private func resolveRole(incoming: Reason? = nil, outgoing: Reason? = nil) -> Role? {
        var active = holds
        if let incoming { active.insert(incoming) }
        if let outgoing { active.remove(outgoing) }
        // A recorder still writing outranks the set: `finish()` clears the hold
        // before the file closes.
        if recorder != nil || active.contains(.micCapture) { return .micCapture }
        // Same role as a live note: the recognizer reads a FILE, but it still
        // activates a session, so the app must be the one holding it.
        if active.contains(.clipTranscribe) { return .micCapture }
        // Above the mirror roles: both resolve to `.playback`, which silently
        // mutes the outgoing mic when the app backgrounds.
        if active.contains(.phoneMic) { return .phoneMic }
        if active.contains(.mirrorPip) { return .mirrorPip }
        if active.contains(.mirrorAudio) { return .mirrorInline }
        return nil
    }

    /// Re-asserts on every call rather than returning early when already active:
    /// a PiP hold taken first would otherwise pin its category, and a voice note
    /// starting underneath it gets a session that cannot record. `setCategory`
    /// on an active session is allowed and cheap.
    ///
    /// OWNERSHIP: with both mic and mirror live we set `.playAndRecord` while
    /// WebKit independently owns its own session for the inline `<video>`. Which
    /// wins a re-assert is UNVERIFIED on device -- if mirror audio ever cuts out
    /// the moment a voice note starts, look here first
    private func applyRole(incoming: Reason? = nil, outgoing: Reason? = nil) {
        // `.mirrorInline` deliberately does not activate: WebKit already owns a
        // session for the inline video, and activating underneath it interrupts
        // the very playback the hold exists to keep alive.
        let resolved = resolveRole(incoming: incoming, outgoing: outgoing)
        guard let role = resolved, role != .mirrorInline else {
            trace("role \(resolved.map(String.init(describing:)) ?? "none") -- session untouched")
            return
        }
        let session = AVAudioSession.sharedInstance()
        let (category, options) = role.category
        do {
            try session.setCategory(category, options: options)
            try session.setActive(true)
            sessionActive = true
            if role == .micCapture { applyPreferredInput(session) }
            // Route and other-audio are the readable half of "did we actually
            // get the speaker", which is the shape silent-PiP would take.
            trace("role \(role) cat=\(category.rawValue) opts=\(options.rawValue) route=\(session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: ",")) otherAudio=\(session.isOtherAudioPlaying)")
        } catch {
            MMLog.phase.error("audio session activate failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Points the session at the glasses when asked, and at the phone otherwise.
    /// Must run AFTER `setActive` -- `availableInputs` is empty on an inactive
    /// session, so an earlier call silently selects nothing.
    private func applyPreferredInput(_ session: AVAudioSession) {
        guard micSource == .glasses else {
            try? session.setPreferredInput(nil)
            return
        }
        guard let hfp = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) else {
            trace("glasses mic: no HFP input offered, staying on the phone")
            return
        }
        do {
            try session.setPreferredInput(hfp)
            trace("glasses mic: preferred input \(hfp.portName)")
        } catch {
            trace("glasses mic: setPreferredInput failed -- \(error.localizedDescription)")
        }
    }

    /// Whether the live route actually reaches the glasses. Meta documents the
    /// failure as SILENT -- the route simply stays on the phone -- so the
    /// picker asks here instead of assuming the request landed.
    var glassesMicRouteActive: Bool {
        AVAudioSession.sharedInstance().currentRoute.inputs.contains { $0.portType == .bluetoothHFP }
    }

    private func deactivateSession() {
        guard sessionActive else { return }
        sessionActive = false
        trace("session deactivated")
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Recording

    func requestPermission(_ completion: @escaping (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                self?.permission = granted ? .granted : .denied
                completion(granted)
            }
        }
    }

    /// Starts immediately if permission is already granted; otherwise asks
    /// first. Foreground-only by construction -- the deck only calls this from
    /// a live tap, and the spike doc's rule is start-in-foreground.
    func start(to destination: PhoneAudioDestination, macAway: Bool = false) {
        pendingMacAway = macAway
        guard !isRecording else { return }
        startGeneration += 1
        let generation = startGeneration
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            beginRecording(to: destination)
        case .denied:
            permission = .denied
            NativeIntentRouter.emit(["type": "nativeMicFailed", "reason": "denied"])
        case .undetermined:
            requestPermission { [weak self] granted in
                guard let self else { return }
                // Stopped or cancelled while the sheet was up: the deck has
                // already reset, so honour that rather than starting a recording
                // nothing is holding a reference to.
                guard generation == self.startGeneration else {
                    NativeIntentRouter.emit(["type": "nativeMicStopped", "discarded": true, "durationMs": 0])
                    return
                }
                guard granted else {
                    NativeIntentRouter.emit(["type": "nativeMicFailed", "reason": "denied"])
                    return
                }
                self.beginRecording(to: destination)
            }
        @unknown default:
            permission = .denied
            NativeIntentRouter.emit(["type": "nativeMicFailed", "reason": "denied"])
        }
    }

    private func beginRecording(to destination: PhoneAudioDestination) {
        hold(.micCapture)
        guard sessionActive else {
            release(.micCapture)
            NativeIntentRouter.emit(["type": "nativeMicFailed", "reason": "session"])
            return
        }

        let fileName = "\(UUID().uuidString).m4a"
        let url = SharedAppGroup.recordingsDirectory.appendingPathComponent(fileName)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]

        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.delegate = self
            recorder.isMeteringEnabled = true
            guard recorder.record() else {
                release(.micCapture)
                MMLog.phase.error("AVAudioRecorder.record() returned false")
                NativeIntentRouter.emit(["type": "nativeMicFailed", "reason": "record"])
                return
            }
            self.recorder = recorder
            self.currentFileName = fileName
            self.startedAt = Date()
            self.pendingDestination = destination
            permission = .granted
            isRecording = true
            elapsedSeconds = 0
            armTimers()
            BackgroundActivity.sync(holds: holds, startedAt: Date())
            // The source is stated, never inferred: a glasses note that quietly
            // recorded off the phone is indistinguishable from a working one
            // until playback.
            let routed = micSource == .phone || glassesMicRouteActive
            NativeIntentRouter.emit([
                "type": "nativeMicStarted",
                "source": (routed ? micSource : .phone).rawValue,
                "requested": micSource.rawValue
            ])
        } catch {
            release(.micCapture)
            MMLog.phase.error("AVAudioRecorder init failed: \(error.localizedDescription, privacy: .public)")
            NativeIntentRouter.emit(["type": "nativeMicFailed", "reason": "record"])
        }
    }

    private var pendingDestination: PhoneAudioDestination = .paste
    /// Whether THIS recording should be written out on the phone. False when the
    /// Mac is reachable: it re-transcribes every clip anyway, so running Apple
    /// Speech as well costs battery and an audio-session hold for a preview the
    /// deck throws away.
    private var pendingMacAway = false

    private func armTimers() {
        tickTimer?.invalidate()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let startedAt = self.startedAt else { return }
                self.elapsedSeconds = Int(Date().timeIntervalSince(startedAt))
            }
        }
        capTimer?.invalidate()
        capTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(Self.maxDurationSeconds), repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finish(discard: false) }
        }
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: Self.meterInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.emitLevel() }
        }
    }

    private func clearTimers() {
        capTimer?.invalidate()
        tickTimer?.invalidate()
        meterTimer?.invalidate()
        capTimer = nil
        tickTimer = nil
        meterTimer = nil
    }

    /// LINEAR amplitude, not the dBFS `averagePower` returns: that is the unit
    /// the deck's analyser produces from a MediaStream, so `MicWaveform`'s gain
    /// curve applies to both paths without a second calibration to drift.
    private func emitLevel() {
        guard let recorder, isRecording else { return }
        recorder.updateMeters()
        let amplitude = pow(10, recorder.averagePower(forChannel: 0) / 20)
        NativeIntentRouter.emit(["type": "nativeMicLevel", "level": Double(amplitude)])
    }

    /// Ends the recording and enqueues it. A no-op if nothing is recording, so
    /// the cap timer and a manual Stop tap can both call this safely.
    @discardableResult
    func stop() -> QueuedClip? {
        finish(discard: false)
    }

    /// Ends the recording and throws the audio away -- the deck's Cancel.
    func cancel() {
        finish(discard: true)
    }

    @discardableResult
    private func finish(discard: Bool) -> QueuedClip? {
        // Bumped FIRST and unconditionally: a stop can arrive while `start` is
        // still awaiting the permission sheet, and invalidating the generation
        // is the only thing that stops the grant from starting a recording the
        // deck has already given up on.
        startGeneration += 1
        guard isRecording, let recorder, let fileName = currentFileName, let startedAt else {
            return nil
        }
        recorder.stop()
        clearTimers()
        self.recorder = nil
        self.currentFileName = nil
        isRecording = false
        elapsedSeconds = 0
        let fileURL = SharedAppGroup.recordingsDirectory.appendingPathComponent(fileName)
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        let keeping = !discard && durationMs >= RecordingModel.minRecordingMs
        let transcribing = keeping && pendingMacAway
        // BEFORE the release, so the hold set never empties between the two --
        // an empty set deactivates the session, and the recognition Task below
        // would then be activating one nothing in here is arbitrating.
        // Dropped in every exit path of that Task, including the failures.
        if transcribing { hold(.clipTranscribe) }
        release(.micCapture)
        // Only now that the last hold may be gone: `release` syncs the Live
        // Activity, and a nil `startedAt` there would reset a still-running
        // mirror's timer to 00:00.
        if holds.isEmpty { self.startedAt = nil }

        guard keeping else {
            try? FileManager.default.removeItem(at: fileURL)
            NativeIntentRouter.emit([
                "type": "nativeMicStopped",
                "discarded": true,
                "durationMs": durationMs
            ])
            return nil
        }
        let clip = QueuedClip(
            id: UUID().uuidString,
            fileName: fileName,
            durationMs: durationMs,
            to: pendingDestination,
            createdAt: Date(),
            macAway: pendingMacAway
        )
        RecordingQueue.enqueue(clip)
        // `transcribing` is what lets the deck fill the gap before the words:
        // recognition starts below and takes seconds, and only this side knows
        // whether it is even going to run.
        NativeIntentRouter.emit([
            "type": "nativeMicStopped",
            "discarded": false,
            "durationMs": durationMs,
            "transcribing": transcribing
        ])
        // Deliberately AFTER the enqueue and deliberately not awaited: the clip
        // is saved and drainable the instant it exists, and recognition on a
        // long recording takes seconds the user is not going to stand still for
        // The words catch up; the save never waits for them.
        guard transcribing else { return clip }
        Task { @MainActor in
            let outcome = await ClipTranscriber.transcribe(fileURL: fileURL)
            // The hold goes back FIRST and unconditionally: every path out of
            // here, success or failure, must hand the session over or the next
            // recording finds it still owned.
            release(.clipTranscribe)
            switch outcome {
            case let .text(text):
                RecordingQueue.setPhoneText(text, for: clip.id)
                NativeIntentRouter.emit(["type": "clipPhoneText", "clipId": clip.id, "text": text])
            case let .unavailable(reason):
                // Said out loud rather than dropped: a clip that saved with no
                // words is otherwise indistinguishable from one that never tried.
                NativeIntentRouter.emit([
                    "type": "clipPhoneTextFailed",
                    "clipId": clip.id,
                    "reason": reason.rawValue
                ])
            }
        }
        return clip
    }
}

extension AudioCapture: AVAudioRecorderDelegate {
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        MMLog.phase.error("recorder encode error: \(error?.localizedDescription ?? "unknown", privacy: .public)")
    }
}

/// Writes out what the phone heard, on the phone, with no network and no Mac.
///
/// Exists so a queued clip isn't silent to its owner: without it you record,
/// get "saved", and have no idea what you said until you walk back to your Mac
/// The text is a RECEIPT, never the artifact -- the Mac re-runs
/// whisper on the same audio and its transcript is what reaches the cursor.
///
/// Apple Speech rather than a bundled Whisper deliberately: no model download,
/// no app-size cost, every supported iPhone can do it. Lower accuracy is
/// acceptable precisely because this text is never the final one.
enum ClipTranscriber {
    /// Why no words came back. Named rather than collapsed to nil so the deck
    /// can say which one happened: "you turned this off" and "your phone can't
    /// do it" need different sentences, and a silent clip needs one at all.
    enum Unavailable: String {
        case denied
        case unsupported
        case failed
        case heardNothing
    }

    enum Outcome {
        case text(String)
        case unavailable(Unavailable)
    }

    /// `nil` when the locale has no on-device asset. Never a network fallback:
    /// the audio not leaving the phone is the point.
    private static var recognizer: SFSpeechRecognizer? {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard recognizer?.supportsOnDeviceRecognition == true else { return nil }
        return recognizer
    }

    /// Asked lazily, at the first offline transcription -- never at onboarding,
    /// where the permission budget is already the product's sorest spot.
    private static func authorized() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default: return false
        }
    }

    /// Never throws and never blocks the queue: a clip with no words is still a
    /// perfectly good queued clip. It does now say WHY there are no words.
    static func transcribe(fileURL: URL) async -> Outcome {
        guard await authorized() else { return .unavailable(.denied) }
        guard let recognizer else { return .unavailable(.unsupported) }
        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        // The whole point: no audio may leave the phone. If the OS can't honor
        // this it fails the request rather than quietly using the network.
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false

        let raw: String? = await withCheckedContinuation { continuation in
            // `recognitionTask` fires its callback more than once even with
            // partials off (an error can follow a final result), so the
            // continuation is guarded -- resuming twice is a crash.
            var resumed = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !resumed else { return }
                if let result, result.isFinal {
                    resumed = true
                    continuation.resume(returning: result.bestTranscription.formattedString)
                } else if error != nil {
                    resumed = true
                    continuation.resume(returning: nil)
                }
            }
        }
        guard let raw else { return .unavailable(.failed) }
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .unavailable(.heardNothing)
        }
        // Punctuation and de-umming for free, with its own guard against the
        // model summarising instead. Skipped silently on a phone without
        // Apple Intelligence, which still leaves the raw words.
        return .text((try? await OnDeviceModel.tidy(raw)) ?? raw)
    }
}

/// The on-disk queue: a JSON index in the App Group defaults plus the audio
/// files it points at. `AudioCapture` is the only writer; `RecordingModel` is
/// the only reader/drainer -- kept separate so a redesign of the recorder
/// never touches how flushing works.
enum RecordingQueue {
    private static let indexKey = "mm.queuedClips"

    static func enqueue(_ clip: QueuedClip) {
        var clips = all()
        clips.append(clip)
        save(clips)
    }

    static func keepNote(audio: Data, ext: String, durationMs: Int, queued: Bool) -> QueuedClip? {
        guard ["wav", "m4a", "webm"].contains(ext) else { return nil }
        let clip = QueuedClip(
            id: UUID().uuidString,
            fileName: "\(UUID().uuidString).\(ext)",
            durationMs: durationMs,
            to: .paste,
            createdAt: Date(),
            macAway: true
        )
        guard (try? audio.write(to: fileURL(for: clip), options: .atomic)) != nil else { return nil }
        if queued { enqueue(clip) }
        return clip
    }

    static func all() -> [QueuedClip] {
        guard let data = SharedAppGroup.defaults.data(forKey: indexKey),
              let clips = try? JSONDecoder().decode([QueuedClip].self, from: data) else {
            return []
        }
        return clips
    }

    /// Removes one clip's index entry AND its file. Called only after the Mac
    /// has confirmed receipt -- never speculatively, or a drop mid-flush would
    /// lose audio with nothing left to retry.
    static func remove(_ clipId: String) {
        let remaining = all().filter { clip in
            guard clip.id == clipId else { return true }
            try? FileManager.default.removeItem(at: fileURL(for: clip))
            return false
        }
        save(remaining)
    }

    static func fileURL(for clip: QueuedClip) -> URL {
        SharedAppGroup.recordingsDirectory.appendingPathComponent(clip.fileName)
    }

    /// Fills in what the phone heard, some seconds after the clip was saved.
    /// Re-reads the index rather than taking a clip value: a drain may have
    /// removed this entry while recognition was running, and a stale write
    /// would resurrect a clip the Mac has already received.
    static func setPhoneText(_ text: String, for clipId: String) {
        var clips = all()
        guard let index = clips.firstIndex(where: { $0.id == clipId }) else { return }
        clips[index].phoneText = text
        save(clips)
    }

    /// A file with no index entry is a recording the process died under --
    /// `finish()` never ran, so nothing else will ever delete it.
    static func sweepOrphanFiles() {
        let indexed = Set(all().map(\.fileName))
        let dir = SharedAppGroup.recordingsDirectory
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for name in files where !indexed.contains(name) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    private static func save(_ clips: [QueuedClip]) {
        guard let data = try? JSONEncoder().encode(clips) else { return }
        SharedAppGroup.defaults.set(data, forKey: indexKey)
    }
}
