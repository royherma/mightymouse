// MicRecorder — resident CoreAudio mic helper via AVAudioEngine.
//
// Why this exists: opening the mic costs ~640-1250 ms per PROCESS (dyld +
// engine.inputNode + first HAL start), and the old design spawned a fresh
// process per hotkey press — so every listen lost its first word. Measured
// 2026-08-29: a resident engine that
// is built + prepare()d once restarts in ~180 ms to first buffer, with the
// HAL idle (no orange mic dot) between sessions. This binary is the mic path
// only; screen-recording still uses ffmpeg.
//
// Contract with the Node side (native-mic.ts) — one line per command on stdin:
//   start <wav path>   create/overwrite the WAV, start the engine, print "READY"
//   stop               stop the engine, finalize the WAV header, print "STOPPED"
//   cancel             stop the engine, close the file unfinalized, print "CANCELLED"
//   EOF / SIGINT / SIGTERM   stop everything and exit 0 (parent went away)
//
// Output format: 16 kHz, mono, 16-bit PCM WAV — exactly what whisper.cpp
// expects and what the ffmpeg path produced with -ac 1 -ar 16000 pcm_s16le.

import AVFoundation
import Foundation

// MARK: - WAV header helpers

/// Write a RIFF WAV header for 16-bit mono PCM.
/// Caller must patch the byte-count fields once they know the final size.
func writeWavHeader(to fh: FileHandle, sampleRate: Int32, channels: Int16, bitsPerSample: Int16) {
    let dataChunkSize: Int32 = 0 // placeholder; patched on finalize
    let byteRate: Int32 = sampleRate * Int32(channels) * Int32(bitsPerSample) / 8
    let blockAlign: Int16 = channels * bitsPerSample / 8
    let riffChunkSize: Int32 = 36 + dataChunkSize // placeholder

    var header = Data()
    func append(_ s: String) { header.append(contentsOf: s.utf8) }
    func append32(_ v: Int32) {
        var le = v.littleEndian
        withUnsafeBytes(of: &le) { header.append(contentsOf: $0) }
    }
    func append16(_ v: Int16) {
        var le = v.littleEndian
        withUnsafeBytes(of: &le) { header.append(contentsOf: $0) }
    }

    append("RIFF"); append32(riffChunkSize)
    append("WAVE")
    append("fmt "); append32(16)   // subchunk1 size for PCM
    append16(1)                    // PCM format
    append16(channels)
    append32(sampleRate)
    append32(byteRate)
    append16(blockAlign)
    append16(bitsPerSample)
    append("data"); append32(dataChunkSize)

    fh.write(header)
}

/// Patch the RIFF and data chunk sizes after recording ends.
func finalizeWavHeader(fh: FileHandle, dataByteCount: Int) {
    let dataSize = Int32(dataByteCount)
    let riffSize = Int32(36 + dataByteCount)

    // RIFF chunk size at byte 4
    fh.seek(toFileOffset: 4)
    var le = riffSize.littleEndian
    withUnsafeBytes(of: &le) { fh.write(Data($0)) }

    // data chunk size at byte 40
    fh.seek(toFileOffset: 40)
    var le2 = dataSize.littleEndian
    withUnsafeBytes(of: &le2) { fh.write(Data($0)) }
}

// MARK: - Main

// Target format: 16 kHz, mono, 16-bit signed integer PCM.
// AVAudioConverter resamples from the hardware rate (44.1k or 48k) down.
let targetSampleRate: Double = 16_000
let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: targetSampleRate,
    channels: 1,
    interleaved: true
)!

// Built ONCE for the life of the process — this is the whole point (see header).
let engine = AVAudioEngine()
let inputNode = engine.inputNode
let hwFormat = inputNode.outputFormat(forBus: 0) // actual device format

guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
    fputs("mic-recorder: failed to create AVAudioConverter\n", stderr)
    exit(1)
}

// Session state: non-nil only while a `start` is in flight. The tap only
// writes when a file is open, so the engine can sit prepared-but-stopped idle.
var fileHandle: FileHandle? = nil
var totalBytesWritten = 0
let writeLock = NSLock()

