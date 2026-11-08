import { describe, expect, it } from 'vitest'
import { serializeAction } from './input-actions'
import { TMUX_ACTION, TMUX_PREFIX_KEY, TMUX_PREFIX_MODIFIER } from './phone-remote-keys'

// serializeAction builds mm-input's argv. A wrong shape here doesn't throw --
// it spawns the binary with arguments it silently misreads, so the assertions
// below are about the exact array, not just its length.

describe('serializeAction — key', () => {
  it('passes a single combo through as one argument', () => {
    expect(serializeAction({ verb: 'key', combo: 'ctrl+b' })).toEqual(['key', 'ctrl+b'])
  })

  it('spreads a combo LIST into separate argv entries', () => {
    // Not JSON, not comma-joined: mm-input reads args[2...] as one combo each.
    expect(serializeAction({ verb: 'key', combo: ['ctrl+b', 'z'] })).toEqual(['key', 'ctrl+b', 'z'])
  })

  it('preserves list order — the whole point of one spawn', () => {
    const argv = serializeAction({ verb: 'key', combo: ['ctrl+b', 'left'] })
    expect(argv.indexOf('ctrl+b')).toBeLessThan(argv.indexOf('left'))
  })

  it('treats a one-element list the same as the bare string', () => {
    expect(serializeAction({ verb: 'key', combo: ['escape'] })).toEqual(
      serializeAction({ verb: 'key', combo: 'escape' })
    )
  })

  it('never nests an array inside argv (would stringify at spawn)', () => {
    for (const arg of serializeAction({ verb: 'key', combo: ['cmd+a', 'delete'] })) {
      expect(typeof arg).toBe('string')
    }
  })
})

describe('the tmux zoom sequence this shape exists for', () => {
  it('serializes to exactly three argv entries', () => {
    const combos = [[TMUX_PREFIX_MODIFIER, TMUX_PREFIX_KEY].join('+'), TMUX_ACTION.zoom]
    expect(serializeAction({ verb: 'key', combo: combos })).toEqual(['key', 'ctrl+b', 'z'])
  })

  it('sends the prefix before the action key', () => {
    // Reversed, this types a literal 'z' into whatever is running.
    const argv = serializeAction({
      verb: 'key',
      combo: [[TMUX_PREFIX_MODIFIER, TMUX_PREFIX_KEY].join('+'), TMUX_ACTION.zoom]
    })
    expect(argv[1]).toBe('ctrl+b')
    expect(argv[2]).toBe('z')
  })
})

describe('serializeAction — other verbs still stringify numerically', () => {
  it('handles click coordinates', () => {
    expect(serializeAction({ verb: 'click', x: 12.6, y: 40 })).toEqual(['click', '13', '40'])
  })

  it('keeps type text as a single argument', () => {
    expect(serializeAction({ verb: 'type', text: 'hello world' })).toEqual(['type', 'hello world'])
  })
})
