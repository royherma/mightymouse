/**
 * UA -> a name a human recognizes in the paired-devices list. The cases locked
 * here are the ones that silently mislabel a device the user is about to revoke.
 */

import { describe, it, expect } from 'vitest'
import {
  parseDeviceIdentity,
  formatDeviceLabel,
  formatOsLabel,
  resolveModelName
} from '../device-identity'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
// Installed Home Screen app: same WebKit, no Safari token.
const IPHONE_PWA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1'
const IPAD_SAFARI =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1'

describe('parseDeviceIdentity', () => {
  it('names an iPhone in Safari', () => {
    const id = parseDeviceIdentity(IPHONE_SAFARI)
    expect(id.kind).toBe('iphone')
    expect(formatDeviceLabel(id)).toBe('iPhone · Safari')
  })

  it('calls a token-less iOS UA a Home Screen app (older iOS)', () => {
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_PWA))).toBe('iPhone · Home Screen app')
  })

  it('trusts the standalone flag over a UA that still says Safari', () => {
    // Recent iOS keeps `Safari/604.1` in an installed PWA, so only the page knows.
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_SAFARI, true))).toBe(
      'iPhone · Home Screen app'
    )
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_SAFARI, false))).toBe('iPhone · Safari')
  })

  it('names a standalone device even with no UA at all', () => {
    expect(formatDeviceLabel(parseDeviceIdentity(null, true))).toBe(
      'Unknown device · Home Screen app'
    )
  })

  it('tells the native app apart from a Home Screen icon', () => {
    // The app's WKWebView sends a stock Safari UA and pairs as standalone too,
    // so the shell the page reports is the only signal that separates them.
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_SAFARI, true, 'native'))).toBe(
      'iPhone · MightyMouse app'
    )
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_SAFARI, true, 'pwa'))).toBe(
      'iPhone · Home Screen app'
    )
  })

  it('keeps naming the real browser when the shell is safari', () => {
    // A 'safari' report only says "not standalone" -- the UA names the browser.
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_CHROME, false, 'safari'))).toBe(
      'iPhone · Chrome'
    )
  })

  it('labels the native app even before any UA is on file', () => {
    expect(formatDeviceLabel(parseDeviceIdentity(null, true, 'native'))).toBe(
      'Unknown device · MightyMouse app'
    )
  })

  it('falls back to the standalone label when no shell was reported', () => {
    // Every device paired before the field existed stores shell: null.
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_SAFARI, true, null))).toBe(
      'iPhone · Home Screen app'
    )
  })

  it('reports iOS Chrome as Chrome, not Safari', () => {
    // Every iOS browser is WebKit and carries `safari` too.
    expect(formatDeviceLabel(parseDeviceIdentity(IPHONE_CHROME))).toBe('iPhone · Chrome')
  })

  it('distinguishes iPad from iPhone', () => {
    expect(parseDeviceIdentity(IPAD_SAFARI).kind).toBe('ipad')
  })

  it('falls back to Unknown device with no surface suffix', () => {
    // Devices paired before identity capture stay valid, so no empty rows.
    for (const ua of [undefined, null, '']) {
      const id = parseDeviceIdentity(ua)
      expect(id.kind).toBe('unknown')
      expect(formatDeviceLabel(id)).toBe('Unknown device')
    }
  })

  it('classifies Android by form factor', () => {
    const phone = parseDeviceIdentity(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'
    )
    expect(phone.kind).toBe('android')
    expect(formatDeviceLabel(phone)).toBe('Android phone · Chrome')
  })

  // All four carry BOTH their own token and `Safari`, so the table's ORDER is
  // the only thing keeping them apart.
  it('picks the specific browser over the Safari token every UA carries', () => {
    const cases: ReadonlyArray<[string, string]> = [
      [
        'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
        'Samsung Internet'
      ],
      [
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 OPR/76.0',
        'Opera'
      ],
      [
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 EdgA/126.0',
        'Edge'
      ],
      [
        'Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0',
        'Firefox'
      ]
    ]
    for (const [ua, expected] of cases) {
      expect(parseDeviceIdentity(ua).browser).toBe(expected)
    }
  })

  it('keeps the major version only, and normalizes the iOS underscore', () => {
    const ios = parseDeviceIdentity(IPHONE_SAFARI)
    expect(ios.os).toBe('iOS')
    // The UA writes `17_5`; a dashboard that groups on this needs dots.
    expect(ios.osVersion).toBe('17.5')
    expect(ios.browserVersion).toBe('17')
  })
})

describe('resolveModelName', () => {
  it('maps an Apple hardware identifier to its marketing name', () => {
    expect(resolveModelName('iPhone16,2')).toBe('iPhone 15 Pro Max')
  })

  // The table gains rows every September, so a miss must still tell two phones
  // apart rather than collapsing to a family name.
  it('passes an unknown identifier through untouched', () => {
    expect(resolveModelName('iPhone99,1')).toBe('iPhone99,1')
  })

  it('leaves an already-readable Chromium model alone', () => {
    expect(resolveModelName('Pixel 8 Pro')).toBe('Pixel 8 Pro')
  })

  it('lets a reported model outrank the UA family in the label', () => {
    const id = parseDeviceIdentity(IPHONE_SAFARI)
    expect(formatDeviceLabel(id, 'iPhone16,2')).toBe('iPhone 15 Pro Max · Safari')
  })
})

describe('formatOsLabel', () => {
  it('names the OS and version from the UA alone', () => {
    expect(formatOsLabel(parseDeviceIdentity(IPHONE_SAFARI))).toBe('iOS 17.5')
  })

  // The native app reports its exact version; the UA only ever carries a
  // rounded two-part one, so the report has to win or a 18.7.7 row reads 18.7.
  it('lets a reported version outrank the UA', () => {
    const id = parseDeviceIdentity(IPHONE_SAFARI)
    expect(formatOsLabel(id, '18.7.7')).toBe('iOS 18.7.7')
  })

  it('falls back to the bare platform when only the family is known', () => {
    const id = parseDeviceIdentity('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
    expect(formatOsLabel(id)).toBe('macOS')
  })

  it('is null for a device we know nothing about', () => {
    expect(formatOsLabel(parseDeviceIdentity(null))).toBeNull()
  })
})
