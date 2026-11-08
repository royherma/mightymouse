import { describe, it, expect } from 'vitest'
import { parseKeyCombo } from '../phone-remote-keys'

// This is the guard between a plain-text pref file and a spawned mm-input. A
// string that gets past it becomes real keystrokes on the Mac, so the bar is
// "provably in the vocabulary", not "looks like a combo".

describe('parseKeyCombo', () => {
  it('accepts a real chord and normalises case', () => {
    expect(parseKeyCombo('Cmd+Shift+V')).toBe('cmd+shift+v')
  })

  it('orders modifiers canonically so one chord has one stored spelling', () => {
    expect(parseKeyCombo('shift+cmd+v')).toBe(parseKeyCombo('cmd+shift+v'))
  })

  it('rejects a bare key — a modifierless global hotkey would eat the letter', () => {
    expect(parseKeyCombo('v')).toBeNull()
  })

  it('rejects a base key outside the vocabulary', () => {
    // mm-input keys its table by these literals; an unknown one exits non-zero
    // at the binary, which reads to the user as "the shortcut did nothing".
    expect(parseKeyCombo('cmd+voice')).toBeNull()
    expect(parseKeyCombo('cmd+f13')).toBeNull()
  })

  it('rejects an unknown modifier rather than dropping it silently', () => {
    expect(parseKeyCombo('hyper+v')).toBeNull()
  })

  it('rejects a repeated modifier', () => {
    expect(parseKeyCombo('cmd+cmd+v')).toBeNull()
  })

  it('rejects a modifier in the base position', () => {
    expect(parseKeyCombo('cmd+shift')).toBeNull()
  })

  it('rejects non-strings and empty input', () => {
    for (const bad of [null, undefined, 42, {}, '', '+', '++']) {
      expect(parseKeyCombo(bad)).toBeNull()
    }
  })

  it('does not let shell metacharacters through', () => {
    expect(parseKeyCombo('cmd+v; rm -rf /')).toBeNull()
    expect(parseKeyCombo('cmd+$(whoami)')).toBeNull()
  })
})