// Buffer size for the tap: 1024 frames at hardware rate.
// Small enough for low latency, large enough to amortize overhead.
let tapBufferSize: AVAudioFrameCount = 1024

inputNode.installTap(onBus: 0, bufferSize: tapBufferSize, format: hwFormat) { hwBuffer, _ in
    let inputFrames = AVAudioFrameCount(hwBuffer.frameLength)
    let outputFrames = AVAudioFrameCount(
        ceil(Double(inputFrames) * targetSampleRate / hwFormat.sampleRate)
    )
    guard outputFrames > 0 else { return }

    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrames) else {
        return
    }

    var inputConsumed = false
    let status = converter.convert(to: outBuffer, error: nil) { _, outStatus in
        if inputConsumed {
            outStatus.pointee = .noDataNow
            return nil
        }
        inputConsumed = true
        outStatus.pointee = .haveData
        return hwBuffer
    }

    guard status != .error, outBuffer.frameLength > 0 else { return }

    let frameCount = Int(outBuffer.frameLength)
    let byteCount = frameCount * 2 // 16-bit = 2 bytes per sample
    guard let int16Ptr = outBuffer.int16ChannelData?[0] else { return }
    let data = Data(bytes: int16Ptr, count: byteCount)

    writeLock.lock()
    if let fh = fileHandle {
        fh.write(data)
        totalBytesWritten += byteCount
    }
    writeLock.unlock()
}

// Pre-allocates the render resources so start() is only the HAL device start.
engine.prepare()

func reply(_ s: String) {
    print(s)
    fflush(stdout)
}

func startSession(path: String) {
    writeLock.lock()
    let busy = fileHandle != nil
    writeLock.unlock()
    if busy {
        fputs("mic-recorder: start while already recording\n", stderr)
        reply("ERROR busy")
        return
    }

    FileManager.default.createFile(atPath: path, contents: nil)
    guard let fh = FileHandle(forWritingAtPath: path) else {
        fputs("mic-recorder: cannot open output path: \(path)\n", stderr)
        reply("ERROR open")
        return
    }
    writeWavHeader(to: fh, sampleRate: Int32(targetSampleRate), channels: 1, bitsPerSample: 16)

    writeLock.lock()
    fileHandle = fh
    totalBytesWritten = 0
    writeLock.unlock()

    do {
        try engine.start()
    } catch {
        fputs("mic-recorder: engine start failed: \(error)\n", stderr)
        writeLock.lock()
        fileHandle = nil
        writeLock.unlock()
        fh.closeFile()
        reply("ERROR start")
        return
    }
    reply("READY")
}

/// Stop the engine and close the file. `finalize` patches the WAV header;
/// cancel skips it because the caller is about to delete the file.
func endSession(finalize: Bool) -> Bool {
    engine.stop()
    writeLock.lock()
    let fh = fileHandle
    let bytes = totalBytesWritten
    fileHandle = nil
    writeLock.unlock()
    guard let handle = fh else { return false }
    if finalize { finalizeWavHeader(fh: handle, dataByteCount: bytes) }
    handle.closeFile()
    return true
}

// SIGINT/SIGTERM (parent crashed or old-style kill): finalize and exit.
// Swift's @convention(c) signal handlers cannot capture context, so we use
// DispatchSource signal watchers on their own queue.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigQueue = DispatchQueue(label: "mic-recorder.signals")
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: sigQueue)
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
let signalHandler = {
    _ = endSession(finalize: true)
    exit(0)
}
sigintSource.setEventHandler(handler: signalHandler)
sigtermSource.setEventHandler(handler: signalHandler)
sigintSource.resume()
sigtermSource.resume()

// Command loop. readLine() returns nil on EOF — the parent is gone, so stop.
while let line = readLine() {
    if line.hasPrefix("start ") {
        startSession(path: String(line.dropFirst("start ".count)))
    } else if line == "stop" {
        reply(endSession(finalize: true) ? "STOPPED" : "ERROR idle")
    } else if line == "cancel" {
        _ = endSession(finalize: false)
        reply("CANCELLED")
    } else if !line.isEmpty {
        reply("ERROR unknown")
    }
}
_ = endSession(finalize: true)
exit(0)
