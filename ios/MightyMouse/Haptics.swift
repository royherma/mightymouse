import UIKit

/// System haptics for the web layer, tuned for mid-drag ticking.
///
/// Generators are cached and kept warm rather than built per tick: `prepare()`
/// is asynchronous, so a generator created and fired in the same instant is
/// cold on almost every call.
enum Haptics {
    /// Below this, consecutive impacts blur into one sensation instead of
    /// distinct detents.
    ///
    /// Lockstep with DETENT_MIN_INTERVAL_MS in haptics.ts, and the LAST word —
    /// a lower web-side floor is silently overruled here.
    private static let minIntervalMs: Double = 22

    private static var generators: [String: UIImpactFeedbackGenerator] = [:]
    private static var lastPlayedAt: CFTimeInterval = 0
    private static let notifier = UINotificationFeedbackGenerator()

    private static func generator(for style: String) -> UIImpactFeedbackGenerator {
        if let cached = generators[style] { return cached }
        let feedbackStyle: UIImpactFeedbackGenerator.FeedbackStyle
        switch style {
        case "medium": feedbackStyle = .medium
        case "rigid": feedbackStyle = .rigid
        default: feedbackStyle = .light
        }
        let created = UIImpactFeedbackGenerator(style: feedbackStyle)
        generators[style] = created
        return created
    }

    /// Spin the engine up ahead of a burst, so the first detent of a gesture is
    /// as crisp as the tenth. Cheap and idempotent.
    static func warm(_ style: String) {
        dispatchOnMain { generator(for: style).prepare() }
    }

    static func play(_ style: String) {
        dispatchOnMain {
            let now = CACurrentMediaTime()
            guard (now - lastPlayedAt) * 1000 >= minIntervalMs else { return }
            lastPlayedAt = now
            if let outcome = notificationType(for: style) {
                notifier.notificationOccurred(outcome)
                notifier.prepare()
                return
            }
            let gen = generator(for: style)
            gen.impactOccurred()
            // Re-arm for the next tick in the same drag.
            gen.prepare()
        }
    }

    private static func notificationType(for style: String) -> UINotificationFeedbackGenerator.FeedbackType? {
        switch style {
        case "success": return .success
        case "warning": return .warning
        case "error": return .error
        default: return nil
        }
    }

    /// UIKit feedback generators are main-thread only.
    private static func dispatchOnMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }
}
