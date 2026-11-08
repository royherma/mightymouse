import Foundation
import Security

final class Credentials {
    private let service = "com.mightymouse.ios"

    /// Keychain accounts the WEB bundle owns get this prefix, so bootstrap can
    /// enumerate them without a hardcoded key list. Native-only secrets (the
    /// Supabase access token) are stored unprefixed and are therefore never
    /// handed to JavaScript -- injecting an auth bearer token into the webview
    /// would widen the blast radius of any XSS on the remote UI.
    static let webKeyPrefix = "web."

    /// The App Group doubles as a Keychain access group on iOS -- and unlike a
    /// `keychain-access-groups` entitlement entry it is used WITHOUT the team-id
    /// prefix. Never write `$(AppIdentifierPrefix)…` here: that macro only
    /// expands inside the .entitlements file at codesign time, and as a Swift
    /// literal it names a group no build is entitled to, so every pinned read
    /// AND write returns errSecMissingEntitlement (-34018). That literal was
    /// this file's one production bug.
    private static let accessGroup = SharedAppGroup.id

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: Self.accessGroup
        ]
    }

    func value(for key: String) -> String? {
        var query = baseQuery()
        query[kSecAttrAccount as String] = key
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        // -25308 (errSecInteractionNotAllowed) means the item is there and this
        // process may not have it right now: it was written before `set` began
        // pinning AfterFirstUnlock, so it still carries the WhenUnlocked
        // default and is unreadable while the phone is locked. That is exactly
        // when the NSE runs, so a stale item degrades every locked-screen card
        // -- silently, and forever, because the migration below only fires on
        // errSecItemNotFound and this item is found. Repairing it needs the
        // phone unlocked, so the read that succeeds is the one that heals it.
        if status == errSecInteractionNotAllowed {
            lastReadStatus = status
            return nil
        }
        if status == errSecItemNotFound {
            // Items written before the shared group existed live in the app-ID
            // group, which only the main app can see. Re-writing into the
            // shared group is what makes them reachable from the extensions.
            query.removeValue(forKey: kSecAttrAccessGroup as String)
            status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecSuccess, let data = result as? Data,
               let legacy = String(data: data, encoding: .utf8) {
                set(legacy, for: key)
                return legacy
            }
        }
        if status == errSecSuccess, let data = result as? Data,
           let value = String(data: data, encoding: .utf8) {
            upgradeAccessibilityIfNeeded(key: key, value: value)
            return value
        }
        guard status == errSecSuccess, let data = result as? Data else {
            // The OSStatus is the whole diagnosis and was previously discarded:
            // -25300 (missing item) and -34018 (entitlement mismatch) are the
            // same nil to a caller but completely different bugs.
            lastReadStatus = status
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /// Rewrites an item that predates the AfterFirstUnlock pin, so the next
    /// locked-phone read from an extension can see it. A no-op once the
    /// attribute is right, and only reachable from a read that already
    /// succeeded -- which means the phone is unlocked and the write can land.
    private func upgradeAccessibilityIfNeeded(key: String, value: String) {
        var query = baseQuery()
        query[kSecAttrAccount as String] = key
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let attributes = result as? [String: Any],
              let accessible = attributes[kSecAttrAccessible as String] as? String,
              accessible != (kSecAttrAccessibleAfterFirstUnlock as String) else { return }
        set(value, for: key)
    }

    /// Last non-success `OSStatus` from `value(for:)`, for surfacing in an
    /// extension where attaching a log stream is impractical.
    private(set) var lastReadStatus: OSStatus = errSecSuccess

    func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        var query = baseQuery()
        query[kSecAttrAccount as String] = key
        // AfterFirstUnlock, not the WhenUnlocked default: the NSE reads this
        // credential while the phone is LOCKED, and the default made every
        // locked-phone relay fetch fail (notification fell back to the app
        // icon). Set on update too, so pre-fix items migrate on next write.
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        if SecItemUpdate(query as CFDictionary, update as CFDictionary) != errSecSuccess {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    func remove(_ key: String) {
        // No access group pinned: a revoke must also delete any pre-migration
        // copy in the app-ID group, or the next read resurrects it.
        var query = baseQuery()
        query.removeValue(forKey: kSecAttrAccessGroup as String)
        query[kSecAttrAccount as String] = key
        SecItemDelete(query as CFDictionary)
    }

    /// Drops every stored key except the ones named, so a delete-and-reinstall
    /// actually signs the user out. Enumerates rather than naming keys, for the
    /// same reason `allBootstrapValues()` does.
    func removeAll(except keep: Set<String>) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]] else { return }
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String,
                  !keep.contains(account) else { continue }
            remove(account)
        }
    }

    /// True when the Keychain holds anything at all for this app.
    func hasAnyStoredValue() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    /// Enumerates the Keychain rather than naming keys: the canonical list is
    /// `CONFIG.PHONE_REMOTE` on the TS side, which Swift cannot import, so any
    /// list written here is a copy that silently rots.
    func allBootstrapValues() -> [String: String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]] else { return [:] }
        return items.reduce(into: [:]) { output, item in
            guard let account = item[kSecAttrAccount as String] as? String,
                  account.hasPrefix(Self.webKeyPrefix),
                  let data = item[kSecValueData as String] as? Data,
                  let value = String(data: data, encoding: .utf8) else { return }
            output[String(account.dropFirst(Self.webKeyPrefix.count))] = value
        }
    }
}
