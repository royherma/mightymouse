import CoreGraphics
import Intents
import UIKit
import UserNotifications

/// Runs OUTSIDE the app, in its own process, on delivery of a `mutable-content`
/// push (agent-relay PRD §5). The push carries only a `requestId` -- this
/// fetches the real question/options/image from the Mac over the tunnel and
/// rewrites the notification before iOS shows it. Three problems solved by
/// this one hop: the 4KB APNs payload cap, images for `show`, and privacy
/// (a question's text/code never transits our cloud). No state survives
/// between invocations; iOS may kill and relaunch this process per push.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    /// Set once the face is drawn; `deliver` folds it into every exit path.
    /// The intent itself is built at delivery, not here: `updating(from:)`
    /// replaces the title with the group name and the subtitle with the sender,
    /// and both are only final after `apply()` has run.
    private var avatarImage: INImage?
    /// The sender as the push named it, before `apply()` may swap the subtitle
    /// for `detail` -- threads stay keyed per agent, not per request.
    private var avatarConversation: String?
    private let credentials = Credentials()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttempt = mutable
        MMLog.phase.info("relay nse wake: requestId=\(request.content.userInfo["requestId"] as? String ?? "nil", privacy: .public)")

        guard let requestId = request.content.userInfo["requestId"] as? String else {
            deliver(mutable)
            return
        }

        Task {
            // BEFORE the fetch, not only in its failure branch: iOS can expire
            // this extension's budget mid-request, and `serviceExtensionTimeWillExpire`
            // is synchronous -- it delivers whatever exists at that instant and
            // cannot await a registration. Doing it up front means the buttons
            // are already on the content no matter which way the fetch ends.
            // The success path re-registers the same identifier, which is a
            // no-op set to the same value.
            await applyPushOnlyFallback(request, requestId: requestId, to: mutable)

            // Ahead of the fetch so a budget kill still ships the cached picture or icon tile.
            await applyAvatar(from: request)
            async let fetchedPicture = fetchProjectPicture(for: request, requestId: requestId)

            var enriched = false
            do {
                let data = try await MacRelayClient.get(
                    AppConfig.relayRequestPath,
                    credentials: credentials,
                    query: ["requestId": requestId]
                )
                let payload = try JSONDecoder().decode(RelayRequestPayload.self, from: data)
                await apply(payload, requestId: requestId, to: mutable)
                enriched = true
            } catch {
                // Content fetch failed (Mac asleep, tunnel down, stale device
                // credential). Nothing to repair here any more: the buttons were
                // registered from the push payload before the fetch began, so an
                // `ask` still renders its real options. Previously this branch
                // delivered choices as body text over a static category with no
                // buttons -- a card announcing an answer it gave no way to give.
                // The OSStatus alongside the error, because `noCredential` is
                // the same word for two unrelated bugs: -25300 is a phone that
                // never paired (or was revoked), -34018 is an entitlement
                // mismatch where the credential exists and this process cannot
                // see it. Without the number a degraded card names neither.
                MMLog.phase.error(
                    """
                    relay content fetch failed: \(String(describing: error), privacy: .public) \
                    keychainStatus=\(self.credentials.lastReadStatus, privacy: .public)
                    """
                )
            }
            // Paired with the `relay card` line below: that one says what the
            // card HOLDS, this says whether the Mac's copy is in it. Without
            // both, a short body reads the same whether the agent wrote a short
            // one or the push's truncated copy was all we ever had.
            MMLog.phase.info("relay fetch verdict: \(enriched ? "enriched" : "degraded", privacy: .public)")
            if let picture = await fetchedPicture {
                await donateAvatar(picture, for: request)
            }
            deliver(mutable)
        }
    }

    /// Degraded mode: build the ask buttons from the push payload alone.
    ///
    /// Only ever reached when the authed fetch failed, so it must assume nothing
    /// about the Mac being reachable. The labels arrive pre-bounded by the Edge
    /// function (APNs 4KB cap), and `userInfo["options"]` is set here for the
    /// same reason the success path sets it: `PushRegistration` resolves a
    /// tapped index against that array to recover the agent's exact string.
    private func applyPushOnlyFallback(
        _ request: UNNotificationRequest,
        requestId: String,
        to content: UNMutableNotificationContent
    ) async {
        guard request.content.userInfo["verb"] as? String == "ask",
              let options = request.content.userInfo["options"] as? [String],
              !options.isEmpty else { return }

        content.userInfo["requestId"] = requestId
        content.userInfo["options"] = options
        let resolved = await registerDynamicAsk(
            options: options,
            requestId: requestId,
            was: content.categoryIdentifier,
            fallback: RelayNotificationCategory.ask
        )
        content.categoryIdentifier = resolved
        MMLog.phase.info(
            "relay push-only fallback: options=\(options.count, privacy: .public) category=\(resolved, privacy: .public)"
        )
    }

    /// iOS's hard budget for extension time ran out -- must call the handler
    /// with whatever we have NOW, not what we were about to fetch.
    override func serviceExtensionTimeWillExpire() {
        // Its own verdict, because this path never reaches the one after the
        // fetch: a budget kill would otherwise log nothing, and no line reads
        // as "no push arrived" rather than "the Mac was too slow to answer".
        MMLog.phase.error("relay fetch verdict: expired")
        if let bestAttempt {
            deliver(bestAttempt)
        }
    }

    private func deliver(_ content: UNMutableNotificationContent) {
        guard let handler = contentHandler else { return }
        contentHandler = nil
        // The three strings AS DELIVERED, above the avatar guard so every push
        // logs one. What iOS then draws from them is Apple's business and cannot
        // be read from this source: an empty field here says the card was built
        // wrong, a full one plus a blank row on the glass says the intent ate it.
        MMLog.phase.info(
            """
            relay card: title=\(content.title, privacy: .public) \
            subtitle=\(content.subtitle, privacy: .public) \
            bodyChars=\(content.body.count, privacy: .public)
            """
        )
        guard let image = avatarImage, let conversation = avatarConversation else {
            handler(content)
            return
        }
        let intent = Self.makeIntent(
            image: image,
            sender: conversation,
            conversation: conversation
        )
        // A communication card is drawn as sender + body; `content.title` and
        // `content.subtitle` are discarded (WWDC21 10091). The headline rides
        // the body so the card keeps its third row. On a copy, so the catch
        // path below still delivers the plain card with its own title.
        let threeRow = (content.mutableCopy() as? UNMutableNotificationContent) ?? content
        if !content.title.isEmpty {
            threeRow.body = "\(content.title)\n\(content.body)"
        }
        do {
            handler(try threeRow.updating(from: intent))
            MMLog.phase.info("relay avatar updating: ok")
        } catch {
            MMLog.phase.error(
                "relay avatar updating failed: \(error.localizedDescription, privacy: .public)"
            )
            handler(content)
        }
    }

    /// iOS draws the sender's project in place of our icon and badges MightyMouse into its corner.
    private func applyAvatar(from request: UNNotificationRequest) async {
        let info = request.content.userInfo
        guard let project = info["project"] as? String, !project.isEmpty else {
            MMLog.phase.info("relay avatar SKIPPED: no project on push")
            return
        }
        let cached = ProjectAvatarImage.cached(project: project)
        guard let data = cached ?? ProjectAvatarImage.iconTile(icon: info["projectIcon"] as? String) else {
            MMLog.phase.error("relay avatar SKIPPED: icon tile failed")
            return
        }
        MMLog.phase.info("relay avatar: source=\(cached == nil ? "icon" : "cache", privacy: .public)")
        await donateAvatar(data, for: request)
    }

    private func fetchProjectPicture(for request: UNNotificationRequest, requestId: String) async -> Data? {
        guard let project = request.content.userInfo["project"] as? String, !project.isEmpty else { return nil }
        do {
            let data = try await MacRelayClient.get(
                AppConfig.relayAvatarPath,
                credentials: credentials,
                query: ["requestId": requestId]
            )
            guard UIImage(data: data) != nil else { return nil }
            ProjectAvatarImage.store(data, project: project)
            MMLog.phase.info("relay avatar: fetched picture bytes=\(data.count, privacy: .public)")
            return data
        } catch {
            MMLog.phase.info("relay avatar picture fetch failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    private func donateAvatar(_ data: Data, for request: UNNotificationRequest) async {
        // The subtitle the Edge function set from `from`, so threads stay keyed per agent.
        let name = request.content.subtitle.isEmpty
            ? AppConfig.appName
            : request.content.subtitle
        let image = INImage(imageData: data)
        let intent = Self.makeIntent(
            image: image, sender: name, conversation: name
        )
        let interaction = INInteraction(intent: intent, response: nil)
        // `.incoming` is load-bearing: an outgoing interaction donates fine and
        // then silently declines to render as a communication notification.
        interaction.direction = .incoming
        do {
            try await interaction.donate()
            MMLog.phase.info("relay avatar donate: ok")
            avatarImage = image
            avatarConversation = name
        } catch {
            MMLog.phase.error(
                "relay avatar donate failed: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    private static func makeIntent(
        image: INImage,
        sender name: String,
        conversation: String
    ) -> INSendMessageIntent {
        // `.unknown`, and a handle that is a relay id rather than anything
        // resembling an address: a matchable handle would let a synthetic
        // sender land in the user's Contacts and share-sheet suggestions.
        let handle = INPersonHandle(value: "mm-relay:\(conversation)", type: .unknown)
        let sender = INPerson(
            personHandle: handle,
            nameComponents: nil,
            displayName: name,
            image: image,
            contactIdentifier: nil,
            customIdentifier: nil
        )
        // Empty recipients: Apple adds the current user. A dummy recipient made
        // iOS style the card as a group; isMe on that dummy dropped all cards.
        let intent = INSendMessageIntent(
            recipients: [],
            outgoingMessageType: .outgoingMessageText,
            content: nil,
            // Pinned nil: two non-nil values (a title, the app name) were tried
            // here on 2026-08-20 and neither changed the card. This slot is
            // ignored unless `recipients.count > 1`, and `updating(from:)`
            // standardises title/subtitle anyway: sender in the title, group
            // in the subtitle, `content.title`/`content.subtitle` discarded
            // (WWDC21 10091). Row 2 must come from the body, not from here.
            speakableGroupName: nil,
            // Per SENDER, not per request: iOS groups a conversation by this id,
            // so keying it to the request would file every card from one agent
            // as a separate thread.
            conversationIdentifier: conversation,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )
        // INPerson.image is not enough: intents-remote-image-proxy only sees this.
        intent.setImage(image, forParameterNamed: \.sender)
        return intent
    }

    private func apply(_ payload: RelayRequestPayload, requestId: String, to content: UNMutableNotificationContent) async {
        // Both sides of the assignment, because "wrong buttons" has two causes
        // that read identically on the glass: the Mac sent a verb we don't map
        // (falls to `notify`, whose only action is Open), or the push arrived
        // with a category the app never registered. The `was` value is the only
        // way to tell an overwrite apart from a category that was never set.
        let resolved = await resolveCategory(payload, requestId: requestId, was: content.categoryIdentifier)
        content.categoryIdentifier = resolved
        content.userInfo["requestId"] = requestId
        content.userInfo["verb"] = payload.verb
        // Carried on the notification itself so a tapped option resolves to the
        // agent's exact string without a second network hop -- the tap can land
        // on a cold launch, offline, or after the request already timed out.
        if let options = payload.params.options { content.userInfo["options"] = options }

        switch payload.verb {
        case "ask":
            // ❓ marks the two verbs that BLOCK on a reply (🔑 below is the
            // other). A notify carries 💬/⛔/⏳ instead and never ❓, so the
            // glyph alone says whether this card can be answered -- the words
            // could not, with "Waiting on You" sitting one line away. Matches
            // GENERIC_TITLE in agent-relay-push so the banner does not swap
            // emoji when this extension's fetch lands and rewrites the title.
            content.title = "❓ Your Agent Needs an Answer"
            content.body = Self.askBody(payload.params.question ?? content.body, options: payload.params.options)
            // Every concurrent session's "ask" reads identically without this --
            // it's the one field that tells them apart on the lock screen.
            // `approve` puts the same identity-bearing slot to `detail` instead
            // (below); `notify`'s title/body are entirely the sender's own words,
            // where a repeated name would be noise, not signal.
        case "approve":
            content.title = payload.params.risk == "high"
                ? "🔑 Your Agent Needs Your OK (Unlock Required)"
                : "🔑 Your Agent Needs Your OK"
            // `detail` runs to 2000 chars and named no session, so holding it in
            // the identity slot made two concurrent approves read alike and
            // truncated mid-sentence. It joins the action instead -- the same
            // shape `bodyFor` already sends, so the card stops rewriting itself
            // when the fetch lands.
            let approveBody = [payload.params.action, payload.params.detail]
                .compactMap { $0 }
                .joined(separator: " — ")
            // Empty only when the payload carried neither, where the push's own
            // body is better than blanking the card.
            if !approveBody.isEmpty { content.body = approveBody }
        case "show":
            content.title = "👀 Your Agent Sent You Something"
            if let caption = payload.params.caption { content.body = caption }
        case "notify":
            // The only verb whose content is entirely the sender's. Falling
            // through to `default` left the cloud's generic one-line title and
            // dropped the body, so a notify arrived as a single bare string.
            if let title = payload.params.title {
                // `info` stays bare on purpose: a marker on every routine update
                // is noise, and stops reading as a signal on the ones that are.
                // Emoji TRAILS the words: iOS truncates from the right, and the
                // status text is what has to survive -- a leading glyph also
                // pushes every title's first word out of vertical alignment.
                content.title = [title, levelPrefix(payload.params.level)]
                    .compactMap { $0 }
                    .joined(separator: " ")
            }
            if let body = payload.params.body { content.body = body }
        default:
            break
        }

        // Any verb may carry a picture, not just `show`: an `ask`/`approve` that
        // shows WHAT it is asking about is decidable in one tap, where a separate
        // `show` card means two notifications and a context switch. Hoisted out
        // of the `show` branch for that reason -- the server's /relay-image gate
        // was widened to match, and both must move together or the fetch 404s.
        if payload.params.imagePath != nil {
            if let attachment = await downloadAttachment(requestId: requestId) {
                content.attachments = [attachment]
                MMLog.phase.info("relay image attached: \(payload.verb, privacy: .public)")
            } else {
                // Loud on purpose: a missing picture is otherwise indistinguishable
                // from an agent that never sent one, and that ambiguity is what
                // makes "why is there no image" unanswerable from the device.
                MMLog.phase.error("relay image FETCH FAILED: \(payload.verb, privacy: .public) \(requestId, privacy: .public)")
            }
        }

        // After the switch, because every branch rewrites the title -- and ahead
        // of the level emoji, so the marker survives iOS truncating a long one.
        if payload.params.test == true {
            content.title = "[TEST] \(content.title)"
        }

    }

    /// Picks the category to stamp, registering a per-request one first when the
    /// agent supplied `options` -- that is what turns "Lucia" / "Auth.js" into
    /// real buttons instead of a keyboard. Falls back to the static per-verb
    /// category whenever there are no options or registration doesn't take.
    ///
    /// `setNotificationCategories` REPLACES the entire set, so the dynamic one
    /// is unioned with `RelayNotificationCategory.all`. Registering it alone
    /// would strip ask/approve/show/notify of their actions for every later
    /// push -- a failure that surfaces one notification late and reads as random.
    private func resolveCategory(
        _ payload: RelayRequestPayload,
        requestId: String,
        was: String
    ) async -> String {
        // A finished notify is replyable: the text goes to the agent's terminal
        // as its next instruction, not to a request (a notify has none to
        // answer). `progress` is excluded on purpose -- it is mid-run, and a
        // reply there would land in a session that is not asking for one.
        if payload.verb == "notify", payload.params.state != "progress" || payload.params.idle == true {
            MMLog.phase.info(
                "relay category: verb=notify was=\(was, privacy: .public) now=\(RelayNotificationCategory.notifyReply, privacy: .public) reply=1"
            )
            return RelayNotificationCategory.notifyReply
        }

        let fallback = RelayNotificationCategory.identifier(for: payload.verb)
        guard payload.verb == "ask",
              let options = payload.params.options,
              !options.isEmpty else {
            MMLog.phase.info(
                "relay category: verb=\(payload.verb, privacy: .public) was=\(was, privacy: .public) now=\(fallback, privacy: .public) options=0"
            )
            return fallback
        }

        return await registerDynamicAsk(
            options: options,
            requestId: requestId,
            was: was,
            fallback: fallback
        )
    }

    /// Registers the per-request option category and reports which identifier is
    /// safe to stamp. Shared by the fetched path and the push-only fallback so
    /// the two can never drift on registration or on the verdict log line.
    private func registerDynamicAsk(
        options: [String],
        requestId: String,
        was: String,
        fallback: String
    ) async -> String {
        // Keyed by requestId so two concurrent asks cannot overwrite each
        // other's buttons -- the set is global to the app, not per-notification.
        let identifier = RelayNotificationCategory.dynamicAskPrefix + requestId
        let center = UNUserNotificationCenter.current()
        let dynamic = RelayNotificationCategory.dynamicAsk(identifier: identifier, options: options)
        // Existing dynamic categories are carried forward, minus any sharing this
        // id: an unbounded set would grow with every ask the app ever received,
        // and iOS keeps them until the app is deleted.
        let existing = await center.notificationCategories().filter { $0.identifier != identifier }
        center.setNotificationCategories(Set(existing).union(RelayNotificationCategory.all).union([dynamic]))

        // Read back rather than assuming the write landed. The setter is not
        // documented as synchronous, and whether a category registered inside
        // didReceive is visible for THIS notification is the one thing source
        // cannot answer -- so verify, and fall back rather than ship a card
        // whose category iOS has never heard of (that renders with NO buttons).
        let known = await center.notificationCategories()
        let landed = known.contains { $0.identifier == identifier }
        MMLog.phase.info(
            "relay category: verb=ask was=\(was, privacy: .public) now=\(landed ? identifier : fallback, privacy: .public) options=\(options.count, privacy: .public) landed=\(landed, privacy: .public)"
        )
        return landed ? identifier : fallback
    }

    /// Appends a count of the tappable choices to an `ask`'s body.
    ///
    /// A collapsed banner shows NO actions at all -- they appear on long-press
    /// or swipe -- so an ask with four one-tap answers and one with none look
    /// identical on the glass. Without this the buttons are only found by
    /// someone who already suspects they exist (Roy, on device: "I don't always
    /// know if there's more options"). The count, not a bare "choose an option",
    /// because knowing there are 4 is what makes the long-press worth doing.
    /// The server appends its own `[Dark ro…/Light r…/Decaf]` hint to the body it
    /// pushes, so this rebuild starts from the FETCHED question -- which has no
    /// hint on it -- and appends the labels in full. Appending to `content.body`
    /// instead would print two hints on the cards where the fetch succeeds.
    private static func askBody(_ question: String, options: [String]?) -> String {
        guard let options, !options.isEmpty else { return question }
        return "\(question) [\(options.joined(separator: "/"))]"
    }

    private func levelPrefix(_ level: String?) -> String? {
        switch level {
        case "success": return "✅"
        case "warn": return "⚠️"
        case "error": return "🛑"
        default: return nil
        }
    }

    /// Downloads a `show` image over the same authed GET the content fetch
    /// used, writes it to the extension's own tmp dir (the only writable
    /// location an NSE has), and hands it to `UNNotificationAttachment` --
    /// which MOVES the file, so a stale copy never lingers past delivery.
    ///
    /// Keyed by `requestId`, NOT the image path: `handleRelayImage` resolves
    /// the file from its own store and never trusts a client-supplied path, so
    /// sending `path` here returned 404 on every `show` and the picture simply
    /// never appeared.
    private func downloadAttachment(requestId: String) async -> UNNotificationAttachment? {
        guard let data = try? await MacRelayClient.get(
            AppConfig.relayImagePath,
            credentials: credentials,
            query: ["requestId": requestId]
        ) else { return nil }

        // The extension must name the file with a TRUE extension --
        // `UNNotificationAttachment` infers the type from it and rejects the
        // attachment outright when it disagrees with the bytes. `show --capture`
        // produces PNG, so the old hardcoded `.jpg` was wrong for the common case.
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(Self.imageExtension(for: data))
        guard (try? data.write(to: fileURL)) != nil else { return nil }
        return try? UNNotificationAttachment(identifier: "relay-image", url: fileURL)
    }

    /// Magic-byte sniff, because `MacRelayClient.get` hands back bytes only --
    /// the server's `Content-Type` never reaches this far. Covers the two types
    /// `RELAY_IMAGE_CONTENT_TYPES` serves; anything else can't have been sent.
    private static func imageExtension(for data: Data) -> String {
        let png: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
        return data.count >= 4 && Array(data.prefix(4)) == png ? "png" : "jpg"
    }
}

/// Mirrors `RelayRequestParams`/`GET /relay-request`'s response shape
/// (`src/main/agent-relay/store.ts`, `server.ts` `handleRelayRequest`) --
/// only the fields a notification card can use, everything else ignored.
private struct RelayRequestPayload: Decodable {
    let verb: String
    let params: Params

    struct Params: Decodable {
        // Session label the CLI sets (e.g. worktree/branch name) -- the server
        // already sends it in this same JSON (server.ts's handleRelayRequest
        // replies with the raw `request.params`), but JSONDecoder silently
        // drops any key missing from CodingKeys, so it never reached the card.
        let from: String?
        let question: String?
        let options: [String]?
        let action: String?
        let detail: String?
        let risk: String?
        let caption: String?
        let imagePath: String?
        let title: String?
        let body: String?
        let level: String?
        let test: Bool?
        // notify only, and read for one reason: they decide whether this card
        // carries a Reply button (see `resolveCategory`). A `progress` notify
        // has nothing to reply to yet.
        let state: String?
        let idle: Bool?

        enum CodingKeys: String, CodingKey {
            case from, question, options, action, detail, risk, caption
            case imagePath
            case title, body, level, test, state, idle
        }
    }
}

/// Icon ids mirror `PROJECT_ICONS` in src/shared/project-icons.tsx.
enum ProjectAvatarImage {
    private static let sizePx: CGFloat = 128

    private static let symbols: [String: String] = [
        "folder": "folder.fill",
        "rocket": "paperplane.fill",
        "globe": "globe",
        "phone": "iphone",
        "terminal": "terminal.fill",
        "palette": "paintpalette.fill",
        "database": "cylinder.split.1x2.fill",
        "bot": "cpu",
        "camera": "video.fill",
        "cart": "cart.fill",
        "music": "music.note",
        "beaker": "testtube.2",
    ]

    static func cached(project: String) -> Data? {
        guard let url = fileURL(project: project) else { return nil }
        return try? Data(contentsOf: url)
    }

    static func store(_ data: Data, project: String) {
        guard let url = fileURL(project: project) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func iconTile(icon: String?) -> Data? {
        let name = icon.flatMap { symbols[$0] } ?? "folder.fill"
        let config = UIImage.SymbolConfiguration(pointSize: sizePx * 0.42, weight: .semibold)
        guard let glyph = (UIImage(systemName: name) ?? UIImage(systemName: "folder.fill"))?
            .applyingSymbolConfiguration(config)?
            .withTintColor(.white, renderingMode: .alwaysOriginal) else { return nil }
        let size = CGSize(width: sizePx, height: sizePx)
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            UIColor(red: 0.760784, green: 0.313725, blue: 0.101961, alpha: 1).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: sizePx * 0.22).fill()
            let g = glyph.size
            glyph.draw(in: CGRect(x: (sizePx - g.width) / 2, y: (sizePx - g.height) / 2, width: g.width, height: g.height))
        }
        return image.pngData()
    }

    private static func fileURL(project: String) -> URL? {
        guard let dir = SharedAppGroup.projectAvatarsDirectory else { return nil }
        let safe = Data(project.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
        return dir.appendingPathComponent("\(safe).png")
    }
}
