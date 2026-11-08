import { describe, it, expect } from 'vitest'
import { casual, formatTranscript, isFormatOn, stripFillers, TRANSCRIPT_FORMATS } from '../transcript-format'

describe('stripFillers', () => {
  it('drops a leading filler and capitalises the next word', () => {
    expect(stripFillers('Um, so I think we should go.')).toBe('So I think we should go.')
  })

  it('drops a filler that opens a later sentence', () => {
    expect(stripFillers('That works. Uh, next thing is the deploy.')).toBe('That works. Next thing is the deploy.')
  })

  it('drops mid-sentence fillers and their commas', () => {
    expect(stripFillers('I think, um, we uh should ship it.')).toBe('I think we should ship it.')
  })

  it('drops a trailing filler before the full stop', () => {
    expect(stripFillers("That's fine hmm.")).toBe("That's fine.")
  })

  it('handles stretched spellings', () => {
    expect(stripFillers('Ummm, uhhh, erm, yes.')).toBe('Yes.')
  })

  it('leaves words that merely contain a filler alone', () => {
    const text = 'Bring the umbrella and the hummus to Uhura.'
    expect(stripFillers(text)).toBe(text)
  })

  it('returns empty for a transcript that is only filler', () => {
    expect(stripFillers('Um. Uh.')).toBe('')
  })

  it('keeps "mm" when it is a unit, not a hum', () => {
    expect(stripFillers('The screw is 5 mm wide.')).toBe('The screw is 5 mm wide.')
  })

  it('keeps "ER" when it means the emergency room', () => {
    expect(stripFillers('She went to the ER.')).toBe('She went to the ER.')
  })
})

describe('casual', () => {
  it('lowercases and drops trailing punctuation', () => {
    expect(casual('Hey, what is up. See you Later!')).toBe('hey what is up see you later')
  })

  it('keeps punctuation inside a token', () => {
    expect(casual('Version 3.5 is out.')).toBe('version 3.5 is out')
  })
})

describe('isFormatOn', () => {
  const fillers = TRANSCRIPT_FORMATS.find((f) => f.id === 'fillers')!

  it('falls back to the default when nothing is saved', () => {
    expect(isFormatOn(fillers, undefined)).toBe(true)
    expect(isFormatOn(fillers, {})).toBe(true)
  })

  it('honours a saved off switch', () => {
    expect(isFormatOn(fillers, { fillers: false })).toBe(false)
  })
})

describe('formatTranscript', () => {
  it('strips fillers from English by default', () => {
    expect(formatTranscript('Um, hello there.', 'en', undefined)).toBe('Hello there')
  })

  it('never strips fillers from a non-English transcript', () => {
    expect(formatTranscript('Um, hallo.', 'de', undefined)).toBe('Um, hallo')
  })

  it('leaves fillers when the user switched the formatter off', () => {
    expect(formatTranscript('Um, hello.', 'en', { fillers: false })).toBe('Um, hello')
  })

  it('does not apply bro mode unless the phrase is spoken', () => {
    expect(formatTranscript('Hey, what is up.', 'en', undefined)).toBe('Hey, what is up')
  })

  it('bro mode removes the spoken trigger and pastes casual text', () => {
    expect(formatTranscript('Hey, what is up. Bro mode.', 'en', undefined)).toBe('hey what is up')
  })

  it('bro mode trigger works mid-sentence, hyphenated, and as the misheard "bro mod"', () => {
    expect(formatTranscript('Bro-mode, See You At Five.', 'en', undefined)).toBe('see you at five')
    expect(formatTranscript('Running late bro mod, Sorry.', 'en', undefined)).toBe('running late sorry')
  })

  it('bro mode fires in any language', () => {
    expect(formatTranscript('Hallo Leute. Bro mode.', 'de', undefined)).toBe('hallo leute')
  })

  it('does not fire on a word that only starts with the trigger', () => {
    expect(formatTranscript('The bromodes list.', 'en', undefined)).toBe('The bromodes list')
  })

  it('switched-off bro mode leaves the phrase in the text', () => {
    expect(formatTranscript('Hey. Bro mode.', 'en', { bro: false })).toBe('Hey. Bro mode.')
  })

  it('runs fillers and bro mode together', () => {
    expect(formatTranscript('Um, Hey, uh, bro mode, What Is Up.', 'en', undefined)).toBe('hey what is up')
  })
})
