import { describe, it, expect } from 'vitest'
import { choosePushTarget } from '../server-runtime'

const entry = (cred: string, deviceModel: string | null, pairedAt: number) => ({
  cred,
  rec: { deviceModel, pairedAt }
})

describe('choosePushTarget', () => {
  it('prefers the live credential when it holds a token', () => {
    const live = entry('live', 'iPhone17,1', 1)
    const older = entry('old', 'iPhone15,2', 99)
    expect(choosePushTarget([older, live], 'live', 'iPhone17,1').cred).toBe('live')
  })

  it('falls back to the same handset, not the newest stale phone', () => {
    const sibling = entry('sibling', 'iPhone17,1', 1)
    const strangerNewer = entry('stranger', 'iPhone15,2', 99)
    expect(choosePushTarget([strangerNewer, sibling], 'live-no-token', 'iPhone17,1').cred).toBe(
      'sibling'
    )
  })

  it('picks the newest sibling when the live phone holds several credentials', () => {
    const old = entry('old', 'iPhone17,1', 1)
    const fresh = entry('fresh', 'iPhone17,1', 50)
    expect(choosePushTarget([old, fresh], 'live-no-token', 'iPhone17,1').cred).toBe('fresh')
  })

  it('falls back to the newest token holder when the live model is unknown', () => {
    const a = entry('a', 'iPhone15,2', 10)
    const b = entry('b', 'iPhone15,2', 20)
    expect(choosePushTarget([a, b], null, null).cred).toBe('b')
  })

  it('does not mutate the caller list', () => {
    const list = [entry('a', 'x', 1), entry('b', 'x', 9)]
    choosePushTarget(list, null, null)
    expect(list.map((e) => e.cred)).toEqual(['a', 'b'])
  })
})
