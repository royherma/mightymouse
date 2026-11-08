import SwiftUI

// The SwiftUI twins of src/renderer/src/components/. Same rule as the renderer
// (docs/conventions.md): check whether a primitive exists before writing a view,
// and never inline a color/radius/font literal -- if a value is not in
// MMColor/MMRadius/MMSpace/MMFont it is not a MightyMouse value.
//
// Only what the native screens actually render is here. No speculative variants.

// MARK: - Screen

/// The one place a native screen's outer geometry is defined, so the two
/// full-screen views cannot disagree about it.
///
/// `ScrollView` does NOT inset for the home indicator or the notch on its own --
/// both screens shipped with the title under the Dynamic Island and the last
/// control sliced off the bottom edge. `safeAreaPadding` adds the device inset on
/// top of our own rhythm rather than replacing it, which is why the pixel gap
/// differs per device and must never be a literal.
struct MMScreen<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            content
                .padding(.horizontal, MMSpace.five)
                .padding(.vertical, MMSpace.six)
                .frame(maxWidth: .infinity)
        }
        .safeAreaPadding(.vertical)
        .background(MMColor.bg)
    }
}

// MARK: - Elevation

/// `shadowCard` from `THEME_TOKENS` — the neumorphic raised control. Needs BOTH
/// halves or the surface flattens.
///
/// The panel and bubble elevations went with the primitives that used them; add
/// one back from `THEME_TOKENS` when a view actually needs it.
struct MMCardElevation: ViewModifier {
    func body(content: Content) -> some View {
        content
            .shadow(color: MMColor.grayMuted.opacity(0.35), radius: 6, x: 4, y: 4)
            .shadow(color: .white.opacity(0.80), radius: 6, x: -4, y: -4)
    }
}

// MARK: - Buttons

enum MMButtonKind {
    case primary    // accent fill — one per screen, the dominant action (DESIGN.md §9)
    case secondary  // surface fill, for the alternative
    case borderless // underlined text, for the escape hatch
}

/// `.buttonStyle(.plain)` strips UIKit's press feedback and puts nothing back, so
/// every control read as dead on touch. Scale + dim is the whole affordance.
struct MMPressStyle: ButtonStyle {
    /// Filled controls take the scale; a text link would jitter, so it only dims.
    let lift: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(lift && configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.72 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct MMButton: View {
    let title: String
    let kind: MMButtonKind
    /// Renders a spinner in place of the label and blocks the tap. Every async
    /// action must pass this -- DESIGN.md §11 requires the state change to be
    /// visible.
    var loading: Bool = false
    var systemImage: String?
    let action: () -> Void

    init(
        _ title: String,
        kind: MMButtonKind = .primary,
        loading: Bool = false,
        systemImage: String? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.kind = kind
        self.loading = loading
        self.systemImage = systemImage
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: MMSpace.two) {
                if loading {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(foreground)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: MMFont.md, weight: .semibold))
                }
                Text(loading ? "Working…" : title)
                    .font(.system(size: MMFont.lg, weight: .semibold))
                    // The escape hatch has no fill and no border, so the underline
                    // is the only thing separating it from body copy.
                    .underline(kind == .borderless)
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, MMSpace.five)
            .padding(.vertical, MMSpace.three)
            .frame(maxWidth: kind == .borderless ? nil : .infinity)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: MMRadius.md, style: .continuous))
            .overlay(border)
        }
        .buttonStyle(MMPressStyle(lift: kind != .borderless))
        .disabled(loading)
        .opacity(loading ? 0.85 : 1)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return MMColor.onAccent
        case .secondary: return MMColor.onSurface
        // Was textMutedDark, which sat at body-copy weight and read as disabled.
        case .borderless: return MMColor.onSurface
        }
    }

    @ViewBuilder private var background: some View {
        switch kind {
        case .primary: MMColor.accent
        case .secondary: MMColor.surface1
        case .borderless: Color.clear
        }
    }

    @ViewBuilder private var border: some View {
        switch kind {
        case .primary:
            RoundedRectangle(cornerRadius: MMRadius.md, style: .continuous)
                .strokeBorder(MMColor.accentBorderSubtle, lineWidth: 1)
        case .secondary:
            RoundedRectangle(cornerRadius: MMRadius.md, style: .continuous)
                .strokeBorder(MMColor.surfaceBorderAlt, lineWidth: 1)
        case .borderless:
            EmptyView()
        }
    }
}

