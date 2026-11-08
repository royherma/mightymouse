import { describe, expect, it } from 'vitest'
import { guessProjectIcon } from '../mighty'

describe('guessProjectIcon', () => {
  it('reads real-world project names', () => {
    expect(guessProjectIcon('LabelCo')).toBe('database')
    expect(guessProjectIcon('Creator-Hub')).toBe('palette')
    expect(guessProjectIcon('StringLab')).toBe('music')
  })

  it('falls back to a folder rather than guessing', () => {
    expect(guessProjectIcon('Zzyzx')).toBe('folder')
    // A name that says nothing about what it is keeps the folder. Acme is a
    // real one: nothing in it reads as phone, data or design.
    expect(guessProjectIcon('Acme')).toBe('folder')
  })

  it('reads the repo folder when the name says nothing', () => {
    expect(guessProjectIcon('Untitled', '/Users/r/dev/my-ios-app')).toBe('phone')
  })
})
