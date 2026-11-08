import AVFoundation
import AVKit
import UIKit
import VideoToolbox

// Native Picture-in-Picture for the screen mirror
// (prds/active/2026-08-09-*-native-pip.md).
//
// The web <video> can never get automatic PiP: only a native AVPlayerLayer or
// AVSampleBufferDisplayLayer may set canStartPictureInPictureAutomaticallyFrom-
// Inline, so a backgrounding app drops the web mirror inline every time. This
// decodes a second H.264 stream from the Mac into an AVSampleBufferDisplayLayer,
// which does qualify.
//
// Owns NO connection state (ios/CLAUDE.md): frames arrive already-received from
// the web view's socket, via NativeBridge.

@MainActor
final class PipMirror: NSObject {
    static let shared = PipMirror()

    private var displayLayer: AVSampleBufferDisplayLayer?
    private var pipController: AVPictureInPictureController?
    private var formatDescription: CMVideoFormatDescription?
    /// Latest parameter sets, kept because the format description can only be
    /// built once BOTH have been seen, and they arrive as separate NALs.
    private var sps: Data?
    private var pps: Data?
    private var frameIndex: Int64 = 0
    private var receivedFrames = 0
    private var receivedBytes = 0
    private var configuredSize = CGSize(width: 1280, height: 800)
    private var frameRate: Int32 = 20

    private var audioRenderer: AVSampleBufferAudioRenderer?
    private var audioSynchronizer: AVSampleBufferRenderSynchronizer?
    private var audioFormat: CMAudioFormatDescription?
    private var audioSampleRate: Double = 48_000
    private var audioChannels: UInt32 = 2
    /// Sample-clock position of the next AAC packet, in `audioSampleRate` units.
    /// The Mac sends no timestamps, so the renderer's timeline is synthesized
    /// from packet order -- 1024 frames per AAC-LC packet, exactly.
    private var audioSampleIndex: Int64 = 0
    /// Whether the synchronizer's clock has been anchored to a real packet.
    private var audioClockRunning = false
    private var receivedAudioPackets = 0
    private var receivedAudioBytes = 0

    private(set) var isActive = false
    /// Mirrors the PiP button so `pictureInPictureControllerIsPlaybackPaused`
    /// can answer from it -- AVKit asks, it does not remember what it was told.
    private var isPaused = false
    /// Cleared in `streamEnded`. Auto-PiP with this false is a black LIVE window.
    /// Deliberately NOT the same bit as the auto-start flag: the window is
    /// suppressed while the app is on screen, and a live stream must still be
    /// live during that stretch or `didStart` kills the next legitimate window.
    private var streamLive = false

    /// Into the MAC's dev log, not just the device's. The Mac already logs its
    /// own half of this pipe, and a gap is only readable when both ends land on
    /// one timeline -- reading the device log needs a 40s stream and a cable.
    fileprivate func trace(_ text: String) {
        MMLog.pip.info("\(text, privacy: .public)")
        NativeIntentRouter.emit(["type": "nativeLog", "text": "pip: \(text)"])
    }

    /// Mount the layer inside `host`. Deliberately 1x1 and effectively
    /// invisible: the web deck stays the foreground picture, and this exists
    /// only to be a legal PiP source. A zero-size or hidden layer is NOT
    /// eligible -- AVKit refuses to start PiP from one.
    func attach(to host: UIView) {
        guard displayLayer == nil else { return }
        let layer = AVSampleBufferDisplayLayer()
        layer.videoGravity = .resizeAspect
        layer.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        layer.opacity = 0.01
        host.layer.addSublayer(layer)
        displayLayer = layer

        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            trace("unsupported on this device")
            return
        }
        // Built before the ContentSource, because the source captures the
        // renderer -- adding one afterwards leaves PiP with a silent source.
        let renderer = AVSampleBufferAudioRenderer()
        let synchronizer = AVSampleBufferRenderSynchronizer()
        synchronizer.addRenderer(renderer)
        // The video layer keeps its own DisplayImmediately path and does NOT
        // join this timebase. Both streams are live and arrive interleaved off
        // one socket, so packet order already aligns them to within a frame;
        // putting the working picture on a synthesized clock to chase tighter
        // lip-sync on a screen mirror risks the picture for nothing.
        //
        // Rate stays 0 until the FIRST packet. Starting the clock here instead
        // runs the timebase from attach, while packets are stamped from sample
        // index 0 -- every one then arrives with a PTS in the past and the
        // renderer drops it silently (no `renderer.error`, packet counter still
        // climbing, speaker dead). That was the silent-PiP bug.
        audioRenderer = renderer
        audioSynchronizer = synchronizer

