import { describe, it, expect } from 'vitest'
import { sessionCompactingSince, setAgentSessionCompacting } from '../http-listener'

describe('session compacting state', () => {
  it('stamps a thread the relay has no row for, keyed as sent', () => {
    const before = Date.now()
    setAgentSessionCompacting('  codex-thread-1  ', true, false)
    expect(sessionCompactingSince('codex-thread-1')).toBeGreaterThanOrEqual(before)
  })

  it('clears on the end event whether the compaction was auto or manual', () => {
    setAgentSessionCompacting('codex-thread-2', true, false)
    setAgentSessionCompacting('codex-thread-2', false, false)
    expect(sessionCompactingSince('codex-thread-2')).toBeUndefined()
    setAgentSessionCompacting('codex-thread-3', true, true)
    setAgentSessionCompacting('codex-thread-3', false, true)
    expect(sessionCompactingSince('codex-thread-3')).toBeUndefined()
  })

  it('ignores a blank id', () => {
    setAgentSessionCompacting('   ', true, false)
    expect(sessionCompactingSince('')).toBeUndefined()
    expect(sessionCompactingSince(undefined)).toBeUndefined()
  })
})
