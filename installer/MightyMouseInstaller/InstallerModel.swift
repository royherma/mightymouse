// InstallerModel.swift — download + install state machine for the thin stub.
//
// Flow: idle -> downloading (progress 0-1) -> mounting -> copying -> launching -> done
// Any step can fail -> .failed(message), surfaced in the UI with no crash.
//
// Networking: plain URLSession download task hitting the PUBLIC release asset
// (no auth needed — royherma/mightymouse-releases is a public GitHub repo, same
// URL the web/ landing page already links to today). Nothing secret here.
//
// Install strategy: mount the downloaded dmg via `hdiutil attach`, verify the
// mounted .app's code signature is a Developer ID chain for our team (stronger
// than a static checksum — a hash can't detect "signed by the wrong identity",
// codesign can), copy to /Applications via `cp -R` (Finder-equivalent, preserves
// signature), detach, then `open` the installed app. All shelled out via Process.
//
// Retry: a dropped download retries with backoff (3 attempts) before surfacing
// a failure — see beginDownload/scheduleRetry.

import Foundation
import Combine
import AppKit

enum InstallState: Equatable {
    case idle
    case resolvingVersion
    case downloading(progress: Double)
    case mounting
    case copying
    case launching
    case done
    case cancelled
    case failed(String)
}

@MainActor
final class InstallerModel: ObservableObject {
    @Published var state: InstallState = .idle
    @Published var version: String?

    private static let latestReleaseAPI = URL(
        string: "https://api.github.com/repos/royherma/mightymouse-releases/releases/latest"
    )!

    // Stable-filename URL — matches electron-builder.yml's dmg artifactName
    // convention (${name}.${ext}) so "latest" always resolves without version
    // bumps in this stub. Same host the web/ landing page links to today.
    private static let downloadURL = URL(
        string: "https://github.com/royherma/mightymouse-releases/releases/latest/download/mightymouse.dmg"
    )!

    private var downloadTask: URLSessionDownloadTask?
    private var observation: NSKeyValueObservation?
    private var wasCancelled = false
    private var retryCount = 0
    private static let maxRetries = 3

    func start() {
        guard case .idle = state else { return }
        Task { await resolveVersionThenDownload() }
    }

    func cancel() {
        guard case .downloading = state else { return }
        wasCancelled = true
        downloadTask?.cancel()
        state = .cancelled
    }

    // Best-effort: the GitHub Releases API is unauthenticated + rate-limited,
    // so a failure here just skips the version label — never blocks the install.
    private func resolveVersionThenDownload() async {
        state = .resolvingVersion
        if let (data, _) = try? await URLSession.shared.data(from: Self.latestReleaseAPI),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let tag = json["tag_name"] as? String {
            version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        }
        beginDownload()
    }

    private func beginDownload() {
        wasCancelled = false
        state = .downloading(progress: 0)

        let session = URLSession(configuration: .default)
        let task = session.downloadTask(with: Self.downloadURL) { localURL, _, error in
            let localPath = localURL
            let errorMessage = error?.localizedDescription
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.wasCancelled { return }
                if let errorMessage {
                    self.handleDownloadFailure(errorMessage)
                    return
                }
                guard let localPath else {
                    self.handleDownloadFailure("no file received")
                    return
                }
                self.retryCount = 0
                self.installFromDownloadedFile(localPath)
            }
        }

        observation = task.progress.observe(\.fractionCompleted, options: [.new]) { progress, _ in
            let fraction = progress.fractionCompleted
            Task { @MainActor [weak self] in
                guard let self, !self.wasCancelled else { return }
                self.state = .downloading(progress: fraction)
            }
        }

