import AVFoundation
import SwiftUI
import UIKit

final class KeyboardRootView: UIInputView, UIInputViewAudioFeedback {
    var enableInputClicksWhenVisible: Bool { true }
}

private enum Layer { case letters, numbers, symbols }
private enum Shift { case off, once, lock }

private enum Mode: Equatable {
    case idle
    case rewrites
    case rewriting(String)
    case rewritten(label: String, text: String)
    case starting
    case listening
    case writing
    case typed
    case note(String)
}


private struct Rewrite {
    let label: String
    let instruction: String
}

private final class KeyButton: UIControl {
    let label = UILabel()
    let icon = UIImageView()
    var isFunction = false { didSet { paint() } }
    var isBlue = false { didSet { paint() } }
    var output: String?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 6
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.3
        layer.shadowOffset = CGSize(width: 0, height: 1)
        layer.shadowRadius = 0
        label.textAlignment = .center
        label.isUserInteractionEnabled = false
        icon.contentMode = .center
        icon.isUserInteractionEnabled = false
        icon.tintColor = .label
        addSubview(label)
        addSubview(icon)
        paint()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool { didSet { paint() } }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds
        icon.frame = bounds
    }

    func paint() {
        let pressed = isHighlighted
        if isBlue {
            backgroundColor = pressed ? KeyboardViewController.functionKey : .systemBlue
            label.textColor = .white
            return
        }
        let usesFunction = isFunction != pressed
        backgroundColor = usesFunction ? KeyboardViewController.functionKey : KeyboardViewController.letterKey
        label.textColor = .label
    }
}

private final class KeysView: UIView {
    private struct Held {
        let touch: UITouch
        var key: KeyButton
        let start: CGPoint
        let at: TimeInterval
        var cursorX: CGFloat?
    }

    var letterKeys: [KeyButton] = []
    var spaceKey: KeyButton?
    var functionKeys: [UIView] = []
    var onPress: ((KeyButton) -> Void)?
    var onSlide: ((KeyButton) -> Void)?
    var onType: ((KeyButton) -> Void)?
    var onCursor: ((Int) -> Void)?
    var onRelease: (() -> Void)?
    private var held: [Held] = []
    private var tapKeys: [KeyButton] { letterKeys + (spaceKey.map { [$0] } ?? []) }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = KeyboardViewController.touchableClear
    }

    required init?(coder: NSCoder) { fatalError() }

    // The hosted window's system gesture gates hold every key's touch down and lift until they fail.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        var node: UIView? = superview
        while let current = node {
            current.gestureRecognizers?.forEach {
                $0.delaysTouchesBegan = false
                $0.delaysTouchesEnded = false
            }
            node = current.superview
        }
    }

    private func distance(_ rect: CGRect, _ p: CGPoint) -> CGFloat {
        let dx = max(rect.minX - p.x, 0, p.x - rect.maxX)
        let dy = max(rect.minY - p.y, 0, p.y - rect.maxY)
        return dx * dx + dy * dy
    }

    private func nearest<V: UIView>(_ views: [V], to p: CGPoint) -> V? {
        views.filter { !$0.isHidden }.min { distance($0.frame, p) < distance($1.frame, p) }
    }

    // The bar's buttons end 6pt above its bottom edge; that strip belongs to the top row.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.inset(by: UIEdgeInsets(top: -6, left: 0, bottom: 0, right: 0)).contains(point)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard self.point(inside: point, with: event),
              let key = nearest((tapKeys as [UIView]) + functionKeys, to: point) else { return nil }
        return tapKeys.contains { $0 === key } ? self : key
    }

    func reset() {
        held.forEach { $0.key.isHighlighted = false }
        held.removeAll()
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            let pending = held.filter { $0.cursorX == nil }
            held.removeAll { $0.cursorX == nil }
            for entry in pending {
                entry.key.isHighlighted = false
                onType?(entry.key)
            }
            let p = touch.location(in: self)
            guard let key = nearest(tapKeys, to: p) else { continue }
            held.append(Held(touch: touch, key: key, start: p, at: touch.timestamp))
            key.isHighlighted = true
            onPress?(key)
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            guard let i = held.firstIndex(where: { $0.touch === touch }) else { continue }
            let p = touch.location(in: self)
            if held[i].key === spaceKey {
                guard let cursorX = held[i].cursorX else {
                    if abs(p.x - held[i].start.x) >= 24 || touch.timestamp - held[i].at >= 0.5 { held[i].cursorX = p.x }
                    continue
                }
                let steps = Int((p.x - cursorX) / 9)
                if steps != 0 {
                    held[i].cursorX = cursorX + CGFloat(steps) * 9
                    onCursor?(steps)
                }
                continue
            }
            guard touch.timestamp - held[i].at >= 0.15,
                  let key = nearest(letterKeys, to: p), key !== held[i].key else { continue }
            held[i].key.isHighlighted = false
            held[i].key = key
            key.isHighlighted = true
            onSlide?(key)
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            guard let i = held.firstIndex(where: { $0.touch === touch }) else { continue }
            let entry = held.remove(at: i)
            entry.key.isHighlighted = false
            if entry.cursorX == nil { onType?(entry.key) } else { onRelease?() }
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            guard let i = held.firstIndex(where: { $0.touch === touch }) else { continue }
            held.remove(at: i).key.isHighlighted = false
        }
        onRelease?()
    }
}

