import { describe, it, expect } from 'vitest'
import { KEY_PROVIDERS } from '../key-providers'
import { daysUntil, detectProvider, expiryStatus, KEY_EXPIRY_WARN_DAYS, shapeOf } from '../keys'

const detect = (name: string, value?: string): string | undefined => detectProvider(KEY_PROVIDERS, name, value)?.id

describe('shapeOf', () => {
  it('shows at most 8 chars and at most a quarter of a long key', () => {
    const key = 'sk-or-v1-' + 'a'.repeat(64)
    const { shape, length } = shapeOf(key)
    expect(shape).toBe('sk-or-v1…')
    expect(length).toBe(key.length)
  })

  it('never reveals more than a quarter of a 25-char key', () => {
    const { shape } = shapeOf('abcdefghijklmnopqrstuvwxy')
    expect(shape).toBe('abcdef…')
  })

  it('shows 3 chars of a mid-length and 2 of a short value', () => {
    expect(shapeOf('abcdefghijklmnopqrst').shape).toBe('abc…')
    expect(shapeOf('abcdefghij').shape).toBe('ab…')
  })

  it('measures and shapes the trimmed value', () => {
    expect(shapeOf('  abcdefghij\n')).toEqual({ shape: 'ab…', length: 10 })
  })
})

describe('expiryStatus', () => {
  const now = Date.parse('2026-09-24T12:00:00Z')
  const day = 86_400_000

  it('is expired at and after the expiry instant', () => {
    expect(expiryStatus(new Date(now).toISOString(), now)).toBe('expired')
    expect(expiryStatus(new Date(now - day).toISOString(), now)).toBe('expired')
  })

  it('warns inside the window and not outside it', () => {
    expect(expiryStatus(new Date(now + KEY_EXPIRY_WARN_DAYS * day).toISOString(), now)).toBe('expiring')
    expect(expiryStatus(new Date(now + KEY_EXPIRY_WARN_DAYS * day + 1000).toISOString(), now)).toBeNull()
  })

  it('has no opinion on a missing or unparseable date', () => {
    expect(expiryStatus(undefined, now)).toBeNull()
    expect(expiryStatus('next tuesday', now)).toBeNull()
  })

  it('daysUntil rounds a partial day up', () => {
    expect(daysUntil(new Date(now + 1.2 * day).toISOString(), now)).toBe(2)
    expect(daysUntil(new Date(now - 1.2 * day).toISOString(), now)).toBe(-1)
    expect(daysUntil('garbage', now)).toBeNull()
  })
})

describe('detectProvider', () => {
  it('an exact env name wins over the value shape', () => {
    expect(detect('openrouter_api_key', 'sk-ant-abc')).toBe('openrouter')
  })

  it('the longest matching value prefix wins', () => {
    expect(detect('MY_KEY', 'sk-ant-api03-xyz')).toBe('anthropic')
    expect(detect('MY_KEY', 'sk-or-v1-xyz')).toBe('openrouter')
    expect(detect('MY_KEY', 'sk-proj-xyz')).toBe('openai')
    expect(detect('MY_KEY', '  sk_live_xyz')).toBe('stripe')
  })

  it('falls back to a provider stem in the name', () => {
    expect(detect('ANTHROPIC_KEY_2')).toBe('anthropic')
    expect(detect('PROD_STRIPE_SECRET')).toBe('stripe')
  })

  it('a stem must be a whole word in the name', () => {
    expect(detect('STRIPED_WIDGET')).toBeUndefined()
  })

  it('returns null for a name and value it cannot place', () => {
    expect(detectProvider(KEY_PROVIDERS, 'SOME_THING', 'zzz')).toBeNull()
  })
})
