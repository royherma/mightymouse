/**
 * Address validation for the phone-remote email invite.
 *
 * This rule runs in three places that cannot import each other (phone bundle,
 * Electron main, Deno Edge function) — see src/shared/invite-email.ts. Two of
 * them share this module; the Edge function hand-copies the pattern. These
 * tests lock the shared one so the copy has something to be checked against.
 *
 * The bar being defended is deliberately low: reject junk, never reject a real
 * person. Cases below are split accordingly — the "accepted" block is the one
 * that matters most, because a false negative means refusing to mail someone.
 */

import { describe, it, expect } from 'vitest'
import {
  isValidInviteEmail,
  normalizeInviteEmail,
  MAX_INVITE_EMAIL_LEN
} from '../invite-email'

describe('isValidInviteEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const email of [
      'roy@getmightymouse.com',
      'a@b.co',
      'first.last@sub.domain.co.uk',
      'pat+phone-remote@example.com',
      "o'brien@example.com",
      'user_name@example-host.com',
      '123@456.com'
    ]) {
      expect(isValidInviteEmail(email), email).toBe(true)
    }
  })

  it('rejects junk', () => {
    for (const bad of [
      '',
      '   ',
      'roy',
      'roy@',
      '@example.com',
      'roy@example', // no dot in the domain
      'roy example@x.com', // internal space
      'roy@ex ample.com',
      'roy@@example.com',
      'two@addresses.com three@more.com',
      'Have a look at mightymouse.com' // a pasted sentence
    ]) {
      expect(isValidInviteEmail(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('rejects non-strings off the wire', () => {
    // The Mac calls this on an unvalidated WS payload, so a hostile client can
    // send any JSON type here — these must not throw.
    for (const bad of [null, undefined, 42, {}, [], true, { toString: () => 'a@b.co' }]) {
      expect(isValidInviteEmail(bad)).toBe(false)
    }
  })

  it('enforces RFC 5321 length, measured after trimming', () => {
    const localMax = 'a'.repeat(MAX_INVITE_EMAIL_LEN - '@example.com'.length)
    expect(isValidInviteEmail(`${localMax}@example.com`)).toBe(true)
    expect(isValidInviteEmail(`${localMax}a@example.com`)).toBe(false)
    // Whitespace must not count toward the ceiling: an address that fits is
    // still valid when a phone keyboard appends a space.
    expect(isValidInviteEmail(`  ${localMax}@example.com  `)).toBe(true)
  })

  it('accepts what a phone keyboard actually produces', () => {
    // iOS appends a space after autocomplete and capitalises the first letter;
    // both must survive, since the send path lowercases and trims anyway.
    expect(isValidInviteEmail('Roy@Example.com ')).toBe(true)
    expect(isValidInviteEmail(' roy@example.com')).toBe(true)
  })
})

describe('normalizeInviteEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeInviteEmail('  Roy@Example.COM ')).toBe('roy@example.com')
  })

  it('is idempotent', () => {
    const once = normalizeInviteEmail(' A@B.co ')
    expect(normalizeInviteEmail(once)).toBe(once)
  })

  it('preserves plus-aliases and dots', () => {
    // Both are significant here. The aggressive same-mailbox normalisation
    // (stripping +tags, Gmail dots) belongs to the SELF-referral check in
    // _shared/abuse-guard.ts, which answers a different question — collapsing
    // them here would suppress invites to genuinely distinct addresses.
    expect(normalizeInviteEmail('Pat.Doe+mm@Example.com')).toBe('pat.doe+mm@example.com')
  })

  it('agrees with what the validator accepted', () => {
    // The value sent must be the value validated: an address checked raw but
    // sent untrimmed would be two different strings.
    const raw = '  Roy@Example.com  '
    expect(isValidInviteEmail(raw)).toBe(true)
    expect(isValidInviteEmail(normalizeInviteEmail(raw))).toBe(true)
  })
})
