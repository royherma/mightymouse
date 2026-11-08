/**
 * The recovery path for a shim too old to send its own name. Real files in a
 * temp HOME, because the whole point is reading a directory the hook wrote --
 * a mocked fs would pass while the actual lookup missed by a path segment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { publishedNameFor, clearPublishedNameCache } from '../published-names'

let home: string
const realHome = process.env.HOME

function publish(sessionId: string, name: string): void {
  writeFileSync(join(home, '.claude', '.session-names', sessionId), `${name}\n`)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-names-'))
  mkdirSync(join(home, '.claude', '.session-names'), { recursive: true })
  process.env.HOME = home
  clearPublishedNameCache()
})

afterEach(() => {
  process.env.HOME = realHome
  clearPublishedNameCache()
  rmSync(home, { recursive: true, force: true })
})

describe('names published by the naming hook', () => {
  it('finds the name from the id head the shim put in its label', () => {
    // The row shows "ShowAndTell/dev - 3fc9b195"; the file is named for the FULL
    // session id, so the head has to match as a prefix or nothing is ever found.
    publish('3fc9b195-7b8a-4724-9586-b138cb945ce0', 'mm-look-last-commits-repo')
    expect(publishedNameFor('3fc9b195')).toBe('mm-look-last-commits-repo')
  })

  it('returns nothing when no name was ever published', () => {
    expect(publishedNameFor('deadbeef')).toBeUndefined()
  })

  it('ignores a tag that is not an id head', () => {
    // "mm-dev-718" is already a name. Prefix-matching it against the directory
    // could only ever produce a wrong answer, so it is never attempted.
    publish('mm-dev-718-and-then-some', 'wrong-answer')
    expect(publishedNameFor('mm-dev-718')).toBeUndefined()
  })

  it('survives a machine with no naming hook at all', () => {
    rmSync(join(home, '.claude', '.session-names'), { recursive: true, force: true })
    clearPublishedNameCache()
    expect(publishedNameFor('3fc9b195')).toBeUndefined()
  })

  it('trims the trailing newline the hook writes', () => {
    publish('08e3d94e-0000-0000-0000-000000000000', 'mm-dev-735')
    expect(publishedNameFor('08e3d94e')).toBe('mm-dev-735')
  })

  it('treats an empty name file as no name, not as a blank row', () => {
    publish('e94e9f25-0000-0000-0000-000000000000', '   ')
    expect(publishedNameFor('e94e9f25')).toBeUndefined()
  })
})
