import AppIntents
import Foundation

#if MM_WIDGET_EXTENSION
/// The extension has no WebView and can never open one -- `NativeBridge` is
/// app-only. Per `ios/CLAUDE.md` ("Swift owns no connection state"), this is
/// a constant, not a second bridge/socket implementation for the extension.
enum NativeIntentRouter {
    static let isConnected = false
    static func emit(_ event: [String: Any]) {}
}
#else
enum NativeIntentRouter {
    static weak var bridge: NativeBridge?

    /// Whether an emit can actually reach the Mac. The bridge is only set in
    /// `RemoteWebView.makeUIView`, so this is false whenever the app is not
    /// already open -- which is the normal case for a Siri request. Callers
    /// that can degrade gracefully must check this instead of emitting into
    /// the void and reporting success.
    static var isConnected: Bool { bridge != nil }

    static func emit(_ event: [String: Any]) {
        bridge?.emit(event)
    }
}
#endif

struct OpenRemoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Open MightyMouse Remote"
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult { .result() }
}

// The two control-button intents live HERE, not beside their ControlWidgets in
// the extension target, and that placement is the whole fix. An intent whose
// only target is the extension is rejected before `perform()` runs:
// `LNContextErrorDomain 2001 "openAppWhenRun is not supported in extensions"`.
// The tap then silently does nothing -- no flag, no launch -- which reads as a
// dead button. This file is a member of BOTH targets, so the app owns the type
// and iOS honours the open.

/// Writes the arm flag and returns immediately -- it must NOT touch
/// `AVAudioSession`. iOS blocks activating a recording session from a fully
/// backgrounded process (`ios/docs/background-audio-spike.md`); the app reads
/// `SharedAppGroup.armRecordingKey` on launch and starts the recorder itself,
/// already in the foreground.
struct StartRecordingIntent: AppIntent {
    static var title: LocalizedStringResource = "Record with MightyMouse"
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        SharedAppGroup.defaults.set(true, forKey: SharedAppGroup.armRecordingKey)
        MMLog.control.log("control: armed recording flag")
        return .result()
    }
}

/// The control-button twin of `AskMightyIntent`. That one takes a `@Parameter`
/// with a `requestValueDialog`, which only Siri can answer -- a
/// `ControlWidgetButton` has no conversational UI, so it fires and dies
/// silently. This asks for nothing, arms a flag, and lets the app's own chat
/// sheet collect the question.
struct ArmAskIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask MightyMouse"
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        SharedAppGroup.defaults.set(true, forKey: SharedAppGroup.armAskKey)
        MMLog.control.log("control: armed ask flag")
        return .result()
    }
}

/// Answers in Siri, on-device, without opening the app. Alone among the intents
/// in NOT setting `openAppWhenRun` — the others need the webview's socket to
/// reach the Mac, this one needs nothing but the phone.
struct AskMightyIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask MightyMouse"
    /// Answering out loud is the whole point, so don't make the user look.
    static var openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What do you want to ask?")
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let answer = try await OnDeviceModel.answer(to: question)
            return .result(dialog: IntentDialog(stringLiteral: answer))
        } catch let unavailable as OnDeviceModel.Unavailable {
            // A device without Apple Intelligence still has a paired Mac running
            // a better model — hand off when connected rather than emitting into
            // a nil bridge.
            if NativeIntentRouter.isConnected {
                NativeIntentRouter.emit(["type": "chatSend", "text": question])
                return .result(dialog: "Sent that to your Mac.")
            }
            return .result(dialog: IntentDialog(stringLiteral: unavailable.message))
        }
    }
}

struct SendToMacIntent: AppIntent {
    static var title: LocalizedStringResource = "Send text to my Mac"
    static var openAppWhenRun = true

    @Parameter(title: "Text")
    var text: String

    func perform() async throws -> some IntentResult {
        NativeIntentRouter.emit(["type": "typeText", "text": text])
        return .result()
    }
}

/// Cleans a spoken note up on-device before it lands on the Mac. The tidy-up is
/// what separates this from `SendToMacIntent`, which emits raw `typeText`.
struct StartDictationIntent: AppIntent {
    static var title: LocalizedStringResource = "Take a note with MightyMouse"
    static var openAppWhenRun = true

