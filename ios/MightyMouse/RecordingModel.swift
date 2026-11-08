import Foundation
import SwiftUI

/// Flushes `RecordingQueue` to the Mac through `NativeBridge` once a WebView
/// exists. Owns no connection state itself (`ios/CLAUDE.md`) -- it only asks
/// `NativeIntentRouter.isConnected` before each send and waits for the Mac's
/// own delivery ack.
///
/// Deliberately does NOT record. Capture belongs to `AudioCapture`, which the
/// deck drives as its microphone -- the deck stays the ONE recorder in the
/// product sense (its button, its HUD, its Stop). A recorder that ran beside
/// the deck rather than under it shipped a stop-bar the page knew nothing about.
@MainActor
final class RecordingModel: ObservableObject {
    /// Mirrors `CONFIG.PHONE_REMOTE.MIN_RECORDING_MS` (`src/shared/config.ts`) --
    /// hand-kept in sync like `maxAudioBytes` below. It sat at 500 while both TS
    /// copies said 300, so a 300-499ms clip was kept on web and discarded here.
    static let minRecordingMs = 300

    /// Mirrors `CONFIG.PHONE_REMOTE.MAX_AUDIO_BYTES` (`src/shared/config.ts`) --
    /// TS constants aren't importable into Swift, so this is hand-kept in sync.
    static let maxAudioBytes = 48 * 1024 * 1024

    @Published private(set) var flushing = false
    @Published var oversizeClipMessage: String?

    private var deliveryWaiter: ((Bool) -> Void)?
    private var inFlightClipId: String?

    /// Called on launch and every foreground. Recording itself is the deck's
    /// job now (`AppModel.drainArmedRecording`) -- this only drains clips the
    /// phone captured while it had no live socket to send them over.
    func handleForeground() {
        flushQueue()
    }

    /// Sends exactly one clip's meta+blob pair at a time -- `server.ts:1240`
    /// resets its pending-meta buffer before the async handler runs, so two
    /// clips in flight together would corrupt each other's destination.
    /// Re-entrant calls collapse into the in-flight run via `flushing`.
    func flushQueue() {
        guard !flushing else { return }
        guard NativeIntentRouter.isConnected else { return }
        let clips = RecordingQueue.all()
        guard !clips.isEmpty else { return }
        flushing = true
        Task { [weak self] in
            await self?.drain(clips)
            self?.flushing = false
        }
    }

    private func drain(_ clips: [QueuedClip]) async {
        for clip in clips {
            guard NativeIntentRouter.isConnected else { return }
            guard let audio = try? Data(contentsOf: RecordingQueue.fileURL(for: clip)) else {
                RecordingQueue.remove(clip.id)
                continue
            }
            // Checked here too, matching App.tsx's own sendClip guard: the phone
            // that recorded it can say something specific instead of pushing
            // megabytes up a slow link to be dropped at the far end.
            guard audio.count <= Self.maxAudioBytes else {
                oversizeClipMessage = "That recording is too long to send"
                RecordingQueue.remove(clip.id)
                continue
            }
            let delivered = await sendAndAwaitDelivery(clip, audio: audio)
            if delivered { RecordingQueue.remove(clip.id) } else { return }
        }
    }

    /// One in-flight waiter at a time, matching the one-clip-at-a-time send
    /// above -- `didDeliver` resolves whichever waiter is current, so a stale
    /// ack from a cancelled attempt can never resolve the wrong clip.
    private func sendAndAwaitDelivery(_ clip: QueuedClip, audio: Data) async -> Bool {
        await withCheckedContinuation { continuation in
            inFlightClipId = clip.id
            deliveryWaiter = { [weak self] delivered in
                self?.inFlightClipId = nil
                continuation.resume(returning: delivered)
            }
            var payload: [String: Any] = [
                "type": "queuedClip",
                "clipId": clip.id,
                "durationMs": clip.durationMs,
                "to": clip.to.rawValue,
                "audioBase64": audio.base64EncodedString(),
                // Absent on entries queued before this shipped, which decode as
                // nil -- treat those as live, the behavior they already had.
                "macAway": clip.macAway ?? false
            ]
            // Omitted rather than sent empty when recognition never ran, so the
            // Mac can tell "the phone heard nothing" from "the phone didn't try".
            if let phoneText = clip.phoneText { payload["phoneText"] = phoneText }
            NativeIntentRouter.emit(payload)
        }
    }

    /// `NativeBridge` calls this on `clipDelivered`. A mismatched id means the
    /// ack belongs to a clip this run already gave up on -- ignore it rather
    /// than resolving the current waiter early.
    func didDeliver(clipId: String) {
        guard clipId == inFlightClipId else { return }
        deliveryWaiter?(true)
    }
}
