/** A TRANSIENT fault must never destroy this device's credential. The Mac
 *  learned this 2026-08-16 (`credentialLoadFailed`); the phone did not,
 *  because nothing tested the wire -- so on 08-17 it cost three QR scans. */
import { describe, it, expect } from 'vitest'
import type { BlockedReason } from '../connection-state'
import { shouldClearCredential } from './useConnection'

// Every reason the Mac can close a 4401 with. The compiler holds this to the
// union, so a new reason fails here until someone decides which side it lands on.
const ALL_REASONS: BlockedReason[] = [
  'no-credential',
  'credential-revoked',
  'mac-unreachable',
  'mac-busy',
  'rate-limited'
]

describe('shouldClearCredential', () => {
  it('clears on a revoke that arrived on an OPEN session', () => {
    // The user tapped X on the Mac. This is the only shape that may delete.
    expect(shouldClearCredential('credential-revoked', true, true)).toBe(true)
    expect(shouldClearCredential('no-credential', true, true)).toBe(true)
  })

  it('never clears on a socket that never opened', () => {
    // The bug: a tunnel drop mid-handshake wears the same reason as a revoke,
    // and deleting here is unrecoverable -- the tombstone blocks the Keychain
    // read-back too, so the only way out is a QR scan.
    for (const reason of ALL_REASONS) {
      expect(shouldClearCredential(reason, false, true)).toBe(false)
    }
  })

  it('never clears when the dial PRESENTED no credential', () => {
    // 2026-08-19, three times in an evening: the journal reads
    // `rejected no-credential ... cred=no opened=yes`. The Mac is describing
    // what arrived, so a dial that sent nothing draws this reason without the
    // stored copy being wrong -- and deleting turns one failed read into a
    // permanent one, because `removeCredential` wipes the Keychain outright.
    for (const reason of ALL_REASONS) {
      expect(shouldClearCredential(reason, true, false)).toBe(false)
    }
  })

  it('never clears on mac-unreachable, even on an open socket', () => {
    // What the Mac downgrades to when its OWN device file is unreadable
    // (server.ts, `credentialLoadFailed`) -- "we cannot tell right now".
    expect(shouldClearCredential('mac-unreachable', true, true)).toBe(false)
  })

  it('only ever clears for reasons that are a statement about the CREDENTIAL', () => {
    // A reason about the Mac's availability can never delete a credential.
    const aboutTheCredential = new Set<BlockedReason>(['no-credential', 'credential-revoked'])
    for (const reason of ALL_REASONS) {
      for (const everOpened of [true, false]) {
        for (const presented of [true, false]) {
          if (shouldClearCredential(reason, everOpened, presented)) {
            expect(aboutTheCredential.has(reason)).toBe(true)
            expect(everOpened).toBe(true)
            expect(presented).toBe(true)
          }
        }
      }
    }
  })
})
