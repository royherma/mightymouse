import { describe, it, expect } from 'vitest'
import { reportsForPoll, type PermissionObservation } from './permission-report'
import type { PermissionKey, PermissionStatus } from './types'

const poll = (states: PermissionObservation[], seen = new Map<PermissionKey, PermissionStatus>()) =>
  ({ reports: reportsForPoll(states, seen), seen })

describe('reportsForPoll', () => {
  // The regression this whole change exists for: a fresh install that never
  // grants Accessibility used to emit nothing, so "stuck at denied" and "never
  // opened the app" were the same silence.
  it('reports a first-observation denial instead of swallowing it', () => {
    const { reports } = poll([{ key: 'accessibility', status: 'denied' }])
    expect(reports).toEqual([
      { permission: 'accessibility', status: 'denied', at_launch: true }
    ])
  })

  it('marks the first observation at_launch and a later change not', () => {
    const seen = new Map<PermissionKey, PermissionStatus>()
    const first = reportsForPoll([{ key: 'screen', status: 'denied' }], seen)
    const changed = reportsForPoll([{ key: 'screen', status: 'granted' }], seen)
    expect(first[0].at_launch).toBe(true)
    expect(changed[0]).toEqual({ permission: 'screen', status: 'granted', at_launch: false })
  })

  it('emits nothing while the status is unchanged, however often it polls', () => {
    const seen = new Map<PermissionKey, PermissionStatus>()
    reportsForPoll([{ key: 'microphone', status: 'granted' }], seen)
    for (let i = 0; i < 20; i++) {
      expect(reportsForPoll([{ key: 'microphone', status: 'granted' }], seen)).toEqual([])
    }
  })

  // 'unknown' means our own check threw, not that the user decided anything.
  it('never reports unknown, and does not let it poison the next real read', () => {
    const seen = new Map<PermissionKey, PermissionStatus>()
    expect(reportsForPoll([{ key: 'screen', status: 'unknown' }], seen)).toEqual([])
    const later = reportsForPoll([{ key: 'screen', status: 'granted' }], seen)
    expect(later[0]).toEqual({ permission: 'screen', status: 'granted', at_launch: true })
  })

  it('reports a revocation after a grant', () => {
    const seen = new Map<PermissionKey, PermissionStatus>()
    reportsForPoll([{ key: 'accessibility', status: 'granted' }], seen)
    const revoked = reportsForPoll([{ key: 'accessibility', status: 'denied' }], seen)
    expect(revoked[0]).toEqual({ permission: 'accessibility', status: 'denied', at_launch: false })
  })

  it('covers every key in one launch poll, granted and denied alike', () => {
    const { reports } = poll([
      { key: 'accessibility', status: 'granted' },
      { key: 'screen', status: 'denied' },
      { key: 'microphone', status: 'denied' }
    ])
    expect(reports).toHaveLength(3)
    expect(reports.every((r) => r.at_launch)).toBe(true)
    expect(reports.filter((r) => r.status === 'denied').map((r) => r.permission)).toEqual([
      'screen',
      'microphone'
    ])
  })
})
