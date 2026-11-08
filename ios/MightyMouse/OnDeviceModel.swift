import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple's on-device model, wrapped so an intent can ask it a question without
/// launching the app.
///
/// This exists because every other intent in `Intents.swift` sets
/// `openAppWhenRun`, which is unavoidable for them: typing at the Mac's cursor
/// needs the webview's socket, and `NativeIntentRouter.bridge` is nil until
/// `RemoteWebView.makeUIView` has run. Asking a question is the one thing that
/// needs no Mac at all, so it can answer inside Siri.
///
/// The model runs entirely on the phone -- no network, no MightyMouse account,
/// nothing metered. That also means it knows nothing about the user's Mac.
/// Anything needing the Mac belongs on the `chatSend` path instead.
enum OnDeviceModel {
    /// Why a request could not be served, in the order the caller should care
    /// about. `.unsupportedOS` covers both an iOS 25 device and a build whose
    /// SDK predates the framework.
    enum Unavailable: Equatable {
        case unsupportedOS
        case deviceNotEligible
        case appleIntelligenceNotEnabled
        case modelNotReady

        /// Spoken by Siri, so it has to say what to DO, not what broke.
        var message: String {
            switch self {
            case .unsupportedOS:
                return "This needs iOS 26 or later."
            case .deviceNotEligible:
                return "This iPhone doesn't support Apple Intelligence."
            case .appleIntelligenceNotEnabled:
                return "Turn on Apple Intelligence in Settings to ask me things."
            case .modelNotReady:
                return "Apple Intelligence is still downloading. Try again shortly."
            }
        }
    }

    /// Keeps replies short because the answer is usually SPOKEN. The model's
    /// default register is a paragraph, which is fine on screen and far too
    /// long out loud.
    private static let instructions = """
        You are MightyMouse, a concise assistant on the user's iPhone.
        Answer in at most three sentences, in plain spoken language.
        If you don't know something, say so briefly instead of guessing.
        """

    /// Caps a runaway generation: Siri cuts off long speech anyway, and the
    /// user is waiting on the result before anything else happens.
    private static let maxTokens = 300

    static var availability: Unavailable? {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else { return .unsupportedOS }
        switch SystemLanguageModel.default.availability {
        case .available:
            return nil
        case .unavailable(.deviceNotEligible):
            return .deviceNotEligible
        case .unavailable(.appleIntelligenceNotEnabled):
            return .appleIntelligenceNotEnabled
        case .unavailable(.modelNotReady):
            return .modelNotReady
        // `UnavailableReason` is not frozen: a future OS can add a case, and
        // treating that as "not ready" tells the user to retry rather than
        // sending them to a Settings toggle that isn't the problem.
        @unknown default:
            return .modelNotReady
        }
        #else
        return .unsupportedOS
        #endif
    }

    /// Punctuates and de-ums a dictated note, returning ONLY the cleaned text.
    /// Separate from `answer` because a "tidied" note the model decided to
    /// summarise has destroyed what the user said — hence the length guard.
    static func tidy(_ note: String) async throws -> String {
        let cleaned = try await complete(
            instructions: """
                You fix up dictated text. Add punctuation and capitalisation and
                remove filler words like "um" and "uh".
                Do not summarise, answer, or add anything. Do not change the
                wording. Reply with the corrected text and nothing else.
                """,
            prompt: note
        )
        // A tidy-up that lost a third of the note means the model summarised
        // instead of punctuating. The original is always the safer artifact.
        return cleaned.count < note.count * 2 / 3 ? note : cleaned
    }

    /// Answers `question` on-device. Throws `Unavailable` when the model can't
    /// run, so the caller can speak the reason rather than a generic failure.
    static func answer(to question: String) async throws -> String {
        try await complete(instructions: instructions, prompt: question)
    }

    private static func complete(instructions: String, prompt: String) async throws -> String {
        if let unavailable = availability { throw unavailable }

        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else { throw Unavailable.unsupportedOS }
        // Built per call rather than held as a stored session: an intent is a
        // fresh process more often than not, and a retained session would carry
        // one question's transcript into an unrelated later one.
        let session = LanguageModelSession(instructions: instructions)
        let options = GenerationOptions(maximumResponseTokens: maxTokens)
        let response = try await session.respond(to: prompt, options: options)
        return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        #else
        throw Unavailable.unsupportedOS
        #endif
    }
}

extension OnDeviceModel.Unavailable: LocalizedError {
    var errorDescription: String? { message }
}
