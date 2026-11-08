import { describe, expect, it } from 'vitest'
import { chordFor, VK } from '../keymap'

const ascii = (ch: string): number => ch.toUpperCase().charCodeAt(0)

describe('chordFor', () => {
  it('maps Cmd to Ctrl', () => {
    expect(chordFor('cmd+v', ascii)).toEqual({
      modifiers: [VK.ctrl],
      key: { vk: 0x56, extended: false }
    })
  })

  it('maps Mac-only chords to their Windows equivalent', () => {
    expect(chordFor('cmd+tab', ascii)).toEqual({
      modifiers: [VK.alt],
      key: { vk: 0x09, extended: false }
    })
    expect(chordFor('cmd+q', ascii)).toEqual({
      modifiers: [VK.alt],
      key: { vk: 0x73, extended: false }
    })
    expect(chordFor('cmd+left', ascii)?.key.vk).toBe(0x24)
    expect(chordFor('cmd+up', ascii)).toEqual({
      modifiers: [VK.ctrl],
      key: { vk: 0x24, extended: true }
    })
    expect(chordFor('option+left', ascii)?.modifiers).toEqual([VK.ctrl])
  })

  it('keeps ctrl chords and ignores fn', () => {
    expect(chordFor('fn+ctrl+b', ascii)?.modifiers).toEqual([VK.ctrl])
  })

  it('rejects unknown keys', () => {
    expect(chordFor('cmd+§', () => null)).toBeNull()
    expect(chordFor('banana+a', ascii)).toBeNull()
  })
})
