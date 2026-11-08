import { describe, it, expect, vi } from 'vitest'
import {
  parsePairingTarget,
  pairingCodeOnUrl,
  spendUrlPairingCode,
  stripPairingCodeParam
} from './qr-pair-target'

describe('parsePairingTarget', () => {
  it('reads host and port from a LAN pairing QR', () => {
    expect(parsePairingTarget('https://192.168.1.42:17771/?c=123456')).toEqual({
      host: '192.168.1.42',
      port: 17771,
      code: '123456'
    })
  })

  it('defaults to 443 for a tunnel URL, which carries no explicit port', () => {
    expect(parsePairingTarget('https://foo-bar.trycloudflare.com/?c=123456')).toEqual({
      host: 'foo-bar.trycloudflare.com',
      port: 443,
      code: '123456'
    })
  })

  it('reads a port drift within the retry range', () => {
    expect(parsePairingTarget('https://10.0.0.5:17775/')?.port).toBe(17775)
  })

  // Carrying the code is what lets a scan finish pairing on its own -- dropping
  // it is what made the scan look like it did nothing.
  it('keeps the pairing code so the scan can pair without a typed code', () => {
    expect(parsePairingTarget('https://192.168.1.42:17771/?c=654321')?.code).toBe('654321')
  })

  // A QR minted while the server was down carries no code; the typed code is
  // still the way in, so this must stay a valid target rather than null.
  it('returns a target with a null code when the QR carries none', () => {
    expect(parsePairingTarget('https://10.0.0.5:17775/')?.code).toBeNull()
  })

  // Shape-checked so a junk QR falls back to the keypad rather than spending
  // one of five /pair attempts per minute on garbage.
  it.each(['12345', '1234567', 'abcdef', '12 456', ''])('drops the malformed code %j', (bad) => {
    expect(parsePairingTarget(`https://10.0.0.5:17775/?c=${bad}`)?.code).toBeNull()
  })

  // A scanned QR is attacker-supplied: anything not plainly one of ours must
  // fall through to "not a MightyMouse QR" rather than become a pair target.
  it.each([
    ['plain text', 'not a url'],
    ['empty', ''],
    ['a wifi QR', 'WIFI:S=home;T=WPA;P=hunter2;;'],
    ['http, not https', 'http://192.168.1.42:17771/'],
    ['a javascript url', 'javascript:alert(1)'],
    ['a mailto', 'mailto:someone@example.com']
  ])('rejects %s', (_label, raw) => {
    expect(parsePairingTarget(raw)).toBeNull()
  })
})

describe('pairingCodeOnUrl', () => {
  it('returns the target when the page URL carries a valid code', () => {
    expect(pairingCodeOnUrl('https://192.168.1.42:17771/?c=123456')?.code).toBe('123456')
  })

  it.each([
    'https://192.168.1.42:17771/',
    'https://192.168.1.42:17771/?c=12',
    'http://192.168.1.42:17771/?c=123456'
  ])('ignores %s', (href) => {
    expect(pairingCodeOnUrl(href)).toBeNull()
  })
})

describe('stripPairingCodeParam', () => {
  it('drops ?c= and keeps the rest of the path', () => {
    expect(stripPairingCodeParam('https://192.168.1.42:17771/?c=123456')).toBe('/')
  })

  it('keeps other query params', () => {
    expect(stripPairingCodeParam('https://192.168.1.42:17771/?c=123456&x=1')).toBe('/?x=1')
  })
})

describe('spendUrlPairingCode', () => {
  it('exchanges a valid ?c= and strips it before the POST', async () => {
    const calls: string[] = []
    const exchange = vi.fn(async () => {
      calls.push('exchange')
      return { ok: true as const }
    })
    const result = await spendUrlPairingCode({
      href: 'https://192.168.1.42:17771/?c=123456',
      hasCredential: false,
      replaceHref: () => {
        calls.push('strip')
      },
      exchange
    })
    expect(result).toBe('spent')
    expect(calls).toEqual(['strip', 'exchange'])
    expect(exchange).toHaveBeenCalledWith('123456', { host: '192.168.1.42', port: 17771 })
  })

  it('does not POST a malformed code', async () => {
    const exchange = vi.fn()
    const replaceHref = vi.fn()
    const result = await spendUrlPairingCode({
      href: 'https://192.168.1.42:17771/?c=12',
      hasCredential: false,
      replaceHref,
      exchange
    })
    expect(result).toBe('ignored')
    expect(exchange).not.toHaveBeenCalled()
    expect(replaceHref).not.toHaveBeenCalled()
  })

  it('leaves a credentialed phone alone', async () => {
    const exchange = vi.fn()
    const replaceHref = vi.fn()
    const result = await spendUrlPairingCode({
      href: 'https://192.168.1.42:17771/?c=123456',
      hasCredential: true,
      replaceHref,
      exchange
    })
    expect(result).toBe('ignored')
    expect(exchange).not.toHaveBeenCalled()
    expect(replaceHref).not.toHaveBeenCalled()
  })

  it('strips ?c= even when the Mac refuses, so a reload cannot retry it', async () => {
    const replaceHref = vi.fn()
    const result = await spendUrlPairingCode({
      href: 'https://192.168.1.42:17771/?c=123456',
      hasCredential: false,
      replaceHref,
      exchange: async () => ({ ok: false, error: 'invalid-code' })
    })
    expect(result).toBe('failed')
    expect(replaceHref).toHaveBeenCalledWith('/')
  })
})