        let source = AVPictureInPictureController.ContentSource(
            sampleBufferDisplayLayer: layer,
            playbackDelegate: self
        )
        let controller = AVPictureInPictureController(contentSource: source)
        // Off until `setAutoStart(true)` -- a live layer with this left on is
        // the orphaned black LIVE window after the mirror stops (PRD §7c).
        controller.canStartPictureInPictureAutomaticallyFromInline = false
        // Hides the skip-back/forward buttons. They are drawn for any sample-
        // buffer source and do nothing on a live mirror -- `skipByInterval` has
        // nowhere to seek to. Play/pause is not removable and stays.
        controller.requiresLinearPlayback = true
        controller.delegate = self
        pipController = controller
        trace("layer attached, controller ready")
    }

    func detach() {
        setAutoStart(false)
        pipController?.stopPictureInPicture()
        pipController = nil
        displayLayer?.removeFromSuperlayer()
        displayLayer = nil
        reset()
        if let renderer = audioRenderer { audioSynchronizer?.removeRenderer(renderer, at: .zero) }
        audioRenderer = nil
        audioSynchronizer = nil
    }

    /// Close the floating window, keeping the decoder and its feed alive.
    /// `streamEnded` is the wrong tool for coming back to the app: it flushes
    /// the layer and resets the format description, so the window that opens on
    /// the NEXT backgrounding has no parameter sets and paints black until the
    /// encoder's next periodic keyframe.
    func stopWindow() {
        guard pipController?.isPictureInPictureActive == true else { return }
        trace("stop window (app foreground)")
        pipController?.stopPictureInPicture()
    }

    /// Auto-PiP is legal only while a stream is flowing (PRD §7c), so arming it
    /// also marks the stream live. Armed for the stream's whole life: iOS reads
    /// the flag before the web view sees the hide edge, so arming on
    /// backgrounding is always too late (2026-08-21). Only `streamEnded` clears it.
    func setAutoStart(_ on: Bool) {
        if on { streamLive = true }
        pipController?.canStartPictureInPictureAutomaticallyFromInline = on
        trace("auto=\(on) streamLive=\(streamLive)")
    }

    /// Dimensions from the Mac's `pipStreamConfig`, before the first frame.
    func configure(width: Int, height: Int, frameRate: Int) {
        configuredSize = CGSize(width: width, height: height)
        self.frameRate = Int32(max(1, frameRate))
        trace("configured \(width)x\(height)@\(frameRate)")
    }

    /// Format from the Mac's `pipAudioConfig`, before the first packet. A change
    /// mid-stream (the user re-picking an output device on the Mac) drops the
    /// old format so the next packet rebuilds it, and restarts the sample clock
    /// -- the old index counts in the OLD rate's units.
    func configureAudio(sampleRate: Int, channels: Int) {
        let rate = Double(max(1, sampleRate))
        let count = UInt32(max(1, channels))
        guard rate != audioSampleRate || count != audioChannels || audioFormat == nil else { return }
        audioSampleRate = rate
        audioChannels = count
        audioFormat = nil
        audioSampleIndex = 0
        stopAudioClock()
        audioRenderer?.flush()
        trace("audio configured \(sampleRate)Hz x\(channels)")
    }

    /// One AAC-LC access unit from the Mac -- raw, no ADTS header, exactly what
    /// WebCodecs' `AudioEncoder` emits.
    func handle(audio packet: Data) {
        guard let renderer = audioRenderer, !packet.isEmpty else { return }
        receivedAudioPackets += 1
        receivedAudioBytes += packet.count
        if receivedAudioPackets % 200 == 0 {
            trace("got \(self.receivedAudioPackets) audio packets, \(self.receivedAudioBytes) bytes")
            if let error = renderer.error {
                trace("audio renderer error -- \(error.localizedDescription)")
            }
        }
        guard let sample = makeAudioSampleBuffer(packet: packet) else { return }
        // Dropped rather than queued when the renderer is behind: this is live
        // audio with a synthesized clock, so a packet held back would play late
        // forever after, drifting further from the picture with every stall.
        guard renderer.isReadyForMoreMediaData else { return }
        renderer.enqueue(sample)
        startAudioClockIfNeeded(at: sample)
    }

    /// Anchors the timebase to the first packet actually enqueued. The clock
    /// must not run while the queue is empty: the gap between attach and the
    /// first packet would otherwise be time the renderer has already passed,
    /// putting every packet permanently in the past.
    /// Parks the clock so the next enqueued packet re-anchors it.
    func stopAudioClock() {
        audioClockRunning = false
        audioSynchronizer?.setRate(0.0, time: .zero)
    }

    private func startAudioClockIfNeeded(at sample: CMSampleBuffer) {
        guard !audioClockRunning else { return }
        audioClockRunning = true
        audioSynchronizer?.setRate(1.0, time: CMSampleBufferGetPresentationTimeStamp(sample))
    }

    func streamEnded(reason: String) {
        setAutoStart(false)
        streamLive = false
        trace("stream ended -- \(reason) auto=false")
        // Close the window too, not just the decoder state: a PiP window with no
        // stream behind it sits frozen on the last frame forever.
        pipController?.stopPictureInPicture()
        displayLayer?.flushAndRemoveImage()
        reset()
    }

    private func reset() {
        formatDescription = nil
        sps = nil
        pps = nil
        frameIndex = 0
        receivedFrames = 0
        receivedBytes = 0
        audioFormat = nil
        audioSampleIndex = 0
        receivedAudioPackets = 0
        receivedAudioBytes = 0
        stopAudioClock()
        audioRenderer?.flush()
        isActive = false
        // Or a stream stopped while paused comes back paused, with the Mac
        // encoding into a window that says it is not playing.
        isPaused = false
    }

    /// One Annex-B access unit from the Mac. May hold several NAL units
    /// (SPS+PPS+IDR on a keyframe), so it is split before anything is decoded.
    func handle(frame: Data) {
        guard let layer = displayLayer else { return }
        receivedFrames += 1
        receivedBytes += frame.count
        // Matched against the Mac's own "pip sent" line: equal counts prove the
        // whole base64 bridge, and any gap localises the loss to one side.
        if receivedFrames % 100 == 0 {
            let status = layer.status.rawValue
            trace("got \(self.receivedFrames) frames, \(self.receivedBytes) bytes, layer status \(status)")
            if let error = layer.error {
                trace("layer error -- \(error.localizedDescription)")
            }
        }
        for nal in splitAnnexB(frame) {
            guard let first = nal.first else { continue }
            switch first & 0x1F {
            case 7: sps = nal; formatDescription = nil
            case 8: pps = nal; formatDescription = nil
            case 1, 5:
                guard let sample = makeSampleBuffer(nal: nal, isKeyframe: (first & 0x1F) == 5) else { continue }
                if layer.status == .failed { layer.flush() }
                layer.enqueue(sample)
                if !isActive {
                    isActive = true
                    let size = configuredSize
                    trace("first frame decoded \(Int(size.width))x\(Int(size.height))")
                }
            default: continue
            }
        }
    }

    /// Annex-B carries 3- and 4-byte start codes interchangeably, so both are
    /// scanned for -- an encoder emitting the short form on non-first NALs is
    /// conformant and would otherwise corrupt every payload boundary.
    private func splitAnnexB(_ data: Data) -> [Data] {
        var units: [Data] = []
        var index = data.startIndex
        var unitStart: Int? = nil
        while index < data.endIndex - 2 {
            let isThree = data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1
            let isFour = index < data.endIndex - 3 && data[index] == 0 && data[index + 1] == 0
                && data[index + 2] == 0 && data[index + 3] == 1
            if isThree || isFour {
                if let start = unitStart, start < index {
                    units.append(data.subdata(in: start..<index))
                }
                index += isFour ? 4 : 3
                unitStart = index
            } else {
                index += 1
            }
        }
        if let start = unitStart, start < data.endIndex {
            units.append(data.subdata(in: start..<data.endIndex))
        }
        return units
    }

    private func ensureFormatDescription() -> CMVideoFormatDescription? {
        if let existing = formatDescription { return existing }
        guard let sps, let pps else { return nil }
        var created: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { spsBuffer -> OSStatus in
            pps.withUnsafeBytes { ppsBuffer -> OSStatus in
                guard let spsBase = spsBuffer.bindMemory(to: UInt8.self).baseAddress,
                      let ppsBase = ppsBuffer.bindMemory(to: UInt8.self).baseAddress else {
                    return -1
                }
                let pointers: [UnsafePointer<UInt8>] = [spsBase, ppsBase]
                let sizes: [Int] = [sps.count, pps.count]
                return pointers.withUnsafeBufferPointer { pointerBuffer in
                    sizes.withUnsafeBufferPointer { sizeBuffer in
                        CMVideoFormatDescriptionCreateFromH264ParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: 2,
                            parameterSetPointers: pointerBuffer.baseAddress!,
                            parameterSetSizes: sizeBuffer.baseAddress!,
                            nalUnitHeaderLength: 4,
                            formatDescriptionOut: &created
                        )
                    }
                }
            }
        }
        guard status == noErr else {
            trace("format description failed \(status)")
            return nil
        }
        formatDescription = created
        return created
    }

    /// AAC-LC, built from the configured rate/channels rather than parsed out of
    /// the stream: WebCodecs emits raw AAC with no ADTS header, so there is no
    /// in-band copy of either value to read.
    private func ensureAudioFormatDescription() -> CMAudioFormatDescription? {
        if let existing = audioFormat { return existing }
        var asbd = AudioStreamBasicDescription(
            mSampleRate: audioSampleRate,
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(Self.aacFramesPerPacket),
            mBytesPerFrame: 0,
            mChannelsPerFrame: audioChannels,
            mBitsPerChannel: 0,
            mReserved: 0
        )
        var created: CMAudioFormatDescription?
        let status = CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            asbd: &asbd,
            layoutSize: 0,
            layout: nil,
            magicCookieSize: 0,
            magicCookie: nil,
            extensions: nil,
            formatDescriptionOut: &created
        )
        guard status == noErr else {
            trace("audio format description failed \(status)")
            return nil
        }
        audioFormat = created
        return created
    }

    /// Every AAC-LC packet decodes to exactly this many frames. It is what makes
    /// a timestamp derivable from packet count alone.
    private static let aacFramesPerPacket: Int64 = 1024

    private func makeAudioSampleBuffer(packet: Data) -> CMSampleBuffer? {
        guard let format = ensureAudioFormatDescription() else { return nil }

        var blockBuffer: CMBlockBuffer?
        let bytes = UnsafeMutableRawPointer.allocate(
            byteCount: packet.count,
            alignment: MemoryLayout<UInt8>.alignment
        )
        packet.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: packet.count)
        // Same ownership transfer as the video path: the block buffer frees it.
        let blockStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: bytes,
            blockLength: packet.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: packet.count,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard blockStatus == kCMBlockBufferNoErr, let block = blockBuffer else {
            bytes.deallocate()
            return nil
        }

        var sampleSize = packet.count
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: Self.aacFramesPerPacket, timescale: CMTimeScale(audioSampleRate)),
            presentationTimeStamp: CMTime(value: audioSampleIndex, timescale: CMTimeScale(audioSampleRate)),
            decodeTimeStamp: .invalid
        )
        audioSampleIndex += Self.aacFramesPerPacket

        var sampleBuffer: CMSampleBuffer?
        let sampleStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            formatDescription: format,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard sampleStatus == noErr else { return nil }
        return sampleBuffer
    }

    private func makeSampleBuffer(nal: Data, isKeyframe: Bool) -> CMSampleBuffer? {
        guard let format = ensureFormatDescription() else { return nil }
        // AVCC for the block buffer: the same bytes, but the start code replaced
        // by a big-endian length. CMSampleBuffer has no Annex-B mode.
        var payload = Data()
        var length = UInt32(nal.count).bigEndian
        withUnsafeBytes(of: &length) { payload.append(contentsOf: $0) }
        payload.append(nal)

        var blockBuffer: CMBlockBuffer?
        let mutablePayload = UnsafeMutableRawPointer.allocate(
            byteCount: payload.count,
            alignment: MemoryLayout<UInt8>.alignment
        )
        payload.copyBytes(
            to: mutablePayload.assumingMemoryBound(to: UInt8.self),
            count: payload.count
        )
        // kCFAllocatorDefault as the BLOCK allocator hands ownership of
        // `mutablePayload` to the block buffer -- freeing it here would free it
        // under the decoder.
        let blockStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: mutablePayload,
            blockLength: payload.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: payload.count,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard blockStatus == kCMBlockBufferNoErr, let block = blockBuffer else {
            mutablePayload.deallocate()
            return nil
        }

        var sampleBuffer: CMSampleBuffer?
        var sampleSize = payload.count
        // A synthesized timeline, because the Mac sends no timestamps. PiP needs
        // monotonic times to present at all; it does not need them to match a
        // clock, since this stream is live and never seeks.
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: frameRate),
            presentationTimeStamp: CMTime(value: frameIndex, timescale: frameRate),
            decodeTimeStamp: .invalid
        )
        frameIndex += 1
        let sampleStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            formatDescription: format,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard sampleStatus == noErr, let sample = sampleBuffer else { return nil }
        // Display immediately: the default defers to a master clock this layer
        // has none of, which shows as a black PiP window that never paints.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let entry = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                entry,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
            if !isKeyframe {
                CFDictionarySetValue(
                    entry,
                    Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(),
                    Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
                )
            }
        }
        return sample
    }
}

