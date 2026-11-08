import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from '../shortcuts'

// A mnemonic exists to make an arbitrary letter memorable ("L is for Listen"),
// so one that doesn't start with its own cap teaches the wrong thing. The tour
// renders both from the same row, so only this check keeps them in step.
describe('shortcut mnemonics', () => {
  it('start with the key they explain', () => {
    for (const s of SHORTCUTS) {
      if (!s.mnemonic) continue
      expect(s.mnemonic[0].toUpperCase(), `${s.id}: "${s.mnemonic}" vs cap "${s.glyph}"`).toBe(
        s.glyph.toUpperCase()
      )
    }
  })

  // The three the tour teaches are the ones this was built for — a future edit
  // dropping one would silently take the memory hook off that step.
  it('cover every hotkey the tour teaches', () => {
    for (const id of ['main', 'capture', 'listen']) {
      expect(SHORTCUTS.find((s) => s.id === id)?.mnemonic, id).toBeTruthy()
    }
  })
})