// MARK: - Card

/// A grouped block on a screen that offers more than one route. Without it the
/// lobby's two offers read as one long column of unrelated controls.
struct MMCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: MMSpace.three) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MMSpace.four)
        .background(MMColor.surface1)
        .clipShape(RoundedRectangle(cornerRadius: MMRadius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MMRadius.lg, style: .continuous)
                .strokeBorder(MMColor.surfaceBorderAlt, lineWidth: 1)
        )
        .modifier(MMCardElevation())
    }
}

// MARK: - Text field

/// The one text input the native app has. Wraps `TextField` because the bare
/// control renders as an invisible baseline on our background -- no fill, no
/// border, nothing saying "type here".
struct MMTextField: View {
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    var contentType: UITextContentType?
    var submitLabel: SubmitLabel = .done
    var onSubmit: () -> Void = {}

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(.system(size: MMFont.lg))
            .foregroundStyle(MMColor.onSurface)
            .keyboardType(keyboard)
            .textContentType(contentType)
            .submitLabel(submitLabel)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .onSubmit(onSubmit)
            .padding(.horizontal, MMSpace.four)
            .padding(.vertical, MMSpace.three)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MMColor.bg)
            .clipShape(RoundedRectangle(cornerRadius: MMRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: MMRadius.md, style: .continuous)
                    .strokeBorder(MMColor.surfaceBorderAlt, lineWidth: 1)
            )
    }
}

// MARK: - Error note

/// An inline failure the user can act on. The palette has no danger token, so
/// the accent wash carries it -- a hand-mixed red here would be the first
/// non-MightyMouse color in the app.
struct MMErrorNote: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: MMSpace.two) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: MMFont.md, weight: .semibold))
                .foregroundStyle(MMColor.accent)
            Text(message)
                .font(.system(size: MMFont.sm))
                .foregroundStyle(MMColor.onSurface)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(MMSpace.three)
        .background(MMColor.accentWash)
        .clipShape(RoundedRectangle(cornerRadius: MMRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MMRadius.md, style: .continuous)
                .strokeBorder(MMColor.accentBorderSubtle, lineWidth: 1)
        )
    }
}

// MARK: - Toast

/// A send result that fades on its own. The lobby's email card cannot latch into
/// a "sent" state instead: the endpoint is public and has no session, so that
/// state would reset on every launch and lie about a link already delivered.
struct MMToast: View {
    let message: String

    var body: some View {
        HStack(spacing: MMSpace.two) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: MMFont.md, weight: .semibold))
            Text(message)
                .font(.system(size: MMFont.sm, weight: .semibold))
        }
        .foregroundStyle(MMColor.onSurface)
        .padding(.horizontal, MMSpace.four)
        .padding(.vertical, MMSpace.three)
        .background(MMColor.accent)
        .clipShape(Capsule())
        .modifier(MMCardElevation())
        .padding(.horizontal, MMSpace.five)
    }
}

// MARK: - Glow dot

/// The renderer's `GlowDot`: a status dot that pulses while a job is live, so
/// "still searching" is distinguishable from "stalled" without reading text.
struct MMGlowDot: View {
    var color: Color = MMColor.accent
    var pulsing: Bool = true
    var size: CGFloat = MMSpace.two

    @State private var expanded = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay(
                Circle()
                    .stroke(color, lineWidth: 1)
                    .scaleEffect(expanded ? 2.6 : 1)
                    .opacity(expanded ? 0 : 0.7)
            )
            .onAppear {
                guard pulsing else { return }
                withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                    expanded = true
                }
            }
    }
}

// MARK: - Radar sweep