    @Parameter(title: "Note", requestValueDialog: "What's the note?")
    var note: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        // Tidying is a nicety, never a gate: if the model can't run, the note
        // still reaches the Mac verbatim.
        let text = (try? await OnDeviceModel.tidy(note)) ?? note
        NativeIntentRouter.emit(["type": "typeText", "text": text])
        return .result(dialog: "Noted.")
    }
}

/// Starts ChatGPT voice mode on the Mac, hands-free.
///
/// `openAppWhenRun = false`, unlike every emit-based intent above, and that is
/// the point: those reach the Mac over the WebView's socket, so they need the
/// app in the foreground. This one is an authed HTTP POST the phone can make
/// from a cold start, so the whole thing happens without a screen -- which is
/// what "start it on my computer" has to mean when the phone is in a pocket.
///
/// It always speaks. A refusal (no hotkey bound yet, Mac unreachable) carries
/// its own sentence up from `MacIntentClient`, because a silent Siri leaves the
/// user with no idea whether anything happened.
/// App target only. `MacIntentClient` reaches the Mac over authed HTTP, which
/// needs `Credentials` and `AppConfig` -- neither is a member of the widget
/// extension, and a control button has no dialog to speak the answer into
/// anyway. Same split as `NativeIntentRouter` at the top of this file.
#if !MM_WIDGET_EXTENSION
struct StartChatGptVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Start ChatGPT voice mode on my Mac"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await MacIntentClient.run(.startChatGptVoice)
        MMLog.control.log(
            "intent: startChatGptVoice ok=\(outcome.ok, privacy: .public) \(outcome.logLine, privacy: .public)"
        )
        return .result(dialog: IntentDialog(stringLiteral: outcome.spoken))
    }
}

/// Ends the call. Paired with the start intent for a reason beyond symmetry: a
/// realtime voice session bills for as long as it stays open, and the user who
/// started one by voice is by definition not at the keyboard to close it.
struct StopChatGptVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Stop ChatGPT voice mode on my Mac"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await MacIntentClient.run(.stopChatGptVoice)
        MMLog.control.log(
            "intent: stopChatGptVoice ok=\(outcome.ok, privacy: .public) \(outcome.logLine, privacy: .public)"
        )
        return .result(dialog: IntentDialog(stringLiteral: outcome.spoken))
    }
}

/// Same call, but the PHONE is the microphone.
///
/// `openAppWhenRun = true`, unlike the two intents above, and that is the whole
/// difference: the phone's mic reaches the Mac only as a track on the mirror's
/// peer connection, and WebRTC needs the WebView. So this one cannot run
/// screenless -- the app comes forward, brings an audio-only session up, and the
/// page asks the Mac to press ChatGPT's button once the mic is actually live.
///
/// Worth its own intent rather than a parameter on `StartChatGptVoiceIntent`:
/// that one's entire value is working from a pocket with no screen, and adding a
/// flag that silently changes whether the app launches would make one phrase
/// behave two ways.
struct StartChatGptVoiceWithPhoneMicIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to ChatGPT on my Mac"
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult & ProvidesDialog {
        NativeIntentRouter.emit(["type": "startChatGptVoiceWithMic"])
        MMLog.control.log("intent: startChatGptVoiceWithMic emitted")
        // No outcome to report: the page does the work after this returns, so a
        // confident "it's on" here would be a guess. The dialog says what is
        // happening, and the page surfaces any failure itself.
        return .result(dialog: "Starting voice mode on your Mac.")
    }
}

/// "Hey Siri, tell my Mac to <anything>."
///
/// The one intent that does not name what it does. Every other intent here is a
/// fixed verb, which means a new capability costs a new intent, new phrases, and
/// an App Store release before anyone can say it. This one takes the sentence
/// whole and lets the Mac decide -- so a verb added to `VERBS` in
/// main/intent-router.ts is sayable the moment the Mac updates, with no iOS
/// build at all.
///
/// Siri only has to recognise the carrier phrase ("tell my Mac to ..."); the
/// part after it is a free-text parameter it never tries to interpret.
struct TellMyMacIntent: AppIntent {
    static var title: LocalizedStringResource = "Tell my Mac to do something"
    static var openAppWhenRun = false

    @Parameter(title: "Request", requestValueDialog: "What should your Mac do?")
    var request: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await MacIntentClient.run(.say, text: request)
        MMLog.control.log(
            "intent: say ok=\(outcome.ok, privacy: .public) \(outcome.logLine, privacy: .public)"
        )
        return .result(dialog: IntentDialog(stringLiteral: outcome.spoken))
    }
}

