import { describe, it, expect, vi } from 'vitest'

// The module's import chain pulls in the Supabase client (→ electron
// safeStorage) purely for the provisioning call — irrelevant to the pure
// helpers under test, so stub it out rather than dragging electron into
// vitest's node environment.
vi.mock('../supabase', () => ({ getSupabase: () => ({}) }))

import {
  pickCloudflaredAsset,
  isProvisionValid,
  matchOrphanPids,
  parseCloudflaredVersion,
  isCloudflaredCurrent
} from './cloudflare-tunnel'

describe('pickCloudflaredAsset', () => {
  it('picks the arm64 build on Apple Silicon', () => {
    expect(pickCloudflaredAsset('arm64')).toBe('cloudflared-darwin-arm64.tgz')
  })

  it('falls back to amd64 for anything else (Intel, Rosetta oddities)', () => {
    expect(pickCloudflaredAsset('x64')).toBe('cloudflared-darwin-amd64.tgz')
  })
})

describe('cloudflared version gate', () => {
  it('reads the version out of --version output', () => {
    expect(parseCloudflaredVersion('cloudflared version 2026.3.0 (built 2026-03-06T12:53:40Z)')).toBe('2026.3.0')
    expect(parseCloudflaredVersion('garbage')).toBeNull()
  })

  it('rejects builds older than the minimum and unknown versions', () => {
    expect(isCloudflaredCurrent('2026.3.0', '2026.10.3')).toBe(false)
    expect(isCloudflaredCurrent('2026.10.2', '2026.10.3')).toBe(false)
    expect(isCloudflaredCurrent('2025.11.1', '2026.10.3')).toBe(false)
    expect(isCloudflaredCurrent(null, '2026.10.3')).toBe(false)
  })

  it('accepts the minimum and anything newer', () => {
    expect(isCloudflaredCurrent('2026.10.3', '2026.10.3')).toBe(true)
    expect(isCloudflaredCurrent('2026.10.4', '2026.10.3')).toBe(true)
    expect(isCloudflaredCurrent('2027.1.0', '2026.10.3')).toBe(true)
  })
})

describe('isProvisionValid', () => {
  const good = { hostname: 'abc123def456-mightymouse-remote.getmightymouse.com', tunnelToken: 'tok', port: 17771 }

  it('accepts a complete record', () => {
    expect(isProvisionValid(good)).toBe(true)
  })

  it('rejects null, empty fields, and missing port', () => {
    expect(isProvisionValid(null)).toBe(false)
    expect(isProvisionValid({ ...good, hostname: '' })).toBe(false)
    expect(isProvisionValid({ ...good, tunnelToken: '' })).toBe(false)
    expect(isProvisionValid({ hostname: good.hostname, tunnelToken: 'tok' })).toBe(false)
  })
})

// Both directions fail silently: too NARROW reaps nothing, too WIDE kills a
// user's own cloudflared.
describe('matchOrphanPids', () => {
  const BIN = '/opt/homebrew/bin/cloudflared'
  // Verbatim shape of `ps -axo pid=,command=` (leading pad + single space),
  // captured from a real run rather than guessed.
  const PS = [
    '  501 /sbin/launchd',
    ` 4242 ${BIN} tunnel run`,
    ` 4243 ${BIN} tunnel run --config /etc/cf.yml`,
    ' 4244 /usr/local/bin/cloudflared tunnel run',
    ` 4245 ${BIN} tunnel --url http://localhost:8080`,
    ` 4246 ${BIN} tunnel run extra-arg`,
    ' 4247 /Applications/MightyMouse.app/Contents/MacOS/MightyMouse'
  ].join('\n')

  it('reaps only our exact `<bin> tunnel run` spawn', () => {
    expect(matchOrphanPids(PS, BIN, 999)).toEqual([4242])
  })

  it("never kills a user's own cloudflared (flags, other path, quick tunnel)", () => {
    const reaped = matchOrphanPids(PS, BIN, 999)
    for (const survivor of [4243, 4244, 4245, 4246, 4247]) {
      expect(reaped).not.toContain(survivor)
    }
  })

  it('never reaps ourselves', () => {
    expect(matchOrphanPids(PS, BIN, 4242)).toEqual([])
  })

  // Our live child has the SAME argv an orphan does, so without livePid every
  // re-enable SIGTERMed the tunnel it was re-enabling.
  it('never reaps our own LIVE child', () => {
    expect(matchOrphanPids(PS, BIN, 999, 4242)).toEqual([])
  })

  it('still reaps real orphans while our live child is running', () => {
    const ps = [` 4242 ${BIN} tunnel run`, ` 4250 ${BIN} tunnel run`].join('\n')
    expect(matchOrphanPids(ps, BIN, 999, 4242)).toEqual([4250])
  })

  it('handles empty/garbage ps output without throwing', () => {
    expect(matchOrphanPids('', BIN, 999)).toEqual([])
    expect(matchOrphanPids('\n\n  \nnot a ps line\n', BIN, 999)).toEqual([])
  })

  it('finds every orphan when several piled up (the reported failure: 5 alive)', () => {
    const many = [4301, 4302, 4303, 4304, 4305].map((p) => ` ${p} ${BIN} tunnel run`).join('\n')
    expect(matchOrphanPids(many, BIN, 999)).toEqual([4301, 4302, 4303, 4304, 4305])
  })
})
