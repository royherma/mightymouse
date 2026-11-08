import SwiftUI
import UIKit
import UserNotifications

/// APNs registration -- request/response only, no state machine (ios/CLAUDE.md:
/// Swift owns no connection state). The token half still self-heals on every
/// launch (a rotated token needs no user action, agent-relay design) via
/// `registerIfAuthorized`; the PROMPT half waits for the first connected deck --
/// see `requestOnFirstConnection`. The delegate below only converts the token
/// iOS hands back and forwards it, nothing more.
enum PushRegistration {
    /// Re-registers with APNs when permission is ALREADY granted, without ever
    /// showing a prompt. This is the every-launch token refresh: `notDetermined`
    /// returns silently so a first-run user meets the pairing screen, not a
    /// system alert about a Mac they have not connected yet.
    static func registerIfAuthorized() {
        UNUserNotificationCenter.current().setNotificationCategories(RelayNotificationCategory.all)
        Task {
            switch await authorizationStatus() {
            case .authorized, .provisional, .ephemeral:
                await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
            default:
                break
            }
        }
    }

    /// Guards `requestOnFirstConnection` to one prompt per process: the deck
    /// raises its `connected` edge again on every reconnect, and a permission
    /// prompt is a once-ever moment, not a per-socket one.
    @MainActor private static var didRequestThisLaunch = false

    /// The one place the prompt is allowed to fire on its own. Called from the
    /// deck's `connected` edge, so the user has a paired, working Mac on screen
    /// and "let your Mac reach you" is a sentence that means something. The
    /// delay lets the lobby-to-deck transition finish first -- a system alert
    /// sliding in over a mid-animation screen reads as a glitch.
    @MainActor static func requestOnFirstConnection() {
        guard !didRequestThisLaunch else { return }
        didRequestThisLaunch = true
        Task {
            guard await authorizationStatus() == .notDetermined else { return }
            try? await Task.sleep(nanoseconds: promptDelayNanos)
            await MainActor.run { requestAndRegister() }
        }
    }

    /// Long enough for the deck to settle, short enough that the prompt still
    /// reads as a consequence of connecting rather than an unprompted interrupt.
    private static let promptDelayNanos: UInt64 = 2_500_000_000

    /// Fires the OS permission prompt (a no-op if already answered) and, once
    /// granted, calls `UIApplication.registerForRemoteNotifications()`. The
    /// actual token arrives later via `AppDelegate`, not this call's return --
    /// APNs registration is inherently async and callback-driven.
    static func requestAndRegister() {
        // Categories are registered BEFORE the permission prompt on purpose: a
        // push can land while the app is still launching, and a notification
        // whose category iOS has not seen yet renders with no buttons at all.
        UNUserNotificationCenter.current().setNotificationCategories(RelayNotificationCategory.all)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Uploads a device token to the paired Mac. Errors are swallowed on
    /// purpose -- see `MacRelayClient`'s doc comment: the next launch retries.
    static func upload(tokenHex: String, credentials: Credentials) {
        Task {
            do {
                try await MacRelayClient.post(
                    AppConfig.pushTokenPath,
                    credentials: credentials,
                    body: ["deviceToken": tokenHex]
                )
                MMLog.phase.log("push token uploaded")
            } catch {
                // `noCredential` alone cannot say WHICH failure it is, and the two
                // have opposite fixes: -25300 means the pairing write has not landed
                // yet (a race worth retrying), -34018 means this build cannot read
                // the access group at all (a signing problem no retry ever fixes).
                let status = credentials.lastReadStatus
                MMLog.phase.error(
                    "push token upload failed: \(String(describing: error), privacy: .public) keychainStatus=\(status, privacy: .public)"
                )
            }
        }
    }

    /// The lobby/settings banner's source of truth for "notifications are off
    /// and only Settings can fix it". Reads live rather than caching:
    /// this is exactly the kind of state that changes underneath the app while
    /// backgrounded, and a stale read would show a stale banner.
    static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// The relay request card the deck currently has open full-screen, reported
    /// by the page over `visibleRelayRequest` (Swift owns no state -- only the
    /// page knows what it is rendering). Read by `willPresent` to drop the
    /// banner for THIS request only: every other push still banners, so a
    /// second agent blocking while you read the first is never swallowed.
    /// Main-actor because both writer and reader are already there.
    @MainActor static var visibleRelayRequestId: String?
}

/// SwiftUI has no other way to receive `didRegisterForRemoteNotificationsWithDeviceToken`
/// / `didFailToRegisterForRemoteNotificationsWithError` -- both are UIKit
/// `UIApplicationDelegate` callbacks with no SwiftUI equivalent, hence the
/// `UIApplicationDelegateAdaptor` in `MightyMouseApp`. Kept to just that
/// conversion + handoff on purpose.
final class AppDelegate: NSObject, UIApplicationDelegate {
    let credentials = Credentials()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushRegistration.upload(tokenHex: hex, credentials: credentials)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        MMLog.phase.error("APNs registration failed: \(String(describing: error), privacy: .public)")
    }

