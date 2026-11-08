import { describe, expect, it } from 'vitest'
import { guessProjectIcon } from '../mighty'

describe('guessProjectIcon', () => {
  it('reads Roy\'s real project names', () => {
    expect(guessProjectIcon('DataLabellingCo')).toBe('database')
    expect(guessProjectIcon('Creators-of-Today')).toBe('palette')
    expect(guessProjectIcon('OpenString')).toBe('music')
  })

  it('falls back to a folder rather than guessing', () => {
    expect(guessProjectIcon('Zzyzx')).toBe('folder')
    // A name that says nothing about what it is keeps the folder. PetFomo is a
    // real one: nothing in it reads as phone, data or design.
    expect(guessProjectIcon('PetFomo')).toBe('folder')
  })

  it('reads the repo folder when the name says nothing', () => {
    expect(guessProjectIcon('Untitled', '/Users/r/dev/my-ios-app')).toBe('phone')
  })
})
