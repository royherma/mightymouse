// SystemAudio — macOS system audio capture via ScreenCaptureKit.
//
// Why this exists: Electron/Chromium implements getDisplayMedia's system-audio
// capture on Windows and ChromeOS only. On macOS `audio: true` silently yields
// no audio track — Apple gates system audio behind ScreenCaptureKit, which
// Chromium doesn't surface through that API. So the phone-remote screen mirror
// captures
// audio here natively and injects it into the existing RTCPeerConnection.
//
// Permission: this rides the SAME Screen Recording (TCC) grant the video mirror
// already holds — verified by probe before this was written: 157 audio buffers
// in 3s with peak 0.207 while a sound played, and zero new permission prompts.
// No new entitlement, no new dialog.
//
// Contract with the Node side (src/main/capture/system-audio.ts):
//   stdout  — "READY\n" once the stream is live, then RAW PCM BYTES forever.
//             Nothing else is ever written to stdout; diagnostics go to stderr,
//             or the Node side would parse log text as audio samples.
//   format  — float32 interleaved, 48 kHz, 2ch (see PCM_* constants below;
//             mirrored in CONFIG.PHONE_REMOTE so both ends agree on one number).
//   signal  — SIGINT/SIGTERM to stop; we stop the capture and exit 0.
//
// This is a TAP, not a redirect: the Mac keeps playing out its own speakers and
// the phone receives a copy. A redirect would need a virtual output device and
// would silence the Mac for everyone else in the room.

import AVFoundation
import Foundation
import ScreenCaptureKit

// Wire format. Must match CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_* on the TS side —
// the Node/renderer end can't infer these from the byte stream.
let PCM_SAMPLE_RATE = 48_000
let PCM_CHANNELS = 2

// SCK requires a video configuration even for an audio-only stream. Keep it
// minimally small: we never read the video frames, and a 2x2 surface at 1fps
// costs essentially nothing versus capturing the real display twice (the video
// mirror already has its own getDisplayMedia stream).
let DUMMY_VIDEO_SIDE = 2
let DUMMY_VIDEO_FPS: Int32 = 1

/// Serializes writes to stdout. The SCK sample handler runs on its own queue,
/// so without this two buffers could interleave mid-write and corrupt frames.
let stdoutLock = NSLock()

/// Gates PCM until the READY line has been written. SCK starts delivering
/// audio buffers BEFORE startCapture() returns — measured: ~15 KB of PCM
/// arrived ahead of READY. Those early bytes would land in front of the
/// header, so the Node side's "find READY, treat the rest as audio" parse
/// would either miss the header entirely or resync mid-frame (a frame is 8
/// bytes; a split at any other offset swaps the channels for the rest of the
/// session). Dropping the pre-READY buffers costs a few ms of audio nobody
/// is listening to yet and keeps the stream frame-aligned.
var readySent = false

func writeStdout(_ data: Data) {
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    guard readySent else { return }
    // FileHandle.write can raise on EPIPE (Node side died). Exit quietly in
    // that case — a dead parent means our job is over, and a crash log here
    // would be noise, not signal.
    FileHandle.standardOutput.write(data)
}

/// Write the READY line and open the PCM gate, atomically against the sample
/// handler's writes so no audio can slip in front of the header.
func markReady() {
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    FileHandle.standardOutput.write(Data("READY\n".utf8))
    readySent = true
}

func logErr(_ s: String) {
    fputs("system-audio: \(s)\n", stderr)
}

@available(macOS 13.0, *)
final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }

        // withAudioBufferList gives a view over the sample's channel buffers.
        // SCK hands us NON-interleaved float32 (one buffer per channel); the
        // Web Audio side wants interleaved, so we weave here rather than
        // shipping a second format the TS end would have to know about.
        _ = try? sb.withAudioBufferList(blockBufferMemoryAllocator: nil) { abl, _ -> Int in
            let buffers = Array(abl)
            guard !buffers.isEmpty else { return 0 }

            let bytesPerSample = MemoryLayout<Float>.size
            let framesPerBuffer = Int(buffers[0].mDataByteSize) / bytesPerSample
            guard framesPerBuffer > 0 else { return 0 }

            // Channel pointers, padded to PCM_CHANNELS. A mono source is
            // duplicated across both output channels rather than dropped, so
            // the phone never plays one-sided audio.
            var channelPtrs: [UnsafePointer<Float>?] = []
            for i in 0..<PCM_CHANNELS {
                let src = i < buffers.count ? buffers[i] : buffers[0]
                channelPtrs.append(src.mData?.assumingMemoryBound(to: Float.self))
            }

            var interleaved = [Float](repeating: 0, count: framesPerBuffer * PCM_CHANNELS)
            for frame in 0..<framesPerBuffer {
                for ch in 0..<PCM_CHANNELS {
                    guard let p = channelPtrs[ch] else { continue }
                    interleaved[frame * PCM_CHANNELS + ch] = p[frame]
                }
            }

            interleaved.withUnsafeBufferPointer { buf in
                writeStdout(Data(buffer: buf))
            }
            return framesPerBuffer
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("stream stopped with error: \(error)")
        exit(1)
    }
}

guard #available(macOS 13.0, *) else {
    // Exit code 2 is the Node side's signal for "this Mac can't do it" (vs a
    // generic failure), so the phone can say "not supported" instead of
    // showing a dead toggle. See system-audio.ts EXIT_UNSUPPORTED.
    logErr("ScreenCaptureKit requires macOS 13 or later")
    exit(2)
}

let tap = AudioTap()
var activeStream: SCStream?

// Signals: DispatchSource rather than a C signal handler, since Swift's
// @convention(c) handlers can't capture context. Same pattern as
// native/mic-recorder/MicRecorder.swift.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigQueue = DispatchQueue(label: "system-audio.signals")
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: sigQueue)
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
let stopHandler = {
    // Best-effort stop; we're exiting either way and a hung stopCapture must
    // not keep the process alive after the parent asked it to go.
    if let s = activeStream { Task { try? await s.stopCapture() } }
    exit(0)
}
sigintSource.setEventHandler(handler: stopHandler)
sigtermSource.setEventHandler(handler: stopHandler)
sigintSource.resume()
sigtermSource.resume()

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )
        guard let display = content.displays.first else {
            logErr("no display available")
            exit(1)
        }

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        // Without this, MightyMouse's own output (including audio arriving back
        // from any playback we do) would be re-captured and fed to the phone —
        // a feedback loop.
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = PCM_SAMPLE_RATE
        cfg.channelCount = PCM_CHANNELS
        cfg.width = DUMMY_VIDEO_SIDE
        cfg.height = DUMMY_VIDEO_SIDE
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: DUMMY_VIDEO_FPS)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: tap)
        try stream.addStreamOutput(tap, type: .audio, sampleHandlerQueue: DispatchQueue(label: "system-audio.tap"))
        try await stream.startCapture()
        activeStream = stream

        // READY must be the FIRST thing on stdout — everything after it is raw
        // audio as far as the Node side is concerned. markReady() takes the
        // same lock the sample handler uses, so no buffer can land in front.
        markReady()
    } catch {
        logErr("start failed: \(error)")
        exit(1)
    }
}

// Park the main thread; the capture and signal handlers run on their own queues.
dispatchMain()
