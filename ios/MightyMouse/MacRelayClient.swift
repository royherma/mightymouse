import Foundation

/// The one authed HTTP client for stateless requests to the paired Mac --
/// `mac-as-an-intent-target` (draft, no Swift yet) is to reuse this rather
/// than opening a second one. Every call is fire-and-forget request/response;
/// nothing here remembers a connection (ios/CLAUDE.md: Swift owns no
/// connection state). The live deck's own socket is untouched by this.
enum MacRelayClient {
    enum RelayError: Error, Equatable {
        case noHost
        case noCredential
        case badResponse
        /// The Mac answered, and refused us: this phone's device credential is
        /// no longer one it knows (a re-pair, a "Forget paired devices", a dev
        /// re-sign changing the safeStorage identity). Split out of
        /// `badResponse` because the two need OPPOSITE handling -- a 5xx or a
        /// dropped tunnel is worth retrying and this can only ever be fixed by
        /// pairing again, so collapsing them left a tapped answer failing
        /// forever in silence.
        case unauthorized
    }

    /// Maps the Mac's reply onto the error a caller can act on. 401 is the one
    /// status the server uses for a credential it does not recognise
    /// (`server.ts` `invalid-credential`), so it is the only one that means
    /// "re-pair" rather than "try again later".
    private static func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw RelayError.badResponse }
        if http.statusCode == 401 { throw RelayError.unauthorized }
        guard 200..<300 ~= http.statusCode else { throw RelayError.badResponse }
    }

    /// Leaves an answer in the cloud when the Mac cannot be reached. Authed by
    /// the device credential, NOT a Supabase session -- this phone never signed
    /// in; the Mac registered that credential's HMAC when it sent the push.
    static func postAnswerToCloud(requestId: String, credentials: Credentials, body: [String: Any]) async throws {
        guard let cred = credential(credentials) else { throw RelayError.noCredential }

        var payload: [String: Any] = ["requestId": requestId, "answerSecret": cred]
        // Only answer-shaped fields cross: `credential` is the Mac's own auth
        // field and must never be copied through from the direct-path body.
        for key in ["answer", "approved", "dismissed"] {
            if let value = body[key] { payload[key] = value }
        }

        var request = URLRequest(url: AppConfig.supabaseURL.appendingPathComponent("functions/v1/agent-relay-answer"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The gateway rejects a call with no `Authorization` BEFORE the function
        // runs -- `apikey` alone is UNAUTHORIZED_NO_AUTH_HEADER. Authorizes
        // nothing itself; `answerSecret` is what this call proves.
        request.setValue("Bearer \(AppConfig.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (_, response) = try await URLSession.shared.data(for: request)
        try validate(response)
    }

    /// `Prefs.lastRemoteURL` names the last Mac this phone actually reached --
    /// the same address the lobby probes first on a cold launch. Falls back to
    /// the App Group mirror because `Prefs` is `UserDefaults.standard`, which
    /// the Notification Service Extension (a separate process) cannot read;
    /// the app writes both, so this only ever differs inside the extension.
    private static var baseURL: URL? {
        Prefs.lastRemoteURL
            ?? SharedAppGroup.defaults.string(forKey: SharedAppGroup.lastRemoteURLKey).flatMap(URL.init(string:))
    }

    /// The device credential `/pair` minted, mirrored into the Keychain by the
    /// web bundle under `Credentials.webKeyPrefix` (`NativeBridge.storeCredential`).
    private static func credential(_ credentials: Credentials) -> String? {
        credentials.value(for: Credentials.webKeyPrefix + AppConfig.deviceCredentialKey)
    }

    /// POSTs a JSON body to `path` on the paired Mac, authed by the device
    /// credential. Returns silently on any failure -- callers that need to
    /// react to a failure inspect the thrown error, but nothing here retries:
    /// a stale host or a dead credential resolves itself on the NEXT launch's
    /// call, per PRD §6c ("re-registered on every launch, invisible").
    @discardableResult
    static func post(
        _ path: String,
        credentials: Credentials,
        body: [String: Any]
    ) async throws -> Data {
        guard let base = baseURL else { throw RelayError.noHost }
        guard let cred = credential(credentials) else { throw RelayError.noCredential }

        var request = URLRequest(url: base.appending(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload = body
        payload["credential"] = cred
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await LanSession.shared.data(for: request)
        try validate(response)
        return data
    }

    /// GETs `path?query` on the paired Mac, authed the same way as `post`.
    /// The NSE's only use of this client -- it fetches a relay request's real
    /// content, never sends one (that's a `post`, see `respondToRelayRequest`).
    static func get(
        _ path: String,
        credentials: Credentials,
        query: [String: String] = [:],
        baseURL overrideBaseURL: URL? = nil
    ) async throws -> Data {
        guard let base = overrideBaseURL ?? baseURL else { throw RelayError.noHost }
        guard let cred = credential(credentials) else { throw RelayError.noCredential }

        var components = URLComponents(url: base.appending(path), resolvingAgainstBaseURL: false)
        components?.queryItems = query.merging(["credential": cred]) { _, new in new }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let url = components?.url else { throw RelayError.badResponse }

        let (data, response) = try await LanSession.shared.data(from: url)
        try validate(response)
        return data
    }
}

private extension URL {
    /// Joins a leading-slash path onto a base that already ends in one.
    /// `appendingPathComponent` does NOT collapse the pair: with
    /// `https://host:17771/` + `/push-token` it yields `//push-token`, which
    /// misses the Mac's exact-match route table and falls through to the static
    /// handler -- so the phone gets a 200 and `index.html`, logs "uploaded",
    /// and NOTHING is stored. Every path constant in `AppConfig` carries a
    /// leading slash, so this affects every call this client makes.
    func appending(_ path: String) -> URL {
        appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
    }
}
