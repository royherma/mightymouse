import { describe, expect, it } from 'vitest'
import {
  CONNECT_LOG_MAX_ENTRIES,
  formatAttempt,
  parseConnectLogBody,
  type ConnectAttempt
} from '../phone-connect-log'

function attempt(over: Partial<ConnectAttempt> = {}): ConnectAttempt {
  return {
    at: 1_700_000_000_000,
    outcome: 'rejected',
    detail: 'no-credential',
    host: 'example.getmightymouse.com',
    hadCredential: false,
    attempt: 1,
    opened: false,
    ...over
  }
}

describe('formatAttempt', () => {
  it('names cred and opened so a cred=no refuse is greppable without the phone', () => {
    expect(formatAttempt(attempt())).toBe(
      'rejected no-credential host=example.getmightymouse.com cred=no opened=no try=1'
    )
  })

  it('omits opened when the attempt never had a socket', () => {
    const row = attempt({ outcome: 'no-stored-credential', detail: null, opened: undefined, attempt: 0 })
    delete row.opened
    expect(formatAttempt(row)).toBe(
      'no-stored-credential host=example.getmightymouse.com cred=no'
    )
  })
})

describe('parseConnectLogBody', () => {
  it('accepts a valid buffer', () => {
    expect(parseConnectLogBody({ entries: [attempt()] })).toEqual([attempt()])
  })

  it('rejects a credential field anywhere in the body', () => {
    expect(parseConnectLogBody({ entries: [attempt()], credential: 'secret' })).toBeNull()
    expect(parseConnectLogBody({ entries: [{ ...attempt(), credential: 'secret' }] })).toBeNull()
    expect(parseConnectLogBody({ entries: [{ ...attempt(), d: 'abc' }] })).toBeNull()
  })

  it('rejects an unknown outcome or extra key', () => {
    expect(
      parseConnectLogBody({ entries: [{ ...attempt(), outcome: 'lol' as never }] })
    ).toBeNull()
    expect(parseConnectLogBody({ entries: [{ ...attempt(), fingerprint: 'abc123' }] })).toBeNull()
  })

  it('carries the bridge signals through, and flags a native launch that lost its handler', () => {
    // The 2026-08-23 shape: a native app whose message handler was missing
    // reported shell='pwa' and read as a never-paired PWA. handler=false with
    // bootstrap=true is the fingerprint that separates the two.
    const parsed = parseConnectLogBody({
      entries: [{ ...attempt(), shell: 'pwa', handler: false, bootstrap: true }]
    })
    expect(parsed?.[0]).toMatchObject({ shell: 'pwa', handler: false, bootstrap: true })
    expect(formatAttempt(parsed![0])).toContain('BRIDGE-HANDLER-MISSING')
  })

  it('stays quiet on a healthy native or a genuine PWA', () => {
    expect(
      formatAttempt({ ...attempt(), shell: 'native', handler: true, bootstrap: true })
    ).not.toContain('BRIDGE-HANDLER-MISSING')
    expect(
      formatAttempt({ ...attempt(), shell: 'pwa', handler: false, bootstrap: false })
    ).not.toContain('BRIDGE-HANDLER-MISSING')
  })

  it('rejects an empty or oversized batch', () => {
    expect(parseConnectLogBody({ entries: [] })).toBeNull()
    expect(
      parseConnectLogBody({ entries: Array.from({ length: CONNECT_LOG_MAX_ENTRIES + 1 }, () => attempt()) })
    ).toBeNull()
  })
})