/// "Hey Siri, what's on my Mac?" — the ship gate for the whole intent surface
///
/// The first intent that brings something BACK from the Mac instead of firing a
/// verb at it, which is why it reads as the headline: the phone in your pocket
/// answers a question about a machine in another room, with nothing open on
/// either one.
///
/// The Mac decides whether it will answer, not this file. A curtain up, away
/// mode held, or the toggle off all arrive here as an ordinary ok:false with a
/// sentence already written, so there is no privacy logic on the phone to drift
/// out of step with the Mac's.
struct WhatsOnMyMacIntent: AppIntent {
    static var title: LocalizedStringResource = "What's on my Mac"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await MacIntentClient.run(.screen)
        MMLog.control.log(
            "intent: screen ok=\(outcome.ok, privacy: .public) \(outcome.logLine, privacy: .public)"
        )
        return .result(dialog: IntentDialog(stringLiteral: outcome.spoken))
    }
}
#endif

/// The verbs that can ride INSIDE a spoken phrase.
///
/// `TellMyMacIntent` takes free text, which a phrase cannot carry -- hence its
/// two-turn exchange. An `AppEnum` is the documented exception: it IS allowed in
/// an AppShortcut phrase, so `\(\.verb)` expands to every case below and one
/// phrase template becomes one sayable sentence per case. "Lock my Mac with
/// MightyMouse" reaches the Mac in a single breath instead of carrier-then-answer.
///
/// Only argument-free verbs belong here. `openApp` and `setVolume` take an
/// argument the enum cannot express, so they stay with the free-text intent.
/// Cases mirror `MacIntentClient.Action`, which mirrors main/intent-actions.ts.
#if !MM_WIDGET_EXTENSION
enum MacVerb: String, AppEnum, CaseIterable {
    case sleep
    case startChatGptVoice
    case stopChatGptVoice

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Mac Action"

    /// Each case's synonyms are what actually widen the grammar -- Siri matches
    /// any of these titles in the phrase slot, so the count of sayable
    /// sentences is roughly phrases x titles, not phrases x cases.
    static var caseDisplayRepresentations: [MacVerb: DisplayRepresentation] = [
        .sleep: DisplayRepresentation(title: "sleep", synonyms: ["lock", "lock my Mac", "go to sleep"]),
        .startChatGptVoice: DisplayRepresentation(
            title: "start ChatGPT voice mode",
            synonyms: [
                "start ChatGPT voice chat", "start ChatGPT", "open ChatGPT voice",
                "start a voice call with ChatGPT"
            ]
        ),
        .stopChatGptVoice: DisplayRepresentation(
            title: "stop ChatGPT voice mode",
            synonyms: [
                "stop ChatGPT voice chat", "end ChatGPT voice chat", "hang up ChatGPT",
                "end my voice call with ChatGPT"
            ]
        )
    ]

    /// The enum is an iOS-side convenience; the Mac still takes the same closed
    /// action names it always did, so an older Mac build answers these unchanged.
    var action: MacIntentClient.Action {
        switch self {
        case .sleep: return .say
        case .startChatGptVoice: return .startChatGptVoice
        case .stopChatGptVoice: return .stopChatGptVoice
        }
    }

    /// `sleep` has no dedicated action -- it rides `.say` and lets the Mac's
    /// router classify it, which is exactly the path a typed sentence takes.
    var sayText: String? { self == .sleep ? "put my Mac to sleep" : nil }
}

/// Feeds the Shortcuts app the list of verbs to show as tappable options.
/// Static because the enum is the whole world -- the Mac's dynamic verb list
/// stays behind `TellMyMacIntent`, which needs no options at all.
struct MacVerbOptions: DynamicOptionsProvider {
    func results() async throws -> [MacVerb] { MacVerb.allCases }
}

/// The one-breath twin of `TellMyMacIntent`.
///
/// Same destination, different grammar: this one carries the verb in the phrase
/// so there is no second turn. It exists alongside the free-text intent rather
/// than replacing it -- the enum can only ever cover argument-free verbs, and
/// the catch-all still has to answer everything else.
struct RunMacVerbIntent: AppIntent {
    static var title: LocalizedStringResource = "Run an action on my Mac"
    static var openAppWhenRun = false

