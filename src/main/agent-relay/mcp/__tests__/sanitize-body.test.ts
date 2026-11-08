/**
 * sanitizeBody strips terminal markup off text headed for a phone card.
 *
 * Every case below is a shape that actually reached a lock screen: agents write
 * markdown because a terminal renders it, and iOS renders none of it -- so
 * `**wrong**` arrived with the asterisks visible. The rule this file pins is
 * that only MARKUP is removed: the sender's words are never rewritten, because
 * a sanitizer that edits content is one that can change what an approve card
 * says you are approving.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeBody } from '../verbs'

describe('sanitizeBody', () => {
  it('passes clean prose through untouched', () => {
    const clean = "Peer has the tables. Both of Roy's questions are still open."
    expect(sanitizeBody(clean)).toBe(clean)
  })

  it('strips bold and italic markers but keeps the words', () => {
    expect(sanitizeBody('my warning was **wrong** and I *fixed* it')).toBe(
      'my warning was wrong and I fixed it'
    )
  })

  it('strips backticks so a path reads as a word', () => {
    expect(sanitizeBody('the `take-me-to-the-session` agent')).toBe(
      'the take-me-to-the-session agent'
    )
  })

  it('drops list bullets while keeping the items', () => {
    expect(sanitizeBody('That means:\n- No script needed.\n- You just talk.')).toBe(
      'That means: No script needed. You just talk.'
    )
  })

  // A hyphen inside a sentence is a hyphen, not a bullet -- the line-start
  // anchor is what separates the two, and losing it ate real words.
  it('leaves a mid-sentence hyphen alone', () => {
    expect(sanitizeBody('the take-me-to-the-session agent is well-tested')).toBe(
      'the take-me-to-the-session agent is well-tested'
    )
  })

  it('turns em and en dashes into commas, per the house voice', () => {
    expect(sanitizeBody('wtf-2026-08-14 — short, Aware pillar')).toBe(
      'wtf-2026-08-14, short, Aware pillar'
    )
    expect(sanitizeBody('one – two')).toBe('one, two')
  })

  it('keeps link text and drops the url', () => {
    expect(sanitizeBody('See [the docs](https://example.com/x) for more.')).toBe(
      'See the docs for more.'
    )
  })

  it('strips headings and blockquote markers', () => {
    expect(sanitizeBody('## Done\n> Shipped it.')).toBe('Done Shipped it.')
  })

  it('collapses newlines and runs of whitespace into single spaces', () => {
    expect(sanitizeBody('Line one.\n\n\tLine   two.')).toBe('Line one. Line two.')
  })

  it('returns undefined for absent, empty, and markup-only input', () => {
    expect(sanitizeBody(undefined)).toBeUndefined()
    expect(sanitizeBody('')).toBeUndefined()
    // Nothing but markup leaves an empty string; undefined is what the mint
    // path treats as "no body", where '' would render a blank second line.
    expect(sanitizeBody('   \n  ')).toBeUndefined()
  })

  it('does not rewrite the words themselves', () => {
    const blunt = 'Deleting the users table now.'
    expect(sanitizeBody(blunt)).toBe(blunt)
  })
})
