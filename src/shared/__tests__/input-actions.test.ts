import { describe, it, expect } from 'vitest'
import { serializeAction, type InputAction } from '../input-actions'

describe('serializeAction', () => {
  it('serializes point actions, rounding coords', () => {
    expect(serializeAction({ verb: 'move', x: 10.4, y: 20.6 })).toEqual(['move', '10', '21'])
    expect(serializeAction({ verb: 'click', x: 100, y: 200 })).toEqual(['click', '100', '200'])
    expect(serializeAction({ verb: 'rightclick', x: 5, y: 6 })).toEqual(['rightclick', '5', '6'])
    expect(serializeAction({ verb: 'doubleclick', x: 1, y: 2 })).toEqual(['doubleclick', '1', '2'])
    expect(serializeAction({ verb: 'tripleclick', x: 3, y: 4 })).toEqual(['tripleclick', '3', '4'])
  })

  it('serializes drag with both points', () => {
    expect(serializeAction({ verb: 'drag', x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual([
      'drag', '1', '2', '3', '4'
    ])
  })

  it('serializes scroll with direction + amount', () => {
    expect(serializeAction({ verb: 'scroll', direction: 'down', amount: 5 })).toEqual([
      'scroll', 'down', '5'
    ])
    expect(serializeAction({ verb: 'scroll', direction: 'left', amount: 12 })).toEqual([
      'scroll', 'left', '12'
    ])
  })

  it('serializes keyboard actions verbatim', () => {
    expect(serializeAction({ verb: 'type', text: 'hello world' })).toEqual(['type', 'hello world'])
    expect(serializeAction({ verb: 'key', combo: 'cmd+a' })).toEqual(['key', 'cmd+a'])
    expect(serializeAction({ verb: 'keydown', key: 'shift' })).toEqual(['keydown', 'shift'])
    expect(serializeAction({ verb: 'keyup', key: 'shift' })).toEqual(['keyup', 'shift'])
  })

  it('maps verb names matching the native binary contract', () => {
    // Guards against drift between the union and MmInput.swift's `switch verb`.
    const verbs = (
      [
        { verb: 'move', x: 0, y: 0 },
        { verb: 'click', x: 0, y: 0 },
        { verb: 'rightclick', x: 0, y: 0 },
        { verb: 'doubleclick', x: 0, y: 0 },
        { verb: 'tripleclick', x: 0, y: 0 },
        { verb: 'drag', x1: 0, y1: 0, x2: 0, y2: 0 },
        { verb: 'scroll', direction: 'up', amount: 1 },
        { verb: 'type', text: '' },
        { verb: 'key', combo: '' },
        { verb: 'keydown', key: '' },
        { verb: 'keyup', key: '' }
      ] as InputAction[]
    ).map((a) => serializeAction(a)[0])
    expect(verbs).toEqual([
      'move', 'click', 'rightclick', 'doubleclick', 'tripleclick',
      'drag', 'scroll', 'type', 'key', 'keydown', 'keyup'
    ])
  })
})