final class KeyboardViewController: UIInputViewController {
    // iOS drops touches on fully transparent pixels of a keyboard extension; gaps need a faint fill.
    static let touchableClear = UIColor(white: 0.5, alpha: 0.01)
    static let letterKey = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.42, alpha: 1) : .white }
    static let functionKey = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.27, alpha: 1) : UIColor(red: 0.67, green: 0.69, blue: 0.73, alpha: 1) }
    private static let accent = UIColor(MMColor.accent)
    private static let rewrites = [
        Rewrite(label: "Fix", instruction: "Fix spelling, grammar and punctuation. Do not change the wording otherwise."),
        Rewrite(label: "Shorter", instruction: "Make this shorter and clearer while keeping the meaning."),
        Rewrite(label: "Friendlier", instruction: "Rewrite this to sound warmer and friendlier."),
        Rewrite(label: "Professional", instruction: "Rewrite this to sound polished and professional."),
    ]
    private static let letterRows = [Array("qwertyuiop"), Array("asdfghjkl"), Array("zxcvbnm")].map { $0.map(String.init) }
    private static let numberRows = [Array("1234567890"), Array("-/:;()$&@\""), Array(".,?!'")].map { $0.map(String.init) }
    private static let symbolRows = [Array("[]{}#%^*+="), Array("_\\|~<>€£¥•"), Array(".,?!'")].map { $0.map(String.init) }
    private static let barHeight: CGFloat = 50
    private static let keyHeight: CGFloat = 45
    private static let rowGap: CGFloat = 11
    private static let keyGap: CGFloat = 6

    private let mic = WebMic()
    private var transcriber: LiveTranscriber?
    private var layerMode: Layer = .letters
    private var shift: Shift = .once
    private var lastShiftTap = Date.distantPast
    private var mode: Mode = .idle { didSet { renderBar() } }
    private var typedCount = 0
    private var undoRestore = ""
    private var talkStartedAt = Date.distantPast
    private var heardLive = false
    private var lastAction = "talk"
    private var noteAction: (() -> Void)?
    private var modeTimer: Timer?
    private var deleteTimer: Timer?
    private var micDownAt = Date.distantPast
    private var hasLiveText = false
    private let cursorTick = UISelectionFeedbackGenerator()
    private let checker = UITextChecker()
    private var suggestionWork: DispatchWorkItem?
    private var lastCorrection: (original: String, fixed: String, separator: String)?
    private static let quickFixes = ["i": "I", "im": "I'm", "ive": "I've", "dont": "don't", "cant": "can't", "wont": "won't",
                                     "didnt": "didn't", "doesnt": "doesn't", "isnt": "isn't", "thats": "that's",
                                     "whats": "what's", "youre": "you're", "theyre": "they're", "couldnt": "couldn't"]
    private static let learnedKey = "mm.keyboard.nextWords"
    private var starterWords: [String: [String]] = [:]
    private var learnedWords = UserDefaults.standard.dictionary(forKey: learnedKey) as? [String: [String]] ?? [:]

    private let bar = UIView()
    private var barRow = UIStackView()
    private let talkButton = UIButton(type: .custom)
    private let suggestionStack = UIStackView()
    private let sparkButton = UIButton(type: .system)
    private let chipScroll = UIScrollView()
    private let chipStack = UIStackView()
    private let noteLabel = UILabel()
    private let noteButton = UIButton(type: .system)
    private let listenStrip = UIView()
    private let waveStack = UIStackView()
    private let liveLabel = UILabel()
    private let doneButton = UIButton(type: .custom)
    private let previewCard = UIView()
    private let previewTitle = UILabel()
    private let previewText = UILabel()
    private let keysView = KeysView()
    private var keyRows: [[KeyButton]] = []
    private var popup: UILabel?

    override func loadView() {
        let root = KeyboardRootView(frame: .zero, inputViewStyle: .keyboard)
        root.allowsSelfSizing = true
        view = root
        inputView = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.addSubview(mic.webView)
        buildBar()
        keysView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(keysView)
        buildPreview()
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: Self.barHeight),
            keysView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            keysView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keysView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            keysView.heightAnchor.constraint(equalToConstant: 4 * Self.keyHeight + 3 * Self.rowGap + 4),
            keysView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        keysView.onPress = { [weak self] key in self?.keyDown(key) }
        keysView.onSlide = { [weak self] key in self?.showPopup(key.label.text ?? "", over: key) }
        keysView.onType = { [weak self] key in
            guard let self else { return }
            if key === self.keysView.spaceKey { self.typeText(" ") } else { self.keyTapped(key) }
        }
        keysView.onCursor = { [weak self] steps in
            self?.textDocumentProxy.adjustTextPosition(byCharacterOffset: steps)
            self?.cursorTick.selectionChanged()
        }
        keysView.onRelease = { [weak self] in
            self?.hidePopup()
            self?.updateAutoShift()
        }
        let height = view.heightAnchor.constraint(equalToConstant: Self.barHeight + 4 * Self.keyHeight + 3 * Self.rowGap + 4)
        height.priority = .required - 1
        height.isActive = true
        mic.onStarted = { [weak self] in self?.micStarted() }
        mic.onFailed = { [weak self] failure in
            guard let self else { return }
            if failure == .busy {
                self.track("ios_keyboard_talk", ["result": "mic_busy", "seconds": 0, "words": 0, "live": false])
                self.note("The mic is busy right now", action: ("Try again", { [weak self] in self?.beginListening() }))
            } else {
                self.recordInApp()
            }
        }
        mic.onLevel = { [weak self] level in self?.showLevel(level) }
        mic.onChunk = { [weak self] chunk in self?.transcriber?.append(chunk) }
        mic.onCapReached = { [weak self] in self?.finishListening() }
        rebuildKeys()
        renderBar()
        loadStarterWords()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if let text = KeyboardHandoff.takeText() { insertDictation(text) }
        KeyboardEvents.opened(fullAccess: hasFullAccess, micAllowed: AVAudioApplication.shared.recordPermission == .granted)
        mic.preload()
        updateAutoShift()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UserDefaults.standard.set(learnedWords, forKey: Self.learnedKey)
        if mode == .starting || mode == .listening {
            if mode == .listening { talkEnded("cancelled") }
            mic.cancel()
            transcriber?.cancel()
            mode = .idle
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutKeys()
    }

    override func textDidChange(_ textInput: UITextInput?) {
        updateAutoShift()
        refreshReturnKey()
        if mode == .idle { scheduleSuggestions() }
    }

    // MARK: Typing

    private func typeText(_ text: String, correct: Bool = true) {
        let proxy = textDocumentProxy
        lastCorrection = nil
        if let c = text.first, !(c.isLetter || c == "'") {
            let word = currentWord, previous = previousWord()
            if correct, let fix = correction(for: word, after: previous) {
                for _ in 0..<word.count { proxy.deleteBackward() }
                proxy.insertText(fix)
                lastCorrection = (word, fix, text)
            }
            learn(lastCorrection?.fixed ?? word, after: previous)
        }
        if text == " ", let before = proxy.documentContextBeforeInput, before.hasSuffix(" "),
           before.dropLast().last.map({ $0.isLetter || $0.isNumber }) == true {
            proxy.deleteBackward()
            proxy.insertText(". ")
        } else {
            proxy.insertText(text)
        }
        if shift == .once { shift = .off }
        if layerMode != .letters, text == " " || text == "'" { layerMode = .letters; rebuildKeys() }
        switch mode {
        case .typed, .rewrites, .rewritten, .note: mode = .idle
        default: break
        }
        updateAutoShift()
        scheduleSuggestions()
    }

    private func updateAutoShift() {
        guard layerMode == .letters, shift != .lock else { return }
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        let wantsCapital = textDocumentProxy.autocapitalizationType != UITextAutocapitalizationType.none
            && (before.isEmpty || before.hasSuffix("\n") || before.range(of: #"[.!?]\s+$"#, options: .regularExpression) != nil)
        let next: Shift = wantsCapital ? .once : .off
        if next != shift { shift = next; refreshKeyLabels() }
    }

    private func keyTapped(_ sender: KeyButton) {
        hidePopup()
        guard let output = sender.output else { return }
        let upper = layerMode == .letters && shift != .off
        typeText(upper ? output.uppercased() : output)
        refreshKeyLabels()
    }

    private func keyDown(_ sender: KeyButton) {
        UIDevice.current.playInputClick()
        guard sender.output != nil, let text = sender.label.text else { return }
        showPopup(text, over: sender)
    }

    @objc private func shiftTapped() {
        UIDevice.current.playInputClick()
        let now = Date()
        if now.timeIntervalSince(lastShiftTap) < 0.3 {
            shift = .lock
        } else {
            shift = shift == .off ? .once : .off
        }
        lastShiftTap = now
        refreshKeyLabels()
    }

    @objc private func layerTapped(_ sender: KeyButton) {
        UIDevice.current.playInputClick()
        switch sender.label.text {
        case "123": layerMode = .numbers
        case "#+=": layerMode = .symbols
        default: layerMode = .letters
        }
        rebuildKeys()
    }

    @objc private func returnTapped() {
        UIDevice.current.playInputClick()
        typeText("\n")
    }

    @objc private func deleteDown() {
        UIDevice.current.playInputClick()
        if let fix = lastCorrection, textDocumentProxy.documentContextBeforeInput?.hasSuffix(fix.fixed + fix.separator) == true {
            for _ in 0..<(fix.fixed + fix.separator).count { textDocumentProxy.deleteBackward() }
            textDocumentProxy.insertText(fix.original)
            UITextChecker.learnWord(fix.original)
            lastCorrection = nil
            scheduleSuggestions()
            return
        }
        textDocumentProxy.deleteBackward()
        deleteTimer?.invalidate()
        var ticks = 0
        deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
            self?.deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.09, repeats: true) { _ in
                guard let self else { return }
                ticks += 1
                if ticks > 14, let word = self.textDocumentProxy.documentContextBeforeInput?.split(separator: " ").last {
                    for _ in 0...word.count { self.textDocumentProxy.deleteBackward() }
                } else {
                    self.textDocumentProxy.deleteBackward()
                }
            }
        }
    }

    @objc private func deleteUp() {
        deleteTimer?.invalidate()
        deleteTimer = nil
        updateAutoShift()
        scheduleSuggestions()
    }

    // MARK: Suggestions

    private func scheduleSuggestions() {
        suggestionWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.renderSuggestions() }
        suggestionWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
    }

    private var currentWord: String {
        guard let before = textDocumentProxy.documentContextBeforeInput else { return "" }
        return String(before.reversed().prefix { $0.isLetter || $0 == "'" }.reversed())
    }

    private func loadStarterWords() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let url = Bundle.main.url(forResource: "next-words", withExtension: "txt"),
                  let text = try? String(contentsOf: url, encoding: .utf8) else { return }
            var table: [String: [String]] = [:]
            for line in text.split(separator: "\n") {
                let parts = line.split(separator: "\t")
                if parts.count == 2 { table[String(parts[0])] = parts[1].split(separator: " ").map(String.init) }
            }
            DispatchQueue.main.async { self?.starterWords = table }
        }
    }

    private func previousWord() -> String {
        var text = Substring(textDocumentProxy.documentContextBeforeInput ?? "")
        while let c = text.last, c.isLetter || c == "'" { text.removeLast() }
        while text.last == " " { text.removeLast() }
        guard let last = text.last, !".!?\n".contains(last) else { return "<s>" }
        return String(text.reversed().prefix { $0.isLetter || $0 == "'" }.reversed()).lowercased()
    }

    private func nextWords(after previous: String) -> [String] {
        var out: [String] = []
        for word in (learnedWords[previous] ?? []) + (starterWords[previous] ?? []) where !out.contains(word) { out.append(word) }
        return out
    }

    private func cased(_ word: String, capital: Bool) -> String {
        capital || word == "i" || word.hasPrefix("i'") ? word.prefix(1).uppercased() + word.dropFirst() : word
    }

    private func learn(_ word: String, after previous: String) {
        let word = word.lowercased()
        guard !previous.isEmpty, word.count > 1 || word == "a" || word == "i",
              learnedWords[previous] != nil || learnedWords.count < 5000 else { return }
        let range = NSRange(location: 0, length: (word as NSString).length)
        guard checker.rangeOfMisspelledWord(in: word, range: range, startingAt: 0, wrap: false, language: spellLanguage).location == NSNotFound else { return }
        var list = learnedWords[previous] ?? []
        list.removeAll { $0 == word }
        list.insert(word, at: 0)
        learnedWords[previous] = Array(list.prefix(3))
    }

    // The keyboard declares "mul" in Info.plist, which UITextChecker has no dictionary for.
    private lazy var spellLanguage: String = {
        let available = UITextChecker.availableLanguages
        for code in Locale.preferredLanguages.map({ $0.replacingOccurrences(of: "-", with: "_") }) {
            if available.contains(code) { return code }
            guard let base = code.split(separator: "_").first.map(String.init) else { continue }
            if base == "en", available.contains("en_US") { return "en_US" }
            if let match = available.first(where: { $0 == base || $0.hasPrefix(base + "_") }) { return match }
        }
        return available.contains("en_US") ? "en_US" : available.first ?? "en_US"
    }()

    private func correction(for word: String, after previous: String) -> String? {
        if let fix = Self.quickFixes[word.lowercased()] { return fix == word ? nil : fix }
        guard word.count > 1, textDocumentProxy.autocorrectionType != .no, !UITextChecker.hasLearnedWord(word),
              word.dropFirst().allSatisfy({ !$0.isUppercase }),
              word.first?.isUppercase != true || previous == "<s>" else { return nil }
        let language = spellLanguage
        let range = NSRange(location: 0, length: (word as NSString).length)
        guard checker.rangeOfMisspelledWord(in: word, range: range, startingAt: 0, wrap: false, language: language).location != NSNotFound,
              let guess = checker.guesses(forWordRange: range, in: word, language: language)?.first,
              abs(guess.count - word.count) <= 2 else { return nil }
        return word.first?.isUppercase == true ? guess.prefix(1).uppercased() + guess.dropFirst() : guess
    }

    private func suggestions() -> [String] {
        let word = currentWord
        let previous = previousWord()
        let next = nextWords(after: previous)
        guard !word.isEmpty else {
            let top = next.prefix(3).map { cased($0, capital: shift != .off) }
            return top.count == 3 ? [top[1], top[0], top[2]] : top
        }
        let language = spellLanguage
        let range = NSRange(location: 0, length: (word as NSString).length)
        var found: [String] = []
        if let fix = correction(for: word, after: previous) { found.append(fix) }
        let lower = word.lowercased()
        found += next.filter { $0.hasPrefix(lower) && $0.count > word.count }.map { cased($0, capital: false) }
        found += (checker.completions(forPartialWordRange: range, in: word, language: language) ?? []).filter { $0.count > word.count }
        var unique: [String] = []
        for candidate in found where !unique.contains(candidate) { unique.append(candidate) }
        return ["\u{201C}\(word)\u{201D}"] + unique.prefix(2)
    }

    @objc private func suggestionTapped(_ sender: UIButton) {
        guard let title = sender.title(for: .normal), !title.isEmpty else { return }
        UIDevice.current.playInputClick()
        if title.hasPrefix("\u{201C}") {
            typeText(" ", correct: false)
            return
        }
        let word = currentWord
        learn(title, after: previousWord())
        for _ in 0..<word.count { textDocumentProxy.deleteBackward() }
        let matched = word.first?.isUppercase == true ? title.prefix(1).uppercased() + title.dropFirst() : title
        textDocumentProxy.insertText(matched + " ")
        updateAutoShift()
        renderSuggestions()
    }

    // MARK: Talk

    @objc private func talkDown() {
        micDownAt = Date()
        switch mode {
        case .listening: finishListening()
        case .starting:
            mic.cancel()
            transcriber?.cancel()
            mode = .idle
        case .writing: break
        default: beginListening()
        }
    }

    @objc private func talkUp() {
        if mode == .listening, Date().timeIntervalSince(micDownAt) > 0.45 { finishListening() }
    }

    private func beginListening() {
        guard hasFullAccess else {
            track("ios_keyboard_setup_blocked", ["reason": "full_access"])
            note("Turn on Full Access to talk", action: ("Open Settings", { [weak self] in
                self?.open(URL(string: UIApplication.openSettingsURLString)!)
            }))
            return
        }
        guard AVAudioApplication.shared.recordPermission == .granted else {
            track("ios_keyboard_setup_blocked", ["reason": "mic"])
            note("Allow the mic once in MightyMouse", action: ("Open", { [weak self] in
                self?.open(KeyboardHandoff.url())
            }))
            return
        }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        hasLiveText = false
        mode = .starting
        mic.start()
    }

    private func micStarted() {
        let live = LiveTranscriber()
        live.onPartial = { [weak self] text in self?.showLive(text) }
        transcriber = live.start() ? live : nil
        talkStartedAt = Date()
        heardLive = false
        mode = .listening
    }

    @objc private func cancelListening() {
        if mode == .listening { talkEnded("cancelled") }
        mic.cancel()
        transcriber?.cancel()
        transcriber = nil
        mode = .idle
    }

    @objc private func finishListening() {
        guard mode == .listening else { return }
        mode = .writing
        Task { @MainActor in
            let samples = await mic.stop()
            let live = await transcriber?.finish()
            transcriber = nil
            if let live, !live.isEmpty {
                talkEnded("typed", words: live)
                insertDictation(live)
                return
            }
            await writeOut(samples)
        }
    }

    private func writeOut(_ samples: [Int16]) async {
        mode = .writing
        switch await SpeechToText.transcribe(samples) {
            case let .success(text):
                talkEnded("typed", words: text)
                insertDictation(text)
            case .failure(.heardNothing):
                talkEnded("heard_nothing")
                note("Didn't catch that", action: ("Try again", { [weak self] in self?.beginListening() }))
            case .failure(.failed) where !samples.isEmpty:
                talkEnded("failed")
                note("Couldn't write that out", action: ("Retry", { [weak self] in
                    Task { @MainActor in await self?.writeOut(samples) }
                }))
            case .failure:
                guard KeyboardHandoff.saveAudio(samples) else {
                    note("Couldn't write that out. Tap Talk to try again")
                    return
                }
                talkEnded("app_fallback")
                note("Finishing in MightyMouse. Come back and it types")
                open(KeyboardHandoff.url(KeyboardHandoff.finishPath))
        }
    }

    private func recordInApp() {
        track("ios_keyboard_talk", ["result": "app_fallback", "seconds": 0, "words": 0, "live": false])
        transcriber?.cancel()
        transcriber = nil
        note("Opening MightyMouse to listen")
        open(KeyboardHandoff.url(KeyboardHandoff.dictatePath))
    }

    private func insertDictation(_ spoken: String) {
        let text = OnDeviceModel.plain(spoken)
        undoRestore = textDocumentProxy.selectedText ?? ""
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        let needsSpace = before.last.map { !$0.isWhitespace } ?? false
        let startsWithPunctuation = text.first.map { $0.isPunctuation } ?? false
        let inserted = (needsSpace && !startsWithPunctuation ? " " : "") + text
        textDocumentProxy.insertText(inserted)
        typedCount = inserted.count
        lastAction = "talk"
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        updateAutoShift()
        mode = .typed
        armModeTimeout(7)
    }

    @objc private func undoTapped() {
        track("ios_keyboard_undo", ["after": lastAction])
        for _ in 0..<typedCount { textDocumentProxy.deleteBackward() }
        if !undoRestore.isEmpty { textDocumentProxy.insertText(undoRestore) }
        typedCount = 0
        undoRestore = ""
        mode = .idle
        updateAutoShift()
    }

    private func showLive(_ text: String) {
        guard mode == .listening else { return }
        hasLiveText = true
        heardLive = true
        liveLabel.text = text
        liveLabel.textColor = .label
    }

    private func showLevel(_ level: Float) {
        let bars = waveStack.arrangedSubviews
        for (i, bar) in bars.enumerated() {
            let wobble = abs(sin(Double(i) * 1.7 + Date().timeIntervalSince1970 * 9))
            let height = 4 + CGFloat(min(1, level * 3)) * 22 * CGFloat(0.35 + wobble * 0.65)
            bar.constraints.first { $0.firstAttribute == .height }?.constant = height
        }
        UIView.animate(withDuration: 0.1) { self.waveStack.layoutIfNeeded() }
    }

    // MARK: Rewrite

    @objc private func sparkTapped() {
        UIDevice.current.playInputClick()
        if case .rewrites = mode { mode = .idle } else { mode = .rewrites }
    }

    @objc private func polishTapped() { runRewrite(Self.rewrites[0], onlyTyped: true) }

    @objc private func rewriteChipTapped(_ sender: UIButton) {
        guard Self.rewrites.indices.contains(sender.tag) else { return }
        runRewrite(Self.rewrites[sender.tag], onlyTyped: false)
    }

    private var lastRewrite: (rewrite: Rewrite, onlyTyped: Bool)?

    private func track(_ event: String, _ props: [String: Any]) {
        KeyboardEvents.track(event, props, fullAccess: hasFullAccess)
    }

    private func talkEnded(_ result: String, words: String = "") {
        let seconds = max(0, Int(Date().timeIntervalSince(talkStartedAt)))
        let count = words.split(whereSeparator: { $0.isWhitespace }).count
        track("ios_keyboard_talk", ["result": result, "seconds": seconds, "words": count, "live": heardLive])
    }

    private func trackRewrite(_ rewrite: Rewrite, onlyTyped: Bool, result: String, highlighted: Bool) {
        let kind = onlyTyped ? "polish" : rewrite.label.lowercased()
        track("ios_keyboard_rewrite", ["kind": kind, "result": result, "highlighted": highlighted])
    }

    private func rewriteFinished(_ result: String, highlighted: Bool) {
        guard let last = lastRewrite else { return }
        trackRewrite(last.rewrite, onlyTyped: last.onlyTyped, result: result, highlighted: highlighted)
        lastRewrite = nil
        if result == "replaced" { lastAction = "rewrite" }
    }

    private var rewriteSource: (before: String, after: String, onlyTyped: Bool, selection: String?)?

    private func runRewrite(_ rewrite: Rewrite, onlyTyped: Bool) {
        let selection = onlyTyped ? nil : textDocumentProxy.selectedText.flatMap { $0.isEmpty ? nil : $0 }
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        let after = onlyTyped ? "" : (textDocumentProxy.documentContextAfterInput ?? "")
        let source = selection ?? (onlyTyped ? String(before.suffix(typedCount)) : before + after)
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            note("Type or talk first, then rewrite it")
            return
        }
        if let unavailable = OnDeviceModel.availability {
            trackRewrite(rewrite, onlyTyped: onlyTyped, result: "unavailable", highlighted: selection != nil)
            note(unavailable.message)
            return
        }
        lastRewrite = (rewrite, onlyTyped)
        rewriteSource = (onlyTyped ? source : before, after, onlyTyped, selection)
        mode = .rewriting(rewrite.label)
        Task { @MainActor in
            do {
                let text = try await OnDeviceModel.rewrite(source.trimmingCharacters(in: .whitespacesAndNewlines), instruction: rewrite.instruction)
                guard case .rewriting = mode else { return }
                mode = .rewritten(label: rewrite.label, text: text)
            } catch {
                trackRewrite(rewrite, onlyTyped: onlyTyped, result: "failed", highlighted: selection != nil)
                note("Couldn't rewrite that", action: ("Retry", { [weak self] in self?.runRewrite(rewrite, onlyTyped: onlyTyped) }))
            }
        }
    }

    @objc private func replaceTapped() {
        guard case let .rewritten(_, text) = mode, let source = rewriteSource else { return }
        if let selection = source.selection {
            guard textDocumentProxy.selectedText == selection else {
                note("The highlight moved. Highlight it again and retry")
                return
            }
            textDocumentProxy.insertText(text)
            typedCount = text.count
            undoRestore = selection
            rewriteFinished("replaced", highlighted: true)
            rewriteSource = nil
            mode = .typed
            armModeTimeout(7)
            return
        }
        undoRestore = source.before + source.after
        if !source.after.isEmpty { textDocumentProxy.adjustTextPosition(byCharacterOffset: source.after.count) }
        let leadingSpace = source.onlyTyped && source.before.first == " " ? " " : ""
        for _ in 0..<(source.before.count + source.after.count) { textDocumentProxy.deleteBackward() }
        textDocumentProxy.insertText(leadingSpace + text)
        typedCount = leadingSpace.count + text.count
        rewriteFinished("replaced", highlighted: false)
        rewriteSource = nil
        mode = .typed
        armModeTimeout(7)
    }

    @objc private func keepTapped() {
        if case .rewritten = mode { rewriteFinished("kept", highlighted: rewriteSource?.selection != nil) }
        rewriteSource = nil
        mode = .idle
    }

    // MARK: Notes and links

    private var isNote: Bool {
        if case .note = mode { return true }
        return false
    }

    private func note(_ text: String, action: (String, () -> Void)? = nil) {
        noteAction = action?.1
        noteButton.setTitle(action?.0, for: .normal)
        mode = .note(text)
        if action == nil { armModeTimeout(4) }
    }

    private func armModeTimeout(_ seconds: TimeInterval) {
        modeTimer?.invalidate()
        let armedFor = mode
        modeTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self, self.mode == armedFor else { return }
            self.mode = .idle
        }
    }

    @objc private func noteActionTapped() {
        let action = noteAction
        noteAction = nil
        mode = .idle
        action?()
    }

    // Keyboards can't call UIApplication.open, so the call goes up the responder chain.
    private func open(_ url: URL) {
        typealias OpenFn = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector), let imp = current.method(for: selector) {
                unsafeBitCast(imp, to: OpenFn.self)(current, selector, url as NSURL, NSDictionary(), nil)
                return
            }
            responder = current.next
        }
    }

    // MARK: Bar

    private func buildBar() {
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = Self.touchableClear
        view.addSubview(bar)

        var talk = UIButton.Configuration.filled()
        talk.title = "Talk"
        talk.image = UIImage(systemName: "mic.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold))
        talk.imagePadding = 5
        talk.baseBackgroundColor = Self.accent
        talk.baseForegroundColor = .white
        talk.cornerStyle = .capsule
        talk.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 14)
        talk.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
            var a = $0
            a.font = .systemFont(ofSize: 17, weight: .semibold)
            return a
        }
        talkButton.configuration = talk
        talkButton.accessibilityLabel = "Talk"
        talkButton.addTarget(self, action: #selector(talkDown), for: .touchDown)
        talkButton.addTarget(self, action: #selector(talkUp), for: [.touchUpInside, .touchUpOutside])

        suggestionStack.distribution = .fillEqually
        for i in 0..<3 {
            let b = UIButton(type: .system)
            b.titleLabel?.font = .systemFont(ofSize: 16, weight: i == 1 ? .semibold : .regular)
            b.titleLabel?.lineBreakMode = .byTruncatingTail
            b.tintColor = .label
            b.addTarget(self, action: #selector(suggestionTapped(_:)), for: .touchUpInside)
            suggestionStack.addArrangedSubview(b)
        }

        sparkButton.setImage(UIImage(systemName: "sparkles"), for: .normal)
        sparkButton.backgroundColor = UIColor.systemGray.withAlphaComponent(0.18)
        sparkButton.layer.cornerRadius = 20
        sparkButton.accessibilityLabel = "Rewrite"
        sparkButton.addTarget(self, action: #selector(sparkTapped), for: .touchUpInside)

        chipStack.spacing = 6
        chipStack.translatesAutoresizingMaskIntoConstraints = false
        chipScroll.showsHorizontalScrollIndicator = false
        chipScroll.addSubview(chipStack)
        NSLayoutConstraint.activate([
            chipStack.leadingAnchor.constraint(equalTo: chipScroll.contentLayoutGuide.leadingAnchor),
            chipStack.trailingAnchor.constraint(equalTo: chipScroll.contentLayoutGuide.trailingAnchor),
            chipStack.centerYAnchor.constraint(equalTo: chipScroll.centerYAnchor),
            chipStack.heightAnchor.constraint(equalToConstant: 38),
        ])

        noteLabel.font = .systemFont(ofSize: 14)
        noteLabel.adjustsFontSizeToFitWidth = true
        noteLabel.minimumScaleFactor = 0.8
        noteButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        noteButton.tintColor = Self.accent
        noteButton.addTarget(self, action: #selector(noteActionTapped), for: .touchUpInside)

        let row = UIStackView(arrangedSubviews: [talkButton, suggestionStack, chipScroll, noteLabel, noteButton, sparkButton])
        barRow = row
        row.spacing = 6
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -6),
            row.topAnchor.constraint(equalTo: bar.topAnchor, constant: 2),
            talkButton.heightAnchor.constraint(equalToConstant: 40),
            sparkButton.widthAnchor.constraint(equalToConstant: 40),
            sparkButton.heightAnchor.constraint(equalToConstant: 40),
            suggestionStack.heightAnchor.constraint(equalToConstant: 40),
            chipScroll.heightAnchor.constraint(equalToConstant: 42),
        ])
        talkButton.setContentHuggingPriority(.required, for: .horizontal)
        noteButton.setContentHuggingPriority(.required, for: .horizontal)

        buildListenStrip()
    }

    private func buildListenStrip() {
        listenStrip.translatesAutoresizingMaskIntoConstraints = false
        listenStrip.isHidden = true
        bar.addSubview(listenStrip)

        let cancel = UIButton(type: .system)
        cancel.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .bold)), for: .normal)
        cancel.tintColor = .label
        cancel.backgroundColor = UIColor.systemGray.withAlphaComponent(0.22)
        cancel.layer.cornerRadius = 20
        cancel.accessibilityLabel = "Cancel"
        cancel.addTarget(self, action: #selector(cancelListening), for: .touchUpInside)

        waveStack.spacing = 3
        waveStack.alignment = .center
        for _ in 0..<9 {
            let b = UIView()
            b.backgroundColor = Self.accent
            b.layer.cornerRadius = 1.5
            b.translatesAutoresizingMaskIntoConstraints = false
            b.widthAnchor.constraint(equalToConstant: 3).isActive = true
            b.heightAnchor.constraint(equalToConstant: 4).isActive = true
            waveStack.addArrangedSubview(b)
        }

        liveLabel.font = .systemFont(ofSize: 16)
        liveLabel.lineBreakMode = .byTruncatingHead

        doneButton.setImage(UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .heavy)), for: .normal)
        doneButton.tintColor = .white
        doneButton.backgroundColor = Self.accent
        doneButton.layer.cornerRadius = 20
        doneButton.accessibilityLabel = "Done"
        doneButton.addTarget(self, action: #selector(finishListening), for: .touchUpInside)

        let row = UIStackView(arrangedSubviews: [cancel, waveStack, liveLabel, doneButton])
        row.spacing = 8
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        listenStrip.addSubview(row)
        NSLayoutConstraint.activate([
            listenStrip.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            listenStrip.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            listenStrip.topAnchor.constraint(equalTo: bar.topAnchor),
            listenStrip.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: listenStrip.leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: listenStrip.trailingAnchor, constant: -6),
            row.topAnchor.constraint(equalTo: listenStrip.topAnchor, constant: 2),
            cancel.widthAnchor.constraint(equalToConstant: 40),
            cancel.heightAnchor.constraint(equalToConstant: 40),
            doneButton.widthAnchor.constraint(equalToConstant: 40),
            doneButton.heightAnchor.constraint(equalToConstant: 40),
            waveStack.heightAnchor.constraint(equalToConstant: 28),
        ])
        liveLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    private func buildPreview() {
        previewCard.isHidden = true
        previewCard.backgroundColor = .systemBackground
        previewCard.layer.cornerRadius = 14
        previewCard.layer.shadowColor = UIColor.black.cgColor
        previewCard.layer.shadowOpacity = 0.18
        previewCard.layer.shadowRadius = 9
        previewCard.layer.shadowOffset = CGSize(width: 0, height: 4)
        previewCard.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(previewCard)

        previewTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        previewTitle.textColor = Self.accent
        previewText.font = .systemFont(ofSize: 17)
        previewText.numberOfLines = 0
        previewText.lineBreakMode = .byTruncatingTail

        let keep = UIButton(type: .system)
        keep.setTitle("Keep mine", for: .normal)
        keep.backgroundColor = UIColor.systemGray.withAlphaComponent(0.18)
        keep.tintColor = .label
        keep.addTarget(self, action: #selector(keepTapped), for: .touchUpInside)
        let replace = UIButton(type: .system)
        replace.setTitle("Replace", for: .normal)
        replace.backgroundColor = Self.accent
        replace.tintColor = .white
        replace.addTarget(self, action: #selector(replaceTapped), for: .touchUpInside)
        for b in [keep, replace] {
            b.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
            b.layer.cornerRadius = 10
            b.heightAnchor.constraint(equalToConstant: 38).isActive = true
        }
        let buttons = UIStackView(arrangedSubviews: [keep, replace])
        buttons.spacing = 8
        buttons.distribution = .fillEqually

        let stack = UIStackView(arrangedSubviews: [previewTitle, previewText, UIView(), buttons])
        stack.axis = .vertical
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        previewCard.addSubview(stack)
        NSLayoutConstraint.activate([
            previewCard.topAnchor.constraint(equalTo: keysView.topAnchor),
            previewCard.bottomAnchor.constraint(equalTo: keysView.bottomAnchor),
            previewCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            previewCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: previewCard.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: previewCard.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: previewCard.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: previewCard.trailingAnchor, constant: -14),
        ])
    }

    private func chip(_ title: String, accent: Bool = false, image: String? = nil, action: Selector) -> UIButton {
        var config = accent ? UIButton.Configuration.filled() : UIButton.Configuration.gray()
        config.title = title
        config.cornerStyle = .capsule
        config.baseBackgroundColor = accent ? Self.accent : Self.letterKey
        config.baseForegroundColor = accent ? .white : .label
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12)
        if let image {
            config.image = UIImage(systemName: image, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
            config.imagePadding = 4
        }
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
            var a = $0
            a.font = .systemFont(ofSize: 15, weight: .medium)
            return a
        }
        let b = UIButton(configuration: config)
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    private func renderBar() {
        let listening = mode == .listening || mode == .writing || mode == .starting
        listenStrip.isHidden = !listening
        barRow.isHidden = listening
        keysView.alpha = listening ? 0.35 : 1
        keysView.isUserInteractionEnabled = !listening
        doneButton.isEnabled = mode == .listening
        doneButton.alpha = mode == .listening ? 1 : 0.5
        if mode == .writing { liveLabel.text = "Writing it out…"; liveLabel.textColor = .secondaryLabel }
        if mode == .starting { liveLabel.text = "Getting the mic ready…"; liveLabel.textColor = .secondaryLabel }
        if mode == .listening, !hasLiveText {
            liveLabel.text = "Listening… talk now"
            liveLabel.textColor = .secondaryLabel
        }

        let showChips: Bool
        chipStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        switch mode {
        case .typed:
            chipStack.addArrangedSubview(chip("Undo", image: "arrow.uturn.backward", action: #selector(undoTapped)))
            chipStack.addArrangedSubview(chip("Polish it", accent: true, image: "sparkles", action: #selector(polishTapped)))
            showChips = true
        case .rewrites, .rewriting, .rewritten:
            for (i, rewrite) in Self.rewrites.enumerated() {
                let b = chip(rewrite.label, action: #selector(rewriteChipTapped(_:)))
                b.tag = i
                if case let .rewriting(label) = mode, label == rewrite.label { b.configuration?.showsActivityIndicator = true }
                chipStack.addArrangedSubview(b)
            }
            showChips = true
        default:
            showChips = false
        }
        chipScroll.isHidden = !showChips
        noteLabel.isHidden = !isNote
        noteButton.isHidden = !isNote || noteAction == nil
        if case let .note(text) = mode { noteLabel.text = text }
        talkButton.isHidden = isNote
        sparkButton.isHidden = isNote || mode == .typed
        suggestionStack.isHidden = showChips || isNote
        let rewriting: Bool
        switch mode {
        case .rewrites, .rewriting, .rewritten: rewriting = true
        default: rewriting = false
        }
        sparkButton.backgroundColor = rewriting ? Self.accent.withAlphaComponent(0.15) : UIColor.systemGray.withAlphaComponent(0.18)
        sparkButton.tintColor = rewriting ? Self.accent : .label

        if case let .rewritten(label, text) = mode {
            previewTitle.text = label
            previewText.text = text
            previewCard.isHidden = false
        } else {
            previewCard.isHidden = true
        }
        if !showChips && !isNote { scheduleSuggestions() }
    }

    private func renderSuggestions() {
        let words = suggestions()
        for (i, view) in suggestionStack.arrangedSubviews.enumerated() {
            (view as? UIButton)?.setTitle(i < words.count ? words[i] : "", for: .normal)
        }
    }

    // MARK: Keys

    private func rows() -> [[String]] {
        switch layerMode {
        case .letters: return Self.letterRows
        case .numbers: return Self.numberRows
        case .symbols: return Self.symbolRows
        }
    }

    private func rebuildKeys() {
        keysView.reset()
        keysView.subviews.forEach { $0.removeFromSuperview() }
        keyRows = rows().map { row in
            row.map { ch in
                let key = KeyButton()
                key.output = ch
                key.label.font = .systemFont(ofSize: 25)
                keysView.addSubview(key)
                return key
            }
        }

        let left = KeyButton()
        left.isFunction = true
        if layerMode == .letters {
            left.addTarget(self, action: #selector(shiftTapped), for: .touchDown)
        } else {
            left.label.text = layerMode == .numbers ? "#+=" : "123"
            left.label.font = .systemFont(ofSize: 16)
            left.addTarget(self, action: #selector(layerTapped(_:)), for: .touchUpInside)
        }
        left.tag = 1

        let delete = KeyButton()
        delete.isFunction = true
        delete.icon.image = UIImage(systemName: "delete.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18))
        delete.accessibilityLabel = "Delete"
        delete.addTarget(self, action: #selector(deleteDown), for: .touchDown)
        delete.addTarget(self, action: #selector(deleteUp), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        delete.tag = 2

        let layerKey = KeyButton()
        layerKey.isFunction = true
        layerKey.label.text = layerMode == .letters ? "123" : "ABC"
        layerKey.label.font = .systemFont(ofSize: 16)
        layerKey.addTarget(self, action: #selector(layerTapped(_:)), for: .touchUpInside)
        layerKey.tag = 3

        let globe = KeyButton()
        globe.isFunction = true
        globe.icon.image = UIImage(systemName: "globe", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18))
        globe.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
        globe.tag = 4

        let space = KeyButton()
        space.label.text = "space"
        space.label.font = .systemFont(ofSize: 16)
        space.tag = 5

        let ret = KeyButton()
        ret.isFunction = true
        ret.label.font = .systemFont(ofSize: 16)
        ret.addTarget(self, action: #selector(returnTapped), for: .touchUpInside)
        ret.tag = 6

        [left, delete, layerKey, globe, space, ret].forEach(keysView.addSubview)
        keysView.letterKeys = keyRows.flatMap { $0 }
        keysView.spaceKey = space
        keysView.functionKeys = [left, delete, layerKey, globe, ret]
        refreshKeyLabels()
        refreshReturnKey()
        view.setNeedsLayout()
    }


    private func refreshKeyLabels() {
        let upper = layerMode == .letters && shift != .off
        for row in keyRows {
            for key in row { key.label.text = upper ? key.output?.uppercased() : key.output }
        }
        guard let shiftKey = keysView.viewWithTag(1) as? KeyButton, layerMode == .letters else { return }
        let symbol = shift == .lock ? "capslock.fill" : shift == .once ? "shift.fill" : "shift"
        shiftKey.icon.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18))
        shiftKey.isFunction = shift == .off
        shiftKey.accessibilityLabel = "Shift"
    }

    private func refreshReturnKey() {
        guard let ret = keysView.viewWithTag(6) as? KeyButton else { return }
        let labels: [UIReturnKeyType: String] = [.go: "go", .search: "search", .send: "send", .done: "done", .next: "next", .join: "join", .route: "route", .continue: "continue", .google: "search", .yahoo: "search"]
        let type = textDocumentProxy.returnKeyType ?? .default
        ret.label.text = labels[type] ?? "return"
        ret.isBlue = labels[type] != nil && type != .next && type != .continue
    }

    private func layoutKeys() {
        let width = keysView.bounds.width
        guard width > 0 else { return }
        let margin: CGFloat = 6.5
        let gap = Self.keyGap
        let keyWidth = (width - 2 * margin - 9 * gap) / 10
        let h = Self.keyHeight
        let y = { (row: Int) in CGFloat(row) * (h + Self.rowGap) }

        for (r, row) in keyRows.enumerated().prefix(2) {
            let rowWidth = CGFloat(row.count) * keyWidth + CGFloat(row.count - 1) * gap
            var x = (width - rowWidth) / 2
            for key in row {
                key.frame = CGRect(x: x, y: y(r), width: keyWidth, height: h)
                x += keyWidth + gap
            }
        }
        let fnWidth: CGFloat = 42
        let third = keyRows.count > 2 ? keyRows[2] : []
        let thirdKeyWidth = layerMode == .letters ? keyWidth : (width - 2 * margin - 2 * fnWidth - 2 * 14 - 4 * gap) / 5
        let thirdWidth = CGFloat(third.count) * thirdKeyWidth + CGFloat(max(0, third.count - 1)) * gap
        var x = (width - thirdWidth) / 2
        for key in third {
            key.frame = CGRect(x: x, y: y(2), width: thirdKeyWidth, height: h)
            x += thirdKeyWidth + gap
        }
        keysView.viewWithTag(1)?.frame = CGRect(x: margin, y: y(2), width: fnWidth, height: h)
        keysView.viewWithTag(2)?.frame = CGRect(x: width - margin - fnWidth, y: y(2), width: fnWidth, height: h)

        let showGlobe = needsInputModeSwitchKey
        let modeWidth: CGFloat = showGlobe ? 42 : 88
        let retWidth: CGFloat = 88
        keysView.viewWithTag(3)?.frame = CGRect(x: margin, y: y(3), width: modeWidth, height: h)
        let globe = keysView.viewWithTag(4)
        globe?.isHidden = !showGlobe
        globe?.frame = CGRect(x: margin + modeWidth + gap, y: y(3), width: 42, height: h)
        let spaceX = margin + modeWidth + gap + (showGlobe ? 42 + gap : 0)
        keysView.viewWithTag(5)?.frame = CGRect(x: spaceX, y: y(3), width: width - margin - retWidth - gap - spaceX, height: h)
        keysView.viewWithTag(6)?.frame = CGRect(x: width - margin - retWidth, y: y(3), width: retWidth, height: h)
    }

    private func showPopup(_ text: String, over key: UIView) {
        hidePopup()
        let pop = UILabel()
        pop.text = text
        pop.font = .systemFont(ofSize: 32)
        pop.textAlignment = .center
        pop.backgroundColor = Self.letterKey
        pop.textColor = .label
        pop.layer.cornerRadius = 10
        pop.layer.masksToBounds = true
        let frame = key.convert(key.bounds, to: view)
        pop.frame = CGRect(x: frame.midX - 26, y: frame.minY - 54, width: 52, height: 56)
        view.addSubview(pop)
        popup = pop
    }

    @objc private func hidePopup() {
        popup?.removeFromSuperview()
        popup = nil
    }
}

private enum KeyboardEvents {
    private static let queueKey = "mm.keyboard.events"
    private static let lastOpenedKey = "mm.keyboard.lastOpened"
    private static let maxQueued = 100
    private static let sessionId = UUID().uuidString
    private static var flushing = false

    static func opened(fullAccess: Bool, micAllowed: Bool) {
        let defaults = UserDefaults.standard
        guard Date().timeIntervalSince1970 - defaults.double(forKey: lastOpenedKey) > 30 * 60 else { return }
        defaults.set(Date().timeIntervalSince1970, forKey: lastOpenedKey)
        track("ios_keyboard_opened", ["full_access": fullAccess, "mic_allowed": micAllowed], fullAccess: fullAccess)
    }

    static func track(_ event: String, _ props: [String: Any], fullAccess: Bool) {
        let row: [String: Any] = ["event": event, "props": props, "at": Date().timeIntervalSince1970]
        var queue = UserDefaults.standard.array(forKey: queueKey) as? [[String: Any]] ?? []
        queue.append(row)
        UserDefaults.standard.set(Array(queue.suffix(maxQueued)), forKey: queueKey)
        if fullAccess { Task { await flush() } }
    }

    @MainActor
    private static func flush() async {
        guard !flushing else { return }
        let queue = UserDefaults.standard.array(forKey: queueKey) as? [[String: Any]] ?? []
        guard !queue.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        let credentials = Credentials()
        let anonId = credentials.value(for: Credentials.analyticsAnonIdKey) ?? {
            let minted = UUID().uuidString
            credentials.set(minted, for: Credentials.analyticsAnonIdKey)
            return minted
        }()
        let device: [String: Any] = ["surface": "keyboard", "device": AppConfig.hardwareIdentifier, "os": UIDevice.current.systemVersion, "build": AppConfig.appBuild]
        let rows: [[String: Any]] = queue.map { item in
            [
                "event": item["event"] ?? "",
                "anon_id": anonId,
                "session_id": sessionId,
                "user_id": NSNull(),
                "app_version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                "platform": "ios",
                "props": device.merging(item["props"] as? [String: Any] ?? [:]) { _, own in own },
            ]
        }
        guard let body = try? JSONSerialization.data(withJSONObject: rows) else { return }
        var request = URLRequest(url: AppConfig.supabaseURL.appendingPathComponent("/functions/v1/events-ingest"))
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(AppConfig.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
        let remaining = (UserDefaults.standard.array(forKey: queueKey) as? [[String: Any]] ?? []).dropFirst(queue.count)
        UserDefaults.standard.set(Array(remaining), forKey: queueKey)
    }
}
