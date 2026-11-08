import ActivityKit
import AppIntents
import Foundation
#if MM_WIDGET_EXTENSION
import SwiftUI
import WidgetKit
#endif

/// The Live Activity shown whenever MightyMouse is holding the phone awake.
///
/// It is not decoration. `UIBackgroundModes: audio` is only defensible if the
/// user can always see that the app is running and end it in one tap -- that is
/// both the App Review answer (`ios/docs/background-audio-spike.md`) and the
/// honest thing to do to someone's battery.
///
/// A member of BOTH targets, for the same reason `Intents.swift` is: the app
/// starts and ends the activity, the widget extension renders it, and the Stop
/// button's intent must be owned by the app to run there.
struct BackgroundActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var listening: Bool
        var playing: Bool
        var startedAt: Date
    }
}

/// The Live Activity's Stop button. `LiveActivityIntent` runs in the APP
/// process, which is why it can reach `AudioCapture` at all -- and why this
/// type cannot live in the extension target alone.
struct StopBackgroundAudioIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop"

    func perform() async throws -> some IntentResult {
        #if !MM_WIDGET_EXTENSION
        // ORDER IS LOAD-BEARING, and getting it wrong is what shipped a Stop
        // button that did nothing. Releasing `.mirrorAudio` first empties
        // `holds`, which ends the Live Activity immediately -- so the button
        // looked like it worked while the sound kept playing.
        //
        // Persist BEFORE emitting, because the emit is the unreliable half: a
        // backgrounded webview may never run it, and only the page can end a
        // WebRTC track (releasing the hold deliberately does not touch the
        // session WebKit owns for the <video>).
        NativeIntentRouter.emit(["type": "nativeLog", "text": "audio: STOP intent fired (Live Activity button)"])
        SharedAppGroup.defaults.set(true, forKey: SharedAppGroup.pendingStopKey)
        SharedAppGroup.defaults.set(true, forKey: SharedAppGroup.pendingStopMirrorKey)
        NativeIntentRouter.emit(["type": "nativeStopRequested", "stopMirror": true])
        await MainActor.run {
            // The mic IS ours to end synchronously -- unlike the mirror, no
            // page round-trip is involved. `.mirrorAudio` is released only when
            // the page acks, in `AudioCapture.acknowledgeStop()`.
            AudioCapture.shared.stop()
        }
        #endif
        return .result()
    }
}

#if !MM_WIDGET_EXTENSION
/// Start/update/end, driven from one place: `AudioCapture`'s hold set. No call
/// site starts or ends an activity directly, so the thing on the Lock Screen
/// cannot disagree with what is actually running.
enum BackgroundActivity {
    private static var current: Activity<BackgroundActivityAttributes>?

    @MainActor
    static func sync(holds: Set<AudioCapture.Reason>, startedAt: Date) {
        let state = BackgroundActivityAttributes.ContentState(
            listening: holds.contains(.micCapture) || holds.contains(.phoneMic),
            playing: holds.contains(.mirrorAudio),
            startedAt: startedAt
        )
        guard !holds.isEmpty else {
            end()
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        if let activity = current {
            Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        do {
            current = try Activity.request(
                attributes: BackgroundActivityAttributes(),
                content: ActivityContent(state: state, staleDate: nil)
            )
        } catch {
            MMLog.phase.error("live activity request failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func end() {
        guard let activity = current else { return }
        current = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    /// Activities outlive an app kill; `current` does not. Anything found at
    /// launch is an orphan from a previous process still sitting on the Lock
    /// Screen -- willTerminate cannot await an end, so launch is where they die.
    static func endOrphans() {
        for activity in Activity<BackgroundActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
#endif

#if MM_WIDGET_EXTENSION
struct BackgroundActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BackgroundActivityAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: glyph(context.state))
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(headline(context.state))
                        .font(.subheadline.weight(.semibold))
                    Text(context.state.startedAt, style: .timer)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(intent: StopBackgroundAudioIntent()) {
                    Text("Stop").font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.bordered)
            }
            .padding()
            .activityBackgroundTint(nil)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: glyph(context.state))
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(headline(context.state)).font(.subheadline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.startedAt, style: .timer)
                        .font(.caption.monospacedDigit())
                        .frame(maxWidth: 56)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Button(intent: StopBackgroundAudioIntent()) {
                        Text("Stop")
                    }
                    .buttonStyle(.bordered)
                }
            } compactLeading: {
                Image(systemName: glyph(context.state))
            } compactTrailing: {
                Text(context.state.startedAt, style: .timer)
                    .font(.caption2.monospacedDigit())
                    .frame(maxWidth: 44)
            } minimal: {
                Image(systemName: glyph(context.state))
            }
        }
    }

    private func glyph(_ state: BackgroundActivityAttributes.ContentState) -> String {
        state.listening ? "mic.fill" : "speaker.wave.2.fill"
    }

    /// Says what the phone is DOING, not which feature is on -- someone
    /// glancing at a Lock Screen wants "is it hearing me?" answered in one read
    /// (`docs/brand-voice.md`).
    private func headline(_ state: BackgroundActivityAttributes.ContentState) -> String {
        if state.listening && state.playing { return "Hearing you, playing your Mac" }
        if state.listening { return "Hearing you" }
        return "Playing sound from your Mac"
    }
}
#endif