        downloadTask = task
        task.resume()
    }

    // Dropped connections (Wi-Fi hiccup, GitHub CDN blip) are common on a ~300MB
    // download — retry with backoff before surfacing a hard failure.
    private func handleDownloadFailure(_ message: String) {
        guard retryCount < Self.maxRetries else {
            state = .failed("Download failed after \(Self.maxRetries) attempts: \(message)")
            return
        }
        retryCount += 1
        let delaySeconds = Double(retryCount) * 2.0
        state = .downloading(progress: 0)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard let self, !self.wasCancelled else { return }
            self.beginDownload()
        }
    }

    private func installFromDownloadedFile(_ tempURL: URL) {
        // URLSession deletes its temp file as soon as the completion handler
        // returns, so move it to a stable path first.
        let dmgPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("mightymouse-\(UUID().uuidString).dmg")
        do {
            try FileManager.default.moveItem(at: tempURL, to: dmgPath)
        } catch {
            state = .failed("Could not stage download: \(error.localizedDescription)")
            return
        }

        state = .mounting
        Task.detached { [weak self] in
            await self?.mountCopyLaunch(dmgPath: dmgPath)
        }
    }

    private func mountCopyLaunch(dmgPath: URL) async {
        do {
            let mountPoint = try Self.runProcessCapturingMountPoint(
                "/usr/bin/hdiutil", ["attach", dmgPath.path, "-nobrowse", "-noautoopen"]
            )
            await MainActor.run { self.state = .copying }

            let appName = "MightyMouse.app"
            let sourceApp = mountPoint.appendingPathComponent(appName)
            let destApp = URL(fileURLWithPath: "/Applications").appendingPathComponent(appName)

            try Self.verifySignature(of: sourceApp)

            if FileManager.default.fileExists(atPath: destApp.path) {
                try FileManager.default.removeItem(at: destApp)
            }
            try FileManager.default.copyItem(at: sourceApp, to: destApp)

            _ = try? Self.runProcess("/usr/bin/hdiutil", ["detach", mountPoint.path, "-quiet"])
            try? FileManager.default.removeItem(at: dmgPath)

            await MainActor.run { self.state = .launching }
            _ = try Self.runProcess("/usr/bin/open", [destApp.path])

            // Show "Done" briefly so success registers, then quit — the stub is
            // transient, it shouldn't linger as a dead window after the real app
            // has launched (was staying open on .done with no self-terminate).
            await MainActor.run { self.state = .done }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run { NSApp.terminate(nil) }
        } catch {
            await MainActor.run {
                self.state = .failed("Install failed: \(error.localizedDescription)")
            }
        }
    }

    // Refuses to install anything not signed by our Developer ID team. Catches a
    // corrupted download, a tampered mirror, or a signature stripped in transit —
    // all things a static checksum would also catch, but this additionally catches
    // "signed, just not by us," which a checksum cannot.
    private static let expectedTeamID = "BZJ35GS989"

    private static func verifySignature(of appURL: URL) throws {
        let output = try runProcess(
            "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appURL.path]
        )
        let info = try runProcess("/usr/bin/codesign", ["-dvvv", appURL.path])
        guard info.contains("TeamIdentifier=\(expectedTeamID)") else {
            throw NSError(
                domain: "MightyMouseInstaller", code: -2,
                userInfo: [NSLocalizedDescriptionKey:
                    "Signature check failed: unexpected team identifier. \(output) \(info)"]
            )
        }
    }

    @discardableResult
    private static func runProcess(_ path: String, _ args: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw NSError(
                domain: "MightyMouseInstaller", code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: "\(path) exited \(process.terminationStatus): \(output)"]
            )
        }
        return output
    }

    // hdiutil attach prints a table; the mount point is the last whitespace-
    // separated field of the last non-empty line.
    private static func runProcessCapturingMountPoint(_ path: String, _ args: [String]) throws -> URL {
        let output = try runProcess(path, args)
        guard let lastLine = output.split(separator: "\n").last,
              let mountField = lastLine.split(separator: "\t").last?.trimmingCharacters(in: .whitespaces),
              !mountField.isEmpty else {
            throw NSError(
                domain: "MightyMouseInstaller", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Could not parse hdiutil mount point from: \(output)"]
            )
        }
        return URL(fileURLWithPath: mountField)
    }
}
