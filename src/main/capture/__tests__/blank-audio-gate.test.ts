import { describe, it, expect } from 'vitest'
import { countWords } from '../whisper'

// Both dictation paths (Mac listen, phone clip) gate their paste on
// countWords(), because whisper returns markers for silence and background
// noise. A non-empty check passes those straight through to the clipboard --
// which pasted a literal "[BLANK_AUDIO]" into whatever app was frontmost.
describe('blank-audio paste gate', () => {
  it('scores silence as zero words', () => {
    expect(countWords('[BLANK_AUDIO]')).toBe(0)
  })

  it('scores music and other non-speech markers as zero', () => {
    expect(countWords('[MUSIC_PLAYING]')).toBe(0)
    expect(countWords('[BLANK_AUDIO]\n[BLANK_AUDIO]')).toBe(0)
    expect(countWords('  [SOUND]  ')).toBe(0)
  })

  it('still counts real speech that sits beside a marker', () => {
    expect(countWords('[BLANK_AUDIO] hello there')).toBe(2)
  })

  it('counts ordinary speech', () => {
    expect(countWords('open the terminal')).toBe(3)
  })
})
