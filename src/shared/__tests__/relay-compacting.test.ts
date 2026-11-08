import { describe, it, expect } from 'vitest'
import { BUSY_MAX_MS, ACTIVITY_MAX_MS, sessionIsCompacting, sessionIsWorking, sessionRow } from '../relay-status'
import { CONFIG } from '../config'

const NOW = 1_786_600_000_000

describe('compacting sessions', () => {
  it('is compacting from the stamp until the busy cap runs out', () => {
    expect(sessionIsCompacting({ compactingSince: NOW - 1000 }, NOW)).toBe(true)
    expect(sessionIsCompacting({ compactingSince: NOW - BUSY_MAX_MS }, NOW)).toBe(false)
    expect(sessionIsCompacting({}, NOW)).toBe(false)
  })

  it('counts as working even with no busy stamp or stale activity', () => {
    expect(sessionIsWorking({ compactingSince: NOW - 1000 }, NOW)).toBe(true)
    expect(
      sessionIsWorking({ compactingSince: NOW - 1000, busySince: NOW - 5000, lastActivityAt: NOW - ACTIVITY_MAX_MS - 1 }, NOW)
    ).toBe(true)
  })

  it('a stale compaction stamp does not keep a finished session working', () => {
    expect(sessionIsWorking({ compactingSince: NOW - BUSY_MAX_MS - 1 }, NOW)).toBe(false)
  })

  it('the row says Compacting instead of Responding', () => {
    const row = sessionRow({ label: 'a', busySince: NOW - 1000, lastActivityAt: NOW - 1000, compactingSince: NOW - 500 }, NOW)
    expect(row.health).toBe('working')
    expect(row.state_text).toBe(CONFIG.UI_LABELS.CODE_SESSION_COMPACTING_SHORT)
    expect(sessionRow({ label: 'a', busySince: NOW - 1000, lastActivityAt: NOW - 1000 }, NOW).state_text).toBe('Responding…')
  })
})