// Required for a sample-buffer PiP source, unlike the AVPlayerLayer variant.
// The stream is live, so the answers are all "no scrubbing, no end".
extension PipMirror: AVPictureInPictureSampleBufferPlaybackDelegate {
    /// The one PiP button that cannot be hidden, so it is made to mean
    /// something: pausing stops the Mac encoding entirely rather than freezing
    /// a stream that keeps costing both machines. Swift owns no connection
    /// state (ios/CLAUDE.md) -- the page relays this to the Mac.
    nonisolated func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        setPlaying playing: Bool
    ) {
        Task { @MainActor in
            let mirror = PipMirror.shared
            guard mirror.isPaused == !playing else { return }
            mirror.isPaused = !playing
            // The Mac stops encoding on this, so anything already queued would
            // keep playing over a frozen picture. Both sides of the pause rewind
            // to zero together -- the synchronizer's clock and the sample index
            // that stamps incoming packets -- because the silence while paused
            // is never encoded and so occupies no time on this timeline.
            if playing {
                // Left stopped on purpose: the next packet re-anchors the clock
                // to its own timestamp. Starting it here is the attach-time bug
                // again -- the encoder takes a moment to come back, and the
                // clock would spend it running past the packets still to come.
                mirror.audioSampleIndex = 0
                mirror.stopAudioClock()
            } else {
                mirror.stopAudioClock()
                mirror.audioRenderer?.flush()
            }
            mirror.trace(playing ? "resume requested auto=\(mirror.streamLive)" : "pause requested auto=\(mirror.streamLive)")
            NativeIntentRouter.emit(["type": "pipSetPlaying", "playing": playing])
        }
    }

    nonisolated func pictureInPictureControllerTimeRangeForPlayback(
        _ controller: AVPictureInPictureController
    ) -> CMTimeRange {
        // A live stream of indefinite length -- this is what hides the scrubber.
        CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
    }

    nonisolated func pictureInPictureControllerIsPlaybackPaused(
        _ controller: AVPictureInPictureController
    ) -> Bool {
        MainActor.assumeIsolated { PipMirror.shared.isPaused }
    }

    nonisolated func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        didTransitionToRenderSize newRenderSize: CMVideoDimensions
    ) {}

    nonisolated func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        skipByInterval skipInterval: CMTime
    ) async {
        Task { @MainActor in PipMirror.shared.trace("skip \(skipInterval.seconds)s") }
    }
}

