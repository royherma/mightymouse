import Foundation
import Network

/// Finds candidate hosts for the Mac on the LAN. Reports only "here is a URL
/// that answered" or "the OS refused to let me look" -- never a UI state. The
/// deck decides what a candidate means; Discovery only supplies one.
///
/// `NWBrowser` rather than `NetServiceBrowser`: under a denied Local Network
/// permission the legacy browser just goes silent, making "the user said no"
/// indistinguishable from "no Mac here". NWBrowser reports it as
/// `.waiting(.dns(kDNSServiceErr_PolicyDenied))` and resumes by itself once the
/// permission is granted in Settings, with no relaunch.
final class Discovery {
    private var browser: NWBrowser?
    private var connections: [NWConnection] = []
    var onFound: ((URL) -> Void)?
    /// iOS denied Local Network — permanent until Settings changes, no sweep
    /// can fix it. Only fires once the tunnel has also missed (`reportBlocked`).
    var onBlocked: (() -> Void)?
    /// Every sweep ends here, hit or miss. Without a consumer the miss path
    /// emits telemetry and nothing else, which is what left the launch screen
    /// spinning forever with no way out.
    var onOutcome: ((String) -> Void)?
    var onSweepStart: (() -> Void)?

    /// The tunnel host to fall back on, held on the instance because the two
    /// denial sites (browse, resolve) can't reach the call that knew the host.
    private var tunnelFallback: String?

    /// Set when a denial already spent the tunnel rung, so the second denial
    /// site reports straight through instead of probing the same host again.
    private var tunnelFallbackSpent = false

    /// How long a sweep may run before it counts as "no Mac here". Bonjour
    /// never reports "finished, found nothing" — blocked and empty both stay
    /// quiet — so without a deadline the likeliest failure emits no event.
    private static let sweepTimeout: TimeInterval = 8

    /// Guards the outcome event so one sweep reports once. A resolve and the
    /// timer keep their own schedules, so both paths can race.
    private var outcomeReported = false
    private var timeoutTimer: Timer?

    /// How long the cached host gets before the sweep starts anyway. Short on
    /// purpose: this races a machine one hop away on the same Wi-Fi.
    private static let cachedProbeTimeout: TimeInterval = 1.5

    /// The service the Mac advertises. `_https._tcp` is also in `NSBonjourServices`;
    /// iOS will not browse a type absent from that list.
    private static let serviceType = "_https._tcp"

    /// Try the last-known address before sweeping. An RFC1918 request trips the
    /// Local Network prompt exactly like Bonjour — a miss just costs one short request.
    func startWithCachedHost(_ cached: URL, tunnelHost: String? = nil) {
        MMLog.discovery.log("cached host probe → \(cached.absoluteString, privacy: .public)")
        stopped = false
        rememberTunnelFallback(tunnelHost)
        probe(cached, label: "cached host") { [weak self] hit in
            guard let self else { return }
            if hit { return }
            self.startWithTunnelHost(tunnelHost)
        }
    }

    /// The off-LAN rung: the Mac's public tunnel hostname, needing no Local
    /// Network permission. Runs AFTER the cached LAN probe, never racing it —
    /// racing would have to reconcile a denied LAN probe against a tunnel win.
    func startWithTunnelHost(_ tunnelHost: String?) {
        guard let tunnelHost, !tunnelHost.isEmpty,
              let url = URL(string: "https://\(tunnelHost)/") else {
            start()
            return
        }
        MMLog.discovery.log("tunnel host probe → \(tunnelHost, privacy: .public)")
        stopped = false
        rememberTunnelFallback(tunnelHost)
        probe(url, label: "tunnel host") { [weak self] hit in
            guard let self, !hit else { return }
            self.start()
        }
    }

    /// Holds the host for the denial path, which runs later and elsewhere.
    private func rememberTunnelFallback(_ tunnelHost: String?) {
        guard let tunnelHost, !tunnelHost.isEmpty else { return }
        tunnelFallback = tunnelHost
        tunnelFallbackSpent = false
    }