    @Parameter(title: "Action")
    var verb: MacVerb

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await MacIntentClient.run(verb.action, text: verb.sayText)
        MMLog.control.log(
            "intent: verb=\(verb.rawValue, privacy: .public) ok=\(outcome.ok, privacy: .public) \(outcome.logLine, privacy: .public)"
        )
        return .result(dialog: IntentDialog(stringLiteral: outcome.spoken))
    }
}
#endif

/// Every phrase must contain `.applicationName` -- Siri rejects the whole
/// provider at build time otherwise. Multiple phrases per intent are how the
/// same action gets reached by however the user happens to say it.
struct MightyMouseShortcuts: AppShortcutsProvider {
    /// Utterances Siri must NOT hand to us. Without these the system's own
    /// skills win the sentence first: "tell <app> to ..." resolved the app name
    /// as a CONTACT and answered "I don't see MightyMouse Dev in your contacts"
    /// (device-verified 2026-09-15, commit a5ede54b). Declaring the shape here
    /// is the supported fix; rewording our phrases around it was the workaround.
    static var negativePhrases: NegativeAppShortcutPhrases {
        NegativeAppShortcutPhrases(phrases: [
            "Tell \(.applicationName)",
            "Ask \(.applicationName) to",
            "Send a message to \(.applicationName)",
            "Call \(.applicationName)"
        ])
    }

    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenRemoteIntent(), phrases: ["Open \(.applicationName)"], shortTitle: "Open Remote", systemImageName: "computermouse")
        AppShortcut(
            intent: AskMightyIntent(),
            phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question"],
            shortTitle: "Ask MightyMouse",
            systemImageName: "text.bubble"
        )
        AppShortcut(
            intent: StartDictationIntent(),
            phrases: ["Take a note with \(.applicationName)", "New \(.applicationName) note"],
            shortTitle: "Take a Note",
            systemImageName: "square.and.pencil"
        )
        // Phrased several ways because this is the one people say out loud
        // without looking: "voice mode" is what the ChatGPT UI calls it, "voice
        // chat" is what its own settings call it, and the hotkey-less user says
        // neither and just asks for ChatGPT.
        #if !MM_WIDGET_EXTENSION
        // First in the list because it is the phrase the product is pitched on.
        // Four ways of asking the same question: people say "what's on" and
        // "what's happening on" about equally, and say "computer" as often as
        // "Mac" when they are not looking at it.
        AppShortcut(
            intent: WhatsOnMyMacIntent(),
            phrases: [
                "What's on my Mac with \(.applicationName)",
                "What's on my computer with \(.applicationName)",
                "What's happening on my Mac with \(.applicationName)",
                "Check my Mac with \(.applicationName)"
            ],
            shortTitle: "What's on my Mac",
            systemImageName: "eye"
        )
        // "Talk to" rather than "start voice mode": the phone-mic version is the
        // one a user reaches for when they are NOT at the desk, and what they
        // want to say is that they want to talk, not to operate a mode.
        AppShortcut(
            intent: StartChatGptVoiceWithPhoneMicIntent(),
            phrases: [
                "Talk to ChatGPT with \(.applicationName)",
                "Talk to ChatGPT on my Mac with \(.applicationName)",
                "\(.applicationName) talk to ChatGPT",
                // "Voice call" is what people call it when the phone is the mic
                // -- this is the path where they are holding a phone and about
                // to speak into it, so the phone word is the natural one.
                "Start a voice call with ChatGPT with \(.applicationName)",
                "\(.applicationName) start a voice call with ChatGPT"
            ],
            shortTitle: "Talk to ChatGPT",
            systemImageName: "waveform"
        )
        // Listed before the catch-all so a verb Siri can see in the sentence
        // never takes the two-turn path. `\(\.$verb)` is the parameter slot --
        // it expands to every `caseDisplayRepresentations` title and synonym, so
        // these 3 templates cover ~30 sayable sentences without a phrase list.
        AppShortcut(
            intent: RunMacVerbIntent(),
            phrases: [
                "\(\.$verb) on my Mac with \(.applicationName)",
                "\(\.$verb) on my computer with \(.applicationName)",
                "\(\.$verb) with \(.applicationName)",
                // Name-first as well as name-last: the token's POSITION is free,
                // only the "Tell <app> to ..." shape is poisoned (see below).
                "\(.applicationName) \(\.$verb) on my Mac",
                "\(.applicationName) \(\.$verb)"
            ],
            shortTitle: "Run on Mac",
            systemImageName: "bolt",
            parameterPresentation: ParameterPresentation(
                for: \.$verb,
                summary: Summary("Run \(\.$verb) on my Mac"),
                optionsCollections: {
                    OptionsCollection(MacVerbOptions(), title: "Actions", systemImageName: "bolt")
                }
            )
        )
        // The catch-all, listed after the specific phrases so Siri still
        // prefers an exact match when there is one -- "what's on my Mac" should
        // go straight to that intent rather than through a model round trip.
        // Several carriers because "tell", "ask" and "on my Mac" are all how
        // people phrase an order to another machine.
        // `\(.applicationName)` is the CARRIER here, not a trailing tag, and the
        // difference is the whole intent. Written as "Tell my Mac to
        // \(.applicationName)" the only matching sentence is "tell my Mac to
        // MightyMouse" -- so "tell my Mac to open Spotify" matched nothing,
        // Siri fell back to its own app-opening skill and answered "I can't
        // open apps from your Mac on here" without ever calling us (verified
        // 2026-09-15: zero intent lines in the Mac log for that attempt).
        //
        // The request CANNOT ride in the phrase: a String @Parameter in an
        // AppShortcut phrase is a build error ("'AppEntity' and 'AppEnum' are
        // the only allowed types"), so free text is a two-turn exchange --
        // carrier phrase, then Siri asks `requestValueDialog` and the user
        // speaks the request. Same shape as `AskMightyIntent` above.
        //
        // A spaced "Mighty Mouse" phrase is not possible here: every utterance
        // must contain `\(.applicationName)` (build error otherwise), and that
        // token only ever expands to the one-word bundle name. Matching the
        // two-word spoken form is an Info.plist alternate-name job, not a
        // phrase-list one.
        // Never phrase this as "Tell <app> to ..." — that is Siri's OWN
        // send-a-message template, so it resolves the app name as a CONTACT and
        // answers "I don't see MightyMouse Dev in your contacts" without ever
        // calling us (device-verified 2026-09-15). Same for "Ask <app> to ...".
        // Every phrase that reaches this app puts the name last, after "with".
        AppShortcut(
            intent: TellMyMacIntent(),
            phrases: [
                "Tell my Mac with \(.applicationName)",
                "Tell my computer with \(.applicationName)",
                "Run a command on my Mac with \(.applicationName)",
                "Do something on my Mac with \(.applicationName)",
                // Name FIRST is fine and reads better; what poisons a phrase is
                // the "Tell <app> to ..." shape above, not the position.
                "\(.applicationName) tell my Mac",
                "\(.applicationName) do something on my Mac",
                "\(.applicationName) run a command on my Mac"
            ],
            shortTitle: "Tell my Mac",
            systemImageName: "wand.and.stars"
        )
        AppShortcut(
            intent: StartChatGptVoiceIntent(),
            phrases: [
                "Start ChatGPT voice mode on my computer with \(.applicationName)",
                "Start ChatGPT voice mode with \(.applicationName)",
                "Start ChatGPT voice chat with \(.applicationName)",
                "Start ChatGPT on my Mac with \(.applicationName)"
            ],
            shortTitle: "ChatGPT Voice",
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: StopChatGptVoiceIntent(),
            phrases: [
                "Stop ChatGPT voice mode on my computer with \(.applicationName)",
                "Stop ChatGPT voice mode with \(.applicationName)",
                "Stop ChatGPT voice chat with \(.applicationName)",
                "End ChatGPT voice chat with \(.applicationName)",
                // The stop side of the phone-mic phrases above. One stop intent
                // serves both start paths: it ends the Mac's session and now
                // sends `voiceCallEnded`, which drops the phone's mic with it.
                "End my voice call with ChatGPT with \(.applicationName)",
                "\(.applicationName) hang up ChatGPT"
            ],
            shortTitle: "Stop ChatGPT Voice",
            systemImageName: "stop.circle"
        )
        #endif
        AppShortcut(
            intent: SendToMacIntent(),
            phrases: ["Send text to my Mac with \(.applicationName)"],
            shortTitle: "Send to Mac",
            systemImageName: "desktopcomputer"
        )
    }
}