    /// Silent `content-available` push whose only job is to retire a card the
    /// Mac has already resolved -- answered at the keyboard, or timed out.
    ///
    /// Without this the notification is owned by iOS and outlives the request
    /// forever: it keeps rendering its option buttons, and tapping one posts an
    /// answer to a request that no longer exists, which fails silently. A card
    /// you cannot tell is dead is worse than no card.
    ///
    /// Matched on the PAYLOAD, not the identifier. A remote notification's
    /// identifier is assigned by APNs (random unless the push sets
    /// `apns-collapse-id`, which ours does not), so
    /// `removeDeliveredNotifications(withIdentifiers: [requestId])` matches
    /// nothing and fails exactly as silently as the bug it is fixing. The
    /// `requestId` in `userInfo` is the field we actually control, so the
    /// delivered list is searched for it instead.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard userInfo["clear"] as? Bool == true,
              let requestId = userInfo["requestId"] as? String else {
            completionHandler(.noData)
            return
        }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered
                .filter { $0.request.content.userInfo["requestId"] as? String == requestId }
                .map { $0.request.identifier }
            if !ids.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: ids)
            }
            MMLog.phase.info(
                "relay card cleared: \(requestId, privacy: .public) removed=\(ids.count, privacy: .public)"
            )
            completionHandler(ids.isEmpty ? .noData : .newData)
        }
    }
}

