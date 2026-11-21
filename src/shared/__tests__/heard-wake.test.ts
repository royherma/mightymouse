import { describe, it, expect } from 'vitest'
import { matchHeardWake, matchWakePhrase } from '../companion-barge-in'

describe('matchHeardWake (the wake model already heard "Hey Mighty")', () => {
  it.each([
    ['They might open Safari', 'open Safari'],
    ['Hey mite, what time is it?', 'what time is it?'],
    ["A Mighty's mouse open Notes", 'open Notes'],
    ['Hey Marty. Play some jazz', 'Play some jazz'],
    ['Mighty Mouse, close Slack', 'close Slack']
  ])('cuts the misheard name off %j', (heard, request) => {
    expect(matchHeardWake(heard)).toEqual({ addressed: true, request })
  })

  it('the text matcher alone throws these away, which is why the wake model vouches', () => {
    expect(matchWakePhrase('They might open Safari').addressed).toBe(false)
  })

  it('keeps the whole sentence when no name sound is in it', () => {
    expect(matchHeardWake('open Safari')).toEqual({ addressed: true, request: 'open Safari' })
  })

  it('only looks for the name in the first three words', () => {
    expect(matchHeardWake('can you please might open it').request).toBe('can you please might open it')
  })

  it('the name alone leaves an empty request', () => {
    expect(matchHeardWake('Mite.')).toEqual({ addressed: true, request: '' })
  })
})
