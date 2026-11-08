// MouseGlyphView.swift — hand-ported SwiftUI version of the React MouseGlyph
// (src/renderer/src/MouseGlyph.tsx), stripped of the animated laser/eye-glow
// refs (this is a static splash mark, not the live cursor overlay). Kept
// visually identical: two rounded ears, tapered angular face, glowing
// almond eyes, triangular nose. Colors match the SVG's own hardcoded fills
// (#161c2e / #0e1320) plus THEME_TOKENS.cyan for the eyes/nose.
//
// Path data below is transcribed 1:1 from the SVG `d` attributes in
// MouseGlyph.tsx so the two renderings stay visually in sync if one changes.

import SwiftUI

struct MouseGlyphView: View {
    var size: CGFloat = 72

    // THEME_TOKENS colors (src/shared/config.ts) — brand mark uses its own
    // fixed dark surfaces regardless of light/dark theme, same as the SVG.
    static let earFill = Color(red: 0x16 / 255, green: 0x1c / 255, blue: 0x2e / 255)
    static let faceFill = Color(red: 0x0e / 255, green: 0x13 / 255, blue: 0x20 / 255)
    static let blue = Color(red: 230 / 255, green: 148 / 255, blue: 68 / 255).opacity(0.42) // accentBorderSubtle
    static let cyan = Color(red: 120 / 255, green: 210 / 255, blue: 190 / 255) // THEME_TOKENS.cyan

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 100
            context.scaleBy(x: scale, y: scale)

            // Ears — big rounded circles, outer ring + inner cutout, like the SVG.
            for cx in [24.0, 76.0] {
                let outer = Path(ellipseIn: CGRect(x: cx - 22, y: 28 - 22, width: 44, height: 44))
                context.fill(outer, with: .color(Self.earFill))
                context.stroke(outer, with: .color(Self.blue), lineWidth: 1.5)

                let inner = Path(ellipseIn: CGRect(x: cx - 12, y: 28 - 12, width: 24, height: 24))
                context.fill(inner, with: .color(Self.faceFill))
            }

            // Face — tapered angular head pointing down to the nose.
            var face = Path()
            face.move(to: CGPoint(x: 50, y: 22))
            face.addLine(to: CGPoint(x: 84, y: 50))
            face.addQuadCurve(to: CGPoint(x: 82, y: 60), control: CGPoint(x: 86, y: 54))
            face.addLine(to: CGPoint(x: 54, y: 92))
            face.addQuadCurve(to: CGPoint(x: 46, y: 92), control: CGPoint(x: 50, y: 96))
            face.addLine(to: CGPoint(x: 18, y: 60))
            face.addQuadCurve(to: CGPoint(x: 16, y: 50), control: CGPoint(x: 14, y: 54))
            face.closeSubpath()
            context.fill(face, with: .color(Self.faceFill))
            context.stroke(face, with: .color(Self.blue), lineWidth: 2)

            // Center crease.
            var crease = Path()
            crease.move(to: CGPoint(x: 50, y: 30))
            crease.addLine(to: CGPoint(x: 50, y: 86))
            context.stroke(crease, with: .color(Self.blue.opacity(0.5)), lineWidth: 1)

            // Eyes — almond shapes.
            var leftEye = Path()
            leftEye.move(to: CGPoint(x: 30, y: 54))
            leftEye.addQuadCurve(to: CGPoint(x: 46, y: 54), control: CGPoint(x: 38, y: 44))
            leftEye.addQuadCurve(to: CGPoint(x: 30, y: 54), control: CGPoint(x: 38, y: 62))
            leftEye.closeSubpath()
            var rightEye = Path()
            rightEye.move(to: CGPoint(x: 54, y: 54))
            rightEye.addQuadCurve(to: CGPoint(x: 70, y: 54), control: CGPoint(x: 62, y: 44))
            rightEye.addQuadCurve(to: CGPoint(x: 54, y: 54), control: CGPoint(x: 62, y: 62))
            rightEye.closeSubpath()
            context.fill(leftEye, with: .color(Self.cyan))
            context.fill(rightEye, with: .color(Self.cyan))

            // Nose.
            var nose = Path()
            nose.move(to: CGPoint(x: 44, y: 78))
            nose.addLine(to: CGPoint(x: 50, y: 86))
            nose.addLine(to: CGPoint(x: 56, y: 78))
            nose.closeSubpath()
            context.fill(nose, with: .color(Self.cyan.opacity(0.85)))
        }
        .frame(width: size, height: size)
    }
}
