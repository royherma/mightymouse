import Foundation

/// A `URLSession` that accepts the Mac's self-signed certificate on the LAN.
///
/// `URLSession.shared` cannot: it takes no delegate, so every HTTPS call to the
/// Mac fails TLS validation before the request is sent. The webview had this
/// covered by `NativeBridge`'s challenge handler and nothing else did, so
/// `/pair` and the cached-host probe were failing as "can't reach your Mac"
/// against a Mac that was awake and answering.
enum LanSession {
    static let shared: URLSession = URLSession(
        configuration: .ephemeral,
        delegate: TrustLocalCertificates(),
        delegateQueue: nil
    )

    /// Lives here rather than on `NativeBridge` because the Notification
    /// Service Extension compiles this file and cannot compile that one (it
    /// pulls in WebKit and the whole app-only bridge). Pure string logic with
    /// no dependencies, so both targets share the one definition.
    static func isPrivateHost(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".").compactMap { UInt8($0) }
        guard parts.count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (10, _): return true
        case (192, 168): return true
        case (172, 16...31): return true
        case (127, _): return true
        default: return false
        }
    }
}

/// Trusts a self-signed cert ONLY from an RFC1918 host, matching the rule the
/// webview uses. A public host still gets default validation -- the tunnel is
/// fronted by a real certificate, so nothing legitimate needs an exception.
private final class TrustLocalCertificates: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let host = challenge.protectionSpace.host.lowercased()
        guard LanSession.isPrivateHost(host),
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
