import AVFoundation
import SwiftUI
import UIKit
import WebKit

enum KeyboardCompanionMode: String, Identifiable {
    case setup
    case dictate
    case finish

    var id: String { rawValue }

    init?(url: URL) {
        guard url.scheme == KeyboardHandoff.scheme, url.host == KeyboardHandoff.host else { return nil }
        switch url.path {
        case KeyboardHandoff.dictatePath: self = .dictate
        case KeyboardHandoff.finishPath: self = .finish
        default: self = .setup
        }
    }
}

@MainActor
final class KeyboardCompanionModel: ObservableObject {
    enum Step: Equatable {
        case setup
        case starting
        case listening
        case writing
        case done(String)
        case failed(String)
    }

    @Published private(set) var step: Step
    @Published private(set) var micAllowed = AVAudioApplication.shared.recordPermission == .granted
    @Published private(set) var speechAllowed = SpeechToText.isAllowed
    let mic = WebMic()
    private let mode: KeyboardCompanionMode

    init(mode: KeyboardCompanionMode) {
        self.mode = mode
        step = mode == .setup ? .setup : .writing
        mic.onStarted = { [weak self] in self?.step = .listening }
        mic.onFailed = { [weak self] _ in
            self?.step = .failed("The mic didn't start. Check that MightyMouse can use the microphone in Settings.")
        }
        mic.onCapReached = { [weak self] in self?.finish() }
    }

    func begin() {
        switch mode {
        case .setup: refresh()
        case .dictate: listen()
        case .finish: writeOut(KeyboardHandoff.takeAudio())
        }
    }

    func refresh() {
        micAllowed = AVAudioApplication.shared.recordPermission == .granted
        speechAllowed = SpeechToText.isAllowed
    }

    func allowAll() {
        AudioCapture.shared.requestPermission { [weak self] _ in
            Task { @MainActor in
                _ = await SpeechToText.requestPermission()
                self?.refresh()
            }
        }
    }

    func listen() {
        guard AVAudioApplication.shared.recordPermission == .granted else {
            AudioCapture.shared.requestPermission { [weak self] granted in
                guard let self else { return }
                if granted { self.listen() } else {
                    self.step = .failed("MightyMouse needs the microphone to hear you. Turn it on in Settings.")
                }
            }
            return
        }
        step = .starting
        mic.preload()
        mic.start()
    }

    func finish() {
        guard step == .listening else { return }
        step = .writing
        Task { @MainActor in writeOut(await mic.stop()) }
    }

    func cancel() { mic.cancel() }

    private func writeOut(_ samples: [Int16]?) {
        guard let samples else {
            step = .failed("Nothing to finish here. Go back and tap the mic again.")
            return
        }
        step = .writing
        Task { @MainActor in
            switch await SpeechToText.transcribe(samples) {
            case let .success(text):
                KeyboardHandoff.handOff(text: text)
                step = .done(text)
            case .failure(.heardNothing):
                step = .failed("Didn't catch that. Try again a little closer to the phone.")
            case .failure(.notAllowed):
                step = .failed("Turn on Speech Recognition for MightyMouse in Settings, then try again.")
            case .failure:
                step = .failed("Couldn't write that out. Try again.")
            }
        }
    }
}

struct KeyboardCompanionView: View {
    @StateObject private var model: KeyboardCompanionModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    init(mode: KeyboardCompanionMode) {
        _model = StateObject(wrappedValue: KeyboardCompanionModel(mode: mode))
    }

    var body: some View {
        MMScreen {
            VStack(alignment: .leading, spacing: MMSpace.five) {
                HStack {
                    Spacer()
                    Button { model.cancel(); dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: MMFont.lg, weight: .semibold))
                            .foregroundStyle(MMColor.muted)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Close")
                }
                content
            }
        }
        .background(HiddenMic(webView: model.mic.webView).frame(width: 2, height: 2))
        .onAppear { model.begin() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.refresh() } }
        .onDisappear { model.cancel() }
    }

    @ViewBuilder private var content: some View {
        switch model.step {
        case .setup: setup
        case .starting: status("Getting the mic ready", detail: nil)
        case .listening:
            status("Listening", detail: "Talk, then tap Done.")
            MMButton("Done", systemImage: "stop.fill") { model.finish() }
        case .writing: status("Writing it out", detail: nil)
        case let .done(text):
            status("Ready to type", detail: "Go back to your app with the arrow in the top corner. Your words appear where you were typing.")
            MMCard { Text(text).font(.system(size: MMFont.lg)).foregroundStyle(MMColor.onSurface) }
        case let .failed(message):
            status("Let's try that again", detail: message)
            MMButton("Try again", systemImage: "mic.fill") { model.listen() }
        }
    }

    private var setup: some View {
        VStack(alignment: .leading, spacing: MMSpace.four) {
            Text("Talk in any app")
                .font(.system(size: MMFont.display, weight: .bold))
                .foregroundStyle(MMColor.onSurface)
            Text("Tap the mic on the MightyMouse keyboard and your words appear in Messages, Mail, Notes, anywhere you type.")
                .font(.system(size: MMFont.lg))
                .foregroundStyle(MMColor.muted)
            stepRow(1, "Let MightyMouse hear you", done: model.micAllowed && model.speechAllowed)
            if !(model.micAllowed && model.speechAllowed) {
                MMButton("Allow", systemImage: "mic.fill") { model.allowAll() }
            }
            stepRow(2, "Add the keyboard: Settings, General, Keyboard, Keyboards, Add New Keyboard, MightyMouse", done: false)
            stepRow(3, "Tap MightyMouse there and turn on Allow Full Access", done: false)
            MMButton("Open Settings", kind: .secondary) {
                UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
            }
        }
    }

    private func stepRow(_ number: Int, _ text: String, done: Bool) -> some View {
        HStack(alignment: .top, spacing: MMSpace.three) {
            Image(systemName: done ? "checkmark.circle.fill" : "\(number).circle")
                .font(.system(size: MMFont.xl))
                .foregroundStyle(done ? MMColor.green : MMColor.accent)
            Text(text).font(.system(size: MMFont.lg)).foregroundStyle(MMColor.onSurface)
        }
    }

    private func status(_ title: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: MMSpace.two) {
            Text(title)
                .font(.system(size: MMFont.display, weight: .bold))
                .foregroundStyle(MMColor.onSurface)
            if let detail {
                Text(detail).font(.system(size: MMFont.lg)).foregroundStyle(MMColor.muted)
            }
        }
    }
}

private struct HiddenMic: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
