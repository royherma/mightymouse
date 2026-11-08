import UserNotifications

/// The lock-screen action buttons for each relay verb (agent-relay PRD §6).
/// Compiled into BOTH the app and the NSE: the extension stamps a category
/// identifier onto the notification it rewrites, and the app registers what
/// those identifiers actually mean. Two copies of these strings would let a
/// push arrive carrying a category iOS has never heard of, which silently
/// renders as a plain notification with no buttons and no error anywhere.
enum RelayNotificationCategory {
    static let ask = "MM_RELAY_ASK"
    static let approve = "MM_RELAY_APPROVE"
    static let show = "MM_RELAY_SHOW"
    static let notify = "MM_RELAY_NOTIFY"

    /// A notify that is finished (`done`, or an idle turn-end ping) and so is
    /// the one a person answers with an instruction rather than an answer. Its
    /// own category because the notify card must stay button-less on `progress`,
    /// where there is nothing to reply to yet.
    static let notifyReply = "MM_RELAY_NOTIFY_REPLY"

    static let answerAction = "MM_RELAY_ANSWER"
    static let replyAction = "MM_RELAY_REPLY"
    static let approveAction = "MM_RELAY_APPROVE_YES"
    static let denyAction = "MM_RELAY_APPROVE_NO"

    /// Prefix for a per-request category built by the NSE from the agent's own
    /// `options` (see `dynamicAsk`). Also the marker the app's response handler
    /// uses to recognise an option tap: the action identifier carries the index.
    static let dynamicAskPrefix = "MM_RELAY_ASK_DYN_"
    static let optionActionPrefix = "MM_RELAY_OPTION_"

    /// The index an option action encodes, or nil if this isn't one of ours.
    static func optionIndex(forAction identifier: String) -> Int? {
        guard identifier.hasPrefix(optionActionPrefix) else { return nil }
        return Int(identifier.dropFirst(optionActionPrefix.count))
    }

    static func identifier(for verb: String) -> String {
        switch verb {
        case "ask": return ask
        case "approve": return approve
        case "show": return show
        default: return notify
        }
    }

    /// A category whose action titles are the agent's ACTUAL option strings, so
    /// an `ask` is answerable in one tap without the keyboard. Built per request
    /// since titles differ per request. iOS collapses extra actions behind a
    /// long-press but all options register anyway — reachable beats missing.
    /// `Answer` trails the options so free text stays available.
    static func dynamicAsk(identifier: String, options: [String]) -> UNNotificationCategory {
        let optionActions = options.enumerated().map { index, title in
            UNNotificationAction(
                identifier: "\(optionActionPrefix)\(index)",
                title: title,
                options: []
            )
        }
        return UNNotificationCategory(
            identifier: identifier,
            actions: optionActions + [answerAction(for: options)],
            intentIdentifiers: [],
            options: []
        )
    }

    /// The free-text reply. Shared by the static `ask` category and every
    /// dynamic one, so the two can never drift on placeholder wording.
    ///
    /// The ✏️ is load-bearing, not decoration: beside real option buttons every
    /// action is the same grey row, so nothing distinguishes "send this answer"
    /// from "open a keyboard" until you have already tapped. The phone deck
    /// makes the same distinction with a pencil on "Write a reply".
    private static func answerAction(for options: [String]) -> UNTextInputNotificationAction {
        UNTextInputNotificationAction(
            identifier: answerAction,
            title: options.isEmpty ? "✏️ Answer" : "✏️ Something else",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Type your answer"
        )
    }

    /// No category carries an open-the-screen action — a plain tap on the banner
    /// already deep-links to that request (see `default` arm in
    /// PushRegistration), so the button was a duplicate occupying a slot `ask`
    /// needs for a real option.
    /// The free-text reply on a FINISHED notify. Distinct from `answerAction`
    /// because it goes somewhere else entirely: an answer resolves a waiting
    /// request, this types into the agent's terminal as its next instruction.
    /// Placeholder says so -- "Answer" over a card announcing it is done reads
    /// like there is a question above it that the person has missed.
    private static var replyTextAction: UNTextInputNotificationAction {
        UNTextInputNotificationAction(
            identifier: replyAction,
            title: "✏️ Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Tell it what's next"
        )
    }

    static var all: Set<UNNotificationCategory> {
        let answer = answerAction(for: [])

        // `.authenticationRequired` demands Face ID / passcode so a bystander
        // can't approve off a locked screen. Deny is NOT gated: refusing is
        // always safe.
        let approveYes = UNNotificationAction(
            identifier: approveAction,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let approveNo = UNNotificationAction(
            identifier: denyAction,
            title: "Don't",
            options: [.destructive]
        )

        return [
            UNNotificationCategory(
                identifier: ask,
                actions: [answer],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: approve,
                actions: [approveYes, approveNo],
                intentIdentifiers: [],
                options: []
            ),
            // Zero actions on purpose: neither has anything to answer, so a tap
            // (deep-linking to the request) is the only interaction. A FINISHED
            // notify is the exception and gets `notifyReply` below. Stay
            // registered — an unregistered category silently strips a card's
            // buttons, and these identifiers still arrive on every push.
            UNNotificationCategory(
                identifier: show,
                actions: [],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: notify,
                actions: [],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: notifyReply,
                actions: [replyTextAction],
                intentIdentifiers: [],
                options: []
            )
        ]
    }
}
