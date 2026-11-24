import AVFoundation
import Speech
import WebKit

enum KeyboardHandoff {
    static let scheme = "mightymouse"
    static let host = "keyboard"
    static let dictatePath = "/dictate"
    static let finishPath = "/finish"

    private static let textKey = "mm.keyboard.text"
    private static let textAtKey = "mm.keyboard.textAt"
    private static let audioKey = "mm.keyboard.audio"
    private static let maxAge: TimeInterval = 10 * 60

    static func url(_ path: String = "") -> URL {
        URL(string: "\(scheme)://\(host)\(path)")!
    }

    static func handOff(text: String) {
        SharedAppGroup.defaults.set(text, forKey: textKey)
        SharedAppGroup.defaults.set(Date().timeIntervalSince1970, forKey: textAtKey)
    }

    static func takeText() -> String? {
        let defaults = SharedAppGroup.defaults
        guard let text = defaults.string(forKey: textKey) else { return nil }
        let at = defaults.double(forKey: textAtKey)
        defaults.removeObject(forKey: textKey)
        defaults.removeObject(forKey: textAtKey)
        guard Date().timeIntervalSince1970 - at < maxAge else { return nil }
        return text
    }

    static func saveAudio(_ samples: [Int16]) -> Bool {
        guard let url = audioFileURL else { return false }
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        guard (try? data.write(to: url, options: .atomic)) != nil else { return false }
        SharedAppGroup.defaults.set(Date().timeIntervalSince1970, forKey: audioKey)
        return true
    }

    static func takeAudio() -> [Int16]? {
        guard let url = audioFileURL else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }
        let at = SharedAppGroup.defaults.double(forKey: audioKey)
        SharedAppGroup.defaults.removeObject(forKey: audioKey)
        guard Date().timeIntervalSince1970 - at < maxAge, let data = try? Data(contentsOf: url) else { return nil }
        return data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    private static var audioFileURL: URL? {
        SharedAppGroup.keyboardDirectory?.appendingPathComponent("pending.pcm")
    }
}

@MainActor
final class WebMic: NSObject {
    enum Failure: String {
        case timedOut
        case blocked
        case busy
        case pageGone
    }

    static let sampleRate: Double = 16_000
    static let maxSeconds: Double = 300
    // Past this the start is treated as blocked and the caller falls back to the app.
    private static let startTimeout: TimeInterval = 2

    let webView: WKWebView
    var onStarted: (() -> Void)?
    var onFailed: ((Failure) -> Void)?
    var onLevel: ((Float) -> Void)?
    var onCapReached: (() -> Void)?
    var onChunk: (([Int16]) -> Void)?