/// The web deck's `.bootGateIcon`, in SwiftUI. Both connect gates now animate
/// identically, because on iOS they appear back-to-back and a change of
/// furniture mid-connect reads as "the app jumped to a different screen".
///
/// Timing is copied from `bootGateSweep`/`bootGatePing` in the phone-remote
/// `theme.css`: one 2.4s cycle, the dial spinning a full turn over the first
/// 35% and resting for the remainder. Change one side and change the other.
struct MMRadarSweep: View {
    /// Matches the `BrandGlyph` this replaced, because it IS the mark now --
    /// the dial orbits the same mouse symbol rather than sitting beside it.
    var size: CGFloat = MMSpace.six * 2
    var lineWidth: CGFloat = 1.75

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The ping's beat. The dial no longer shares it -- one continuous turn at
    /// this length reads as slow-motion, so it runs on `spin` instead.
    private var cycle: Double { 2.4 }
    /// Roughly a system spinner's rate.
    private var spin: Double { 1.1 }

    var body: some View {
        // TimelineView, not `withAnimation` on a @State bool: a bool flips
        // ONCE, so `repeatForever` had nothing left to drive after the first
        // 0->360 and the dial sat still at an angle identical to where it
        // started. A clock has no such end state.
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion)) { timeline in
            let now = timeline.date.timeIntervalSinceReferenceDate
            let t = now.truncatingRemainder(dividingBy: cycle) / cycle
            let s = now.truncatingRemainder(dividingBy: spin) / spin
            ZStack {
                Circle().fill(MMColor.accentWash)
                Circle().strokeBorder(MMColor.accentBorderSubtle, lineWidth: 1)
                // The brand mark stays put and the dial turns around it, so
                // the screen keeps its identity while still visibly working.
                Image(systemName: "computermouse.fill")
                    .font(.system(size: size * 0.34, weight: .medium))
                    .foregroundStyle(MMColor.accent)
                // Drawn, not an SF Symbol: `dot.radiowaves.*` animates its
                // waves, not a dial, so it cannot match the web's rotation.
                //
                // `.drawingGroup()` BEFORE the rotation is what makes it
                // smooth: rotating a Shape re-runs `path(in:)` and rasterises
                // new geometry every frame, which is the stutter. Flattened to
                // one texture first, the spin is a layer transform.
                RadarDial(inset: lineWidth)
                    .stroke(MMColor.accent, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .drawingGroup()
                    .rotationEffect(.degrees(Self.sweepAngle(at: s)))
                // The single expanding ring. One, not a stack -- see the
                // theme.css note: concentric rings read as decoration, one
                // ping reads as a pulse going out.
                Circle()
                    .strokeBorder(MMColor.accent, lineWidth: lineWidth * 0.85)
                    .scaleEffect(1 + 0.75 * Self.pingProgress(at: t))
                    .opacity(0.55 * (1 - Self.pingProgress(at: t)))
            }
        }
        .frame(width: size, height: size)
    }

    /// One unbroken turn per cycle. The dial never stops, so there is no seam
    /// where 360 becomes 0 -- an eased sweep that parked for the back 65% of
    /// the cycle put a visible hitch at exactly that handover, which reads as
    /// jitter rather than as the deliberate beat it was meant to be.
    private static func sweepAngle(at t: Double) -> Double {
        t * 360
    }

    /// `bootGatePing`: expands and fades over the first 70%, then waits.
    private static func pingProgress(at t: Double) -> Double {
        guard t < 0.7 else { return 1 }
        let p = t / 0.7
        return 1 - pow(1 - p, 3)
    }
}

/// One short arc riding just inside the rim, so the mark at the centre stays
/// legible. A full-circle face would sit on top of it and read as a smudge.
private struct RadarDial: Shape {
    var inset: CGFloat = 2

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        // Inset by the stroke so the arc sits ON the rim rather than clipping.
        let r = min(rect.width, rect.height) / 2 - inset
        path.addArc(center: c, radius: r, startAngle: .degrees(-100), endAngle: .degrees(-10), clockwise: false)
        return path
    }
}
