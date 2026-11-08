// The release-notes parser is a REGEX over config.ts, not an import — so it can
// silently start returning zero changes the moment someone reformats
// RELEASE_NOTES or uses a quote style it doesn't handle. That failure is
// invisible: the GitHub body goes out empty (it did, four releases running) and
// the email refuses to send with no clue why.
//
// These tests parse the REAL config, so a formatting change that breaks the
// parser fails here instead of at publish time.

import { describe, it, expect } from 'vitest'
// @ts-expect-error - plain .mjs script, no types
import { readEntry } from '../../../scripts/release-body.mjs'
import { CONFIG } from '../config'

interface Entry {
  version: string
  date: string
  changes: { icon: string; title: string; detail: string }[]
}

describe('readEntry', () => {
  it('parses every RELEASE_NOTES entry with the same change count as the source', () => {
    for (const note of CONFIG.RELEASE_NOTES) {
      const parsed = readEntry(note.version) as Entry | null
      expect(parsed, `no entry parsed for ${note.version}`).toBeTruthy()
      expect(parsed!.changes.length, `change count drifted for ${note.version}`).toBe(
        note.changes.length
      )
    }
  })

  it('round-trips title and detail text exactly', () => {
    const note = CONFIG.RELEASE_NOTES[0]
    const parsed = readEntry(note.version) as Entry
    for (let i = 0; i < note.changes.length; i++) {
      expect(parsed.changes[i].title).toBe(note.changes[i].title)
      expect(parsed.changes[i].detail).toBe(note.changes[i].detail)
    }
  })

  it('survives an apostrophe inside a double-quoted value', () => {
    // "your Mac's cursor" broke an earlier version of the regex, which treated
    // the apostrophe as a string terminator and truncated the change list.
    const all = CONFIG.RELEASE_NOTES.flatMap((n) => n.changes)
    const withApostrophe = all.find((c) => c.detail.includes("'") || c.title.includes("'"))
    expect(withApostrophe, 'no apostrophe fixture in RELEASE_NOTES to test against').toBeTruthy()

    const owner = CONFIG.RELEASE_NOTES.find((n) =>
      n.changes.some((c) => c.title === withApostrophe!.title)
    )!
    const parsed = readEntry(owner.version) as Entry
    expect(parsed.changes.map((c) => c.title)).toContain(withApostrophe!.title)
  })

  it('returns null for a version that is not in RELEASE_NOTES', () => {
    expect(readEntry('99.99.99')).toBeNull()
  })

  it('never returns an entry with zero changes for a real version', () => {
    // The CLI refuses to mail an empty email; this makes that refusal a test
    // failure at build time rather than a surprise at send time.
    for (const note of CONFIG.RELEASE_NOTES) {
      expect((readEntry(note.version) as Entry).changes.length).toBeGreaterThan(0)
    }
  })
})