    private(set) var isRecording = false
    private var isReady = false
    private var wantsStart = false
    private var samples: [Int16] = []
    private var startTimer: Timer?
    private var stopContinuation: CheckedContinuation<[Int16], Never>?

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 2, height: 2), configuration: config)
        super.init()
        config.userContentController.add(WeakMessageHandler(self), name: "mic")
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isUserInteractionEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.alpha = 0.02
    }

    func preload() {
        guard !isReady, !webView.isLoading else { return }
        webView.loadHTMLString(Self.page, baseURL: URL(string: "https://keyboard.getmightymouse.com/"))
    }

    func start() {
        guard !isRecording, startTimer == nil else { return }
        samples.removeAll(keepingCapacity: true)
        wantsStart = true
        startTimer = Timer.scheduledTimer(withTimeInterval: Self.startTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.fail(.timedOut) }
        }
        if isReady { webView.evaluateJavaScript("mmStart()") } else { preload() }
    }

    func stop() async -> [Int16] {
        guard isRecording else {
            cancel()
            return []
        }
        isRecording = false
        return await withCheckedContinuation { continuation in
            stopContinuation = continuation
            webView.evaluateJavaScript("mmStop()")
            Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.finishStop() }
            }
        }
    }

    func cancel() {
        wantsStart = false
        isRecording = false
        startTimer?.invalidate()
        startTimer = nil
        if isReady { webView.evaluateJavaScript("mmStop()") }
        samples.removeAll()
        finishStop()
    }

    private func finishStop() {
        guard let continuation = stopContinuation else { return }
        stopContinuation = nil
        continuation.resume(returning: Self.normalized(samples))
        samples.removeAll()
    }

    private func fail(_ failure: Failure) {
        guard wantsStart || isRecording else { return }
        cancel()
        onFailed?(failure)
    }

    fileprivate func handle(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "ready":
            isReady = true
            if wantsStart, !isRecording { webView.evaluateJavaScript("mmStart()") }
        case "started":
            guard wantsStart else {
                webView.evaluateJavaScript("mmStop()")
                return
            }
            wantsStart = false
            startTimer?.invalidate()
            startTimer = nil
            isRecording = true
            onStarted?()
        case "chunk":
            guard isRecording || stopContinuation != nil,
                  let b64 = body["data"] as? String, let data = Data(base64Encoded: b64) else { return }
            let chunk = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
            samples.append(contentsOf: chunk)
            onChunk?(chunk)
            if let level = body["level"] as? Double { onLevel?(Float(level)) }
            if isRecording, Double(samples.count) >= Self.maxSeconds * Self.sampleRate { onCapReached?() }
        case "stopped":
            finishStop()
        case "failed":
            let reason = body["reason"] as? String ?? ""
            fail(reason == "NotReadableError" || reason == "AbortError" ? .busy : .blocked)
        default:
            break
        }
    }

    // iOS's auto gain doesn't reach the page, so quiet speech is lifted to a usable level.
    private static func normalized(_ input: [Int16]) -> [Int16] {
        guard let peak = input.lazy.map({ abs(Int32($0)) }).max(), peak > 0 else { return input }
        let gain = min(8.0, 0.9 * 32_767.0 / Double(peak))
        guard gain > 1.05 else { return input }
        return input.map { Int16(clamping: Int(Double($0) * gain)) }
    }

    private static let page = """
    <!doctype html><html><head><meta charset="utf-8"></head><body><script>
    let ctx = null, stream = null, src = null, node = null, running = false;
    const post = (m) => window.webkit.messageHandlers.mic.postMessage(m);
    function toB64(int16) {
      const bytes = new Uint8Array(int16.buffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    async function mmStart() {
      if (running) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        ctx = new AudioContext();
        await ctx.resume();
        src = ctx.createMediaStreamSource(stream);
        node = ctx.createScriptProcessor(4096, 1, 1);
        const ratio = ctx.sampleRate / 16000;
        let carry = 0;
        node.onaudioprocess = (e) => {
          if (!running) return;
          const input = e.inputBuffer.getChannelData(0);
          const count = Math.floor((input.length - carry) / ratio);
          if (count <= 0) { carry -= input.length; return; }
          const out = new Int16Array(count);
          let peak = 0;
          for (let i = 0; i < count; i++) {
            const from = Math.floor(carry + i * ratio), to = Math.min(input.length, Math.floor(carry + (i + 1) * ratio));
            let sum = 0;
            for (let j = from; j < to; j++) sum += input[j];
            const v = Math.max(-1, Math.min(1, sum / Math.max(1, to - from)));
            peak = Math.max(peak, Math.abs(v));
            out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
          }
          carry = carry + count * ratio - input.length;
          post({ type: "chunk", data: toB64(out), level: peak });
        };
        src.connect(node);
        node.connect(ctx.destination);
        running = true;
        post({ type: "started" });
      } catch (err) {
        teardown();
        post({ type: "failed", reason: String((err && err.name) || err) });
      }
    }
    function teardown() {
      running = false;
      try { if (node) node.disconnect(); if (src) src.disconnect(); } catch (_) {}
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close();
      ctx = stream = src = node = null;
    }
    function mmStop() { const was = running || stream; teardown(); if (was) post({ type: "stopped" }); }
    post({ type: "ready" });
    </script></body></html>
    """
}

extension WebMic: WKUIDelegate, WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(type == .microphone ? .grant : .deny)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        isReady = false
        if wantsStart || isRecording { fail(.pageGone) }
        preload()
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebMic?

    init(_ target: WebMic) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        MainActor.assumeIsolated { target?.handle(body) }
    }
}

enum SpeechToText {
    enum Failure: Error {
        case notAllowed
        case unavailable
        case heardNothing
        case failed
    }

    static var isAllowed: Bool { SFSpeechRecognizer.authorizationStatus() == .authorized }

