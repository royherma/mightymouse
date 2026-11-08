import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivity, getActivity, initActivity } from '../activity'
import { CONFIG } from '../../shared/config'
import type { ActivityPayload } from '../../shared/types'

// activity.ts is pure logic: it tracks the current state, fans it out through an
// injected push function, and auto-resets done/error → idle after RESET_MS. We
// inject a vi.fn() for the push so no real island window is needed, and use fake
// timers to assert the reset without waiting.

describe('activity emitter', () => {
  let push: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    push = vi.fn()
    initActivity(push as (p: ActivityPayload) => void)
    // Reset to a known baseline; clears any pending reset timer from a prior test.
    setActivity('idle')
    push.mockClear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('records the current state and pushes it once', () => {
    setActivity('listening')
    expect(getActivity().state).toBe('listening')
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({ state: 'listening', detail: undefined, elapsed: undefined })
  })

  it('carries the detail label and elapsed through', () => {
    setActivity('done', 'Transcribed', 12)
    expect(getActivity()).toEqual({ state: 'done', detail: 'Transcribed', elapsed: 12 })
  })

  it('auto-resets to idle after a done state', () => {
    setActivity('done', 'Screenshot saved')
    expect(getActivity().state).toBe('done')
    vi.advanceTimersByTime(CONFIG.ISLAND.RESET_MS)
    expect(getActivity().state).toBe('idle')
  })

  it('auto-resets to idle after an error state', () => {
    setActivity('error', 'Failed')
    vi.advanceTimersByTime(CONFIG.ISLAND.RESET_MS)
    expect(getActivity().state).toBe('idle')
  })

  it('a new state cancels a pending reset from the previous one', () => {
    setActivity('done', 'first')
    // Before the reset fires, a fresh activity arrives.
    vi.advanceTimersByTime(CONFIG.ISLAND.RESET_MS - 1)
    setActivity('recording')
    // The stale reset must NOT clobber the live recording state.
    vi.advanceTimersByTime(CONFIG.ISLAND.RESET_MS)
    expect(getActivity().state).toBe('recording')
  })

  it('does not schedule a reset for non-terminal states', () => {
    setActivity('thinking', 'analyzing…')
    vi.advanceTimersByTime(CONFIG.ISLAND.RESET_MS * 2)
    expect(getActivity().state).toBe('thinking')
  })
})
