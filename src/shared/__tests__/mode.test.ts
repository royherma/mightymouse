import { describe, it, expect } from 'vitest'
import { detectMode, stripModePrefix } from '../mode'

describe('detectMode', () => {
  // Prefix shortcuts
  it('? prefix → ask', () => expect(detectMode('?what is this')).toBe('ask'))
  it('! prefix → act', () => expect(detectMode('!do something')).toBe('act'))

  // Leading whitespace around prefix
  it('  ? with leading space → ask', () => expect(detectMode('  ?anything')).toBe('ask'))
  it('  ! with leading space → act', () => expect(detectMode('  !anything')).toBe('act'))

  // ACT verbs (from CONFIG.ACT_VERBS)
  it('convert <file> → act', () => expect(detectMode('convert this file')).toBe('act'))
  it('make something → act', () => expect(detectMode('make a backup')).toBe('act'))
  it('create a report → act', () =>
    expect(detectMode('create a report')).toBe(
      'create a report'.toLowerCase().startsWith('create ') ? 'act' : 'act'
    ))
  it('remove background → act', () =>
    expect(detectMode('remove background from image')).toBe('act'))
  it('turn this into → act', () => expect(detectMode('turn this into a PDF')).toBe('act'))
  it('run the script → act', () => expect(detectMode('run the script')).toBe('act'))

  // ASK verbs (from CONFIG.ASK_VERBS)
  it('what is this → ask', () => expect(detectMode('what is this')).toBe('ask'))
  it("what's this → ask", () => expect(detectMode("what'this")).toBe('ask'))
  it('tell me about → ask', () => expect(detectMode('tell me about that')).toBe('ask'))
  it('summarize → ask', () => expect(detectMode('summarize this document')).toBe('ask'))
  it('explain → ask', () => expect(detectMode('explain the context')).toBe('ask'))
  it('why does → ask', () => expect(detectMode('why does this fail')).toBe('ask'))

  // Rewrite (plain instruction, no verb match)
  it('fix the grammar → rewrite', () => expect(detectMode('fix the grammar')).toBe('rewrite'))
  it('shorter please → rewrite', () => expect(detectMode('shorter please')).toBe('rewrite'))
  it('rephrase this → rewrite', () => expect(detectMode('rephrase this')).toBe('rewrite'))

  // Case-insensitivity
  it('WHAT is this (uppercase) → ask', () => expect(detectMode('WHAT is this')).toBe('ask'))
  it('CONVERT file (uppercase) → act', () => expect(detectMode('CONVERT file.mp4')).toBe('act'))
  it('Make it (mixed case) → act', () => expect(detectMode('Make a copy')).toBe('act'))

  // Trimming
  it('  what is this (leading spaces) → ask', () =>
    expect(detectMode('  what is this')).toBe('ask'))
  it('convert file   (trailing spaces in input) → act', () =>
    expect(detectMode('convert file   ')).toBe('act'))
})

describe('stripModePrefix', () => {
  it('? prefix stripped', () => expect(stripModePrefix('?what is this')).toBe('what is this'))
  it('! prefix stripped', () => expect(stripModePrefix('!do x')).toBe('do x'))
  it('space after prefix stripped', () => expect(stripModePrefix('? hello')).toBe('hello'))
  it('leading space + prefix stripped', () => expect(stripModePrefix('  ? hello')).toBe('hello'))
  it('only the first char is a prefix', () => expect(stripModePrefix('!!urgent')).toBe('!urgent'))
  it('no prefix → unchanged', () => expect(stripModePrefix('no prefix')).toBe('no prefix'))
  it('a question with no prefix is untouched', () =>
    expect(stripModePrefix('what is this?')).toBe('what is this?'))
})
