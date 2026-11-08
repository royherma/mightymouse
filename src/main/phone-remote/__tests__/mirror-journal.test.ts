import { describe, it, expect } from 'vitest'
import type { PhoneRemoteMessage, MirrorStopCause } from '../../../shared/phone-remote-protocol'

/** The handler journals a mirrorStop only when it names a cause worth counting.
 *  Locks the exact predicate in ipc/phone-remote.ts's 'mirrorStop' case. */
const shouldJournal = (msg: Extract<PhoneRemoteMessage, { type: 'mirrorStop' }>): boolean =>
  !!msg.cause && msg.cause !== 'user'

describe('mirrorStop journalling', () => {
  it('records every cause that is not a deliberate user stop', () => {
    const real: MirrorStopCause[] = [
      'connect-timeout',
      'ice-failed',
      'mac-stopped',
      'disconnected',
      'offer-failed',
      'restart'
    ]
    for (const cause of real) {
      expect(shouldJournal({ type: 'mirrorStop', cause })).toBe(true)
    }
  })

  it('stays silent for a user toggle and for a bare stop', () => {
    expect(shouldJournal({ type: 'mirrorStop', cause: 'user' })).toBe(false)
    expect(shouldJournal({ type: 'mirrorStop' })).toBe(false)
  })
})
