import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ActionLogRow } from '../action-log'

let rows: ActionLogRow[] = []

vi.mock('../action-log', () => ({
  readRecentActionRows: (): ActionLogRow[] => rows
}))

import { slotValueBoost, invalidatePersonalModel } from '../personal-model'

function outcome(suggested: string, ran: string): ActionLogRow {
  return {
    ts: new Date().toISOString(),
    event: 'outcome',
    runId: 'r',
    trigger: 'voice',
    frontApp: 'Chrome',
    topActionId: 'open-app',
    chosenActionId: 'open-app',
    suggestedSlots: { app: suggested },
    slots: { app: ran },
    outcome: 'accepted',
    ok: true,
    line: '',
    runMs: 1
  }
}

describe('slotValueBoost', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    rows = []
    invalidatePersonalModel()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is neutral for a value with no history', () => {
    expect(slotValueBoost('Chrome', 'open-app', 'app', 'spark')).toBe(1)
  })

  it('stays neutral below the weighted-shows floor', () => {
    rows = [outcome('spotify', 'spark'), outcome('spotify', 'spark')]
    expect(slotValueBoost('Chrome', 'open-app', 'app', 'spark')).toBe(1)
  })

  it('lifts the value the user kept correcting to, and sinks the guess', () => {
    rows = [outcome('spotify', 'spark'), outcome('spotify', 'spark'), outcome('spotify', 'spark')]
    expect(slotValueBoost('Chrome', 'open-app', 'app', 'spark')).toBeGreaterThan(1)
    expect(slotValueBoost('Chrome', 'open-app', 'app', 'spotify')).toBeLessThan(1)
  })

  it('does not leak across front apps', () => {
    rows = [outcome('spotify', 'spark'), outcome('spotify', 'spark'), outcome('spotify', 'spark')]
    expect(slotValueBoost('Slack', 'open-app', 'app', 'spark')).toBe(1)
  })

  it('an accepted suggestion reinforces the value that ran', () => {
    rows = [outcome('spark', 'spark'), outcome('spark', 'spark'), outcome('spark', 'spark')]
    expect(slotValueBoost('Chrome', 'open-app', 'app', 'spark')).toBeGreaterThan(1)
  })
})