extension PipMirror: AVPictureInPictureControllerDelegate {
    nonisolated func pictureInPictureControllerWillStartPictureInPicture(
        _ controller: AVPictureInPictureController
    ) {
        Task { @MainActor in
            let mirror = PipMirror.shared
            mirror.trace("willStart auto=\(mirror.pipController?.canStartPictureInPictureAutomaticallyFromInline ?? false) streamLive=\(mirror.streamLive)")
        }
    }

    nonisolated func pictureInPictureControllerDidStartPictureInPicture(
        _ controller: AVPictureInPictureController
    ) {
        Task { @MainActor in
            let mirror = PipMirror.shared
            let auto = mirror.pipController?.canStartPictureInPictureAutomaticallyFromInline ?? false
            mirror.trace("started auto=\(auto) streamLive=\(mirror.streamLive)")
            guard mirror.streamLive else {
                mirror.trace("started with dead stream -- stopping")
                mirror.setAutoStart(false)
                mirror.pipController?.stopPictureInPicture()
                return
            }
        }
    }

    nonisolated func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {
        let detail = error.localizedDescription
        Task { @MainActor in PipMirror.shared.trace("failed to start -- \(detail)") }
    }

    nonisolated func pictureInPictureControllerWillStopPictureInPicture(
        _ controller: AVPictureInPictureController
    ) {
        Task { @MainActor in PipMirror.shared.trace("willStop") }
    }

    nonisolated func pictureInPictureControllerDidStopPictureInPicture(
        _ controller: AVPictureInPictureController
    ) {
        Task { @MainActor in
            let mirror = PipMirror.shared
            mirror.trace("stopped")
            // AVKit tears the window down asynchronously, so a play() issued
            // when the stop was REQUESTED still races it: WebKit re-pauses the
            // inline element as the window goes away, and it sits on iOS's
            // paused-video play button. This edge is the only moment the page
            // can know the element is free to resume.
            NativeIntentRouter.emit(["type": "pipDidStop"])
        }
    }

    nonisolated func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        Task { @MainActor in PipMirror.shared.trace("restore UI") }
        completionHandler(true)
    }
}
