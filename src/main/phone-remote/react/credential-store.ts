import { nativeBridge } from './native-bridge'

export interface CredentialStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const memory = new Map<string, string>()

/** Keys removed this session, so a cache miss cannot re-read the value we just
 *  deleted -- resurrecting a credential the server revoked and retrying it
 *  forever instead of falling back to the pairing screen.
 *
 *  Belt to `removeCredential`'s braces, NOT the only guard: `NativeBridge.swift`
 *  calls `reinjectBootstrap()` on every write, so the snapshot does refresh
 *  between reads. This still covers the window before that lands. Note what it
 *  cannot do -- once the Keychain entry is gone, no tombstone state decides
 *  anything, which is why the delete itself must stay rare. */
const cleared = new Set<string>()

/** Retire every tombstone -- a reached Mac supersedes whatever refusal set one.
 *  Without this, a negative cache with no expiry is a permanent delete: the
 *  Keychain copy stays unreadable for the rest of the launch. */
export function retireTombstones(): void {
  cleared.clear()
}

const browserStore: CredentialStore = {
  get(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return memory.get(key) ?? null
    }
  },
  set(key, value) {
    memory.set(key, value)
    try {
      localStorage.setItem(key, value)
    } catch {
      // Private-mode storage can reject writes; this session still works.
    }
  },
  remove(key) {
    memory.delete(key)
    try {
      localStorage.removeItem(key)
    } catch {
      // Best effort, matching the existing phone-local preference behavior.
    }
  }
}

/**
 * Synchronous by design: the current pairing path is synchronous at every
 * read site. The native shell hydrates this cache before the bundle runs and
 * writes through to Keychain; making this async would ripple through connect.
 */
export const credentialStore: CredentialStore = {
  get(key) {
    if (nativeBridge.available) {
      if (!memory.has(key) && !cleared.has(key)) {
        const value = nativeBridge.bootstrapCredential(key)
        if (value !== null) memory.set(key, value)
      }
      return memory.get(key) ?? null
    }
    // The bootstrap is a plain injected object, so it can be present while the
    // message handler is not -- a native launch whose `available` reads false
    // still carries the Keychain credential here. Reading it before falling
    // back stops that launch dialing with no credential at all, which the Mac
    // logs as `no-credential` and the phone renders as the pairing form, on a
    // device that never unpaired. Safari and a real PWA have no bootstrap, so
    // this is null for them and the browser store answers as before.
    if (!cleared.has(key)) {
      const bootstrapped = nativeBridge.bootstrapCredential(key)
      if (bootstrapped !== null) return bootstrapped
    }
    return browserStore.get(key)
  },
  // Both writes go through unconditionally. `storeCredential` is
  // `getHandler()?.postMessage(...)` -- fire-and-forget with no queue, so on a
  // launch whose message handler is missing it is a silent no-op. Returning
  // early there would drop the value into neither Keychain nor localStorage.
  // Mirroring instead costs one localStorage write on the healthy path and is
  // what makes a write survive the same missing handler `get()` already
  // survives.
  set(key, value) {
    memory.set(key, value)
    cleared.delete(key)
    if (nativeBridge.available) nativeBridge.storeCredential(key, value)
    browserStore.set(key, value)
  },
  remove(key) {
    memory.delete(key)
    cleared.add(key)
    if (nativeBridge.available) nativeBridge.removeCredential(key)
    browserStore.remove(key)
  }
}
