// ContentView.swift — the entire stub UI. One screen, no navigation: glyph,
// status line, progress bar. Colors pulled from THEME_TOKENS (src/shared/config.ts)
// — dark bg to match the glyph's own dark surfaces (#0e1320/#161c2e), orange
// accent for the progress fill and "MightyMouse" wordmark.

import SwiftUI

struct ContentView: View {
    @ObservedObject var model: InstallerModel

    // THEME_TOKENS.accent
    static let accent = Color(red: 255 / 255, green: 160 / 255, blue: 80 / 255)
    static let bg = Color(red: 0x0e / 255, green: 0x13 / 255, blue: 0x20 / 255)
    static let muted = Color(white: 0.6)

    var body: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 8)

            MouseGlyphView(size: 88)

            Text("MightyMouse")
                .font(.system(size: 20, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)

            Text(statusText)
                .font(.system(size: 13))
                .foregroundStyle(Self.muted)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(height: 34)

            progressBar

            cancelButton

            Spacer(minLength: 8)
        }
        .padding(.horizontal, 36)
        .padding(.vertical, 28)
        .frame(width: 340, height: 320)
        .background(Self.bg)
        .onAppear { model.start() }
    }

    @ViewBuilder
    private var cancelButton: some View {
        if case .downloading = model.state {
            Button("Cancel") { model.cancel() }
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(Self.muted)
        } else {
            // Reserve the row's height so the layout doesn't jump when the
            // button appears/disappears.
            Text(" ").font(.system(size: 12)).hidden()
        }
    }

    @ViewBuilder
    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.white.opacity(0.08))
                RoundedRectangle(cornerRadius: 4)
                    .fill(Self.accent)
                    .frame(width: geo.size.width * fraction)
                    .animation(.easeOut(duration: 0.2), value: fraction)
            }
        }
        .frame(height: 6)
    }

    private var fraction: CGFloat {
        switch model.state {
        case .idle, .resolvingVersion: return 0
        case .downloading(let p): return max(0.02, CGFloat(p))
        case .mounting, .copying: return 1.0
        case .launching, .done: return 1.0
        case .cancelled, .failed: return 0
        }
    }

    private var statusText: String {
        // Empty until the releases API answers; it's best-effort, so every line
        // below has to read correctly with no version at all.
        let v = model.version.map { " \($0)" } ?? ""
        switch model.state {
        case .idle, .resolvingVersion:
            return "Starting…"
        case .downloading(let p):
            return "Downloading MightyMouse\(v)… \(Int(p * 100))%"
        case .mounting:
            return "Preparing install…"
        case .copying:
            return "Installing MightyMouse\(v) to Applications…"
        case .launching:
            return "Launching MightyMouse\(v)…"
        case .done:
            return "Done — MightyMouse\(v) is installed!"
        case .cancelled:
            return "Download cancelled."
        case .failed(let message):
            return message
        }
    }
}
