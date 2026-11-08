import Foundation

/// Runs ONE named action on the paired Mac and gets back a sentence to speak.
///
/// Thin on purpose: `MacRelayClient.post` already owns host resolution, the
/// device credential and the 401-means-re-pair split, and its own doc comment
/// names this design as the thing that should reuse it rather than opening a
/// second client. All this adds is the `/intent` envelope and the rule that
/// every outcome -- including a refusal -- comes back as something speakable.
///
/// Why the Mac answers 200 on a refusal: Siri surfaces a non-2xx as "MightyMouse
/// isn't responding", which buries the one sentence that tells the user what to
/// fix. So the transport succeeds and the BODY carries ok:false plus its own
/// spoken line (see handleIntent in phone-remote/http-handlers.ts).
enum MacIntentClient {
    /// What the user hears. `ok` is kept apart from the sentence so a caller can
    /// branch (analytics, a retry) without parsing prose.
    struct Outcome {
        let ok: Bool
        let spoken: String
        /// The Mac's structured account of what it did, logged rather than
        /// spoken. A voice failure is the hardest kind to debug -- nobody is
        /// looking at a screen when it happens -- so the one artifact that
        /// survives is this line in the device log.
        var meta: [String: Any] = [:]

        /// Compact `key=value` rendering for a log line. Sorted so two runs of
        /// the same outcome produce comparable text.
        var logLine: String {
            meta.keys.sorted()
                .map { "\($0)=\(meta[$0].map { String(describing: $0) } ?? "")" }
                .joined(separator: " ")
        }
    }

    /// The Mac-side action names. A closed list here mirrors the closed table in
    /// main/intent-actions.ts -- an intent cannot name an action the Mac does
    /// not have, and neither side can drift without the other failing to build.
    enum Action: String {
        case startChatGptVoice
        case stopChatGptVoice
        /// Reads the Mac's screen rather than pressing something on it, so it is
        /// the one action the Mac can refuse on privacy grounds. That refusal
        /// arrives as ok:false plus its own sentence, like every other.
        case screen
        /// The open-ended one. Carries the user's sentence instead of naming a
        /// verb, because the phone does not know what verbs the Mac has -- the
        /// Mac's model picks one (main/intent-router.ts). This is why adding a
        /// capability needs no iOS release: the list it chooses from lives on
        /// the Mac, and this case never changes.
        case say
    }

    /// Never throws. Every failure -- no paired Mac, a dead credential, a
    /// timeout -- has to become a sentence, because the caller is a Siri
    /// response and silence there is indistinguishable from a broken app.
    static func run(
        _ action: Action,
        text: String? = nil,
        credentials: Credentials = Credentials()
    ) async -> Outcome {
        do {
            var body: [String: Any] = ["action": action.rawValue]
            // Only `say` carries text; the named actions send exactly what they
            // always sent, so an old Mac build keeps answering them.
            if let text { body["text"] = text }
            let data = try await MacRelayClient.post(
                AppConfig.intentPath,
                credentials: credentials,
                body: body
            )
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            // A 200 whose body we can't read is still a failure, not a success:
            // the Mac's own refusals arrive as 200 + ok:false, so trusting the
            // status alone would report every one of them as done.
            guard let body = json, let spoken = body["spoken"] as? String else {
                return Outcome(ok: false, spoken: "Your Mac answered, but I couldn't read it.")
            }
            return Outcome(
                ok: body["ok"] as? Bool ?? false,
                spoken: spoken,
                meta: body["meta"] as? [String: Any] ?? [:]
            )
        } catch MacRelayClient.RelayError.noHost {
            return Outcome(ok: false, spoken: "I don't know where your Mac is yet. Open MightyMouse on your phone once while it's nearby.")
        } catch MacRelayClient.RelayError.noCredential {
            return Outcome(ok: false, spoken: "This phone isn't paired with your Mac yet.")
        } catch MacRelayClient.RelayError.unauthorized {
            // Distinct from noCredential on purpose: a credential exists and the
            // Mac has stopped honouring it, so the fix is pairing again, not
            // pairing for the first time.
            return Outcome(ok: false, spoken: "Your Mac stopped recognising this phone. Pair it again in MightyMouse.")
        } catch {
            return Outcome(ok: false, spoken: "I couldn't reach your Mac.")
        }
    }
}
