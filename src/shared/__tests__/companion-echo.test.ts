import { describe, expect, it } from 'vitest'
import { echoTail, loudMs, stripEcho, wordSpan } from '../companion-barge-in'

describe('stripEcho', () => {
  it('drops the reply heard back through the mic', () => {
    expect(stripEcho('Your build passed on main', 'Your build passed on main today.')).toBe('')
  })

  it('keeps what you said over the reply', () => {
    expect(stripEcho('passed on main stop the deploy', 'Your build passed on main')).toBe('stop the deploy')
  })

  it('only strips words heard in the order they were said', () => {
    expect(stripEcho('main on passed', 'passed on main')).toBe('main on passed')
  })

  it('a single word is echo only if it is still playing', () => {
    const said = 'Your build\npassed'
    expect(stripEcho('passed', said)).toBe('')
    expect(stripEcho('Your', said)).toBe('Your')
  })

  it('ignores case, punctuation and plurals', () => {
    expect(stripEcho('Builds, passed!', 'the build passed')).toBe('')
  })

  it('with nothing said, returns what was heard', () => {
    expect(stripEcho('  open Safari ', '')).toBe('open Safari')
  })
})

describe('echoTail / wordSpan', () => {
  const text = 'a b c d e f g h i j'

  it('slices words by fraction of the clip, clamped to the clip', () => {
    expect(wordSpan(text, 0.3, 0.6)).toBe('d e f')
    expect(wordSpan(text, -0.5, 0.2)).toBe('a b')
    expect(wordSpan(text, 0.9, 3)).toBe('j')
  })

  it('splits what already played from what is still playing', () => {
    expect(echoTail(text, 0.5, 0.2)).toBe('d e\nf g h i j')
    expect(echoTail(text, 0.5, 0.2, 0.8)).toBe('d e\nf g h')
  })
})

describe('loudMs', () => {
  const FRAME = 512
  const clip = (loudFrames: number, level = 0.5): Float32Array => {
    const a = new Float32Array(16000)
    a.fill(level, 0, loudFrames * FRAME)
    return a
  }

  it('counts 32ms frames at or above the floor', () => {
    expect(loudMs(clip(5), 0.02)).toBe(160)
    expect(loudMs(clip(10), 0.02)).toBe(320)
  })

  it('silence and sound under the floor are 0', () => {
    expect(loudMs(new Float32Array(16000), 0.02)).toBe(0)
    expect(loudMs(clip(10, 0.01), 0.02)).toBe(0)
  })

  it('ignores a trailing partial frame', () => {
    const a = new Float32Array(FRAME + 100).fill(0.5)
    expect(loudMs(a, 0.02)).toBe(32)
  })
})