    /// Terminal only when there's no public address to fall back on — the
    /// permission governs the LAN, not the internet. Both denial sites (browse,
    /// resolve) route through here; the spent flag stops a re-probe of the same host.
    private func reportBlocked() {
        guard let tunnelHost = tunnelFallback, !tunnelFallbackSpent,
              let url = URL(string: "https://\(tunnelHost)/") else {
            reportOutcome(DiscoveryOutcome.blocked)
            Task { @MainActor in self.onBlocked?() }
            return
        }
        tunnelFallbackSpent = true
        MMLog.discovery.log("Local Network denied → trying the tunnel, which does not need it")
        probe(url, label: "tunnel host (after denial)") { [weak self] hit in
            guard let self, !hit else { return }
            // The tunnel missed too, so the permission is genuinely the wall.
            self.reportOutcome(DiscoveryOutcome.blocked)
            Task { @MainActor in self.onBlocked?() }
        }
    }

    /// One `/whoami` request against a known address. `completion(true)` means it
    /// answered as MightyMouse and `onFound` has already fired; `false` means the
    /// caller should try its next rung.
    private func probe(_ url: URL, label: String, completion: @escaping (Bool) -> Void) {
        let era = generation
        var request = URLRequest(url: url.appendingPathComponent("whoami"))
        request.timeoutInterval = Self.cachedProbeTimeout
        LanSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let self, era == self.generation else { return }
            let app = data
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                .flatMap { $0["app"] as? String }
            guard app == "mightymouse" else {
                MMLog.discovery.log(
                    "\(label, privacy: .public) miss (\(error?.localizedDescription ?? "not mightymouse", privacy: .public))"
                )
                completion(false)
                return
            }
            MMLog.discovery.log("\(label, privacy: .public) HIT → skipping sweep")
            self.reportOutcome(DiscoveryOutcome.found)
            self.onFound?(url)
            completion(true)
        }.resume()
    }

    func start() {
        onSweepStart?()
        outcomeReported = false
        // Reopens the gate a previous stop() closed, so an explicit "Look again"
        // after an unpair is heard again.
        generation &+= 1
        stopped = false
        let era = generation

        browser?.cancel()
        let browser = NWBrowser(
            for: .bonjour(type: Self.serviceType, domain: nil),
            using: .tcp
        )
        self.browser = browser

        MMLog.discovery.log("bonjour sweep start (timeout \(Self.sweepTimeout, privacy: .public)s)")
        // The first sweep is what makes iOS show the Local Network alert, so
        // this is the only honest place to count a phone as having been asked.
        // Once per install: later sweeps reuse the answer without a prompt.
        if !Prefs.localNetworkPrimed {
            Prefs.localNetworkPrimed = true
            Task { @MainActor in Analytics.shared.track(AnalyticsEvent.localNetworkPrimed) }
        }

        browser.stateUpdateHandler = { [weak self] state in
            guard let self, era == self.generation else { return }
            // The denial signal this class was rewritten for. It arrives as a
            // WAITING state, not a failure: the browse is parked, and iOS
            // resumes it by itself if the user grants the permission later.
            if case .waiting(let error) = state, Self.isPermissionDenied(error) {
                MMLog.discovery.error("Local Network DENIED — browse is parked until Settings changes")
                self.reportBlocked()
                return
            }
            if case .failed(let error) = state {
                MMLog.discovery.error("browse failed: \(String(describing: error), privacy: .public)")
                self.reportOutcome(DiscoveryOutcome.unresolved)
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self, era == self.generation else { return }
            for result in results {
                guard case .service(let name, _, _, _) = result.endpoint else { continue }
                guard name.lowercased().contains("mightymouse") else {
                    MMLog.discovery.log("browse saw \(name, privacy: .public) — not ours, skipping")
                    continue
                }
                MMLog.discovery.log("browse MATCHED \(name, privacy: .public) → resolving")
                self.resolve(result.endpoint, era: era)
            }
        }

        browser.start(queue: .main)

        timeoutTimer?.invalidate()
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: Self.sweepTimeout, repeats: false) { [weak self] _ in
            MMLog.discovery.error("bonjour sweep TIMED OUT — no Mac found")
            self?.reportOutcome(DiscoveryOutcome.notFound)
        }
    }

    /// A browse result names a service, not an address. One short connection is
    /// what turns it into the host:port the webview can load.
    private func resolve(_ endpoint: NWEndpoint, era: UInt) {
        let connection = NWConnection(to: endpoint, using: .tcp)
        connections.append(connection)
        MMLog.discovery.log("resolve START (\(self.connections.count, privacy: .public) in flight)")
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, era == self.generation else { return }
            switch state {
            case .ready:
                guard let path = connection.currentPath,
                      case .hostPort(let host, let port) = path.remoteEndpoint else {
                    connection.cancel()
                    return
                }
                connection.cancel()
                // `stopped` and NOT `outcomeReported`: the latter is also true
                // after a sweep timeout, and a resolve landing just past that
                // deadline is a working Mac we still want.
                guard !self.stopped else { return }
                let address = Self.literal(host)
                MMLog.discovery.log("resolved \(address, privacy: .public):\(port.rawValue, privacy: .public)")
                self.reportOutcome(DiscoveryOutcome.found)
                self.onFound?(URL(string: "https://\(address):\(port.rawValue)/")!)
                self.browser?.cancel()
            case .failed(let error):
                MMLog.discovery.error("service found but did NOT resolve: \(String(describing: error), privacy: .public)")
                self.reportOutcome(DiscoveryOutcome.unresolved)
                connection.cancel()
            case .waiting(let error):
                // A resolve hits the denial too when the browse was already
                // running as the user answered the alert.
                guard Self.isPermissionDenied(error) else {
                    MMLog.discovery.error("resolve WAITING (not a denial): \(String(describing: error), privacy: .public)")
                    return
                }
                self.reportBlocked()
                connection.cancel()
            default:
                MMLog.discovery.log("resolve state \(String(describing: state), privacy: .public)")
            }
        }
        connection.start(queue: .main)
    }

    /// `kDNSServiceErr_PolicyDenied` (-65570) is what a denied Local Network
    /// permission surfaces as. `localNetworkDenied` covers the direct-connection
    /// form of the same refusal.
    private static func isPermissionDenied(_ error: NWError) -> Bool {
        if case .dns(let code) = error, code == DNSServiceErrorType(kDNSServiceErr_PolicyDenied) {
            return true
        }
        return false
    }

    /// An `NWEndpoint.Host` prints IPv6 with its scope (`fe80::1%en0`), which is
    /// not valid inside a URL. Strip it, and bracket a v6 literal.
    private static func literal(_ host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let address):
            return "\(address)".components(separatedBy: "%")[0]
        case .ipv6(let address):
            return "[\("\(address)".components(separatedBy: "%")[0])]"
        case .name(let name, _):
            return name.hasSuffix(".") ? String(name.dropLast()) : name
        @unknown default:
            return ""
        }
    }

    /// Halt discovery and disown everything in flight. Cancelling the browser
    /// alone isn't enough — the cached-host probe and each resolve hold their
    /// own live task/connection and would still fire `onFound`; bumping generation makes those results stale.
    func stop() {
        MMLog.discovery.log("discovery stopped")
        generation &+= 1
        stopped = true
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        browser?.cancel()
        browser = nil
        connections.forEach { $0.cancel() }
        connections.removeAll()
    }

    /// Incremented by `stop()`. Any callback captured under an older value is a
    /// result for a sweep nobody is waiting for any more, and drops itself.
    private var generation: UInt = 0

    /// True between `stop()` and the next `start()`. Distinct from
    /// `outcomeReported`, which is about reporting analytics once per sweep.
    private var stopped = false

    /// First outcome wins, ending the sweep's reporting window. Telemetry only
    /// now -- no UI state to settle, so every terminal branch just reports once.
    private func reportOutcome(_ outcome: String) {
        guard !outcomeReported else { return }
        outcomeReported = true
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        Task { @MainActor in
            Analytics.shared.track(AnalyticsEvent.discoveryResult, ["outcome": outcome])
            self.onOutcome?(outcome)
        }
    }
}