    static func requestPermission() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default: return false
        }
    }

    static func transcribe(_ samples: [Int16]) async -> Result<String, Failure> {
        guard samples.count > Int(WebMic.sampleRate / 4) else { return .failure(.heardNothing) }
        guard await requestPermission() else { return .failure(.notAllowed) }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable,
              let buffer = pcmBuffer(samples) else { return .failure(.unavailable) }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        request.append(buffer)
        request.endAudio()

        let text: String? = await withCheckedContinuation { continuation in
            let lock = NSLock()
            var resumed = false
            var task: SFSpeechRecognitionTask?
            let finish: (String?) -> Void = { value in
                lock.lock()
                let first = !resumed
                resumed = true
                lock.unlock()
                guard first else { return }
                task?.cancel()
                continuation.resume(returning: value)
            }
            task = recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    finish(result.bestTranscription.formattedString)
                } else if error != nil {
                    finish(result?.bestTranscription.formattedString)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { finish(nil) }
        }
        guard let text else { return .failure(.failed) }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .failure(.heardNothing) : .success(trimmed)
    }

    private static func pcmBuffer(_ samples: [Int16]) -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: WebMic.sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        for (i, sample) in samples.enumerated() { channel[i] = Float(sample) / 32_768 }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        return buffer
    }
}

@MainActor
final class LiveTranscriber {
    var onPartial: ((String) -> Void)?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var committed = ""
    private var segment = ""
    private var lastCommitted = ""
    private var restarts = 0
    private var finishing = false
    private var finalText: String??
    private var waiter: CheckedContinuation<String?, Never>?
    private var peak: Float = 0.05

    private var latest: String {
        [committed, segment].filter { !$0.isEmpty }.joined(separator: " ")
    }

    func start() -> Bool {
        guard SpeechToText.isAllowed,
              let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else { return false }
        self.recognizer = recognizer
        beginSegment()
        return true
    }

    private func beginSegment() {
        guard let recognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let segmentEnded = result?.speechRecognitionMetadata != nil
            let failed = error != nil
            DispatchQueue.main.async {
                guard let self, self.request === request else { return }
                if let text, !text.isEmpty { self.take(text) }
                if segmentEnded || isFinal || failed { self.commitSegment() }
                guard isFinal || failed else { return }
                if self.finishing || self.restarts >= 40 || (failed && self.latest.isEmpty) {
                    self.resolve(self.latest.isEmpty ? nil : self.latest)
                } else {
                    self.restarts += 1
                    self.beginSegment()
                }
            }
        }
    }

    // iOS restarts formattedString after a pause, so each result may hold only the newest phrase.
    private func take(_ text: String) {
        var text = text
        if !lastCommitted.isEmpty, text.lowercased().hasPrefix(lastCommitted.lowercased()) {
            text = String(text.dropFirst(lastCommitted.count)).trimmingCharacters(in: .whitespaces)
        } else {
            lastCommitted = ""
            if Self.looksRestarted(from: segment, to: text) { commitSegment() }
        }
        guard !text.isEmpty else { return }
        segment = text
        onPartial?(latest)
    }

    private func commitSegment() {
        guard !segment.isEmpty else { return }
        committed = latest
        lastCommitted = segment
        segment = ""
    }

    private static func looksRestarted(from old: String, to new: String) -> Bool {
        guard old.count >= 8, new.count < old.count / 2 else { return false }
        let firstWord: (String) -> String = { $0.split(separator: " ").first.map { $0.lowercased() } ?? "" }
        return firstWord(old) != firstWord(new)
    }

    func append(_ samples: [Int16]) {
        guard let request, !samples.isEmpty,
              let format = AVAudioFormat(standardFormatWithSampleRate: WebMic.sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return }
        let chunkPeak = samples.lazy.map { abs(Float($0)) / 32_768 }.max() ?? 0
        peak = max(chunkPeak, peak * 0.97, 0.02)
        let gain = min(8, 0.6 / peak)
        for (i, sample) in samples.enumerated() { channel[i] = max(-1, min(1, Float(sample) / 32_768 * gain)) }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        request.append(buffer)
    }

    func finish() async -> String? {
        if let finalText { return finalText }
        finishing = true
        request?.endAudio()
        return await withCheckedContinuation { continuation in
            waiter = continuation
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self else { return }
                self.resolve(self.latest.isEmpty ? nil : self.latest)
            }
        }
    }

    func cancel() {
        finishing = true
        task?.cancel()
        request = nil
        resolve(nil)
    }

    private func resolve(_ text: String?) {
        if finalText == nil { finalText = .some(text) }
        waiter?.resume(returning: text)
        waiter = nil
    }
}
