import { describe, it, expect } from 'vitest'
import {
  micTraceLeftover,
  micTraceNativeStopped,
  micTraceStop
} from '../mic-trace'

describe('micTraceStop', () => {
  it('includes inert age for grep-friendly stop lines', () => {
    expect(micTraceStop({ why: 'tap-while-live', discard: false, state: 'toggled', gen: 3, inertSince: 1000, now: 1200 })).toBe(
      'mic stop why=tap-while-live discard=false state=toggled gen=3 inertAgeMs=200'
    )
  })
})

describe('micTraceLeftover', () => {
  it('names the site that swallowed the ghost tap', () => {
    expect(micTraceLeftover('mic-btn', 'toggled', 1000, 1150)).toContain('site=mic-btn')
    expect(micTraceLeftover('cancel', 'toggled', 1000, 1150)).toContain('inertAgeMs=150')
  })
})

describe('micTraceNativeStopped', () => {
  it('predicts hold-longer vs cancelled vs sent', () => {
    expect(
      micTraceNativeStopped({ discarded: true, durationMs: 42, jsDiscard: false, silent: false }).includes('toast=hold-longer')
    ).toBe(true)
    expect(
      micTraceNativeStopped({ discarded: true, durationMs: 42, jsDiscard: true, silent: false }).includes('toast=cancelled')
    ).toBe(true)
    expect(
      micTraceNativeStopped({ discarded: false, durationMs: 900, jsDiscard: false, silent: false }).includes('toast=sent')
    ).toBe(true)
  })
})
