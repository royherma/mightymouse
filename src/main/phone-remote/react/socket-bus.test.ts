import { describe, expect, it, vi } from 'vitest'
import { createSocketBus } from './socket-bus'

describe('socket bus', () => {
  it('routes events by type and unsubscribes', () => {
    const bus = createSocketBus()
    const handler = vi.fn()
    const unsubscribe = bus.subscribe('pong', handler)

    bus.dispatch({ type: 'pong' })
    expect(handler).toHaveBeenCalledOnce()

    unsubscribe()
    bus.dispatch({ type: 'pong' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('ignores an event with no subscribers', () => {
    const bus = createSocketBus()
    expect(() => bus.dispatch({ type: 'pong' })).not.toThrow()
  })
})
