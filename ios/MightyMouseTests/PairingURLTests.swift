import XCTest
@testable import MightyMouse

/// `AppModel.pairingURL(from:)` is the QR scan gate: the only filter between an
/// attacker-suppliable scanned string and `remoteURL`, which mounts the deck.
/// Two shipped bugs lived at this seam ("scan only worked once", "never mount
/// an origin-down page as the deck"), so the accepted shape is locked here.
@MainActor
final class PairingURLTests: XCTestCase {
    func testAcceptsHttpsWithHostAndKeepsQueryVerbatim() {
        let url = AppModel.pairingURL(from: "https://mightymouse.local:17771/?c=123456")
        XCTAssertNotNil(url)
        XCTAssertEqual(url?.host, "mightymouse.local")
        // The deck spends `?c=` on POST /pair — Swift must pass it through untouched.
        XCTAssertEqual(url?.query, "c=123456")
    }

    func testAcceptsTunnelHostname() {
        let url = AppModel.pairingURL(from: "https://example.trycloudflare.com/?c=654321")
        XCTAssertEqual(url?.host, "example.trycloudflare.com")
    }

    func testRejectsPlainHttp() {
        XCTAssertNil(AppModel.pairingURL(from: "http://mightymouse.local:17771/?c=123456"))
    }

    func testRejectsForeignNonURLPayload() {
        XCTAssertNil(AppModel.pairingURL(from: "WIFI:T:WPA;S:HomeNetwork;P:hunter2;;"))
    }

    func testRejectsSchemeOnlyAndEmptyHost() {
        XCTAssertNil(AppModel.pairingURL(from: "https://"))
        XCTAssertNil(AppModel.pairingURL(from: "https:///pair?c=123456"))
    }

    func testRejectsEmptyString() {
        XCTAssertNil(AppModel.pairingURL(from: ""))
    }
}
