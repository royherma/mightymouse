import Foundation
import Photos
import UIKit

/// The Photos half of `photos_search`/`photos_get`. Metadata leaves this file;
/// pixels leave only for the ids an agent explicitly asks for, so a search over
/// hundreds of candidates costs nothing but a fetch.
///
/// Nothing here prompts on its own. The permission ask is a deliberate call the
/// web layer makes only after a search has already failed for lack of access
/// (PRD decision 1) -- asking at launch is what makes a photo grant feel like a
/// toll booth rather than a trade.
enum PhotoLibrary {
    /// What the agent is allowed to reach. Sent back on EVERY response, not
    /// just failures: an agent that does not know its own scope promises a
    /// search of the whole library while holding four hand-picked photos.
    enum Scope: String {
        /// Nothing granted. The picker is the only way through.
        case none
        /// The user handed over a specific set. Searchable, but it is their set.
        case limited
        case full
    }

    /// iOS's read authorization, collapsed to the three the agent can act on.
    /// `.restricted`/`.denied` both mean none: the difference is why, and there
    /// is no different move to make about it.
    static func scope() -> Scope {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return .full
        case .limited: return .limited
        default: return .none
        }
    }

    /// Asks iOS for read access, once. Returns the scope that resulted, so the
    /// caller reports what the user actually chose rather than what was asked
    /// for -- "limited" after a full-access prompt is a normal, common answer.
    static func requestAccess() async -> Scope {
        await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
                continuation.resume(returning: scope())
            }
        }
    }

    // MARK: - Session ids

    /// Local identifiers handed out since the app came to the foreground.
    ///
    /// The agent never sees a raw `PHAsset.localIdentifier`: those are stable
    /// across launches, so a leaked one is a durable handle on someone's photo
    /// library. An opaque short id that dies with the session is not (PRD
    /// decision 6). Cleared by `endSession` on every background edge.
    private static var sessionIds: [String: String] = [:]
    private static let sessionLock = NSLock()

    /// Called on the background edge. A `photos_get` against an id minted
    /// before this returns a stated "that search expired" rather than an empty
    /// result -- an empty result reads as "you have no such photo", which sends
    /// the agent looking for a different one that does not exist either.
    static func endSession() {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        sessionIds.removeAll()
    }

    private static func mintId(for localIdentifier: String) -> String {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        // 12 hex chars: short enough to sit in a JSON reply an agent reads,
        // wide enough that a collision inside one session is not a real risk.
        let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
        sessionIds[String(id)] = localIdentifier
        return String(id)
    }

    private static func localIdentifier(for id: String) -> String? {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return sessionIds[id]
    }

    // MARK: - Search

    struct Query {
        /// Inclusive lower bound on creation date.
        var after: Date?
        /// Exclusive upper bound, so two adjacent month queries cannot both
        /// return the same midnight photo.
        var before: Date?
        /// nil means "either" -- an absent filter, not `false`.
        var isScreenshot: Bool?
        var limit: Int
    }

    /// Metadata for every match, newest first, capped at `query.limit`.
    ///
    /// `matched` is the count BEFORE the cap, so an agent can tell "these are
    /// all of them" from "these are the first 20 of 400" and say so instead of
    /// quietly answering from a truncated set.
    static func search(_ query: Query) -> (scope: Scope, matched: Int, photos: [[String: Any]]) {
        let current = scope()
        guard current != .none else { return (current, 0, []) }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

        var predicates: [NSPredicate] = [
            // Images only. A video's first frame is not what "photo" means to
            // anyone who asked for one.
            NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        ]
        if let after = query.after {
            predicates.append(NSPredicate(format: "creationDate >= %@", after as NSDate))
        }
        if let before = query.before {
            predicates.append(NSPredicate(format: "creationDate < %@", before as NSDate))
        }
        if let isScreenshot = query.isScreenshot {
            // A bitmask, not a boolean column: `photoScreenshot` is one flag
            // among several in `mediaSubtypes`, so an equality test would miss
            // a screenshot that is also, say, an HDR capture.
            let mask = PHAssetMediaSubtype.photoScreenshot.rawValue
            predicates.append(
                isScreenshot
                    ? NSPredicate(format: "(mediaSubtypes & %d) != 0", mask)
                    : NSPredicate(format: "(mediaSubtypes & %d) == 0", mask)
            )
        }
        options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)

        let assets = PHAsset.fetchAssets(with: options)
        let matched = assets.count
        let cap = max(0, min(query.limit, matched))

        let formatter = ISO8601DateFormatter()
        var photos: [[String: Any]] = []
        photos.reserveCapacity(cap)
        for index in 0..<cap {
            let asset = assets.object(at: index)
            var row: [String: Any] = [
                "id": mintId(for: asset.localIdentifier),
                "isScreenshot": asset.mediaSubtypes.contains(.photoScreenshot),
                "w": asset.pixelWidth,
                "h": asset.pixelHeight,
                "favorite": asset.isFavorite
            ]
            if let taken = asset.creationDate {
                row["takenAt"] = formatter.string(from: taken)
            }
            photos.append(row)
        }
        return (current, matched, photos)
    }

    // MARK: - Fetch

    enum FetchError: String, Error {
        /// The id was minted in an earlier foreground session.
        case expired
        /// A live id whose asset is gone -- deleted, or dropped out of a
        /// limited selection the user has since narrowed.
        case missing
        case failed
    }

    /// JPEG bytes for one session id.
    ///
    /// Deliberately re-encoded rather than shipping the original file: an
    /// iPhone's originals are HEIC, and the Mac decodes JPEG/PNG only
    /// (`PHONE_IMAGE_MIMES`). Doing the conversion here also keeps a Live
    /// Photo's video half from riding along uninvited.
    static func jpeg(for id: String, maxPixel: CGFloat = 2048) async -> Result<Data, FetchError> {
        guard let localIdentifier = localIdentifier(for: id) else { return .failure(.expired) }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = assets.firstObject else { return .failure(.missing) }

        let options = PHImageRequestOptions()
        // The point of the whole feature is that the agent gets the real photo.
        // An `.opportunistic` request would hand back a thumbnail first and an
        // agent would read that, so this waits for the real one.
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        options.resizeMode = .exact
        options.isSynchronous = false

        let target = CGSize(width: maxPixel, height: maxPixel)
        let image: UIImage? = await withCheckedContinuation { continuation in
            var resumed = false
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: target,
                contentMode: .aspectFit,
                options: options
            ) { result, info in
                // `requestImage` can call back more than once even on
                // `.highQualityFormat` (a degraded pass, then the real one),
                // and resuming a continuation twice is a crash, not a warning.
                guard !resumed else { return }
                let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                guard !degraded || result == nil else { return }
                resumed = true
                continuation.resume(returning: result)
            }
        }

        guard let image, let data = image.jpegData(compressionQuality: 0.9) else {
            return .failure(.failed)
        }
        return .success(data)
    }
}