/// Lock-screen answers. The Mac's request store is the single source of truth
/// and decides first-answer-wins, so this posts and does not interpret the
/// result: a race the phone lost is not an error worth surfacing here.
extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard let requestId = response.notification.request.content.userInfo["requestId"] as? String else { return }

        var body: [String: Any] = ["requestId": requestId]

        // An option button carries its index, not its text: the title iOS shows
        // is display-only and the Mac's store is the authority on what option 0
        // actually was. Resolved against the titles the NSE registered, so the
        // posted answer is byte-identical to what the agent offered.
        if let index = RelayNotificationCategory.optionIndex(forAction: response.actionIdentifier) {
            let titles = response.notification.request.content.userInfo["options"] as? [String]
            guard let answer = titles?.indices.contains(index) == true ? titles?[index] : nil else { return }
            postAnswer(["requestId": requestId, "answer": answer, "via": "chip"], requestId: requestId)
            return
        }

        switch response.actionIdentifier {
        case RelayNotificationCategory.answerAction:
            guard let text = (response as? UNTextInputNotificationResponse)?.userText else { return }
            body["answer"] = text
            body["via"] = "typed"
        // `reply`, not `answer`: a notify is already settled, so the Mac types
        // this into the agent's terminal instead of resolving anything. Posting
        // it as an answer would come back 'already-resolved' every time.
        case RelayNotificationCategory.replyAction:
            guard let text = (response as? UNTextInputNotificationResponse)?.userText,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            body["reply"] = text
            body["via"] = "typed"
        case RelayNotificationCategory.approveAction:
            body["approved"] = true
            body["via"] = "chip"
        case RelayNotificationCategory.denyAction:
            body["approved"] = false
            body["via"] = "chip"
        // A plain tap: open that request's card. Stash durably FIRST -- the tap
        // can land on a cold launch before any bridge exists -- then emit live
        // for the warm case, where there is no foreground edge to drain on.
        default:
            SharedAppGroup.defaults.set(requestId, forKey: SharedAppGroup.pendingRelayRequestIdKey)
            SharedAppGroup.defaults.set(Date().timeIntervalSince1970, forKey: SharedAppGroup.pendingRelayRequestAtKey)
            NativeIntentRouter.emit(["type": "openRelayRequest", "requestId": requestId])
            return
        }

        postAnswer(body, requestId: requestId)
    }

    /// Delivers one lock-screen answer, and keeps it if the Mac is merely
    /// asleep. The single post site for every answer shape (option chip, typed
    /// text, approve/deny) so none can regress to fire-and-forget.
    ///
    /// A tap happens exactly when the Mac is most likely unreachable -- the
    /// person is away from it. Dropping the answer there loses a decision the
    /// user believes they made, and unlike a fetch there is nothing to retry
    /// from: the notification is gone. So a transient failure queues rather than
    /// reports, and the queue drains on the next foreground.
    private func postAnswer(_ body: [String: Any], requestId: String) {
        Task {
            do {
                try await MacRelayClient.post(AppConfig.relayRespondPath, credentials: credentials, body: body)
            } catch let error as MacRelayClient.RelayError where error != .unauthorized {
                // Cloud first -- it resolves NOW, while the agent still waits.
                // Queue anyway: the cloud row expires, so the direct retry is
                // what covers a Mac that stays away. Both are first-answer-wins.
                do {
                    try await MacRelayClient.postAnswerToCloud(
                        requestId: requestId, credentials: credentials, body: body
                    )
                    MMLog.phase.log("relay answer left in cloud: \(requestId, privacy: .public)")
                } catch {
                    MMLog.phase.log("relay cloud answer failed, queueing: \(requestId, privacy: .public)")
                }
                RelayAnswerQueue.enqueue(body)
            } catch {
                // `unauthorized` only. Retrying cannot fix a credential the Mac
                // no longer knows, so this is the one case worth interrupting
                // the user for -- queueing it would retry forever in silence.
                reportAnswerFailure(error, requestId: requestId, what: "respond")
            }
        }
    }

    /// Turns a failed lock-screen answer into something the user can act on.
    ///
    /// The answer is already gone by the time this runs -- the notification is
    /// dismissed and its text lives nowhere -- so the ONLY useful outcome is
    /// telling the person their tap did not land, and which fix applies. A
    /// `unauthorized` credential is dead until they pair again; everything else
    /// is a Mac that will come back on its own. Both used to log and return,
    /// which is why a dead button and a working one felt identical.
    ///
    /// Stashed in the App Group as well as emitted: a tap can arrive on a cold
    /// launch where no bridge exists yet, and the emit would go nowhere.
    private func reportAnswerFailure(_ error: Error, requestId: String, what: String) {
        let unauthorized = (error as? MacRelayClient.RelayError) == .unauthorized
        let reason = unauthorized ? "unauthorized" : "unreachable"
        MMLog.phase.error(
            "relay \(what, privacy: .public) failed: reason=\(reason, privacy: .public) \(String(describing: error), privacy: .public)"
        )
        SharedAppGroup.defaults.set(reason, forKey: SharedAppGroup.pendingRelayAnswerFailureKey)
        SharedAppGroup.defaults.set(requestId, forKey: SharedAppGroup.pendingRelayRequestIdKey)
        SharedAppGroup.defaults.set(Date().timeIntervalSince1970, forKey: SharedAppGroup.pendingRelayRequestAtKey)
        NativeIntentRouter.emit([
            "type": "relayAnswerFailed",
            "requestId": requestId,
            "reason": reason
        ])
    }

    /// Without this a push that arrives while the app is open is swallowed by
    /// iOS and the user never learns their agent is blocked on them -- the
    /// foreground default is to show NOTHING, so every option here is opt-in.
    ///
    /// The one exception is a push about the very card already filling the
    /// screen: the deck re-renders it live off the socket, so a banner over it
    /// covers the answer box with a copy of what it is covering. That one drops
    /// to no banner and no sound. Anything else -- a different request, or the
    /// deck showing the list rather than a card -- still banners, because
    /// "app is open" never implies the user saw it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let requestId = notification.request.content.userInfo["requestId"] as? String
        // The last hop before iOS draws the card, so this is the ONLY place that
        // reports what actually got rendered rather than what someone intended:
        // it runs after the NSE, on the real content. `registered` is logged
        // beside it because a category iOS never heard of renders with no
        // buttons and raises nothing -- silence is the entire symptom, and
        // without this line the two causes are indistinguishable on the glass.
        Task {
            let known = await UNUserNotificationCenter.current().notificationCategories()
            let id = notification.request.content.categoryIdentifier
            let match = known.first { $0.identifier == id }
            MMLog.phase.info(
                "relay present: category=\(id, privacy: .public) registered=\(match != nil, privacy: .public) actions=\(match?.actions.map(\.identifier).joined(separator: ",") ?? "-", privacy: .public)"
            )
        }
        Task { @MainActor in
            // `.active` is checked live rather than trusting the stored id on its
            // own: the webview keeps running (and keeps its card "open") while
            // the app sits behind PiP or a Control Center pull, and a card the
            // user cannot see must never suppress its own banner.
            let frontmost = UIApplication.shared.applicationState == .active
            let onScreen = frontmost && requestId != nil && requestId == PushRegistration.visibleRelayRequestId
            completionHandler(onScreen ? [] : [.banner, .sound])
        }
    }
}
